#!/usr/bin/env node
/**
 * check-fence-propagation.js
 *
 * Answers ONE question, for one content id: do the translated mirrors carry the
 * frozen fence bodies English has *now*?
 *
 * ## Why this is not `check-i18n-fence-parity.js`
 *
 * The parity gate is deliberately **staleness-immune**: it accepts a gated fence
 * body that appears in *any* revision of the paired English file, because 2,571
 * translations are stale and `evolve-*` bumps `source_commit` without
 * retranslating (#405/#616). That property is correct for a gate, and it has an
 * exact consequence, measured on 2026-08-17 while fixing #551:
 *
 *   Editing a frozen fence in English and propagating to ZERO mirrors leaves the
 *   parity gate reporting 0 violations — before and after the commit. The old
 *   body is in history, so it is in the pool, forever.
 *
 * `check-translation-freshness.js` carries no information here either: those ten
 * mirrors were already STALE before the edit, so the edit moved nothing.
 *
 * So an eleven-file propagation cannot be verified by watching either check pass.
 * It has to be verified by BYTES, and this is the instrument that does it. It is
 * the same blind spot `feedback_historical_match_gates_miss_deletions` names — a
 * historical-match rule can never see the source move on — reached from the edit
 * side rather than the deletion side.
 *
 * ## What it is NOT
 *
 * **Not a gate, and deliberately not wired into CI.** Run corpus-wide it would
 * report an unread population of unknown size — every stale mirror whose fence
 * English later edited — and this repository's rule is that a count nobody has
 * read must not be given authority (see § Ratcheting a Warn-Only Gate in
 * CLAUDE.md). Turning it into a gate is tracked separately; it needs its members
 * read first.
 *
 * It is therefore **id-scoped and required to be so**: `--id` has no default. A
 * tool that answers a question about a corpus nobody triaged should not be one
 * keystroke away.
 *
 * ## What it compares
 *
 * Fence bodies at their ORDINAL, English against each mirror, restricted to
 * fences that are frozen (`isGated`) in English. Ordinal mapping is only sound
 * when both sides carry the same folded tag sequence, so a mirror whose sequence
 * differs is reported `unalignable` and NOT compared — the same refusal
 * `normalize-i18n-fences.js` makes, for the same reason.
 *
 * Whole bodies, never the inserted lines. Proving that the line you added arrived
 * is not proving the fence matches: the mirrors may each have matched a
 * *different* historical revision beforehand, so a fence can carry your insertion
 * and still differ elsewhere.
 *
 * Exit 0 = every frozen fence agrees. Exit 1 = a divergence or an unalignable
 * mirror. Exit 2 = the question could not be answered (bad id, no mirrors).
 *
 * Usage:
 *   node scripts/check-fence-propagation.js --id write-helm-chart
 *   node scripts/check-fence-propagation.js --id write-helm-chart --tree skills
 *   node scripts/check-fence-propagation.js --id quick-reference --tree guides --json
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { extractFences, isGated, foldedTagSequence, TREES } from './lib/fences.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

const BOOL_FLAGS = new Set(['--json']);
const VALUE_FLAGS = new Set(['--id', '--tree', '--root']);

function usageError(message) {
  console.error(`ERROR: ${message}`);
  console.error('Usage: node scripts/check-fence-propagation.js --id <content-id> [--tree <tree>] [--root <dir>] [--json]');
  process.exit(2);
}

// Parsed the same way as the normalizer's flags, and for the same reason: an
// `indexOf` scan accepts `--id=x` as a bare positional and silently widens scope.
const opts = { id: null, tree: null, root: null, json: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const name = eq >= 0 ? arg.slice(0, eq) : arg;
  if (BOOL_FLAGS.has(name)) {
    if (eq >= 0) usageError(`${name} takes no value`);
    opts[name.slice(2)] = true;
  } else if (VALUE_FLAGS.has(name)) {
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith('--')) usageError(`${name} needs a value`);
    opts[name.slice(2)] = value;
  } else {
    usageError(`unrecognised argument '${arg}'`);
  }
}

if (!opts.id) usageError('--id is required (this tool is deliberately id-scoped; see the header)');

// `--root` exists for the fixture tests. It is safe here in a way it is not in
// `check-debt-ratchet.js`, because this tool resolves NOTHING but content under
// the root — no gate to invoke, no git history to walk, so a redirected root can
// only narrow what is read, never point the check at a different subject.
const ROOT = opts.root ? resolve(opts.root) : DEFAULT_ROOT;
const I18N_DIR = resolve(ROOT, 'i18n');

/** English path for a content id, by tree. `skills` nests, the other three do not. */
const englishPath = (tree, id) => (tree === 'skills'
  ? resolve(ROOT, 'skills', id, 'SKILL.md')
  : resolve(ROOT, tree, `${id}.md`));

