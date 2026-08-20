/**
 * What the content trees actually contain, for the generated security surface (#691).
 *
 * Both functions here were inline in `scripts/generate-readmes.js`, which executes its
 * whole pipeline plus `process.exit` at import time. Nothing could import it, so nothing
 * could test them — and the properties they carry are exactly the kind that a refactor
 * breaks silently while every gate stays green.
 *
 * They do not live in `lib/readme-sections.js`, the destination #691 finding 3 names,
 * because that module's header claims zero imports and `dependency-free.test.js` guards
 * the reachability of the no-`npm ci` integrity path through it. These need `fs`. (Note
 * that guard would NOT have caught the addition: it detects package dependencies by
 * `ERR_MODULE_NOT_FOUND`, and `node:fs` resolves fine — the header's claim is broader
 * than its test. Worth knowing before trusting the claim.)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { declaresBash } from './readme-sections.js';

/** Extensions the inventory is entitled to call "documentation". */
const DOCUMENTATION_EXTENSIONS = ['.md', '.yml', '.yaml'];

/** `files` entries under this prefix are the CLI, not a content tree. */
const CLI_PREFIX = 'cli/';

/**
 * How many registered skills declare `Bash`, and how many there are.
 *
 * Enumerates the REGISTRY, never the directory. That is the whole property: a directory
 * walk finds 371 including `skills/_template/`, which declares Bash and is not a skill,
 * so every term gains one and a figure published in SECURITY.md quietly inflates. The
 * shipped package excludes `_template` for the same reason (#669).
 *
 * A registry id with no `SKILL.md` **throws**. The previous form was
 * `existsSync(file) && declaresBash(...)`, which counted a missing skill as
 * *non-declaring* — the direction that under-reports how much of the corpus instructs an
 * agent to run shell commands, in a security document.
 *
 * #691 asserts that A4/A5 make this unreachable on a green main. They do not: A4 and A5
 * are the AGENT and TEAM registries, and the only skills-registry gate anywhere is a
 * count, which a renamed directory leaves untouched. So the branch is reachable, and it
 * must be loud rather than tolerant. The upstream repair is #700.
 */
export function skillsDeclaringBash(root, domains) {
  const ids = Object.values(domains).flatMap((d) => (d.skills || []).map((s) => s.id));
  const missing = [];
  const declaring = ids.filter((id) => {
    const file = resolve(root, 'skills', id, 'SKILL.md');
    if (!existsSync(file)) {
      missing.push(id);
      return false;
    }
    return declaresBash(readFileSync(file, 'utf8'));
  }).length;

  if (missing.length) {
    throw new Error(
      `skills/_registry.yml lists ${missing.length} skill(s) with no SKILL.md on disk: ` +
      `${missing.join(', ')}. Counting them as non-declaring would understate the Bash ` +
      'share published in SECURITY.md. Fix the registry, or restore the skill (#700).',
    );
  }
  return { ids, declaring };
}

/**
 * Does `files`' negation set exclude this path?
 *
 * Derived from the consumer's own accept-list rather than re-stated. The first version
 * skipped any entry NAMED `_template` at any depth, which was a 55th hand-rolled
 * exclusion site (#672) AND disagreed with npm: the negations are root-anchored
 * gitignore-style patterns, so `skills/<id>/_template/helper.py` SHIPS while that walk
 * skipped it — the inventory would have said 16 where 17 shipped, under a sentence that
 * now says "all of it ships".
 *
 * `content-paths.js`'s `isExcludedId` was the other candidate and is wrong in the
 * opposite direction: its `_`-prefix rule would skip `skills/_experimental/tool.py`,
 * which ships. Neither hand-rolled rule is the package's rule. This one is.
 */
function isExcludedFromPackage(relPath, negations) {
  return negations.some((pattern) => (pattern.endsWith('/')
    ? relPath.startsWith(pattern)
    : relPath === pattern));
}

