#!/usr/bin/env node
/**
 * repo-guard.js — prove a multi-agent run left the repository untouched.
 *
 *   node scripts/repo-guard.js snapshot           # before the fan-out
 *   node scripts/repo-guard.js verify             # after it returns
 *   node scripts/repo-guard.js verify --release   # ... and drop the snapshot
 *
 * Exit 0 = the repository is exactly as it was. Exit 1 = it moved, with the
 * difference printed. Exit 2 = the question could not be answered honestly.
 *
 * ## Why this exists (#493)
 *
 * During an adversarial review of #486, a subagent wrote a test fixture into the
 * working repository and committed it. It sat on the branch HEAD for ten minutes
 * and would have gone out on the next push.
 *
 * The prompt had told it, specifically, to build fixtures under `/tmp`. It tried
 * to. Two parallel agents had each written `$SCRATCH/fixture.sh` — the same path
 * in the shared scratchpad — and the second clobbered the first, so the victim's
 * `bash fixture.sh /tmp/nf-skipwt` ran a script that ignored its argument. The
 * directory was never created, its `cd "$1"` failed, execution continued anyway,
 * and every following relative path resolved against the repository.
 *
 * The lesson is that the containment cannot be a sentence in a prompt, because
 * the agent complied with the sentence. It has to be a check that runs.
 *
 * ## Why `git status` is not that check
 *
 * `git status` cannot see an agent that COMMITTED — the tree reads clean
 * afterwards, and every dirty-tree check passes. In the real incident it was a
 * stale generated README that gave the write away, which is luck, not a control.
 *
 * So this compares five things, each corresponding to a way a change can hide:
 *
 *   HEAD            a stray commit (the tree looks clean afterwards)
 *   branch          a checkout that moved the working branch
 *   status lines    files appearing, vanishing, or changing state
 *   file contents   a stray write to a file that was ALREADY modified. Comparing
 *                   status lines alone misses this entirely: ` M CLAUDE.md` reads
 *                   identical before and after the overwrite. This repo is
 *                   normally mid-edit, so that is the common case, not the
 *                   exotic one.
 *   index flags     `git update-index --skip-worktree`, which the incident really
 *                   ran, and which makes git report a modified file as clean from
 *                   then on — poisoning every later check
 *
 * ## What it does NOT cover
 *
 * Ignored paths. `git status --porcelain` omits them by design and walking them
 * would mean hashing `node_modules`. A stray write to a gitignored file (in this
 * repo, `CONTINUE_HERE.md`) is invisible here. Everything else under the working
 * tree is compared by content.
 *
 * ## Failing closed
 *
 * A guard that answers "unchanged" when it could not look is worse than none.
 * Every uncertainty exits 2, never 0: a missing, unreadable, or foreign snapshot,
 * a git invocation that fails, or an unrecognised argument.
 *
 * Two rules keep a second run from laundering the first run's damage into a
 * green, which a single global snapshot slot otherwise invites:
 *
 *   - `snapshot` REFUSES to overwrite an existing snapshot (`--force` to
 *     override). Re-arming mid-run would rebaseline the damage as the new normal.
 *   - `verify` KEEPS the snapshot unless `--release`. Consuming it by default
 *     silently disarms every later check — and a stale snapshot can only ever
 *     over-report, never under-report, so keeping is the safe direction.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SNAPSHOT_NAME = 'repo-guard.json';
/**
 * Bump whenever `captureState()` changes shape. A snapshot written by an older
 * build cannot be compared against a newer capture — the first time that
 * happened the guard said `snapshot is missing 'contents'`, which is accurate
 * and useless. Refusing is right; naming the reason is what makes it actionable.
 */
const FORMAT_VERSION = 2;
const USAGE = `Usage:
  node scripts/repo-guard.js snapshot [--force] [--quiet]
  node scripts/repo-guard.js verify   [--release] [--quiet]

  snapshot   record HEAD, branch, status, file contents and index flags
  --force    replace an existing snapshot (refused by default)
  verify     compare the repository against that record
  --release  delete the snapshot afterwards (kept by default)
  --quiet    suppress the success line; differences always print`;

function die(message, code = 2) {
  console.error(`repo-guard: ${message}`);
  process.exit(code);
}

