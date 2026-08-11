#!/usr/bin/env node
/**
 * translation-status.js — deciding whether a translated file is an untranslated scaffold.
 *
 * Extracted from `generate-translation-status.js` so the verdict can be unit-tested without
 * a git repository or a ten-minute corpus scan (#305).
 *
 * ## Why this is not a body comparison
 *
 * The original detector asked "is the translated body byte-equal to the English body?".
 * That is the right *question* — file existence lies, so `translation_status.yml` once
 * counted scaffolds as translations — but byte equality is the wrong instrument, and it
 * failed in three separate ways:
 *
 *   1. Equality against **current** English closes the moment English is next edited, after
 *      which an untranslated scaffold is silently recounted as a translation (#473).
 *   2. Equality is byte equality, so a translated copy that acquires CRLF while its source
 *      stays LF stops matching and is recounted the same way (#532).
 *   3. Equality against the `source_commit` blob — the fix suggested on both issues — does
 *      not work either. Mirrors in this repo are routinely patched *surgically*: an English
 *      fix is spliced into `i18n/**` without recopying the file. The result equals no single
 *      English revision, past or present. Measured on the four
 *      `harden-github-repo-security` scaffolds: they match neither current English nor the
 *      blob at their own recorded `source_commit` nor any of the four revisions the path
 *      has ever had.
 *
 * All three failures point the same way — `stubs` decays upward into `translated` — and all
 * three come from asking a question about *one* English text.
 *
 * ## What is asked instead
 *
 * A file is an untranslated scaffold when it carries **no evidence of translation**:
 *
 *   - every substantive prose line in it appeared verbatim in English at some point, or
 *   - the locale is written in a script the file contains none of.
 *
 * Both are decisive rather than threshold-based, which matters because the compressed
 * locales are *specified* to stay close to English — `caveman-lite` keeps grammar, articles
 * and full sentences, and measures ~90% verbatim English lines by design. Any similarity
 * threshold that catches a scaffold also condemns that tier for meeting its own spec. The
 * zero-evidence rule does not: measured on the corpus of 2026-08-11, every genuine
 * `caveman-lite` translation carries at least one line English never had — the closest
 * carrying exactly one — and its scaffolds carry none. That is a measurement, not an
 * invariant. Nothing in the spec forbids a short, heavily fenced skill from compressing to
 * zero novel lines.
 *
 * Frozen fences are excluded from both sides. A fence whose tag is not `text`/`markdown`/`md`
 * is keep-in-English by design in every locale, so counting it as agreement would push every
 * genuine translation toward the scaffold verdict.
 *
 * ## Which way the errors point, and why it changed
 *
 * The old detector's failures were all **lenient**: a scaffold read as a translation, and
 * the cost was an inflated percentage. This one can fail **strict** — a genuine translation
 * read as a scaffold — and that cost is different in kind, because the established
 * remediation for a scaffold in this repo is #478's delete-and-re-scaffold. A false stub
 * therefore destroys real work.
 *
 * So: before acting on a verdict in bulk, read the per-file list rather than the aggregate
 * count. `generate-translation-status.js --verdicts` prints it. A number cannot be reviewed.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { toLines, extractFences, isGated, contentKey, TREES } from './fences.js';

// Deliberately smaller than `lib/fences.js`'s 2 GiB: this pool holds trimmed prose lines,
// not whole fence bodies. On overflow `execFileSync` throws ENOBUFS, so the difference fails
// loud rather than producing a short pool. Raise both together if either is ever hit.
const GIT_BUFFER = 512 * 1024 * 1024;

/**
 * Shortest line worth comparing. Below this, markdown structure dominates — `---`, `1.`,
 * `**Note:**` — and matches English in every locale whether or not anything was translated.
 *
 * The floor errs **strict**, not neutral: a short translated line such as `## Nutzung` is
 * genuine evidence of translation that this discards, and discarding evidence can only flip
 * a verdict toward `stub`. Measured, the margin holds anyway — the genuine translation
 * closest to the scaffold verdict corpus-wide is a `caveman-lite` file with 2 foreign lines,
 * and among the natural-language locales the closest carries 5. Re-measure before lowering
 * it; do not reason about it.
 */
