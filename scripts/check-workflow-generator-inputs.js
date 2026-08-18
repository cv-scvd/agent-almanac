#!/usr/bin/env node
/**
 * check-workflow-generator-inputs.js — every module a healer workflow's generators import must
 * appear in that workflow's `paths:` filter (#618).
 *
 * `update-readmes.yml` regenerates committed output and auto-commits it. If a change to a
 * generator does not match the filter, the healer does not run at the causing commit, and the
 * drift sits until an unrelated push heals it or a release goes red (#362).
 *
 * That list has now been extended four separate times, once per omission, each after the
 * omission caused or nearly caused drift:
 *
 *   #553/#560  lib/translation-status.js   the stub verdict
 *   #566       lib/readme-sections.js      how a section renders
 *   —          lib/fences.js               the MIDDLE of the chain, with both endpoints listed
 *   #615/#552  lib/provenance.js           the frontmatter reader staleness is computed from
 *
 * A list maintained by memory is the failure mode, not the individual misses. This derives it
 * instead: resolve each `run:` step of the job to its entry script, walk the static import
 * graph, and require every reachable repo-local module to be matched by a `paths:` entry.
 *
 *   node scripts/check-workflow-generator-inputs.js          # exit 1 on any unlisted input
 *   node scripts/check-workflow-generator-inputs.js --warn   # report, exit 0
 *   node scripts/check-workflow-generator-inputs.js --list   # print the resolved graph
 *
 * ## Why the entry points are derived too
 *
 * Hardcoding "the generators are generate-readmes.js and generate-translation-status.js" would
 * rebuild the same defect one level up: add a fourth step to the job and its imports are
 * invisible again. The entry points come from the job's own `run:` steps, resolving
 * `npm run <name>` through `package.json`, so the check has no list of its own to maintain.
 *
 * One consequence, stated because it is a real scope decision rather than an accident: the
 * job's *validator* step (`npm run validate:readme-parity`) is an entry point too. Changing it
 * cannot move committed output — it can only fail the job — so requiring it in `paths:` is
 * stricter than #618 asked for. It is kept because "everything this job runs" is a rule a
 * reader can apply, and "everything this job runs that writes a file" is one that needs a
 * second list to answer.
 *
 * ## What it does not check
 *
 * That the `paths:` list is not too WIDE. Extra entries are legitimate and numerous here —
 * content globs, registries, the lockfile — so only the missing direction is enforced.
 *
 * Dynamic `import()` and `require()` are invisible to it. Neither appears in these scripts, and
 * a static-graph walk that silently mis-parsed would be the vacuous pass this repo keeps
 * finding, so an entry file it cannot read is an error rather than an empty graph.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const WARN_ONLY = process.argv.includes('--warn');
const LIST = process.argv.includes('--list');

/**
 * Healer workflows: those that regenerate committed output and push it back.
 *
 * Deliberately a short explicit list, unlike the input graph. "Which workflows heal" is a
 * property of intent that no file states mechanically — `git-auto-commit-action` is a strong
 * signal but a job could write output another way — so this is the one thing a human declares.
 * Everything downstream of it is derived.
 */
const HEALER_WORKFLOWS = ['.github/workflows/update-readmes.yml'];

/** Read the `paths:` entries of a workflow's `push:` trigger. */
function pushPaths(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const entries = [];
  let inPush = false;
  let inPaths = false;
  for (const line of lines) {
    if (/^  [A-Za-z_-]+:/.test(line)) {
      inPush = /^  push:/.test(line);
      inPaths = false;
      continue;
    }
    if (!inPush) continue;
    if (/^    paths:/.test(line)) { inPaths = true; continue; }
    if (/^    [A-Za-z_-]+:/.test(line)) { inPaths = false; continue; }
    if (!inPaths) continue;
    const match = line.match(/^      - ['"]?([^'"]+)['"]?\s*$/);
    if (match) entries.push(match[1]);
  }
  return entries;
}

