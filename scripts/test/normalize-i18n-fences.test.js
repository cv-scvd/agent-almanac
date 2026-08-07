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

/**
 * Add a second skill carrying TWO divergent fences with different tags, so a
 * tag-scoped run has something to include and something to leave alone. This is
 * the shape #477's batches face: 54 of the 108 files holding yaml divergences
 * also hold bash, r or python ones belonging to later batches.
 */
function addMixedSkill(dir) {
  const english = [
    '---', 'name: mixed-skill', 'description: Two fences.', '---', '',
    '# Mixed', '', '## Procedure', '',
    '```bash', 'echo "english-bash"', '```', '',
    '```yaml', 'key: english-yaml', '```', '',
  ].join('\n');
  mkdirSync(join(dir, 'skills', 'mixed-skill'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'mixed-skill', 'SKILL.md'), english, 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'english mixed skill']);
  const sc = git(dir, ['rev-parse', 'HEAD']);

  const translatedPath = join(dir, 'i18n', 'de', 'skills', 'mixed-skill', 'SKILL.md');
  mkdirSync(dirname(translatedPath), { recursive: true });
  writeFileSync(translatedPath, [
    '---', 'name: mixed-skill', 'description: Zwei Bloecke.',
    'locale: de', 'source_locale: en', `source_commit: ${sc}`, '---', '',
    '# Gemischt', '', '## Ablauf', '',
    '```bash', 'echo "uebersetzt-bash"', '```', '',
    '```yaml', 'key: uebersetzt-yaml', '```', '',
  ].join('\n'), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'de mixed translation, both fences divergent']);
  return translatedPath;
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

test('--write refuses on an UNTRACKED file, the one case git cannot restore', async (t) => {
  // The modified-file case is recoverable: `git checkout -- i18n/` brings it
  // back. An untracked translation has no copy in git at all, so overwriting it
  // destroys the only one — this is the case the guard most needs to catch, and
  // `git status --porcelain` reports it as `??` rather than ` M`.
  const { dir } = makeFixture(t);
  const untracked = join(dir, 'i18n', 'de', 'skills', 'demo-skill', 'DRAFT.md');
  writeFileSync(untracked, 'Work in progress, never committed.\n', 'utf8');

  const r = run(dir, ['--write']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /\?\? i18n\/de\/skills\/demo-skill\/DRAFT\.md/);
  // Plain `git stash` leaves untracked files behind, so advising it here would
  // hand back a tree the guard still refuses.
  assert.match(r.stderr, /git stash -u/);
  assert.equal(readFileSync(untracked, 'utf8'), 'Work in progress, never committed.\n');
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
  // The count, not just the banner. Both the banner and exit 0 are emitted
  // unconditionally, so asserting only those cannot tell "previewed the dirty
  // tree normally" from "previewed it and silently found nothing" — and preview
  // is now the default mode, so this count is the number a caller acts on.
  assert.match(r.stdout, /files to change: 1/);
});

// ── --tag: the #477 batch scoping ───────────────────────────────────────────

test('--tag restores only the named tag, leaving other tags divergent', async (t) => {
  const { dir } = makeFixture(t);
  const mixed = addMixedSkill(dir);

  const r = run(dir, ['--tag', 'yaml', '--write']);

  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(mixed, 'utf8');
  assert.ok(after.includes('key: english-yaml'), 'the yaml fence should be restored');
  assert.ok(after.includes('echo "uebersetzt-bash"'),
    'the bash fence belongs to a later batch and must be left alone');
});

test('--tag accepts a comma list, and the = form', async (t) => {
  const { dir } = makeFixture(t);
  addMixedSkill(dir);

  const list = run(dir, ['--tag', 'yaml,bash']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /fences to restore: 3/, 'both mixed fences plus the demo bash one');

  const eq = run(dir, ['--tag=yaml']);
  assert.equal(eq.status, 0, eq.stderr);
  assert.match(eq.stdout, /fences to restore: 1/);
});