export const MIN_LINE_LENGTH = 12;

/**
 * Fewest substantive lines a file must have before the zero-evidence rule may fire. A file
 * with two comparable lines does not carry enough text to distinguish "untranslated" from
 * "short". Files below this are reported `insufficient` and counted as translated, which is
 * the lenient direction — stated so a reader knows which way the residue leans.
 */
export const MIN_SUBSTANTIVE_LINES = 5;

/**
 * Locales written in a script English does not use. A file in one of these containing none
 * of that script is untranslated no matter what its prose compares to — decisive, with no
 * false positives available to it.
 *
 * Listed explicitly rather than derived from the locale code: adding a locale here is a
 * claim about its writing system and should be made deliberately. A locale absent from this
 * map is simply judged by prose alone, which is the primary rule anyway — a new locale is
 * less redundantly guarded, not unguarded.
 *
 * The test runs against the whole body, frozen fences included, so a CJK literal inside a
 * keep-in-English code fence satisfies it. Deliberate: that errs lenient, the prose rule
 * still catches such a file, and per the header the strict direction is the expensive one.
 */
export const REQUIRED_SCRIPT = new Map([
  ['ja', /[぀-ヿ㐀-䶿一-鿿豈-﫿]/u],
  ['zh-CN', /[㐀-䶿一-鿿豈-﫿]/u],
  ['wenyan', /[㐀-䶿一-鿿豈-﫿]/u],
  ['wenyan-lite', /[㐀-䶿一-鿿豈-﫿]/u],
  ['wenyan-ultra', /[㐀-䶿一-鿿豈-﫿]/u],
]);

/**
 * Strip YAML frontmatter, returning the body.
 *
 * Splits through `toLines()`, which normalises CRLF and lone CR (#532). The previous
 * implementation split on `\n` and trimmed only the ends, so an interior `\r` survived into
 * every comparison — the same blindness `toLines()` carries a comment about having already
 * caused once, unfixed at this call site.
 *
 * @param {string} content full file text
 * @returns {string} body with LF line endings, or the whole text when no frontmatter closes
 */
export function stripFrontmatter(content) {
  const lines = toLines(content);
  let delimiters = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      delimiters += 1;
      if (delimiters === 2) return lines.slice(i + 1).join('\n');
    }
  }
  return lines.join('\n');
}

/**
 * Lines of `text` that are outside frozen fences: fence delimiters dropped, frozen fence
 * bodies dropped, localisable (`text`/`markdown`/`md`) fence bodies kept because those are
 * translatable and a scaffold's English in them is evidence.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function openLines(text) {
  const lines = toLines(text);
  const dropped = new Array(lines.length).fill(false);
  for (const fence of extractFences(text)) {
    dropped[fence.line - 1] = true;
    if (fence.bodyEnd < lines.length) dropped[fence.bodyEnd] = true;
    if (isGated(fence)) {
      for (let i = fence.bodyStart; i < fence.bodyEnd; i += 1) dropped[i] = true;
    }
  }
  return lines.filter((_, i) => !dropped[i]);
}

/**
 * The lines of `text` long enough to carry prose, trimmed.
 * @param {string} text
 * @returns {string[]}
 */
export function substantiveLines(text) {
  return openLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE_LENGTH && /\p{L}/u.test(line));
}

/**
 * The pool key for a translated item, or `null` when the id is not content.
 *
 * Exists so the caller does not re-derive `<tree>/<id>` next to `contentKey`'s own rule for
 * what an id is. Two copies of that rule is exactly the drift #519 was, and here the
 * consequence is quiet: a mirror of `_template` or `README` keys to nothing, reports
 * `no-source`, and is counted as *translated*.
 *
 * @param {string} contentType `skills` | `agents` | `teams` | `guides`
 * @param {string} itemId      directory name (skills) or filename stem (everything else)
 * @returns {string|null}
 */
export function translationKey(contentType, itemId) {
  return contentKey(contentType === 'skills'
    ? `${contentType}/${itemId}/SKILL.md`
    : `${contentType}/${itemId}.md`);
}

