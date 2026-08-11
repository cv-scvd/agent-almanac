#!/usr/bin/env node
/**
 * check-i18n-frontmatter-parity.js
 *
 * Checks that keep-in-English frontmatter fields in translated skills match
 * the English source. i18n/README.md declares `allowed-tools` (among others)
 * keep-in-English, but nothing enforced it: when a source's tool grant
 * changes, every locale snapshot silently desyncs (the drift class behind
 * PR #368; root cause filed as #371).
 *
 * Compares every keep-in-English frontmatter field on EQUALITY except `version`,
 * which is compared on DIRECTION instead (#485).
 *
 * `version` cannot be gated on equality. It diverges on 317 of 3,576 pairs
 * across all ten locales, and that is not drift: a translation records the
 * English version it was made from, so a bump on the English side is expected to
 * leave the snapshot behind. Gating equality would fail 317 files for doing the
 * right thing.
 *
 * But it can be gated on direction. All 317 divergences are the translation
 * running BEHIND its source; measured, exactly 0 run ahead. Nothing legitimate
 * produces a translation claiming a version its source never reached — that can
 * only come from metadata being authored rather than copied, which is the #543
 * signature. So the AHEAD case is blocking, with nothing to catch up.
 *
 * The remaining fields were measured at the time this was extended:
 *
 *   tags           61 divergences   de 11, es 19, ja  9, zh-CN 22
 *   language       14 divergences   es  3, ja  6, zh-CN 5
 *   complexity     13 divergences   es  8, ja  2, zh-CN 3
 *   domain          0
 *   author          0
 *   allowed-tools   0   (repaired by 439d92df; dead as a live detector, see #485)
 *
 * All 88 were caught up in the commit that extended this, and every divergent
 * value was recorded on #543 first — those files are that issue's screening
 * population, and pasting English over them destroys the signal that identifies
 * them.
 *
 * Deliberately does NOT parse the full frontmatter as YAML: pilot-era
 * translations carry shape variance (locale fields at top level vs under
 * metadata), and a malformed unrelated field must not mask an allowed-tools
 * comparison. The field is extracted by scoped line matching instead —
 * frontmatter block only, so `allowed-tools:` inside body code examples
 * (the #369 false-positive class) is never matched.
 *
 * Usage:
 *   node scripts/check-i18n-frontmatter-parity.js          # fail on mismatch
 *   node scripts/check-i18n-frontmatter-parity.js --warn   # warn only
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const I18N_DIR = resolve(ROOT, 'i18n');
const SKILLS_DIR = resolve(ROOT, 'skills');
const WARN_ONLY = process.argv.includes('--warn');

/**
 * Extract the frontmatter block (between the leading `---` delimiters),
 * or null when the file has none.
 */
function extractFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  return match ? match[1] : null;
}

/**
 * The keep-in-English fields this gate compares. `version` is excluded on purpose —
 * see the header. Order is the report order.
 */
const GATED_FIELDS = ['allowed-tools', 'tags', 'domain', 'language', 'complexity', 'author'];

/**
 * `version` cannot be gated on equality, but it can be gated on DIRECTION.
 *
 * A translation records the English version it was made from, so lagging behind is correct
 * and 317 of 3,576 pairs do exactly that. Running *ahead* is a different thing: no
 * legitimate process produces a translation claiming a version its source never reached.
 * It can only come from metadata being authored rather than copied — the #543 signature.
 *
 * Measured before this was added: 317 behind, **0 ahead**, 0 incomparable. So the check
 * ships blocking with nothing to catch up, and it closes the hole a blanket exclusion
 * would leave open.
 */
