/**
 * fence-basis-stamp.test.js — what the normalizer is allowed to CLAIM (#552).
 *
 * `normalize-i18n-fences.js` is the only writer of `fence_basis_commit`, and it was the only
 * tool in the schema with no wiring test — the reader side got three suites and four killed
 * mutations while the pen that signs the corpus got none.
 *
 * The claim it writes names ONE English revision. Proving "every gated fence matches SOME
 * revision" is a weaker statement than that, and the gap between them is reachable: the splice
 * repairs only the DIVERGENT fences, so an untouched fence keeps a body from whatever revision
 * it came from. A file can therefore end up mirroring revision W at one ordinal and X at
 * another, and be stamped X — a false claim at the moment it is written, invisible to the
 * checker (each body matches some revision), and inherited by the backfill.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/normalize-i18n-fences.js';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** English with two gated fences, whose bodies are given. */
const english = (a, b) => [
  '---', 'name: demo-skill', 'description: A demo skill.', '---', '',
  '# Demo Skill', '', '## One', '', '```bash', a, '```', '', '## Two', '', '```bash', b, '```', '',
].join('\n');

const translated = (sourceCommit, a, b) => [
  '---', 'name: demo-skill', 'description: Eine Demo.', 'locale: de', 'source_locale: en',
  `source_commit: ${sourceCommit}`, '---', '',
  '# Demo', '', '## Eins', '', '```bash', a, '```', '', '## Zwei', '', '```bash', b, '```', '',
].join('\n');

/**
 * Two English revisions where BOTH fences changed, and a translation that carries the OLD
 * second fence with a bumped `source_commit` — the #405 shape: a tool moved the field without
 * retranslating. Its first fence is hand-localized, so it is divergent and the file enters the
 * repair plan.
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fence-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(REPO, SCRIPT), join(dir, SCRIPT));
  cpSync(join(REPO, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);

  const skill = join(dir, 'skills', 'demo-skill', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });

  // Revision W.
  writeFileSync(skill, english('echo "A1"', 'echo "B1"'), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'english W']);

  // Revision X — BOTH fence bodies change, so B1 belongs to W alone.
  writeFileSync(skill, english('echo "A2"', 'echo "B2"'), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'english X']);
  const X = git(dir, ['rev-parse', '--short', 'HEAD']);

  // The mirror: fence 1 localized (divergent), fence 2 still W's body, source_commit at X.
  const mirror = join(dir, 'i18n', 'de', 'skills', 'demo-skill', 'SKILL.md');
  mkdirSync(dirname(mirror), { recursive: true });
  writeFileSync(mirror, translated(X, 'echo "LOKALISIERT"', 'echo "B1"'), 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'de mirror']);

  return { dir, mirror, X };
}

const run = (dir, args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
const field = (text, name) => (text.match(new RegExp(`^\\s*${name}:\\s*(\\S+)`, 'm')) || [])[1];

describe('normalize-i18n-fences: what it may claim (#552)', () => {
  it('does not stamp a basis the file only partly mirrors', (t) => {
    const { dir, mirror, X } = makeFixture(t);
    const r = run(dir, ['--write']);
    assert.equal(r.status, 0, `normalizer failed:\n${r.stdout}\n${r.stderr}`);

    const after = readFileSync(mirror, 'utf8');

    // The repair itself must still have happened: the divergent fence takes X's body.
    assert.ok(after.includes('echo "A2"'), 'the divergent fence should be repaired from the basis');
    // And the untouched fence still carries W's body — it matched history, so nothing rewrote it.
    assert.ok(after.includes('echo "B1"'), 'the non-divergent fence is left alone by design');

    // Therefore the file mirrors X at ordinal 1 and W at ordinal 2. No single revision
    // describes it, so there is no true value to write and the field must be absent.
    assert.equal(field(after, 'fence_basis_commit'), undefined,
      `stamped a basis (${X}) that only one of two fences mirrors — a false claim at birth`);
  });

  it('stamps when the repaired file mirrors the basis at every gated fence', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'fence-stamp-ok-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(join(REPO, SCRIPT), join(dir, SCRIPT));
    cpSync(join(REPO, 'scripts', 'lib'), join(dir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    git(dir, ['config', 'user.name', 'Fixture']);

    const skill = join(dir, 'skills', 'demo-skill', 'SKILL.md');
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, english('echo "A1"', 'echo "B1"'), 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'english']);
    const head = git(dir, ['rev-parse', '--short', 'HEAD']);

    // Only fence 1 diverges; fence 2 already equals the basis, so after the repair the whole
    // file mirrors that one revision and the claim is true.
    const mirror = join(dir, 'i18n', 'de', 'skills', 'demo-skill', 'SKILL.md');
    mkdirSync(dirname(mirror), { recursive: true });
    writeFileSync(mirror, translated(head, 'echo "LOKALISIERT"', 'echo "B1"'), 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'de mirror']);

    const r = run(dir, ['--write']);
    assert.equal(r.status, 0, `normalizer failed:\n${r.stdout}\n${r.stderr}`);

    const after = readFileSync(mirror, 'utf8');
    assert.ok(after.includes('echo "A1"'), 'repaired from the basis');
    assert.equal(field(after, 'fence_basis_commit'), head,
      'a file that fully mirrors its basis should carry the claim');
  });
});
