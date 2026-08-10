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
 * Pass `--basis head` to restore from current English instead. That is the right
 * choice only when refreshing the translation's prose in the same pass.
 *
 * Note that "head" reads the WORKING TREE, not the HEAD commit — and so does the
 * default basis whenever a translation's `source_commit` fails to resolve. An
 * uncommitted English edit is a legitimate parity basis, so this is deliberate,
 * but it means a dirty `skills/` changes what is spliced into the corpus. Such
 * restores are reported as basis `worktree`; a `--write` run warns when
 * `skills/` is dirty.
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
 * Scope: all four content trees — `skills`, `agents`, `teams`, `guides` — so it
 * covers exactly what `check-i18n-fence-parity.js` flags. It was skills-only
 * until the mirrors became the last mechanically-repairable slice of #477: 87 of
 * the 335 gated violations, 76 of them in `guides/quick-reference.md` across
 * four locales, and every one a translated comment inside a `bash`, `r` or
 * `yaml` fence.
 *
 * `--tree` scopes a run the way `--tag` scopes one, so the mirrors land as their
 * own reviewable batch. Paths differ by tree — `skills/<id>/SKILL.md` against
 * `<tree>/<id>.md` — and which names count as content at all is decided by
 * `contentKey` from `lib/fences.js`, the same function the history index is
 * built with, rather than by a second list here that could drift from it.
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
 *   node scripts/normalize-i18n-fences.js --locale de    # restrict to one locale
 *   node scripts/normalize-i18n-fences.js --tag yaml,json  # restrict to tags (#477 batches)
 *   node scripts/normalize-i18n-fences.js --tree guides,agents  # restrict to trees
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  extractFences, toLines, isGated, buildEnglishFenceHistory, TREES, contentKey,
} from './lib/fences.js';
import { assertNotShallow } from './lib/git-freshness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const I18N_DIR = resolve(ROOT, 'i18n');

const argv = process.argv.slice(2);

/**
 * Single-pass argument parser, default-deny: an argument this table does not
 * name is an error, never a silent no-op.
 *
 * The `indexOf('--locale')` version it replaces failed open in the worst
 * possible direction. `--locale=de` is the ordinary GNU idiom, and `indexOf`
 * does not match it — so `ONLY_LOCALE` stayed null, the locale scoping vanished,
 * and a run the caller had narrowed to one locale silently covered all ten.
 * With `--write` that is 281 files rewritten where 63 were asked for: a stray
 * broad write reached through a natural spelling of a correct command, which is
 * precisely the #486 failure this file exists to prevent.
 *
 * The same silence covered every other unrecognised argument. A mistyped
 * `--wrte` is harmless now that preview is the default, but a mistyped or
 * misspelled `--locale` was not, and neither was a stray positional. Rejecting
 * the whole unknown space costs nothing and removes the class.
 *
 * Also retains the older guard this replaces: `--locale --dry` must not read
 * `"--dry"` as the locale value.
 */
const BOOL_FLAGS = new Set(['--write', '--dry']);
const VALUE_FLAGS = new Set(['--basis', '--locale', '--tag', '--tree']);

function usageError(message) {
  console.error(`ERROR: ${message}`);
  console.error(`Usage: ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(' ')}`);
  process.exit(2);
}

const opts = { write: false, dry: false, basis: 'source-commit', locale: null, tag: null, tree: null };
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const name = eq >= 0 ? arg.slice(0, eq) : arg;

  if (BOOL_FLAGS.has(name)) {
    if (eq >= 0) usageError(`${name} takes no value (got '${arg}')`);
    opts[name.slice(2)] = true;
  } else if (VALUE_FLAGS.has(name)) {
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      usageError(`${name} requires a value`);
    }
    opts[name.slice(2)] = value;
  } else {
    usageError(`unknown argument '${arg}'`);
  }
}

// Writing is opt-in. `--dry` predates the inversion and is kept as an explicit
// no-op so documented commands and muscle memory keep working; it is the
// default, not a mode. Passing both is a contradiction rather than a preference
// — guessing which one the caller meant is how a "preview" becomes a write.
if (opts.write && opts.dry) {
  console.error('ERROR: --write and --dry contradict each other. Pass one.');
  process.exit(2);
}
const WRITE = opts.write;
const PREVIEW = !WRITE;

