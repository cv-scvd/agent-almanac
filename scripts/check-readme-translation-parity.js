#!/usr/bin/env node
/**
 * Cross-surface parity gate: the published README translation table vs the
 * per-locale i18n/<code>/translation_status.yml files (#560).
 *
 * These are the project's two reader-facing statements of the same fact, and
 * until #560 they were independent derivations: generate-readmes.js counted
 * files with readdirSync/existsSync while generate-translation-status.js
 * judged each file's content. Every README cell was therefore
 * `translated + stubs` -- the README said `de 383/500 (76.6%)` where the
 * status files said `347/500 (69.4%)`. Nothing could catch it: check-readmes
 * regenerates the table with the same generator and compares it against
 * itself, so it agrees with any generator bug.
 *
 * This check deliberately does NOT call the generator. It parses the two
 * COMMITTED artifacts and compares them. That is what makes it able to see a
 * reintroduced existence count: a regenerate-and-compare gate would render
 * 366, read 366, and pass.
 *
 * Dependency-free on purpose: validate-integrity.yml runs the integrity
 * script with no `npm ci`, and A8 documents keeping that parse free of
 * js-yaml. The two YAML inputs are machine-generated with a fixed shape, so a
 * shape-restricted parser is honest here -- and it fails closed (exit 2)
 * rather than guessing whenever the shape is not the one it knows.
 *
 * Exit codes:
 *   0  the two surfaces agree
 *   1  they disagree (the defect this exists to catch)
 *   2  the comparison could not be made at all (missing markers, unparseable
 *      input, no locales) -- never read this as a pass
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONTENT_TYPES = ['skills', 'agents', 'teams', 'guides'];

/** Marker suffix a cell carries when the generator fell back to file counting. */
export const FALLBACK_MARK = '*';

/** Rendered when a number was not measured (never `0`, which reads as "none"). */
export const UNMEASURED = '-';

/**
 * Locale codes and display names from i18n/_config.yml.
 *
 * Shape-restricted to the `supported_locales:` block's `- code:` / `name:`
 * pairs. Anything else throws rather than returning a short list -- a
 * silently-truncated locale list would make the row-set comparison below
 * pass by not looking.
 */
export function parseLocales(configText) {
  const lines = configText.split('\n');
  const start = lines.findIndex((l) => /^supported_locales:\s*$/.test(l));
  if (start === -1) throw new Error('i18n/_config.yml: no `supported_locales:` block');

  const locales = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (/^\S/.test(line)) break; // dedented out of the block
    if (/^\s*$/.test(line)) continue;
    const code = line.match(/^\s*-\s+code:\s*(\S+)\s*$/);
    if (code) {
      locales.push({ code: code[1], name: null });
      continue;
    }
    const name = line.match(/^\s*name:\s*(.+?)\s*$/);
    if (name && locales.length) {
      if (locales[locales.length - 1].name === null) {
        locales[locales.length - 1].name = name[1];
      }
      continue;
    }
    if (/^\s*(name_en|status):/.test(line)) continue;
    throw new Error(`i18n/_config.yml: unrecognised line in supported_locales: ${JSON.stringify(line)}`);
  }
  if (!locales.length) throw new Error('i18n/_config.yml: supported_locales is empty');
  for (const l of locales) {
    if (!l.name) throw new Error(`i18n/_config.yml: locale '${l.code}' has no name`);
  }
  return locales;
}

/**
 * `coverage:` numbers from one translation_status.yml.
 *
 * Returns { skills|agents|teams|guides|total: { translated, total, pct, stubs } }
 * with pct kept as the VERBATIM string from the file. Re-deriving it here with
 * different rounding than generate-translation-status.js would be the
 * two-derivations defect reborn inside one cell.
 */
export function parseStatus(statusText) {
  const lines = statusText.split('\n').map((l) => l.replace(/\r$/, ''));
  const start = lines.findIndex((l) => /^coverage:\s*$/.test(l));
  if (start === -1) throw new Error('translation_status.yml: no `coverage:` block');

  const coverage = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    if (/^\s*$/.test(line)) continue;
    const section = line.match(/^ {2}(\w[\w-]*):\s*$/);
    if (section) {
      current = section[1];
      coverage[current] = {};
      continue;
    }
    const field = line.match(/^ {4}(\w+):\s*(\S+)\s*$/);
    if (field && current) {
      coverage[current][field[1]] = field[2];
      continue;
    }
    throw new Error(`translation_status.yml: unrecognised line in coverage: ${JSON.stringify(line)}`);
  }

  for (const key of [...CONTENT_TYPES, 'total']) {
    if (!coverage[key]) throw new Error(`translation_status.yml: coverage.${key} missing`);
    for (const field of ['translated', 'total', 'pct', 'stubs']) {
      if (coverage[key][field] === undefined) {
        throw new Error(`translation_status.yml: coverage.${key}.${field} missing`);
      }
    }
  }
  return coverage;
}

