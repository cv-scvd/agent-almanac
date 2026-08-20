/**
 * The publish gate, read as data (#697).
 *
 * `prepublishOnly` is the last thing that runs before an `npm publish` PUT, and
 * `CLAUDE.md` records that it is *deliberately* redundant with the workflow's
 * "Run tests" step: it runs the CLI suite independently, and must not be removed in
 * favour of that step. Redundancy is the property that makes the gate worth having.
 *
 * Duplicate *spelling* is not the same thing as redundancy, and #697 is what happens
 * when the two are confused. Both scripts used to name `cli/test/cli.test.js`
 * literally, with nothing tying them together:
 *
 *     "test:cli":       "node --test cli/test/cli.test.js",
 *     "prepublishOnly": "node --test cli/test/cli.test.js",
 *
 * Rename or move the suite, update `test:cli`, and `prepublishOnly` still points at a
 * path that no longer exists. `npm publish` would fail there — but loudly in the wrong
 * place, months later, on the one command whose failure mode nobody rehearses. The
 * repair is that the path is named exactly once and `prepublishOnly` delegates, so the
 * two *cannot* say different things.
 *
 * This module reads that arrangement and reports what is wrong with it. It is shared
 * by two consumers so the rule exists once:
 *
 *   - `scripts/assert-publish-gate.js`, wired as npm's `pretest:cli` hook, so the check
 *     runs at publish time on the operator's machine — inside `prepublishOnly` itself,
 *     by way of the delegation.
 *   - `scripts/test/publish-gate.test.js`, so a PR that re-inlines the path goes red in
 *     CI. `ci-scripts.yml` carries no `paths:` filter (#641), so that test sees a
 *     `package.json`-only change; a gate living under a `scripts/**` filter would not.
 *
 * ## What it checks, and why each one
 *
 * The interesting failure is not "the file is missing" — `node --test` says that loudly.
 * It is the two silences #486 names, one of which nobody chose:
 *
 *   1. **A rename updated in one spelling and not the other.** Removed structurally:
 *      exactly one script may name the suite directory. Two again is a failure, whatever
 *      the two say.
 *   2. **A newly added test file that no script names.** `test:cli` names its file
 *      explicitly rather than globbing, which is what makes it fail loudly on a rename
 *      (`test:scripts` globs and so goes vacuously green instead — see
 *      `scripts/test/_assert-suite-nonempty.js`). The cost of naming is that a file
 *      added beside it is simply never run, and every gate stays green. So the named set
 *      is compared against the discovered set, in both directions.
 *
 * Direction matters: named-but-absent is a broken gate, absent-but-present is an unrun
 * test. Both are reported, separately, because the repairs differ.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

/** Scripts whose value names a path under this directory are "naming the CLI suite". */
export const CLI_TEST_DIR = 'cli/test';

/** The one script permitted to name the suite. Everything else must reach it by delegation. */
export const CANONICAL_SCRIPT = 'test:cli';

/** The script npm runs immediately before an `npm publish` PUT. */
export const PUBLISH_HOOK = 'prepublishOnly';

/**
 * Test files a `node --test` invocation would pick up. Kept in one place so the
 * discovered set and the named set are compared under the same definition of "a test".
 */
const TEST_FILE_SUFFIX = '.test.js';

/**
 * Pull the file arguments out of an npm script command line.
 *
 * Deliberately crude: it takes every whitespace-separated token that looks like a path
 * into the CLI test directory, rather than parsing the shell. A parser would be a proxy
 * for the real consumer (the shell, then node's own globber), and this repo's rule is to
 * guard by the consumer's accept-rule or by something strictly broader — never by
 * something narrower that can be stepped around. Broader is safe here: an extra token
 * that is not really a path shows up as named-but-absent, which is a loud failure, not a
 * silent pass.
 */
export function namedTestFiles(command) {
  if (!command) return [];
  return command
    .split(/\s+/)
    .filter((token) => token.includes(`${CLI_TEST_DIR}/`))
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
}

/** Every `*.test.js` actually sitting in the CLI test directory. */
export function discoverTestFiles(repoRoot) {
  const dir = resolve(repoRoot, CLI_TEST_DIR);
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.endsWith(TEST_FILE_SUFFIX))
    .sort()
    .map((name) => `${CLI_TEST_DIR}/${name}`);
}

/**
 * Inspect a repository's publish gate.
 *
 * `scripts` may be passed directly (for fixtures); otherwise it is read from
 * `<repoRoot>/package.json`. Returns `{ problems, ... }` — an empty `problems` array
 * means the gate holds.
 */
