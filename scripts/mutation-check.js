#!/usr/bin/env node
/**
 * mutation-check.js — prove that a check is capable of failing.
 *
 * A green gate is evidence about the *gate*, not the subject. The only way to know
 * a test covers a line is to remove that line and watch the test go red. This runs
 * that experiment and refuses to guess when it cannot answer honestly.
 *
 *   node scripts/mutation-check.js \
 *     --file cli/index.js \
 *     --delete-matching 'process.exitCode = auditExitCode' \
 *     --test 'npm run test:cli'
 *
 * Exit 0 = mutant killed (the check works).
 * Exit 1 = mutant survived (the line is uncovered), or the run was inconclusive.
 *
 * ── Why it is this defensive ─────────────────────────────────────
 *
 * The first version of this file was reviewed adversarially and had four blocking
 * defects, two of which destroyed uncommitted work. Every guard below exists
 * because its absence was reproduced:
 *
 *   - It restored with `git checkout --`, which resurrects from the INDEX, not
 *     HEAD, and silently overwrote a `--assume-unchanged` file's uncommitted
 *     content. Restore is now purely from the in-memory buffer; git is never asked
 *     to write to the worktree.
 *   - `writeFileSync` followed a symlinked --file and wrote through it to a target
 *     git has no copy of. Symlinks are now refused.
 *   - A mutation that merely broke JS parsing was reported as a kill, which is the
 *     exact false-confidence this tool exists to prevent. Mutants are now syntax
 *     checked, and a mutant that does not parse is INVALID, not killed.
 *   - spawnSync's 1 MiB default maxBuffer SIGTERMs the child and returns
 *     `status: null`; `?? 1` turned a genuinely GREEN run into "killed". Spawn
 *     errors and signals are now inspected and reported as inconclusive.
 *
 * Written in Node rather than shell deliberately: in-place `sed`/`perl -0pi`
 * silently no-op on this repo's NTFS mount, and bare `grep` resolves to ugrep
 * locally but GNU grep in CI — the two failure modes this tool exists to catch.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, relative, resolve } from 'node:path';
import { parseFailCount, parsePassCount, crashSuspicion } from './lib/mutation-verdict.js';

const USAGE = `Usage:
  node scripts/mutation-check.js --file <path> --test <cmd> (--delete-matching <str> | --replace <old>::<new>)

Options:
  --file <path>             File to mutate. Must be tracked, unmodified, and a
                            regular file (symlinks are refused).
  --test <cmd>              Command whose red/green decides whether the mutant died
  --delete-matching <str>   Delete lines containing this literal substring
  --replace <old>::<new>    Replace literal <old> with <new>
  --allow-broad             Accept a kill that fails a large share of the suite. Use when
                            the mutated line genuinely is load-bearing for most of it; the
                            crash-signature check still applies and is not waived.
  --allow-multiple          Permit a mutation affecting more than one site. Off by
                            default: a collateral site can produce a kill that gets
                            credited to the line you meant to test.
  --expect-killed-by <n>    Require exactly n failing tests. Errors if the count
                            cannot be parsed, rather than passing silently.
  -h, --help                Show this message`;

const BACKUP_SUFFIX = '.mutation-check.bak';

// ── helpers ──────────────────────────────────────────────────────

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

/**
 * Cap on captured output.
 *
 * spawnSync's maxBuffer used to enforce this by SIGTERM-ing the child and returning
 * status null — which a `?? 1` coercion turned into a fake kill. Streaming spawn has
 * no cap at all, so the bound is applied here and reported as an error rather than
 * silently becoming a verdict.
 */
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;

/**
 * Run a shell command and report what actually happened.
 *
 * Async, not spawnSync: a synchronous child blocks the event loop, so the SIGINT
 * handler below could not fire for the whole test run — Ctrl-C appeared to do
 * nothing and users escalated to SIGKILL, which strands the mutant (#462).
 *
 * The return shape is deliberate. `status` alone is not a verdict: a spawn failure
 * and a self-inflicted overflow kill both produce a non-zero-ish result that has
 * nothing to do with whether tests passed. `error` and `signal` stay separate so
 * inconclusiveReason() can tell "the suite went red" from "I killed the suite
 * myself".
 */
async function runCommand(cmd) {
  return new Promise((settle) => {
    const child = spawn(cmd, { shell: true });
    let output = '';
    let overflowed = false;
    let spawnError = null;

    const capture = (chunk) => {
      if (overflowed) return;
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        overflowed = true;
        child.kill('SIGKILL');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (err) => { spawnError = err; });

    child.on('close', (status, signal) => {
      settle({
        status,
        signal,
        // An overflow is reported as an error rather than as a verdict: the run
        // was cut short by this tool, so its exit status describes the kill, not
        // the tests.
        error: spawnError ?? (overflowed
          ? Object.assign(
            new Error(`output exceeded ${MAX_OUTPUT_CHARS} characters and was cut short`),
            { code: 'ENOBUFS' },
          )
          : null),
        output,
      });
    });
  });
}

