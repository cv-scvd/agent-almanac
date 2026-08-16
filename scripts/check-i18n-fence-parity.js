#!/usr/bin/env node
/**
 * check-i18n-fence-parity.js
 *
 * Enforces the keep-code-in-English rule for fenced code blocks in translated
 * content — skills, agents, teams and guides. `CLAUDE.md` § Translation Rules
 * and `i18n/README.md` both declare code blocks keep-in-English, and
 * `skills/translate-content/SKILL.md` step 5.3 even instructs the translator to
 * "diff the fenced blocks" — but nothing mechanical checked it, and the corpus
 * drifted (#472).
 *
 * That the rule was stated four times and still violated is the point: every
 * i18n commit in this repo postdates the commit that introduced step 5.3
 * (77006e7a, 2026-03-13), so every violation was produced under a procedure
 * that told the agent to verify exactly this. Prose does not enforce.
 *
 * ## What counts as a violation
 *
 * A fence body in a translated file is a violation when it appears in NO
 * revision of its English counterpart, ever.
 *
 * That basis is chosen to be immune to the two confounds that make the naive
 * comparison unusable:
 *
 *   - **Staleness.** 2,549 translations are stale repo-wide. A stale
 *     translation's fence legitimately matches an OLDER English source and
 *     diverges from HEAD without anybody having translated anything. Comparing
 *     against HEAD alone would report those as violations.
 *   - **`source_commit` bumps.** `evolve-skill` bumps `source_commit` without
 *     retranslating (#405), so the frontmatter's claimed basis can sit ahead of
 *     the real one. Anchoring to `source_commit` inherits that lie.
 *
 * Searching the whole history of the English file dodges both: staleness can
 * only ever make a fence match an *earlier* English revision, never a revision
 * that does not exist. So anything this reports was written by a human or an
 * agent and never existed in English. Measured false positives on the corpus at
 * introduction: 1 whitespace-only (under a per-line-trim reading) and 2
 * cross-skill artifacts out of 2,115 divergences — 0.14%.
 *
 * Consequence, stated deliberately: a fence matching an OLD English revision
 * passes. That is staleness, which is `check-translation-freshness.js`'s job,
 * not this gate's. The same deliberate choice means a translation that DELETES
 * a frozen fence is not caught here — see #480, and the comment at the end of
 * the compare loop for why the obvious fix reintroduces the confound.
 *
 * ## Why not the CJK discriminator
 *
 * #472 proposed flagging fences containing CJK characters absent from English.
 * That is sound but sees only 457 of 1,307 gated violations (35%) — it is
 * structurally blind to `de` and `es`, which contribute 648 between them, and
 * to reworded-ASCII violations in every locale. German is the largest violator
 * and transliterates umlauts inside fences (`pruefen`, `fuer`, `zaehlen`), so
 * even a Latin-diacritic test misses most of it.
 *
 * Usage:
 *   node scripts/check-i18n-fence-parity.js                    # fail on violation
 *   node scripts/check-i18n-fence-parity.js --warn             # report, exit 0
 *   node scripts/check-i18n-fence-parity.js --all              # include ungated tags
 *   node scripts/check-i18n-fence-parity.js --json             # machine-readable
 *   node scripts/check-i18n-fence-parity.js --limit N          # cap printed findings
 *   node scripts/check-i18n-fence-parity.js --locale de        # one locale
 *   node scripts/check-i18n-fence-parity.js --locale de --id X # one file
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertNotShallow } from './lib/git-freshness.js';
import { extractFences, buildEnglishFenceHistory, isGated, foldedTagSequence } from './lib/fences.js';
import { FENCE_BASIS_FIELD, readFrontmatterField } from './lib/provenance.js';
import { CONTENT_TYPES } from './lib/content-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WARN_ONLY = process.argv.includes('--warn');
const SHOW_ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');

/**
 * Read `--flag value`, rejecting a following flag as the value. Bare
 * `--limit` with nothing after it used to yield `Number(undefined)` = NaN,
 * which made `slice(0, NaN)` print no findings AND suppressed the "N more"
 * hint, so the run looked clean.
 */
function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`ERROR: ${name} requires a value`);
    process.exit(2);
  }
  return v;
}

