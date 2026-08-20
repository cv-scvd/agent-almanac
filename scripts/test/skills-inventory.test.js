/**
 * The content-tree inventory that SECURITY.md publishes (#691 findings 2 and 3).
 *
 * These functions were inline in `scripts/generate-readmes.js`, which runs its pipeline
 * and calls `process.exit` at import time — so nothing could import them and nothing did
 * test them. The properties they carry are precisely the kind a refactor breaks in
 * silence: a directory walk instead of a registry enumeration, or an extension allowlist
 * instead of an exclusion, each shipping green while a published figure drifts.
 *
 * Fixtures are hermetic `mkdtemp` trees, not the real repository, so the failure branches
 * are reachable — on a green main every one of them is unreachable by construction. Two
 * tests deliberately use the REAL tree, to pin that the fixtures are not testing a
 * different function than the generator calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  skillsDeclaringBash,
  nonDocumentationFiles,
  shippedTrees,
  CONTENT_TREES,
} from '../lib/skills-inventory.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BASH_SKILL = '---\nname: x\nallowed-tools: Read, Bash, Grep\n---\n\n# X\n';
const QUIET_SKILL = '---\nname: y\nallowed-tools: Read, Grep\n---\n\n# Y\n';

/** A tree with the skills named, plus a `_template` that declares Bash — as the real one does. */
function makeTree(t, skills) {
  const dir = mkdtempSync(join(tmpdir(), 'skills-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [id, body] of Object.entries(skills)) {
    mkdirSync(join(dir, 'skills', id), { recursive: true });
    writeFileSync(join(dir, 'skills', id, 'SKILL.md'), body, 'utf8');
  }
  mkdirSync(join(dir, 'skills', '_template'), { recursive: true });
  writeFileSync(join(dir, 'skills', '_template', 'SKILL.md'), BASH_SKILL, 'utf8');
  return dir;
}

const domainsOf = (...ids) => ({ d: { skills: ids.map((id) => ({ id })) } });

test('counts registry entries, and the directory walk would differ', (t) => {
  const dir = makeTree(t, { alpha: BASH_SKILL, beta: QUIET_SKILL });

  const { ids, declaring } = skillsDeclaringBash(dir, domainsOf('alpha', 'beta'));

  // THE property. `skills/_template/` exists on disk and declares Bash, so a walk would
  // report 2 of 3. The registry does not list it, so the answer is 1 of 2. A refactor to
  // a directory walk gains one in EACH term and stays green everywhere else (#669).
  assert.equal(ids.length, 2, '_template must not be counted as a skill');
  assert.equal(declaring, 1, '_template must not be counted as declaring Bash');
});

test('a registry id with no SKILL.md THROWS, and does not count as non-declaring', (t) => {
  // The old form was `existsSync(file) && declaresBash(...)`, which silently returned
  // false — under-reporting the Bash share in a security document, which is the
  // dangerous direction. #691 claims A4/A5 make this unreachable; they gate the AGENT
  // and TEAM registries, so it is reachable, and the realistic path is a renamed
  // directory that leaves the count check undisturbed (#700).
  const dir = makeTree(t, { alpha: BASH_SKILL });

  assert.throws(
    () => skillsDeclaringBash(dir, domainsOf('alpha', 'renamed-away')),
    /lists 1 skill\(s\) with no SKILL\.md/,
  );
});

test('every missing id is named, not just the first', (t) => {
  const dir = makeTree(t, { alpha: BASH_SKILL });
  assert.throws(
    () => skillsDeclaringBash(dir, domainsOf('alpha', 'gone-a', 'gone-b')),
    (e) => e.message.includes('gone-a') && e.message.includes('gone-b'),
  );
});

test('non-documentation files are found by EXCLUSION, including extensions nobody expected', (t) => {
  // An earlier pass over this same question enumerated `.py` and `.webp` and missed ten
  // `.bib` files. An allowlist of "interesting" extensions would have shipped that
  // undercount and stayed green, so the rule is: not .md/.yml/.yaml counts.
  const dir = makeTree(t, { alpha: BASH_SKILL });
  mkdirSync(join(dir, 'skills', 'alpha', 'references'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'alpha', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'alpha', 'references', 'CITATIONS.bib'), '@x{}\n', 'utf8');
  writeFileSync(join(dir, 'skills', 'alpha', 'scripts', 'run.py'), 'print(1)\n', 'utf8');
  writeFileSync(join(dir, 'skills', 'alpha', 'notes.yaml'), 'a: 1\n', 'utf8');
  writeFileSync(join(dir, 'skills', 'alpha', 'diagram.svg'), '<svg/>\n', 'utf8');

  assert.deepEqual(nonDocumentationFiles(dir, ['skills']), [
    'skills/alpha/diagram.svg',
    'skills/alpha/references/CITATIONS.bib',
    'skills/alpha/scripts/run.py',
  ]);
});

test('the walk is recursive and skips _template', (t) => {
  const dir = makeTree(t, { alpha: BASH_SKILL });
  writeFileSync(join(dir, 'skills', '_template', 'scaffold.py'), 'pass\n', 'utf8');

  assert.deepEqual(nonDocumentationFiles(dir, ['skills']), [],
    '_template is excluded from the package by a files negation, so it must not be counted');
});

test('a tree that does not exist is skipped rather than throwing', (t) => {
  const dir = makeTree(t, { alpha: BASH_SKILL });
  assert.deepEqual(nonDocumentationFiles(dir, ['skills', 'nonexistent']), []);
});

test('shippedTrees reads package.json rather than assuming cli/ is the surface', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skills-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    files: ['cli/lib/', 'cli/index.js', 'skills/', '!skills/_template/', 'agents/', 'LICENSE'],
  }), 'utf8');

  // Directories only, negations dropped: the statement is about which TREES ship.
  assert.deepEqual(shippedTrees(dir), ['cli/lib/', 'skills/', 'agents/']);
});

// ── against the real tree, so the fixtures cannot drift from the generator ───

test('LIVE: the real registry resolves — every listed skill exists on disk', async () => {
  const { load } = await import('js-yaml');
  const { readFileSync } = await import('node:fs');
  const registry = load(readFileSync(join(REPO_ROOT, 'skills', '_registry.yml'), 'utf8'));

  const { ids, declaring } = skillsDeclaringBash(REPO_ROOT, registry.domains || registry);

  assert.ok(ids.length > 0, 'the registry must not be empty');
  assert.ok(declaring > 0 && declaring < ids.length, 'the Bash share must be a real fraction');
  assert.ok(!ids.includes('_template'), 'the registry must not list _template');
});

test('LIVE: the non-documentation set is what SECURITY.md publishes', () => {
  const found = nonDocumentationFiles(REPO_ROOT);
  // Not a pinned count — that would go stale on every legitimate addition. What is pinned
  // is the shape: the claim "Markdown and YAML documentation" was FALSE, so the generator
  // must keep deriving the exception rather than reverting to the flat assertion.
  for (const path of found) {
    assert.ok(CONTENT_TREES.some((t) => path.startsWith(`${t}/`)), `outside content trees: ${path}`);
    assert.ok(!/\.(md|ya?ml)$/.test(path), `documentation leaked in: ${path}`);
    assert.ok(!path.includes('_template'), `_template leaked in: ${path}`);
  }
});
