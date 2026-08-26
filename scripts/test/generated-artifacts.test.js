/**
 * Unit tests for `scripts/check-generated-artifacts.js` (#590).
 *
 * The envelope (`scripts/envelopes/generated-artifacts.mjs`) proves the gate goes red against the
 * REAL corpus, 6 killed of 7 cases. These cover what the envelope structurally cannot reach: the
 * REFUSAL paths.
 *
 * Refusals matter more than findings here. Every comparison this checker makes has an empty-set
 * mode in which it would report a clean run having measured nothing — an inventory with no rows,
 * a sweep that discovered no generators, a checkout git cannot enumerate. Each of those must exit
 * 2, never 0, and a test is the only thing that can demonstrate it: an envelope case mutates the
 * corpus and reads the gate's red, so it cannot distinguish "found a problem" from "refused".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-generated-artifacts.js');

const CLEAN_INVENTORY = `version: 1
artifacts:
  - id: thing
    paths: [out/thing.txt]
    generator: gen/build-thing.js
    gate:
      kind: regenerate-and-diff
      command: npm run check-thing
      where: package.json
`;

/** A throwaway git repo with enough tracked files to clear the anti-vacuity floor. */
function fixture(t, { inventory = CLEAN_INVENTORY, files = {}, trackedCount = 120 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, 'gen'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  mkdirSync(join(dir, 'viz'), { recursive: true });
  mkdirSync(join(dir, 'filler'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });

  writeFileSync(join(dir, 'gen', 'build-thing.js'), '// generator\n');
  writeFileSync(join(dir, 'out', 'thing.txt'), 'output\n');
  // build.sh must EXIST (its absence is a refusal, tested below) but need not invoke anything:
  // the fixture's single generator is reachable from source 1 instead, so the sweep has one
  // member and no refusal fires. An earlier version had it run `node build-data.js`, which the
  // sweep correctly reported as unlisted — a fixture bug that read as a gate defect.
  writeFileSync(join(dir, 'viz', 'build.sh'), '#!/usr/bin/env bash\necho "no generators here"\n');
  // Source 3 needs a workflow that commits output back; its absence is a refusal, tested below.
  // This one runs the fixture's generator so the sweep has a member from source 3 too.
  writeFileSync(join(dir, '.github', 'workflows', 'heal.yml'),
    'name: heal\njobs:\n  h:\n    steps:\n'
    + '      - run: npm run build-thing\n'
    + '      - uses: stefanzweifel/git-auto-commit-action@v6\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    scripts: {
      'check-thing': 'node gen/build-thing.js --check',
      'build-thing': 'node gen/build-thing.js',
    },
  }, null, 2));
  if (inventory !== null) writeFileSync(join(dir, 'generated-artifacts.yml'), inventory);

  // The floor is 100 tracked files; clear it so a refusal in a test is about the thing under
  // test rather than about the fixture being small.
  for (let i = 0; i < trackedCount; i += 1) {
    writeFileSync(join(dir, 'filler', `f${i}.txt`), `${i}\n`);
  }
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }

  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  return dir;
}

