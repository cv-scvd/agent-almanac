/**
 * Unit tests for `scripts/check-workflow-generator-inputs.js` (#618).
 *
 * The envelope proves the check goes red against the real repo. These cover the parsing
 * decisions underneath, on synthetic trees, because each is a way the check could report
 * `0 unlisted` while having read almost nothing — and on a gate, a wrong all-clear is worse
 * than no gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-workflow-generator-inputs.js');

const WORKFLOW = (paths, steps) => `name: Update READMEs
on:
  push:
    branches: [main]
    paths:
${paths.map((p) => `      - '${p}'`).join('\n')}
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
${steps.map((s) => `      - run: ${s}`).join('\n')}
`;

/** Build a throwaway tree and run the check over it. */
function run({ paths, steps, files, scripts = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/update-readmes.yml'), WORKFLOW(paths, steps));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }, null, 2));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
    let output;
    let status = 0;
    try {
      output = execFileSync('node', [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      output = `${error.stdout || ''}${error.stderr || ''}`;
      status = error.status;
    }
    return { output, status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = {
  paths: ['scripts/generate-readmes.js', 'scripts/lib/a.js'],
  steps: ['node scripts/generate-readmes.js'],
  files: {
    'scripts/generate-readmes.js': "import { a } from './lib/a.js';\nconsole.log(a);\n",
    'scripts/lib/a.js': 'export const a = 1;\n',
  },
};

test('a fully listed graph passes', () => {
  const { output, status } = run(BASE);
  assert.equal(status, 0);
  assert.match(output, /0 unlisted/);
});

test('a transitive import that nobody listed is reported', () => {
  // The #618 shape exactly: both endpoints listed, the middle skipped.
  const { output, status } = run({
    ...BASE,
    files: {
      ...BASE.files,
      'scripts/lib/a.js': "import { b } from './b.js';\nexport const a = b;\n",
      'scripts/lib/b.js': 'export const b = 2;\n',
    },
  });
  assert.equal(status, 1);
  assert.match(output, /scripts\/lib\/b\.js is imported by this workflow/);
});

test('an unparseable paths: filter fails instead of reporting nothing missing', () => {
  // The vacuous pass. The reachable set is still computed and non-empty, so a naive
  // implementation reports `0 unlisted` over a filter it never read.
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(
      join(dir, '.github/workflows/update-readmes.yml'),
      WORKFLOW(BASE.paths, BASE.steps).replace('    paths:', '    pathz:')
    );
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    for (const [name, body] of Object.entries(BASE.files)) writeFileSync(join(dir, name), body);
    let status = 0;
    let output = '';
    try {
      output = execFileSync('node', [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      output = `${error.stdout || ''}${error.stderr || ''}`;
      status = error.status;
    }
    assert.equal(status, 1);
    assert.match(output, /no push paths: entries parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised run: step fails rather than shrinking the graph', () => {
  // The silent-shrink direction. With the step skipped, everything still reachable is listed,
  // so the summary would read `0 unlisted` over a fraction of the job.
  const { output, status } = run({ ...BASE, steps: [...BASE.steps, 'bash scripts/other.sh'] });
  assert.equal(status, 1);
  assert.match(output, /could not be resolved to a script or recognised as a non-entry/);
});

test('`npm ci` is a recognised non-entry and does not fail', () => {
  const { status } = run({ ...BASE, steps: ['npm ci', ...BASE.steps] });
  assert.equal(status, 0);
});

test('`npm run <name>` resolves through package.json', () => {
  const { output, status } = run({
    paths: ['scripts/gen.js'],
    steps: ['npm run gen'],
    scripts: { gen: 'node scripts/gen.js' },
    files: { 'scripts/gen.js': 'console.log(1);\n' },
  });
  assert.equal(status, 0);
  assert.match(output, /1 entry point/);
});

test('`npm run <name>` naming an undefined script fails', () => {
  const { output, status } = run({ ...BASE, steps: ['npm run nope'] });
  assert.equal(status, 1);
  assert.match(output, /undefined package script/);
});

test('a `**` glob entry covers files beneath it', () => {
  const { status } = run({ ...BASE, paths: ['scripts/**'] });
  assert.equal(status, 0);
});

test('a negation entry never counts as coverage', () => {
  // `- '!scripts/lib/a.js'` is an EXCLUSION in GitHub's filter syntax. Treating it as a match
  // would report a deliberately-excluded input as covered — the inverse of the truth.
  const { output, status } = run({
    ...BASE,
    paths: ['scripts/generate-readmes.js', '!scripts/lib/a.js'],
  });
  assert.equal(status, 1);
  assert.match(output, /scripts\/lib\/a\.js is imported by this workflow/);
});

test('a bare package specifier is not walked', () => {
  // Packages are covered by the package.json / package-lock.json entries the filter already
  // carries; trying to resolve them would throw on the first `node:` builtin.
  const { status } = run({
    ...BASE,
    files: {
      ...BASE.files,
      'scripts/generate-readmes.js':
        "import { readFileSync } from 'node:fs';\nimport * as yaml from 'js-yaml';\nimport { a } from './lib/a.js';\nconsole.log(readFileSync, yaml, a);\n",
    },
  });
  assert.equal(status, 0);
});
