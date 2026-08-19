/**
 * `check-i18n-fence-parity.js` answered a mistyped `--id` with `OK` and exit 0 (#634).
 *
 * Measured before the fix:
 *
 *   $ node scripts/check-i18n-fence-parity.js --id write-helm-chrat
 *   i18n fence parity: 0 fences in 0 translated skills
 *   OK: every gated code fence matches an English source revision.
 *   $ echo $?
 *   0
 *
 * "Every gated code fence matches" is true of the empty set, which is what makes this worse than
 * an ordinary typo: CLAUDE.md tells a contributor to run exactly this command on the one file
 * they just edited. Edit a fence, mistype the id, see OK, commit.
 *
 * The guard asks REACHED, not EXISTS. A real content id nobody has translated must refuse too —
 * `existsSync('skills/' + id)` would pass for it and still compare nothing, which is the
 * proxy-predicate mistake CLAUDE.md names. That case has its own test below, and it is the one
 * that separates this guard from the obvious wrong one.
 *
 * MUST-GO-RED, both measured against `npm run test:scripts` on a 529-test green baseline:
 *
 *   delete the `process.exit(2)` in `collectTargets`        exit 1, 4 failing — all four refusals
 *   neuter the `onlyId` arm of `validateScope`              exit 1, 3 failing — locale stays green
 *
 * The second number is the one worth having. It shows the four tests are not one test written
 * four ways: the locale arm and the id arm are covered separately, and a mutation to either is
 * visible on its own. Both kills are narrow — 4 and 3 of 529 — and neither prints a runtime
 * error, so neither is the crash-shaped false kill `mutation-verdict.js` exists to flag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-i18n-fence-parity.js');

const doc = (title) => `# ${title}\n\n\`\`\`yaml\na: 1\n\`\`\`\n`;

/**
 * A fixture whose translation coverage is deliberately RAGGED, because every interesting case
 * here is about a scope that is individually valid and jointly empty.
 *
 *   alpha  translated into de       gamma  English only — real id, zero mirrors
 *   beta   translated into ja
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aa-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  for (const id of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(dir, 'skills', id), { recursive: true });
    writeFileSync(join(dir, 'skills', id, 'SKILL.md'), doc(id));
  }
  git('add', '-A');
  git('commit', '-qm', 'english');

  for (const [locale, id] of [['de', 'alpha'], ['ja', 'beta']]) {
    mkdirSync(join(dir, 'i18n', locale, 'skills', id), { recursive: true });
    writeFileSync(join(dir, 'i18n', locale, 'skills', id, 'SKILL.md'), doc(id));
  }
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [CHECKER, '--root', dir, ...args], { encoding: 'utf8' });
}

function withFixture(body) {
  const dir = fixture();
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a mistyped --id refuses, and says so in the exit code', () => {
  withFixture((dir) => {
    const r = run(dir, '--id', 'alhpa');
    // 2, not merely non-zero. 1 means "the thing I check is wrong"; asserting only `!== 0` would
    // be satisfied by a findings-exit-1, so this test would stay green with the guard deleted on
    // any fixture that happens to carry a violation.
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--id 'alhpa' matched no translated content/);
    assert.doesNotMatch(r.stdout, /OK: every gated code fence matches/);
  });
});

test('a mistyped --locale refuses too — the gate validated neither before', () => {
  withFixture((dir) => {
    const r = run(dir, '--locale', 'ed');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--locale 'ed' matched no translated content/);
  });
});

test('a --locale/--id pair that is individually valid but JOINTLY empty refuses', () => {
  // `beta` is translated, and `de` has translations — but not of `beta`. Both flags name
  // something real, so any guard checking them separately passes and compares nothing.
  withFixture((dir) => {
    assert.equal(run(dir, '--id', 'beta').status, 0, 'beta alone is reachable');
    assert.equal(run(dir, '--locale', 'de').status, 0, 'de alone is reachable');

    const r = run(dir, '--locale', 'de', '--id', 'beta');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--id 'beta' matched no translated content in locale 'de'/);
  });
});

test('REACHED, not EXISTS: a real id with zero mirrors refuses', () => {
  // THE CASE THAT SEPARATES THIS GUARD FROM THE WRONG ONE. `gamma` is a genuine English source in
  // the fixture, so `existsSync('skills/gamma/SKILL.md')` is true — and there is nothing to
  // compare it against. A guard built on existence passes here and reports a clean zero.
  withFixture((dir) => {
    const r = run(dir, '--id', 'gamma');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--id 'gamma' matched no translated content/);
  });
});

test('a scope that DOES reach something still runs — the non-vacuity control', () => {
  // Without this, every assertion above is satisfied by a gate that refuses everything.
  withFixture((dir) => {
    const r = run(dir, '--locale', 'de', '--id', 'alpha', '--json');
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.filesCompared, 1, 'the scoped file must actually have been compared');
    assert.equal(report.violations, 0);
  });
});
