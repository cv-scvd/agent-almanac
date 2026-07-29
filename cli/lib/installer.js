/**
 * installer.js — Orchestrate install/uninstall across adapters.
 *
 * Takes resolved items and a set of adapters, runs install/uninstall on each,
 * collects and returns results.
 */

import { warn } from './reporter.js';

/**
 * Install items across all adapters.
 * @param {object} resolved - { skills, agents, teams } from resolveItems()
 * @param {import('../adapters/base.js').FrameworkAdapter[]} adapters
 * @param {string} projectDir
 * @param {string} scope
 * @param {object} options - { dryRun, force, almanacRoot }
 * @returns {Promise<object[]>} Array of result objects
 */
export async function installAll(resolved, adapters, projectDir, scope, options) {
  const results = [];

  const allItems = [
    ...resolved.skills,
    ...resolved.agents,
    ...resolved.teams,
  ];

  for (const item of allItems) {
    if (item.unknown) {
      results.push({
        item,
        adapter: '—',
        action: 'skipped',
        path: '',
        error: `Unknown item: ${item.id}`,
      });
      continue;
    }

    for (const adapter of adapters) {
      if (!adapter.supports(item.type)) {
        // Warn once for non-skill types on skills-only adapters
        if (item.type !== 'skill' && adapter.constructor.id !== 'universal') {
          warn(`${item.type}s not supported by ${adapter.constructor.displayName}. Skipping ${item.id}.`);
        }
        continue;
      }

      try {
        const result = await adapter.install(item, projectDir, scope, options);
        results.push({
          item,
          adapter: adapter.constructor.id,
          ...result,
        });
      } catch (err) {
        results.push({
          item,
          adapter: adapter.constructor.id,
          action: 'failed',
          path: '',
          error: err.message,
        });
      }
    }
  }

  return results;
}

/**
 * Uninstall items across all adapters.
 * @param {object} resolved - { skills, agents, teams }
 * @param {import('../adapters/base.js').FrameworkAdapter[]} adapters
 * @param {string} projectDir
 * @param {string} scope
 * @param {object} options - { dryRun }
 * @returns {Promise<object[]>}
 */
export async function uninstallAll(resolved, adapters, projectDir, scope, options) {
  const results = [];

  const allItems = [
    ...resolved.skills,
    ...resolved.agents,
    ...resolved.teams,
  ];

  for (const item of allItems) {
    for (const adapter of adapters) {
      if (!adapter.supports(item.type)) continue;

      try {
        const result = await adapter.uninstall(item, projectDir, scope, options);
        results.push({
          item,
          adapter: adapter.constructor.id,
          ...result,
        });
      } catch (err) {
        results.push({
          item,
          adapter: adapter.constructor.id,
          action: 'failed',
          path: '',
          error: err.message,
        });
      }
    }
  }

  return results;
}

/**
 * Audit all adapters.
 *
 * A crash and a finding are different kinds of result: a finding means the
 * adapter ran and reported something, while a crash means it produced no
 * verdict at all — so a fully broken install reads as "nothing installed,
 * nothing wrong" (#365). `crashed` carries that distinction structurally, so
 * callers never have to match on the `Audit failed:` message prefix (#439).
 *
 * @param {import('../adapters/base.js').FrameworkAdapter[]} adapters
 * @param {string} projectDir
 * @param {string} scope
 * @returns {Promise<import('../adapters/base.js').AuditEntry[]>}
 */
export async function auditAll(adapters, projectDir, scope) {
  const results = [];
  for (const adapter of adapters) {
    try {
      const result = await adapter.audit(projectDir, scope);
      // Normalised here rather than in all 14 adapters: returning from audit()
      // is what proves the adapter ran to completion, so this is the only place
      // that can set the flag authoritatively.
      results.push({ ...result, crashed: false });
    } catch (err) {
      results.push({
        framework: adapter.constructor.displayName,
        ok: [],
        warnings: [],
        errors: [`Audit failed: ${err.message}`],
        crashed: true,
        error: err,
      });
    }
  }
  return results;
}

/**
 * Exit codes for `audit` (#439).
 *
 * 1 is deliberately absent. It already means "usage or loader error": getContext()
 * exits 1 for an undetectable almanac root and for an unknown --framework, and node
 * itself exits 1 with ERR_MODULE_NOT_FOUND when the CLI's deps are missing. Reusing
 * it would leave automation unable to tell "the CLI is not installed here" from
 * "your install is broken" — the ambiguity that made check B11 unfixable (#443).
 */
export const AUDIT_EXIT = {
  CLEAN: 0,
  CRASHED: 2,
  FINDINGS: 3,
};

/**
 * Reduce audit results to a process exit code.
 *
 * A crash outranks a finding: a finding is a completed audit that found
 * something, while a crash means that framework has no verdict at all, so it is
 * the more urgent thing to report. Warnings never affect the code — they
 * describe ordinary states such as "No Copilot skills installed", so failing on
 * them would make a machine with one framework installed exit non-zero for
 * every other adapter.
 *
 * An empty result set is CLEAN. "Nothing was detected" is surfaced by the
 * command as a warning rather than a failure, since a fresh clone with nothing
 * installed yet is a legitimate state.
 *
 * @param {import('../adapters/base.js').AuditEntry[]} results
 * @returns {number}
 */
export function auditExitCode(results) {
  if (results.some((r) => r.crashed)) return AUDIT_EXIT.CRASHED;
  if (results.some((r) => (r.errors || []).length > 0)) return AUDIT_EXIT.FINDINGS;
  return AUDIT_EXIT.CLEAN;
}