/** Read the shell command of every `run:` step in the file. */
function runSteps(workflowText) {
  return workflowText
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-?\s*run:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * Commands that run no repo JavaScript and are not entry points.
 *
 * Enumerated, so that an UNRECOGNISED command is an error rather than a silent skip. That
 * distinction is the whole difference between "this job has three entry points" and "this job
 * has three entry points that I happened to parse": a `run:` step whose form drifts would
 * otherwise shrink the graph, and the remaining modules would all still be listed, so the
 * check would report `0 unlisted` over a third of the job.
 */
const NON_ENTRY_COMMANDS = [/^npm ci\b/, /^npm install\b/, /^npm run build\b/];

/**
 * Resolve one shell command to the script it runs.
 *
 * Returns the script path, or `null` for a command on the non-entry list. Throws for anything
 * else — including an `npm run` naming a package script that is not a `node <file>` invocation,
 * which is precisely how the graph would silently lose an entry point.
 */
function entryScript(command, packageScripts) {
  const npmRun = command.match(/^npm run ([A-Za-z0-9:_-]+)/);
  if (npmRun) {
    const script = packageScripts[npmRun[1]];
    if (!script) throw new Error(`run step names an undefined package script: npm run ${npmRun[1]}`);
    return entryScript(script, packageScripts);
  }
  const nodeRun = command.match(/^node\s+(?:--[^\s]+\s+)*([^\s]+\.js)/);
  if (nodeRun) return nodeRun[1];
  if (NON_ENTRY_COMMANDS.some((pattern) => pattern.test(command))) return null;
  throw new Error(`run step could not be resolved to a script or recognised as a non-entry: ${command}`);
}

/**
 * Every repo-local module reachable from `entry` by static relative imports.
 *
 * Only relative specifiers are followed: a bare specifier is a package, and packages are
 * covered by the `package.json` / `package-lock.json` entries the filter already carries for
 * exactly this reason.
 */
function importGraph(entry, seen = new Set()) {
  const absolute = resolvePath(ROOT, entry);
  const rel = relative(ROOT, absolute).split('\\').join('/');
  if (seen.has(rel)) return seen;
  if (!existsSync(absolute)) {
    throw new Error(`entry or import does not exist: ${rel}`);
  }
  seen.add(rel);
  const text = readFileSync(absolute, 'utf8');
  const specifiers = [...text.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)].map((m) => m[1]);
  for (const specifier of specifiers) {
    importGraph(relative(ROOT, resolvePath(dirname(absolute), specifier)), seen);
  }
  return seen;
}

/** Does any `paths:` entry cover this file? Exact match, or a `**` prefix glob. */
function covered(file, entries) {
  return entries.some((entry) => {
    if (entry.startsWith('!')) return false;
    if (entry === file) return true;
    const star = entry.indexOf('**');
    return star !== -1 && file.startsWith(entry.slice(0, star));
  });
}

let findings = 0;

for (const workflow of HEALER_WORKFLOWS) {
  const absolute = join(ROOT, workflow);
  if (!existsSync(absolute)) {
    console.error(`FAIL: healer workflow not found: ${workflow}`);
    findings++;
    continue;
  }
  const text = readFileSync(absolute, 'utf8');
  const entries = pushPaths(text);
  if (entries.length === 0) {
    // An absent or unparsed filter must not read as "everything is covered". A healer with no
    // filter is legitimate; a filter this function failed to parse is the vacuous pass.
    console.error(`FAIL: ${workflow} — no push paths: entries parsed. If the filter was removed`);
    console.error('      deliberately, remove this workflow from HEALER_WORKFLOWS as well.');
    findings++;
    continue;
  }

  const packageScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};
  const commands = runSteps(text);
  let scripts;
  try {
    scripts = commands.map((c) => entryScript(c, packageScripts)).filter(Boolean);
  } catch (error) {
    // Reported rather than thrown, so one unparseable step does not hide the state of any
    // other healer workflow — and so the message names the command instead of a stack trace.
    console.error(`FAIL: ${workflow} — ${error.message}`);
    console.error('      Add it to NON_ENTRY_COMMANDS if it runs no repo JavaScript. Skipping it');
    console.error('      silently would shrink the import graph and report 0 unlisted over it.');
    findings++;
    continue;
  }
  if (scripts.length === 0) {
    console.error(`FAIL: ${workflow} — no node entry point resolved from its run: steps.`);
    findings++;
    continue;
  }

  const reachable = new Set();
  for (const script of scripts) {
    for (const module of importGraph(script)) reachable.add(module);
  }

  const missing = [...reachable].filter((module) => !covered(module, entries)).sort();

  if (LIST) {
    console.log(`${workflow}: ${scripts.length} entry point(s), ${reachable.size} module(s)`);
    for (const module of [...reachable].sort()) {
      console.log(`  ${covered(module, entries) ? 'listed  ' : 'MISSING '} ${module}`);
    }
    console.log('');
  }

  console.log(`${workflow}: ${reachable.size} module(s) reachable from ${scripts.length} entry point(s); ${missing.length} unlisted`);
  for (const module of missing) {
    console.log(`${WARN_ONLY ? 'WARN' : 'FAIL'}: ${module} is imported by this workflow's generators but matches no paths: entry`);
    findings++;
  }
}

if (findings > 0 && !WARN_ONLY) {
  console.log('');
  console.log('A change to an unlisted module moves generated output without triggering the');
  console.log('healer, so the drift lands at some later unrelated commit instead.');
}

process.exitCode = findings > 0 && !WARN_ONLY ? 1 : 0;
