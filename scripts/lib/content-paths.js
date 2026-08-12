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
function isExcludedId(id) {
  const stem = id.endsWith('.md') ? id.slice(0, -3) : id;
  return stem.startsWith('_') || stem === 'README';
}