const BASIS = opts.basis;
const ONLY_LOCALE = opts.locale;

if (!['source-commit', 'head'].includes(BASIS)) {
  console.error(`ERROR: --basis must be 'source-commit' or 'head' (got '${BASIS}')`);
  process.exit(2);
}

/**
 * Restrict the run to fences carrying these tags — the tag-scoped batches #477
 * calls for, so a 1,307-fence backlog lands as reviewable, individually
 * revertable slices instead of one 300-file diff.
 *
 * Scoping is applied to the DIVERGENT set only, never to the soundness checks:
 * fence-count and tag-sequence alignment still consider every fence in the file,
 * because whether ordinal mapping is trustworthy is a property of the whole
 * file, not of the slice being repaired. Narrowing those would let a batch
 * rewrite fences in a file the unscoped run correctly refuses to touch.
 */
const ONLY_TAGS = opts.tag === null ? null : new Set(
  opts.tag.split(',').map((t) => t.trim().toLowerCase()).filter((t) => t !== ''),
);
if (ONLY_TAGS !== null && ONLY_TAGS.size === 0) {
  console.error("ERROR: --tag was given no usable value (got '" + opts.tag + "').");
  process.exit(2);
}
// `untagged` names the empty info string, which is gated under default-deny and
// would otherwise be unaddressable from the command line.
const tagOf = (fence) => (fence.lang === '' ? 'untagged' : fence.lang);

/**
 * The locales this tool can actually scan: a directory under `i18n/` carrying a
 * `skills/` subtree. Derived once and used BOTH to validate `--locale` and to
 * drive the scan below, so the two cannot disagree about what a locale is.
 *
 * Validating instead by `existsSync` on the constructed `i18n/<value>` path —
 * the first version of this guard — accepted every input that named some
 * existing path, which is not the same question. `--locale de/skills`,
 * `--locale ..` and `--locale glossaries` (a real directory with no `skills/`)
 * all passed a guard whose entire job is to reject a run that scans nothing,
 * and all three then reported the clean-looking zero it exists to prevent.
 * Membership in the scan's own list is the only formulation that cannot drift
 * from the scan.
 */
const hasTree = (locale, tree) => {
  const p = join(I18N_DIR, locale, tree);
  return existsSync(p) && statSync(p).isDirectory();
};

/**
 * Scoped to content trees, so the mirrors can be repaired as their own batch —
 * 87 of the 335 gated violations live in `agents`/`teams`/`guides`, and 76 of
 * those in one guide across four locales.
 *
 * Validated against the trees this repository actually carries rather than
 * against `TREES`, for the same reason `--locale` is validated against the
 * scan's own list: a value that names a real tree the corpus has no
 * translations for would otherwise report the clean-looking zero both guards
 * exist to reject.
 */
const PRESENT_TREES = TREES.filter((tree) =>
  readdirSync(I18N_DIR).some((locale) => hasTree(locale, tree)));

const ONLY_TREES = opts.tree === null ? null : new Set(
  opts.tree.split(',').map((t) => t.trim().toLowerCase()).filter((t) => t !== ''),
);
if (ONLY_TREES !== null) {
  if (ONLY_TREES.size === 0) {
    console.error(`ERROR: --tree was given no usable value (got '${opts.tree}').`);
    process.exit(2);
  }
  const unknown = [...ONLY_TREES].filter((t) => !PRESENT_TREES.includes(t));
  if (unknown.length) {
    console.error(`ERROR: --tree names no translated content tree: ${unknown.join(', ')}`);
    console.error('Nothing would be scanned, and the run would report a clean-looking zero.');
    console.error(`Available: ${PRESENT_TREES.join(', ') || '(none)'}`);
    process.exit(2);
  }
}

const SCANNABLE_LOCALES = readdirSync(I18N_DIR).filter((entry) =>
  PRESENT_TREES.some((tree) => hasTree(entry, tree)));