/** Describe why a run could not be interpreted, or null if it can be. */
function inconclusiveReason(run) {
  if (run.error) return `the test command did not complete (${run.error.code ?? run.error.message})`;
  if (run.signal) return `the test command was killed by ${run.signal}, so its result is not a verdict`;
  if (run.status === null) return 'the test command produced no exit status';
  if (run.status === 127) return 'the test command was not found (exit 127) — check the --test string';
  return null;
}

/** The `type` of the nearest package.json above `dir`, defaulting to commonjs. */
function packageType(dir, stopAt) {
  let cur = dir;
  for (;;) {
    const manifest = resolve(cur, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8')).type ?? 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    if (cur === stopAt || dirname(cur) === cur) return 'commonjs';
    cur = dirname(cur);
  }
}

/**
 * JS mutants must still parse — otherwise a "kill" only means the file is broken.
 *
 * `node --check <file>.js` parses as CommonJS, so an ESM file mangled into invalid
 * syntax can still exit 0. Verified: a file containing a stray `}` checks clean as
 * `.js` and fails as `.mjs`. Since the extension drives the parser, the content is
 * probed through a temp file whose extension matches the package's actual module
 * type — otherwise this guard is dead for every `.js` file in an ESM package, which
 * is exactly the shape of defect it exists to catch.
 */
function parses(filePath, content, repoRootDir) {
  const ext = extname(filePath);
  if (!['.js', '.mjs', '.cjs'].includes(ext)) return true;
  const probeExt = ext !== '.js'
    ? ext
    : (packageType(dirname(filePath), repoRootDir) === 'module' ? '.mjs' : '.cjs');
  const probe = resolve(tmpdir(), `mutation-check-probe-${process.pid}${probeExt}`);
  try {
    writeFileSync(probe, content);
    return spawnSync(process.execPath, ['--check', probe]).status === 0;
  } finally {
    try { unlinkSync(probe); } catch { /* best effort */ }
  }
}

// ── args ─────────────────────────────────────────────────────────

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '-h' || arg === '--help') opts.help = true;
  else if (arg === '--allow-multiple') opts.allowMultiple = true;
  else if (arg === '--allow-broad') opts.allowBroad = true;
  else if (arg === '--file') opts.file = argv[++i];
  else if (arg === '--test') opts.test = argv[++i];
  else if (arg === '--delete-matching') opts.deleteMatching = argv[++i];
  else if (arg === '--replace') opts.replace = argv[++i];
  else if (arg === '--expect-killed-by') opts.expectKilledBy = Number(argv[++i]);
  else fail(`Unknown argument: ${arg}\n\n${USAGE}`);
}

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
// An empty needle matches every line and blanks the file, which reliably "kills"
// the mutant while proving nothing.
if (opts.deleteMatching === '') fail('--delete-matching needs a non-empty string');
if (opts.replace !== undefined && !opts.replace.includes('::')) {
  fail('--replace needs the form <old>::<new>');
}
if (opts.expectKilledBy !== undefined && !Number.isInteger(opts.expectKilledBy)) {
  fail('--expect-killed-by needs an integer');
}

// ── preconditions ────────────────────────────────────────────────

const repoRoot = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!repoRoot) fail('Not inside a git repository.');

const absFile = resolve(process.cwd(), opts.file);
const relFile = relative(repoRoot, absFile);
const backupPath = absFile + BACKUP_SUFFIX;

if (!existsSync(absFile)) fail(`${relFile} does not exist.`);

// Symlinks: readFileSync/writeFileSync follow them, so the tool would mutate a
// target git has no copy of, and no git-based safety net could see it.
if (lstatSync(absFile).isSymbolicLink()) {
  fail(`${relFile} is a symlink. Pass the real file — writes would follow the link to a target git does not track.`);
}
if (!lstatSync(absFile).isFile()) fail(`${relFile} is not a regular file.`);

if (existsSync(backupPath)) {
  fail(
    `A backup from a previous run is still present:\n  ${relative(repoRoot, backupPath)}\n` +
    'That run did not finish cleanly, so the file may still hold a mutation.\n' +
    `Recover with:  mv "${backupPath}" "${absFile}"`
  );
}

if (git(['ls-files', '--error-unmatch', '--', relFile], { cwd: repoRoot }).status !== 0) {
  fail(`${relFile} is not tracked by git.`);
}

