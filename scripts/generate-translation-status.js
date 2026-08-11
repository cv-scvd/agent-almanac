#!/usr/bin/env node
/**
 * generate-translation-status.js
 *
 * Auto-generates per-locale translation_status.yml files by counting
 * translated files and checking freshness against English sources.
 *
 * Usage:
 *   node scripts/generate-translation-status.js
 *   node scripts/generate-translation-status.js --verdicts   # list every stub with its
 *                                                            # reason and line counts, plus
 *                                                            # any orphaned mirror
 *   node scripts/generate-translation-status.js --margins     # per locale, the genuine
 *                                                            # translations that came
 *                                                            # closest to a stub verdict
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { assertNotShallow, createFreshnessChecker } from './lib/git-freshness.js';
import { buildEnglishProseHistory, classifyTranslation, translationKey } from './lib/translation-status.js';
import { TREES } from './lib/fences.js';

// A stub verdict is acted on by deleting and re-scaffolding the file (#478), so a wrong one
// destroys work. The aggregate counts cannot be reviewed; this prints the per-file list that
// can. Use it before any bulk remediation.
const SHOW_VERDICTS = process.argv.includes('--verdicts');

// The detector's safety case is a MARGIN — how many novel lines the closest genuine
// translation carries above the scaffold verdict. That was measured once and written into a
// comment, where it rots. This re-measures it on demand, and doubles as the drift alarm the
// comment's "re-measure before lowering the floor" instruction otherwise lacks.
const SHOW_MARGINS = process.argv.includes('--margins');
const MARGIN_COUNT = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const I18N_DIR = resolve(ROOT, 'i18n');

// Load config
const configPath = resolve(I18N_DIR, '_config.yml');
if (!existsSync(configPath)) {
  console.error('ERROR: i18n/_config.yml not found');
  process.exit(1);
}
const config = yaml.load(readFileSync(configPath, 'utf8'));

// Staleness needs full history — see the shared guard for rationale (#279).
assertNotShallow(ROOT);

// Derive source counts from registries (single source of truth)
const skillsRegistry = yaml.load(readFileSync(resolve(ROOT, 'skills/_registry.yml'), 'utf8'));
const agentsRegistry = yaml.load(readFileSync(resolve(ROOT, 'agents/_registry.yml'), 'utf8'));
const teamsRegistryPath = resolve(ROOT, 'teams/_registry.yml');
const teamsRegistry = existsSync(teamsRegistryPath)
  ? yaml.load(readFileSync(teamsRegistryPath, 'utf8'))
  : { total_teams: 0 };
const guidesRegistryPath = resolve(ROOT, 'guides/_registry.yml');
const guidesRegistry = existsSync(guidesRegistryPath)
  ? yaml.load(readFileSync(guidesRegistryPath, 'utf8'))
  : { total_guides: 0 };

const sourceCounts = {
  skills: skillsRegistry.total_skills,
  agents: agentsRegistry.total_agents,
  teams: teamsRegistry.total_teams || 0,
  guides: guidesRegistry.total_guides || 0,
  total: skillsRegistry.total_skills + agentsRegistry.total_agents
    + (teamsRegistry.total_teams || 0) + (guidesRegistry.total_guides || 0)
};

/**
 * Extract source_commit from translation frontmatter.
 */
