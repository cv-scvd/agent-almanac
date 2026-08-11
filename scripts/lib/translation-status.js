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
 * carrying two, per `--margins` — and its scaffolds carry none. That is a measurement, not an
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
import { toLines, extractFences, isGated, contentKey, fenceShape, TREES } from './fences.js';

// Smaller than `lib/fences.js`'s 2 GiB, and the earlier justification here was wrong: the
// buffer bounds `git cat-file --batch` stdout, which is the same bytes in both callers, so
// what the pool later retains has nothing to do with it. The honest statement is that this
// caller will hit ENOBUFS first as history grows, and that the failure is loud — `spawnSync`
// sets `error` and a short `stdout`, and the parse below would silently produce a truncated
// pool if it were not for the `status !== 0` check. Raise both together, and keep that check.
const GIT_BUFFER = 512 * 1024 * 1024;

/**
 * Shortest line worth comparing. Below this, markdown structure dominates — `---`, `1.`,
 * `**Note:**` — and matches English in every locale whether or not anything was translated.
 *
 * The floor errs **strict**, not neutral: a short translated line such as `## Nutzung` is
 * genuine evidence of translation that this discards, and discarding evidence can only flip
 * a verdict toward `stub`. Measured, the margin holds anyway — the genuine translation
 * closest to the scaffold verdict corpus-wide is a `caveman-lite` file with 2 novel lines,
 * and among the natural-language locales the closest carries 5. Re-measure before lowering
 * it, with `generate-translation-status.js --margins`; do not reason about it. (An earlier
 * revision stated this margin as 1 here and 2 below, from the same corpus. Numbers written
 * into prose drift against each other; the flag exists so this one does not have to.)
 */
export const MIN_COMPARABLE_LINE_CHARS = 12;

/**
 * Fewest substantive lines a file must have before the zero-evidence rule may fire. A file
 * with two comparable lines does not carry enough text to distinguish "untranslated" from
 * "short". Files below this are reported `insufficient` and counted as translated, which is
 * the lenient direction — stated so a reader knows which way the residue leans.
 */
export const MIN_LINES_TO_JUDGE = 5;

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
 * @returns {string} body with LF line endings, or the whole text when fewer than two `---`
 *   lines are present. Note the delimiters are counted anywhere in the file, not only at the
 *   top, so a frontmatter-less document opening with two thematic breaks loses everything
 *   above the second — see the note in the body for why that is left alone.
 */
