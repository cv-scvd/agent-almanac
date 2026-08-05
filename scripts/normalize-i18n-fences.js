#!/usr/bin/env node
/**
 * normalize-i18n-fences.js
 *
 * Companion repair tool to `check-i18n-fence-parity.js` (#472). Restores the
 * English body of gated code fences in translated skills, which the
 * keep-code-in-English rule requires them to carry verbatim.
 *
 * Shares `lib/fences.js` with the checker, so the two can never disagree about
 * where a fence begins or ends.
 *
 * ## Which English revision is restored
 *
 * By default the translation's own `source_commit` — the English revision it
 * was actually translated from — NOT English at HEAD.
 *
 * That is deliberate. 2,549 translations are stale: their prose describes an
 * older English source. Splicing HEAD's code into a file whose prose predates
 * it produces a document that is internally inconsistent — prose describing one
 * command sitting above a different command — and it silently entangles this
 * parity repair with the separate staleness backlog (#278). Restoring the
 * source_commit body leaves each file coherent, satisfies the parity gate
 * (which accepts any historical English revision), and leaves
 * `check-translation-freshness.js` free to keep reporting the file as stale,
 * which it still is.
 *
 * Pass `--basis head` to restore from English at HEAD instead. That is the
 * right choice only when refreshing the translation's prose in the same pass.
 *
 * ## What it refuses to touch
 *
 * A fence is only rewritten when the translated file and its English basis
 * carry the SAME number of fences in the SAME language-tag sequence. Then
 * ordinal mapping is sound: the nth fence corresponds to the nth fence.
 * Otherwise the file is skipped and reported for manual repair — 46 of the 327
 * affected skills at introduction (41 by fence count, 5 by tag sequence),
 * mostly translations that dropped or merged blocks outright, which no
 * positional rule can safely reconstruct. Those 46 carry 206 fences and are
 * tracked as content forks in #478.
 *
 * Scope: skills only. The checker also covers the agents/teams/guides mirrors,
 * whose 87 gated violations this tool does not yet repair (#477).
 *
 * ## Why preview is the default (#486)
 *
 * It writes only when `--write` is passed. The inverse — write by default,
 * `--dry` to preview — put the destructive mode behind the obvious command, and
 * a read-only probe agent typed it: 281 files / 1,014 fences rewritten during an
 * investigation whose prompt forbade modifying tracked files.
 *
 * The edit was trivially reverted. The expensive part was that every measurement
 * taken afterwards was wrong AND self-consistent — the parity gate read 293
 * instead of 1,307, and 1307 − 1014 = 293 exactly. That arithmetic was read as
 * evidence the published figure had been inflated, and a true finding about a
 * translated 21 CFR Part 11 audit value was publicly retracted before the stray
 * write was found. A silent write turns later measurements into confident lies,
 * which is worse than a crash.
 *
 * Two further guards follow from the same incident: the tool refuses to write
 * into a dirty tree (`git checkout -- i18n/` is the only undo, and it would
 * destroy uncommitted work), and it announces the write on stderr before
 * touching disk, so a stray run is visible even when stdout is redirected.
 *
 * Usage:
 *   node scripts/normalize-i18n-fences.js                # preview (default)
 *   node scripts/normalize-i18n-fences.js --dry          # preview, explicitly
 *   node scripts/normalize-i18n-fences.js --write        # apply
 *   node scripts/normalize-i18n-fences.js --basis head
 *   node scripts/normalize-i18n-fences.js --locale de    # restrict
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { extractFences, toLines, isGated, buildEnglishFenceHistory } from './lib/fences.js';
import { assertNotShallow } from './lib/git-freshness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const I18N_DIR = resolve(ROOT, 'i18n');
const SKILLS_DIR = resolve(ROOT, 'skills');

const argv = process.argv.slice(2);

// Writing is opt-in. `--dry` predates the inversion and is kept as an explicit
// no-op so documented commands and muscle memory keep working; it is the
// default, not a mode. Passing both is a contradiction rather than a preference
// — guessing which one the caller meant is how a "preview" becomes a write.
const WRITE = argv.includes('--write');
const DRY = argv.includes('--dry');
if (WRITE && DRY) {
  console.error('ERROR: --write and --dry contradict each other. Pass one.');
  process.exit(2);
}
const PREVIEW = !WRITE;

/**
 * Read `--flag value`, rejecting a following flag as the value. The naive
 * `argv[i + 1]` version silently accepted `--locale --dry` as locale `"--dry"`,
 * which matched no locale and reported "files to change: 0" — a clean-looking
 * no-op. It also let a trailing `--basis` fall back to the default,
 * short-circuiting the validation immediately below it.
 */
function flagValue(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`ERROR: ${name} requires a value`);
    process.exit(2);
  }
  return v;
}

const BASIS = flagValue('--basis', 'source-commit');
const ONLY_LOCALE = flagValue('--locale');

if (!['source-commit', 'head'].includes(BASIS)) {
  console.error(`ERROR: --basis must be 'source-commit' or 'head' (got '${BASIS}')`);
  process.exit(2);
}

