/**
 * Pins the `translator:` stub value across the three places it lives (#545).
 *
 * `scripts/translate-content.sh` stamps the value; `i18n/README.md` documents it; and
 * `tools/translator-stamp.mjs` reads it from the scaffolder rather than carrying a copy. This
 * test drives that same reader — not a second regex — so the assertion covers the accept rule
 * the tool actually applies. Two properties, each the kind of drift that shipped before:
 *
 *   1. The scaffold value must not assert a review or a human. The old value,
 *      `"Claude + human review"`, was stamped onto byte copies of English for months, which made
 *      the field answer "yes" to "has a human reviewed this?" for every file in the corpus.
 *   2. The README example must carry the value the scaffolder actually stamps. Documentation
 *      drift is treated as a P1 bug here, and an example that shows a retired value teaches
 *      translators to write it back by hand.
 *
 * Reverting either scaffolder line to the old value fails both tests; editing only the README
 * fails the second. The scaffolder is bash, which `mutation-check` cannot syntax-check (#758),
 * so this pin is what stands between the value and a silent return.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SCAFFOLDER, stubValueFromScaffolder } from '../../tools/translator-stamp.mjs';

const README = join(ROOT, 'i18n', 'README.md');

/** The `translator:` line inside the README's frontmatter example fence. */
function readmeExampleValue() {
  const text = readFileSync(README, 'utf8');
  const fence = /```yaml\r?\n([\s\S]*?)```/.exec(text);
  assert.ok(fence, 'i18n/README.md has a ```yaml frontmatter example');
  const m = /^translator: "([^"]+)"/m.exec(fence[1]);
  assert.ok(m, 'the example carries a quoted translator: line');
  return m[1];
}

test('the scaffolder stamps a single value that asserts neither a review nor a human', () => {
  const value = stubValueFromScaffolder(SCAFFOLDER);
  assert.doesNotMatch(value, /review|human/i, `scaffold value "${value}" claims work that a byte copy has not done`);
  assert.notEqual(value, 'Claude + human review');
});

test('the README frontmatter example shows the value the scaffolder stamps', () => {
  assert.equal(readmeExampleValue(), stubValueFromScaffolder(SCAFFOLDER));
});

test('a scaffolder without a quoted value is a measurement failure, not a value', () => {
  assert.throws(
    () => stubValueFromScaffolder(join(ROOT, 'package.json')),
    /no quoted translator value/,
  );
});
