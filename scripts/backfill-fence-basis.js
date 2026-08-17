#!/usr/bin/env node
/**
 * backfill-fence-basis.js — write `fence_basis_commit` onto every translation that can prove it
 * (#552, the second half).
 *
 * ## What it writes, and why to so few files
 *
 * The field means: *the English revision this file's frozen fence bodies were verified against.*
 * A backfill that wrote it everywhere would write a false claim into every file that cannot
 * prove one — the disagreement-between-files failure the schema exists to end. So this verifies
 * before it writes, file by file, and leaves the field ABSENT wherever it cannot.
 *
 * The candidate value is the file's own `source_commit`, the only revision the file itself
 * names. A file earns the stamp when, against the blob at that commit:
 *
 *   1. English history exists for the id at all (not an orphan);
 *   2. `<source_commit>:<englishRel>` resolves to a real object;
 *   3. `mirrorsBasis` — same fence count, same folded tag sequence, every GATED body byte-equal
 *      at its ordinal. Shared with `normalize-i18n-fences.js`, which consults the same predicate
 *      before it may stamp, so the two writers cannot disagree about what "verified" means;
 *   4. every gated BODY is in the walked English pool;
 *   5. the folded SEQUENCE is in the walked pool too.
 *
 * (4) and (5) look redundant against (3) and are not. The pool comes from `git log --name-only`
 * over path-limited, history-simplified history that lists no paths for merges, while the basis
 * blob is resolved with `git cat-file --batch`, which answers for any object in the store. They
 * are also two separate holes: a conflict-resolved merge can assemble bodies that each exist in
 * a parent into an order no revision ever had. Stamping either would sign a claim the parity
 * gate contradicts on its next run.
 *
 * ## Add-only, and never a second value
 *
 * This tool never clears and never overwrites. Clearing is the normalizer's job, because only
 * the normalizer knows it just changed the bytes. A file already carrying the field is skipped
 * whatever its value — the scaffolders write it at birth, and silently rewriting their claim
 * would make this tool a second, invisible author of a fact it did not establish.
 *
 * ## Why the vacuous case IS stamped
 *
 * A file with no gated fences passes (3) trivially, and that is deliberate. The scaffolders
 * already stamp unconditionally, so withholding here would make two byte-identical zero-gated
 * files disagree on the field purely by age. Nor is the claim empty: fence count and folded tag
 * sequence are verified, so a later retag or fence deletion contradicts it and the gate's
 * `stale-basis-claim` says so.
 *
 * ## What it deliberately does NOT do
 *
 * It does not search history for a revision a file *does* mirror. Measured at introduction, 198
 * files are clean — every gated body pooled — yet fail to mirror the commit they name, which is
 * the `evolve-*` `source_commit` bump (#616) visible in the data. Deferred, not abandoned: when
 * #616 stops the bump and repairs the values, a re-run stamps them. The field accretes from
 * three writers, so nothing here is one-shot, and this tool is idempotent by construction.
 *
 * Usage:
 *   node scripts/backfill-fence-basis.js                        # PREVIEW, writes nothing
 *   node scripts/backfill-fence-basis.js --write
 *   node scripts/backfill-fence-basis.js --locale de
 *   node scripts/backfill-fence-basis.js --tree skills,guides
 *   node scripts/backfill-fence-basis.js --json
 *   node scripts/backfill-fence-basis.js --verify --base <sha> [--head <sha>]  # audit a diff
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import {
  extractFences, buildEnglishFenceHistory, isGated, foldedTagSequence,
  compareTagSequence, mirrorsBasis,
} from './lib/fences.js';
import { collectI18nTargets, validateScope } from './lib/i18n-targets.js';
import { assertNotShallow } from './lib/git-freshness.js';
import {
  SOURCE_COMMIT_FIELD, FENCE_BASIS_FIELD,
  readFrontmatterField, stampFrontmatterField,
} from './lib/provenance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GIT_BUFFER = 512 * 1024 * 1024;

// ---- flags ----------------------------------------------------------------
//
// Strict, and value-taking flags are excused BY POSITION rather than by shape. Excusing
// "anything not starting with --" would also swallow a typo like `wirte`, which is the
// silent-misparse class `generate-translation-status.js` records paying for.

const BOOL_FLAGS = new Set(['--write', '--json', '--verify']);
const VALUE_FLAGS = new Set(['--locale', '--tree', '--root', '--base', '--head']);

function parseArgs(argv) {
  const opts = {
    write: false, json: false, verify: false,
    locale: null, trees: null, root: null, base: null, head: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOL_FLAGS.has(arg)) {
      opts[arg.slice(2)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`ERROR: ${arg} requires a value`);
        process.exit(2);
      }
      if (arg === '--tree') opts.trees = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
      else opts[arg.slice(2)] = value;
      i++;
      continue;
    }
    console.error(`ERROR: unknown argument: ${arg}`);
    console.error(`Known flags: ${[...BOOL_FLAGS, ...VALUE_FLAGS].sort().join(', ')}`);
    process.exit(2);
  }
  if (opts.trees !== null && opts.trees.size === 0) {
    console.error('ERROR: --tree requires at least one tree name');
    process.exit(2);
  }
  if (opts.verify && !opts.base) {
    console.error('ERROR: --verify requires --base <ref> to reconstruct against');
    process.exit(2);
  }
  if (opts.verify && opts.write) {
    console.error('ERROR: --verify audits a landed diff; it cannot be combined with --write');
    process.exit(2);
  }
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const ROOT = resolve(OPTS.root ?? resolve(__dirname, '..'));
const PREVIEW = !OPTS.write;

function git(args, { input } = {}) {
  const r = spawnSync('git', args, {
    cwd: ROOT, encoding: input ? undefined : 'utf8', input, maxBuffer: GIT_BUFFER,
  });
  return r;
}

// ---- --verify: reconstruct the diff rather than read it -------------------
//
// The total check that replaces reading 3,415 files. For every path the commit range touched,
// take the file as it was at <base>, apply the SAME stamp this tool would apply, and require
// byte equality with the file at HEAD. One equality proves the whole diff shape at once: only
// the field was added, its value is that file's own `source_commit`, nothing else moved.
//
// Reads git BLOBS at two named refs, never the working tree, so a dirty checkout cannot make a
// bad diff look good.

if (OPTS.verify) {
  // `--head` defaults to HEAD but must be settable, because the commit being audited is rarely
  // the branch tip by the time anyone audits it. Hardcoding HEAD made the documented audit
  // command fail the moment a docs commit landed on top: the range then contains paths outside
  // `i18n/`, which this loop correctly rejects, and the failure reads as corpus corruption
  // rather than as the wrong range. An audit that only works for one commit-shaped moment is
  // the "verification nobody can run" this mode already had to be rescued from once.
  const HEAD_REF = OPTS.head ?? 'HEAD';
  const names = git(['diff', '--name-only', `${OPTS.base}..${HEAD_REF}`]);
  if (names.status !== 0) {
    console.error(`ERROR: git diff ${OPTS.base}..${HEAD_REF} failed:\n${names.stderr}`);
    process.exit(2);
  }
  const changed = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const problems = [];
  let checked = 0;

  // Two batched `cat-file` reads, not two `git show` per file. The naive form spawns 2N git
  // processes — at corpus scale that is ~6,800 spawns and the audit does not finish, which
  // makes it a verification nobody runs. `readBlobs` is a hoisted function declaration, so
  // calling it above its definition is deliberate rather than accidental.
  const beforeBlobs = readBlobs(changed.map((rel) => `${OPTS.base}:${rel}`));
  const afterBlobs = readBlobs(changed.map((rel) => `${HEAD_REF}:${rel}`));

  for (const rel of changed) {
    if (!rel.startsWith('i18n/')) { problems.push(`${rel}: outside i18n/`); continue; }
    const before = beforeBlobs.get(`${OPTS.base}:${rel}`);
    const after = afterBlobs.get(`${HEAD_REF}:${rel}`);
    if (before === undefined || after === undefined) { problems.push(`${rel}: added or deleted, not modified`); continue; }
    const sc = readFrontmatterField(before, SOURCE_COMMIT_FIELD);
    if (!sc) { problems.push(`${rel}: no source_commit at base, so no value was derivable`); continue; }
    const expected = stampFrontmatterField(before, FENCE_BASIS_FIELD, sc);
    if (expected === null) { problems.push(`${rel}: not stampable at base`); continue; }
    if (expected !== after) { problems.push(`${rel}: ${HEAD_REF} is not base+stamp — something else changed`); continue; }
    checked++;
  }

  console.log(`reconstructed ${checked} of ${changed.length} changed path(s) from ${OPTS.base}`);
  if (problems.length) {
    console.error(`\n${problems.length} path(s) are NOT base+stamp:`);
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    if (problems.length > 20) console.error(`  ... ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log('OK: every changed file is exactly its base content plus one fence_basis_commit line.');
  process.exit(0);
}

// ---- refuse to write into a dirty scope -----------------------------------
//
// Same rule the fence normalizer adopted after a read-only probe agent rewrote 281 files
// (#486): a mechanical corpus edit must not mix with hand edits, because the resulting diff
// cannot be reviewed as either one.

const WRITE_SCOPE = OPTS.locale ? `i18n/${OPTS.locale}` : 'i18n';

if (OPTS.write) {
  const st = git(['status', '--porcelain', '--', WRITE_SCOPE]);
  if (st.status !== 0) {
    console.error('ERROR: git status failed; refusing to write blind.');
    process.exit(2);
  }
  const dirty = st.stdout.split('\n').filter((l) => l.trim() !== '');
  if (dirty.length) {
    console.error(`ERROR: ${WRITE_SCOPE}/ has ${dirty.length} uncommitted change(s). Refusing to write.`);
    console.error('A mechanical backfill mixed with hand edits produces a diff nobody can review.');
    for (const line of dirty.slice(0, 10)) console.error(`  ${line}`);
    if (dirty.length > 10) console.error(`  ... ${dirty.length - 10} more`);
    process.exit(2);
  }
}

// A shallow clone silently truncates the pool, which would reclassify files (#279/#362).
assertNotShallow(ROOT);

// ---- gather ---------------------------------------------------------------

const { targets, localesReached, treesReached } = collectI18nTargets({
  root: ROOT, onlyLocale: OPTS.locale, onlyTrees: OPTS.trees, withText: true,
});

const scopeErrors = validateScope({
  onlyLocale: OPTS.locale, onlyTrees: OPTS.trees, localesReached, treesReached,
});
if (scopeErrors.length) {
  for (const line of scopeErrors) console.error(line);
  process.exit(2);
}

for (const t of targets) t.sourceCommit = readFrontmatterField(t.text, SOURCE_COMMIT_FIELD);

// ---- resolve each target's claimed basis in one git process ---------------

const specs = [...new Set(
  targets.filter((t) => t.sourceCommit).map((t) => `${t.sourceCommit}:${t.englishRel}`),
)];

function readBlobs(list) {
  const out = new Map();
  if (!list.length) return out;
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT, input: Buffer.from(`${list.join('\n')}\n`, 'utf8'), maxBuffer: GIT_BUFFER,
  });
  if (batch.error) {
    throw new Error(`git cat-file --batch did not complete (${batch.error.code ?? batch.error.message}). `
      + `If this is ENOBUFS, GIT_BUFFER (${GIT_BUFFER}) is too small for this corpus.`);
  }
  if (batch.status !== 0) {
    throw new Error(`git cat-file --batch failed: ${batch.stderr?.toString().slice(0, 500)}`);
  }
  const buf = batch.stdout;
  let offset = 0;
  let index = 0;
  while (offset < buf.length && index < list.length) {
    const newline = buf.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = buf.slice(offset, newline).toString('utf8');
    offset = newline + 1;
    // A missing or ambiguous object emits a header and NO body. Failing to advance the index
    // past it shifts every later blob onto the wrong spec — a silent, total corruption of the
    // basis set, and the exact line whose deletion the fences copy of this loop could not detect.
    if (/ (missing|ambiguous)$/.test(header)) { index += 1; continue; }
    const size = Number.parseInt(header.split(' ')[2], 10);
    if (!Number.isFinite(size)) break;
    out.set(list[index], buf.toString('utf8', offset, offset + size));
    offset += size + 1;
    index += 1;
  }
  return out;
}

const blobs = readBlobs(specs);
const history = buildEnglishFenceHistory(ROOT);

// ---- decide ---------------------------------------------------------------

const R = {
  ORPHAN: 'no English history for this id',
  NO_SOURCE_COMMIT: 'no source_commit to verify against',
  UNRESOLVABLE: 'source_commit resolves to no blob for this path',
  // `mirrorsBasis` is one predicate deliberately, but three DIFFERENT stories about a file, and
  // absence is meaningful in this schema — so the report decomposes what the decision bundles.
  // A reader asking "why does this file have no claim?" gets an answer specific enough to act
  // on: a count mismatch is usually a fence English gained or lost since, a sequence mismatch is
  // usually a retag, and a body mismatch is usually a translated code block.
  NOT_MIRROR_COUNT: 'fence count differs from its source_commit',
  NOT_MIRROR_SEQ: 'fence tag sequence differs from its source_commit',
  NOT_MIRROR_BODY: 'a gated fence body differs from its source_commit',
  BODY_OFF_POOL: 'mirrors its source_commit, but a gated body is in no walked revision',
  SEQ_OFF_POOL: 'mirrors its source_commit, but its fence sequence is in no walked revision',
  NO_ANCHOR: 'no source_commit line to anchor the field beside',
  PRESENT: 'already carries the field (never overwritten by this tool)',
};

const plan = [];
const withheld = new Map();
const examples = new Map();
const record = (reason, relPath) => {
  withheld.set(reason, (withheld.get(reason) || 0) + 1);
  if (!examples.has(reason)) examples.set(reason, []);
  examples.get(reason).push(relPath);
};

for (const t of targets) {
  const pool = history.get(t.key);
  if (!pool) { record(R.ORPHAN, t.relPath); continue; }
  if (readFrontmatterField(t.text, FENCE_BASIS_FIELD) !== null) { record(R.PRESENT, t.relPath); continue; }
  if (!t.sourceCommit) { record(R.NO_SOURCE_COMMIT, t.relPath); continue; }

  const basisText = blobs.get(`${t.sourceCommit}:${t.englishRel}`);
  if (basisText === undefined) { record(R.UNRESOLVABLE, t.relPath); continue; }

  const mine = extractFences(t.text);
  const basis = extractFences(basisText);
  if (!mirrorsBasis(mine, basis)) {
    // Re-derive WHICH conjunct failed, for the report only. The decision above is
    // `mirrorsBasis` and nothing else, so this cannot disagree with it — it can only be less
    // specific, never differently specific.
    if (mine.length !== basis.length) record(R.NOT_MIRROR_COUNT, t.relPath);
    else if (foldedTagSequence(mine).join(',') !== foldedTagSequence(basis).join(',')) record(R.NOT_MIRROR_SEQ, t.relPath);
    else record(R.NOT_MIRROR_BODY, t.relPath);
    continue;
  }
  if (!mine.filter(isGated).every((f) => pool.has(f.body))) { record(R.BODY_OFF_POOL, t.relPath); continue; }
  if (compareTagSequence(foldedTagSequence(mine), history.sequences.get(t.key)) !== null) {
    record(R.SEQ_OFF_POOL, t.relPath); continue;
  }

  const stamped = stampFrontmatterField(t.text, FENCE_BASIS_FIELD, t.sourceCommit);
  if (stamped === null) { record(R.NO_ANCHOR, t.relPath); continue; }

  plan.push({ path: t.absPath, relPath: t.relPath, locale: t.locale, value: t.sourceCommit, text: stamped });
}

// ---- containment assertion ------------------------------------------------
//
// Every file the parity gate flags must land outside the plan. This follows from the predicate
// — a gated finding means a body or a sequence in no revision, which fails (4) or (5) — but it
// is ASSERTED rather than argued, because its violation is the one outcome that matters: the
// tool stamping a file the gate already knows is broken. `stale-basis-claim` is emitted
// ungated, and CI runs the gate with `--warn`, so such a file would merge green twice over.

const planned = new Set(plan.map((p) => p.relPath));
const flagged = targets.filter((t) => {
  const pool = history.get(t.key);
  if (!pool) return false;
  const fences = extractFences(t.text);
  const bodyBad = fences.some((f) => isGated(f) && !pool.has(f.body));
  const seqBad = compareTagSequence(foldedTagSequence(fences), history.sequences.get(t.key)) !== null;
  return bodyBad || seqBad;
}).map((t) => t.relPath);

const leaked = flagged.filter((f) => planned.has(f));
if (leaked.length) {
  console.error(`ERROR: ${leaked.length} file(s) the gate flags would be stamped. The predicate is wrong.`);
  for (const f of leaked.slice(0, 10)) console.error(`  ${f}`);
  process.exit(2);
}

// ---- report ---------------------------------------------------------------

const byLocale = new Map();
for (const p of plan) byLocale.set(p.locale, (byLocale.get(p.locale) || 0) + 1);

if (OPTS.json) {
  console.log(JSON.stringify({
    preview: PREVIEW,
    scanned: targets.length,
    stamp: plan.length,
    withheld: Object.fromEntries(withheld),
    flaggedByGate: flagged.length,
    leaked: leaked.length,
    byLocale: Object.fromEntries([...byLocale.entries()].sort()),
  }, null, 2));
} else {
  for (const [reason, files] of examples) {
    console.log(`\nWITHHELD ${String(withheld.get(reason)).padStart(4)} — ${reason}`);
    for (const f of files.slice(0, 4)) console.log(`     ${f}`);
    if (files.length > 4) console.log(`     ... ${files.length - 4} more`);
  }
  console.log(`\nscanned:         ${targets.length}`);
  console.log(`${PREVIEW ? 'would stamp:    ' : 'stamped:        '} ${plan.length}`);
  console.log(`withheld:        ${targets.length - plan.length}`);
  console.log(`flagged by gate: ${flagged.length}  (0 leaked into the plan — asserted)`);
  if (byLocale.size) {
    console.log(`by locale:       ${[...byLocale.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
}

if (!PREVIEW && plan.length) {
  // stderr, deliberately: a run that rewrites thousands of corpus files must leave a mark in the
  // transcript that `> log.txt` cannot swallow.
  console.error(`WRITING ${plan.length} file(s) under ${WRITE_SCOPE}/ ...`);
  for (const p of plan) writeFileSync(p.path, p.text, 'utf8');
}

console.log(`\n${PREVIEW ? 'PREVIEW — nothing written (pass --write to apply)' : 'Wrote changes'}`);