/** Every path this run may rewrite. Also the pathspec the dirty check uses. */
const WRITE_SCOPE = ONLY_LOCALE ? `i18n/${ONLY_LOCALE}` : 'i18n';

// A locale that matches no directory yields "files to change: 0" — the same
// clean-looking no-op `flagValue` above exists to prevent, arriving by typo
// rather than by flag parsing.
if (ONLY_LOCALE && !existsSync(resolve(ROOT, WRITE_SCOPE))) {
  console.error(`ERROR: --locale '${ONLY_LOCALE}' matches no directory (${WRITE_SCOPE}/).`);
  console.error('Nothing would be scanned, and the run would report a clean-looking zero.');
  process.exit(2);
}

// Refuse to write into a dirty tree. `git checkout -- i18n/` is the only undo
// for this tool, and it discards uncommitted work along with the repair — so a
// stray run over unstaged edits is unrecoverable in exactly the case where
// recovery matters most. Checked before the ~90s history build so it fails fast.
if (WRITE) {
  const status = spawnSync('git', ['status', '--porcelain', '--', WRITE_SCOPE], {
    cwd: ROOT, encoding: 'utf8',
  });
  if (status.status !== 0) {
    console.error(`ERROR: could not read git status for ${WRITE_SCOPE}/ — refusing to write.`);
    console.error(status.stderr?.toString().slice(0, 500));
    process.exit(2);
  }
  const dirty = status.stdout.trim();
  if (dirty) {
    const lines = dirty.split('\n');
    console.error(`ERROR: ${WRITE_SCOPE}/ has uncommitted changes:`);
    for (const line of lines.slice(0, 10)) console.error(`  ${line}`);
    if (lines.length > 10) console.error(`  ... and ${lines.length - 10} more`);
    console.error('');
    console.error('This tool rewrites files in place, and `git checkout -- ' + WRITE_SCOPE + '` is the');
    console.error('only undo — it would discard the changes above too. Commit or stash them first.');
    process.exit(2);
  }
}

const GIT_BUFFER = 512 * 1024 * 1024;

function frontmatterField(text, field) {
  const fm = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!fm) return null;
  const m = new RegExp(`^\\s*${field}:\\s*(\\S.*)$`, 'm').exec(fm[1]);
  if (!m) return null;
  // A few source_commit values carry a trailing YAML comment.
  return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
}

/** Batch-resolve `<commit>:skills/<id>/SKILL.md` blobs in one git process. */
function readBlobs(specs) {
  const out = new Map();
  if (!specs.length) return out;
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: Buffer.from(specs.join('\n') + '\n', 'utf8'),
    maxBuffer: GIT_BUFFER,
  });
  if (batch.status !== 0) {
    console.error('ERROR: git cat-file --batch failed');
    console.error(batch.stderr?.toString().slice(0, 500));
    process.exit(1);
  }
  const buf = batch.stdout;
  let offset = 0;
  let index = 0;
  while (offset < buf.length && index < specs.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = buf.slice(offset, nl).toString('utf8');
    offset = nl + 1;
    if (/ (missing|ambiguous)$/.test(header)) { out.set(specs[index], null); index++; continue; }
    const size = Number.parseInt(header.split(' ')[2], 10);
    if (!Number.isFinite(size)) break;
    out.set(specs[index], buf.slice(offset, offset + size).toString('utf8'));
    offset += size + 1;
    index++;
  }
  return out;
}

assertNotShallow(ROOT);
const history = buildEnglishFenceHistory();

// ---- gather targets ----
const targets = [];
for (const locale of readdirSync(I18N_DIR)) {
  if (ONLY_LOCALE && locale !== ONLY_LOCALE) continue;
  const localeSkills = join(I18N_DIR, locale, 'skills');
  if (!existsSync(localeSkills) || !statSync(localeSkills).isDirectory()) continue;
  for (const skill of readdirSync(localeSkills)) {
    const translated = join(localeSkills, skill, 'SKILL.md');
    const english = join(SKILLS_DIR, skill, 'SKILL.md');
    if (!existsSync(translated) || !existsSync(english)) continue;
    const text = readFileSync(translated, 'utf8');
    targets.push({
      locale, skill, path: translated, english,
      relPath: `i18n/${locale}/skills/${skill}/SKILL.md`,
      text,
      sourceCommit: frontmatterField(text, 'source_commit'),
    });
  }
}

// ---- resolve each target's English basis ----
const specs = BASIS === 'source-commit'
  ? [...new Set(targets.filter((t) => t.sourceCommit)
      .map((t) => `${t.sourceCommit}:skills/${t.skill}/SKILL.md`))]
  : [];
const blobs = readBlobs(specs);

let filesChanged = 0;
let fencesRestored = 0;
const skipped = [];
const changedByLocale = new Map();
// Every edit is planned first and applied afterwards, so preview and write walk
// identical code and the preview cannot describe a run the write does not make.
const plan = [];

