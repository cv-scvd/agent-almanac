/**
 * fences.js
 *
 * Shared fenced-code-block extractor for the i18n fence-parity tooling (#472).
 * Used by `check-i18n-fence-parity.js` (which reports) and
 * `normalize-i18n-fences.js` (which rewrites), so the two can never disagree
 * about where a fence starts and ends.
 *
 * Two properties are load-bearing:
 *
 * 1. **CRLF is normalised before parsing.** 68 translated SKILL.md carry CRLF
 *    in the working tree while the committed blob is LF — `*.md text eol=lf`
 *    normalises on the way into the index, not on disk. In a JavaScript regex
 *    `\r` is a LineTerminator, so `.` does not match it and an unanchored `$`
 *    will not match before it. An extractor written the obvious way
 *    (`/^\s*```(\w*)\s*$/` happens to survive; `/^(\s*)(`{3,})(.*)$/` does not)
 *    silently finds ZERO fences in those files and reports them clean. A gate
 *    blind to 69 files is not a gate.
 *
 * 2. **The opening delimiter's run length and character are tracked.** A fence
 *    opened with four backticks may legally contain three-backtick fences —
 *    the skills corpus does this when documenting markdown itself. Closing on
 *    the first ``` would splice two blocks together and invent divergences.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { CONTENT_TYPES } from './content-types.js';
import { contentKey } from './content-paths.js';
import { walkEnglishHistory } from './english-history.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The ONLY fence info-string tags a translation may localise. Everything else
 * is frozen — its body must match the English source byte-for-byte.
 *
 * The polarity is deliberate and is the whole design. An allowlist of "code"
 * tags has to enumerate every language the corpus will ever use, and anything
 * it forgets is unguarded by default. This corpus already carries `logql` (50
 * fences), `bibtex` (20), `jsonl` (10), `traceql` (10), `powershell` (10) and
 * `language` (10) — all of which a hand-written code list misses. All but
 * `language` are at zero violations today (`language` has one), so closing the
 * hole costs one finding now and an unbounded number later. It also NARROWS the
 * retag escape hatch: because the tag is read off the translated file and never
 * compared to English, retagging a ```yaml fence still removes it from the gate
 * — default-deny shrinks the escape set from unbounded to {text, markdown, md}
 * rather than closing it. Closing it needs tag-sequence parity (#481).
 *
 * `text` and `markdown` are exempt because they carry reference tables,
 * decision flows and report templates that a human reads or fills in — a German
 * reviewer should be able to emit a German report. Byte parity on `markdown`
 * would fire 268 times to catch 3 real defects and would forbid the thing the
 * locale exists for.
 *
 * Untagged fences are frozen, not exempt. Measured cost: zero — there are no
 * untagged fence openers in either tree, because `guides/content-styleguide.md`
 * already requires a tag. The remedy for a future one is to tag the English
 * source.
 *
 * Adding a tag here requires naming which machine consumes that fence.
 *
 * Single source of truth for both the checker and the normalizer. A second copy
 * would drift, and the two disagreeing means the repair tool rewrites fences the
 * gate does not flag, or leaves flagged ones alone.
 */
export const LOCALISABLE_TAGS = new Set(['text', 'markdown', 'md']);

/** True when a fence's body must match an English revision byte-for-byte. */
export const isGated = (fence) => !LOCALISABLE_TAGS.has(fence.lang);

/**
 * English content trees that have translated mirrors under `i18n/<locale>/`.
 *
 * Re-exported from the SSOT (#568), NOT re-declared. Note the shape: `import` plus
 * `export const`, never `export { CONTENT_TYPES as TREES } from './content-types.js'` — a bare
 * re-export creates no LOCAL binding.
 *
 * Stated as a rule rather than as a fact about this file, because the fact expired. The
 * original wording said this module reads `TREES` internally "in `contentKey`, in the `git log`
 * pathspec, and in the working-tree walk" (measured then: 42 of 224 tests failing with
 * `ReferenceError: TREES is not defined`). #559 moved all three of those out, so today nothing
 * here reads it and a bare re-export would in fact work. Keep the shape anyway: the next line
 * added to this module that uses `TREES` would otherwise fail at a distance from the edit, and
 * a comment justifying a shape by a condition that can silently stop holding is worse than no
 * comment.
 */