if (ONLY_LOCALE && !SCANNABLE_LOCALES.includes(ONLY_LOCALE)) {
  console.error(`ERROR: --locale '${ONLY_LOCALE}' is not a translated locale under i18n/.`);
  console.error('Nothing would be scanned, and the run would report a clean-looking zero.');
  console.error(`Available: ${SCANNABLE_LOCALES.join(', ') || '(none)'}`);
  process.exit(2);
}

/**
 * Every path this run may rewrite, and the pathspec the dirty check uses.
 * Safe to interpolate only because `ONLY_LOCALE` is now a validated direct child
 * name — as a bare `--locale` value, `..` made this `i18n/..`, silently widening
 * the dirty check to the whole repository.
 */
const WRITE_SCOPE = ONLY_LOCALE ? `i18n/${ONLY_LOCALE}` : 'i18n';

// Refuse to write into a dirty tree. `git checkout -- i18n/` is the only undo
// for this tool, and it discards uncommitted work along with the repair — so a
// stray run over unstaged edits is unrecoverable in exactly the case where
// recovery matters most. Checked before the ~90s history build so it fails fast.
function gitStatus(pathspec) {
  const status = spawnSync('git', ['status', '--porcelain', '--', pathspec], {
    cwd: ROOT, encoding: 'utf8',
  });
  // `status.error` is set and stdout/stderr are null when the spawn itself
  // fails (git missing, ENOENT). Reading `.stderr` alone printed "undefined"
  // as the reason a destructive run was refused.
  if (status.error) return { ok: false, reason: status.error.message };
  if (status.status !== 0) {
    return { ok: false, reason: (status.stderr || '').trim() || `git exited ${status.status}` };
  }
  return { ok: true, dirty: status.stdout.trim() };
}

