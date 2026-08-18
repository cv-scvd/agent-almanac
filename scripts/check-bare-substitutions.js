#!/usr/bin/env node
/**
 * check-bare-substitutions.js — find command-substitution assignments that can abort a
 * `set -e` shell script with no diagnostic (#647).
 *
 * The defect it exists to catch, in one line:
 *
 *   intent=$(grep -m1 '^intent:' "$f" | xargs)
 *
 * Under `set -euo pipefail` the assignment carries the pipeline's exit status. `grep` exits 1
 * when it matches nothing, so a file without `intent:` stopped the entire script HERE — one
 * line above the `-z` test written to report exactly that. Nothing printed. Every check below
 * was skipped, and the run looked like an ordinary early exit. That shipped in
 * `validate-integrity.sh` and made A6a's missing-field diagnostic unreachable code.
 *
 * `| wc -l` is not a rescue. `pipefail` returns the rightmost non-zero status, so
 * `grep(1) | wc -l(0)` still exits 1.
 *
 *   node scripts/check-bare-substitutions.js            # exit 1 on any unguarded site
 *   node scripts/check-bare-substitutions.js --warn     # report, always exit 0
 *   node scripts/check-bare-substitutions.js --list     # print every site and its verdict
 *
 * ## Why the safe list is the enumerated one
 *
 * The tempting design is a list of dangerous commands — grep, rg, sed — and a guard required
 * only for those. That is an allowlist wearing a deny-list's clothes: the first script to
 * pipe through `jq`, `yq`, `git diff --quiet` or a local function is unguarded by default, and
 * nobody notices, because the gate stays green. This repo has been bitten by that shape twice
 * (see CLAUDE.md § *Which code fences are frozen* for the same argument about fence tags).
 *
 * So the enumeration runs the other way. SAFE_COMMANDS lists commands whose non-zero exit
 * always means a genuine error rather than "found nothing" — a closed set, short, and every
 * addition has to be argued. Anything else needs a guard or an annotation. A pipeline built
 * from unknown commands fails closed.
 *
 * ## What counts as handled
 *
 * A site passes if EITHER:
 *
 *   - it carries a guard: `|| true`, `|| echo …`, `|| rc=$?`, `|| <name>_rc=$?`, `|| :`
 *   - or it carries `# abort-ok: <reason>` on the assignment's first or last line
 *
 * The annotation is not a suppression comment. It is where you record that the pipeline
 * cannot legitimately return empty — that a `find` over a directory guaranteed to exist, or
 * an `awk` with no exit statement, will only fail if something is genuinely broken, in which
 * case aborting is the correct behaviour.
 *
 * ## What this cannot check
 *
 * Whether a guard is *appropriate*. `|| true` belongs where the next lines explicitly handle
 * the empty result; where nothing checks the zero case it is worse than the abort, because it
 * converts a loud stop into a silent empty string and an empty haystack passes every
 * "is X missing" test. That judgement is not decidable by pattern-matching, which is why the
 * rule is also stated in prose at the top of `validate-integrity.sh`.
 *
 * It also deliberately ignores `local x=$(…)` / `declare x=$(…)`, which do NOT abort: the
 * status becomes `local`'s, always 0. That is the inverse hazard — a silent empty value where
 * the author expected an abort — and it needs a different check, not this one.
 *
 * And one known false negative, stated rather than left to be discovered:
 *
 *   x=$(grep foo bar || true | wc -l)
 *
 * The guard is INSIDE the pipeline, so it protects `grep` and not the pipeline's exit status.
 * `pipefail` still returns the rightmost non-zero, and the assignment can still abort. The
 * guard test here is span-wide, so this reads as guarded. Fixing it needs the guard's position
 * relative to the last pipeline segment, which the span scanner does not track. No site in
 * this repo has that shape; it is written down because the next one to appear will be invisible
 * to this check, and a limit nobody recorded looks like a limit nobody has.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const WARN_ONLY = process.argv.includes('--warn');
const LIST = process.argv.includes('--list');

/**
 * Commands whose non-zero exit always signals a real error, never "matched nothing".
 *
 * Deliberately short and deliberately closed. `grep`, `rg`, `find`, `git`, `awk`, `sed` and
 * every custom shell function are absent on purpose — each of them has a legitimate
 * non-zero return in ordinary use, or can be given one.
 *
 * `wc` is here and it is the subtle entry: `wc` itself cannot fail on empty input, which is
 * exactly why `grep … | wc -l` reads as safe to a human and is not. The scan looks at every
 * command in the pipeline, so the `grep` upstream is what decides the verdict.
 */
