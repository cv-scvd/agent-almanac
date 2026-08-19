/**
 * content-paths.js — repo-relative English content path -> stable `<tree>/<id>` key.
 *
 * Split out of `fences.js` so the shared history walker (#559) can key its blobs without
 * importing `fences.js`, which imports the walker. The cycle would in fact have *worked* —
 * both bindings are hoisted `export function`s used only at call time — but it would have been
 * load-bearing on that fact, and the first top-level `const` either module later needed from
 * the other would have turned it into a `ReferenceError` a long way from the edit that caused
 * it. `fences.js` re-exports `contentKey`, so every existing importer is unchanged.
 */

import { CONTENT_TYPES } from './content-types.js';

/**
 * Repo-relative English content path -> stable `<tree>/<id>` key, or null when
 * the path is not translatable content.
 *
 * Uses the second-to-last segment for `SKILL.md` so that pre-flatten historical
 * paths (`skills/<domain>/<id>/SKILL.md`, ~42% of the blobs in history) key to
 * the same id as today's `skills/<id>/SKILL.md`.
 *
 * `skills/<id>/SKILL.md` IS A PUBLIC PATH SHAPE. At least one consumer outside this repository
 * globs on it — the `memex` extractor, which also infers projects by walking parent directories.
 * A wholesale layout change strands it loudly, which is fine; a PARTIAL one (some skills moved,
 * others not) reads as a partial extraction rather than a broken glob, which is not. This
 * function has already survived one such migration by keying on the second-to-last segment, and
 * that tolerance is the reason to say so here rather than assume the next one is equally kind.
 */
export function contentKey(relPath) {
  const parts = relPath.split('/');
  if (parts.length < 2 || !CONTENT_TYPES.includes(parts[0])) return null;
  // Both branches below must agree on what an id is, and on which ids are not content.
  // They did not: the exclusion lived only in the flat branch, so
  // `contentKey('skills/_template/SKILL.md')` returned `skills/_template` — a key the
  // English history index then carried, which would have made a translated `_template`
  // a rewrite target (#519). skills/ holds most of the corpus, so the general claim that
  // deriving both the path and the key from this function removes the need for a second
  // exclusion list was false exactly where it mattered most.
  if (parts[parts.length - 1] === 'SKILL.md') {
    if (parts.length < 3) return null;
    // Second-to-last, never parts[1]: pre-flatten paths are
    // `skills/<domain>/<id>/SKILL.md`, and keying off parts[1] would silently key a whole
    // domain — ~42% of the blobs in history — to the wrong id.
    const id = parts[parts.length - 2];
    if (isExcludedId(id)) return null;
    return `${parts[0]}/${id}`;
  }
  if (parts.length === 2 && parts[1].endsWith('.md')) {
    const id = parts[1].slice(0, -3);
    if (isExcludedId(id)) return null;
    return `${parts[0]}/${id}`;
  }
  return null;
}

/**
 * Names that live inside a content tree without being content.
 *
 * Takes a RAW path segment and strips a `.md` suffix itself, so the two branches above can
 * hand it the same kind of thing. They could not before: the flat branch stripped the
 * extension before testing while the nested branch passed a bare directory segment, which
 * made `contentKey('skills/README.md/SKILL.md')` return `skills/README.md` instead of null
 * while `contentKey('skills/README.md')` correctly returned null. Unreachable today only
 * because every caller happens to `statSync(...).isFile()` afterwards — which is the
 * "unreachable because of ambient state" framing #519 exists to reject.
 */
/**
 * Every path shape a `git log` pathspec must carry to see one key's whole history (#682).
 *
 * `contentKey` is deliberately many-to-one: `skills/<domain>/<id>/SKILL.md` and
 * `skills/<id>/SKILL.md` key to the same `skills/<id>`. That is what makes the pre-flatten era
 * — 863 path occurrences in this repository's history — reachable under today's ids.
 *
 * It also means a pathspec built from the CURRENT path alone is not the same walk. A tree-level
 * pathspec (`-- skills agents teams guides`) matches both shapes and never had to know; a
 * file-level one matches only what it names. Scoping the walk (#635) is what turned an invariant
 * of `contentKey` into a requirement on its callers, and the failure it produced was silent and
 * in the strict direction: a mirror whose fence body existed only in pre-flatten English is
 * clean under the corpus-wide walk and a VIOLATION under `--id`. A false accusation against a
 * translation nobody touched, on the command CLAUDE.md tells a contributor to run.
 *
 * So the alias list lives here, beside the function whose many-to-one mapping creates it, rather
 * than in the caller that happens to need it first. A second caller deriving its own answer is
 * the drift this directory keeps closing.
 *
 * Flat trees (`agents`, `teams`, `guides`) have never had a second shape, and `contentKey`'s
 * flat branch requires `parts.length === 2`, so there is nothing to alias for them. If that ever
 * changes, it changes in `contentKey` first and this function must follow in the same commit.
 *
 * @param {string} englishRel repo-relative path to an English source, as `contentKey` takes it
 * @returns {string[]} pathspecs covering every historical shape of that key, current one first
 */
export function historicalPathspecs(englishRel) {
  const parts = englishRel.split('/');
  if (parts[0] === 'skills' && parts[parts.length - 1] === 'SKILL.md') {
    const id = parts[parts.length - 2];
    // `*` does not cross `/` in a git pathspec's fnmatch, so this matches exactly one
    // intervening domain segment — the pre-flatten shape — and not deeper nestings that
    // `contentKey` would key to a different id anyway.
    return [englishRel, `skills/*/${id}/SKILL.md`];
  }
  return [englishRel];
}

function isExcludedId(id) {
  const stem = id.endsWith('.md') ? id.slice(0, -3) : id;
  return stem.startsWith('_') || stem === 'README';
}
