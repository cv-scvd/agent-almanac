/**
 * Behavioural tests for `scripts/repo-guard.js` (#493).
 *
 * The guard's whole value is detecting changes that other checks miss, so
 * "verify passes on an untouched repo" is the least interesting case here. Each
 * test below makes a specific change and asserts the guard goes red — and the
 * `skip-worktree` case additionally asserts that plain `git status` reads CLEAN
 * on the same tree, which is what makes that mechanism worth guarding at all.
 *
 * Fixtures are built with `mkdtempSync`, never a shared fixed path. That is the
 * pattern whose absence caused #493: two agents wrote the same scratchpad
 * filename, and the second clobbered the first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'repo-guard.js');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function guard(cwd, args) {
  const r = spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Inside `.git/`, deliberately — see the note on SNAPSHOT_NAME in repo-guard.js. */
const snapshotPath = (dir) => join(dir, '.git', 'repo-guard.json');

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.txt'), 'original\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

// ── the baseline, and proof it is not vacuous ───────────────────────────────

test('verify passes when nothing happened', async (t) => {
  const dir = makeRepo(t);

  assert.equal(guard(dir, ['snapshot']).status, 0);
  const r = guard(dir, ['verify']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unchanged at/);
});

test('verify KEEPS the snapshot, so a run cannot be silently disarmed', async (t) => {
  // Consuming by default was the original design and it disarmed the guard the
  // first time it was dogfooded: something ran verify mid-run, and the real
  // check afterwards had nothing to compare against. A retained snapshot can
  // only ever over-report, never under-report, so keeping is the safe direction.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);

  assert.equal(guard(dir, ['verify']).status, 0);
  const second = guard(dir, ['verify']);

  assert.equal(second.status, 0, 'the snapshot should still be there');
  assert.match(second.stdout, /unchanged at/);
});

test('--release drops the snapshot when the run is genuinely over', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);

  assert.equal(guard(dir, ['verify', '--release']).status, 0);

  const after = guard(dir, ['verify']);
  assert.equal(after.status, 2);
  assert.match(after.stderr, /no snapshot/);
});

test('snapshot refuses to overwrite, so a nested run cannot rebaseline damage', async (t) => {
  // The laundering path: run A arms, an agent strays, run B arms afresh — now
  // the stray write is part of B's baseline and A's verify reports green.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  writeFileSync(join(dir, 'strayed.txt'), 'damage\n', 'utf8');

  const second = guard(dir, ['snapshot']);

  assert.equal(second.status, 2, 'a second snapshot must not silently replace the first');
  assert.match(second.stderr, /already exists/);
  // The original baseline must survive and still see the damage.
  const v = guard(dir, ['verify']);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /strayed\.txt/);
});

// ── the four mechanisms from the incident ───────────────────────────────────

test('detects a stray COMMIT — the case git status cannot see', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);

  // Exactly what the subagent did: write into the tree, then commit it.
  mkdirSync(join(dir, 'i18n', 'de'), { recursive: true });
  writeFileSync(join(dir, 'i18n', 'de', 'SKILL.md'), 'stray fixture\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'de translation']);

  // The premise: after committing, the tree is clean and every dirty-check passes.
  assert.equal(git(dir, ['status', '--porcelain']), '', 'precondition: tree reads clean');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /HEAD moved/);
  assert.match(r.stderr, /de translation/, 'should name the stray commit');
  assert.match(r.stderr, /git reset --mixed/, 'should give the recovery command');
});

test('detects a stray write to an ALREADY-modified file', async (t) => {
  // The blocking defect the first version shipped with. Comparing status LINES
  // alone, ` M src/a.txt` reads identical before and after an overwrite, so the
  // guard reported "unchanged" while the file had been rewritten. This repo is
  // normally mid-edit, which makes it the common case rather than the exotic one.
  const dir = makeRepo(t);
  writeFileSync(join(dir, 'src', 'a.txt'), 'my own work in progress\n', 'utf8');
  guard(dir, ['snapshot']);

  const statusBefore = git(dir, ['status', '--porcelain']);
  writeFileSync(join(dir, 'src', 'a.txt'), 'CLOBBERED BY A STRAY AGENT\n', 'utf8');
  assert.equal(git(dir, ['status', '--porcelain']), statusBefore,
    'precondition: the porcelain line is byte-identical before and after');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1, 'a status-line-only comparison would pass here');
  assert.match(r.stderr, /contents changed/);
  assert.match(r.stderr, /src\/a\.txt/);
});

test('detects a new file inside an already-untracked directory', async (t) => {
  // `git status --porcelain` collapses an untracked directory to a single entry,
  // so without -uall a file added inside it moves no line.
  const dir = makeRepo(t);
  mkdirSync(join(dir, 'scratch'), { recursive: true });
  writeFileSync(join(dir, 'scratch', 'one.txt'), 'first\n', 'utf8');
  guard(dir, ['snapshot']);

  writeFileSync(join(dir, 'scratch', 'two.txt'), 'snuck in\n', 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /scratch\/two\.txt/);
});