/** Every shipped file under `dir`, repo-relative, recursively. */
function walk(root, dir, negations, out) {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (isExcludedFromPackage(entry.isDirectory() ? `${rel}/` : rel, negations)) continue;
    if (entry.isDirectory()) walk(root, rel, negations, out);
    else out.push(rel);
  }
  return out;
}

/**
 * Files in the shipped content trees that are NOT documentation.
 *
 * The inventory called these trees "Markdown and YAML documentation" for a section whose
 * stated job is scoping *executable* content for a security researcher. Sixteen files
 * contradicted it at the time this was written, including an executable Python script,
 * and all of them ship — `skills/` is in `package.json`'s `files`.
 *
 * Derived by exclusion, never by naming extensions to look for. An earlier pass over the
 * same question enumerated `.py` and `.webp` and missed ten `.bib` files; an allowlist of
 * "interesting" extensions would have shipped that undercount and stayed green. Anything
 * that is not `.md`/`.yml`/`.yaml` counts, including extensions nobody has used yet.
 */
export function nonDocumentationFiles(root, trees = null) {
  const { negations } = shippedEntries(root);
  const found = [];
  for (const tree of trees ?? contentTrees(root)) {
    if (!existsSync(resolve(root, tree))) continue;
    walk(root, tree, negations, found);
  }
  return found
    .filter((path) => !DOCUMENTATION_EXTENSIONS.some((ext) => path.endsWith(ext)))
    .sort();
}

/**
 * Shipped files that a shell or interpreter would execute.
 *
 * Exported so the generated sentence can DERIVE its exemplar instead of naming one.
 * A hardcoded `verify_runtime.py` inside a generated sentence is the defect
 * `generateSecuritySurface` polices ten lines above, where three `scripts/` tools get
 * `existsSync` throws for exactly this reason. Deleting that one file — registry and
 * SKILL.md untouched, so nothing throws — would have had the healer regenerate and
 * auto-commit "15 files … including verify_runtime.py", a false claim in a security
 * document, with every gate green.
 */
export function executableFiles(paths) {
  return paths.filter((path) => /\.(py|sh|bash|zsh|ps1|rb|pl|mjs|cjs|js)$/.test(path));
}

/**
 * The extension of a path, or `null` when it has none.
 *
 * `path.slice(path.lastIndexOf('.'))` is what this replaced, and it fabricated on two
 * plausible inputs: `skills/foo/LICENSE` gave `lastIndexOf` = -1 and `slice(-1)` = `"E"`,
 * published as an extension; `skills/foo.bar/LICENSE` published `.bar/LICENSE`. Both would
 * have rendered into a security document as fact.
 */
export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? null : base.slice(dot);
}

/**
 * What `package.json` ships, split into inclusions and negations.
 *
 * Returns FILES as well as directories. Filtering to `endsWith('/')` silently dropped
 * `cli/index.js` — the file `npx agent-almanac` executes, and one `bin` forces into the
 * package regardless — so the generated sentence told a researcher that a vulnerability
 * in the entry point was "against the repository only". That is #600's failure mode (a
 * bullet naming 5 of 13 adapters) reproduced in freshly authored security prose, and the
 * test written alongside it pinned the behaviour rather than catching it.
 *
 * The negations are returned too, because they are the package's own exclusion rule and
 * the walk below has no business restating it.
 */
export function shippedEntries(root) {
  const files = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files ?? [];
  return {
    included: files.filter((entry) => !entry.startsWith('!')),
    negations: files.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1)),
  };
}

/**
 * Content trees the inventory scans: shipped directories that are not the CLI.
 *
 * Derived rather than listed, because a hardcoded `['skills','agents','teams','guides']`
 * beside `shippedEntries` is a drift PAIR inside one module: add a tree to `files` and the
 * preamble says it ships while the file count never scans it — the "16 files" claim
 * silently excluding a tree the same paragraph says ships.
 */
export function contentTrees(root) {
  return shippedEntries(root).included
    .filter((entry) => entry.endsWith('/') && !entry.startsWith(CLI_PREFIX))
    .map((entry) => entry.replace(/\/$/, ''));
}
