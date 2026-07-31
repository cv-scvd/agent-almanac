#!/usr/bin/env node
/**
 * check-i18n-fence-parity.js
 *
 * Enforces the keep-code-in-English rule for fenced code blocks in translated
 * content — skills, agents, teams and guides. `CLAUDE.md` § Translation Rules
 * and `i18n/README.md` both declare code blocks keep-in-English, and
 * `skills/translate-content/SKILL.md` step 5.3 even instructs the translator to
 * "diff the fenced blocks" — but nothing mechanical checked it, and the corpus
 * drifted (#472).
 *
 * That the rule was stated four times and still violated is the point: every
 * i18n commit in this repo postdates the commit that introduced step 5.3
 * (77006e7a, 2026-03-13), so every violation was produced under a procedure
 * that told the agent to verify exactly this. Prose does not enforce.
 *
 * ## What counts as a violation
 *
 * A fence body in a translated file is a violation when it appears in NO
 * revision of its English counterpart, ever.
 *
 * That basis is chosen to be immune to the two confounds that make the naive
 * comparison unusable:
 *
 *   - **Staleness.** 2,549 translations are stale repo-wide. A stale
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
 * agent and never existed in English. Measured false positives on the corpus at
 * introduction: 1 whitespace-only (under a per-line-trim reading) and 2
 * cross-skill artifacts out of 2,115 divergences — 0.14%.
 *
 * Consequence, stated deliberately: a fence matching an OLD English revision
 * passes. That is staleness, which is `check-translation-freshness.js`'s job,
 * not this gate's. The same deliberate choice means a translation that DELETES
 * a frozen fence is not caught here — see #480, and the comment at the end of
 * the compare loop for why the obvious fix reintroduces the confound.
 *
 * ## Why not the CJK discriminator
 *
 * #472 proposed flagging fences containing CJK characters absent from English.
 * That is sound but sees only 457 of 1,307 gated violations (35%) — it is
 * structurally blind to `de` and `es`, which contribute 648 between them, and
 * to reworded-ASCII violations in every locale. German is the largest violator
 * and transliterates umlauts inside fences (`pruefen`, `fuer`, `zaehlen`), so
 * even a Latin-diacritic test misses most of it.
 *
 * Usage:
 *   node scripts/check-i18n-fence-parity.js                    # fail on violation
 *   node scripts/check-i18n-fence-parity.js --warn             # report, exit 0
 *   node scripts/check-i18n-fence-parity.js --all              # include ungated tags
 *   node scripts/check-i18n-fence-parity.js --json             # machine-readable
 *   node scripts/check-i18n-fence-parity.js --limit N          # cap printed findings
 *   node scripts/check-i18n-fence-parity.js --locale de        # one locale
 *   node scripts/check-i18n-fence-parity.js --locale de --id X # one file
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

/**
 * Read `--flag value`, rejecting a following flag as the value. Bare
 * `--limit` with nothing after it used to yield `Number(undefined)` = NaN,
 * which made `slice(0, NaN)` print no findings AND suppressed the "N more"
 * hint, so the run looked clean.
 */
function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`ERROR: ${name} requires a value`);
    process.exit(2);
  }
  return v;
}

const LIMIT = Number(flagValue('--limit', '40'));
if (!Number.isFinite(LIMIT)) { console.error('ERROR: --limit must be a number'); process.exit(2); }
const ONLY_LOCALE = flagValue('--locale', null);
const ONLY_ID = flagValue('--id', null);

/**
 * Translated content trees this gate covers. `skills` is where the corpus and
 * the violations are, but the rule as written in CLAUDE.md and i18n/README.md
 * says "any translated file" — and the mirrors carry 168 gated fences that a
 * skills-only walk never opens. Covering them is what makes the documented rule
 * true.
 */