function extractSourceCommit(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/source_commit:\s*["']?([a-f0-9]+)["']?/m);
  return match ? match[1] : null;
}

// Stub detection lives in ./lib/translation-status.js. It used to be body equality against
// the English source on disk, which stopped being true the moment English was next edited
// (#473) and was defeated outright by an interior `\r` (#532). See that module's header for
// why comparing against the `source_commit` blob does not fix it either.
//
// Built once and reused across all ten locales: two git processes for the whole corpus.
const englishProse = buildEnglishProseHistory(ROOT);

// Batched staleness (#305): one `git log <source_commit>..HEAD` per DISTINCT
// source_commit instead of per-file `git log -1` + `merge-base` spawns.
const freshness = createFreshnessChecker(ROOT);
const toRelPath = (absPath) => absPath.slice(ROOT.length + 1);

/**
 * Resolve English source path.
 */
function resolveSourcePath(contentType, itemPath) {
  if (contentType === 'skills') {
    const skillName = basename(dirname(itemPath));
    return resolve(ROOT, 'skills', skillName, 'SKILL.md');
  } else {
    const fileName = basename(itemPath);
    return resolve(ROOT, contentType, fileName);
  }
}

/**
 * Count translations and stale files for a locale + content type.
 */
function countTranslations(locale, contentType) {
  const typeDir = resolve(I18N_DIR, locale, contentType);
  let translated = 0;
  let stale = 0;
  let stubs = 0;
  // Every non-stub verdict's novel-line count, so `--margins` can report how close the
  // closest genuine translation came to the scaffold verdict. The module header's safety
  // case rests on that margin being 2 lines on the compressed tiers; an instruction to
  // "re-measure before lowering the floor" needs something to re-measure with.
  const margins = [];

  if (!existsSync(typeDir)) {
    return { translated, stale, stubs, margins };
  }

  const entries = readdirSync(typeDir);
  for (const entry of entries) {
    const entryPath = resolve(typeDir, entry);

    let translatedFile;
    let itemId;
    if (contentType === 'skills') {
      if (!statSync(entryPath).isDirectory()) continue;
      translatedFile = resolve(entryPath, 'SKILL.md');
      if (!existsSync(translatedFile)) continue;
      itemId = entry;
    } else {
      if (!entry.endsWith('.md')) continue;
      translatedFile = entryPath;
      itemId = basename(entry, '.md');
    }

    // Keyed through `translationKey`, which defers to `contentKey`, so this cannot drift
    // from the pool's own idea of what an id is. The null branch below is NOT covered by a
    // test: it fires only for a `_`-prefixed or README mirror, and no such file exists in
    // `i18n/` — adding one to the corpus purely as a fixture would be worse than the gap.
    // The derivation itself is covered in `translation-status.test.js`.
    const key = translationKey(contentType, itemId);
    if (key === null) continue;

    const verdict = classifyTranslation({
      translatedText: readFileSync(translatedFile, 'utf8'),
      locale,
      englishLines: englishProse.get(key),
    });
    // `novel` is null when the comparison did not run. Printing `-` rather than `0` keeps
    // the distinction visible in the one list a maintainer reads before deleting files.
    const measured = verdict.novel === null ? '-' : String(verdict.novel);

    if (verdict.stub) {
      stubs++;
      if (SHOW_VERDICTS) {
        console.log(`  STUB      ${locale}/${key}  (${verdict.reason}, ${measured}/${verdict.total} novel)`);
      }
      continue;
    }

    // Surfaced because it is a lenient hole with no counter of its own: a mirror whose id
    // matches no English content in history OR the working tree is counted as translated,
    // and it most likely indicates an orphaned or misspelt directory, which is actionable.
    if (verdict.reason === 'no-source' && SHOW_VERDICTS) {
      console.log(`  NO-SOURCE ${locale}/${key}  (counted as translated — orphaned mirror?)`);
    }
    if (verdict.novel !== null) margins.push({ key, novel: verdict.novel });

    translated++;

    // Computed here rather than above the verdict: the stub path discards it.
    const sourcePath = resolveSourcePath(contentType, translatedFile);
    const sourceCommit = extractSourceCommit(translatedFile);
    if (existsSync(sourcePath) && sourceCommit) {
      if (freshness.isStale(sourceCommit, toRelPath(sourcePath))) {
        stale++;
      }
    }
  }

  return { translated, stale, stubs, margins };
}

// ── Main ─────────────────────────────────────────────────────────

// `TREES`, not a second literal list: `buildEnglishProseHistory` pools from `TREES`, so a
// fifth tree added there but not here would be pooled and never scanned — coverage for it
// silently absent from the YAML, with no error. Same drift class as #519.
const contentTypes = TREES;
const locales = config.supported_locales.map(l => l.code);
const today = new Date().toISOString().split('T')[0];

for (const locale of locales) {
  const localeDir = resolve(I18N_DIR, locale);
  if (!existsSync(localeDir)) {
    console.log(`SKIP: ${locale} (directory not found)`);
    continue;
  }

  const coverage = {};
  let totalTranslated = 0;
  let totalStale = 0;
  let totalStubs = 0;
  const totalSource = sourceCounts.total;

  const localeMargins = [];
  for (const contentType of contentTypes) {
    const startedAt = Date.now();
    const { translated, stale, stubs, margins } = countTranslations(locale, contentType);
    const total = sourceCounts[contentType];
    const pct = total > 0 ? Math.round((translated / total) * 1000) / 10 : 0;
    coverage[contentType] = { translated, total, pct, stale, stubs };
    totalTranslated += translated;
    totalStale += stale;
    totalStubs += stubs;
    localeMargins.push(...margins);
    console.log(`  scan ${locale}/${contentType}: ${translated} translated, ${stale} stale, ${stubs} stubs (${Date.now() - startedAt}ms)`);
  }

  if (SHOW_MARGINS) {
    const closest = localeMargins.sort((a, b) => a.novel - b.novel).slice(0, MARGIN_COUNT);
    console.log(`  margin ${locale}: closest genuine translations to the scaffold verdict — `
      + (closest.length
        ? closest.map((m) => `${m.key}=${m.novel}`).join('  ')
        : 'none (no judged translations)'));
  }

  const totalPct = totalSource > 0
    ? Math.round((totalTranslated / totalSource) * 1000) / 10
    : 0;
  coverage.total = {
    translated: totalTranslated,
    total: totalSource,
    pct: totalPct,
    stale: totalStale,
    stubs: totalStubs,
  };

  const status = {
    locale,
    last_updated: today,
    coverage,
  };

  const statusPath = resolve(localeDir, 'translation_status.yml');
  writeFileSync(statusPath, yaml.dump(status, { flowLevel: 3 }));
  console.log(`GENERATED: ${statusPath.replace(ROOT + '/', '')}`);
  console.log(`  Coverage: ${totalTranslated}/${totalSource} (${totalPct}%), ${totalStale} stale, ${totalStubs} stubs`);
  // Standing hint, not a footnote in a docstring. A stub verdict is remediated by deleting
  // the file, the detector's errors point strict, and `--verdicts` was discoverable only by
  // reading the source — which makes the containment documentation rather than a control.
  if (totalStubs > 0 && !SHOW_VERDICTS) {
    console.log(`  ${totalStubs} stubs — re-run with --verdicts and read the per-file list before any re-scaffold.`);
  }
}
