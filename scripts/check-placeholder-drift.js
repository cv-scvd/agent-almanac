#!/usr/bin/env node
/**
 * check-placeholder-drift.js
 *
 * Advisory detector for the review hazard #477 names as "prose can reference
 * in-fence identifiers" (#497). Run it on every fence-restore batch.
 *
 * ## What it is for
 *
 * Restoring a frozen fence to its English body is correct by the #472 rule, but
 * the fence does not stand alone: the prose around it, and the exempt
 * `text`/`markdown` fences beside it, may name the same placeholder. Restore one
 * and not the other and the file names one thing two ways.
 *
 * #496 did exactly that. Two `bash` fences in
 * `i18n/de/skills/release-package-version/SKILL.md` went `paketname` ->
 * `packagename`, while the prose explaining those commands and the exempt
 * ```markdown NEWS.md example kept saying `paketname`. Fixed in `8ed584a4`.
 *
 * Three things were pointed at that batch and only one caught it:
 *
 *   | check                                        | result          |
 *   |----------------------------------------------|-----------------|
 *   | ad-hoc detector keyed on code-shaped tokens   | 0 — missed it   |
 *   | 6 locale-sharded review agents + refuters     | 0 — missed it   |
 *   | Copilot                                       | found it        |
 *
 * ## Why shape does not work, and structure does
 *
 * The detector that missed it keyed on token SHAPE — snake_case, CONSTANT_CASE,
 * kebab-case, dotted.path, camelCase. `paketname` is a plain lowercase word and
 * matched none of them. That is the most likely form of this defect, because a
 * translator renames `packagename` to a plain word in their own language, not to
 * a camelCase one. Worse, that filter had been tuned from 216 false positives
 * down to 0 with no confirmed true positive to test against, so the tuning
 * deleted the target class and the resulting zero read as success.
 *
 * The predicate here is structural instead. A **substitution pair**: within a
 * frozen fence, an old and a new line are identical except for exactly one
 * token, and the removed form is still cited in a localisable register — prose
 * inline-code, or the body of an exempt `text`/`markdown`/`md` fence.
 *
 * "Exactly one token" is what carries it. The same commit rewrote
 * `git commit -m "Entwicklung fuer naechste Version beginnen"` to
 * `git commit -m "Begin development for next version"` — five tokens changed,
 * an ordinary translation restore, and not a placeholder rename. Requiring a
 * single differing token separates a rename from a retranslation without
 * knowing anything about what the token looks like.
 *
 * ## It stays advisory
 *
 * Not every hit is a defect. `de/prune-agent-memory` changes `Eintraege` ->
 * `entries` inside an echoed shell string, which is a frozen fence carrying an
 * English output string: exactly what the rule requires. A reviewer should see
 * it and dismiss it. A gate that must be overridden routinely trains the reflex
 * #472 exists to prevent, so this reports and exits 0 on findings.
 *
 * ## Scope limit
 *
 * It compares two revisions, so it sees only drift a change INTRODUCES.
 * Pre-existing drift in the corpus is invisible to it and needs a separate
 * one-shot scan.
 *
 * Usage:
 *   node scripts/check-placeholder-drift.js                      # HEAD~1..HEAD
 *   node scripts/check-placeholder-drift.js --base <ref>
 *   node scripts/check-placeholder-drift.js --base <ref> --head <ref>
 *   node scripts/check-placeholder-drift.js --json
 *   node scripts/check-placeholder-drift.js --compare            # rejected predicates too
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { extractFences, toLines, isGated } from './lib/fences.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GIT_BUFFER = 512 * 1024 * 1024;

// ---- arguments: default-deny, same shape as normalize-i18n-fences.js ----
const BOOL_FLAGS = new Set(['--json', '--compare']);
const VALUE_FLAGS = new Set(['--base', '--head']);

function usageError(message) {
  console.error(`ERROR: ${message}`);
  console.error(`Usage: ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(' ')}`);
  process.exit(2);
}

const opts = { json: false, compare: false, base: 'HEAD~1', head: 'HEAD' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const name = eq >= 0 ? arg.slice(0, eq) : arg;
  if (BOOL_FLAGS.has(name)) {
    if (eq >= 0) usageError(`${name} takes no value (got '${arg}')`);
    opts[name.slice(2)] = true;
  } else if (VALUE_FLAGS.has(name)) {
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
      usageError(`${name} requires a value`);
    }
    opts[name.slice(2)] = value;
  } else {
    usageError(`unknown argument '${arg}'`);
  }
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_BUFFER });
  return r.status === 0 ? r.stdout : null;
}

function resolveRef(ref) {
  const out = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (out === null) {
    console.error(`ERROR: --base/--head ref does not resolve to a commit: '${ref}'`);
    process.exit(2);
  }
  return out.trim();
}

const BASE = resolveRef(opts.base);
const HEAD = resolveRef(opts.head);

/**
 * A token, for the purpose of "identical except one token".
 *
 * Unicode letters, because the removed side is by definition the translated one
 * — `Eintraege`, `Duesendurchmesser`, and in other locales tokens outside ASCII
 * entirely. An ASCII-only class would drop the very side being measured.
 *
 * A trailing `.`/`-` is kept inside the token so `v0.2.0` and `--dry-run` read
 * as one, which is what makes `"Release paketname v0.2.0"` a single-token change
 * rather than a four-token one.
 */