// `--assume-unchanged` / `--skip-worktree` make git report a file clean no matter
// how far the worktree has diverged, so every git-based check below would lie.
const lsFlag = git(['ls-files', '-v', '--', relFile], { cwd: repoRoot }).stdout.trim().charAt(0);
if (lsFlag && lsFlag !== 'H') {
  fail(
    `${relFile} carries the git index flag '${lsFlag}' (assume-unchanged or skip-worktree).\n` +
    'git reports such a file clean regardless of its real contents, so this tool cannot\n' +
    `verify it is safe to mutate. Clear it with:  git update-index --no-assume-unchanged -- ${relFile}`
  );
}

const dirty = git(['status', '--porcelain', '--', relFile], { cwd: repoRoot }).stdout.trim();
if (dirty) {
  fail(
    `${relFile} has uncommitted changes:\n  ${dirty}\n` +
    'Commit or stash them first, so the mutation is applied to a known state.'
  );
}

// ── run ──────────────────────────────────────────────────────────

console.log(`\nmutation-check: ${relFile}`);
console.log(`  mutation: ${opts.deleteMatching !== undefined
  ? `delete lines containing "${opts.deleteMatching}"`
  : `replace "${opts.replace.slice(0, opts.replace.indexOf('::'))}"`}`);
console.log(`  test:     ${opts.test}\n`);

console.log('[1/5] baseline (expect green) ...');
const baseline = await runCommand(opts.test);
const baselineProblem = inconclusiveReason(baseline);
if (baselineProblem) fail(`Baseline inconclusive — ${baselineProblem}`);
if (baseline.status !== 0) {
  fail(
    `Baseline is already failing (exit ${baseline.status}). Fix that first — a killed or\n` +
    'surviving mutant means nothing when the suite is red to begin with.'
  );
}
const baselinePassCount = parsePassCount(baseline.output);
console.log(`      green${baselinePassCount !== null ? ` (${baselinePassCount} passing)` : ''}.\n`);

const original = readFileSync(absFile, 'utf8');

// CRLF is safe, a LONE CR is not, and the difference took three passes to get right.
//
// CRLF: splitting on '\n' leaves the '\r' at the END of each line, so rejoining reproduces
// every untouched line byte-for-byte — `"a\r\nX\r\nb\r\n"` deletes to `"a\r\nb\r\n"`. A
// guard refusing all carriage returns was added here on the theory that rejoining rewrote
// line endings; the theory was wrong and the guard only refused valid input.
//
// Lone CR (Classic-Mac line endings) is a different failure and a much worse one:
// `"a\rTARGET\rb\r".split('\n')` is ONE line, so --delete-matching deletes the entire file.
// `sites` still reports 1, which looks like a precise single-site mutation; the empty file
// parses fine as JS; and the suite then fails because the module is gone. That is reported
// as MUTANT KILLED — a fabricated kill, the exact false confidence this tool exists to
// prevent. Refuse it rather than answer dishonestly.
if (/\r(?!\n)/.test(original)) {
  fail(
    `${opts.file} contains a carriage return that is not part of a CRLF pair.\n` +
    'Splitting on LF would treat the file as a single line, so a line-oriented mutation\n' +
    'deletes everything and the resulting failure would be reported as a kill.\n' +
    'Repair with `git add --renormalize` and re-run.'
  );
}

// Build the mutant in memory. Comparing strings is how "did it land" is decided:
// asking git would be blind to exactly the cases guarded against above.
let mutated;
let sites;
if (opts.deleteMatching !== undefined) {
  const lines = original.split('\n');
  sites = lines.filter((line) => line.includes(opts.deleteMatching)).length;
  mutated = lines.filter((line) => !line.includes(opts.deleteMatching)).join('\n');
} else {
  const sep = opts.replace.indexOf('::');
  const from = opts.replace.slice(0, sep);
  const to = opts.replace.slice(sep + 2);
  sites = from === '' ? 0 : original.split(from).length - 1;
  mutated = original.split(from).join(to);
}

if (mutated === original) {
  fail(
    'The mutation would not change the file — nothing matched.\n' +
    'This is the silent no-op that makes a negative test pass vacuously.\n' +
    'The string is matched literally, not as a regex.'
  );
}
if (sites > 1 && !opts.allowMultiple) {
  fail(
    `The mutation affects ${sites} sites, not 1.\n` +
    'A collateral site can produce a kill that gets credited to the line you meant to\n' +
    'test. Narrow the string, or pass --allow-multiple if that is genuinely intended.'
  );
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  // Buffer only. `git checkout --` would restore from the index, not from what was
  // read, and would overwrite content git cannot see.
  writeFileSync(absFile, original);
  if (readFileSync(absFile, 'utf8') !== original) {
    console.error(`\nERROR: ${relFile} was NOT restored. Recover with:\n  mv "${backupPath}" "${absFile}"`);
    return;
  }
  if (existsSync(backupPath)) unlinkSync(backupPath);
}

