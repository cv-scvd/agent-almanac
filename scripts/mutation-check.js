#!/usr/bin/env node
/**
 * mutation-check.js — prove that a check is capable of failing.
 *
 * A gate that reports healthy is evidence about the *gate*, not the subject. The
 * only way to know a test covers a line is to remove that line and watch the test
 * go red. This automates that envelope safely:
 *
 *   1. refuse to run if the target file has uncommitted changes (restore is
 *      `git checkout --`, which would destroy them)
 *   2. run the test command first and require GREEN — a mutation tells you nothing
 *      about an already-red suite
 *   3. apply the mutation
 *   4. VERIFY THE MUTATION LANDED via `git diff`. This is the step that matters:
 *      a substitution that silently matched nothing makes the whole exercise pass
 *      vacuously while looking correct
 *   5. re-run the tests and record the real exit code
 *   6. restore, and verify the restore actually happened
 *
 * The mutant is "killed" if the suite goes red. A SURVIVING mutant means the line
 * is not covered, however convincingly the behaviour was demonstrated by hand.
 *
 *   node scripts/mutation-check.js \
 *     --file cli/index.js \
 *     --delete-matching 'process.exitCode = auditExitCode' \
 *     --test 'npm run test:cli'
 *
 *   node scripts/mutation-check.js \
 *     --file cli/lib/installer.js \
 *     --replace 'crashed: true'::'crashed: false' \
 *     --test 'npm run test:cli'
 *
 * Exit 0 = mutant killed (the check works). Exit 1 = mutant survived (gap found),
 * or the run could not be completed safely.
 *
 * Written in Node rather than shell deliberately: in-place `sed` silently no-ops on
 * this repo's NTFS mount, and bare `grep` resolves to ugrep locally but GNU grep in
 * CI — the two failure modes this tool exists to catch.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const USAGE = `Usage:
  node scripts/mutation-check.js --file <path> --test <cmd> (--delete-matching <str> | --replace <old>::<new>)

Options:
  --file <path>             File to mutate (must be tracked and unmodified)
  --test <cmd>              Command whose red/green tells you if the mutant died
  --delete-matching <str>   Delete every line containing this literal substring
  --replace <old>::<new>    Replace literal <old> with <new> (first occurrence)
  --expect-killed-by <n>    Require exactly n failing tests (parsed from node:test output)
  --skip-baseline           Skip the pre-flight green run (faster, less safe)
  -h, --help                Show this message`;

// ── args ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--skip-baseline') opts.skipBaseline = true;
    else if (arg === '--file') opts.file = argv[++i];
    else if (arg === '--test') opts.test = argv[++i];
    else if (arg === '--delete-matching') opts.deleteMatching = argv[++i];
    else if (arg === '--replace') opts.replace = argv[++i];
    else if (arg === '--expect-killed-by') opts.expectKilledBy = Number(argv[++i]);
    else fail(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

/** Run a shell command, returning its REAL exit code. Never piped — a pipe would
 *  report the last stage's status and silently invert the result. */
