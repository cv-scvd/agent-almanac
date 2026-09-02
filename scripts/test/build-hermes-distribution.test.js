/**
 * Tests for `scripts/build-hermes-distribution.js` (companion #78).
 *
 * One synthetic almanac per test, each gate broken exactly once, and the clean tree pinned by
 * its exact output set — because a gate that has never been seen red is a gate whose colour
 * means nothing (CLAUDE.md § Proving a Gate Can Fail). The real tree is exercised by
 * `npm run check:hermes-distribution` in CI; these cover the decisions underneath on trees small
 * enough to reason about.
 *
 * Every case drives the script as a subprocess through `--root`, so the exit-code contract
 * (0 clean / 1 finding / 2 cannot build) is what is asserted, not an internal return value.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build-hermes-distribution.js');

const {
  USER_OWNED_EXCLUDE, EXCLUDED_SKILL_DIRS, BANNED_LITERALS, OWNED_ROOT_ENTRIES, HERMES_REQUIRES,
} = await import(SCRIPT);

/** Write a minimal almanac: two skills, one with a references/ file. Returns its root. */
function fixture({ ids = ['alpha', 'beta'], total = null, version = '1.2.3', soul = '# Soul\n\nText.\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-dist-fixture-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'agent-almanac', version, author: 'A. Author', license: 'MIT' }));
  writeFileSync(join(root, 'SOUL.md'), soul);
  writeFileSync(join(root, 'LICENSE'), 'MIT License\n');
  mkdirSync(join(root, 'agents'));
  mkdirSync(join(root, 'teams'));
  writeFileSync(join(root, 'agents', '_registry.yml'), 'total_agents: 2\nagents: []\n');
  writeFileSync(join(root, 'teams', '_registry.yml'), 'total_teams: 1\nteams: []\n');
  mkdirSync(join(root, 'skills'));
  const registry = {
    total_skills: total ?? ids.length,
    domains: { general: { description: 'd', skills: ids.map((id) => ({ id, path: `${id}/SKILL.md`, complexity: 'basic' })) } },
  };
  writeFileSync(join(root, 'skills', '_registry.yml'), yaml.dump(registry));
  for (const id of ids) {
    mkdirSync(join(root, 'skills', id), { recursive: true });
    writeFileSync(join(root, 'skills', id, 'SKILL.md'), `---\nname: ${id}\n---\n# ${id}\n`);
  }
  if (ids.includes('beta')) {
    mkdirSync(join(root, 'skills', 'beta', 'references'));
    writeFileSync(join(root, 'skills', 'beta', 'references', 'notes.md'), 'notes\n');
  }
  // Scaffolding that lives inside skills/ in the real repository and must never be emitted.
  mkdirSync(join(root, 'skills', '_template'));
  writeFileSync(join(root, 'skills', '_template', 'SKILL.md'), '# template\n');
  return root;
}

function run(root, args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', ...args], { encoding: 'utf8' });
  let summary = null;
  try { summary = JSON.parse(r.stdout); } catch { /* exit 2 prints no JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary };
}

const gates = (summary) => [...new Set(summary.findings.map((f) => f.gate))].sort();

test('clean tree: exit 0, exact root set, one directory per registry id, _template never emitted', () => {
  const root = fixture();
  const out = join(root, 'out');
  try {
    const r = run(root, ['--out', out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.summary.findings, []);
    assert.deepEqual(readdirSync(out).sort(), [...OWNED_ROOT_ENTRIES].sort());
    assert.deepEqual(readdirSync(join(out, 'skills')).sort(), ['alpha', 'beta']);
    assert.ok(existsSync(join(out, 'skills', 'beta', 'references', 'notes.md')), 'support files travel with the skill');
    assert.equal(readFileSync(join(out, 'SOUL.md'), 'utf8'), readFileSync(join(root, 'SOUL.md'), 'utf8'));
    assert.equal(r.summary.measured.skillMdCount, 2);
    assert.equal(r.summary.measured.filesScanned, 2 + 1 + 4, 'two SKILL.md, notes.md, and the four root files');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('manifest: Hermes key order, version mirrors package.json, no env_requires, no distribution_owned', () => {
  const root = fixture({ version: '9.8.7' });
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    const text = readFileSync(join(out, 'distribution.yaml'), 'utf8');
    const m = yaml.load(text);
    assert.deepEqual(Object.keys(m), ['name', 'version', 'description', 'hermes_requires', 'author', 'license'],
      'the key order Hermes to_dict() emits, and nothing more');
    assert.equal(m.name, 'agent-almanac');
    assert.equal(m.version, '9.8.7');
    assert.equal(m.hermes_requires, HERMES_REQUIRES);
    assert.match(m.description, /\b2 skills\b/);
    assert.match(m.description, /\b2 agents\b/);
    assert.match(m.description, /\b1 teams\b/);
    assert.ok(!('env_requires' in m));
    assert.ok(!('distribution_owned' in m));
    assert.match(text, /^# Generated by scripts\/build-hermes-distribution\.js/, 'the file says what wrote it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deterministic: two builds of the same tree are byte-identical, and --check --against agrees', () => {
  const root = fixture();
  const a = join(root, 'a');
  const b = join(root, 'b');
  try {
    assert.equal(run(root, ['--out', a]).status, 0);
    assert.equal(run(root, ['--out', b]).status, 0);
    for (const rel of ['distribution.yaml', 'README.md', 'SOUL.md', 'LICENSE', 'skills/alpha/SKILL.md']) {
      assert.ok(readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))), `${rel} differs between builds`);
    }
    const r = run(root, ['--check', '--against', a]);
    assert.equal(r.status, 0, r.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check --against: an edited, an extra and a missing file in the checkout are each drift', () => {
  const root = fixture();
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    writeFileSync(join(out, 'skills', 'alpha', 'SKILL.md'), 'hand edit\n');
    writeFileSync(join(out, 'skills', 'alpha', 'extra.md'), 'extra\n');
    rmSync(join(out, 'skills', 'beta', 'references', 'notes.md'));
    const r = run(root, ['--check', '--against', out]);
    assert.equal(r.status, 1);
    const drift = r.summary.findings.filter((f) => f.gate === 'drift').map((f) => `${f.path}: ${f.detail}`).sort();
    assert.deepEqual(drift, [
      'skills/alpha/SKILL.md: content differs',
      'skills/alpha/extra.md: present in the checkout but not generated',
      'skills/beta/references/notes.md: missing from the checkout',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--out: regenerates in place over its own entries (and .git), refuses a foreign entry with exit 2', () => {
  const root = fixture();
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    mkdirSync(join(out, '.git'));
    writeFileSync(join(out, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(out, 'skills', 'alpha', 'SKILL.md'), 'stale\n');
    const again = run(root, ['--out', out]);
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual(readFileSync(join(out, 'skills', 'alpha', 'SKILL.md'), 'utf8'), 'stale\n', 'owned entries are replaced');
    assert.ok(existsSync(join(out, '.git', 'HEAD')), '.git is left alone');

    writeFileSync(join(out, 'stray.txt'), 'not mine\n');
    const refused = run(root, ['--out', out]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /does not own: stray\.txt/);
    assert.ok(existsSync(join(out, 'stray.txt')), 'nothing was deleted');
    assert.ok(existsSync(join(out, 'distribution.yaml')), 'and nothing owned was deleted either');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user-owned: a nested directory named in USER_OWNED_EXCLUDE is a finding at any depth', () => {
  const root = fixture();
  try {
    assert.ok(USER_OWNED_EXCLUDE.includes('cache') && USER_OWNED_EXCLUDE.includes('bin'), 'the two names the issue leads with');
    assert.equal(USER_OWNED_EXCLUDE.length, 37, 'the 37-name denylist the companion measured');
    mkdirSync(join(root, 'skills', 'beta', 'references', 'cache'), { recursive: true });
    writeFileSync(join(root, 'skills', 'beta', 'references', 'cache', 'x.md'), 'x\n');
    const r = run(root, ['--check']);
    assert.equal(r.status, 1);
    assert.deepEqual(gates(r.summary), ['user-owned']);
    assert.ok(r.summary.findings.some((f) => f.path === 'skills/beta/references/cache' && /'cache'/.test(f.detail)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hermes-excluded: a node_modules component is a finding', () => {
  const root = fixture();
  try {
    // `site-packages`: in EXCLUDED_SKILL_DIRS, not in USER_OWNED_EXCLUDE, not dot- or
    // underscore-prefixed — so it exercises this gate alone. (`node_modules` sits in both Hermes
    // sets and `__pycache__` also trips `hidden`; either would report two gates for one path.)
    assert.ok(EXCLUDED_SKILL_DIRS.includes('site-packages') && !USER_OWNED_EXCLUDE.includes('site-packages'));
    mkdirSync(join(root, 'skills', 'alpha', 'vendor', 'site-packages'), { recursive: true });
    writeFileSync(join(root, 'skills', 'alpha', 'vendor', 'site-packages', 'm.py'), 'x');
    const r = run(root, ['--check']);
    assert.equal(r.status, 1);
    assert.deepEqual(gates(r.summary), ['hermes-excluded']);
    assert.equal(r.summary.findings.length, 2, 'the directory and the file beneath it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hidden: an underscore-prefixed and a dot-prefixed component are each a finding', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'skills', 'alpha', '_private'));
    writeFileSync(join(root, 'skills', 'alpha', '_private', 'x.md'), 'x\n');
    writeFileSync(join(root, 'skills', 'beta', '.hidden'), 'x\n');
    const r = run(root, ['--check']);
    assert.equal(r.status, 1);
    assert.deepEqual(gates(r.summary), ['hidden']);
    assert.deepEqual(r.summary.findings.map((f) => f.path).sort(), ['skills/alpha/_private', 'skills/alpha/_private/x.md', 'skills/beta/.hidden']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlink: a symlink in a skill is reported and never copied', () => {
  const root = fixture();
  const out = join(root, 'out');
  try {
    symlinkSync('SKILL.md', join(root, 'skills', 'alpha', 'link.md'));
    const r = run(root, ['--out', out]);
    assert.equal(r.status, 1);
    assert.deepEqual(gates(r.summary), ['symlink']);
    assert.equal(r.summary.findings[0].path, 'skills/alpha/link.md');
    assert.ok(!existsSync(join(out, 'skills', 'alpha', 'link.md')), 'not dereferenced into a copy either');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('skill-shape + count: a SKILL.md preserved under references/ inflates the count and is a finding', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'skills', 'beta', 'references', 'SKILL.md'), '# preserved package\n');
    const r = run(root, ['--check']);
    assert.equal(r.status, 1);
    assert.deepEqual(gates(r.summary), ['count', 'skill-shape']);
    assert.equal(r.summary.measured.skillMdCount, 3, 'what v0.13.0 _count_skills would report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cannot build (exit 2): a registry id with no directory, and a total_skills the entries contradict', () => {
  const missing = fixture({ ids: ['alpha', 'beta', 'gamma'] });
  rmSync(join(missing, 'skills', 'gamma'), { recursive: true });
  const contradicted = fixture({ total: 5 });
  try {
    const r1 = run(missing, ['--check']);
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /'gamma' names skills\/gamma\/SKILL\.md, which does not exist/);
    const r2 = run(contradicted, ['--check']);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /total_skills says 5 but 2 entries/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(contradicted, { recursive: true, force: true });
  }
});

test('banned-literal: each literal fires in a skill file, and the emitted README and manifest pass', () => {
  for (const lit of BANNED_LITERALS) {
    const root = fixture();
    try {
      writeFileSync(join(root, 'skills', 'beta', 'references', 'notes.md'), `see ${lit} for details\n`);
      const r = run(root, ['--check']);
      assert.equal(r.status, 1, `'${lit}' did not fire`);
      assert.deepEqual(gates(r.summary), ['banned-literal']);
      assert.deepEqual(r.summary.findings.map((f) => f.path), ['skills/beta/references/notes.md']);
      assert.ok(r.summary.findings[0].detail.includes(lit));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  // The trap named in the header: `almanac@` is a substring of the npm spelling. The README this
  // script writes must therefore never spell name@version — pinned here as a positive/negative pair.
  assert.ok('agent-almanac@1.9.1'.includes('almanac@'), 'the literal would catch the npm spelling');
  const root = fixture();
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    const readme = readFileSync(join(out, 'README.md'), 'latin1');
    for (const lit of BANNED_LITERALS) assert.ok(!readme.includes(lit), `README contains '${lit}'`);
    assert.match(readme, /No ref pinning/, 'the README states the no-pinning rule');
    assert.match(readme, /hermes profile install github\.com\/pjt222\/agent-almanac-hermes-profile/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('soul: a SOUL.md that differs from the source is a finding even when everything else is clean', () => {
  // Reached through the drift path: regenerate, then tamper with the emitted copy and re-check
  // the tampered tree as a checkout. The gate itself re-reads bytes, so this pins the comparison.
  const root = fixture();
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    writeFileSync(join(out, 'SOUL.md'), 'edited\n');
    const r = run(root, ['--check', '--against', out]);
    assert.equal(r.status, 1);
    assert.deepEqual(r.summary.findings.map((f) => `${f.gate}:${f.path}`), ['drift:SOUL.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('--check --against: a symlink in the checkout is drift even when its target has the right bytes', () => {
  const root = fixture();
  const out = join(root, 'out');
  try {
    assert.equal(run(root, ['--out', out]).status, 0);
    const target = join(out, 'skills', 'alpha', 'SKILL.md');
    const bytes = readFileSync(target);
    writeFileSync(join(root, 'elsewhere.md'), bytes);
    rmSync(target);
    symlinkSync(join(root, 'elsewhere.md'), target);
    const r = run(root, ['--check', '--against', out]);
    assert.equal(r.status, 1);
    assert.deepEqual(r.summary.findings.map((f) => `${f.gate}:${f.path}:${f.detail}`), ['drift:skills/alpha/SKILL.md:symlink in the checkout']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkOutput re-reads the tree it is given: each manifest field, the root set and SOUL.md are gated on disk', async () => {
  // Through the module API, because the CLI can only ever produce a manifest that agrees with
  // its inputs — these gates exist for a FUTURE edit to the writer, and are otherwise unreachable.
  const { loadInputs, emit, checkOutput } = await import(SCRIPT);
  const tamper = (mutate, expectedPaths) => {
    const root = fixture();
    const out = join(root, 'out');
    try {
      const inputs = loadInputs(root);
      mkdirSync(out);
      assert.deepEqual(emit(inputs, out), []);
      assert.deepEqual(checkOutput(out, inputs).findings, [], 'clean before tampering');
      mutate(out);
      const paths = checkOutput(out, inputs).findings.map((f) => `${f.gate}:${f.path}`).sort();
      assert.deepEqual(paths, expectedPaths.sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const rewriteManifest = (out, change) => {
    const m = yaml.load(readFileSync(join(out, 'distribution.yaml'), 'utf8'));
    change(m);
    writeFileSync(join(out, 'distribution.yaml'), yaml.dump(m, { sortKeys: false }));
  };
  tamper((out) => rewriteManifest(out, (m) => { m.version = '0.0.0'; }), ['manifest:distribution.yaml:version']);
  tamper((out) => rewriteManifest(out, (m) => { m.name = 'Agent Almanac'; }),
    ['manifest:distribution.yaml:name', 'manifest:distribution.yaml:name']); // not the expected name, and not a valid Hermes id
  tamper((out) => rewriteManifest(out, (m) => { m.name = 'test'; }),
    ['manifest:distribution.yaml:name', 'manifest:distribution.yaml:name']); // not the expected name, and reserved by Hermes
  tamper((out) => rewriteManifest(out, (m) => { m.env_requires = [{ name: 'X' }]; }),
    ['manifest:distribution.yaml:env_requires', 'manifest:distribution.yaml:env_requires']); // present, and not an allowed key
  tamper((out) => rewriteManifest(out, (m) => { m.distribution_owned = ['skills']; }),
    ['manifest:distribution.yaml:distribution_owned', 'manifest:distribution.yaml:distribution_owned']);
  tamper((out) => rewriteManifest(out, (m) => { m.hermes_requires = '>=0.1.0'; }), ['manifest:distribution.yaml:hermes_requires']);
  tamper((out) => rewriteManifest(out, (m) => { m.description = 'no count here'; }), ['manifest:distribution.yaml:description']);
  // A YAML sequence is an object to `typeof`; it must be reported as not-a-mapping, not walked as keys.
  tamper((out) => writeFileSync(join(out, 'distribution.yaml'), '- not\n- a mapping\n'), ['manifest:distribution.yaml']);
  tamper((out) => writeFileSync(join(out, 'distribution.yaml'), 'name: [unclosed\n'), ['manifest:distribution.yaml']);
  tamper((out) => writeFileSync(join(out, 'SOUL.md'), 'edited\n'), ['soul:SOUL.md']);
  tamper((out) => writeFileSync(join(out, 'stray.txt'), 'x\n'), ['root-set:stray.txt']);
  tamper((out) => rmSync(join(out, 'LICENSE')), ['root-set:LICENSE']);
  tamper((out) => rmSync(join(out, 'skills', 'alpha', 'SKILL.md')), ['skill-shape:skills/alpha/SKILL.md', 'count:skills']);
  tamper((out) => { mkdirSync(join(out, 'skills', 'gamma')); writeFileSync(join(out, 'skills', 'gamma', 'SKILL.md'), 'x\n'); },
    ['count:skills/gamma', 'count:skills']);
});

test('usage: unknown flag, both modes, neither mode, --against without --check, missing --against dir all exit 2', () => {
  const root = fixture();
  try {
    for (const args of [['--bogus'], ['--out', join(root, 'o'), '--check'], [], ['--against', root], ['--check', '--against', join(root, 'nope')]]) {
      const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