export const TREES = CONTENT_TYPES;

/**
 * Re-exported, not re-declared: `contentKey` now lives in `content-paths.js` so the shared
 * history walker can key blobs without importing this module, which imports the walker (#559).
 * Four modules import it from here — `normalize-i18n-fences.js`, `lib/translation-status.js`,
 * `check-yaml-fences.js`, `test/fences.test.js` — and this keeps all four working unchanged.
 *
 * Same `import` + `export` shape as `TREES` above, for the same forward-looking reason and with
 * the same caveat: nothing in this module reads `contentKey` internally today either.
 */
export { contentKey };

/**
 * Union of every fence body that has ever appeared in each English SKILL.md,
 * keyed by skill id, plus the current working tree.
 *
 * This is the violation basis: a translated fence body absent from this set
 * appears in no English revision, ever, so it cannot be explained by staleness
 * (which can only make a fence match an EARLIER revision) nor by a
 * `source_commit` bumped without retranslation (#405).
 *
 * Costs two git processes rather than one per revision — see `english-history.js`, which owns
 * the walk both this and `buildEnglishProseHistory` run over.
 *
 * `root` defaults to the repo this file lives in, which is how every production caller uses it.
 * It exists as a parameter because it did NOT before, and that was the reason this half of the
 * duplicated walk had no test: nothing could point it at a fixture repo (#559).
 *
 * Also pooled, from the same walk: every folded TAG SEQUENCE each source has carried
 * (`history.sequences`), which is the basis for the retag check (#481). Collected here rather
 * than in a third builder for the reason #559 exists — a third near-identical walk is exactly
 * the duplication that issue removed.
 *
 * @param {string} [root] repository root
 * @returns {Map<string, Set<string>> & {current: Map<string, Fence[]>, sequences: Map<string, Set<string>>}}
 */
export function buildEnglishFenceHistory(root = ROOT, { paths = null } = {}) {
  const history = new Map();
  // Kept separately, keyed the same way: the deleted-fence check needs the fences English has
  // NOW, with their tags, not the flattened union of every body that ever existed.
  const current = new Map();
  const sequences = new Map();

  walkEnglishHistory(root, (key, text, { fromWorkingTree }) => {
    if (!history.has(key)) history.set(key, new Set());
    const set = history.get(key);
    const fences = extractFences(text);
    for (const f of fences) set.add(f.body);
    if (fromWorkingTree) current.set(key, fences);
    if (!sequences.has(key)) sequences.set(key, new Set());
    sequences.get(key).add(foldedTagSequence(fences).join(','));
  }, { paths });

  history.current = current;
  history.sequences = sequences;
  return history;
}

/**
 * A document's fence tags in order, with untagged folded to `text`.
 *
 * The fold is not cosmetic and must not be dropped. `normalize-content-style.js --mode fences`
 * retro-tagged untagged blocks as `text` on the NEWER side only, so an untagged fence facing a
 * `text` one is an artifact of a repo tool rather than a translator action. Without the fold,
 * every one of those pairings reads as a retag.
 *
 * Equally, this must NOT be expressed as `isGated(a) !== isGated(b)`. Under default-deny an
 * untagged fence is gated while `text` is not, so that formulation makes the same benign
 * pairings misalignments — it stranded 169 mechanically-repairable fences across 73 files when
 * `normalize-i18n-fences.js` tried it, and the comment there records why.
 *
 * ALL fences, not just gated ones. The retag this detects is precisely a fence LEAVING the gated
 * set, so a gated-only sequence cannot see it — that is the tripwire #582 removed from the
 * status detector's `fenceShape` and #583 records the loss of. `fenceShape` stays gated-only
 * because it answers a different question (is the frozen-region mask trustworthy?).
 *
 * The fold is on the INFO STRING being empty, not on `lang` being empty, and the difference is
 * load-bearing. `lang` is also `''` for a brace info string — ` ```{r} `, ` ```{r setup} ` —
 * because the split at the bottom of this module breaks on `{`. Brace fences are frozen under
 * default-deny exactly like untagged ones, so folding them to `text` would let an English
 * ` ```{r} ` fence be replaced by a localisable ` ```text ` one with neither this check nor the
 * body check seeing it: the retag escape surviving through its own fix. They get the same `{`
 * placeholder `fenceShape` uses, whose comment already records the lesson — "a 'cannot happen'
 * margin is exactly how this module keeps getting bypassed". Zero top-level brace fences exist
 * today, which is the argument for encoding it now rather than after one appears.
 *
 * Unterminated fences ARE included, unlike in `fenceShape`, and the choice is not free either
 * way. `fenceShape` filters them because an unterminated fence masks nothing (#558). Here the
 * sequence is a structural claim, and a degradation near EOF that leaves a fence open is a real
 * corruption this should see; excluding them would demote it to `unalignable`. The cost is that
 * a translation carrying #558's stray-opener artifact gains a phantom token — usually a count
 * mismatch, so unjudged rather than a false finding. Measured over all 3,644 translated files at
 * introduction: 0 carry an unterminated fence and 0 carry a top-level brace-info fence, so both
 * choices above are free TODAY and are made on their merits rather than on cost. Re-measure
 * before assuming that still holds — `scripts/measure-tag-sequence-parity.js` is the reproducer
 * for the finding set, and neither number is pinned by a gate.
 *
 * @param {Fence[]|string} input fences, or text to extract them from
 * @returns {string[]}
 */
