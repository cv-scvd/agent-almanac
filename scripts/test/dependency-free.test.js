/**
 * The dependency-free constraint, made checkable (#568).
 *
 * `scripts/check-readme-translation-parity.js` is invoked by integrity check B13, and
 * `.github/workflows/validate-integrity.yml` runs with `setup-node` but deliberately NO
 * `npm ci` — the constraint A8 documents. So that file's TRANSITIVE import closure must stay
 * inside node builtins.
 *
 * Nothing else can see a violation. Locally `node_modules` exists, so the checker runs fine
 * and every other gate stays green; the failure appears only in CI, as
 * `ERR_MODULE_NOT_FOUND`, in a job whose other checks are unrelated. Measured on a scratch
 * clone: adding `import 'js-yaml'` to the checker left the whole suite passing except for one
 * failure that was present identically WITHOUT the mutation — i.e. no signal at all — while
 * the same file exits 1 the moment `node_modules` is removed.
 *
 * The walker is static (regex over specifiers) rather than a real resolver, because the
 * question is "what would node try to resolve", not "what does it resolve to here". It
 * refuses to report clean when it meets a dynamic `import(` whose argument it cannot read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `node:fs` and bare `fs` are both builtins; anything else bare is a package. */
const BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'console', 'crypto', 'events', 'fs', 'http', 'https',
  'os', 'path', 'process', 'readline', 'stream', 'string_decoder', 'timers', 'tty', 'url',
  'util', 'worker_threads', 'zlib',
]);

const isBuiltin = (spec) => spec.startsWith('node:') || BUILTINS.has(spec);

/**
 * Every module specifier `file` mentions statically.
 *
 * Covers `import ... from 'x'`, `export ... from 'x'`, bare `import 'x'`, and literal
 * `import('x')` / `require('x')`.
 */
function specifiersOf(source) {
  const found = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

/**
 * Walk the relative import graph from `entry`.
 *
 * @returns {{files: string[], external: string[], dynamic: number}}
 */
function walk(entry) {
  const seen = new Set();
  const external = [];
  let dynamic = 0;
  const queue = [resolve(SCRIPTS, entry)];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');

    // A dynamic import whose argument is not a literal defeats static analysis. Count it, so
    // "clean" can never mean "I could not tell".
    for (const m of source.matchAll(/\bimport\s*\(\s*([^'")\s])/g)) { void m; dynamic += 1; }

    for (const spec of specifiersOf(source)) {
      if (isBuiltin(spec)) continue;
      if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      external.push(`${file.slice(SCRIPTS.length + 1)} -> ${spec}`);
    }
  }
  return { files: [...seen], external, dynamic };
}

test('the parity checker reaches nothing outside node builtins', () => {
  const { files, external, dynamic } = walk('check-readme-translation-parity.js');

  // Assert on the formatted list, so a failure names the offending edge rather than a count.
  assert.deepEqual(external, [], `B13 would die at module resolution in CI:\n  ${external.join('\n  ')}`);
  assert.equal(dynamic, 0, 'a non-literal dynamic import defeats this walk');

  // A walk that stopped at the entry file would report clean while checking nothing.
  assert.ok(files.length >= 2, `expected the walk to follow relative edges, saw ${files.length} file(s)`);
  assert.ok(files.some((f) => f.endsWith('content-types.js')), 'the SSOT leaf must be in the closure');
});

test('the walker actually detects a package import (non-vacuity control)', () => {
  // Without this, the test above proves nothing: a walker that silently found no specifiers
  // at all would report the same empty list.
  const { external } = walk('generate-readmes.js');
  assert.ok(
    external.some((e) => e.endsWith('-> js-yaml')),
    `expected generate-readmes.js -> js-yaml, saw:\n  ${external.join('\n  ') || '(nothing)'}`,
  );
});

test('the walker follows relative edges to find a transitive package import', () => {
  // generate-translation-status.js reaches js-yaml directly AND pulls in several relative
  // modules; asserting both shows the traversal is real rather than a single-file scan.
  const { files, external } = walk('generate-translation-status.js');
  assert.ok(files.length >= 4, `expected a multi-file closure, saw ${files.length}`);
  assert.ok(external.some((e) => e.endsWith('-> js-yaml')));
});