function compareVersions(a, b) {
  const parts = (v) => v.replace(/^["']|["']$/g, '').split('.')
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    // A non-numeric segment (a pre-release tag, say) falls back to string order rather
    // than being silently treated as equal.
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/**
 * Extract one field from a frontmatter block, at ANY indent.
 *
 * The indent tolerance is load-bearing, not defensive. `allowed-tools` sits at column 0,
 * but `tags`, `domain`, `language`, `complexity` and `author` are all nested under
 * `metadata:` — so a column-anchored `^tags:` matches **zero** of the 3,576 pairs and the
 * gate reports clean having compared nothing. That was measured, not assumed:
 *
 *   tags        found at indent 0: 0    at any indent: 3526
 *   language    found at indent 0: 0    at any indent: 3576
 *   complexity  found at indent 0: 0    at any indent: 3576
 *
 * It also covers the two frontmatter shapes this corpus carries (#533): `de`/`zh-CN` nest
 * the locale fields under `metadata:` while `ja`/`es` place them top-level.
 *
 * Inline form:  <field>: a b c
 * Block form:   <field>:\n  - a\n  - b
 * Returns an array of tokens, or null when the field is absent.
 */
function extractField(fmText, key) {
  if (fmText === null) return null;
  const inlineRe = new RegExp(`^[ \\t]*${key}:[ \\t]*(\\S.*)$`);
  const emptyRe = new RegExp(`^([ \\t]*)${key}:[ \\t]*$`);
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(inlineRe);
    if (inline) return inline[1].trim().split(/[\s,]+/).filter(Boolean);
    const empty = lines[i].match(emptyRe);
    if (empty) {
      const items = [];
      const keyIndent = empty[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^[ \t]+-[ \t]*(\S.*)$/);
        if (item) { items.push(item[1].trim()); continue; }
        // A line indented no further than the key ends the block. Anchoring on `^\S`
        // would run a nested field's list into the following sibling keys.
        const indent = lines[j].match(/^[ \t]*/)[0].length;
        if (lines[j].trim() !== '' && indent <= keyIndent) break;
      }
      return items;
    }
  }
  return null;
}

// Cache the English side once: skill name -> { field -> token array (or null) }.
const englishFields = new Map();
for (const skillName of readdirSync(SKILLS_DIR)) {
  if (skillName.startsWith('_')) continue;
  const sourcePath = join(SKILLS_DIR, skillName, 'SKILL.md');
  if (!existsSync(sourcePath)) continue;
  const fm = extractFrontmatter(readFileSync(sourcePath, 'utf8'));
  const byField = {};
  for (const field of GATED_FIELDS) byField[field] = extractField(fm, field);
  byField.version = extractField(fm, 'version');
  englishFields.set(skillName, byField);
}

let comparedPairs = 0;
let comparedFields = 0;
let versionsChecked = 0;
const problems = []; // { file, kind, detail }

for (const locale of readdirSync(I18N_DIR)) {
  const localeSkillsDir = join(I18N_DIR, locale, 'skills');
  if (!existsSync(localeSkillsDir)) continue;
  for (const skillName of readdirSync(localeSkillsDir)) {
    const translatedPath = join(localeSkillsDir, skillName, 'SKILL.md');
    if (!existsSync(translatedPath)) continue;
    const relPath = `i18n/${locale}/skills/${skillName}/SKILL.md`;

    if (!englishFields.has(skillName)) {
      problems.push({ file: relPath, kind: 'ORPHAN', detail: 'no English source skill' });
      continue;
    }
    const source = englishFields.get(skillName);
    const fm = extractFrontmatter(readFileSync(translatedPath, 'utf8'));
    comparedPairs++;

    for (const field of GATED_FIELDS) {
      const sourceTokens = source[field];
      const translatedTokens = extractField(fm, field);

      if (sourceTokens === null) {
        // English has no such field; a translation must not invent one.
        if (translatedTokens !== null) {
          problems.push({ file: relPath, kind: 'EXTRA', detail: `${field} "${translatedTokens.join(' ')}" but English source has no such field` });
        }
        continue;
      }
      comparedFields++;

      if (translatedTokens === null) {
        problems.push({ file: relPath, kind: 'MISSING', detail: `${field} absent (source: ${sourceTokens.join(' ')})` });
      } else if (translatedTokens.join(' ') !== sourceTokens.join(' ')) {
        problems.push({
          file: relPath,
          kind: 'MISMATCH',
          detail: `${field} "${translatedTokens.join(' ')}" != source "${sourceTokens.join(' ')}"`,
        });
      }
    }

    // version: direction only, never equality. See compareVersions.
    const sourceVersion = extractField(fm === null ? null : fm, 'version');
    const englishVersion = source.version;
    if (englishVersion !== null && sourceVersion !== null) {
      versionsChecked++;
      // Values are usually YAML-quoted (`version: "1.0"`); strip for display so the
      // message does not read `""1.0""`.
      const unquote = (v) => v.join(' ').replace(/^["']|["']$/g, '');
      if (compareVersions(sourceVersion.join(' '), englishVersion.join(' ')) > 0) {
        problems.push({
          file: relPath,
          kind: 'AHEAD',
          detail: `version "${unquote(sourceVersion)}" is ahead of source "${unquote(englishVersion)}" — a translation cannot legitimately reach a version its source never did`,
        });
      }
    }
  }
}

const label = WARN_ONLY ? 'WARN' : 'FAIL';
for (const p of problems) console.log(`${label} [${p.kind}] ${p.file}: ${p.detail}`);

console.log(`\ni18n frontmatter parity: ${comparedPairs} translated skills against ${englishFields.size} English sources;`);
// Field comparisons are reported because the pair count alone cannot distinguish "compared
// six fields per pair" from "matched nothing and reported clean" — the exact failure a
// column-anchored implementation produces.
console.log(`${comparedFields} field comparison(s) across: ${GATED_FIELDS.join(', ')};`);
console.log(`${versionsChecked} version(s) checked for direction only (lagging is legitimate, running ahead is not).`);
if (problems.length === 0) {
  console.log('OK: all keep-in-English frontmatter fields match their source.');
} else {
  console.log(`${problems.length} parity problem(s) found. Fix: copy the English value verbatim (keep-in-English fields, see i18n/README.md).`);
  if (problems.some((p) => p.kind === 'AHEAD')) {
    // Copying English is the wrong advice here: the translation's version is meant to lag.
    console.log('For [AHEAD]: do NOT copy the English version. A translation ahead of its');
    console.log('source means the value was authored rather than recorded — investigate the');
    console.log('file before changing anything (see #543).');
  }
}

process.exit(problems.length > 0 && !WARN_ONLY ? 1 : 0);