// ── arguments: default-deny, and per-command, so a flag that means nothing to
// this subcommand is an error rather than a silently narrower check.
const argv = process.argv.slice(2);
const FLAGS_FOR = { snapshot: ['--force', '--quiet'], verify: ['--release', '--quiet'] };

const command = argv.find((a) => !a.startsWith('-'));
if (!command) die(`no command given.\n${USAGE}`);
if (!FLAGS_FOR[command]) die(`unknown command '${command}'.\n${USAGE}`);
for (const arg of argv) {
  if (arg === command) continue;
  if (!FLAGS_FOR[command].includes(arg)) {
    die(`unknown argument '${arg}' for '${command}'.\n${USAGE}`);
  }
}
const QUIET = argv.includes('--quiet');

/**
 * Run git from the repository ROOT, never the caller's cwd.
 *
 * `git ls-files` is cwd-scoped: run from a subdirectory it lists only that
 * subtree, so a `skip-worktree` bit set elsewhere would be invisible and the
 * guard would silently cover less than it claims.
 */
function git(args, { cwd = undefined, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 512 * 1024 * 1024 });
  if (result.error) die(`could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return null;
    die(`git ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

const TOPLEVEL = git(['rev-parse', '--show-toplevel']).trim();
const GIT_DIR = git(['rev-parse', '--absolute-git-dir']).trim();
const SNAPSHOT_PATH = join(GIT_DIR, SNAPSHOT_NAME);
const atRoot = (args) => git(args, { cwd: TOPLEVEL });

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16);

/**
 * Hash of every path git reports as changed or untracked.
 *
 * This is what makes a stray write to an already-dirty file visible. `-uall`
 * lists untracked files individually rather than collapsing a directory to one
 * entry, so a new file inside an already-untracked directory is caught too.
 */
function captureState() {
  const statusRaw = atRoot(['status', '--porcelain', '-uall']);
  const status = statusRaw.split('\n').filter((line) => line.trim() !== '').sort();

  const contents = {};
  for (const line of status) {
    // Porcelain v1: 2 status chars, a space, then the path. Renames use
    // "old -> new"; the post-rename path is the one on disk.
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) {
      try { path = JSON.parse(path); } catch { /* keep the quoted form */ }
    }
    const abs = join(TOPLEVEL, path);
    try {
      // Deleted paths have no content; the status line already records them.
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      contents[path] = sha(readFileSync(abs));
    } catch (error) {
      // Unreadable is a state too — record it rather than silently skipping,
      // so a file becoming unreadable during a run still shows up.
      contents[path] = `unreadable:${error.code || 'error'}`;
    }
  }

  // `git ls-files -v` marks anything not plainly cached with a tag other than
  // 'H'. 'S' is skip-worktree; a lowercase tag is assume-unchanged. Both make
  // git report a modified file as clean, so they must be part of the baseline —
  // otherwise setting one is itself an undetectable change.
  const indexFlags = atRoot(['ls-files', '-v'])
    .split('\n')
    .filter((line) => line && line[0] !== 'H')
    .sort();

  // A repository with no commits yet has neither a resolvable HEAD nor an
  // abbrev-ref for it. That is a legitimate state to snapshot, not an error —
  // dying here would make the guard unusable on a fresh fixture.
  const head = git(['rev-parse', 'HEAD'], { cwd: TOPLEVEL, allowFailure: true });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: TOPLEVEL, allowFailure: true });

  return {
    toplevel: TOPLEVEL,
    head: head === null ? '(unborn)' : head.trim(),
    branch: branch === null ? '(unborn)' : branch.trim(),
    status,
    contents,
    indexFlags,
  };
}

function reportList(label, before, after) {
  const gone = before.filter((x) => !after.includes(x));
  const added = after.filter((x) => !before.includes(x));
  if (!gone.length && !added.length) return false;
  console.error(`\n  ${label}:`);
  for (const entry of added) console.error(`    + ${entry}`);
  for (const entry of gone) console.error(`    - ${entry}`);
  return true;
}

