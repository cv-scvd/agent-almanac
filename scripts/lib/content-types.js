/**
 * content-types.js — the single source of truth for the four content trees (#568).
 *
 * The list `['skills', 'agents', 'teams', 'guides']` was a hardcoded literal in three places
 * that must agree: `TREES` in `lib/fences.js` (which drives the git pathspec and every
 * `coverage.*` section), `contentTypes` in `generate-readmes.js` (the README table's columns),
 * and `CONTENT_TYPES` in `check-readme-translation-parity.js` (integrity check B13's per-type
 * comparison).
 *
 * The drift is quiet rather than loud. Add a fifth tree and `coverage.total` starts including
 * it while the table gains no column and B13 compares only the four it knows — totals still
 * add up, so nothing *lies* and nothing goes red. A gate that stays green while ignoring a
 * whole content tree is the failure this repo keeps rediscovering.
 *
 * ## ZERO IMPORTS, BY CONSTRUCTION — do not add one
 *
 * `check-readme-translation-parity.js` is imported by integrity check B13, and
 * `.github/workflows/validate-integrity.yml` runs with `setup-node` but deliberately NO
 * `npm ci` (the constraint A8 documents). So B13 must reach nothing outside node builtins,
 * *transitively*. A single `import` added here would break B13 in CI only — green on every
 * developer machine, where `node_modules` exists — which is the worst shape a break can have.
 *
 * `lib/fences.js` is itself dependency-free today and was the obvious host, but it is a
 * 293-line module with six consumers and git/spawn helpers; making B13's CI-only constraint
 * depend on it means the day someone adds a YAML import there, B13 dies at module resolution
 * and nothing local notices. A leaf module cannot acquire that liability.
 *
 * `scripts/test/dependency-free.test.js` enforces this, so the property is checkable rather
 * than merely asserted here.
 */

export const CONTENT_TYPES = ['skills', 'agents', 'teams', 'guides'];
