/**
 * Behavioural tests for `scripts/normalize-i18n-fences.js` (#486).
 *
 * The property under test is that the tool does NOT write unless asked. That
 * property is trivial to assert vacuously: a run over a corpus with nothing to
 * repair also writes nothing, and such a test stays green even if `--write`
 * were the default again. So every "writes nothing" case here is paired with a
 * `--write` case proving the same fixture DOES get rewritten — the difference
 * between the two is the whole gate.
 *
 * Each test builds a throwaway git repo holding the script, its lib, and one
 * English skill plus one divergent translation. That keeps a run under a second
 * (against the real corpus it is ~90s, dominated by walking English history)
 * and lets a test dirty the tree without touching the working repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/normalize-i18n-fences.js';

const ENGLISH_FENCE = 'echo "hello"';
const TRANSLATED_FENCE = 'echo "hallo"';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function englishSkill() {
  return [
    '---', 'name: demo-skill', 'description: A demo skill.', '---', '',
    '# Demo Skill', '', '## Procedure', '',
    '```bash', ENGLISH_FENCE, '```', '',
  ].join('\n');
}

function translatedSkill(sourceCommit) {
  return [
    '---', 'name: demo-skill', 'description: Eine Demo-Fertigkeit.',
    'locale: de', 'source_locale: en', `source_commit: ${sourceCommit}`, '---', '',
    '# Demo-Fertigkeit', '', '## Ablauf', '',
    // Gated (bash), and a body that appears in no English revision — exactly
    // what the parity gate flags and this tool repairs.
    '```bash', TRANSLATED_FENCE, '```', '',
  ].join('\n');
}

/**
 * A minimal repo the tool can run against: its own `scripts/` copy (the tool
 * resolves ROOT from `__dirname/..`, so it always operates on the tree it sits
 * in), a `package.json` marking ESM, and a clean two-commit history.
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'norm-fences-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, SCRIPT), join(dir, SCRIPT));
  cpSync(join(REPO, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);

  mkdirSync(join(dir, 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'demo-skill', 'SKILL.md'), englishSkill(), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'english source']);
  const sourceCommit = git(dir, ['rev-parse', 'HEAD']);

  const translated = join(dir, 'i18n', 'de', 'skills', 'demo-skill', 'SKILL.md');
  mkdirSync(dirname(translated), { recursive: true });
  writeFileSync(translated, translatedSkill(sourceCommit), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'de translation with a divergent fence']);

  return { dir, translated };
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const isDirty = (dir) => git(dir, ['status', '--porcelain']) !== '';

// ── the gate ────────────────────────────────────────────────────────────────

test('no flags: previews, and writes nothing', async (t) => {
  const { dir, translated } = makeFixture(t);
  const before = readFileSync(translated, 'utf8');

  const r = run(dir);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREVIEW — nothing written/);
  assert.match(r.stdout, /files to change: 1/);
  assert.equal(readFileSync(translated, 'utf8'), before, 'file was modified by a preview run');
  assert.equal(isDirty(dir), false, 'a preview run left the tree dirty');
});

test('--write: rewrites the same fixture the default run left alone', async (t) => {
  // Without this the test above is vacuous — it would pass on a fixture the
  // tool had no reason to touch, and on a tool that still wrote by default.
  const { dir, translated } = makeFixture(t);

  const r = run(dir, ['--write']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Wrote changes/);
  assert.match(r.stdout, /fences restored: 1/);
  const after = readFileSync(translated, 'utf8');
  assert.ok(after.includes(ENGLISH_FENCE), 'English body was not restored');
  assert.ok(!after.includes(TRANSLATED_FENCE), 'translated fence body survived the repair');
  assert.equal(isDirty(dir), true, 'a --write run should leave the tree dirty');
});

test('--write announces the write on stderr, so redirecting stdout cannot hide it', async (t) => {
  const { dir } = makeFixture(t);

  const r = run(dir, ['--write']);

  assert.match(r.stderr, /WRITING 1 file\(s\) \/ 1 fence\(s\) under i18n\/ \.\.\./);
});

test('--dry is still accepted, and still previews', async (t) => {
  const { dir, translated } = makeFixture(t);
  const before = readFileSync(translated, 'utf8');

  const r = run(dir, ['--dry']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREVIEW — nothing written/);
  assert.equal(readFileSync(translated, 'utf8'), before);
});

test('--write --dry is a contradiction, not a preference', async (t) => {
  const { dir, translated } = makeFixture(t);
  const before = readFileSync(translated, 'utf8');

  const r = run(dir, ['--write', '--dry']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /contradict/);
  assert.equal(readFileSync(translated, 'utf8'), before);
});

// ── the dirty-tree refusal ──────────────────────────────────────────────────

test('--write refuses when the write scope is dirty, and touches nothing', async (t) => {
  const { dir, translated } = makeFixture(t);
  const handEdit = readFileSync(translated, 'utf8') + '\nUncommitted prose a human just wrote.\n';
  writeFileSync(translated, handEdit, 'utf8');

  const r = run(dir, ['--write']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /has uncommitted changes/);
  assert.match(r.stderr, /i18n\/de\/skills\/demo-skill\/SKILL\.md/);
  assert.equal(readFileSync(translated, 'utf8'), handEdit, 'the uncommitted edit was overwritten');
});

test('the dirty-tree refusal fires before any scanning', async (t) => {
  // Placement is the point: the guard sits ahead of ~90s of history reading on
  // the real corpus. If it drifts below that, the refusal still works but stops
  // being usable — a caller learns their run was rejected two minutes in.
  // A two-commit fixture cannot show that as duration, but it can show that the
  // rejected run emitted no scan output at all.
  const { dir, translated } = makeFixture(t);
  writeFileSync(translated, readFileSync(translated, 'utf8') + '\nedit\n', 'utf8');

  const r = run(dir, ['--write']);

  assert.equal(r.status, 2);
  assert.equal(r.stdout, '', 'the guard let the run reach the scanning stage');
});

test('a preview run is unaffected by a dirty tree', async (t) => {
  // The guard exists to protect uncommitted work from being overwritten. A
  // preview overwrites nothing, so blocking it would only train callers to
  // pass --write to see what a run would do.
  const { dir, translated } = makeFixture(t);
  writeFileSync(translated, readFileSync(translated, 'utf8') + '\nedit\n', 'utf8');

  const r = run(dir);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREVIEW — nothing written/);
});

// ── the no-op guards ────────────────────────────────────────────────────────

test('--locale matching no locale is an error, not a clean-looking zero', async (t) => {
  const { dir } = makeFixture(t);

  const r = run(dir, ['--locale', 'nope', '--write']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not a translated locale/);
  assert.match(r.stderr, /Available: de/);
});

// The first version of this guard asked "does `i18n/<value>` exist?", which is a
// different question from "would the scan accept this locale?". Each input below
// answered yes to the first and no to the second, and so reached the vacuous
// `files to change: 0` the guard exists to reject.
for (const [label, locale] of [
  ['a path segment', 'de/skills'],
  ['a dot-segment', '..'],
  ['a directory with no skills/ subtree', 'glossaries'],
]) {
  test(`--locale rejects ${label} ('${locale}')`, async (t) => {
    const { dir } = makeFixture(t);
    // A real i18n/ sibling that is a directory but carries no translations —
    // `i18n/glossaries/` in the working repo.
    mkdirSync(join(dir, 'i18n', 'glossaries'), { recursive: true });
    writeFileSync(join(dir, 'i18n', 'glossaries', 'de.yml'), 'term: Begriff\n', 'utf8');

    const r = run(dir, ['--locale', locale, '--write']);

    assert.equal(r.status, 2, `'${locale}' was accepted: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /is not a translated locale/);
  });
}

test('--locale scopes the dirty check to that locale', async (t) => {
  const { dir, translated } = makeFixture(t);
  mkdirSync(join(dir, 'i18n', 'es'), { recursive: true });
  writeFileSync(join(dir, 'i18n', 'es', 'stray.md'), 'untracked\n', 'utf8');

  // `es` is dirty; a `de`-scoped write must not be blocked by it.
  const r = run(dir, ['--locale', 'de', '--write']);

  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(readFileSync(translated, 'utf8'), /hallo/);
});