/**
 * Decide whether one translated file is an untranslated scaffold.
 *
 * @param {object} input
 * @param {string} input.translatedText   full text of the translated file
 * @param {string} input.locale           locale code, e.g. `de`
 * @param {Set<string>} input.englishLines every substantive prose line the English source
 *                                        has ever had (see `buildEnglishProseHistory`)
 * @returns {{stub: boolean, reason: string, foreign: number, total: number}}
 *   `reason` is one of `no-script`, `no-foreign-lines`, `has-foreign-lines`,
 *   `insufficient`, `no-source`.
 */
export function classifyTranslation({ translatedText, locale, englishLines }) {
  const body = stripFrontmatter(translatedText);
  const lines = substantiveLines(body);

  const script = REQUIRED_SCRIPT.get(locale);
  if (script && !script.test(body)) {
    return { stub: true, reason: 'no-script', foreign: 0, total: lines.length };
  }

  if (!englishLines) {
    return { stub: false, reason: 'no-source', foreign: 0, total: lines.length };
  }
  if (lines.length < MIN_SUBSTANTIVE_LINES) {
    return { stub: false, reason: 'insufficient', foreign: 0, total: lines.length };
  }

  let foreign = 0;
  for (const line of lines) if (!englishLines.has(line)) foreign += 1;

  return foreign === 0
    ? { stub: true, reason: 'no-foreign-lines', foreign, total: lines.length }
    : { stub: false, reason: 'has-foreign-lines', foreign, total: lines.length };
}

/**
 * Every substantive English prose line each source has ever carried, keyed by `contentKey`
 * (`skills/create-r-package`, `agents/r-developer`, …).
 *
 * Pooling across history is what makes the verdict survive surgical mirror propagation: a
 * paragraph spliced into `i18n/**` from a later English revision, sitting in a body copied
 * from an earlier one, is English in both halves and foreign in neither.
 *
 * Costs two git processes for the whole corpus — one `git log --name-only`, one
 * `git cat-file --batch` — rather than one per file (#305). The working tree is added last
 * so an uncommitted English edit counts as English too.
 *
 * Two known gaps in the walk, shared with `buildEnglishFenceHistory` and pointing opposite
 * ways in the two consumers, which is why neither should be "fixed" without checking both:
 * `git log` lists no paths for a merge commit and applies default history simplification, so
 * a body existing only as conflict-resolution output never enters the pool; and `--name-only`
 * without `--follow` loses pre-rename paths (harmless for the skills flatten, which
 * `contentKey` normalises, but not for an id rename). **Here** both shrink the pool, so a
 * scaffold shows foreign lines and reads as translated — lenient. In `fences.js`, where the
 * same pool is a *violation* basis, a missing revision manufactures a false violation —
 * strict. Measured on this repo: adding `--diff-merges=separate` changes the pool by 0 lines
 * and the verdict set by 0 files.
 *
 * @param {string} root repository root
 * @returns {Map<string, Set<string>>}
 */
export function buildEnglishProseHistory(root) {
  const log = execFileSync(
    'git', ['log', '--format=%x00%H', '--name-only', '--', ...TREES],
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

  const history = new Map();
  const add = (key, text) => {
    if (key === null) return;
    if (!history.has(key)) history.set(key, new Set());
    const set = history.get(key);
    for (const line of substantiveLines(stripFrontmatter(text))) set.add(line);
  };

  if (specs.length) {
    const batch = spawnSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: Buffer.from(`${specs.join('\n')}\n`, 'utf8'),
      maxBuffer: GIT_BUFFER,
    });
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
      if (/ (missing|ambiguous)$/.test(header)) { index += 1; continue; }
      const size = Number.parseInt(header.split(' ')[2], 10);
      if (!Number.isFinite(size)) break;
      const path = specs[index].slice(specs[index].indexOf(':') + 1);
      add(contentKey(path), buf.slice(offset, offset + size).toString('utf8'));
      offset += size + 1;
      index += 1;
    }
  }

  for (const tree of TREES) {
    const base = join(root, tree);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('_')) continue;
      const path = tree === 'skills' ? join(base, entry, 'SKILL.md') : join(base, entry);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const rel = tree === 'skills' ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
      add(contentKey(rel), readFileSync(path, 'utf8'));
    }
  }

  return history;
}