const TOKEN = /[\p{L}_][\p{L}\p{N}_.-]*/gu;
const tokensOf = (line) => line.match(TOKEN) ?? [];

/** Shapes the detector that MISSED the defect keyed on. Kept only for --compare. */
const CODE_SHAPED = /^(?:[a-z0-9]+_[a-z0-9_]+|[A-Z0-9]+_[A-Z0-9_]+|[a-z0-9]+-[a-z0-9-]+|\w+\.\w+|[a-z]+[A-Z]\w*)$/;

/**
 * Every token cited in a register a translation is ALLOWED to localise, in one
 * revision of one file: prose inline-code spans, and exempt fence bodies.
 *
 * Bare prose is deliberately excluded — admitting it is one of the predicates
 * #497 rejected, and `--compare` still measures it: 223 hits over #496's 3,242
 * removed tokens, almost all ordinary German words that happen to sit in an
 * exempt block somewhere. (#497 quotes 143 for that predicate and 0 for the
 * code-shape one; the prototype behind those figures no longer exists, so the
 * exact definitions are unrecoverable and the numbers here are this file's own.
 * What reproduces is the shape of the comparison, not the digits.)
 *
 * The register is recorded rather than filtered on, and it turns out to separate
 * the classes by itself. Across all seven merged batches plus the #476 re-mirror
 * — 992 frozen fences — the two registers split 4 / 5:
 *
 *   inline-code   4, all in #496, two of them the real `paketname` defect
 *   exempt-fence  5, every one an ordinary German word (`von` ×4, `Datei`)
 *
 * Someone who writes a placeholder in backticks is NAMING it. A token that
 * merely occurs as a word inside an exempt block usually is not. Sorting on that
 * puts the target class first and makes the rest a one-glance dismissal, without
 * deleting anything — with a single confirmed true positive on record, filtering
 * on it is exactly the move that tuned the previous detector to zero.
 */
