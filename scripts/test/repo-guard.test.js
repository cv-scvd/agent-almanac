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

test('verify consumes the snapshot, so a second verify cannot pass on a stale one', async (t) => {
  // Otherwise a snapshot left behind by an earlier run would answer a later
  // question it never observed — a green that means nothing.
  const dir = makeRepo(t);
  guard(dir, ['snapshot']);
  assert.equal(guard(dir, ['verify']).status, 0);

  const second = guard(dir, ['verify']);

  assert.equal(second.status, 2);
  assert.match(second.stderr, /no snapshot/);
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

  for (const args of [['snapshot', '--force'], ['verify', '--all'], ['inspect']]) {
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

  const r = guard(dir, ['verify', '--keep']);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(snapshotPath(dir)), '--keep should preserve it');
});
