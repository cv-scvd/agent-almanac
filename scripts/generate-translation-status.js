#!/usr/bin/env node
/**
 * generate-translation-status.js
 *
 * Auto-generates per-locale translation_status.yml files by counting
 * translated files and checking freshness against English sources.
 *
 * Usage:
 *   node scripts/generate-translation-status.js
 *   node scripts/generate-translation-status.js --verdicts   # also list every stub, with
 *                                                            # the reason and line counts
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { assertNotShallow, createFreshnessChecker } from './lib/git-freshness.js';
import { buildEnglishProseHistory, classifyTranslation, translationKey } from './lib/translation-status.js';

// A stub verdict is acted on by deleting and re-scaffolding the file (#478), so a wrong one
// destroys work. The aggregate counts cannot be reviewed; this prints the per-file list that
// can. Use it before any bulk remediation.
const SHOW_VERDICTS = process.argv.includes('--verdicts');

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

  if (!existsSync(typeDir)) {
    return { translated, stale, stubs };
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
    if (verdict.stub) {
      stubs++;
      if (SHOW_VERDICTS) {
        console.log(`  STUB ${locale}/${key}  (${verdict.reason}, ${verdict.foreign}/${verdict.total} foreign)`);
      }
      continue;
    }

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

  return { translated, stale, stubs };
}

// ── Main ─────────────────────────────────────────────────────────

const contentTypes = ['skills', 'agents', 'teams', 'guides'];
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

  for (const contentType of contentTypes) {
    const startedAt = Date.now();
    const { translated, stale, stubs } = countTranslations(locale, contentType);
    const total = sourceCounts[contentType];
    const pct = total > 0 ? Math.round((translated / total) * 1000) / 10 : 0;
    coverage[contentType] = { translated, total, pct, stale, stubs };
    totalTranslated += translated;
    totalStale += stale;
    totalStubs += stubs;
    console.log(`  scan ${locale}/${contentType}: ${translated} translated, ${stale} stale, ${stubs} stubs (${Date.now() - startedAt}ms)`);
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
}