// These now fire during the test run too, since the child is spawned asynchronously
// (#462). The on-disk backup still exists for SIGKILL, which no handler can trap.
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

let verdict = null;
let failCount = null;
// Kept outside the try so the crash check can read it after `restore()` — the verdict block
// needs the mutant's OUTPUT, not just its exit status.
let mutantOutput = '';

try {
  console.log('[2/5] writing backup and applying mutation ...');
  // On disk before the file is touched, so an untrappable death is recoverable.
  writeFileSync(backupPath, original);
  writeFileSync(absFile, mutated);
  console.log(`      ${sites} site(s) mutated; backup at ${relative(repoRoot, backupPath)}\n`);

  console.log('[3/5] checking the mutant still parses ...');
  if (!parses(absFile, mutated, repoRoot)) {
    verdict = 'invalid';
    console.log('      it does NOT parse.\n');
  } else {
    console.log('      it parses.\n');

    console.log('[4/5] running tests against the mutant (expect red) ...');
    const mutant = await runCommand(opts.test);
    const problem = inconclusiveReason(mutant);
    if (problem) {
      verdict = 'inconclusive';
      console.log(`      inconclusive — ${problem}\n`);
    } else {
      mutantOutput = mutant.output;
      failCount = parseFailCount(mutant.output);
      verdict = mutant.status !== 0 ? 'killed' : 'survived';
      console.log(`      exit ${mutant.status}${failCount !== null ? `, ${failCount} failing` : ''}\n`);
    }
  }
} finally {
  console.log('[5/5] restoring ...');
  restore();
  console.log('      restored.\n');
}

// ── verdict ──────────────────────────────────────────────────────

if (verdict === 'invalid') {
  console.error('INVALID MUTANT — the mutated file does not parse.');
  console.error('  Any red result would mean "this file is broken", not "a test covers this line".');
  console.error('  Reporting that as a kill is the false confidence this tool exists to prevent.');
  console.error('  Mutate something that leaves valid syntax — a value, not a delimiter.');
  process.exit(1);
}

if (verdict === 'inconclusive') {
  console.error('INCONCLUSIVE — the mutant run produced no usable verdict (see above).');
  process.exit(1);
}

if (verdict === 'survived') {
  console.error('MUTANT SURVIVED — this line is not covered.');
  console.error(`  Mutating it in ${relFile} did not fail "${opts.test}".`);
  console.error('  Whatever you verified by hand, no test would catch this regressing.');
  process.exit(1);
}

if (opts.expectKilledBy !== undefined) {
  if (failCount === null) {
    console.error('MUTANT KILLED, but --expect-killed-by cannot be checked:');
    console.error('  the failing-test count could not be parsed from the output.');
    console.error('  Silently accepting that would make the flag decorative.');
    process.exit(1);
  }
  if (failCount !== opts.expectKilledBy) {
    console.error(`MUTANT KILLED, but by ${failCount} tests, not the expected ${opts.expectKilledBy}.`);
    console.error('  More than expected can mean collateral coupling; fewer can mean thinner');
    console.error('  coverage than you think. Both are worth understanding before trusting it.');
    process.exit(1);
  }
}

const suspicion = crashSuspicion(mutantOutput, failCount, baselinePassCount, opts.allowBroad);
if (suspicion.length > 0) {
  console.error(`SUSPECT KILL${failCount !== null ? ` — ${failCount} failing test(s)` : ''}, but the mutant looks BROKEN rather than caught.`);
  for (const reason of suspicion) console.error(`  - ${reason}`);
  console.error('');
  console.error('  A crash proves the code is REACHED, not that its effect is asserted. The syntax');
  console.error('  gate catches a mutant that does not parse; this is the same trap one level up,');
  console.error('  where the mutant parses and then throws the moment the module runs.');
  console.error('  Mutate a VALUE instead — invert a condition, weaken a comparison, change a');
  console.error('  constant — so the module still runs to completion and only behaviour changes.');
  console.error('  Then the failing count means "tests that assert this", which is the number');
  console.error('  worth quoting.');
  process.exit(1);
}

console.log(`MUTANT KILLED${failCount !== null ? ` by ${failCount} failing test(s)` : ''} — the check can fail.`);
console.log('Quote this in the commit message: same mutation, gate red; restored, gate green.');