function runTest(cmd) {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Pull `# fail N` out of node:test output; null if the format is not recognised. */
function parseFailCount(output) {
  const match = output.match(/^\s*[^\s]*\s*fail\s+(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

// ── mutation ─────────────────────────────────────────────────────

function mutate(original, opts) {
  if (opts.deleteMatching !== undefined) {
    const kept = original.split('\n').filter((line) => !line.includes(opts.deleteMatching));
    return kept.join('\n');
  }
  const sep = opts.replace.indexOf('::');
  if (sep === -1) fail('--replace needs the form <old>::<new>');
  const from = opts.replace.slice(0, sep);
  const to = opts.replace.slice(sep + 2);
  if (!original.includes(from)) return original; // step 4 will catch it
  return original.replace(from, to);
}

// ── main ─────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opts.file || !opts.test) fail(`--file and --test are both required\n\n${USAGE}`);
if (opts.deleteMatching === undefined && opts.replace === undefined) {
  fail(`One of --delete-matching or --replace is required\n\n${USAGE}`);
}
if (opts.deleteMatching !== undefined && opts.replace !== undefined) {
  fail('--delete-matching and --replace are mutually exclusive');
}

const repoRoot = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!repoRoot) fail('Not inside a git repository.');

const absFile = resolve(process.cwd(), opts.file);
const relFile = relative(repoRoot, absFile);

// 1. Precondition. Restore is `git checkout --`, which discards working-tree
//    changes, so refuse outright rather than risk destroying uncommitted work.
const tracked = git(['ls-files', '--error-unmatch', '--', relFile], { cwd: repoRoot });
if (tracked.status !== 0) fail(`${relFile} is not tracked by git — cannot restore it safely.`);

const dirty = git(['status', '--porcelain', '--', relFile], { cwd: repoRoot }).stdout.trim();
if (dirty) {
  fail(
    `${relFile} has uncommitted changes:\n  ${dirty}\n` +
    'Commit or stash them first — this tool restores with `git checkout --`, which would discard them.'
  );
}

console.log(`\nmutation-check: ${relFile}`);
console.log(`  mutation: ${opts.deleteMatching !== undefined
  ? `delete lines containing "${opts.deleteMatching}"`
  : `replace "${opts.replace.split('::')[0]}"`}`);
console.log(`  test:     ${opts.test}\n`);

// 2. Baseline. A mutation on an already-red suite proves nothing.
if (!opts.skipBaseline) {
  console.log('[1/4] baseline (expect green) ...');
  const base = runTest(opts.test);
  if (base.status !== 0) {
    fail(
      `Baseline is already failing (exit ${base.status}). Fix that first — a surviving\n` +
      'or killed mutant is meaningless when the suite is red to begin with.'
    );
  }
  console.log('      green.\n');
} else {
  console.log('[1/4] baseline skipped (--skip-baseline)\n');
}

const original = readFileSync(absFile, 'utf8');
let restored = false;

function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(absFile, original);
  const res = git(['checkout', '--', relFile], { cwd: repoRoot });
  const stillDirty = git(['status', '--porcelain', '--', relFile], { cwd: repoRoot }).stdout.trim();
  if (res.status !== 0 || stillDirty) {
    console.error(`\nERROR: ${relFile} may not be restored. Check it manually:\n  git status -- ${relFile}`);
  }
}

// Restore even if interrupted — a half-mutated tree is worse than no result.
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

let killed = false;
let failCount = null;

try {
  // 3. Apply.
  console.log('[2/4] applying mutation ...');
  writeFileSync(absFile, mutate(original, opts));

  // 4. THE step that makes this trustworthy. A mutation that matched nothing
  //    leaves the file untouched, and every later result would be a lie.
  const landed = git(['diff', '--quiet', '--', relFile], { cwd: repoRoot }).status !== 0;
  if (!landed) {
    restore();
    fail(
      'The mutation did not change the file — nothing matched.\n' +
      'This is the silent no-op that makes a negative test pass vacuously.\n' +
      'Check the literal string; it is matched exactly, not as a regex.'
    );
  }
  const stat = git(['diff', '--stat', '--', relFile], { cwd: repoRoot }).stdout.trim();
  console.log(`      landed: ${stat}\n`);

  // 5. Re-run.
  console.log('[3/4] running tests against the mutant (expect red) ...');
  const mutant = runTest(opts.test);
  killed = mutant.status !== 0;
  failCount = parseFailCount(mutant.stdout + mutant.stderr);
  console.log(`      exit ${mutant.status}${failCount !== null ? `, ${failCount} failing` : ''}\n`);
} finally {
  // 6. Restore, and verify.
  console.log('[4/4] restoring ...');
  restore();
  console.log('      restored.\n');
}

// ── verdict ──────────────────────────────────────────────────────

if (!killed) {
  console.error('MUTANT SURVIVED — this line is not covered.');
  console.error(`  Removing it from ${relFile} did not fail "${opts.test}".`);
  console.error('  Whatever you verified by hand, no test would catch this regressing.');
  process.exit(1);
}

if (opts.expectKilledBy !== undefined && failCount !== null && failCount !== opts.expectKilledBy) {
  console.error(`MUTANT KILLED, but by ${failCount} tests, not the expected ${opts.expectKilledBy}.`);
  console.error('  More than expected can mean collateral coupling; fewer can mean thinner');
  console.error('  coverage than you think. Both are worth understanding before trusting it.');
  process.exit(1);
}

console.log(`MUTANT KILLED${failCount !== null ? ` by ${failCount} failing test(s)` : ''} — the check can fail.`);
console.log('Quote this in the commit message: same mutation, gate red; restored, gate green.');
