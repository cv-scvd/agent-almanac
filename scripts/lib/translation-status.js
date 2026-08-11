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
import { toLines, extractFences, isGated, contentKey, fenceShape, hasSwallowedOpener, TREES } from './fences.js';

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
 * Does a frozen fence in `text` hide lines English carries as PROSE?
 *
 * The hiding half of the cross-pool test (#561 R2). English's own frozen bodies are excluded
 * from the prose pool by the same mask, so a gated fence in the translation whose body
 * intersects that pool means the mask swallowed prose that should have been compared. No
 * legitimate translation does this: a frozen fence is keep-in-English *code*, and code is not
 * in the prose pool.
 *
 * Catches the wrap construction — tilde or longer-run fences replicating the original tags,
 * which reproduce the shape exactly and trip no fingerprint — from the other side, by asking
 * what ended up inside them rather than how they were spelled.
 *
 * `englishFrozen` is not optional refinement — without it this fires on 76 innocent files.
 * Measured, before it shipped: the prose pool spans EVERY revision, so a line that sits in a
 * frozen fence today but was unmasked in some older revision is in both pools. Real examples
 * it flagged: `def route_issue(severity, issue_type):`, `helm repo add myrepo …`,
 * `gt(descriptives) |>` — ordinary code in ordinary frozen fences, in 76 files that would each
 * have dropped out of the translated count. That is the strict direction, which this module's
 * header names as the expensive one, so the test has to be "known prose AND NOT known frozen
 * content", not "known prose".
 *
 * Residual, stated rather than hidden: a line English carries inside a LOCALISABLE fence is in
 * the prose pool and not the frozen pool, so a translation that moves such a line into a
 * frozen fence trips this. That is a retag, which #481 already treats as a defect.
 *
 * @param {string} text body text, frontmatter already stripped
 * @param {Set<string>} englishProse the English prose pool
 * @param {Set<string>} englishFrozen lines English keeps inside its own frozen fences
 * @returns {boolean}
 */
export function hidesKnownProse(text, englishProse, englishFrozen) {
  if (!englishProse || !englishProse.size) return false;
  const frozen = englishFrozen || new Set();
  return extractFences(text).some(
    (fence) => isGated(fence)
      && !fence.unterminated
      && substantiveLines(fence.body).some((line) => englishProse.has(line) && !frozen.has(line)),
  );
}

/**
 * Does any frozen region of `text` actually remove content from comparison?
 *
 * Not used by the verdict — `fence-mismatch` deliberately does NOT require hiding, because a
 * stray *localisable* opener hides nothing and still corrupts the mask (it exposes the real
 * frozen body instead). Kept and exported because the tests assert exactly that distinction,
 * and because it states `openLines`' masking conditions — gated, terminated, non-empty — in
 * one place where they can be checked rather than re-derived.
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
  // One condition, because `fenceShape` counts terminated fences only. #558's unterminated
  // stray opener therefore leaves the shape untouched and its file stays judgeable — which is
  // what an earlier draft bought with a second "did the mask hide lines?" test, at the cost of
  // a worse hole: a stray ```` ```text ```` opener is localisable, so it hides nothing and
  // passed that test, yet it still phase-flips and EXPOSES the real frozen body. Those
  // keep-in-English lines are absent from the English prose pool (which excludes gated fences
  // by construction), so they counted as NOVEL and the scaffold was reported
  // `has-novel-lines` — a positive claim of translation, worse than the `insufficient` this
  // issue started from. Mask corruption is symmetric; hiding is half of it.
  //
  // `fenceShapes` is empty only for a key with no pooled revisions, which cannot happen once
  // `englishLines` is non-empty; the guard keeps a hand-built pool from silently disabling
  // the check.
  // Two independent signatures, because neither can see the other's case.
  //
  // A shape mismatch catches a stray opener whose tag DIFFERS from the fence it swallows.
  // It structurally cannot catch a stray opener carrying the SAME tag: that one is closed by
  // the swallowed fence's real closer and inherits its position in the shape string, so the
  // shape stays byte-identical while the mask is entirely wrong. Measured on a 5-line body:
  // 5 -> 3 substantive lines, `insufficient`, counted as translated — one added line, shape
  // unchanged, count unchanged. Found by adversarial review, not by this module's tests.
  //
  // `hasSwallowedOpener` catches that by looking for the flip's own fingerprint — a line
  // inside a fence body that would itself have opened a fence — which is unreachable in a
  // well-formed document whatever the tags happen to be.
  //
  // Neither fingerprint generalises, and a third review round proved it: a stray or MOVED
  // CLOSER leaves no stray fence, no unterminated fence, and an identical shape, while a
  // tilde or longer-run wrap replicating the original tags rides through both documented
  // exemptions. Chasing each construction with its own fingerprint is a losing game.
  //
  // So the load-bearing test is the last one, and it is not a fingerprint at all. Every
  // construction in the family — cross-tag, same-tag, localisable-stray, split, moved-closer,
  // wrap — works by moving the mask across the boundary between prose and frozen content, in
  // one of exactly two directions:
  //
  //   HIDDEN-KNOWN-PROSE     a frozen fence in the translation contains lines English carries
  //                          as PROSE. Nothing legitimate does this: English's own frozen
  //                          bodies are excluded from the prose pool, so an intersection means
  //                          the mask swallowed prose.
  //   EXPOSED-KNOWN-FENCE    handled below, in the novel count.
  //
  // Membership, not shape. That is why it covers constructions nobody has thought of yet.
  const shapes = english.fenceShapes;
  const shapeUnknown = Boolean(shapes && shapes.size && !shapes.has(fenceShape(body)));
  if (shapeUnknown || hasSwallowedOpener(body) || hidesKnownProse(body, englishLines, english.fenceLines)) {
    return { stub: false, reason: 'fence-mismatch', novel: null, total: null };
  }

  if (lines.length < MIN_LINES_TO_JUDGE) {
    return { stub: false, reason: 'insufficient', novel: null, total: lines.length };
  }

  const script = REQUIRED_SCRIPT.get(locale);
  if (script && !script.test(body)) {
    return { stub: true, reason: 'no-script', novel: null, total: lines.length };
  }

  // EXPOSED-KNOWN-FENCE, the other direction. `novel` used to mean "absent from the English
  // PROSE pool", and absence from prose is not evidence of translation when the line is
  // English that simply lives inside a frozen fence. Every expose-style corruption converted
  // keep-in-English content into a positive claim of translation through exactly this gap —
  // `has-novel-lines`, which is worse than the `insufficient` these issues started from,
  // because it asserts rather than admits.
  const fenceLines = english.fenceLines;
  let novel = 0;
  for (const line of lines) {
    if (englishLines.has(line)) continue;
    if (fenceLines && fenceLines.has(line)) continue;
    novel += 1;
  }

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
 * `contentKey` normalises, but not for an id rename). The direction differs by consumer, and
 * there are now THREE, so "fix the walk" is not a decision that can be made from one of them:
 *
 *   - **prose pool, here:** a shrunk pool means a scaffold shows novel lines and reads as
 *     translated — lenient.
 *   - **fence bodies, `fences.js`:** the same pool is a *violation* basis, so a missing
 *     revision manufactures a false violation — strict.
 *   - **fence shapes, here (#561):** a missing revision means a missing *legitimate* shape,
 *     so a genuine translation drops out of the count into `unjudged` — also strict, and this
 *     one silently removes real coverage rather than raising a flag someone reads.
 *
 * Measured on this repo: adding `--diff-merges=separate` changes the pool by 0 lines and the
 * verdict set by 0 files. Re-measure all three before changing the walk.
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
    if (!history.has(key)) {
      history.set(key, { lines: new Set(), fenceShapes: new Set(), fenceLines: new Set() });
    }
    const entry = history.get(key);
    const body = stripFrontmatter(text);
    for (const line of substantiveLines(body)) entry.lines.add(line);
    // Third collector, same walk: the lines English keeps INSIDE its frozen fences.
    //
    // `lines` cannot contain these — it is built through the same mask, which is the whole
    // point of the mask. That absence is what every remaining bypass monetises: corrupt the
    // mask so a frozen body is exposed as prose, and those keep-in-English lines are "absent
    // from the English prose pool", i.e. novel, i.e. evidence of translation. Pooling them
    // separately lets the verdict say what is actually true — this line is English, it is
    // simply English we normally decline to compare.
    for (const fence of extractFences(body)) {
      if (!isGated(fence) || fence.unterminated) continue;
      for (const line of substantiveLines(fence.body)) entry.fenceLines.add(line);
    }
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
