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
      # The real update-readmes.yml commits its output, and the declared-skip path in
      # assertHealersDeclared is only load-bearing because of it. A fixture without this
      # line lets that guard be deleted with every test still green (found by mutation).
      - uses: stefanzweifel/git-auto-commit-action@v6
`;

/** Build a throwaway tree and run the check over it. */
function run({ paths, steps, files, scripts = {}, warn = false, extraWorkflows = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    for (const [name, body] of Object.entries(extraWorkflows)) {
      writeFileSync(join(dir, '.github/workflows', name), body);
    }
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/update-readmes.yml'), WORKFLOW(paths, steps));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }, null, 2));
    for (const [name, body] of Object.entries(files)) {
      // mkdir the parent of every fixture, not just `scripts/lib` — a fixture that needs a nested
      // directory should express that in its own path rather than in the helper.
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
    let output;
    let status = 0;
    try {
      const argv = warn ? [CHECK, '--root', dir, '--warn'] : [CHECK, '--root', dir];
      output = execFileSync('node', argv, { cwd: dir, encoding: 'utf8' });
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
  assert.match(output, /; 0 unlisted$/m);
});

test('an exported function whose body quotes a dotted string is not read as an import', () => {
  // Found by #672. The specifier class spans newlines on purpose, so that multi-line
  // `import {\n a,\n} from './x.js'` is covered without an `s` flag. Unanchored, it ran from
  // the `export` keyword straight into the function BODY and took the first quoted string:
  //
  //     export function isExcludedId(id) {
  //       const stem = id.endsWith('.md') ? …
  //
  // was read as an import of `./lib/.md`, which does not exist, so the check hard-refused --
  // exit 1 even under `--warn`, in a REQUIRED context. Nothing in the repo had exported such a
  // function before, so the bug shipped latent and fired on an unrelated PR.
  const { output, status } = run({
    ...BASE,
    files: {
      ...BASE.files,
      'scripts/lib/a.js':
        "export function a(id) {\n  const stem = id.endsWith('.md') ? id : id;\n  return stem;\n}\n",
    },
  });
  assert.equal(status, 0, output);
  assert.match(output, /; 0 unlisted$/m);
  assert.doesNotMatch(output, /\.md/, 'a quoted literal in a function body reached the graph');
});

test('a MULTI-LINE import is still followed after that fix', () => {
  // The narrowing direction, and the reason the fix anchors on `from` rather than forbidding
  // the newline. A smaller reachable set means fewer required trigger paths -- a FALSE PASS on
  // a gate whose header calls a wrong all-clear worse than no gate.
  //
  // The target must be UNLISTED. A first version imported a module `BASE.paths` already
  // listed, so dropping the specifier changed no output and the naive `[^'"\n]*` narrowing
  // SURVIVED this test. Measured, not assumed.
  const { output, status } = run({
    ...BASE,
    files: {
      ...BASE.files,
      'scripts/generate-readmes.js':
        "import {\n  m,\n} from './lib/multi.js';\nconsole.log(m);\n",
      'scripts/lib/multi.js': 'export const m = 1;\n',
    },
  });
  assert.equal(status, 1, output);
  assert.match(output, /scripts\/lib\/multi\.js is imported by this workflow/);
});

