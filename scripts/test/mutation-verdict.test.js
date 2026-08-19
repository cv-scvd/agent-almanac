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

test('a ReferenceError is suspect however few tests failed', () => {
  const reasons = crashSuspicion(REFERENCE_ERROR, 15, 490);
  assert.equal(reasons.length, 1, 'the share signal must not also fire at 15/490');
  assert.match(reasons[0], /runtime error/);
});

test('a broad failure is suspect without any runtime error', () => {
  // Measured shape: returning `[]` from `guideCategoryOrder` fails 13 of 15 and prints no
  // runtime error at all. The two signals are independent, and each must be able to fire alone —
  // otherwise one of them is decoration.
  const reasons = crashSuspicion(ASSERTION_FAILURE.replace('fail 2', 'fail 13'), 13, 15);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /13 of 15 baseline tests failed \(87%\)/);
});

test('--allow-broad waives the share signal', () => {
  assert.deepEqual(crashSuspicion(ASSERTION_FAILURE.replace('fail 2', 'fail 13'), 13, 15, true), []);
});

test('--allow-broad does NOT waive a crash signature', () => {
  // The load-bearing asymmetry. A broad failure can be legitimate; a crash never establishes
  // that a test asserts the behaviour, so no flag may buy past it.
  const reasons = crashSuspicion(REFERENCE_ERROR, 400, 490, true);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /runtime error/);
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
