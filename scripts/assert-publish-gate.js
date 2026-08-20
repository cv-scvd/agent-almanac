#!/usr/bin/env node
/**
 * Assert that the publish gate is wired such that it cannot silently resolve to nothing.
 *
 * Wired as npm's `pretest:cli` hook, so it runs before the CLI suite on every
 * `npm run test:cli` — and therefore also inside `prepublishOnly`, which delegates to
 * that script. The check is on the operator's machine, immediately before the
 * `npm publish` PUT, which is the moment it exists for.
 *
 * The rule itself lives in `scripts/lib/publish-gate.js`, shared with
 * `scripts/test/publish-gate.test.js`. Writing it twice would reintroduce exactly the
 * duplicate-spelling defect (#697) this is here to prevent.
 */
import { inspectPublishGate, repoRootFromHere } from './lib/publish-gate.js';

const repoRoot = repoRootFromHere(import.meta.url);
const { problems, naming, named } = inspectPublishGate(repoRoot);

if (problems.length > 0) {
  console.error('ERROR: the publish gate is not wired safely.\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nThis runs as `pretest:cli`, so it also guards `prepublishOnly` — the last check ' +
    'before an npm publish PUT.',
  );
  process.exit(1);
}

console.log(
  `publish gate: ${named.length} CLI suite file(s) named once, by "${naming[0]}"; ` +
  'prepublishOnly delegates.',
);
