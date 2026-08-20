/**
 * Unit tests for `scripts/lib/mutation-verdict.js` (#621).
 *
 * The end-to-end proof is in the PR: the exact deletion from the issue now reports SUSPECT where
 * it used to report `MUTANT KILLED by 15 failing test(s)`. These cover the decision itself, and
 * in particular the two properties that make the signal trustworthy rather than merely present:
 * a crash signature is never waived, and an ordinary assertion failure is never flagged.
 *
 * A false SUSPECT is the direction that gets a check switched off, so the negative cases here
 * matter as much as the positive ones.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  crashSuspicion,
  parseFailCount,
  parsePassCount,
  BROAD_KILL_SHARE,
  MIN_BASELINE_FOR_SHARE,
  CRASH_SIGNATURES,
} from '../lib/mutation-verdict.js';

// A normal node:test failure: a diff, no runtime error.
const ASSERTION_FAILURE = `
✖ label capitalises the first letter (1.2ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'workflow'
  - 'Workflow'
ℹ tests 15
ℹ pass 13
ℹ fail 2
`;

// The #621 shape: the module throws before any assertion runs.
const REFERENCE_ERROR = `
✖ normalize writes the repaired text (2.0ms)
  ReferenceError: stamped is not defined
      at repairFile (file:///repo/scripts/normalize-i18n-fences.js:585:9)
ℹ tests 490
ℹ pass 475
ℹ fail 15
`;

test('an ordinary assertion failure is NOT suspect', () => {
  // The case that must stay silent. Flagging this would make every honest kill noisy, and a
  // noisy check gets ignored — which costs more than the blind spot it was added to close.
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 2, 15), []);
});

// NAME CAREFULLY. node:test prints every test name, passing or failing, so a name containing
// crash text lands in the transcript of every future `mutation-check --test 'npm run
// test:scripts'` run and trips the signature scan on kills that have nothing to do with it.
// This one was called 'a ReferenceError is suspect …' and would have done exactly that.
test('a runtime crash is suspect however few tests failed', () => {
  const reasons = crashSuspicion(REFERENCE_ERROR, 15, 490);
  assert.equal(reasons.length, 1, 'the share signal must not also fire at 15/490');
  assert.match(reasons[0], /runtime error/);
});

test('a broad failure is suspect without any runtime error', () => {
  // Measured shape: returning `[]` from `guideCategoryOrder` fails 13 of 15 and prints no
  // runtime error at all. The two signals are independent, and each must be able to fire alone —
  // otherwise one of them is decoration.
  // Counts are parameters, not parsed from the fixture — an earlier `.replace('fail 2', …)` here
  // was doing nothing and reading as though it set up the case.
  const reasons = crashSuspicion(ASSERTION_FAILURE, 13, 15);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /13 test\(s\) failed against a baseline of 15 passing \(87%\)/);
});

test('--allow-broad waives the share signal', () => {
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 13, 15, true), []);
});

test('the share threshold is a boundary, not a range', () => {
  const output = ASSERTION_FAILURE;
  const justUnder = Math.floor(BROAD_KILL_SHARE * 100) - 1;
  assert.deepEqual(crashSuspicion(output, justUnder, 100), [], `${justUnder}/100 must not fire`);
  assert.equal(crashSuspicion(output, Math.ceil(BROAD_KILL_SHARE * 100), 100).length, 1);
});

test('an unparseable count disables the share signal rather than guessing', () => {
  // `null` means "the output format was not recognised". Treating that as 0, or as the whole
  // suite, would invent a verdict out of a parse failure — the vacuous-pass shape this repo
  // keeps finding. Silence is the honest answer; the crash signature still applies.
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, null, 15), []);
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 13, null), []);
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 13, 0), []);
  assert.equal(crashSuspicion(REFERENCE_ERROR, null, null).length, 1, 'crashes still flagged');
});

test('every crash signature is reachable from a realistic message', () => {
  // Guards against a pattern that can never match — an entry in a deny list that fires on
  // nothing is indistinguishable from an absent one, and reads as coverage it does not provide.
  const samples = [
    'ReferenceError: x is not defined',
    "TypeError: fn is not a function",
    "ReferenceError: Cannot access 'x' before initialization",
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find module',
    'Cannot find package \'js-yaml\'',
    'ReferenceError: helper is not defined',
  ];
  for (const pattern of CRASH_SIGNATURES) {
    assert.ok(
      samples.some((sample) => pattern.test(sample)),
      `no sample matches ${pattern} — is it reachable?`
    );
  }
});

test('parseFailCount and parsePassCount read node:test summaries', () => {
  assert.equal(parseFailCount(ASSERTION_FAILURE), 2);
  assert.equal(parsePassCount(ASSERTION_FAILURE), 13);
  assert.equal(parseFailCount('no summary here'), null);
  assert.equal(parsePassCount('no summary here'), null);
  assert.equal(parseFailCount(undefined), null);
});

// ── the false SUSPECT that self-review caught (#621) ────────────────────────

// A LEGITIMATE behavioural kill whose assertion message embeds crash text. Real output,
// captured from `scripts/test/dependency-free.test.js` after adding a package import to
// `readme-sections.js` — one failing test, the exact one written for that property.
const ASSERTION_EMBEDDING_CRASH_TEXT = `
✖ failing tests:

test at scripts/test/dependency-free.test.js:86:1
✖ readme-sections.js keeps the zero-import property it claims (358.098293ms)
  AssertionError [ERR_ASSERTION]: readme-sections.js acquired a package dependency:
  node:internal/modules/package_json_reader:301
    throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);

  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from /tmp/x/readme-sections.js
      at Object.getPackageJSONURL (node:internal/modules/package_json_reader:301:9)
ℹ tests 8
ℹ pass 7
ℹ fail 1
`;

test('a kill whose assertion message embeds crash text IS flagged, and is waivable', () => {
  // THE MEASURED LIMIT, and why this is a heuristic rather than a verdict. This is a perfect
  // behavioural kill — one failing test, the one written for that property — and it is
  // INDISTINGUISHABLE from #621's crash: both are an `AssertionError` whose message embeds a
  // subprocess crash. An error-TYPE discriminator was written, shipped, and removed, because it
  // separates neither; what divides them is whether the crash IS the asserted property, which no
  // transcript records.
  //
  // So the doubt is raised and the human answers it.
  assert.equal(crashSuspicion(ASSERTION_EMBEDDING_CRASH_TEXT, 1, 8).length, 1);
  assert.deepEqual(crashSuspicion(ASSERTION_EMBEDDING_CRASH_TEXT, 1, 8, false, true), []);
});

test('--allow-crash-text waives the signature signal', () => {
  assert.deepEqual(crashSuspicion(REFERENCE_ERROR, 15, 490, false, true), []);
});

test('each flag answers one doubt, not both', () => {
  // One flag clearing both signals would let a reader waive a question they never considered.
  const broadOnly = crashSuspicion(ASSERTION_FAILURE, 13, 15, false, true);
  assert.equal(broadOnly.length, 1);
  assert.match(broadOnly[0], /broad for one line/);

  const crashOnly = crashSuspicion(REFERENCE_ERROR, 400, 490, true, false);
  assert.equal(crashOnly.length, 1);
  assert.match(crashOnly[0], /runtime error/);
});

test('crash text anywhere in the transcript raises the doubt', () => {
  // The scan is deliberately whole-transcript: a mutant that crashes one module while assertions
  // fail elsewhere is still worth a second look.
  const mixed = ASSERTION_EMBEDDING_CRASH_TEXT.replace(
    '  AssertionError [ERR_ASSERTION]: readme-sections.js',
    '  ReferenceError: stamped is not defined\n  AssertionError [ERR_ASSERTION]: readme-sections.js'
  );
  // Asserted on the REASON, not the count: 2 of 8 is also 25%, so the share signal fires too.
  // Pinning `length === 1` here failed for a reason that had nothing to do with the property
  // under test — a test can be red about the wrong thing just as a gate can.
  // 8 is below MIN_BASELINE_FOR_SHARE, so only the crash signal can speak here — which is the
  // point: the crash signal must not need the share signal's help.
  const reasons = crashSuspicion(mixed, 2, 8);
  assert.ok(reasons.some((reason) => /runtime error/.test(reason)), JSON.stringify(reasons));
});

test('an unrecognised output format falls back to the signature scan', () => {
  // No parseable error-type line means the discriminator cannot speak. It must not then CLEAR
  // the crash signal — that would turn a parse failure into an all-clear, which is the vacuous
  // pass shape this repo keeps finding.
  const noErrorTypes = 'something broke: ReferenceError: x is not defined';
  assert.equal(crashSuspicion(noErrorTypes, 1, 8).length, 1);
});

test('a small baseline does not let one honest failure look broad', () => {
  // 1 of 4 is 25% and tripped the signal. The cost is not the noisy run — it is that
  // `--allow-broad` becomes routine on targeted single-file runs, and a reflex waiver is not a
  // decision. Below MIN_BASELINE_FOR_SHARE only the crash signature speaks.
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 1, 4), []);
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE, 3, MIN_BASELINE_FOR_SHARE - 1), []);
  assert.equal(crashSuspicion(ASSERTION_FAILURE, 3, MIN_BASELINE_FOR_SHARE).length, 1);
});

// ── both node:test reporters, pinned from measured transcripts (#666) ────────
//
// `package.json` permits `node >= 22.12.0`; CI runs 24. The piped DEFAULT reporter differs
// across that range — Node 22 emits TAP, Node 23+ emits spec — and these parsers were
// designed against spec alone. A parse failure disables the share signal by design and
// says nothing, so a Node-22 user could have been getting one of the two SUSPECT signals
// without ever being told which.
//
// Measured on 22.16.0 and 25.9.0: both parse, because `\S*` matches `#` as readily as `ℹ`.
// These fixtures are literal transcript tails from those runs, so tightening either pattern
// against one reporter fails loudly on the other.

const TAP_TAIL = [
  '# tests 3',
  '# suites 0',
  '# pass 2',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 91.861266',
].join('\n');

const SPEC_TAIL = [
  'ℹ tests 3',
  'ℹ suites 0',
  'ℹ pass 2',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 91.861266',
].join('\n');

test('the counts parse on Node 22 TAP and on Node 23+ spec alike', () => {
  for (const [label, tail] of [['TAP (node 22)', TAP_TAIL], ['spec (node 23+)', SPEC_TAIL]]) {
    assert.equal(parseFailCount(tail), 1, `fail count under ${label}`);
    assert.equal(parsePassCount(tail), 2, `pass count under ${label}`);
  }
});

test('an unrecognised format still returns null rather than inventing a count', () => {
  // The property that makes the above safe to rely on: when the reporter changes again,
  // the share signal disables itself instead of guessing. A parse that returned 0 here
  // would read as "zero failures", which is the opposite of what it knows.
  assert.equal(parseFailCount('RESULTS: 1 failure of 3'), null);
  assert.equal(parsePassCount('RESULTS: 2 successes of 3'), null);
  assert.equal(parseFailCount(''), null);
});

test('the crash signature is reporter-independent, on both transcript shapes', () => {
  // Measured end to end on Node 22 rather than argued from format-independence: an
  // undeclared-binding mutant reported `SUSPECT KILL — 18 failing test(s)`, and a
  // behavioural mutant on the same file reported `MUTANT KILLED by 1` with no SUSPECT.
  // `crashSuspicion` returns an ARRAY of reasons, and `[]` is truthy — so assert on its
  // length. A bare `assert.ok(crashSuspicion(...))` passes for every input, which is a
  // vacuous test dressed as a real one, and it is how this test first failed.
  const crash = 'ReferenceError: preHook is not defined\n    at inspectPublishGate';
  assert.equal(crashSuspicion(`${TAP_TAIL}\n${crash}`, 1, 600).length, 1,
    'TAP transcript carrying a crash');
  assert.equal(crashSuspicion(`${SPEC_TAIL}\n${crash}`, 1, 600).length, 1,
    'spec transcript carrying a crash');
  assert.deepEqual(crashSuspicion(TAP_TAIL, 1, 600), [], 'a clean TAP transcript is not suspect');
  assert.deepEqual(crashSuspicion(SPEC_TAIL, 1, 600), [], 'a clean spec transcript is not suspect');
});