function localisableCitations(text) {
  const lines = toLines(text);
  const fences = extractFences(text);
  const inFence = new Array(lines.length).fill(false);
  /** token -> 'inline-code' | 'exempt-fence'; inline-code wins when both. */
  const cited = new Map();
  const note = (t, register) => {
    if (register === 'inline-code' || !cited.has(t)) cited.set(t, register);
  };

  for (const f of fences) {
    // Blank the delimiters too, so a fence opener never reads as prose.
    for (let i = Math.max(0, f.line - 1); i <= Math.min(lines.length - 1, f.bodyEnd); i++) {
      inFence[i] = true;
    }
    if (isGated(f)) continue;
    for (const t of tokensOf(f.body)) note(t, 'exempt-fence');
    for (const m of f.body.matchAll(/`([^`\n]+)`/g)) {
      for (const t of tokensOf(m[1])) note(t, 'inline-code');
    }
  }

  const prose = lines.filter((_, i) => !inFence[i]).join('\n');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    for (const t of tokensOf(m[1])) note(t, 'inline-code');
  }
  return cited;
}

/**
 * Pair the changed lines of two fence bodies by LCS.
 *
 * Index pairing, which this replaces, could only examine a fence whose two
 * bodies had the SAME line count — 67 of batch 1's 172 changed fences failed
 * that and went unexamined. A fence that gained or lost a line can still carry
 * a substitution pair in the lines around it.
 *
 * Returns `null` rather than a partial answer when the table would be
 * pathologically large, so the caller counts it as unexamined instead of
 * quietly clearing it.
 */
function changeBlocks(before, after) {
  const n = before.length;
  const m = after.length;
  if (n * m > 400000) return null;

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const blocks = [];
  let pendingBefore = [];
  let pendingAfter = [];
  const flush = () => {
    if (pendingBefore.length || pendingAfter.length) {
      blocks.push({ before: pendingBefore, after: pendingAfter });
    }
    pendingBefore = [];
    pendingAfter = [];
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { flush(); i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) pendingBefore.push({ text: before[i], index: i++ });
    else pendingAfter.push({ text: after[j], index: j++ });
  }
  while (i < n) pendingBefore.push({ text: before[i], index: i++ });
  while (j < m) pendingAfter.push({ text: after[j], index: j++ });
  flush();
  return blocks;
}

/**
 * The removed/added token when two lines are identical except for exactly one
 * token, else null.
 *
 * "Exactly one" is what carries the whole detector. #496 rewrote
 * `git commit -m "Entwicklung fuer naechste Version beginnen"` to
 * `git commit -m "Begin development for next version"` in the same batch as the
 * `paketname` rename — five tokens, an ordinary retranslation. Requiring a
 * single differing token separates a rename from a retranslation without knowing
 * anything about what the token looks like.
 */
function substitution(beforeLine, afterLine) {
  const from = tokensOf(beforeLine);
  const to = tokensOf(afterLine);
  if (from.length !== to.length) return null;
  let at = -1;
  for (let k = 0; k < to.length; k++) {
    if (from[k] === to[k]) continue;
    if (at >= 0) return null;
    at = k;
  }
  return at < 0 ? null : { removed: from[at], added: to[at] };
}

/** Every token appearing in ANY exempt fence — the other rejected predicate. */
function exemptFenceTokens(text) {
  const cited = new Set();
  for (const f of extractFences(text)) {
    if (!isGated(f)) for (const t of tokensOf(f.body)) cited.add(t);
  }
  return cited;
}

// ---- scan ----
const changed = (git(['diff', '--name-only', BASE, HEAD, '--', 'i18n/']) || '')
  .split('\n')
  .filter((p) => p.endsWith('.md'));

const findings = [];
/**
 * The two predicates #497 rejected, measured over the SAME candidate universe
 * they were originally run against: every token removed from a frozen fence
 * line, NOT only the ones that survive the substitution-pair filter. Scoping
 * them to substitution pairs would flatter both — the pair filter is most of
 * what makes this detector quiet, so crediting it to them hides the comparison
 * the issue exists to record.
 */
const alternatives = { candidates: 0, codeShaped: 0, anyExemptFence: 0 };
let fencesCompared = 0;
let unalignedFences = 0;
const skippedFiles = [];

for (const path of changed) {
  const baseText = git(['show', `${BASE}:${path}`]);
  const headText = git(['show', `${HEAD}:${path}`]);
  if (baseText === null || headText === null) continue; // added or deleted

  const baseFences = extractFences(baseText);
  const headFences = extractFences(headText);
  if (baseFences.length !== headFences.length) {
    skippedFiles.push({ path, reason: `fence count ${baseFences.length} -> ${headFences.length}` });
    continue;
  }

  const cited = localisableCitations(headText);
  const exemptOnly = opts.compare ? exemptFenceTokens(headText) : null;

  for (let i = 0; i < headFences.length; i++) {
    const before = baseFences[i];
    const after = headFences[i];
    if (!isGated(after) || before.body === after.body) continue;

    const blocks = changeBlocks(before.body.split('\n'), after.body.split('\n'));
    if (blocks === null) {
      // Reported, never silently dropped: an unexamined fence is not a cleared
      // one, and a detector that conflates the two is how a zero stops meaning
      // anything.
      unalignedFences++;
      continue;
    }
    fencesCompared++;

    for (const block of blocks) {
      if (opts.compare) {
        // Per block, not per line pair: which tokens the block removed is a
        // property of the block, and counting them per candidate pairing would
        // multiply them by the cross product below.
        const kept = new Set(block.after.flatMap((l) => tokensOf(l.text)));
        for (const t of block.before.flatMap((l) => tokensOf(l.text))) {
          if (kept.has(t)) continue;
          alternatives.candidates++;
          if (CODE_SHAPED.test(t)) alternatives.codeShaped++;
          if (exemptOnly.has(t)) alternatives.anyExemptFence++;
        }
      }

      // Every before x after combination within the block, rather than a guessed
      // pairing. Positional pairing — the first version — mispairs the moment a
      // block holds an insertion before the rename: a fence that gained a line
      // paired the renamed line against the INSERTED one, found many differing
      // tokens, and cleared the fence.
      //
      // The cross product is safe precisely because the predicate is so narrow.
      // Two unrelated lines matching "identical except exactly one token"
      // requires every other token to agree in order, which does not happen by
      // accident; blocks are also small. At most one hit per new line, so an
      // insertion cannot inflate the count.
      const claimed = new Set();
      for (const afterLine of block.after) {
        for (const beforeLine of block.before) {
          if (claimed.has(afterLine.index)) break;
          const sub = substitution(beforeLine.text, afterLine.text);
          if (sub === null) continue;
          const register = cited.get(sub.removed);
          if (register === undefined) continue;
          claimed.add(afterLine.index);
          findings.push({
            path,
            fence: i + 1,
            tag: after.lang || 'untagged',
            line: after.line + 1 + afterLine.index,
            removed: sub.removed,
            added: sub.added,
            register,
            context: afterLine.text.trim().slice(0, 120),
          });
        }
      }
    }
  }
}

// A run that compared nothing is not a clean run. Without this the natural
// mistake — pointing it at a merge commit, or a ref pair with no i18n/ change —
// reports "0 findings" and reads as a pass.
if (changed.length === 0) {
  console.error(`ERROR: no i18n/*.md changed between ${BASE.slice(0, 9)} and ${HEAD.slice(0, 9)}.`);
  console.error('Nothing would be compared, and the run would report a clean-looking zero.');
  process.exit(2);
}

if (opts.json) {
  console.log(JSON.stringify({
    base: BASE, head: HEAD, filesChanged: changed.length, fencesCompared, unalignedFences,
    findings, skippedFiles,
    ...(opts.compare ? { alternatives } : {}),
  }, null, 2));
  process.exit(0);
}

console.log(`placeholder drift: ${BASE.slice(0, 9)} -> ${HEAD.slice(0, 9)}`);
console.log(`  ${changed.length} changed i18n file(s); ${fencesCompared} frozen fence(s) compared`);
if (unalignedFences) console.log(`  ${unalignedFences} fence(s) not examined (line counts differ)`);
if (skippedFiles.length) console.log(`  ${skippedFiles.length} file(s) skipped (fence count changed)`);
console.log('');

if (findings.length === 0) {
  console.log('No substitution pair leaves a translated placeholder cited in prose.');
} else {
  // Strongest register first. An author who writes a placeholder in backticks
  // is NAMING it; a token that merely occurs as a word inside an exempt block is
  // usually an ordinary word of the locale. Batch 1's four `von` -> `from` hits
  // are the whole of that second class, and they are dismissed in one glance
  // once the register is on the line.
  //
  // Sorted, not filtered. There is exactly one confirmed true positive on
  // record, and dropping the weaker register on that evidence is how the
  // previous detector tuned 216 false positives down to 0 and deleted the target
  // class with them.
  const strong = findings.filter((f) => f.register === 'inline-code');
  const weak = findings.filter((f) => f.register !== 'inline-code');
  console.log(`${findings.length} substitution pair(s) whose removed form is still cited nearby`);
  console.log(`  ${strong.length} cited in inline-code · ${weak.length} cited only as a word in an exempt fence`);
  console.log('');
  for (const f of [...strong, ...weak]) {
    console.log(`  ${f.path}:${f.line}  [${f.tag}] fence ${f.fence}  (cited in ${f.register})`);
    console.log(`    ${f.removed}  ->  ${f.added}`);
    console.log(`    ${f.context}`);
  }
  console.log('');
  console.log('ADVISORY. Each needs a human call: an English output string inside a frozen');
  console.log('fence is what the rule requires, and reads the same as a placeholder rename.');
}

if (opts.compare) {
  console.log('');
  console.log(`rejected predicates over the same ${alternatives.candidates} removed token(s):`);
  console.log(`  code-shaped removed token          : ${alternatives.codeShaped}`);
  console.log(`  removed token in any exempt fence  : ${alternatives.anyExemptFence}`);
  console.log(`  substitution pair + cited (shipped): ${findings.length}`);
}

// Advisory by design — see the header. Findings do not fail the run.
process.exit(0);