export function foldedTagSequence(input) {
  const fences = typeof input === 'string' ? extractFences(input) : input;
  return fences.map((f) => {
    if (f.lang !== '') return f.lang;
    return f.info === '' ? 'text' : '{';
  });
}

/**
 * @typedef {object} Fence
 * @property {string} lang      lowercased first token of the info string ('' when untagged)
 * @property {string} info      the full info string, trimmed
 * @property {string} body      fence content, LF-joined, delimiters excluded
 * @property {number} line      1-based line number of the opening delimiter
 * @property {number} bodyStart 0-based index of the first body line in `lines`
 * @property {number} bodyEnd   0-based index one past the last body line
 * @property {boolean} [unterminated] set when EOF arrived before a closing delimiter
 */

/** Split text into lines with CRLF (and lone CR) normalised to LF. */
export function toLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * The document's fence structure as one comparable string: every fence's tag, in order.
 *
 * Info-string tags are never translated — they are the machine-readable part of the fence,
 * and the keep-in-English rule freezes them in every locale. So a translated file's shape
 * must equal its English source's shape at *some* revision, and a shape appearing in no
 * revision means the mask cannot be trusted (#561).
 *
 * Shape rather than count, because the failure this detects leaves the count intact. A stray
 * ```` ```bash ```` opener cannot close anything (a closer carries no trailing text), but it
 * *opens*, so the real opener below it is swallowed into the body and the real closer closes
 * the stray fence instead. Measured on a two-fence body: count 1 -> 1, shape `yaml` -> `bash`,
 * and five lines of prose vanish from comparison. A count check sees nothing.
 *
 * Tags, not bodies: #477's backlog leaves 1,220+ translated fence *bodies* diverging from
 * English, so gating on bodies would refuse to judge much of the corpus.
 *
 * **Terminated fences only.** An unterminated fence is not frozen (#558) — it masks nothing —
 * so it does not describe the mask and must not perturb the shape. Excluding it here is what
 * lets the shape comparison stand alone: #558's stray *unterminated* opener leaves the shape
 * unchanged and its file stays judgeable, while a stray *terminated* opener changes the shape
 * and is caught. An earlier attempt kept unterminated fences in the shape and paid for it with
 * a second condition ("did the mask hide lines?"), which left a worse bypass open: a stray
 * ```` ```text ```` opener is localisable, so it hides nothing, yet it still phase-flips and
 * EXPOSES the real frozen body — whose keep-in-English lines are absent from the English prose
 * pool and therefore read as novel. That turned a scaffold into `has-novel-lines`, a positive
 * claim of translation. Mask corruption is symmetric; hiding is only half of it.
 *
 * Joined on `,` rather than `|`, and that is not cosmetic. `lang` is the first token of the
 * info string split on `/[\s{,]/`, so a comma can never occur inside a tag — but a pipe can.
 * A single fence tagged ```` ```bash|yaml ```` produced the shape `bash|yaml`, colliding with
 * the shape of two fences `bash` and `yaml`. That let one gated fence wrapping an entire body
 * match a two-fence English shape, hide everything, and land `insufficient` — translated.
 *
 * @param {string} text
 * @returns {string} e.g. `bash,yaml,markdown`; `''` for a file with no terminated fences
 */
export function fenceShape(text) {
  return extractFences(text)
    // GATED fences only, and this is the whole point of the invariant rather than a detail.
    // The mask `openLines` builds drops FROZEN bodies and keeps localisable ones, so a
    // well-formed `text`/`markdown` fence added or removed in translation cannot corrupt the
    // measurement — it is translatable prose either way. Counting it in the shape cost real
    // translations their verdict for a change that provably could not affect them: measured on
    // the corpus, 76 files mismatched on the all-fence shape and 62 of those had an intact
    // frozen mask. 59 of those 62 recovered; the other 3 are held by a second, independent
    // cause. That is the strict direction, which this module's header names as the expensive
    // one.
    //
    // What it costs, stated conditionally because the unconditional version was wrong. A stray
    // localisable opener still CHANGES this shape — it swallows the real frozen fence, which
    // disappears from the gated list — but changing only CATCHES when the new shape is absent
    // from the pool, and the new shape is often `''`, which any gated-fence-free revision
    // pools. Fences accrete, so that is common rather than exotic. There the catcher is
    // `hasSwallowedOpener`, and the membership tests behind it; a test pins that fallback
    // explicitly rather than leaving it to this comment.
    //
    // It also gives up an accidental tripwire: under the all-fence shape a `yaml`->`text`
    // retag (#481's escape hatch, which also evades the parity gate) usually changed the shape
    // and was flagged here. Under gated-only it is invisible whenever the pre-addition revision
    // already pooled the shorter shape. That tripwire was never designed, never tested, and
    // never documented — but it was real, and its loss belongs on the record rather than in
    // silence. Tag-sequence parity (#481) is the durable close.
    .filter((f) => !f.unterminated && isGated(f))
    // A lang-empty fence renders as `{`, not as the empty string. Empty made a single such
    // terminated fence spell the shape `''` — identical to the shape of a file with NO fences
    // at all. So if any English revision was fence-free, an untagged wrap around the whole
    // body matched the pool, hid everything, and landed `insufficient`.
    //
    // `{` is provably impossible in a `lang`: the extractor strips braces unconditionally
    // (`.replace(/[{}]/g, '')`), so no info string can produce one. An earlier draft used `~`
    // and justified it with "never contains whitespace" — which argues the wrong character.
    // Nothing removes `~`, so ```` ```~ ```` yields `lang === '~'` and collides with the
    // placeholder. A "cannot happen" margin is exactly how this module keeps getting bypassed.
    //
    // Note the placeholder covers more than untagged fences: any `{...}` info string
    // (```` ```{r} ````, ```` ```{r setup} ````) is also lang-empty, and the corpus carries
    // dozens — all currently nested inside ```` ````markdown ```` wraps, so no top-level shape
    // changes today.
    .map((f) => f.lang || '{')
    .join(',');
}

/**
 * Does any fence body contain a line that would itself have opened a fence?
 *
 * The phase flip's invariant fingerprint, and the half `fenceShape` structurally cannot see.
 * A stray opener carrying the SAME tag as the fence below it is terminated by that fence's
 * real closer and takes over its position in the shape string — so the shape stays
 * byte-identical while the mask is completely wrong. Shape equality cannot close this,
 * because the attack preserves shape by construction. Measured: a 5-line body drops to 3,
 * lands `insufficient`, and is counted as translated, with one added line.
 *
 * What it looks for is the swallowed opener itself: inside a fence body, a line with the same
 * delimiter character, a run at least as long as the enclosing fence's, and a non-empty info
 * string. Such a line is unreachable in a well-formed document — it would have closed the
 * fence if its info string were empty, and it cannot appear as content because the parser
 * would have ended the fence before reaching it.
 *
 * Deliberately not fooled by legitimate fence-in-fence documentation, which this corpus writes
 * with a longer outer run (a ````` ````markdown ````` wrapping ```` ```r ````): the inner run
 * is SHORTER than the enclosing one, so it fails the length test. Nor by a ```` ``` ```` line
 * inside a `~~~` fence, which is ordinary content — the delimiter characters differ.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasSwallowedOpener(text) {
  return extractFences(text).some((fence) => {
    return toLines(fence.body).some((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      return Boolean(
        match
        && match[1][0] === fence.delim
        && match[1].length >= fence.len
        && match[2].trim() !== '',
      );
    });
  });
}

/**
 * Extract every fenced block from `text`.
 * @param {string} text
 * @returns {Fence[]}
 */
export function extractFences(text) {
  const lines = toLines(text);
  const out = [];
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]);

    if (open === null) {
      if (match) {
        const info = match[3].trim();
        open = {
          delim: match[2][0],
          len: match[2].length,
          info,
          lang: (info.split(/[\s{,]/)[0] || '').replace(/[{}]/g, '').toLowerCase(),
          line: i + 1,
          bodyStart: i + 1,
        };
      }
      continue;
    }

    const closes = match
      && match[2][0] === open.delim
      && match[2].length >= open.len
      && match[3].trim() === '';

    if (closes) {
      out.push({
        lang: open.lang,
        info: open.info,
        body: lines.slice(open.bodyStart, i).join('\n'),
        // Exposed for hasSwallowedOpener, which must apply CommonMark's own closer rule
        // (same character, run at least as long) to lines INSIDE the body.
        delim: open.delim,
        len: open.len,
        line: open.line,
        bodyStart: open.bodyStart,
        bodyEnd: i,
      });
      open = null;
    }
  }

  if (open !== null) {
    out.push({
      lang: open.lang,
      info: open.info,
      body: lines.slice(open.bodyStart).join('\n'),
      delim: open.delim,
      len: open.len,
      line: open.line,
      bodyStart: open.bodyStart,
      bodyEnd: lines.length,
      unterminated: true,
    });
  }

  return out;
}
/**
 * Does this translation's folded tag sequence exist in English?
 *
 * #481: the retag escape. `isGated` reads the info string off the TRANSLATION, so retagging a
 * frozen ```yaml fence to ```text removes it from the body check entirely — the set of fences
 * under the gate is chosen by the file being gated. Default-deny narrowed that escape to
 * {text, markdown, md} without closing it, and #583 records that the status detector's
 * accidental tripwire for the same escape was removed in #582, leaving this the only cover.
 *
 * Staleness-immune by the same construction as the body check: the sequence must match SOME
 * English revision, never HEAD. A stale translation legitimately carries an older sequence.
 *
 * @param {string[]} mine folded tag sequence of the translation
 * @param {Set<string>|undefined} englishSequences joined folded sequences from every revision
 * @returns {null | {unalignable: true} | {positions: {index: number, english: string, translated: string}[]}}
 */