test('a --tag matching nothing is an error, not a clean-looking zero', async (t) => {
  // The `--locale` lesson, one flag over: a scoping value that matches nothing
  // reports "files to change: 0", which reads as "this batch is already done".
  const { dir } = makeFixture(t);
  addMixedSkill(dir);

  const r = run(dir, ['--tag', 'yaml,nosuchtag', '--write']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /matched no divergent fence: nosuchtag/);
  assert.match(r.stderr, /Divergent tags present:.*yaml/, 'should list what IS available');
  assert.equal(isDirty(dir), false, 'a rejected batch must not have written anything');
});

test('--tag with no usable value is an error', async (t) => {
  const { dir } = makeFixture(t);

  for (const args of [['--tag'], ['--tag', '--write'], ['--tag='], ['--tag', ',, ,']]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} was accepted`);
  }
});

test('--tag does NOT relax the alignment checks', async (t) => {
  // Scoping narrows what gets repaired, never whether ordinal mapping is
  // trustworthy. A file the unscoped run refuses to touch must stay refused,
  // or a batch could rewrite fences on a mapping the tool knows is unsound.
  const { dir } = makeFixture(t);
  const mixed = addMixedSkill(dir);
  // Drop a fence from the translation so counts no longer match the basis.
  writeFileSync(mixed, readFileSync(mixed, 'utf8')
    .replace('```bash\necho "uebersetzt-bash"\n```\n\n', ''), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'drop a fence, breaking ordinal mapping']);

  const r = run(dir, ['--tag', 'yaml', '--write']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skipped/, 'the misaligned file must be reported, not repaired');
  assert.ok(readFileSync(mixed, 'utf8').includes('key: uebersetzt-yaml'),
    'a file with unsound ordinal mapping must not be rewritten by a scoped run');
});

// ── argument parsing ────────────────────────────────────────────────────────

test('--locale=de is honoured, not silently dropped', async (t) => {
  // `indexOf('--locale')` does not match `--locale=de`, so the locale scoping
  // vanished and the run silently covered every locale. On the real corpus that
  // was 281 files where 63 were asked for — with --write, a stray broad write
  // reached by spelling a correct command the ordinary way.
  const { dir, translated } = makeFixture(t);
  mkdirSync(join(dir, 'i18n', 'es', 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(
    join(dir, 'i18n', 'es', 'skills', 'demo-skill', 'SKILL.md'),
    readFileSync(translated, 'utf8').replace('locale: de', 'locale: es'),
    'utf8',
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'es translation, also divergent']);

  const both = run(dir);
  assert.match(both.stdout, /files to change: 2/, 'fixture should have two divergent locales');

  const scoped = run(dir, ['--locale=de']);

  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /files to change: 1/, '--locale=de did not scope the run');
  assert.match(scoped.stdout, /by locale: de=1/);
});

test('--basis=head is honoured too', async (t) => {
  const { dir } = makeFixture(t);

  const r = run(dir, ['--basis=head']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /basis: head/);
});

test('an unknown argument is an error, not a silent no-op', async (t) => {
  const { dir } = makeFixture(t);

  for (const arg of ['--wrte', '--locale-de', 'stray-positional', '--writeq']) {
    const r = run(dir, [arg]);
    assert.equal(r.status, 2, `'${arg}' was accepted`);
    assert.match(r.stderr, /unknown argument/);
  }
});

test('a value passed to a boolean flag is an error', async (t) => {
  const { dir } = makeFixture(t);

  const r = run(dir, ['--write=true']);

  assert.equal(r.status, 2);
  assert.match(r.stderr, /takes no value/);
});

test('a value flag with no value is still an error', async (t) => {
  const { dir } = makeFixture(t);

  for (const args of [['--locale'], ['--locale', '--dry'], ['--locale=']]) {
    const r = run(dir, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} was accepted`);
    assert.match(r.stderr, /requires a value/);
  }
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