/**
 * The repo to check. Defaults to this one, which is how every real invocation uses it.
 *
 * It exists as a flag because the gate was otherwise untestable end to end, and that gap was
 * not theoretical: deleting the blocking flag from the tag-sequence finding SURVIVED against the
 * whole suite, meaning every such finding could stop being blocking with 298 tests still green.
 * Three component-level mutation kills had been quoted as coverage for a path nothing executed.
 *
 * The flag is deliberately NOT quoted verbatim here. Spelling it out made this comment a second
 * match site for the very mutation it describes, and `mutation-check` refused the run rather than
 * guessing which site to mutate — the same collision the A10 envelope hit hours earlier, where
 * a comment quoting `find agents teams guides ...` doubled its own case.
 *
 * Third time this exact shape has appeared here — `buildEnglishFenceHistory()` closing over its
 * module root (#559), `gate-envelope.js` before `--root`, and now this. The rule it keeps
 * teaching: a module that hardcodes its own repo root cannot be tested, so it will not be.
 */
const ROOT = resolve(flagValue('--root', resolve(__dirname, '..')));
const I18N_DIR = resolve(ROOT, 'i18n');

const LIMIT = Number(flagValue('--limit', '40'));
if (!Number.isFinite(LIMIT)) { console.error('ERROR: --limit must be a number'); process.exit(2); }
const ONLY_LOCALE = flagValue('--locale', null);
const ONLY_ID = flagValue('--id', null);

/**
 * Translated content trees this gate covers. `skills` is where the corpus and
 * the violations are, but the rule as written in CLAUDE.md and i18n/README.md
 * says "any translated file" — and the mirrors carry 168 gated fences that a
 * skills-only walk never opens. Covering them is what makes the documented rule
 * true.
 *
 * The DIRECTORY LIST is derived from the SSOT (#578), so this gate and the English-history
 * side in `fences.js` cannot disagree about which trees exist. The nesting flag stays local
 * because it is a different fact — the layout of one tree, not the set of trees.
 *
 * `NESTING` is a record with a THROW, not a Set with a default. The first version used
 * `NESTED.has(dir)`, which is a silently-defaulting predicate: an unclassified tree gets
 * `false`, its entries are directories, they fail the `.endsWith('.md')` test in
 * `collectTargets`, and the tree contributes zero targets — so the gate prints OK having
 * scanned nothing. There is no per-tree zero-target guard to catch it. That is the
 * vacuous-pass shape this repo keeps paying for, and the comment claiming the opposite was
 * worse than the code.
 *
 * Throwing at module load means a fifth tree in the SSOT breaks every CI invocation of this
 * gate until someone declares its layout. Loud is the point.
 */
const NESTING = { skills: true, agents: false, teams: false, guides: false };
export const TREES = CONTENT_TYPES.map((dir) => {
  if (!(dir in NESTING)) {
    throw new Error(
      `check-i18n-fence-parity: content type '${dir}' has no declared i18n layout. `
      + 'Add it to NESTING (true if mirrored as <dir>/<id>/FILE.md, false if <dir>/<id>.md).',
    );
  }
  return { dir, nested: NESTING[dir] };
});

