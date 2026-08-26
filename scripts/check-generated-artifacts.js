#!/usr/bin/env node
/**
 * check-generated-artifacts.js — is `generated-artifacts.yml` still true? (#590)
 *
 * #590's ask is "a table nobody can add a row to without naming a reader". A table alone cannot
 * do that; a table plus a reverse sweep can. This is that sweep.
 *
 * ## Why it binds GENERATORS rather than artifacts
 *
 * The obvious design is "find every path a script writes, require each to be listed". Measured
 * on this tree that is impossible: 253 write sites across 171 source files, and ZERO whose
 * destination is a bare string literal — every one composes the path. Generators, by contrast,
 * are enumerable from three places, so those are what the reverse sweep binds. The reasoning and
 * the measurement are recorded in `generated-artifacts.yml`'s header.
 *
 * ## Globs are matched by GIT, not by a matcher written here
 *
 * `git ls-files -- <pattern>` is the ruler. Writing a fourth glob implementation in this
 * repository is precisely what #672 was filed about, and `content-paths.js` already documents
 * how easy it is to get `*`-crosses-`/` wrong in a pathspec. Delegating also means the check
 * agrees with `git` about what is tracked, which is the property that actually matters:
 * an UNTRACKED generated file is out of scope by definition.
 *
 * ## Vacuity
 *
 * Every comparison here has an empty-set failure mode where it would pass while measuring
 * nothing, so each is floored explicitly. A check that compares two empty lists is green and
 * proves nothing — the shape `validate-integrity.sh`'s own header calls the worst outcome.
 *
 * Exit 0 clean, 1 findings, 2 the check could not run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

/**
 * `--root` exists so a test can point this at a fixture repo. Without it the script runs only
 * against its own checkout, which is precisely the untestability `lib/english-history.js`
 * records having fixed — and the refusal paths below, which are the anti-vacuity guards, are
 * unreachable any other way.
 */
const rootArg = (() => {
  const index = process.argv.indexOf('--root');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error('ERROR: --root requires a directory');
    process.exit(2);
  }
  return value;
})();

