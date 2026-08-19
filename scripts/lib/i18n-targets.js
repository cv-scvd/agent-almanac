/**
 * i18n-targets.js — the one walk over translated content (#552).
 *
 * Three tools need "every translated file, optionally scoped to a locale or a set of trees":
 * the parity gate, the fence normalizer, and the backfill. Each had grown its own copy, and the
 * copies were not interchangeable — one recorded which trees it reached before applying the
 * `--tree` filter, one after; one checked `isFile`, one only `existsSync`. Those differences are
 * not stylistic. They decide whether a scoped run that reaches nothing reports a clean-looking
 * zero or exits 2, which is the guard-proxy failure `--tree` was added to prevent.
 *
 * ## The accept-lists are returned, not computed by the caller
 *
 * Both are collected DURING the walk and after the existence checks, so "reached" means "carries
 * translated content" rather than "has a directory of that name". But they are collected at
 * different points relative to the scope filters, and that asymmetry is the guard:
 *
 *   - `localesReached` before any filter — `--locale` asks whether a locale carries content at
 *     all, which no tree filter should narrow;
 *   - `treesReached` after the LOCALE filter and before the tree filter — `--tree` asks whether
 *     a tree would be reached *by this run*, and collecting it corpus-wide makes the check
 *     circular for combined scopes. Collecting it before filtering (as the first version of
 *     this module did) let `--locale wenyan --tree guides` satisfy each guard independently and
 *     scan nothing at exit 0: six of the ten locales carry `skills/` alone.
 *
 * Validating a scope flag against a static list rather than against these has the same failure,
 * one level up.
 */