for (const t of targets) {
  let basisText = null;
  let basisLabel = 'head';
  if (BASIS === 'source-commit' && t.sourceCommit) {
    basisText = blobs.get(`${t.sourceCommit}:skills/${t.skill}/SKILL.md`) ?? null;
    basisLabel = t.sourceCommit;
  }
  if (basisText === null) { basisText = readFileSync(t.english, 'utf8'); basisLabel = 'head'; }

  const translatedFences = extractFences(t.text);
  const basisFences = extractFences(basisText);
  // Keys are `<tree>/<id>` (see lib/fences.js contentKey). A bare `t.skill`
  // lookup returns undefined for every file, which the `everEnglish &&` guard
  // below silently turns into "nothing to repair" — a clean-looking zero.
  const everEnglish = history.get(`skills/${t.skill}`);
  if (!everEnglish) {
    skipped.push({ file: t.relPath, reason: 'no English history for this id', n: 0 });
    continue;
  }

  // Restore exactly what the gate flags: a gated fence whose body appears in no
  // English revision. Using the same predicate as the checker is what keeps the
  // two tools from disagreeing — an ordinal-only test would rewrite fences the
  // gate considers legitimately stale.
  const divergent = translatedFences.filter((f) => isGated(f) && !everEnglish.has(f.body));
  if (divergent.length === 0) continue;

  if (translatedFences.length !== basisFences.length) {
    skipped.push({ file: t.relPath, reason: `fence count ${translatedFences.length} vs basis ${basisFences.length}`, n: divergent.length });
    continue;
  }

  // Ordinal mapping is sound when the tag at every position corresponds.
  //
  // A `text` fence facing an untagged one is NOT a divergence:
  // `normalize-content-style.js --mode fences` retro-tagged untagged blocks as
  // `text`, so that pairing is an artifact of a known repo tool acting on the
  // newer side only. `alignmentTag` folds the two together.
  //
  // This must NOT be expressed as `isGated(a) !== isGated(b)`. Under default-deny
  // an untagged fence is gated while `text` is not, so that formulation makes
  // every one of those benign pairings a misalignment — it stranded 169
  // mechanically-repairable fences across 73 files between the two commits of
  // this PR, while the comment above it still described the pre-inversion
  // behaviour. Alignment is a question about ordinal correspondence, not about
  // what the gate covers.
  const alignmentTag = (f) => (f.lang === '' ? 'text' : f.lang);
  const misaligned = translatedFences.findIndex(
    (f, i) => alignmentTag(f) !== alignmentTag(basisFences[i]),
  );
  if (misaligned >= 0) {
    const a = translatedFences[misaligned].lang || 'untagged';
    const b = basisFences[misaligned].lang || 'untagged';
    skipped.push({ file: t.relPath, reason: `tag sequence diverges at fence ${misaligned + 1} (${a} vs ${b})`, n: divergent.length });
    continue;
  }

  // Splice from the bottom so earlier indices stay valid.
  const lines = toLines(t.text);
  let restoredHere = 0;
  for (let i = translatedFences.length - 1; i >= 0; i--) {
    const f = translatedFences[i];
    if (!divergent.includes(f)) continue;
    const basisBody = basisFences[i].body;
    if (basisBody === f.body) continue;
    lines.splice(f.bodyStart, f.bodyEnd - f.bodyStart, ...basisBody.split('\n'));
    restoredHere++;
  }
  if (!restoredHere) continue;

  filesChanged++;
  fencesRestored += restoredHere;
  changedByLocale.set(t.locale, (changedByLocale.get(t.locale) || 0) + restoredHere);
  plan.push({ path: t.path, relPath: t.relPath, text: lines.join('\n'), n: restoredHere, basisLabel });
}

if (!PREVIEW && plan.length) {
  // stderr, deliberately: every other line here goes to stdout, so `--write >
  // log.txt` would hide them all. A run that rewrites hundreds of corpus files
  // must leave a mark in the transcript no redirection can swallow.
  console.error(`WRITING ${plan.length} file(s) / ${fencesRestored} fence(s) under ${WRITE_SCOPE}/ ...`);
}

for (const p of plan) {
  console.log(`${PREVIEW ? 'would restore' : '   restoring'} ${String(p.n).padStart(2)} fence(s) in ${p.relPath}  (basis ${p.basisLabel})`);
}

if (!PREVIEW) {
  for (const p of plan) writeFileSync(p.path, p.text, 'utf8');
}

console.log(`\n${PREVIEW ? 'PREVIEW — nothing written (pass --write to apply)' : 'Wrote changes'}`);
console.log(`basis: ${BASIS}`);
console.log(`files ${PREVIEW ? 'to change' : 'changed'}: ${filesChanged}`);
console.log(`fences ${PREVIEW ? 'to restore' : 'restored'}: ${fencesRestored}`);
if (changedByLocale.size) {
  console.log(`by locale: ${[...changedByLocale.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}
if (skipped.length) {
  console.log(`\n${skipped.length} file(s) skipped — ordinal mapping is not sound, repair by hand:`);
  for (const s of skipped) console.log(`  ${s.file}  (${s.n} divergent gated fence(s); ${s.reason})`);
}
