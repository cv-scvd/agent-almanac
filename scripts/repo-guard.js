#!/usr/bin/env node
/**
 * repo-guard.js — prove a multi-agent run left the repository untouched.
 *
 *   node scripts/repo-guard.js snapshot   # before the fan-out
 *   node scripts/repo-guard.js verify     # after it returns
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
 * So this compares four things, each corresponding to a way the incident hid:
 *
 *   HEAD          a stray commit (the tree looks clean afterwards)
 *   branch        a checkout that moved the working branch
 *   status        stray writes and stray new files
 *   index flags   `git update-index --skip-worktree`, which the incident really
 *                 did run, and which makes git report a modified file as clean
 *                 from that point on — poisoning every later check
 *
 * ## Failing closed
 *
 * A guard that answers "unchanged" when it could not look is worse than none.
 * Every uncertainty here exits 2, never 0: a missing or unreadable snapshot, a
 * snapshot taken in a different repository, a git invocation that fails, or an
 * unrecognised argument.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The snapshot lives inside the git directory, not the working tree.
 *
 * The first version put it at the repo root, and a test caught two consequences:
 * it appeared in `git status` as an untracked file (so the guard had to special-
 * case its own artifact), and an agent running `git add -A` — precisely the
 * command from the incident — would have committed it. `.git/` is not part of
 * the working tree, so none of that can happen.
 */
const SNAPSHOT_NAME = 'repo-guard.json';
const USAGE = `Usage:
  node scripts/repo-guard.js snapshot [--quiet]
  node scripts/repo-guard.js verify   [--keep] [--quiet]

  snapshot  record HEAD, branch, worktree status and index flags
  verify    compare the repository against that record (and delete it)
  --keep    verify without deleting the snapshot (for repeated checks)
  --quiet   suppress the success line; differences always print`;

function die(message, code = 2) {
  console.error(`repo-guard: ${message}`);
  process.exit(code);
}

// ── argument parsing: default-deny, because a silently ignored flag is how a
// guard ends up not guarding what the caller believed it did.
const argv = process.argv.slice(2);
const COMMANDS = new Set(['snapshot', 'verify']);
const FLAGS = new Set(['--keep', '--quiet']);

const command = argv.find((a) => !a.startsWith('-'));
if (!command) die(`no command given.\n${USAGE}`);
if (!COMMANDS.has(command)) die(`unknown command '${command}'.\n${USAGE}`);
for (const arg of argv) {
  if (arg === command) continue;
  if (!FLAGS.has(arg)) die(`unknown argument '${arg}'.\n${USAGE}`);
}
const KEEP = argv.includes('--keep');
const QUIET = argv.includes('--quiet');

/** Run git, or exit 2. A guard must never treat a failed probe as "nothing changed". */
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) die(`could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    die(`git ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

const TOPLEVEL = git(['rev-parse', '--show-toplevel']).trim();
// `--absolute-git-dir` resolves correctly in a linked worktree, where `.git` is
// a file pointing elsewhere rather than a directory.
const SNAPSHOT_PATH = join(git(['rev-parse', '--absolute-git-dir']).trim(), SNAPSHOT_NAME);

/** The repository's observable state. */
function captureState() {
  const status = git(['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .sort();

  // `git ls-files -v` marks anything not plainly cached with a tag other than
  // 'H'. 'S' is skip-worktree; a lowercase tag is assume-unchanged. Both make
  // git report a modified file as clean, so they must be part of the baseline —
  // otherwise setting one is itself an undetectable change.
  const indexFlags = git(['ls-files', '-v'])
    .split('\n')
    .filter((line) => line && line[0] !== 'H')
    .sort();

  return {
    toplevel: TOPLEVEL,
    head: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    status,
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
  const state = captureState();
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
for (const field of ['toplevel', 'head', 'branch', 'status', 'indexFlags']) {
  if (before[field] === undefined) die(`snapshot is missing '${field}' — refusing to compare.`);
}
if (before.toplevel !== TOPLEVEL) {
  die(`snapshot was taken in ${before.toplevel}, but this is ${TOPLEVEL}.`);
}

const after = captureState();
let changed = false;

if (before.head !== after.head) {
  changed = true;
  console.error(`\n  HEAD moved: ${before.head.slice(0, 8)} -> ${after.head.slice(0, 8)}`);
  // The commits themselves are the actionable part: this is the case `git
  // status` cannot see, because a committed stray write leaves a clean tree.
  const range = spawnSync('git', ['log', '--format=  %h %an  %s', `${before.head}..${after.head}`],
    { encoding: 'utf8' });
  if (range.status === 0 && range.stdout.trim()) {
    console.error('  commits added:');
    console.error(range.stdout.trimEnd());
  }
}

if (before.branch !== after.branch) {
  changed = true;
  console.error(`\n  branch changed: ${before.branch} -> ${after.branch}`);
}

changed = reportList('working tree', before.status, after.status) || changed;
changed = reportList('index flags (skip-worktree / assume-unchanged)',
  before.indexFlags, after.indexFlags) || changed;

if (!KEEP) unlinkSync(SNAPSHOT_PATH);

if (changed) {
  console.error(`\nrepo-guard: the repository CHANGED during the run.`);
  console.error('Investigate before pushing. A stray commit is recoverable while unpushed:');
  console.error(`  git log --oneline ${before.head.slice(0, 8)}..HEAD`);
  console.error(`  git reset --mixed ${before.head.slice(0, 8)}   # keeps the files, drops the commit`);
  process.exit(1);
}

if (!QUIET) console.log(`repo-guard: unchanged at ${after.head.slice(0, 8)} on ${after.branch}.`);
process.exit(0);