const SAFE_COMMANDS = new Set([
  'printf', 'echo', 'basename', 'dirname', 'pwd', 'wc', 'tr', 'sort', 'uniq',
  'cut', 'rev', 'date', 'mktemp', 'tee', 'nl', 'seq', 'true', 'false', 'yes',
]);

// `|| return N` and `|| exit N` are guards too: control leaves the assignment rather than
// falling through, so `set -e` never sees an unhandled non-zero. `wf_event_paths` uses exactly
// that shape, and leaving it out of this pattern reported the repo's most carefully-guarded
// site as unguarded.
const GUARD = /\|\|\s*(true|:|echo\b|return\b|exit\b|continue\b|break\b|[A-Za-z_][A-Za-z_0-9]*=|\w+\s*=\s*\$\?)/;
const ANNOTATION = /#\s*abort-ok:/;
// `$((` is arithmetic expansion, not command substitution, and it cannot abort anything.
// The first version of this pattern matched it, so every `count=$((count + 1))` in the corpus
// was reported with a "pipeline" consisting of the variable's own name — 10 findings that
// looked exactly like the real ones and would have taught the next reader to skim the output.
const ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z_0-9]*=\$\((?!\()/;
const DECLARED = /^\s*(?:local|declare|typeset|readonly)\s/;

/**
 * Every tracked `*.sh`, from git rather than from a filesystem walk.
 *
 * The walk was written first and measured at over 60 seconds without finishing. Two reasons,
 * both of which git sidesteps: `.claude/skills/<name>` and `.claude/agents` are symlinks that
 * `statSync` follows, so the discovery symlink farm gets re-walked once per entry; and
 * `viz/renv/library/` holds thousands of vendored files on an NTFS mount. Asking git returns
 * 27 paths and takes milliseconds — and, unlike a walk, cannot wander into an untracked
 * agent worktree or a build directory and start reporting findings against a copy.
 */
function shellScripts() {
  return execFileSync('git', ['ls-files', '-z', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((rel) => join(ROOT, rel));
}

/**
 * Collect the full text of a command substitution that starts on `lines[start]`.
 *
 * Substitutions here span up to a dozen lines, so a line-at-a-time scan would read the guard
 * off the wrong line — or miss a `grep` on a continuation entirely and call the site safe.
 *
 * The scanner is quote-aware, and that is not polish. The first version counted `$(` and `)`
 * on the raw text, which meant an embedded awk program containing `sub(/x/, "", line)` drove
 * the depth NEGATIVE on parens that were never openers. The span then ended mid-program, two
 * lines above the site's real `|| true`, and the checker reported a correctly-guarded
 * substitution as UNGUARDED. Measured: `validate-integrity.sh:98`, which is guarded and was
 * flagged. A truncating span is the dangerous direction in general — it can also cut a
 * pipeline before its `grep` and report a site as safe — so the scanner tracks quotes across
 * line boundaries (the awk and sed programs here open a single quote on one line and close it
 * several lines later) and only counts parens outside them.
 */
function substitutionSpan(lines, start) {
  let depth = 0;
  let seen = false;
  let quote = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) {
        if (ch === '\\' && quote === '"') { c++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      // An unquoted `#` starts a comment only at a word boundary; inside a substitution the
      // sites here never use one mid-line, and treating every `#` as a comment would swallow
      // `${x#prefix}`.
      if (ch === '#' && (c === 0 || /\s/.test(line[c - 1]))) break;
      if (ch === '$' && line[c + 1] === '(') { depth++; seen = true; c++; }
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    const continued = /\\$/.test(line);
    if (seen && !quote && !continued && depth <= 0) {
      return { text: lines.slice(start, i + 1).join('\n'), end: i };
    }
  }
  return { text: lines.slice(start).join('\n'), end: lines.length - 1 };
}

/**
 * Every command word in a substitution's pipeline.
 *
 * Splits on `|`, `&&`, `||` and `;`, then takes the first bare word of each segment, skipping
 * a leading `$(`, redirections and variable assignments. Quoted script bodies (the awk and
 * sed programs) contain pipes of their own, so the split is done after stripping single- and
 * double-quoted runs — otherwise an awk program mentioning `|` invents phantom commands and
 * the verdict becomes noise.
 */
function pipelineCommands(text) {
  const stripped = text
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const body = stripped.replace(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z_0-9]*=\$\(/, '');
  return body
    .split(/\|\||&&|[|;]/)
    .map((segment) => {
      const word = segment
        .replace(/^[\s()]*/, '')
        .replace(/^(?:[A-Za-z_][A-Za-z_0-9]*=\S*\s+)*/, '')
        .split(/\s+/)[0] || '';
      return word.replace(/^\$?\(/, '').replace(/[)"'`]/g, '');
    })
    .filter((word) => word && /^[A-Za-z_./][A-Za-z_0-9./-]*$/.test(word));
}

const findings = [];
const sites = [];

for (const file of shellScripts()) {
  const text = readFileSync(file, 'utf8');
  // Only scripts that actually abort. A script without `set -e` has this hazard in a much
  // milder form (an empty value, not a vanished run), and flagging it would bury the real ones.
  if (!/^set\s+-[a-z]*e/m.test(text)) continue;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (DECLARED.test(lines[i])) continue;
    if (!ASSIGNMENT.test(lines[i])) continue;

    const { text: span, end } = substitutionSpan(lines, i);
    const commands = pipelineCommands(span);
    const unsafe = commands.filter((command) => !SAFE_COMMANDS.has(command));
    const guarded = GUARD.test(span);
    const annotated = ANNOTATION.test(lines[i]) || ANNOTATION.test(lines[end]);

    const rel = relative(ROOT, file);
    const verdict = unsafe.length === 0 ? 'safe'
      : guarded ? 'guarded'
      : annotated ? 'annotated'
      : 'UNGUARDED';
    sites.push({ file: rel, line: i + 1, verdict, commands: unsafe });
    if (verdict === 'UNGUARDED') {
      findings.push({ file: rel, line: i + 1, commands: unsafe, source: lines[i].trim() });
    }
    i = end;
  }
}

if (LIST) {
  for (const site of sites) {
    console.log(`  ${site.verdict.padEnd(10)} ${site.file}:${site.line}  ${site.commands.join(' ') || '-'}`);
  }
  console.log('');
}

const counts = sites.reduce((acc, s) => ({ ...acc, [s.verdict]: (acc[s.verdict] || 0) + 1 }), {});
console.log(`Command-substitution assignments scanned: ${sites.length} in ${new Set(sites.map((s) => s.file)).size} file(s)`);
console.log(`  safe (every command in the pipeline is on the closed safe list): ${counts.safe || 0}`);
console.log(`  guarded (|| true, || rc=$?, …):                                  ${counts.guarded || 0}`);
console.log(`  annotated (# abort-ok:):                                         ${counts.annotated || 0}`);
console.log(`  UNGUARDED:                                                       ${counts.UNGUARDED || 0}`);

if (findings.length > 0) {
  console.log('');
  for (const finding of findings) {
    console.log(`${WARN_ONLY ? 'WARN' : 'FAIL'}: ${finding.file}:${finding.line} can abort the script`);
    console.log(`  pipeline includes: ${finding.commands.join(', ')}`);
    console.log(`  ${finding.source}`);
  }
  console.log('');
  console.log('Each site needs one of: a guard whose empty result the next lines explicitly');
  console.log('check, or `# abort-ok: <why this pipeline cannot legitimately return empty>`.');
  console.log('A blanket `|| true` sweep is not a fix — see the rule at the top of');
  console.log('scripts/validate-integrity.sh.');
}

process.exitCode = findings.length > 0 && !WARN_ONLY ? 1 : 0;