function run(dir) {
  try {
    return { status: 0, output: execFileSync('node', [CHECK, '--root', dir], { encoding: 'utf8' }) };
  } catch (error) {
    return { status: error.status, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

test('a consistent inventory passes', (t) => {
  const { status, output } = run(fixture(t));
  assert.equal(status, 0, output);
  assert.match(output, /1 artifact class/);
});

test('REFUSES when the inventory is missing, rather than reporting nothing to check', (t) => {
  const { status, output } = run(fixture(t, { inventory: null }));
  assert.equal(status, 2, output);
  assert.match(output, /no inventory at/);
});

test('REFUSES an inventory with an empty artifacts list', (t) => {
  // The purest vacuous pass: zero rows, zero findings, exit 0 — a green run over nothing.
  const { status, output } = run(fixture(t, { inventory: 'version: 1\nartifacts: []\n' }));
  assert.equal(status, 2, output);
  assert.match(output, /declares no `artifacts`/);
});

test('REFUSES a checkout too small to be the real one', (t) => {
  // Guards the case where `git ls-files` returns almost nothing, under which every path pattern
  // would "match no tracked file" and the check would emit a wall of confident, wrong findings.
  //
  // What it actually catches is a wrong `--root` pointed at a small repo. An earlier version of
  // this comment also claimed shallow and partial clones; an adversarial review corrected it —
  // both keep a FULL index, so `git ls-files` counts are unaffected and the floor cannot see
  // them. (A sparse checkout is a related residual: the file COUNT is fine, so the floor passes,
  // while `existsSync(generator)` yields a confident wrong "generator does not exist". CI is
  // always a full checkout, so this is a local-run hazard rather than a CI one.)
  const { status, output } = run(fixture(t, { trackedCount: 3 }));
  assert.equal(status, 2, output);
  assert.match(output, /not a full checkout/);
});

test('REFUSES when viz/build.sh is absent, because a sweep missing a source is not a sweep', (t) => {
  // `viz/build.sh` is source 2 of the reverse sweep, and it is the ONLY place two real
  // generators are reachable from. If it disappears the sweep still finds npm-script
  // generators and would report a clean result it did not earn.
  const dir = fixture(t);
  rmSync(join(dir, 'viz', 'build.sh'));
  const { status, output } = run(dir);
  assert.equal(status, 2, output);
  assert.match(output, /viz\/build\.sh not found/);
});

test('an exemption must NOT swallow a different generator whose path it contains', (t) => {
  // The bug an adversarial review found in the first version, and reproduced: exemptions were
  // matched with `blob.includes(generator)` over a concatenation of every exemption's id and
  // command. An exemption reading `node legacy/gen/build-thing.js` therefore exempted the
  // DISCOVERED `gen/build-thing.js` by suffix containment — the #672 substring class, reintroduced
  // in the PR that removed it from three other call sites.
  //
  // The names here COLLIDE on purpose. The test that previously claimed this property used two
  // paths with no substring relation, so it could not have failed on the bug it named. A test
  // whose fixture cannot express the defect is a green light of unknown wiring.
  const dir = fixture(t, {
    inventory: `version: 1
artifacts:
  - id: unrelated
    paths: [out/thing.txt]
    generator: gen/other-generator.js
    gate:
      kind: none
    unread_edge: not the subject of this test
generators_without_committed_output:
  - id: containment
    command: node legacy/gen/build-thing.js
    generator: legacy/gen/build-thing.js
    reason: a DIFFERENT generator whose path CONTAINS the discovered one
`,
    files: { 'gen/other-generator.js': '// present so the row resolves\n' },
  });
  const { status, output } = run(dir);
  assert.equal(status, 1, output);
  assert.match(
    output,
    /UNLISTED GENERATOR: gen\/build-thing\.js/,
    'the discovered generator must still be reported — an exemption for '
    + 'legacy/gen/build-thing.js names a different file',
  );
});

test('an exemption satisfies the reverse sweep, and only for the generator it names', (t) => {
  const withUnlisted = fixture(t, {
    inventory: `${CLEAN_INVENTORY}generators_without_committed_output:
  - id: exempted
    command: node gen/build-scratch.js
    reason: writes to a temp directory
`,
    files: {
      'package.json': JSON.stringify({
        scripts: {
          'check-thing': 'node gen/build-thing.js --check',
          'build-thing': 'node gen/build-thing.js',
          'build-scratch': 'node gen/build-scratch.js',
          'build-unexempted': 'node gen/build-other.js',
        },
      }, null, 2),
    },
  });
  const { status, output } = run(withUnlisted);
  assert.equal(status, 1, output);
  assert.match(output, /UNLISTED GENERATOR: gen\/build-other\.js/);
  assert.doesNotMatch(output, /gen\/build-scratch\.js/, 'the exempted generator must not be reported');
});

test('REFUSES when no workflow commits output back, because source 3 found nothing', (t) => {
  // Symmetric with the build.sh refusal. If the committing-workflow detector stops matching —
  // the action gets renamed, the healer moves — the sweep silently loses a source and would
  // report a clean result over a corpus it did not fully read.
  const dir = fixture(t);
  rmSync(join(dir, '.github', 'workflows', 'heal.yml'));
  const { status, output } = run(dir);
  assert.equal(status, 2, output);
  assert.match(output, /source 3 found nothing/);
});

test('--root without a value is refused rather than silently defaulting', (t) => {
  // Defaulting here would run the check against the REPO while a caller believed it was pointed
  // at a fixture — a green result about the wrong tree.
  void t;
  try {
    execFileSync('node', [CHECK, '--root'], { encoding: 'utf8' });
    assert.fail('expected a non-zero exit');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(`${error.stdout || ''}${error.stderr || ''}`, /--root requires a directory/);
  }
});
