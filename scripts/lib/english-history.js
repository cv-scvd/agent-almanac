/**
 * english-history.js — one walk over every revision of every English content file (#559).
 *
 * `buildEnglishFenceHistory` (fences.js) and `buildEnglishProseHistory` (translation-status.js)
 * each carried a verbatim copy of this: the `git log --name-only` spec walk, the `commit:path`
 * dedup, the `git cat-file --batch` positional parse, the `missing|ambiguous` skip, the
 * `offset += size + 1` advance, and the working-tree pass. They differed only in variable
 * names, the per-blob callback, and the failure policy.
 *
 * ## Why the duplication was worse than it looked
 *
 * The two copies had asymmetric COVERAGE, and the untested one is the strict-direction
 * consumer. Measured: deleting the `missing|ambiguous` skip from the translation-status copy
 * kills a test; deleting the identical line from the fences copy left the suite green. The
 * enclosing function does run during the suite (the normalizer's fixture repo drives it), so
 * it was the `missing` BRANCH that was uncovered — `git cat-file --batch` emits that header
 * only for a spec naming a path absent from its commit, i.e. a DELETION commit, and no fixture
 * repo in this suite had ever deleted a file. `english-history.test.js` now does.
 *
 * That matters because of which way each consumer's errors point. In translation-status.js a
 * misparse shrinks a pool, so a scaffold shows novel lines and reads as translated — lenient.
 * In fences.js the same pool is a VIOLATION basis, so a misparse manufactures false fence
 * violations against real translations — strict. The copy that could do the more expensive
 * damage was the one no test could reach.
 *
 * ## Why it was untestable, which #559 does not name
 *
 * `buildEnglishFenceHistory()` took no `root` argument — it closed over module-level `ROOT`.
 * No test could point it at a fixture repo, so no test did. Taking `root` is the change that
 * makes the coverage possible; the extraction is what makes it shared.
 *
 * Zero package imports, deliberately: `fences.js` sits in the import closure of tooling that
 * runs in jobs without `npm ci`, and a walker is exactly the kind of module someone would
 * later reach for a YAML parser inside.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { CONTENT_TYPES } from './content-types.js';
import { contentKey } from './content-paths.js';

/**
 * Bounds `git cat-file --batch` stdout, which is the same bytes for every caller — the two
 * copies disagreed (2 GiB vs 512 MiB) for no reason either could state. Unified upward so
 * neither caller regresses. A truncation here silently produces a short pool, which is why
 * the ENOBUFS case below is surfaced by name rather than left to a status check.
 */
const GIT_BUFFER = 2048 * 1024 * 1024;

/**
 * Call `onBlob(key, text, meta)` for every revision of every English content file, then once
 * more per file for the working tree.
 *
 * The working-tree pass is last and deliberate: an uncommitted English edit is a legal basis
 * too, so a translation matching work-in-progress English is not a violation.
 *
 * ## Two known gaps, and why they cannot be "fixed" from one call site
 *
 * `git log` lists no paths for a merge commit and applies default history simplification, so a
 * body existing only as conflict-resolution output never enters the pool; and `--name-only`
 * without `--follow` loses pre-rename paths (harmless for the skills flatten, which
 * `contentKey` normalises, but not for an id rename).
 *
 * Both gaps SHRINK the pool. What a shrunk pool does then depends entirely on which collector
 * is reading it, and the five differ — three tighten, two loosen:
 *
 *   - **fence bodies** (`buildEnglishFenceHistory`): the pool is a *violation* basis, so a
 *     missing revision manufactures a false violation against a real translation — strict.
 *   - **working-tree fences** (`history.current`): unaffected; that map is built from the
 *     working-tree pass, which no history gap can reach.
 *   - **prose lines** (`buildEnglishProseHistory.lines`): a scaffold shows novel lines and
 *     reads as translated — lenient.
 *   - **fence shapes** (`.fenceShapes`, #561): a legitimate shape goes missing, so a genuine
 *     translation drops out of the count into `unjudged` — strict, and this one silently
 *     removes real coverage rather than raising a flag someone reads.
 *   - **frozen-fence lines** (`.fenceLines`, #561 R2): frozen lines go missing, so content the
 *     mask later exposes reads as novel — lenient, the opposite of its neighbour.
 *
 * Recorded measurement (`translation-status.js`, pre-extraction): adding `--diff-merges=separate`
 * changed the pool by 0 lines and the verdict set by 0 files. That was measured for the prose
 * side only — re-measure all five before changing the walk.
 *
 * @param {string} root repository root
 * @param {(key: string, text: string, meta: {fromWorkingTree: boolean, path?: string}) => void} onBlob
 * @param {{trees?: readonly string[]}} [options]
 */
export function walkEnglishHistory(root, onBlob, { trees = CONTENT_TYPES } = {}) {
  const log = execFileSync(
    'git', ['log', '--format=%x00%H', '--name-only', '--', ...trees],
    { cwd: root, encoding: 'utf8', maxBuffer: GIT_BUFFER },
  );

  const specs = [];
  const seen = new Set();
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\x00')) { commit = line.slice(1).trim(); continue; }
    if (!line || !commit || contentKey(line) === null) continue;
    const spec = `${commit}:${line}`;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }

  if (specs.length) {
    const batch = spawnSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: Buffer.from(`${specs.join('\n')}\n`, 'utf8'),
      maxBuffer: GIT_BUFFER,
    });
    // Surfaced explicitly rather than left to the status check, and THROWN rather than
    // `process.exit`ed — the fences copy killed the process, which is wrong for a library.
    // A maxBuffer overflow SIGTERMs the child and leaves `status` null, which `!== 0` happens
    // to catch, but the message would then blame git for failing rather than naming the
    // truncation. A truncated pool is the one failure here that silently reclassifies files.
    if (batch.error) {
      throw new Error(`git cat-file --batch did not complete (${batch.error.code ?? batch.error.message}). `
        + `If this is ENOBUFS, GIT_BUFFER (${GIT_BUFFER}) is too small for this history.`);
    }
    if (batch.status !== 0) {
      throw new Error(`git cat-file --batch failed: ${batch.stderr?.toString().slice(0, 500)}`);
    }

    const buf = batch.stdout;
    let offset = 0;
    let index = 0;
    while (offset < buf.length && index < specs.length) {
      const newline = buf.indexOf(0x0a, offset);
      if (newline < 0) break;
      const header = buf.slice(offset, newline).toString('utf8');
      offset = newline + 1;
      // A missing or ambiguous object emits a header and NO body. Failing to advance `index`
      // past it shifts every later blob onto the wrong key — a silent, total corruption of the
      // pool. This is the line whose deletion the fences copy could not detect.
      if (/ (missing|ambiguous)$/.test(header)) { index += 1; continue; }
      const size = Number.parseInt(header.split(' ')[2], 10);
      if (!Number.isFinite(size)) break;
      const path = specs[index].slice(specs[index].indexOf(':') + 1);
      const key = contentKey(path);
      if (key !== null) {
        onBlob(key, buf.slice(offset, offset + size).toString('utf8'), { fromWorkingTree: false, path });
      }
      offset += size + 1;
      index += 1;
    }
  }

  for (const tree of trees) {
    const base = join(root, tree);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('_')) continue;
      const path = tree === 'skills' ? join(base, entry, 'SKILL.md') : join(base, entry);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const rel = tree === 'skills' ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
      const key = contentKey(rel);
      if (key === null) continue;
      onBlob(key, readFileSync(path, 'utf8'), { fromWorkingTree: true, path: rel });
    }
  }
}
