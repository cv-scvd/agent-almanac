/**
 * Behavioural tests for `scripts/normalize-content-style.js` (#490).
 *
 * The property under test is that the tool PREVIEWS unless asked to write. #486 inverted
 * the same default in the i18n normalizer after a read-only probe agent typed the bare
 * command and silently rewrote 281 files; this file's blast radius is larger, since
 * `--scope all` is the whole corpus and the default scope is still every English content
 * file.
 *
 * That property is trivial to assert vacuously: a run over a corpus with nothing to repair
 * also writes nothing, and such a test stays green even if `--write` were the default
 * again. So every "writes nothing" case here is paired with a `--write` case proving the
 * SAME fixture does get rewritten. The difference between the two is the whole gate.
 *
 * Each test builds a throwaway git repo holding the script and one content file. Nothing
 * touches the working repository — a test that dirties the real tree makes ambient state
 * decide the result (#453).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/normalize-content-style.js';

/** A decorative separator: a separator row carrying four or more dashes. */
const DECORATIVE = '| Col A | Col B |\n|-------|:------|\n| x | y |\n';
/** What the normalizer must produce — three dashes per column, alignment colon kept. */
const COMPACTED = '| Col A | Col B |\n|---|:---|\n| x | y |\n';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A throwaway repo containing the script and one committed content file. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'norm-content-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'agents'), { recursive: true });
  cpSync(join(REPO, SCRIPT), join(dir, SCRIPT));
  writeFileSync(join(dir, 'agents', 'sample.md'), DECORATIVE);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

function run(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

function body(dir) {
  return readFileSync(join(dir, 'agents', 'sample.md'), 'utf8');
}

function withFixture(fn) {
  const dir = fixture();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the gate itself: preview by default, write only when asked -----------------------

test('the bare command does not write', () => {
  withFixture((dir) => {
    const r = run(dir, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body(dir), DECORATIVE, 'the bare command rewrote the file');
    assert.match(r.stdout, /PREVIEW/);
    // Not vacuous: the run DID find the change, it just declined to apply it.
    assert.match(r.stdout, /separators compacted: 1/);
    assert.match(r.stdout, /files to change: 1/);
  });
});

test('--write applies the same change the bare command only reported', () => {
  withFixture((dir) => {
    const r = run(dir, ['--write']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body(dir), COMPACTED);
    assert.match(r.stdout, /files written: 1/);
  });
});

test('--dry is an explicit no-op, not a write', () => {
  withFixture((dir) => {
    const r = run(dir, ['--dry']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(body(dir), DECORATIVE);
  });
});

test('--write and --dry together are refused rather than guessed', () => {
  withFixture((dir) => {
    const r = run(dir, ['--write', '--dry']);
    assert.equal(r.status, 2);
    assert.equal(body(dir), DECORATIVE);
  });
});

// --- refuses to write into a dirty scope ----------------------------------------------

test('--write refuses when the scope is dirty, and preview still works', () => {
  withFixture((dir) => {
    writeFileSync(join(dir, 'agents', 'sample.md'), `${DECORATIVE}\nuncommitted\n`);
    const dirty = body(dir);

    const w = run(dir, ['--write']);
    assert.equal(w.status, 2, 'wrote into a dirty scope');
    assert.match(w.stderr, /dirty scope/);
    assert.equal(body(dir), dirty, 'the refused run still modified the file');

    // The guard must not over-block: previewing a dirty scope is safe and must succeed.
    const p = run(dir, []);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(body(dir), dirty);
  });
});

// --- default-deny on flags and values -------------------------------------------------

test('an unknown flag is refused rather than ignored', () => {
  withFixture((dir) => {
    const r = run(dir, ['--wrote']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag --wrote/);
    assert.equal(body(dir), DECORATIVE);
  });
});

test('--mode and --scope reject values outside their sets', () => {
  withFixture((dir) => {
    assert.equal(run(dir, ['--mode', 'sideways']).status, 2);
    assert.equal(run(dir, ['--scope', 'everything']).status, 2);
    assert.equal(run(dir, ['--files']).status, 2);
  });
});

test('--files stops at the next flag instead of eating its value', () => {
  withFixture((dir) => {
    // `--files a.md --mode both` previously kept 'both' as a filename, because the parse
    // filtered out only `--`-prefixed args. The scanned count is what proves it.
    const r = run(dir, ['--files', 'agents/sample.md', '--mode', 'both']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /of 1 scanned/);
  });
});