const mirrorPath = (locale, tree, id) => (tree === 'skills'
  ? resolve(I18N_DIR, locale, 'skills', id, 'SKILL.md')
  : resolve(I18N_DIR, locale, tree, `${id}.md`));

// Resolve the tree by finding the id, rather than defaulting to `skills`: a
// guide and a skill may share a name, and guessing would compare the wrong pair.
let tree = opts.tree;
if (tree === null) {
  const found = TREES.filter((t) => existsSync(englishPath(t, opts.id)));
  if (found.length === 0) usageError(`no English source for id '${opts.id}' in any of: ${TREES.join(', ')}`);
  if (found.length > 1) usageError(`id '${opts.id}' exists in ${found.join(' and ')} — pass --tree`);
  [tree] = found;
} else if (!TREES.includes(tree)) {
  usageError(`--tree '${tree}' is not a content tree (${TREES.join(', ')})`);
} else if (!existsSync(englishPath(tree, opts.id))) {
  usageError(`no English source at ${englishPath(tree, opts.id)}`);
}

const english = readFileSync(englishPath(tree, opts.id), 'utf8');
const englishFences = extractFences(english);
const englishSeq = foldedTagSequence(englishFences).join(',');

const locales = existsSync(I18N_DIR)
  ? readdirSync(I18N_DIR).filter((e) => statSync(resolve(I18N_DIR, e)).isDirectory())
  : [];
const mirrors = locales
  .map((locale) => ({ locale, path: mirrorPath(locale, tree, opts.id) }))
  .filter((m) => existsSync(m.path));

if (mirrors.length === 0) {
  // Vacuity refusal: "0 divergences" over 0 files is the answer this tool exists
  // to never give. A typo'd id must not read as a clean propagation.
  console.error(`ERROR: id '${opts.id}' (tree '${tree}') has no translated mirrors — nothing to compare`);
  process.exit(2);
}

const gatedOrdinals = englishFences
  .map((f, index) => (isGated(f) ? index : -1))
  .filter((index) => index >= 0);

const findings = [];
for (const mirror of mirrors) {
  const fences = extractFences(readFileSync(mirror.path, 'utf8'));
  if (foldedTagSequence(fences).join(',') !== englishSeq) {
    findings.push({
      locale: mirror.locale,
      path: mirror.path.slice(ROOT.length + 1),
      kind: 'unalignable',
      detail: 'folded tag sequence differs from English — ordinal mapping is not sound, not compared',
    });
    continue;
  }
  for (const index of gatedOrdinals) {
    if (fences[index].body !== englishFences[index].body) {
      findings.push({
        locale: mirror.locale,
        path: mirror.path.slice(ROOT.length + 1),
        kind: 'lags-english',
        ordinal: index,
        tag: englishFences[index].lang || 'untagged',
        detail: 'frozen fence body differs from English at HEAD of the working tree',
      });
    }
  }
}

const summary = {
  id: opts.id,
  tree,
  mirrorsCompared: mirrors.length,
  englishFences: englishFences.length,
  frozenFences: gatedOrdinals.length,
  findings,
};

if (opts.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`${opts.id} (${tree}): ${mirrors.length} mirror(s), `
    + `${gatedOrdinals.length} frozen of ${englishFences.length} fence(s)`);
  for (const f of findings) {
    console.log(f.kind === 'unalignable'
      ? `  UNALIGNABLE ${f.path} — ${f.detail}`
      : `  LAGS        ${f.path} fence #${f.ordinal} (\`${f.tag}\`)`);
  }
  console.log(findings.length === 0
    ? '  OK — every frozen fence is byte-identical to English'
    : `  ${findings.length} finding(s)`);
}

process.exitCode = findings.length === 0 ? 0 : 1;