/**
 * Rows of the README's AUTO:translations table, keyed by locale code.
 *
 * A malformed row is an error, not a skip: a row this parser cannot read is a
 * row it cannot compare, and skipping it would report agreement it never
 * established.
 */
export function parseReadmeTable(readmeText, markerName = 'translations') {
  const open = `<!-- AUTO:START:${markerName} -->`;
  const close = `<!-- AUTO:END:${markerName} -->`;
  const from = readmeText.indexOf(open);
  const to = readmeText.indexOf(close);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`README: AUTO:${markerName} markers missing or inverted`);
  }

  const block = readmeText.slice(from + open.length, to);
  const rows = new Map();
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells.length) continue;
    if (/^-+$/.test(cells[0]) || cells[0] === 'Locale') continue; // header / separator
    if (cells.length !== 8) {
      throw new Error(`README: translations row has ${cells.length} cells, expected 8: ${JSON.stringify(line)}`);
    }
    const [code, name, skills, agents, teams, guides, total, stubs] = cells;
    if (rows.has(code)) throw new Error(`README: duplicate translations row for locale '${code}'`);
    rows.set(code, { code, name, skills, agents, teams, guides, total, stubs });
  }
  if (!rows.size) throw new Error('README: AUTO:translations block contains no data rows');
  return rows;
}

/** `340/369` (optionally marked) -> { translated, total, fallback }. */
function parseRatioCell(cell, label) {
  const fallback = cell.endsWith(FALLBACK_MARK);
  const bare = fallback ? cell.slice(0, -FALLBACK_MARK.length) : cell;
  const m = bare.match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error(`README: cell '${label}' is not N/M: ${JSON.stringify(cell)}`);
  return { translated: m[1], total: m[2], fallback };
}

/** `347/500 (69.4%)` (optionally marked) -> { translated, total, pct, fallback }. */
function parseTotalCell(cell) {
  const fallback = cell.endsWith(FALLBACK_MARK);
  const bare = fallback ? cell.slice(0, -FALLBACK_MARK.length) : cell;
  const m = bare.match(/^(\d+)\/(\d+)\s+\((\d+(?:\.\d+)?)%\)$/);
  if (!m) throw new Error(`README: total cell is not 'N/M (P%)': ${JSON.stringify(cell)}`);
  return { translated: m[1], total: m[2], pct: m[3], fallback };
}

/**
 * Compare the parsed surfaces. Pure: takes already-read text so the unit
 * tests exercise the same code path CI does, on fixtures rather than the repo.
 *
 * `statusTexts` maps locale code -> file text, or to `null` when that locale
 * has no status file on disk.
 */