export function stripFrontmatter(content) {
  // Counts any two `---` lines, so a frontmatter-less historical blob whose body opens with
  // two horizontal rules loses everything before the second. That shrinks the pool, which is
  // the lenient direction (more lines look novel, the file reads as translated), and no blob
  // in this corpus is shaped that way. Left as-is knowingly.
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
 * An **unterminated** fence is deliberately not treated as frozen. CommonMark says such a
 * fence runs to end of document, and honouring that here was a one-line bypass of the whole
 * detector: appending a single ```` ```bash ```` to a scaffold hid every remaining line from
 * comparison, collapsed `total` from 5 to 0, and turned a `stub` verdict into `insufficient`
 * — which is counted as *translated*. Measured, not theorised. An unterminated fence is a
 * malformed document, not a claim that the rest of the file is keep-in-English, so its body
 * is compared like any other prose. The fence gate flags the malformation separately.
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
    if (isGated(fence) && !fence.unterminated) {
      for (let i = fence.bodyStart; i < fence.bodyEnd; i += 1) dropped[i] = true;
    }
  }
  return lines.filter((_, i) => !dropped[i]);
}

/**
 * Does any frozen region of `text` actually remove content from comparison?
 *
 * The second half of the `fence-mismatch` test (#561). A fence shape that matches no English
 * revision is only *dangerous* when the mask built from it swallowed something; when it hid
 * nothing, the count is sound whatever the shape says. Mirrors `openLines`' own conditions
 * exactly — gated, terminated, non-empty body — so the two cannot drift into disagreeing
 * about what "hidden" means.
 *
 * @param {string} text body text, frontmatter already stripped
 * @returns {boolean}
 */
export function hidesLines(text) {
  return extractFences(text).some(
    (fence) => isGated(fence) && !fence.unterminated && fence.bodyEnd > fence.bodyStart,
  );
}

/**
 * The lines of `text` long enough to carry prose, trimmed.
 * @param {string} text
 * @returns {string[]}
 */
export function substantiveLines(text) {
  return openLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_COMPARABLE_LINE_CHARS && /\p{L}/u.test(line));
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
 * @param {{lines: Set<string>, fenceShapes: Set<string>}|undefined} input.english the English
 *   source's pooled history (see `buildEnglishProseHistory`), or undefined when it has none.
 *   Both pools arrive together deliberately: passing prose without shapes was possible while
 *   they were separate parameters, and a caller that forgot the second one would silently
 *   lose the #561 check with no symptom.
 * @returns {{stub: boolean, reason: string, novel: number|null, total: number|null}}
 *   `reason` is one of `no-script`, `no-novel-lines`, `has-novel-lines`,
 *   `insufficient`, `no-source`, `fence-mismatch`.
 *
 *   `fence-mismatch` reports `total: null` as well as `novel: null`: the count itself was
 *   taken through a mask the file just proved untrustworthy, so reporting it would be
 *   presenting a corrupted measurement as a measurement.
 *
 *   **`novel` is `null` whenever the comparison did not run** — on `no-script`, `no-source`,
 *   `insufficient` and `fence-mismatch`. It used to report `0` there, which is a fabricated measurement in
 *   the one place it does the most damage: the `--verdicts` list a maintainer reads before
 *   a delete-and-re-scaffold. `(no-script, 0/57)` reads as "checked, nothing novel,
 *   open-and-shut" for a file that might carry forty novel lines. A verdict must be able to
 *   say it did not measure.
 */
export function classifyTranslation({ translatedText, locale, english }) {
  const body = stripFrontmatter(translatedText);
  const lines = substantiveLines(body);
  const englishLines = english?.lines;

  // ORDER MATTERS, and it is not the obvious one. The two "we cannot judge this" checks run
  // BEFORE the decisive script rule, because a decisive rule must not outrank an admission
  // of ignorance. Running the script rule first produced two wrong verdicts:
  //
  //   - An orphaned CJK mirror — the file exists, its English source was deleted or its id
  //     renamed — was called `no-script`, i.e. a scaffold, i.e. delete-and-re-scaffold. With
  //     no source left to re-scaffold from, that is permanent loss of the only surviving
  //     artifact. The identical file under `de` returned `no-source` and was preserved, so
  //     the disposition differed by locale alone.
  //   - A near-empty or all-fenced CJK mirror yielded `{stub: true, total: 0}`. A one-line
  //     file has essentially no opportunity to contain han, so "decisive, with no false
  //     positives available to it" is simply not earned at small `total` — which is the very
  //     reasoning `MIN_LINES_TO_JUDGE` exists to encode.
  if (!englishLines) {
    return { stub: false, reason: 'no-source', novel: null, total: lines.length };
  }

  // Third "we cannot judge this" check, and it must precede `insufficient` rather than follow
  // it. A shape mismatch means the frozen-region mask is wrong, and `lines.length` is computed
  // THROUGH that mask — so `total` is exactly the number not to be trusted. Ordering this
  // after the line-count rule would let the corrupted count answer first, which is the bug:
  // the phase flip drives `total` DOWN, straight through MIN_LINES_TO_JUDGE, and
  // `insufficient` is counted as translated (#561).
  //
  // Two conditions, and the second is what keeps this narrow. A shape mismatch alone is not
  // enough: #558's unterminated stray opener also mismatches, but an unterminated fence is no
  // longer treated as frozen, so it hides nothing and the count through the mask is sound —
  // that file must stay judgeable, and its scaffold must still be called a scaffold. What
  // makes a measurement void is a mask that BOTH disagrees with every English revision AND
  // actually removed lines. The phase flip does both; the unterminated case does neither.
  //
  // `fenceShapes` is empty only for a key with no pooled revisions, which cannot happen once
  // `englishLines` is non-empty; the guard keeps a hand-built pool from silently disabling
  // the check.
  const shapes = english.fenceShapes;
  if (shapes && shapes.size && !shapes.has(fenceShape(body)) && hidesLines(body)) {
    return { stub: false, reason: 'fence-mismatch', novel: null, total: null };
  }

  if (lines.length < MIN_LINES_TO_JUDGE) {
    return { stub: false, reason: 'insufficient', novel: null, total: lines.length };
  }

  const script = REQUIRED_SCRIPT.get(locale);
  if (script && !script.test(body)) {
    return { stub: true, reason: 'no-script', novel: null, total: lines.length };
  }

  let novel = 0;
  for (const line of lines) if (!englishLines.has(line)) novel += 1;

  return novel === 0
    ? { stub: true, reason: 'no-novel-lines', novel, total: lines.length }
    : { stub: false, reason: 'has-novel-lines', novel, total: lines.length };
}

/**
 * Every substantive English prose line each source has ever carried, keyed by `contentKey`
 * (`skills/create-r-package`, `agents/r-developer`, …).
 *
 * Pooling across history is what makes the verdict survive surgical mirror propagation: a
 * paragraph spliced into `i18n/**` from a later English revision, sitting in a body copied
 * from an earlier one, is English in both halves and novel in neither.
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
 * scaffold shows novel lines and reads as translated — lenient. In `fences.js`, where the
 * same pool is a *violation* basis, a missing revision manufactures a false violation —
 * strict. Measured on this repo: adding `--diff-merges=separate` changes the pool by 0 lines
 * and the verdict set by 0 files.
 *
 * @param {string} root repository root
 * @returns {Map<string, {lines: Set<string>, fenceShapes: Set<string>}>} per source: every
 *   substantive prose line it has ever carried, and every fence shape it has ever had
 *   (see `fenceShape`). One walk feeds both.
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
    if (!history.has(key)) history.set(key, { lines: new Set(), fenceShapes: new Set() });
    const entry = history.get(key);
    const body = stripFrontmatter(text);
    for (const line of substantiveLines(body)) entry.lines.add(line);
    // Same walk, second collector. Pooling the shape here rather than in a third history
    // builder is deliberate: #559 already objects to the two near-identical walkers this
    // module and fences.js each carry, and a third would make that worse for one Set.
    entry.fenceShapes.add(fenceShape(body));
  };

  if (specs.length) {
    const batch = spawnSync('git', ['cat-file', '--batch'], {
      cwd: root,
      input: Buffer.from(`${specs.join('\n')}\n`, 'utf8'),
      maxBuffer: GIT_BUFFER,
    });
    // Surfaced explicitly, not left to the status check. A maxBuffer overflow SIGTERMs the
    // child and leaves `status` null, which `!== 0` happens to catch — but the message would
    // then blame git for failing rather than naming the truncation, and a truncated pool is
    // the one failure here that silently reclassifies files.
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