test('detects a modified tracked file', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  writeFileSync(join(dir, 'src', 'a.txt'), 'rewritten by a stray --write\n', 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /working tree/);
  assert.match(r.stderr, /src\/a\.txt/);
});

test('detects a new untracked file', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  writeFileSync(join(dir, 'fixture.sh'), '#!/bin/sh\n', 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixture\.sh/);
});

test('detects a skip-worktree bit — which makes git status LIE afterwards', async (t) => {
  // The incident really ran `git update-index --skip-worktree` on a real path.
  // From that point on git reports the file clean no matter what it contains, so
  // this bit poisons every later check. A guard blind to it can be disarmed.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);

  git(dir, ['update-index', '--skip-worktree', 'src/a.txt']);
  writeFileSync(join(dir, 'src', 'a.txt'), 'changed behind the flag\n', 'utf8');

  assert.equal(git(dir, ['status', '--porcelain']), '',
    'precondition: git status reads clean despite the file being modified');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /index flags/);
  assert.match(r.stderr, /src\/a\.txt/);
});

test('detects a skip-worktree bit set from a SUBDIRECTORY', async (t) => {
  // `git ls-files -v` is cwd-scoped: run from a subdirectory it lists only that
  // subtree, so a bit set elsewhere would be invisible and the guard would cover
  // less than it claims. Every git call therefore runs from the toplevel.
  const dir = makeRepo(t);
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(join(dir, 'other', 'b.txt'), 'b\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'add other']);
  guard(dir, ['snapshot']);

  git(dir, ['update-index', '--skip-worktree', 'src/a.txt']);

  // Verify from a subdirectory that does NOT contain the flagged file.
  const r = guard(join(dir, 'other'), ['verify']);

  assert.equal(r.status, 1, 'cwd-scoped ls-files would miss this');
  assert.match(r.stderr, /src\/a\.txt/);
});

test('recovery advice does not suggest a reset when HEAD never moved', async (t) => {
  // `git reset --mixed` would unstage the caller's own work. Printing it for a
  // pure worktree change is advice that destroys data.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  writeFileSync(join(dir, 'stray.txt'), 'x\n', 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /git reset --mixed/);
  assert.match(r.stderr, /HEAD did not move/);
});

test('detects a branch switch', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  git(dir, ['checkout', '-q', '-b', 'somewhere-else']);

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /branch changed: main -> somewhere-else/);
});

// ── failing closed ──────────────────────────────────────────────────────────

test('verify without a snapshot is an error, never a pass', async (t) => {
  const dir = makeRepo(t);

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 2, 'a comparison that never happened must not report success');
  assert.match(r.stderr, /no snapshot/);
});

test('an unreadable snapshot is an error, never a pass', async (t) => {
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  writeFileSync(snapshotPath(dir), '{ not json', 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /unreadable/);
});

test('a snapshot in an older format is an error naming the reason', async (t) => {
  // Hit for real: a snapshot armed before the `contents` field was added made
  // verify die with "missing 'contents'" — accurate and useless.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  const snap = JSON.parse(readFileSync(snapshotPath(dir), 'utf8'));
  delete snap.formatVersion;
  delete snap.contents;
  writeFileSync(snapshotPath(dir), JSON.stringify(snap), 'utf8');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /format v1, but this is v2/);
  assert.match(r.stderr, /guard:snapshot/, 'should say how to recover');
});

test('a snapshot from a different repository is an error', async (t) => {
  const a = makeRepo(t);
  const b = makeRepo(t);
  guard(a, ['snapshot']);
  writeFileSync(snapshotPath(b), readFileSync(snapshotPath(a), 'utf8'), 'utf8');

  const r = guard(b, ['verify']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /was taken in/);
});

test('an unknown argument is an error, not a silently narrower check', async (t) => {
  const dir = makeRepo(t);

  for (const args of [['snapshot', '--release'], ['verify', '--force'], ['verify', '--all'], ['inspect']]) {
    const r = guard(dir, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} was accepted`);
    assert.match(r.stderr, /unknown (argument|command)/);
  }
});

test('the snapshot lives outside the working tree, so it cannot dirty it', async (t) => {
  // The first version wrote it to the repo root, where it showed up in `git
  // status` as untracked and an agent's `git add -A` — the very command from the
  // incident — would have committed it. `.git/` is outside the working tree.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);

  assert.ok(existsSync(snapshotPath(dir)), 'snapshot should be inside .git/');
  assert.equal(git(dir, ['status', '--porcelain']), '',
    'taking a snapshot must not dirty the working tree');

  const r = guard(dir, ['verify']);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(snapshotPath(dir)), 'verify keeps the snapshot by default');
});