export function inspectPublishGate(repoRoot, scripts = null) {
  const pkgScripts = scripts ?? JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
  ).scripts ?? {};

  const problems = [];

  const naming = Object.entries(pkgScripts)
    .filter(([, command]) => namedTestFiles(command).length > 0)
    .map(([name]) => name)
    .sort();

  // 1. The suite path is named exactly once, by the canonical script.
  if (naming.length === 0) {
    problems.push(
      `No script names a suite under ${CLI_TEST_DIR}/. The CLI suite would never run — ` +
      `not by \`npm test\`, and not by \`${PUBLISH_HOOK}\` before a publish.`,
    );
  } else if (naming.length > 1) {
    problems.push(
      `${naming.length} scripts name a suite under ${CLI_TEST_DIR}/ (${naming.join(', ')}). ` +
      `Exactly one may — that is what stops a rename from being applied to one spelling ` +
      `and not the other (#697). Have the others delegate with \`npm run ${CANONICAL_SCRIPT}\`.`,
    );
  } else if (naming[0] !== CANONICAL_SCRIPT) {
    problems.push(
      `The suite is named by "${naming[0]}", not "${CANONICAL_SCRIPT}". Callers delegate to ` +
      `\`npm run ${CANONICAL_SCRIPT}\`, so moving the path elsewhere breaks them silently.`,
    );
  }

  // 2. The publish hook still exists, and reaches the suite by delegation rather than
  //    by spelling the path a second time.
  const hook = pkgScripts[PUBLISH_HOOK];
  if (!hook) {
    problems.push(
      `"${PUBLISH_HOOK}" is missing. It runs the CLI suite independently of the workflow's ` +
      `"Run tests" step, and CLAUDE.md records that this redundancy is deliberate (#680) — ` +
      `it must not be removed in favour of the step.`,
    );
  } else if (namedTestFiles(hook).length > 0) {
    problems.push(
      `"${PUBLISH_HOOK}" spells a suite path itself ("${hook}"). It must delegate — ` +
      `\`npm run ${CANONICAL_SCRIPT}\` — so the two cannot drift apart (#697).`,
    );
  } else if (!hook.includes(CANONICAL_SCRIPT)) {
    problems.push(
      `"${PUBLISH_HOOK}" ("${hook}") does not reach "${CANONICAL_SCRIPT}". The last gate ` +
      `before an npm publish PUT would not run the CLI suite.`,
    );
  }

  // 3. `npm test`, the release gate, still runs the CLI suite too. The redundancy is
  //    the point: this is the other half of the pair #680 established.
  const aggregate = pkgScripts.test;
  if (!aggregate || !aggregate.includes(CANONICAL_SCRIPT)) {
    problems.push(
      `"test" ("${aggregate ?? '<missing>'}") does not run "${CANONICAL_SCRIPT}". ` +
      `\`npm test\` is the release gate; #680 is what happens when it skips a suite.`,
    );
  }

  // 4. Named set versus discovered set, both directions.
  const named = namedTestFiles(pkgScripts[CANONICAL_SCRIPT] ?? '');
  const discovered = discoverTestFiles(repoRoot);

  if (discovered === null) {
    problems.push(
      `${CLI_TEST_DIR}/ does not exist. Whatever "${CANONICAL_SCRIPT}" names cannot be there.`,
    );
  } else {
    for (const file of named) {
      if (!existsSync(resolve(repoRoot, file))) {
        problems.push(
          `"${CANONICAL_SCRIPT}" names ${file}, which does not exist. The publish gate ` +
          `resolves to nothing.`,
        );
      }
    }
    for (const file of discovered) {
      if (!named.includes(file)) {
        problems.push(
          `${file} exists but no script names it, so it never runs. "${CANONICAL_SCRIPT}" ` +
          `names its files explicitly — which fails loudly on a rename, and skips a newly ` +
          `added file in silence (#486). Add it, or delete it.`,
        );
      }
    }
    if (discovered.length === 0) {
      problems.push(
        `${CLI_TEST_DIR}/ holds no ${TEST_FILE_SUFFIX} files. The publish gate would run ` +
        `nothing.`,
      );
    }
  }

  return { problems, naming, hook, named, discovered };
}

/** Locate the repository root from this file, without shelling out to git. */
export function repoRootFromHere(metaUrl) {
  const here = dirname(new URL(metaUrl).pathname);
  let cur = here;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, 'package.json')) && existsSync(join(cur, '.git'))) return cur;
    cur = dirname(cur);
  }
  return resolve(here, '..', '..');
}