/** Every translated file to compare, as { relPath, absPath, locale, id, tree }. */
export function collectTargets() {
  const out = [];
  for (const locale of readdirSync(I18N_DIR)) {
    if (ONLY_LOCALE && locale !== ONLY_LOCALE) continue;
    for (const { dir, nested } of TREES) {
      const base = join(I18N_DIR, locale, dir);
      if (!existsSync(base) || !statSync(base).isDirectory()) continue;
      for (const entry of readdirSync(base)) {
        const id = nested ? entry : entry.replace(/\.md$/, '');
        if (ONLY_ID && id !== ONLY_ID) continue;
        const absPath = nested ? join(base, entry, 'SKILL.md') : join(base, entry);
        if (!nested && !entry.endsWith('.md')) continue;
        if (!existsSync(absPath) || !statSync(absPath).isFile()) continue;
        out.push({
          absPath, locale, id, tree: dir,
          relPath: `i18n/${locale}/${dir}/${nested ? `${entry}/SKILL.md` : entry}`,
        });
      }
    }
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

function main() {
  assertNotShallow(ROOT);

  const history = buildEnglishFenceHistory(ROOT);
  const findings = [];
  let filesCompared = 0;
  let fencesCompared = 0;
  let ungatedDivergences = 0;
  let tagSequenceUnalignable = 0;
  let staleBasisClaims = 0;

  for (const t of collectTargets()) {
    const englishFences = history.get(`${t.tree}/${t.id}`);
    if (!englishFences) continue; // orphan: check-i18n-frontmatter-parity.js owns that

    filesCompared++;
    const text = readFileSync(t.absPath, 'utf8');
    const translatedFences = extractFences(text);

    // #552: `fence_basis_commit` is READ here and never consulted before a comparison. The byte
    // check below stays unconditional — a field that could suppress it would be a bypass, and
    // the mutation guarding this design (hand-edit a fence body, leave the field alone) has to
    // stay red. What the field adds is the one thing bytes alone cannot say: whether the file
    // CLAIMS to have been verified against a named English revision. A claim plus a divergence
    // is a false claim, and it is strictly worse than no claim, because the next tool to read
    // the frontmatter believes it.
    const claimedBasis = readFrontmatterField(text, FENCE_BASIS_FIELD);
    let divergedHere = 0;

    // #481: the retag escape. `isGated` reads the info string off the TRANSLATION, so retagging
    // a frozen ```yaml fence to ```text removes it from the loop below entirely — the set of
    // fences under the gate is chosen by the file being gated. Default-deny narrowed that escape
    // to {text, markdown, md} without closing it, and #583 records that the status detector's
    // accidental tripwire for the same escape was removed in #582, leaving this the only cover.
    //
    // Staleness-immune by the same construction as the body check: the sequence must match SOME
    // English revision, never HEAD. A stale translation legitimately carries an older sequence.
    //
    // Count-mismatched pairs are NOT violations. With a different number of fences there is no
    // positional correspondence to claim anything about, and a translation predating a fence
    // English later gained lands here — calling that a violation reintroduces exactly the
    // staleness confound this gate exists to avoid.
    const seqVerdict = compareTagSequence(
      foldedTagSequence(translatedFences), history.sequences.get(`${t.tree}/${t.id}`),
    );
    if (seqVerdict?.unalignable) {
      tagSequenceUnalignable++;
    } else if (seqVerdict) {
      findings.push({
        file: t.relPath,
        line: translatedFences[seqVerdict.positions[0].index - 1]?.line ?? 1,
        locale: t.locale,
        skill: t.id,
        tag: seqVerdict.positions.map((p) => `#${p.index} ${p.english}->${p.translated}`).join(', '),
        gated: true,
        kind: 'tag-sequence',
        firstDivergentLine: `fence tag sequence appears in no English revision (${seqVerdict.positions.length} position(s) differ)`,
      });
    }

    for (const fence of translatedFences) {
      fencesCompared++;
      if (englishFences.has(fence.body)) continue;
      const gated = isGated(fence);
      if (gated) divergedHere++;
      if (!gated) { ungatedDivergences++; if (!SHOW_ALL) continue; }
      findings.push({
        file: t.relPath,
        line: fence.line,
        locale: t.locale,
        skill: t.id,
        tag: fence.lang || '(untagged)',
        gated,
        kind: 'diverged',
        firstDivergentLine: (fence.body.split('\n').find((l) => l.trim() !== '') || '').trim().slice(0, 100),
      });
    }

    // A translation that DELETES a frozen fence outright contributes nothing to
    // the loop above, so it reports clean. That gap is real and tracked in #480
    // — but it is NOT fixable by comparing against current English, which is
    // what a first attempt did here. A stale translation legitimately lacks
    // fences English gained after it was written, so that comparison
    // reintroduces exactly the staleness confound this gate exists to avoid:
    // measured, it produced 1,518 findings across 402 files, topped by four
    // `quick-reference.md` mirrors that `check-translation-freshness.js`
    // independently reports as stale. Any fix must be staleness-immune the way
    // the divergence check is.

    // The false claim (#552). Reported as its own kind rather than folded into the divergence
    // count, because it accuses the FRONTMATTER, not the body: the bytes are already flagged
    // above, and what this adds is that the file also asserts they were checked. Not gated —
    // it cannot make a run fail that the underlying divergence did not already fail — so it
    // can never be the reason a corpus goes red, only the reason someone stops trusting a
    // field. Absence of the field is silent by design: absent means unverified, which is the
    // honest state for every file predating this schema.
    if (claimedBasis && divergedHere > 0) {
      staleBasisClaims++;
      findings.push({
        file: t.relPath,
        line: 1,
        locale: t.locale,
        skill: t.id,
        tag: FENCE_BASIS_FIELD,
        gated: false,
        kind: 'stale-basis-claim',
        firstDivergentLine: `frontmatter claims ${FENCE_BASIS_FIELD}: ${claimedBasis}, but ${divergedHere} gated fence(s) match no English revision`,
      });
    }
  }

  const blocking = findings.filter((f) => f.gated);

  if (AS_JSON) {
    // process.exit() discards writes still queued on an async pipe, which
    // truncated this payload to 65,536 bytes whenever stdout was piped rather
    // than redirected — the exact consumer this mode exists for.
    console.log(JSON.stringify({
      filesCompared, fencesCompared,
      violations: blocking.length,
      ungatedDivergences,
      tagSequenceFindings: findings.filter((f) => f.kind === 'tag-sequence').length,
      tagSequenceUnalignable,
      staleBasisClaims,
      findings,
    }, null, 2));
    process.exitCode = blocking.length > 0 && !WARN_ONLY ? 1 : 0;
    return;
  }

  const label = WARN_ONLY ? 'WARN' : 'FAIL';
  for (const f of findings.slice(0, LIMIT)) {
    const kind = f.gated ? label : 'INFO';
    console.log(`${kind} ${f.file}:${f.line} [${f.tag}] ${f.firstDivergentLine}`);
  }
  if (findings.length > LIMIT) {
    console.log(`... ${findings.length - LIMIT} more (use --limit ${findings.length} to see all, or --json)`);
  }

  const tagSeq = blocking.filter((f) => f.kind === 'tag-sequence');
  const byTag = new Map();
  for (const f of blocking.filter((f) => f.kind !== 'tag-sequence')) byTag.set(f.tag, (byTag.get(f.tag) || 0) + 1);
  const byLocale = new Map();
  for (const f of blocking) byLocale.set(f.locale, (byLocale.get(f.locale) || 0) + 1);

  console.log(`\ni18n fence parity: ${fencesCompared} fences in ${filesCompared} translated skills`);
  console.log(`compared against every historical revision of their English source.`);

  if (blocking.length === 0) {
    console.log('OK: every gated code fence matches an English source revision.');
  } else {
    const files = new Set(blocking.map((f) => f.file)).size;
    console.log(`\n${blocking.length} gated-fence violation(s) across ${files} file(s).`);
    console.log(`by tag:    ${[...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`by locale: ${[...byLocale.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log('\nFix: restore the English fence body verbatim. Code blocks are keep-in-English');
    console.log('(CLAUDE.md § Translation Rules, i18n/README.md). Translate the surrounding prose only.');
  }
  if (tagSeq.length) {
    // Reported apart from body divergences because the remedy differs: a body divergence is
    // repaired by restoring the English text, a tag-sequence finding by restoring the fence
    // STRUCTURE — and the two most common causes need different judgement. Measured at
    // introduction across 3,584 count-matched pairs: 9 findings, of which 3 were a frozen tag
    // becoming localisable (the #481 escape proper, and in `escalate-issues` caused by a
    // 4-backtick opener degraded to 3, which swallows the next fence whole) and 6 were
    // partial-update drift on stale files. Read the file before repairing it.
    console.log(`\n${tagSeq.length} fence tag-sequence finding(s) — a structure appearing in NO English revision.`);
    console.log('These are the retag escape (#481): a frozen tag changed to text/markdown/md leaves');
    console.log('the body check entirely, because gating is read off the translated file.');
    for (const f of tagSeq.slice(0, LIMIT)) console.log(`  ${f.file}  ${f.tag}`);
    if (tagSeq.length > LIMIT) console.log(`  ... ${tagSeq.length - LIMIT} more`);
  }
  if (tagSequenceUnalignable) {
    // Deliberately not a finding. No English revision has that fence COUNT, so there is no
    // positional correspondence to make a claim about; a stale translation predating a fence
    // English later gained lands here. Counting them keeps the omission visible rather than
    // silent — the population is unmeasured otherwise.
    console.log(`\n${tagSequenceUnalignable} file(s) unjudged for tag sequence — no English revision has their fence count.`);
    console.log('Not violations: without a count match there is no position to compare (staleness, #481).');
  }
  if (ungatedDivergences) {
    // Deliberately does NOT say "untagged": untagged fences are frozen under
    // default-deny, so an untagged divergence prints FAIL and is counted above.
    console.log(`\n${ungatedDivergences} divergence(s) in localisable tags (text/markdown/md) — localising those is allowed.`);
    if (!SHOW_ALL) console.log('Use --all to list them.');
  }
  if (staleBasisClaims) {
    // Ungated on purpose: the divergence underneath each of these is already counted above, so
    // gating them would double-count the same file and could not change any verdict. The value
    // is that the frontmatter is now known to be lying — a `fence_basis_commit` present on a
    // file whose fences diverge. Repairing the body clears it automatically; if the body is
    // legitimately divergent, the field should be removed instead.
    console.log(`\n${staleBasisClaims} file(s) claim a ${FENCE_BASIS_FIELD} their fences contradict (#552).`);
    console.log('Absence of the field is not a finding — absent means unverified, which is honest.');
  }

  process.exit(blocking.length > 0 && !WARN_ONLY ? 1 : 0);
}

// Guarded so the module can be IMPORTED by a test without running the gate. Without this,
// importing to check anything executes the whole walk — which is why the fifth-tree check
// was a regex over source text, asserting token presence rather than behaviour. The pattern
// matches check-readme-translation-parity.js, and it is what dependency-free.test.js relies on.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
