/**
 * Unit tests for the template predicate (#672) and the JS/shell pair it creates.
 *
 * #672 counted 54 hand-rolled `_template` exclusions across 14 files, in three spellings, with
 * no shared definition — the count re-derived on this branch under the issue's own ruler was
 * 115 occurrences. The predicate under test replaces the ones that ask "is this scaffolding".
 *
 * Two properties are load-bearing and neither is obvious from reading the function:
 *
 * 1. It is ROOT-ANCHORED. A depth-agnostic test is the version `skills-inventory.js` shipped,
 *    measured wrong against npm, and reverted — `skills/<id>/_template/helper.py` SHIPS, and
 *    `skills-inventory.test.js` pins that with a live fixture. The nested case is asserted
 *    here too so the two files cannot drift apart on it.
 * 2. Its member set is EXACT, and a second copy of that set lives in
 *    `scripts/lib/template-names.sh` because a bash script cannot import an ES module. That
 *    duplication is the very shape #672 is about, one level up, so it is gated below rather
 *    than trusted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isTemplate,
  isTemplateSegment,
  TEMPLATE_SEGMENTS,
  templateSpellingDrift,
  isExcludedId,
} from '../lib/content-paths.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const trackedPaths = () => execFileSync('git', ['ls-files'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
}).split('\n').filter(Boolean);

test('every template spelling on disk is recognised', () => {
  for (const path of [
    'agents/_template.md',
    'guides/_template.md',
    'teams/_template.md',
    'tests/_template.md',
    'skills/_template/SKILL.md',
    'workflows/_template.mjs',
  ]) {
    assert.equal(isTemplate(path), true, path);
  }
});

test('a NESTED _template is not a template — it ships', () => {
  // The direction `skills-inventory.js` measured wrong and reverted. npm's `files` negations
  // are root-anchored, so `!skills/_template/` does not exclude this path and the file is in
  // the published tarball. A predicate that matched it here would put the two modules back
  // into disagreement, which is what #672 exists to prevent.
  assert.equal(isTemplate('skills/alpha/_template/helper.py'), false);
  assert.equal(isTemplate('skills/alpha/_template/'), false);
});

test('substring lookalikes are not templates', () => {
  // `includes('_template')` was the spelling at three call sites before #672. Each of these
  // would have been excluded by it, silently, from a gate or a published count.
  assert.equal(isTemplate('guides/my_template_notes.md'), false);
  assert.equal(isTemplate('agents/_templates.md'), false);
  assert.equal(isTemplate('skills/_template_backup/SKILL.md'), false);
});

test('a mirror anchors like its English source', () => {
  // `check-content-style.js` lists `i18n/` among its content globs and excluded mirror
  // templates via `includes('/_template')`. Returning false here would have quietly started
  // scanning them. Zero are tracked today, so no fixture in this repo would have caught it.
  assert.equal(isTemplate('i18n/de/skills/_template/SKILL.md'), true);
  assert.equal(isTemplate('i18n/zh-CN/agents/_template.md'), true);
  assert.equal(isTemplate('i18n/de/skills/create-r-package/SKILL.md'), false);
});

test('degenerate inputs do not throw and do not match', () => {
  for (const path of ['', 'i18n', '_template.md', 'skills', '/', 'skills/']) {
    assert.equal(isTemplate(path), false, JSON.stringify(path));
  }
});

test('isTemplate is a STRICT SUBSET of isExcludedId, and the two are not interchangeable', () => {
  // The distinction three modules now depend on. `isExcludedId` also covers `README` and every
  // other `_`-prefixed name; `isTemplate` covers scaffolding alone. Collapsing them would make
  // `_registry.yml` a "template" and `_experimental/` non-content.
  for (const segment of TEMPLATE_SEGMENTS) {
    assert.equal(isExcludedId(segment), true, `${segment} must also be excluded as an id`);
  }
  for (const segment of ['_registry.yml', 'README.md', 'README', '_experimental']) {
    assert.equal(isTemplateSegment(segment), false, `${segment} is not a template`);
    assert.equal(isExcludedId(segment), true, `${segment} is still not content`);
  }
});

test('the drift check reports an UNSEEN spelling', () => {
  const { uncovered, dead } = templateSpellingDrift([
    'agents/_template.md', 'skills/_template/SKILL.md', 'workflows/_template.mjs',
    'guides/_template.yml',
  ]);
  assert.deepEqual(uncovered, ['guides/_template.yml']);
  assert.deepEqual(dead, []);
});

test('the drift check reports a DEAD member', () => {
  // The direction an `observed ⊆ declared` check is blind to. A set that keeps naming a
  // spelling nobody uses is how the list stays green describing a corpus that has moved on,
  // and it is indistinguishable from coverage unless asserted.
  const { uncovered, dead } = templateSpellingDrift(['agents/_template.md']);
  assert.deepEqual(uncovered, []);
  assert.deepEqual(dead, ['_template', '_template.mjs']);
});

test('the drift check ignores a nested _template rather than calling it uncovered', () => {
  // Caught during development: scanning every segment reported the legitimately-nested,
  // legitimately-shipped `skills/alpha/_template/helper.py` as an uncovered spelling, so the
  // check would have gone red demanding the predicate absorb a path it is right to reject.
  const { uncovered } = templateSpellingDrift([
    'agents/_template.md', 'skills/_template/SKILL.md', 'workflows/_template.mjs',
    'skills/alpha/_template/helper.py',
  ]);
  assert.deepEqual(uncovered, []);
});

test('THE CORPUS: no template spelling on disk escapes the predicate, and no member is dead', () => {
  // #672 AC4, against the real tree rather than a fixture. Add `guides/_template.yml` and this
  // fails naming it; delete the last `.mjs` template and it fails naming the dead member.
  const { uncovered, dead } = templateSpellingDrift(trackedPaths());
  assert.deepEqual(uncovered, [], 'a _template* spelling the predicate does not cover');
  assert.deepEqual(dead, [], 'a declared spelling no tracked path uses');
});

test('THE PAIR: the shell list matches TEMPLATE_SEGMENTS exactly', () => {
  // `scripts/lib/template-names.sh` cannot import this module, so the set exists twice. Gated
  // in BOTH directions: a name added to either side alone fails here naming the other.
  const shell = readFileSync(resolve(ROOT, 'scripts/lib/template-names.sh'), 'utf8');
  const line = shell.match(/^TEMPLATE_NAMES=\((.*)\)$/m);
  assert.ok(line, 'TEMPLATE_NAMES=( ... ) not found in scripts/lib/template-names.sh');

  const names = [...line[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'parsed zero names — the parse, not the corpus, is broken');
  assert.deepEqual([...names].sort(), [...TEMPLATE_SEGMENTS].sort());
});

test('the shell helper agrees with the JS predicate name by name', () => {
  // Parsing the array proves the LISTS match. This proves the shell FUNCTION reads them, which
  // a typo in `is_template` itself would otherwise leave green.
  const script = resolve(ROOT, 'scripts/lib/template-names.sh');
  const probe = [
    ...TEMPLATE_SEGMENTS,
    '_templates.md', 'README.md', '_registry.yml', 'my_template_notes.md', '',
  ];
  for (const name of probe) {
    const status = execFileSync('bash', [
      '-c', `source "$1"; if is_template "$2"; then echo yes; else echo no; fi`, '_', script, name,
    ], { encoding: 'utf8' }).trim();
    assert.equal(
      status === 'yes',
      isTemplateSegment(name),
      `is_template(${JSON.stringify(name)}) disagrees with isTemplateSegment`,
    );
  }
});
