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
 * kills a test; deleting the identical line from the fences copy left the suite green.
 *
 * The asymmetry is not that the branch was unreachable in principle. It was already covered on
 * the prose side — `translation-status.test.js`'s `'a missing blob does not shift the batch
 * parser onto the wrong key'` builds a repo that deletes a skill, which is what makes
 * `git cat-file --batch` emit a `missing` header at all (it does so only for a spec naming a
 * path absent from its commit). The asymmetry is that NO fixture could drive the fences copy,
 * covered branch or not, because `buildEnglishFenceHistory()` took no `root` (below). Sharing
 * one walk is what gives the strict consumer the coverage the lenient one already had.
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
import { execFileSync } from 'child_process';
import { CONTENT_TYPES } from './content-types.js';
import { contentKey } from './content-paths.js';
import { catFileBatch, GIT_BUFFER } from './git-batch.js';

/**
 * Bounds `git cat-file --batch` stdout, which is the same bytes for every caller — the two
 * copies disagreed (2 GiB vs 512 MiB) for no reason either could state. Unified upward so
 * neither caller regresses. A truncation here silently produces a short pool, which is why
 * the ENOBUFS case below is surfaced by name rather than left to a status check.
 */
// Imported from `./git-batch.js` (#587) so the `git log` call below and the `cat-file`
// batch cannot drift to different ceilings again — which is precisely what happened between
// the walker and the normalizer after #559 declared the value unified.

/**
 * Every `<commit>:<path>` spec the walk will resolve: one per revision of each English content
 * file, deduplicated, with non-content paths dropped by `contentKey`.
 *
 * Exported so a test can assert what the walk ACTUALLY looks at. Without that, a test can only
 * rebuild the spec list itself and assert against its own copy — which proves the fixture emits
 * a `missing` header, not that the walker's stream contains one. Those come apart the moment
 * spec-building changes: filter deleted paths here and the `missing` branch goes dead while
 * every test stays green, because a deleted file's earlier revisions still arrive by their own
 * specs.
 *
 * @param {string} root repository root
 * @returns {string[]} specs in `git log` order, newest commit first
 */
export function collectSpecs(root) {
  const log = execFileSync(
    'git', ['log', '--format=%x00%H', '--name-only', '--', ...CONTENT_TYPES],
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
  return specs;
}

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
 * is reading it. Only five of the six sort into buckets — two tighten, two loosen, one is
 * untouched. The sixth goes BOTH ways, depending on which revision went missing:
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
 *   - **tag sequences** (`.sequences`, #481): BOTH, and which one depends on which revision went
 *     missing. `compareTagSequence` (`check-i18n-fence-parity.js`) first asks whether the
 *     translation's folded sequence appears in the pool at all; when it does not, the verdict
 *     turns on whether any SURVIVING revision carries the same fence count. So losing the
 *     revision that matched reads as a retag *whenever a same-count revision survives* — a false
 *     violation against a legitimate translation, strict. Losing the last count-matched revision
 *     instead yields `unalignable`, which is expressly not a finding, so a real retag is demoted
 *     to unjudged — lenient. A legitimate translation reaching that same path is demoted too,
 *     which is the silent coverage loss the `fenceShapes` row above describes rather than either
 *     direction. Three outcomes, two directions, one collector — which is why the list above is
 *     a list and not a tally: no count of "how many tighten" survives this member.
 *
 * Recorded measurement (`translation-status.js`, pre-extraction): adding `--diff-merges=separate`
 * changed the pool by 0 lines and the verdict set by 0 files. That was measured for the prose
 * side only — re-measure all six before changing the walk.
 *
 * ## Three PRODUCTION call sites reach this walk, not two
 *
 * Say production, and mean it: `rg walkEnglishHistory` returns a fourth,
 * `scripts/test/english-history.test.js`, which is deliberately excluded here because this
 * section is a re-measurement obligation and a test owes nothing to it. An unqualified "three"
 * is a count the obvious grep refutes — the same shape as the clause above this one.
 *
 * `buildEnglishProseHistory` (`translation-status.js`) and `buildEnglishFenceHistory`
 * (`fences.js`) are the production pair that own the six collectors above. The third is
 * `scripts/measure-tag-sequence-parity.js`, and it is deliberately NOT scoped out of this table
 * for being a measurement script: `fences.js` cites it as the reproducer for the tag-sequence
 * finding set, so a change to this walk that moves its numbers moves the evidence the gate was
 * tuned against. Since #612 it folds through `foldedTagSequence`, so its sequences and the
 * `.sequences` row above are now built from the same fold and a walk change moves both the same
 * way. It still pools INLINE rather than calling `buildEnglishFenceHistory`, because it also
 * needs a per-count index the pool does not carry — so a change to that builder's own logic,
 * as opposed to this walk's, still does not reach it. Re-measure through it for the second kind
 * of change; the first is now covered by the row above.
 *
 * There is deliberately no `trees` option. An earlier draft had one, defaulting to
 * `CONTENT_TYPES` and used by nobody — and it could not have worked, because `contentKey`
 * decides membership against `CONTENT_TYPES` regardless of what the option says. Passing
 * `{trees: ['docs']}` would have narrowed the `git log` pathspec and then filtered every
 * resulting path back out, walking nothing and reporting success. That is the guard-proxy shape
 * CLAUDE.md's `--tree` lesson already names: scope validated against a static list rather than
 * against what the run actually reached. An unused parameter that cannot be used correctly is
 * worse than no parameter.
 *
 * @param {string} root repository root
 * @param {(key: string, text: string, meta: {fromWorkingTree: boolean, path: string}) => void} onBlob
 */
export function walkEnglishHistory(root, onBlob) {
  const specs = collectSpecs(root);

  // The parse moved to `scripts/lib/git-batch.js` (#587), because a third copy of it lived in
  // `normalize-i18n-fences.js` with a different buffer and a different failure policy — the
  // situation #559 believed it had ended. Absences are ignored here: this walker builds a pool
  // keyed by content, and a deleted path simply has no blob to contribute.
  catFileBatch(root, specs, (spec, text) => {
    if (text === null) return;
    const path = spec.slice(spec.indexOf(':') + 1);
    const key = contentKey(path);
    if (key !== null) onBlob(key, text, { fromWorkingTree: false, path });
  });

  for (const tree of CONTENT_TYPES) {
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