const ROOT = rootArg
  ? resolve(rootArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = resolve(ROOT, 'generated-artifacts.yml');

const findings = [];
const fail = (message) => findings.push(message);

/** Refuse rather than report a clean run the check could not have earned. */
function refuse(message) {
  console.error(`REFUSED: ${message}`);
  console.error('This check could not measure, so it exits 2 rather than reporting success.');
  process.exit(2);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(Boolean);
}

/** Tracked files matching one pathspec, via git's own matcher. */
function trackedMatching(pattern) {
  try {
    return git(['ls-files', '--', pattern]);
  } catch {
    return [];
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────────────────────

if (!existsSync(INVENTORY)) refuse(`no inventory at ${INVENTORY}`);
const inventory = yaml.load(readFileSync(INVENTORY, 'utf8'));

const artifacts = inventory?.artifacts;
if (!Array.isArray(artifacts) || artifacts.length === 0) {
  refuse('generated-artifacts.yml declares no `artifacts` — nothing to check');
}
const exempt = inventory?.generators_without_committed_output ?? [];

const allTracked = git(['ls-files']);
if (allTracked.length < 100) {
  refuse(`git reports only ${allTracked.length} tracked files — not a full checkout`);
}

// ── FORWARD: every declaration must still be true ─────────────────────────────────────────────

for (const entry of artifacts) {
  const id = entry.id ?? '(unnamed)';

  if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
    fail(`${id}: declares no paths`);
  } else {
    for (const pattern of entry.paths) {
      if (trackedMatching(pattern).length === 0) {
        fail(`${id}: path pattern '${pattern}' matches no tracked file — `
          + 'the artifact moved, was deleted, or the pattern is wrong');
      }
    }
  }

  if (!entry.generator) {
    fail(`${id}: names no generator`);
  } else if (!existsSync(resolve(ROOT, entry.generator))) {
    fail(`${id}: generator '${entry.generator}' does not exist`);
  }

  const gate = entry.gate;
  if (!gate || !gate.kind) {
    fail(`${id}: declares no gate.kind — every row must name a reader or say there is none`);
    continue;
  }

  // A row claiming a gate must be able to point at it. A row claiming none must say why.
  if (gate.kind === 'none') {
    if (!entry.unread_edge) {
      fail(`${id}: gate.kind is 'none' but no \`unread_edge\` explains what that costs`);
    }
    continue;
  }

  if (!gate.command) {
    fail(`${id}: gate.kind is '${gate.kind}' but names no command`);
    continue;
  }
  if (!gate.where) {
    fail(`${id}: gate '${gate.command}' names no file it lives in`);
    continue;
  }
  const wherePath = resolve(ROOT, gate.where);
  if (!existsSync(wherePath)) {
    fail(`${id}: gate.where '${gate.where}' does not exist`);
    continue;
  }
  // Match on the command's distinguishing tail, so `npm run check-readmes` is found whether the
  // file spells it as an npm script or as the underlying node invocation.
  const needle = gate.command.replace(/^(npm run |node |bash )/, '');
  if (!readFileSync(wherePath, 'utf8').includes(needle)) {
    fail(`${id}: gate command '${gate.command}' does not appear in ${gate.where} — `
      + 'the gate was renamed or removed while this row still claims it');
  }
}

// ── REVERSE: every generator must be accounted for ────────────────────────────────────────────
//
// Three enumerable sources. Source 2 is load-bearing: viz/package.json has no script for
// build-wordmark.R or build-terminal-glyphs.js, so an npm-script-only sweep would miss two
// generators, one of which feeds an artifact published to npm.

const discovered = new Map(); // generator path -> where it was found

function noteGenerator(file, source) {
  if (!file) return;
  const rel = file.replace(/^\.\//, '');
  if (!discovered.has(rel)) discovered.set(rel, source);
}

// 1. npm scripts named build*/generate*/update*
for (const [manifest, prefix] of [['package.json', ''], ['viz/package.json', 'viz/']]) {
  const manifestPath = resolve(ROOT, manifest);
  if (!existsSync(manifestPath)) continue;
  const scripts = JSON.parse(readFileSync(manifestPath, 'utf8')).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (!/^(build|generate|update)/.test(name)) continue;
    const match = command.match(/(?:node|Rscript)\s+([\w./-]+\.(?:js|mjs|R))/);
    if (match) noteGenerator(prefix + match[1], `${manifest} script '${name}'`);
  }
}

// 2. commands invoked by viz/build.sh
const buildSh = resolve(ROOT, 'viz/build.sh');
if (existsSync(buildSh)) {
  for (const line of readFileSync(buildSh, 'utf8').split('\n')) {
    const match = line.match(/^\s*(?:node|\$RSCRIPT|Rscript)\s+([\w./-]+\.(?:js|mjs|R))/);
    if (match) noteGenerator(`viz/${match[1]}`, 'viz/build.sh');
  }
} else {
  refuse('viz/build.sh not found — source 2 of the reverse sweep cannot run, and a sweep '
    + 'missing a source would report a clean result it did not earn');
}

if (discovered.size === 0) {
  refuse('the reverse sweep discovered zero generators — it is broken, not the corpus');
}

const listed = new Set(artifacts.map((entry) => entry.generator).filter(Boolean));
const exemptCommands = exempt.map((entry) => `${entry.id} ${entry.command ?? ''}`).join('\n');

for (const [generator, source] of discovered) {
  if (listed.has(generator)) continue;
  // An exemption may name the generator directly or the wrapper that runs it.
  if (exemptCommands.includes(generator)) continue;
  fail(`UNLISTED GENERATOR: ${generator} (found in ${source}) — add it to `
    + 'generated-artifacts.yml with the gate that reads its output, or to '
    + '`generators_without_committed_output` with the reason it produces none');
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────

if (findings.length) {
  for (const finding of findings) console.error(`FAIL: ${finding}`);
  console.error(`\n${findings.length} finding(s) in generated-artifacts.yml.`);
  process.exit(1);
}

const gated = artifacts.filter((entry) => entry.gate?.kind === 'regenerate-and-diff').length;
const unread = artifacts.filter((entry) => entry.gate?.kind === 'none').length;
console.log(
  `generated-artifacts: ${artifacts.length} artifact class(es), ${gated} regenerate-and-diff, `
  + `${unread} with no reader; ${discovered.size} generator(s) swept, all accounted for.`,
);