const TREES = [
  { dir: 'skills', nested: true },   // i18n/<loc>/skills/<id>/SKILL.md
  { dir: 'agents', nested: false },  // i18n/<loc>/agents/<id>.md
  { dir: 'teams', nested: false },
  { dir: 'guides', nested: false },
];

/** Every translated file to compare, as { relPath, absPath, locale, id, tree }. */
function collectTargets() {
  const out = [];
  for (const locale of readdirSync(I18N_DIR)) {
    if (ONLY_LOCALE && locale !== ONLY_LOCALE) continue;
    for (const { dir, nested } of TREES) {
      const base = join(I18N_DIR, locale, dir);
      if (!existsSync(base) || !statSync(base).isDirectory()) continue;
      for (const entry of readdirSync(base)) {
        const id = nested ? entry : entry.replace(/\.md$/, '');
        if (ONLY_ID && id !== ONLY_ID) continue;
        const absPath = nested ? join(base, entry, 'SKILL.md') : join(base, entry);
        if (!nested && !entry.endsWith('.md')) continue;
        if (!existsSync(absPath) || !statSync(absPath).isFile()) continue;
        out.push({
          absPath, locale, id, tree: dir,
          relPath: `i18n/${locale}/${dir}/${nested ? `${entry}/SKILL.md` : entry}`,
        });
      }
    }
  }
  return out;
}

function main() {
  assertNotShallow(ROOT);

  const history = buildEnglishFenceHistory();
  const findings = [];
  let filesCompared = 0;
  let fencesCompared = 0;
  let ungatedDivergences = 0;

  for (const t of collectTargets()) {
    const englishFences = history.get(`${t.tree}/${t.id}`);
    if (!englishFences) continue; // orphan: check-i18n-frontmatter-parity.js owns that

    filesCompared++;
    for (const fence of extractFences(readFileSync(t.absPath, 'utf8'))) {
      fencesCompared++;
      if (englishFences.has(fence.body)) continue;
      const gated = isGated(fence);
      if (!gated) { ungatedDivergences++; if (!SHOW_ALL) continue; }
      findings.push({
        file: t.relPath,
        line: fence.line,
        locale: t.locale,
        skill: t.id,
        tag: fence.lang || '(untagged)',
        gated,
        kind: 'diverged',
        firstDivergentLine: (fence.body.split('\n').find((l) => l.trim() !== '') || '').trim().slice(0, 100),
      });
    }

    // A translation that DELETES a frozen fence outright contributes nothing to
    // the loop above, so it reports clean. That gap is real and tracked in #480
    // — but it is NOT fixable by comparing against current English, which is
    // what a first attempt did here. A stale translation legitimately lacks
    // fences English gained after it was written, so that comparison
    // reintroduces exactly the staleness confound this gate exists to avoid:
    // measured, it produced 1,518 findings across 402 files, topped by four
    // `quick-reference.md` mirrors that `check-translation-freshness.js`
    // independently reports as stale. Any fix must be staleness-immune the way
    // the divergence check is.
  }

  const blocking = findings.filter((f) => f.gated);

  if (AS_JSON) {
    // process.exit() discards writes still queued on an async pipe, which
    // truncated this payload to 65,536 bytes whenever stdout was piped rather
    // than redirected — the exact consumer this mode exists for.
    console.log(JSON.stringify({
      filesCompared, fencesCompared,
      violations: blocking.length,
      ungatedDivergences,
      findings,
    }, null, 2));
    process.exitCode = blocking.length > 0 && !WARN_ONLY ? 1 : 0;
    return;
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
    // Deliberately does NOT say "untagged": untagged fences are frozen under
    // default-deny, so an untagged divergence prints FAIL and is counted above.
    console.log(`\n${ungatedDivergences} divergence(s) in localisable tags (text/markdown/md) — localising those is allowed.`);
    if (!SHOW_ALL) console.log('Use --all to list them.');
  }

  process.exit(blocking.length > 0 && !WARN_ONLY ? 1 : 0);
}

main();
