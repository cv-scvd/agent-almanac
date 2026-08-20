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

/** Content trees that ship in the published package and are described by the inventory. */
export const CONTENT_TREES = ['skills', 'agents', 'teams', 'guides'];

/** Extensions the inventory is entitled to call "documentation". */
const DOCUMENTATION_EXTENSIONS = ['.md', '.yml', '.yaml'];

/** Scaffolding, excluded from the package by `files` negations and from every count here. */
const TEMPLATE = '_template';

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

/** Every file under `dir`, repo-relative, recursively, skipping `_template` scaffolding. */
function walk(root, dir, out) {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    if (entry.name === TEMPLATE || entry.name === `${TEMPLATE}.md`) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
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
export function nonDocumentationFiles(root, trees = CONTENT_TREES) {
  const found = [];
  for (const tree of trees) {
    if (!existsSync(resolve(root, tree))) continue;
    walk(root, tree, found);
  }
  return found
    .filter((path) => !DOCUMENTATION_EXTENSIONS.some((ext) => path.endsWith(ext)))
    .sort();
}

/**
 * The content trees `package.json` actually ships, in `files` order.
 *
 * Read rather than assumed: the CLI bullet has always said "the published package
 * surface", which reads as *the* surface, while `files` ships four content trees beside
 * it. A statement about which artifact the inventory describes has to enumerate them, or
 * it scopes a researcher to a fifth of what they can install.
 */
export function shippedTrees(root) {
  const files = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files || [];
  return files.filter((entry) => !entry.startsWith('!') && entry.endsWith('/'));
}