export function compareTagSequence(mine, englishSequences) {
  if (!englishSequences || englishSequences.has(mine.join(','))) return null;

  // `''.split(',')` is `['']` — length 1, not 0. A source revision with NO fences joins to the
  // empty string, so the naive length made it look like a one-fence revision, matched it against
  // every one-fence translation, and compared position 1 against `undefined`. That fabricated 3
  // findings reading `#1 ->markdown`, and it was caught only because an independent measurement
  // of the same property disagreed by exactly 3 — not by any test.
  const lengthOf = (seq) => (seq === '' ? 0 : seq.split(',').length);
  const sameLength = [...englishSequences].filter((seq) => lengthOf(seq) === mine.length);

  // NOT a violation. With a different number of fences there is no positional correspondence to
  // claim anything about, and a translation predating a fence English later gained lands here —
  // calling that a violation reintroduces exactly the staleness confound this gate avoids.
  if (sameLength.length === 0) return { unalignable: true };

  // Report against the count-matched revision differing in the FEWEST positions — the nearest
  // legal basis. An arbitrary one inflates a single retag into wholesale divergence.
  let best = null;
  for (const candidate of sameLength) {
    const other = candidate === '' ? [] : candidate.split(',');
    const diff = mine
      .map((tag, i) => ({ index: i + 1, english: other[i], translated: tag }))
      .filter((d) => d.english !== d.translated);
    if (!best || diff.length < best.length) best = diff;
  }
  return { positions: best };
}