import { readdirSync, existsSync, statSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

import { contentKey } from './content-paths.js';
import { CONTENT_TYPES } from './content-types.js';

/**
 * How each content tree is MIRRORED under `i18n/<locale>/`.
 *
 * A record with a THROW, not a Set with a default. The first version of this used
 * `NESTED.has(dir)`, which is a silently-defaulting predicate: an unclassified tree gets
 * `false`, its entries are directories, they fail the `.endsWith('.md')` test downstream, and
 * the tree contributes zero targets — so a gate prints OK having scanned nothing. There is no
 * per-tree zero-target guard to catch it.
 *
 * Throwing at module load means a fifth tree in the SSOT breaks every consumer until someone
 * declares its layout. Loud is the point. Moved here from `check-i18n-fence-parity.js` so the
 * gate, the normalizer and the backfill cannot disagree about the corpus layout.
 */
const NESTING = { skills: true, agents: false, teams: false, guides: false };

/** @type {{dir: string, nested: boolean}[]} */
export const I18N_TREES = CONTENT_TYPES.map((dir) => {
  if (!(dir in NESTING)) {
    throw new Error(
      `i18n-targets: content type '${dir}' has no declared i18n layout. `
      + 'Add it to NESTING (true if mirrored as <dir>/<id>/FILE.md, false if <dir>/<id>.md).',
    );
  }
  return { dir, nested: NESTING[dir] };
});

/**
 * Every translated file, richly described.
 *
 * @param {object} opts
 * @param {string} opts.root repository root
 * @param {string|null} [opts.onlyLocale] restrict to one locale
 * @param {Set<string>|null} [opts.onlyTrees] restrict to these content trees
 * @param {boolean} [opts.withText] read each file (the callers that classify always do)
 * @returns {{
 *   targets: Array<{locale: string, tree: string, id: string, key: string, absPath: string,
 *                   english: string, englishRel: string, relPath: string, text?: string}>,
 *   localesReached: Set<string>, treesReached: Set<string>, localesPresent: string[],
 * }}
 */
/**
 * Does `<i18n>/<locale>/<tree>` exist as a directory?
 *
 * Directory-ness, not mere existence — the same test the walk applies one level down, so a file
 * named like a tree cannot make a locale look scannable.
 */
export function hasTree(root, locale, tree) {
  const path = join(resolve(root, 'i18n'), locale, tree);
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Trees this repository actually carries translations for.
 *
 * A corpus-wide union, and that is its limit: it answers "does any locale have this tree", which
 * stops being the scan's own list the moment `--locale` narrows the scan. `--tree` must NOT be
 * validated against it — that is `validateScope`'s job, against `treesReached`. Kept because the
 * dirty-check pathspec and the write scope need a tree list BEFORE the scan runs.
 */
export function presentTrees(root) {
  const i18nDir = resolve(root, 'i18n');
  if (!existsSync(i18nDir)) return [];
  const locales = readdirSync(i18nDir);
  return I18N_TREES.map(({ dir }) => dir).filter((tree) => locales.some((l) => hasTree(root, l, tree)));
}

/**
 * Locales carrying at least one present tree.
 *
 * The `--locale` accept-list, and it has to be computable BEFORE the scan: rejecting an
 * unreachable locale after a ~90s history build is a worse tool. `localesReached` from the walk
 * is the stricter, content-based answer and is what `validateScope` uses; this is the cheap
 * pre-scan one.
 */
export function scannableLocales(root) {
  const i18nDir = resolve(root, 'i18n');
  if (!existsSync(i18nDir)) return [];
  const trees = presentTrees(root);
  return readdirSync(i18nDir).filter((entry) => trees.some((tree) => hasTree(root, entry, tree)));
}

export function collectI18nTargets({ root, onlyLocale = null, onlyTrees = null, withText = false }) {
  const i18nDir = resolve(root, 'i18n');
  const targets = [];
  const localesReached = new Set();
  const treesReached = new Set();

  const localesPresent = existsSync(i18nDir)
    ? readdirSync(i18nDir).filter((entry) => {
      // `_config.yml`, `README.md`, `glossaries/` are not locales. Directory-ness is the test,
      // plus the underscore convention the rest of the repo already uses.
      if (entry.startsWith('_') || entry === 'glossaries') return false;
      return statSync(join(i18nDir, entry)).isDirectory();
    })
    : [];

  for (const locale of localesPresent) {
    for (const { dir: tree, nested } of I18N_TREES) {
      const base = join(i18nDir, locale, tree);
      if (!existsSync(base) || !statSync(base).isDirectory()) continue;

      for (const entry of readdirSync(base)) {
        // `contentKey` decides what counts as content at all, so `_template.md`, `README.md`
        // and `_registry.yml` fall out here rather than needing a second list that could drift
        // from the gate's.
        const englishRel = nested ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
        const key = contentKey(englishRel);
        if (key === null) continue;

        const absPath = join(i18nDir, locale, englishRel);
        const english = join(root, englishRel);
        // `isFile`, not merely `existsSync`. For skills the entry is a directory and the file is
        // `SKILL.md`, so existence alone was safe by construction; on the mirror branch the
        // ENTRY is the file, and a directory named `foo.md` would reach readFileSync and kill
        // the run with EISDIR where the gate skips it.
        if (!existsSync(absPath) || !statSync(absPath).isFile()) continue;
        // The ENGLISH-side existence test is a real narrowing, and it is recorded rather than
        // silent. The fence gate's previous walk did not have it, so a translation whose English
        // source was DELETED but still has walked history was compared; here it drops out of the
        // walk entirely. Measured neutral today — the gate reports the same 3,644 pairs / 87
        // gated / 40 files before and after delegating to this module — because no such file
        // currently exists.
        //
        // It is kept because the normalizer needs the English path to exist before it reads it,
        // and a walk that returns targets one caller cannot use is worse. But it puts deleted
        // English in the same blind spot #480 already describes for deleted FENCES: a
        // historical-match gate cannot see a deletion, so the next one will vanish from this
        // gate unexamined. If #480 is ever addressed, this filter is part of its surface.
        if (!existsSync(english) || !statSync(english).isFile()) continue;

        // The two accept-lists are collected at DIFFERENT points, and the difference is the
        // whole guard rather than a detail.
        //
        // `localesReached` is corpus-wide: the question `--locale` asks is "does this locale
        // carry translated content at all", which no tree filter should narrow.
        //
        // `treesReached` is LOCALE-SCOPED — collected after the locale filter — because the
        // question `--tree` asks is "would this tree be reached BY THIS RUN". Collecting it
        // corpus-wide made each guard pass on its own while their composition scanned nothing:
        // `--locale wenyan --tree guides` found `wenyan` reachable (it has skills) and `guides`
        // reachable (de/es/ja/zh-CN have it), and reported `scanned: 0` at exit 0. Six of the
        // ten locales carry `skills/` alone, so that composition is not exotic. This is the
        // exact bug `normalize-i18n-fences.js` was fixed for and names in its own comment, and
        // the first version of this lib reintroduced it while claiming to prevent it.
        localesReached.add(locale);
        if (onlyLocale && locale !== onlyLocale) continue;
        treesReached.add(tree);
        if (onlyTrees && !onlyTrees.has(tree)) continue;

        const target = {
          locale,
          tree,
          id: nested ? entry : entry.replace(/\.md$/, ''),
          key,
          absPath,
          english,
          englishRel,
          relPath: `i18n/${locale}/${englishRel}`,
        };
        if (withText) target.text = readFileSync(absPath, 'utf8');
        targets.push(target);
      }
    }
  }

  return { targets, localesReached, treesReached, localesPresent };
}

/**
 * Reject a scope flag that reached nothing, naming what WAS reachable.
 *
 * Shared so the three callers cannot disagree about when a scoped run is vacuous. Returns an
 * array of error lines; empty means the scope is good. The caller exits 2 — this module does not
 * call `process.exit`, because a library that kills the process cannot be tested.
 *
 * @param {object} opts
 * @param {string|null} opts.onlyLocale
 * @param {Set<string>|null} opts.onlyTrees
 * @param {Set<string>} opts.localesReached
 * @param {Set<string>} opts.treesReached
 * @returns {string[]}
 */
export function validateScope({ onlyLocale, onlyTrees, localesReached, treesReached }) {
  const errors = [];
  if (onlyLocale && !localesReached.has(onlyLocale)) {
    errors.push(`ERROR: --locale '${onlyLocale}' matched no translated content.`);
    errors.push('Nothing would be scanned, and the run would report a clean-looking zero.');
    errors.push(`Reachable here: ${[...localesReached].sort().join(', ') || '(none)'}`);
    return errors;
  }
  if (onlyTrees) {
    const known = new Set(I18N_TREES.map((t) => t.dir));
    const unknown = [...onlyTrees].filter((t) => !known.has(t));
    if (unknown.length) {
      errors.push(`ERROR: --tree names no such content tree: ${unknown.join(', ')}`);
      errors.push(`Known trees: ${[...known].sort().join(', ')}`);
      return errors;
    }
    const unreached = [...onlyTrees].filter((t) => !treesReached.has(t));
    if (unreached.length) {
      errors.push(`ERROR: --tree matched no translated content${onlyLocale ? ` in locale '${onlyLocale}'` : ''}: ${unreached.join(', ')}`);
      errors.push('Nothing would be scanned, and the run would report a clean-looking zero.');
      errors.push(`Reachable here: ${[...treesReached].sort().join(', ') || '(none)'}`);
    }
  }
  return errors;
}
