#!/usr/bin/env node
/**
 * check-i18n-fence-parity.js
 *
 * Enforces the keep-code-in-English rule for fenced code blocks in translated
 * skills. `CLAUDE.md` § Translation Rules and `i18n/README.md` both declare code
 * blocks keep-in-English, and `skills/translate-content/SKILL.md` step 5.3 even
 * instructs the translator to "diff the fenced blocks" — but nothing mechanical
 * checked it, and the corpus drifted (#472).
 *
 * That the rule was stated four times and still violated is the point: every
 * i18n commit in this repo postdates the commit that introduced step 5.3
 * (77006e7a, 2026-03-13), so every violation was produced under a procedure
 * that told the agent to verify exactly this. Prose does not enforce.
 *
 * ## What counts as a violation
 *
 * A fence body in a translated SKILL.md is a violation when it appears in NO
 * revision of that skill's English SKILL.md, ever.
 *
 * That basis is chosen to be immune to the two confounds that make the naive
 * comparison unusable:
 *
 *   - **Staleness.** 2,545 translations are stale repo-wide. A stale
 *     translation's fence legitimately matches an OLDER English source and
 *     diverges from HEAD without anybody having translated anything. Comparing
 *     against HEAD alone would report those as violations.
 *   - **`source_commit` bumps.** `evolve-skill` bumps `source_commit` without
 *     retranslating (#405), so the frontmatter's claimed basis can sit ahead of
 *     the real one. Anchoring to `source_commit` inherits that lie.
 *
 * Searching the whole history of the English file dodges both: staleness can
 * only ever make a fence match an *earlier* English revision, never a revision
 * that does not exist. So anything this reports was written by a human or an
 * agent and never existed in English. Measured false-positive rate on the
 * corpus at introduction: 2 whitespace-only and 2 cross-skill artifacts out of
 * 1,934 — 0.2%.
 *
 * Consequence, stated deliberately: a fence matching an OLD English revision
 * passes. That is staleness, which is `check-translation-freshness.js`'s job,
 * not this gate's.
 *
 * ## Why not the CJK discriminator
 *
 * #472 proposed flagging fences containing CJK characters absent from English.
 * That is sound but sees only 410 of 1,198 executable-tag violations (34%) —
 * it is structurally blind to `de` and `es`, which contribute 590 between them,
 * and to reworded-ASCII violations in every locale.
 *
 * Usage:
 *   node scripts/check-i18n-fence-parity.js           # fail on violation
 *   node scripts/check-i18n-fence-parity.js --warn    # report, exit 0
 *   node scripts/check-i18n-fence-parity.js --all     # include ungated tags
 *   node scripts/check-i18n-fence-parity.js --json    # machine-readable
 *   node scripts/check-i18n-fence-parity.js --limit N # cap printed findings
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertNotShallow } from './lib/git-freshness.js';
import { extractFences, buildEnglishFenceHistory, isGated } from './lib/fences.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const I18N_DIR = resolve(ROOT, 'i18n');

const WARN_ONLY = process.argv.includes('--warn');
const SHOW_ALL = process.argv.includes('--all');
const AS_JSON = process.argv.includes('--json');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 40;

function main() {
  assertNotShallow(ROOT);

  const history = buildEnglishFenceHistory();
  const findings = [];
  let filesCompared = 0;
  let fencesCompared = 0;
  let ungatedDivergences = 0;

  for (const locale of readdirSync(I18N_DIR)) {
    const localeSkills = join(I18N_DIR, locale, 'skills');
    if (!existsSync(localeSkills) || !statSync(localeSkills).isDirectory()) continue;

    for (const skill of readdirSync(localeSkills)) {
      const translated = join(localeSkills, skill, 'SKILL.md');
      if (!existsSync(translated)) continue;
      const englishFences = history.get(skill);
      if (!englishFences) continue; // orphan: check-i18n-frontmatter-parity.js owns that

      filesCompared++;
      const relPath = `i18n/${locale}/skills/${skill}/SKILL.md`;
      for (const fence of extractFences(readFileSync(translated, 'utf8'))) {
        fencesCompared++;
        if (englishFences.has(fence.body)) continue;
        const gated = isGated(fence);
        if (!gated) { ungatedDivergences++; if (!SHOW_ALL) continue; }
        findings.push({
          file: relPath,
          line: fence.line,
          locale,
          skill,
          tag: fence.lang || '(untagged)',
          gated,
          firstDivergentLine: (fence.body.split('\n').find((l) => l.trim() !== '') || '').trim().slice(0, 100),
        });
      }
    }
  }

  const blocking = findings.filter((f) => f.gated);

  if (AS_JSON) {
    console.log(JSON.stringify({
      filesCompared, fencesCompared,
      violations: blocking.length,
      ungatedDivergences,
      findings,
    }, null, 2));
    process.exit(blocking.length > 0 && !WARN_ONLY ? 1 : 0);
  }

  const label = WARN_ONLY ? 'WARN' : 'FAIL';
  for (const f of findings.slice(0, LIMIT)) {
    const kind = f.gated ? label : 'INFO';
    console.log(`${kind} ${f.file}:${f.line} [${f.tag}] ${f.firstDivergentLine}`);
  }
  if (findings.length > LIMIT) {
    console.log(`... ${findings.length - LIMIT} more (use --limit ${findings.length} to see all, or --json)`);
  }

  const byTag = new Map();
  for (const f of blocking) byTag.set(f.tag, (byTag.get(f.tag) || 0) + 1);
  const byLocale = new Map();
  for (const f of blocking) byLocale.set(f.locale, (byLocale.get(f.locale) || 0) + 1);

  console.log(`\ni18n fence parity: ${fencesCompared} fences in ${filesCompared} translated skills`);
  console.log(`compared against every historical revision of their English source.`);

  if (blocking.length === 0) {
    console.log('OK: every gated code fence matches an English source revision.');
  } else {
    const files = new Set(blocking.map((f) => f.file)).size;
    console.log(`\n${blocking.length} gated-fence violation(s) across ${files} file(s).`);
    console.log(`by tag:    ${[...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log(`by locale: ${[...byLocale.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    console.log('\nFix: restore the English fence body verbatim. Code blocks are keep-in-English');
    console.log('(CLAUDE.md § Translation Rules, i18n/README.md). Translate the surrounding prose only.');
  }
  if (ungatedDivergences) {
    console.log(`\n${ungatedDivergences} divergence(s) in ungated tags (text/markdown/untagged) — localising those is allowed.`);
    if (!SHOW_ALL) console.log('Use --all to list them.');
  }

  process.exit(blocking.length > 0 && !WARN_ONLY ? 1 : 0);
}

main();
