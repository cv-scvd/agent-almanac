/**
 * The publish gate cannot diverge from the suite it is supposed to run (#697).
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * **Fixture tests** drive `inspectPublishGate` with hand-written script maps. They pin
 * the rule, and they are what a mutation of the rule kills. They are the only way to
 * exercise the failure branches at all — the repository is, by construction, in the
 * passing state.
 *
 * **One live test** runs the rule against this repository's real `package.json` and real
 * `cli/test/` directory. Without it every fixture could pass while the actual gate is
 * broken; with it, re-inlining the path in `prepublishOnly` goes red in CI.
 * `ci-scripts.yml` carries no `paths:` filter (#641), so it sees a `package.json`-only
 * change. A gate filtered on `scripts/**` would not, and this test would be decorative.
 *
 * The live test is what makes the mutation envelope honest:
 *
 *     npm run mutation-check -- \
 *       --file package.json \
 *       --replace '"prepublishOnly": "npm run test:cli"'::'"prepublishOnly": "node --test cli/test/cli.test.js"' \
 *       --test 'npm run test:scripts' \
 *       --expect-killed-by 1
 *
 * That mutant is the exact prior state of the file, it parses, it runs to completion, and
 * it dies to one test. Not a crash, not a broad kill — the shape `mutation-check` reports
 * as SUSPECT and CLAUDE.md warns is inverted evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectPublishGate,
  namedTestFiles,
  discoverTestFiles,
  CANONICAL_SCRIPT,
  PUBLISH_HOOK,
  PRE_HOOK,
  CLI_TEST_DIR,
} from '../lib/publish-gate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A script map matching the repository's intended arrangement. */
function healthyScripts() {
  return {
    test: 'npm run validate:integrity && npm run check-readmes && npm run test:scripts && npm run test:cli',
    'test:cli': 'node --test cli/test/cli.test.js',
    'pretest:cli': 'node scripts/assert-publish-gate.js',
    prepublishOnly: 'npm run test:cli',
  };
}

/** Only `problems` entries mentioning `needle`, to keep assertions specific. */
function problemsMatching(scripts, needle) {
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  return problems.filter((p) => p.includes(needle));
}

test('the fixture standing in for a healthy repo produces no problems', () => {
  const { problems } = inspectPublishGate(REPO_ROOT, healthyScripts());
  assert.deepEqual(problems, [], `expected a clean fixture, got:\n${problems.join('\n')}`);
});

test('THE LIVE GATE: this repository\'s own package.json wires the publish gate safely', () => {
  const { problems } = inspectPublishGate(REPO_ROOT);
  assert.deepEqual(
    problems,
    [],
    'package.json no longer wires the publish gate safely:\n' + problems.join('\n'),
  );
});

test('two scripts spelling the suite path is the #697 defect, and is rejected', () => {
  const scripts = healthyScripts();
  // The exact pre-#697 state: prepublishOnly spelled the path a second time.
  scripts[PUBLISH_HOOK] = 'node --test cli/test/cli.test.js';
  const problems = problemsMatching(scripts, '#697');
  assert.ok(
    problems.length > 0,
    `a second literal spelling of the suite path must be rejected; problems were:\n${
      inspectPublishGate(REPO_ROOT, scripts).problems.join('\n')}`,
  );
});

test('a third script naming the path is rejected too, not just prepublishOnly', () => {
  const scripts = healthyScripts();
  scripts['test:cli:watch'] = 'node --test --watch cli/test/cli.test.js';
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('2 scripts name a suite')),
    `expected the duplicate-naming problem, got:\n${problems.join('\n')}`,
  );
});

test('removing prepublishOnly is rejected — the redundancy is deliberate (#680)', () => {
  const scripts = healthyScripts();
  delete scripts[PUBLISH_HOOK];
  const problems = problemsMatching(scripts, '#680');
  assert.equal(problems.length, 1, 'losing the publish hook must be reported, citing #680');
});

test('a prepublishOnly that reaches nothing is rejected', () => {
  const scripts = healthyScripts();
  scripts[PUBLISH_HOOK] = 'echo "trust me"';
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('does not reach')),
    `expected a "does not reach" problem, got:\n${problems.join('\n')}`,
  );
});

test('npm test dropping the CLI suite is rejected — that was #680 itself', () => {
  const scripts = healthyScripts();
  scripts.test = 'npm run validate:integrity && npm run check-readmes';
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('is the release gate')),
    `expected the release-gate problem, got:\n${problems.join('\n')}`,
  );
});

test('deleting the pretest:cli hook is rejected — the gate must not be silently disarmable', () => {
  // This branch exists because mutating package.json found it: with the rule module
  // intact, dropping one line from package.json removed the publish-time check and
  // every test still passed. Same disarm shape as the defect #697 describes.
  const scripts = healthyScripts();
  delete scripts[PRE_HOOK];
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('exists only in CI')),
    `expected the disarmed-hook problem, got:\n${problems.join('\n')}`,
  );
});

test('a pretest:cli that runs something else is rejected', () => {
  const scripts = healthyScripts();
  scripts[PRE_HOOK] = 'echo "checked, honest"';
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('at publish time')),
    `expected a wrong-checker problem, got:\n${problems.join('\n')}`,
  );
});

test('a named suite file that does not exist is rejected', () => {
  const scripts = healthyScripts();
  scripts[CANONICAL_SCRIPT] = 'node --test cli/test/renamed.test.js';
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('resolves to nothing')),
    `expected a "resolves to nothing" problem, got:\n${problems.join('\n')}`,
  );
});

test('a test file nobody names is rejected — the silence naming buys (#486)', () => {
  // Simulate the discovered set gaining a file by naming a strict subset of it: the
  // real directory is the discovered set, and the fixture names only part of it.
  const discovered = discoverTestFiles(REPO_ROOT);
  assert.ok(discovered.length >= 1, 'this test needs at least one real CLI test file');

  const scripts = healthyScripts();
  scripts[CANONICAL_SCRIPT] = 'node --test';   // names none of them
  const { problems } = inspectPublishGate(REPO_ROOT, scripts);
  assert.ok(
    problems.some((p) => p.includes('but no script names it')),
    `expected an unrun-file problem, got:\n${problems.join('\n')}`,
  );
});

test('namedTestFiles reads paths out of a command line, quotes and all', () => {
  assert.deepEqual(namedTestFiles('node --test cli/test/cli.test.js'), ['cli/test/cli.test.js']);
  assert.deepEqual(namedTestFiles('node --test "cli/test/cli.test.js"'), ['cli/test/cli.test.js']);
  assert.deepEqual(
    namedTestFiles('node --test cli/test/a.test.js cli/test/b.test.js'),
    ['cli/test/a.test.js', 'cli/test/b.test.js'],
  );
  assert.deepEqual(namedTestFiles('npm run test:cli'), []);
  assert.deepEqual(namedTestFiles(undefined), []);
});

test(`discoverTestFiles reports every *.test.js under ${CLI_TEST_DIR}/`, () => {
  const discovered = discoverTestFiles(REPO_ROOT);
  assert.ok(Array.isArray(discovered), `${CLI_TEST_DIR}/ must exist`);
  assert.ok(discovered.length >= 1, `${CLI_TEST_DIR}/ must hold at least one test file`);
  for (const file of discovered) {
    assert.ok(file.startsWith(`${CLI_TEST_DIR}/`), `unexpected path shape: ${file}`);
    assert.ok(file.endsWith('.test.js'), `unexpected suffix: ${file}`);
  }
});