export function compareSurfaces({ locales, readmeRows, statusTexts }) {
  const failures = [];
  const seen = new Set();

  for (const locale of locales) {
    const { code } = locale;
    seen.add(code);
    const row = readmeRows.get(code);
    if (!row) {
      // Iterating locales (not README rows) is what lets a DELETED row be
      // seen at all; a loop over rows can only ever check what is present.
      failures.push(`locale '${code}' is in i18n/_config.yml but has no row in the README translations table`);
      continue;
    }

    const statusText = statusTexts.get(code);
    let coverage = null;
    if (statusText != null) {
      try {
        coverage = parseStatus(statusText);
      } catch (err) {
        failures.push(`locale '${code}': ${err.message}`);
        continue;
      }
    }

    let cells;
    try {
      cells = {
        skills: parseRatioCell(row.skills, `${code}.skills`),
        agents: parseRatioCell(row.agents, `${code}.agents`),
        teams: parseRatioCell(row.teams, `${code}.teams`),
        guides: parseRatioCell(row.guides, `${code}.guides`),
        total: parseTotalCell(row.total)
      };
    } catch (err) {
      failures.push(err.message);
      continue;
    }

    const marked = Object.values(cells).some((c) => c.fallback);

    if (coverage === null) {
      // No status file: the fallback count is the only number available, and
      // the table must say so rather than presenting it as measured.
      if (!marked) {
        failures.push(
          `locale '${code}' has no i18n/${code}/translation_status.yml, so its README numbers are a file count, ` +
          `but the row is not marked '${FALLBACK_MARK}' -- an unmeasured number is presented as measured`
        );
      }
      if (row.stubs !== UNMEASURED) {
        failures.push(`locale '${code}' has no status file, so stubs is unmeasured; expected '${UNMEASURED}', README says '${row.stubs}'`);
      }
      continue;
    }

    // A status file exists, so nothing may be marked as a fallback: a marked
    // cell here means the generator silently fell back with real data on disk.
    if (marked) {
      failures.push(
        `locale '${code}' has a translation_status.yml but its README row is marked '${FALLBACK_MARK}' ` +
        `(the generator fell back to file counting while measured numbers exist)`
      );
      continue;
    }

    for (const ct of CONTENT_TYPES) {
      const expected = coverage[ct];
      const actual = cells[ct];
      if (actual.translated !== String(expected.translated)) {
        failures.push(
          `${code}.${ct}: README says translated=${actual.translated}, ` +
          `i18n/${code}/translation_status.yml says ${expected.translated} ` +
          `(stubs=${expected.stubs}; ${Number(expected.translated) + Number(expected.stubs)} would be an existence count)`
        );
      }
      if (actual.total !== String(expected.total)) {
        failures.push(`${code}.${ct}: README denominator ${actual.total} != status total ${expected.total}`);
      }
    }

    const expectedTotal = coverage.total;
    if (cells.total.translated !== String(expectedTotal.translated)) {
      failures.push(
        `${code}.total: README says translated=${cells.total.translated}, ` +
        `status says ${expectedTotal.translated} ` +
        `(stubs=${expectedTotal.stubs}; ${Number(expectedTotal.translated) + Number(expectedTotal.stubs)} would be an existence count)`
      );
    }
    if (cells.total.total !== String(expectedTotal.total)) {
      failures.push(`${code}.total: README denominator ${cells.total.total} != status total ${expectedTotal.total}`);
    }
    if (cells.total.pct !== String(expectedTotal.pct)) {
      failures.push(`${code}.total: README pct ${cells.total.pct}% != status pct ${expectedTotal.pct}%`);
    }
    if (row.stubs !== String(expectedTotal.stubs)) {
      failures.push(`${code}: README stubs column ${row.stubs} != status stubs ${expectedTotal.stubs}`);
    }
    if (row.name !== locale.name) {
      failures.push(`${code}: README language '${row.name}' != i18n/_config.yml name '${locale.name}'`);
    }
  }

  // Reverse containment: a row for a locale the config does not list.
  for (const code of readmeRows.keys()) {
    if (!seen.has(code)) {
      failures.push(`README translations table has a row for '${code}', which is not a supported locale in i18n/_config.yml`);
    }
  }

  return { failures, checked: locales.length };
}

function main() {
  let locales;
  let readmeRows;
  const statusTexts = new Map();
  try {
    locales = parseLocales(readFileSync(resolve(ROOT, 'i18n/_config.yml'), 'utf8'));
    readmeRows = parseReadmeTable(readFileSync(resolve(ROOT, 'README.md'), 'utf8'));
    for (const { code } of locales) {
      const p = resolve(ROOT, `i18n/${code}/translation_status.yml`);
      statusTexts.set(code, existsSync(p) ? readFileSync(p, 'utf8') : null);
    }
  } catch (err) {
    console.error(`FAIL: README/translation-status parity could not be evaluated: ${err.message}`);
    console.error('       (exit 2 -- this is not a pass)');
    process.exit(2);
  }

  const { failures, checked } = compareSurfaces({ locales, readmeRows, statusTexts });
  if (failures.length) {
    console.error(`FAIL: README translations table disagrees with i18n/*/translation_status.yml (${failures.length} discrepancies across ${checked} locales)`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('  Fix: npm run update-readmes (after npm run translation:status), then commit both.');
    process.exit(1);
  }
  console.log(`OK: README translations table matches i18n/*/translation_status.yml for all ${checked} locales`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
