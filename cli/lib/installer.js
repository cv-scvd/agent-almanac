/**
 * installer.js — Orchestrate install/uninstall across adapters.
 *
 * Takes resolved items and a set of adapters, runs install/uninstall on each,
 * collects and returns results.
 */

import { warn } from './reporter.js';

/**
 * Warn once per adapter when the requested scope will not be honoured (#607).
 *
 * Most adapters install to exactly one place regardless of `--scope`: some
 * always global (a home directory), some always project (a path under
 * projectDir). Before this they accepted the flag and ignored it silently, so
 * `--scope project -f hermes` printed a successful install at a global path,
 * and `--scope global -f cursor` wrote into the project. The dry-run output
 * presented the wrong scope's path as though the request had been honoured,
 * which is the shape that makes the silence expensive: the one command a
 * caller runs to CHECK the destination confirmed the wrong one.
 *
 * This reports; it does not redirect. Which scope an adapter uses is the
 * adapter's own decision and is unchanged — the defect was never that hermes
 * installs globally, it was that nothing said so.
 *
 * Called once per run rather than once per item: a scope mismatch is a
 * property of the adapter and the run, not of the item being installed, so
 * per-item warnings would repeat the same line N times.
 *
 * @param {import('../adapters/base.js').FrameworkAdapter[]} adapters
 * @param {string} scope - The requested scope
 * @returns {void}
 */
export function warnUnsupportedScopes(adapters, scope) {
  for (const adapter of adapters) {
    // An adapter is not required to extend FrameworkAdapter — the registry
    // accepts anything with the right methods, and the #439 tests use bare
    // duck-typed classes. Calling supportsScope() unguarded threw
    // `adapter.supportsScope is not a function` from here, which runs BEFORE
    // auditAll()'s try/catch: a third-party adapter predating this field would
    // have made `almanac audit` throw outright instead of being recorded as
    // `crashed`, defeating the very guarantee #439 added. Skipping is the
    // pre-#607 behaviour for such an adapter — no warning — which is a gap,
    // not a regression.
    if (typeof adapter.supportsScope !== 'function') continue;
    if (adapter.supportsScope(scope)) continue;

    const { displayName, scopes } = adapter.constructor;
    const effective = adapter.effectiveScope(scope);

    if (effective !== null) {
      warn(`${displayName} is ${effective}-only; --scope ${scope} ignored (installing to ${effective}).`);
    } else {
      // No single destination to name — say what it does support instead of
      // inventing one. Unreachable for every adapter shipped today, all of
      // which declare either one scope or both; it exists so a future adapter
      // with a partial set cannot fall through to silence.
      warn(`${displayName} does not support --scope ${scope} (supports: ${scopes.join(', ')}).`);
    }
  }
}

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

  warnUnsupportedScopes(adapters, scope);

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

  warnUnsupportedScopes(adapters, scope);

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

  // The audit path carries the same silence as the install path, and its
  // symptom is more confusing: auditing at a scope the adapter never uses
  // reports "nothing installed" for content that IS installed, somewhere else.
  // A warning here is output only — it does not touch auditExitCode.
  warnUnsupportedScopes(adapters, scope);

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