test('a BARE side-effect import, which has no `from`, is still followed', () => {
  // The reason the `from` group is optional rather than required. Same unlisted-target rule.
  const { output, status } = run({
    ...BASE,
    files: {
      ...BASE.files,
      'scripts/generate-readmes.js': "import './lib/side.js';\nconsole.log(1);\n",
      'scripts/lib/side.js': 'export const s = 1;\n',
    },
  });
  assert.equal(status, 1, output);
  assert.match(output, /scripts\/lib\/side\.js is imported by this workflow/);
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

test('a `bash <script>` step must resolve rather than shrinking the graph', () => {
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
  assert.match(output, /\b1 entry point\(s\)/);
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

test('a `run: |` block scalar is expanded line by line', () => {
  // Five workflows in this repo use block scalars. Without the block branch the `|` is captured
  // as the command and null-drops through the not-a-launcher pass, so the body goes unscanned and
  // the run fails with `no node entry point resolved` — red, but for a reason that reads as the
  // CHECK being broken rather than as the step being unlisted. (The first version of this comment
  // claimed the naive mutant throws "could not be resolved"; traced, it does not.)
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/update-readmes.yml'), `name: Update READMEs
on:
  push:
    branches: [main]
    paths:
      - 'scripts/gen.js'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: |
          npm ci
          node scripts/gen.js
`);
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    writeFileSync(join(dir, 'scripts/gen.js'), 'console.log(1);\n');
    const output = execFileSync('node', [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' });
    assert.match(output, /\b1 entry point\(s\)/);
    assert.match(output, /; 0 unlisted$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell control flow inside a block is not mistaken for an entry point', () => {
  // Expanding validate-skills.yml's blocks yields 67 lines, most of them `failed=0`, `fi`,
  // `for dir in skills/*/; do`. Treating each as an unresolvable entry point would bury the one
  // real finding under sixty errors, which is how a check gets switched off.
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/update-readmes.yml'), `name: Update READMEs
on:
  push:
    branches: [main]
    paths:
      - 'scripts/gen.js'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - run: |
          failed=0
          for dir in scripts/*/; do
            [ -d "$dir" ] || continue
          done
          node scripts/gen.js
          exit $failed
`);
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    writeFileSync(join(dir, 'scripts/gen.js'), 'console.log(1);\n');
    const output = execFileSync('node', [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' });
    assert.match(output, /\b1 entry point\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`bash <script>` is an invoker and must resolve — a shell script can run node', () => {
  const { output, status } = run({ ...BASE, steps: [...BASE.steps, 'bash scripts/helper.sh'] });
  assert.equal(status, 1);
  assert.match(output, /could not be resolved/);
});

test('an `npm run` naming a non-node script still fails — the invoker pass is workflow-level only', () => {
  // The regression this pins: adding the "not a launcher" pass made `npm run x` -> `echo skipped`
  // resolve to null instead of throwing, silently dropping an entry point. A step that names a
  // package script has declared intent to run it; only the workflow's own shell fragments get
  // the pass.
  const { output, status } = run({
    ...BASE,
    steps: ['npm run gen'],
    scripts: { gen: 'echo skipped' },
  });
  assert.equal(status, 1);
  assert.match(output, /could not be resolved/);
});

// ── holes an adversarial review found, each now closed and pinned ───────────

test('a `**` in the MIDDLE respects the suffix after it', () => {
  // `i18n/**/*.md` is a live entry. The first version reduced any `**` entry to the prefix
  // before it, so it read as "anything under i18n/" and would have called a future
  // `i18n/x.js` covered when GitHub's `*.md` suffix would not trigger on it. FALSE PASS.
  const out = run({
    paths: ['scripts/gen.js', 'lib/**/*.md'],
    steps: ['node scripts/gen.js'],
    files: {
      'scripts/gen.js': "import { a } from '../lib/deep/a.js';\nconsole.log(a);\n",
      'lib/deep/a.js': 'export const a = 1;\n',
    },
  });
  assert.equal(out.status, 1);
  assert.match(out.output, /lib\/deep\/a\.js is imported by this workflow/);
});

test('a single `*` does not cross a directory separator', () => {
  const shallow = run({
    paths: ['scripts/*.js'],
    steps: ['node scripts/gen.js'],
    files: { 'scripts/gen.js': 'console.log(1);\n' },
  });
  assert.equal(shallow.status, 0);
});

test('a negation REVOKES an earlier glob grant', () => {
  // GitHub applies the filter in order. Returning false for every negation is the right half —
  // a negation never grants — and dropping the other half meant `['scripts/**', '!scripts/lib/a.js']`
  // granted `a.js` via the glob while GitHub excludes it. FALSE PASS.
  const out = run({
    paths: ['scripts/**', '!scripts/lib/a.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: BASE.files,
  });
  assert.equal(out.status, 1);
  assert.match(out.output, /scripts\/lib\/a\.js is imported by this workflow/);
});

test('a compound `&&` command resolves EVERY segment, not just the head', () => {
  // `node a.js && node b.js` resolved to `a.js` alone, with no error — a half-recognised command
  // is a silent partial skip, which is what this file's doctrine says must never happen. The live
  // shape exists in package.json's own `test` script.
  const out = run({
    paths: ['scripts/a.js'],
    steps: ['node scripts/a.js && node scripts/b.js'],
    files: { 'scripts/a.js': 'console.log(1);\n', 'scripts/b.js': 'console.log(2);\n' },
  });
  assert.equal(out.status, 1);
  assert.match(out.output, /scripts\/b\.js is imported by this workflow/);
});

test('a non-npm launcher is not silently skipped', () => {
  // `yarn`, `pnpm`, `python`, `make` fell through the not-a-launcher pass and vanished from the
  // graph with no error unless they were the only entry.
  const out = run({ ...BASE, steps: [...BASE.steps, 'python scripts/gen.py'] });
  assert.equal(out.status, 1);
  assert.match(out.output, /could not be resolved/);
});

test('`export … from` is an edge like `import`', () => {
  // A re-exporting barrel module is in the graph and its own changes move generated output.
  const out = run({
    paths: ['scripts/generate-readmes.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: {
      'scripts/generate-readmes.js': "export { a } from './lib/a.js';\n",
      'scripts/lib/a.js': 'export const a = 1;\n',
    },
  });
  assert.equal(out.status, 1);
  assert.match(out.output, /scripts\/lib\/a\.js is imported by this workflow/);
});

test('a `run: |2` block header is still recognised as a block', () => {
  // An explicit indentation indicator is legal YAML. Without it the INLINE regex captured `|2`
  // as the command, which null-dropped, and the whole block body went unscanned — silently, so
  // long as the job had one other resolving entry.
  const dir = mkdtempSync(join(tmpdir(), 'gen-inputs-'));
  try {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/update-readmes.yml'), `name: Update READMEs
on:
  push:
    branches: [main]
    paths:
      - 'scripts/listed.js'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/listed.js
      - run: |2
          node scripts/hidden.js
`);
    writeFileSync(join(dir, 'package.json'), '{"scripts":{}}');
    writeFileSync(join(dir, 'scripts/listed.js'), 'console.log(1);\n');
    writeFileSync(join(dir, 'scripts/hidden.js'), 'console.log(2);\n');
    let status = 0;
    let output = '';
    try {
      output = execFileSync('node', [CHECK, '--root', dir], { cwd: dir, encoding: 'utf8' });
    } catch (error) {
      output = `${error.stdout || ''}${error.stderr || ''}`;
      status = error.status;
    }
    assert.equal(status, 1);
    assert.match(output, /scripts\/hidden\.js is imported by this workflow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`--warn` downgrades findings but NEVER a structural refusal', () => {
  // Same rule as `assertNotShallow`: a warn-only run over a filter the check could not read
  // would not warn less, it would lie.
  const finding = run({
    ...BASE,
    paths: ['scripts/generate-readmes.js'],
    warn: true,
  });
  assert.equal(finding.status, 0, 'an unlisted module is a finding, downgradable by --warn');

  const refusal = run({ ...BASE, steps: ['npm run nope'], warn: true });
  assert.equal(refusal.status, 1, 'an unresolvable step is a refusal and must stay non-zero');
  assert.match(refusal.output, /structural refusal/);
});

test('a bare `--root` with no value exits 2 rather than crashing', () => {
  let status = 0;
  let output = '';
  try {
    output = execFileSync('node', [CHECK, '--root'], { encoding: 'utf8' });
  } catch (error) {
    output = `${error.stdout || ''}${error.stderr || ''}`;
    status = error.status;
  }
  assert.equal(status, 2);
  assert.match(output, /--root needs a value/);
});

// ── the healer DECLARATION is itself checked (#663) ─────────────────────────
//
// Without these, `assertHealersDeclared` shipped with an envelope run by hand and nothing
// re-proving it afterwards. This repo has a name for that: a manual break-and-check proves
// the feature, not the coverage — #458 verified an exit code end to end by hand, wrote it
// into the commit, and deleting the fix line still left all 101 tests green.

/** A workflow that commits, in the form workflows actually use. */
const BLOCK_SCALAR_COMMITTER = `name: Commits Things
on:
  push:
    branches: [main]
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: |
          git config user.name bot
          git add -A && git commit -m update
          git push
`;

const ACTION_COMMITTER = `name: Commits Things
on:
  push:
    branches: [main]
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - uses: stefanzweifel/git-auto-commit-action@v6
`;

test('an undeclared healer using a BLOCK-SCALAR git push is refused', () => {
  // The form that matters, and the one the first version of this signal could not see: the
  // `run:` line carries no `git push` and the `git push` line carries no `run:`, so a
  // same-line pattern matched neither. Routed through `runSteps`, which expands block scalars.
  const { status, output } = run({
    paths: ['skills/**', 'scripts/generate-readmes.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: { 'scripts/generate-readmes.js': 'export const x = 1;\n' },
    extraWorkflows: { 'commits.yml': BLOCK_SCALAR_COMMITTER },
  });

  assert.equal(status, 1, output);
  assert.match(output, /commits\.yml uses a bare `git push` but is not in HEALER_WORKFLOWS/);
});

test('an undeclared healer using a commit ACTION is refused', () => {
  const { status, output } = run({
    paths: ['skills/**', 'scripts/generate-readmes.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: { 'scripts/generate-readmes.js': 'export const x = 1;\n' },
    extraWorkflows: { 'commits.yml': ACTION_COMMITTER },
  });

  assert.equal(status, 1, output);
  assert.match(output, /commits\.yml uses git-auto-commit-action but is not in HEALER_WORKFLOWS/);
});

test('a workflow that commits nothing is not accused', () => {
  // The accept side. Without it, "refuse everything" would satisfy both tests above — and
  // this fixture carries the exact shape that would false-positive a naive scan: a full-line
  // comment naming the action, which is how `update-readmes.yml` records its SHA pin.
  const innocent = `name: Just Checks
on:
  pull_request:
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      # SHA-pinned: https://github.com/stefanzweifel/git-auto-commit-action/releases
      - run: |
          echo "Repair locally, then commit:"
          echo "    git add --renormalize ."
          npm test
`;
  const { status, output } = run({
    paths: ['skills/**', 'scripts/generate-readmes.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: { 'scripts/generate-readmes.js': 'export const x = 1;\n' },
    extraWorkflows: { 'innocent.yml': innocent },
  });

  assert.equal(status, 0, output);
  assert.ok(!/HEALER_WORKFLOWS/.test(output), output);
});

test('the DECLARED healer is skipped, or the check would accuse itself', () => {
  // `update-readmes.yml` commits, so it carries the very signal this detector hunts. If the
  // declared-skip path broke, every run would fail on the one workflow the check exists to
  // serve — which makes this the load-bearing test of the pair.
  //
  // The first version passed `update-readmes.yml` through `extraWorkflows`, where the harness
  // promptly OVERWROTE it with the standard fixture — a fixture that committed nothing, so
  // the skip was never exercised and deleting it left the suite green. Found by mutation; the
  // repair is in the fixture, which now commits like the real file does.
  //
  // Read the resulting kill count correctly. Deleting the skip now dies to EIGHT tests, and
  // that is coupling through a shared fixture, not eight independent assertions — every test
  // using the standard workflow inherits the accusation. Bigger is not stronger here, which
  // is the inversion this repo's mutation doctrine warns about; the one that means something
  // is this test, and it would die alone if it had a fixture of its own.
  const { status, output } = run({
    paths: ['skills/**', 'scripts/generate-readmes.js'],
    steps: ['node scripts/generate-readmes.js'],
    files: { 'scripts/generate-readmes.js': 'export const x = 1;\n' },
  });

  assert.equal(status, 0, output);
  assert.ok(!/HEALER_WORKFLOWS/.test(output), output);
});