/**
 * Is a tag-sequence mismatch the #481 escape, or ordinary tag drift?
 *
 * Two populations arrive at `compareTagSequence` with the same shape and opposite meanings, and
 * #598 is the triage that separated them on the corpus. Both were reported as one undifferentiated
 * blocking finding, which is why neither could be ratcheted: a count whose members mean different
 * things cannot be read.
 *
 *   - **escape** — a frozen tag became localisable. This is #481 proper: the fence leaves the
 *     body check entirely, because gating is read off the TRANSLATED file. Nothing else in the
 *     repo can see it, so it must block. Measured population at introduction: 3, all in
 *     `escalate-issues`, all caused by a 4-backtick ` ````markdown ` opener degraded to 3, which
 *     closes early and swallows the following `python` fence into a `text` block.
 *   - **drift** — every other tag mismatch: `bash`->`yaml`, a reordering of `javascript`/
 *     `typescript`. Both sides stay frozen, so the body check still covers every fence and the
 *     escape is not in play. Measured population: 6, and they split further — 4 are partial-update
 *     drift on stale files (`harden-github-repo-security`, 3 English commits since their
 *     `source_commit`), whose remedy is retranslation and belongs to
 *     `check-translation-freshness.js`; 2 are FRESH files carrying an English subsection at the
 *     wrong ordinal (`annotate-source-files`, zero English commits since — #626), whose remedy is
 *     a translation edit and belongs to nobody else.
 *
 * That second group is why the class is defined by what it does to the GATE rather than by its
 * cause. "Drift" is a statement about coverage — no fence left the body check — not a diagnosis.
 * The causes vary and are triaged per member in `debt-ratchet.yml`.
 *
 * The asymmetry in the test is the point, and it is why this is not `translated !== english`.
 * A mismatch matters here only when the fence LEAVES the gated set; a frozen-to-frozen change
 * loses no coverage. `LOCALISABLE_TAGS`, not a fourth literal copy of `['text','markdown','md']`
 * — the folded `{` token for a brace info string is deliberately absent from that set, so
 * ` ```{r} ` -> ` ```text ` classifies as an escape, which is the whole reason `foldedTagSequence`
 * does not collapse braces to `text`.
 *
 * @param {{index: number, english: string, translated: string}[]} positions from `compareTagSequence`
 * @returns {boolean} true when at least one position frees a frozen fence
 */
