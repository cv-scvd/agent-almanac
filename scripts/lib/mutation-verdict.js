/**
 * mutation-verdict.js — reading a mutant test run: how many failed, and does the kill mean
 * anything (#621).
 *
 * Extracted from `scripts/mutation-check.js` for the reason `guide-categories.js` was extracted
 * from `generate-readmes.js` in #644: that file runs its whole pipeline at module scope, so
 * importing it to test one decision executes a mutation. The decision here is pure — text in,
 * verdict out — and it is the decision the tool's central promise rests on.
 *
 * ## The promise, and the two ways it breaks
 *
 * `MUTANT KILLED` is supposed to mean "a test asserts this behaviour". Two kinds of red do not
 * establish that, and both look identical in an exit code:
 *
 *   1. the mutant does not PARSE — caught upstream in mutation-check.js, reported `INVALID`;
 *   2. the mutant parses and then CRASHES the moment the module runs — this file.
 *
 * The second is quieter precisely because the syntax gate passes it. Deleting
 * `const stamped = …` leaves `if (stamped !== null)` referencing an undeclared binding, and
 * under ESM strict mode every test reaching that module throws `ReferenceError`. Measured on
 * `normalize-i18n-fences.js` while covering #552: `MUTANT KILLED by 15 failing test(s)`. The
 * honest instrument for the same line — weakening a condition, which parses AND runs to
 * completion — died to exactly 1 test, the one written for it.
 *
 * Same line, same tool, 15 versus 1, and only the 1 means anything. That inversion is the whole
 * problem: the count is quoted in commit messages as evidence of coverage strength, and a bigger
 * number reads as stronger.
 */

/**
 * Output patterns that mean the module BROKE rather than that a test asserted something.
 *
 * Deliberately narrow. Each entry names an error a normal assertion failure does not produce —
 * `assert.equal` failing prints a diff, not a `ReferenceError`. Broadening this to "any stack
 * trace" would swallow legitimate kills in code that throws by design, which is the false-SUSPECT
 * direction and the one that gets a check switched off.
 */
export const CRASH_SIGNATURES = [
  /\bReferenceError\b/,
  /\bTypeError\b.*\bis not a function\b/,
  /\bCannot access '[^']*' before initialization\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bCannot find (?:module|package)\b/,
  /\bis not defined\b/,
];

/**
 * Error TYPES of the failing tests, e.g. `AssertionError`, `ReferenceError`.
 *
 * node:test prints the error on its own indented line under each `✖` in the failing-tests
 * section, so the type is the first word of that line.
 */
export function failureErrorTypes(output) {
  return [...String(output ?? '').matchAll(/^\s+([A-Za-z]+Error)\b/gm)].map((m) => m[1]);
}

/**
 * Are ALL the failures ordinary assertion failures?
 *
 * This is what makes the crash signal usable rather than a tripwire, and it is not a
 * refinement — without it the check refuses to certify correct kills, with no waiver, because
 * crash signatures are deliberately unwaivable.
 *
 * Measured on this repo. `scripts/test/dependency-free.test.js` asserts that a module acquires
 * no package dependency, and on failure it EMBEDS the resolution error in its own assertion
 * message:
 *
 *   AssertionError [ERR_ASSERTION]: readme-sections.js acquired a package dependency:
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from …
 *
 * Adding `import * as yaml from 'js-yaml'` to `readme-sections.js` is a perfect behavioural
 * kill — one failing test, the exact one written for that property — and the raw signature
 * scan reported it SUSPECT. A test whose subject IS a crash will always carry crash text in
 * its message; the error TYPE is what separates "a test asserted this" from "the module broke".
 *
 * Returns false when no error type could be parsed, so an unrecognised format falls back to the
 * signature scan rather than silently clearing it.
 */
function errorTypesAreAllAssertions(output) {
  const types = failureErrorTypes(output);
  return types.length > 0 && types.every((type) => type === 'AssertionError');
}

/** Pull `fail N` out of node:test output; null if the format is not recognised. */
export function parseFailCount(output) {
  const match = String(output ?? '').match(/^\s*\S*\s*fail\s+(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

/** Pull `pass N` out of node:test output; null if the format is not recognised. */
export function parsePassCount(output) {
  const match = String(output ?? '').match(/^\s*\S*\s*pass\s+(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

/** Share of the baseline suite at or above which a kill is called broad. */
export const BROAD_KILL_SHARE = 0.25;

/**
 * Reasons to doubt that a red run is a behavioural kill. Empty means no doubt.
 *
 * Two independent signals, because neither is decidable from an exit code alone:
 *
 *   - a runtime-error signature, which an assertion failure does not produce;
 *   - a failure count taking a large share of the suite, since a behavioural mutation usually
 *     kills the handful of tests written for that behaviour.
 *
 * They differ in one important way, and the difference is what `allowBroad` encodes. A crash
 * signature is NEVER legitimate — a crash cannot establish that a test asserts anything. A broad
 * failure often is: mutating a genuinely load-bearing line honestly fails most of the suite.
 * Measured — returning `[]` from `guideCategoryOrder` fails 13 of 15 with no runtime error, and
 * that is a real kill. So the share signal is waivable by an explicit flag, the way
 * `--allow-multiple` waives the one-site rule, and the waiver does not extend to the other.
 *
 * @param {string} output - combined stdout/stderr of the mutant run
 * @param {number|null} failCount - failing tests in the mutant run
 * @param {number|null} baselinePassCount - passing tests in the green baseline
 * @param {boolean} [allowBroad] - accept a broad failure as a legitimate kill
 * @returns {string[]} human-readable reasons; empty if the kill looks behavioural
 */
export function crashSuspicion(output, failCount, baselinePassCount, allowBroad = false) {
  const reasons = [];
  const text = String(output ?? '');
  const matched = errorTypesAreAllAssertions(text)
    ? []
    : CRASH_SIGNATURES.filter((pattern) => pattern.test(text));
  if (matched.length > 0) {
    const names = matched.map((pattern) => pattern.source.replace(/\\b/g, '')).join(', ');
    reasons.push(
      `the output contains ${matched.length === 1 ? 'a runtime error' : 'runtime errors'} (${names})`
    );
  }
  if (!allowBroad && failCount !== null && baselinePassCount !== null && baselinePassCount > 0) {
    const share = failCount / baselinePassCount;
    if (share >= BROAD_KILL_SHARE) {
      reasons.push(
        `${failCount} of ${baselinePassCount} baseline tests failed (${Math.round(share * 100)}%), ` +
        'which is broad for one line — pass --allow-broad if that is genuinely expected'
      );
    }
  }
  return reasons;
}
