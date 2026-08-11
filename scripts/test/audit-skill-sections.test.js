/**
 * Tests for `auditSkillText()` in `scripts/audit-skill-sections.js`.
 *
 * Written to test a code comment claiming a carriage return "would report every required
 * section missing" — and the claim turned out to be **false**. `sectionBody` compares
 * `line.trim()`, which eats the trailing '\r', and every other test in the module is
 * start-anchored, so `raw.split('\n')` and `toLines(raw)` behave identically. The mutant
 * reverting the normalisation SURVIVES, and that is the correct result, recorded here so
 * nobody re-derives the wrong conclusion from the surviving mutant.
 *
 * The tests are kept because the module had none at all, and because the CRLF case is now
 * a characterisation test: if a future end-anchored comparison is added below, it breaks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditSkillText, countPitfalls, REQUIRED_SECTIONS } from '../audit-skill-sections.js';

const SKILL = [
  '---',
  'name: demo-skill',
  'description: A demo',
  'metadata:',
  '  version: "1.2.0"',
  '---',
  '',
  '# Demo Skill',
  '',
  '## When to Use',
  '',
  'When demonstrating.',
  '',
  '## Inputs',
  '',
  '- **Required**: nothing',
  '',
  '## Procedure',
  '',
  '### Step 1: Do it',
  '',
  'Do the thing.',
  '',
  '## Validation',
  '',
  '- [ ] It worked',
  '',
  '## Common Pitfalls',
  '',
  '- **First**: one way it goes wrong',
  '- **Second**: another way',
  '- **Third**: a third way',
  '',
  '## Related Skills',
  '',
  '- `other-skill` — related',
  '',
].join('\n');

test('a well-formed skill reports no missing sections', () => {
  const result = auditSkillText(SKILL, 'demo-skill');
  assert.deepEqual(result.missing, []);
  assert.equal(result.pitfalls, 3);
  assert.equal(result.version, '1.2.0');
});

test('a CRLF copy audits identically (#532)', () => {
  // True of BOTH implementations — see the header. This pins the behaviour rather than the
  // mechanism, so it stays meaningful if the parsing changes.
  const crlf = SKILL.replace(/\n/g, '\r\n');
  const result = auditSkillText(crlf, 'demo-skill');
  assert.deepEqual(result.missing, [], 'a carriage return must not empty the section list');
  assert.deepEqual(result, auditSkillText(SKILL, 'demo-skill'));
});

test('a genuinely incomplete skill still reports what is missing', () => {
  // Guards the other direction: the CRLF fix must not make the audit report success for a
  // file that really is missing sections.
  const stripped = SKILL.replace('## Common Pitfalls', '## Something Else');
  const result = auditSkillText(stripped, 'demo-skill');
  assert.deepEqual(result.missing, ['Common Pitfalls']);
  // `null`, not 0 — an absent section is distinguishable from a present but empty one.
  assert.equal(result.pitfalls, null);
  assert.ok(REQUIRED_SECTIONS.includes('Common Pitfalls'));
});

test('pitfalls are counted in both authored list formats, under either line ending', () => {
  // The #382 tail measurement under-counted by 8 skills with a dash-only counter. Exercised
  // through `auditSkillText` because the counter takes `sectionBody`'s structured output,
  // and that is exactly what a stray `\r` would corrupt.
  const numbered = SKILL.replace(
    '- **First**: one way it goes wrong\n- **Second**: another way\n- **Third**: a third way',
    '1. **First**: one way it goes wrong\n2. **Second**: another way',
  );
  assert.equal(auditSkillText(numbered, 'demo-skill').pitfalls, 2);
  assert.equal(auditSkillText(numbered.replace(/\n/g, '\r\n'), 'demo-skill').pitfalls, 2);
  assert.equal(typeof countPitfalls, 'function');
});