if (command === 'snapshot') {
  // Refusing to clobber is what stops a nested or concurrent run from
  // rebaselining the outer run's damage as the new normal.
  if (existsSync(SNAPSHOT_PATH) && !argv.includes('--force')) {
    die(`a snapshot already exists at ${SNAPSHOT_NAME}.\n` +
      'Another guarded run may be in progress — overwriting it would rebaseline its damage.\n' +
      'Finish that run with `repo-guard.js verify --release`, or pass --force.');
  }
  const state = captureState();
  writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify({ formatVersion: FORMAT_VERSION, ...state, takenAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  if (!QUIET) {
    console.log(`repo-guard: snapshot at ${state.head.slice(0, 8)} on ${state.branch}` +
      ` (${state.status.length} pending change(s), ${state.indexFlags.length} index flag(s))`);
  }
  process.exit(0);
}

// ── verify ───────────────────────────────────────────────────────────────────

if (!existsSync(SNAPSHOT_PATH)) {
  die(`no snapshot at ${SNAPSHOT_NAME}. Run \`repo-guard.js snapshot\` before the run.\n` +
    'Refusing to report "unchanged" for a comparison that never happened.');
}

let before;
try {
  before = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
} catch (error) {
  die(`snapshot at ${SNAPSHOT_NAME} is unreadable: ${error.message}`);
}
if (before.formatVersion !== FORMAT_VERSION) {
  die(`snapshot was written in format v${before.formatVersion ?? 1}, but this is v${FORMAT_VERSION}.\n` +
    'It predates a change to what is recorded, so the comparison would be incomplete.\n' +
    `Re-arm and re-run:  rm ${SNAPSHOT_PATH} && npm run guard:snapshot`);
}
for (const field of ['toplevel', 'head', 'branch', 'status', 'contents', 'indexFlags']) {
  if (before[field] === undefined) die(`snapshot is missing '${field}' — refusing to compare.`);
}
if (before.toplevel !== TOPLEVEL) {
  die(`snapshot was taken in ${before.toplevel}, but this is ${TOPLEVEL}.`);
}

const after = captureState();
let changed = false;
let headMoved = false;

if (before.head !== after.head) {
  changed = true;
  headMoved = true;
  console.error(`\n  HEAD moved: ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}`);
  // The commits themselves are the actionable part: this is the case `git
  // status` cannot see, because a committed stray write leaves a clean tree.
  const range = git(['log', '--format=  %h %an  %s', `${before.head}..${after.head}`],
    { cwd: TOPLEVEL, allowFailure: true });
  if (range && range.trim()) {
    console.error('  commits added:');
    console.error(range.trimEnd());
  }
}

if (before.branch !== after.branch) {
  changed = true;
  console.error(`\n  branch changed: ${before.branch} -> ${after.branch}`);
}

changed = reportList('working tree', before.status, after.status) || changed;

// Content comparison, restricted to paths present in both status lists — a path
// that appeared or vanished is already reported above, and repeating it adds
// noise without adding information.
const contentChanged = Object.keys(after.contents)
  .filter((path) => before.contents[path] !== undefined)
  .filter((path) => before.contents[path] !== after.contents[path])
  .sort();
if (contentChanged.length) {
  changed = true;
  console.error('\n  contents changed (file was already modified, so its status line did not move):');
  for (const path of contentChanged) console.error(`    ~ ${path}`);
}

changed = reportList('index flags (skip-worktree / assume-unchanged)',
  before.indexFlags, after.indexFlags) || changed;

if (argv.includes('--release')) {
  try {
    unlinkSync(SNAPSHOT_PATH);
  } catch (error) {
    // Do not let a cleanup failure masquerade as "the repository changed".
    console.error(`repo-guard: warning — could not remove the snapshot: ${error.message}`);
  }
}

if (changed) {
  console.error('\nrepo-guard: the repository CHANGED during the run.');
  if (headMoved) {
    console.error('Investigate before pushing. A stray commit is recoverable while unpushed:');
    console.error(`  git log --oneline ${before.head.slice(0, 8)}..HEAD`);
    console.error(`  git reset --mixed ${before.head.slice(0, 8)}   # keeps the files, drops the commit`);
  } else {
    // `git reset --mixed` would unstage the caller's own work here, so it must
    // not be suggested when HEAD never moved.
    console.error('HEAD did not move, so this is a worktree change — inspect it before assuming');
    console.error('it was yours:  git diff  /  git status --porcelain -uall');
  }
  process.exit(1);
}

if (!QUIET) {
  const age = before.takenAt ? ` (snapshot taken ${before.takenAt})` : '';
  console.log(`repo-guard: unchanged at ${after.head.slice(0, 8)} on ${after.branch}${age}.`);
}
process.exit(0);