export function isRetagEscape(positions) {
  return positions.some(
    (p) => LOCALISABLE_TAGS.has(p.translated) && !LOCALISABLE_TAGS.has(p.english),
  );
}

/**
 * Does `mine` mirror `basis` — the same document, fence for fence?
 *
 * The predicate BOTH writers of `fence_basis_commit` consult before they may stamp it
 * (`normalize-i18n-fences.js` after a repair, `backfill-fence-basis.js` over the corpus). It
 * lives here, once, because two tools disagreeing about what "verified" means is exactly the
 * agreement-between-files failure the field was introduced to end.
 *
 * Three conjuncts, and none is redundant:
 *
 *   - same fence COUNT, so ordinal correspondence exists at all;
 *   - same folded tag SEQUENCE. Without it a fence retagged from ```yaml to ```text but
 *     carrying the identical body reads as a mirror — the #481 escape surviving through the
 *     very check meant to close it. `foldedTagSequence`, not a local `lang === '' ? 'text'`
 *     fold, because the latter cannot tell ```{r} from an untagged fence (#612);
 *   - every GATED body byte-equal at its ordinal. Ungated fences are exempt by design: the
 *     claim is about frozen content, and localising a `text` block is allowed.
 *
 * This says nothing about whether the basis is one the history walk can SEE. That is a separate
 * question with its own answer — see the callers, which additionally require the bodies and the
 * folded sequence to be present in the walked pool. A basis resolved by `git cat-file` but
 * absent from `git log --name-only` output is real (merges, other branches) and stamping it
 * signs a claim the parity gate contradicts on its next run.
 *
 * @param {Fence[]} mine fences of the translated file
 * @param {Fence[]} basis fences of the English blob being claimed
 * @returns {boolean}
 */
export function mirrorsBasis(mine, basis) {
  if (mine.length !== basis.length) return false;
  if (foldedTagSequence(mine).join(',') !== foldedTagSequence(basis).join(',')) return false;
  return mine.every((f, i) => !isGated(f) || f.body === basis[i].body);
}