if (WRITE) {
  const scope = gitStatus(WRITE_SCOPE);
  if (!scope.ok) {
    console.error(`ERROR: could not read git status for ${WRITE_SCOPE}/ — refusing to write.`);
    console.error(`  ${scope.reason.slice(0, 500)}`);
    process.exit(2);
  }
  if (scope.dirty) {
    const lines = scope.dirty.split('\n');
    const hasUntracked = lines.some((line) => line.startsWith('??'));
    console.error(`ERROR: ${WRITE_SCOPE}/ has uncommitted changes:`);
    for (const line of lines.slice(0, 10)) console.error(`  ${line}`);
    if (lines.length > 10) console.error(`  ... and ${lines.length - 10} more`);
    console.error('');
    console.error(`This tool rewrites files in place, and \`git checkout -- ${WRITE_SCOPE}\` is the`);
    console.error('only undo — it would discard the changes above too. Commit them first,');
    // `git stash` without -u leaves untracked files in the tree, so the stock
    // advice would hand back a tree this guard still refuses — or worse, one it
    // accepts while the untracked file remains overwritable with no copy in git.
    console.error(hasUntracked
      ? 'or stash them with `git stash -u` (plain `git stash` leaves the `??` entries behind).'
      : 'or stash them.');
    process.exit(2);
  }

  // English is read from the WORKING TREE when a translation's `source_commit`
  // does not resolve, and always under `--basis head`. That is legitimate — an
  // uncommitted English edit is a valid parity basis — but it means a dirty
  // `skills/` changes what gets spliced into the corpus, and the run would
  // report it as basis `head`. Warn rather than refuse: refusing would block
  // the ordinary edit-English-then-repair pass this tool is for.
  const english = gitStatus('skills');
  if (english.ok && english.dirty) {
    console.error(`NOTE: skills/ has ${english.dirty.split('\n').length} uncommitted change(s).`);
    console.error('      Fences restored from the working tree are labelled `worktree`, not a commit.');
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
for (const locale of SCANNABLE_LOCALES) {
  if (ONLY_LOCALE && locale !== ONLY_LOCALE) continue;
  for (const tree of PRESENT_TREES) {
    if (ONLY_TREES && !ONLY_TREES.has(tree)) continue;
    if (!hasTree(locale, tree)) continue;
    for (const entry of readdirSync(join(I18N_DIR, locale, tree))) {
      // `skills/<id>/SKILL.md` for skills, `<tree>/<id>.md` for the mirrors.
      // `contentKey` decides which names are content at all, so `_template.md`,
      // `README.md` and `_registry.yml` fall out here rather than needing a
      // second list that could drift from the checker's.
      const englishRel = tree === 'skills' ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
      const key = contentKey(englishRel);
      if (key === null) continue;
      const translated = join(I18N_DIR, locale, englishRel);
      const english = join(ROOT, englishRel);
      if (!existsSync(translated) || !existsSync(english)) continue;
      const text = readFileSync(translated, 'utf8');
      targets.push({
        locale, tree, key, path: translated, english, englishRel,
        relPath: `i18n/${locale}/${englishRel}`,
        text,
        sourceCommit: frontmatterField(text, 'source_commit'),
      });
    }
  }
}

// ---- resolve each target's English basis ----
const specs = BASIS === 'source-commit'
  ? [...new Set(targets.filter((t) => t.sourceCommit)
      .map((t) => `${t.sourceCommit}:${t.englishRel}`))]
  : [];
const blobs = readBlobs(specs);

let filesChanged = 0;
let fencesRestored = 0;
const skipped = [];
const changedByLocale = new Map();
// Every edit is planned first and applied afterwards, so preview and write walk
// identical code and the preview cannot describe a run the write does not make.
const plan = [];
/** tag -> divergent-fence count, for validating --tag against reality. */
const seenTags = new Map();

for (const t of targets) {
  let basisText = null;
  // `worktree`, not `head`: the fallback below reads `skills/<id>/SKILL.md` off
  // disk, which is HEAD's content only when that file is clean. Labelling it
  // `head` made the report claim a provenance the bytes did not have.
  let basisLabel = 'worktree';
  if (BASIS === 'source-commit' && t.sourceCommit) {
    basisText = blobs.get(`${t.sourceCommit}:${t.englishRel}`) ?? null;
    basisLabel = t.sourceCommit;
  }
  if (basisText === null) { basisText = readFileSync(t.english, 'utf8'); basisLabel = 'worktree'; }

  const translatedFences = extractFences(t.text);
  const basisFences = extractFences(basisText);
  // Keys are `<tree>/<id>`, produced by the same `contentKey` the history is
  // built with, so the two cannot disagree about what an id is. A bare `t.skill`
  // lookup returned undefined for every file, which the `everEnglish &&` guard
  // below silently turned into "nothing to repair" — a clean-looking zero.
  const everEnglish = history.get(t.key);
  if (!everEnglish) {
    skipped.push({ file: t.relPath, reason: 'no English history for this id', n: 0 });
    continue;
  }

  // Restore exactly what the gate flags: a gated fence whose body appears in no
  // English revision. Using the same predicate as the checker is what keeps the
  // two tools from disagreeing — an ordinal-only test would rewrite fences the
  // gate considers legitimately stale.
  const allDivergent = translatedFences.filter((f) => isGated(f) && !everEnglish.has(f.body));
  // Every divergent tag anywhere in the corpus, INCLUDING in files this run will
  // skip as unrepairable — the set `--tag` is validated against. Collecting only
  // from repairable files would reject a real tag as a typo.
  for (const f of allDivergent) seenTags.set(tagOf(f), (seenTags.get(tagOf(f)) || 0) + 1);
  const divergent = ONLY_TAGS === null ? allDivergent : allDivergent.filter((f) => ONLY_TAGS.has(tagOf(f)));
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

// Validate `--tag` against what the scan actually saw, not against a hand-kept
// list of language names. A tag matching nothing would otherwise report
// "files to change: 0" — the clean-looking zero `--locale` already exists to
// prevent, arriving by typo. Checked after the scan because the accept-list is
// the scan's own output; checked before any write, so a mistyped batch cannot
// touch the corpus.
if (ONLY_TAGS !== null) {
  const unknown = [...ONLY_TAGS].filter((t) => !seenTags.has(t));
  if (unknown.length) {
    console.error(`ERROR: --tag matched no divergent fence: ${unknown.join(', ')}`);
    console.error('Nothing would be restored, and the run would report a clean-looking zero.');
    const available = [...seenTags.entries()].sort((a, b) => b[1] - a[1]);
    console.error(`Divergent tags present: ${available.map(([t, n]) => `${t}=${n}`).join('  ')}`);
    process.exit(2);
  }
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
