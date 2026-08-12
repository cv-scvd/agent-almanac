/**
 * readme-sections.js — the pure parts of README generation (#566).
 *
 * `scripts/generate-readmes.js` writes nine committed files and had NO unit test, because it
 * is not merely untested — it is *unimportable*. It reads the registries at module scope and
 * runs its MANAGED loop at module scope, so importing it from a test reads the real registries
 * and WRITES ALL NINE FILES (`CHECK_MODE` is false unless `--check` is in `process.argv`,
 * which a test runner's argv lacks). The seam therefore has to be extract-to-lib, never
 * import-the-script.
 *
 * Confirmed cost of that gap: deleting the core line of #560's fix left the entire suite green
 * (`MUTANT SURVIVED`). Only CI-time artifact comparison caught it.
 *
 * `MANAGED` deliberately stays in `generate-readmes.js`, at column 0 and unexported: integrity
 * check A8 static-parses that block by literal path with sed, and it reports "could not derive
 * generated files" — failing closed, but without distinguishing "moved" from "reformatted".
 *
 * Zero imports, so this module is safe to reach from anywhere including the no-`npm ci`
 * integrity job. That is a property to preserve, not an accident. (Note the constraint binds
 * what `validate-integrity.yml` INVOKES; `ci-scripts.yml` does run `npm ci`, so the tests of
 * this module may use dependencies freely.)
 */

/** Marker suffix a translations cell carries when the generator fell back to file counting. */
export const FALLBACK_MARK = '*';

/** Rendered where a number was not measured. Never `0`, which reads as "none". */
export const UNMEASURED = '-';

/**
 * Replace the body between a section's AUTO markers.
 *
 * Returns `matched: false` rather than throwing or warning, so the caller decides the policy.
 * That distinction is load-bearing: this used to `console.warn` and return the content
 * unchanged, which made `--check` compute "no change" and exit 0 on a warning nobody reads in
 * a green job. Deleting a marker pair was permanent silent drift — the section stopped being
 * generated for good, and the auto-commit healer took the same path, so nothing could repair
 * it either.
 *
 * @param {string} content    full file text
 * @param {string} sectionName the AUTO marker name
 * @param {string} newInner   replacement body, without surrounding newlines
 * @returns {{content: string, matched: boolean}}
 */
export function replaceSection(content, sectionName, newInner) {
  const startTag = `<!-- AUTO:START:${sectionName} -->`;
  const endTag = `<!-- AUTO:END:${sectionName} -->`;
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    return { content, matched: false };
  }
  const before = content.slice(0, startIdx + startTag.length);
  const after = content.slice(endIdx);
  return { content: `${before}\n${newInner}\n${after}`, matched: true };
}

/**
 * Render the translations coverage table from already-loaded per-locale data.
 *
 * The function #560 fixed and #566 exists to make testable. It takes records rather than
 * reading the filesystem, so a test can hand it a locale with a status file, one without, and
 * one with a partial file, and assert the rendered row — which is what nothing could do while
 * this logic lived inside an unimportable script.
 *
 * The measured-vs-fallback PREDICATE stays in here, deliberately. Splitting it — caller
 * decides which branch, renderer formats it — is the guard-proxy-predicate anti-pattern this
 * repo has already been bitten by: the two copies drift, and the gate ends up asserting
 * something adjacent to what the consumer actually does.
 *
 * Every measured figure is rendered VERBATIM from the status file, denominators and `pct`
 * included. Recomputing `pct` here with different rounding than
 * `generate-translation-status.js` would be #560's two-derivations defect rebuilt inside a
 * single cell.
 *
 * @param {Array<{code: string, name: string, coverage: object|null,
 *   fallback: {counts: Record<string, number>, total: number}}>} locales
 * @param {{skills: number, agents: number, teams: number, guides: number, total: number}} sourceCounts
 * @param {string[]} contentTypes
 * @returns {string} the markdown table, plus a footnote when any row fell back
 */
export function renderTranslationsTable(locales, sourceCounts, contentTypes) {
  const rows = [
    '| Locale | Language | Skills | Agents | Teams | Guides | Total | Stubs | Unjudged |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  let anyFallback = false;

  for (const locale of locales) {
    const { coverage } = locale;
    if (coverage && contentTypes.every((ct) => coverage[ct]) && coverage.total) {
      const cell = (ct) => `${coverage[ct].translated}/${coverage[ct].total}`;
      const t = coverage.total;
      rows.push(
        `| ${locale.code} | ${locale.name} | ${cell('skills')} | ${cell('agents')} | `
        + `${cell('teams')} | ${cell('guides')} | ${t.translated}/${t.total} (${t.pct}%) | `
        + `${t.stubs} | ${t.unjudged} |`,
      );
      continue;
    }

    anyFallback = true;
    const { counts, total } = locale.fallback;
    const m = FALLBACK_MARK;
    const pct = sourceCounts.total > 0 ? Math.round((total / sourceCounts.total) * 1000) / 10 : 0;
    rows.push(
      `| ${locale.code} | ${locale.name} | ${counts.skills}/${sourceCounts.skills}${m} | `
      + `${counts.agents}/${sourceCounts.agents}${m} | ${counts.teams}/${sourceCounts.teams}${m} | `
      + `${counts.guides}/${sourceCounts.guides}${m} | ${total}/${sourceCounts.total} (${pct}%)${m} | `
      + `${UNMEASURED} | ${UNMEASURED} |`,
    );
  }

  if (anyFallback) {
    rows.push('');
    rows.push(
      `${FALLBACK_MARK} File count, not a measurement -- this locale has no `
      + '`translation_status.yml`. Run `npm run translation:status` to measure it.',
    );
  }

  return rows.join('\n');
}
