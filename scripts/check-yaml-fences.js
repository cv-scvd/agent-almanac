#!/usr/bin/env node
/**
 * check-yaml-fences.js
 *
 * Every ```yaml fence in English content must parse as YAML (#507).
 *
 * ## Why this is a gate and not a style preference
 *
 * #472 freezes a fence by its TAG: everything between the delimiters is either
 * frozen to English or localisable, and `yaml` is frozen. That is the right
 * answer for a machine-consumed document and the wrong one for a reference table
 * a human reads, and the tag is the only thing distinguishing them — so a
 * mislabelled fence quietly freezes content that should have been translatable.
 *
 * `skills/escalate-issues/SKILL.md` carried a `yaml` fence holding a routing
 * header AND the markdown incident report beneath it. The German translation had
 * that report in German; #508 restored it to English, correctly per the rule,
 * and the surrounding German prose still told the reader to write one.
 *
 * What turns that from a judgement call into a decidable one is that the fence
 * **was not YAML**. `js-yaml` rejects it at the `---` separating the header from
 * the prose. Three fences in `troubleshoot-print-issues` and one in
 * `render-publication-graphic` were the same shape — printer settings and
 * publication requirements written with ranges (`1.0-2.0mm`), arrows
 * (`0.98 → 0.96`) and bullet lists, which is a reference table, not a config.
 *
 * So the rule is: if it is tagged `yaml`, it parses. If it does not parse, it is
 * either broken YAML or it is not YAML, and both need fixing at the source rather
 * than being frozen into ten locales.
 *
 * This is also what keeps retagging honest. CLAUDE.md names retagging a `yaml`
 * fence to `text` as the way the freeze's scope could be edited from inside the
 * gated file. Correcting a mislabel is not that — but the two are only
 * distinguishable if something checks which fences are genuinely YAML, and this
 * is that something.
 *
 * ## Exemptions are by ERROR CLASS, not by location
 *
 * Two shapes legitimately do not parse, and both are named here with the reason:
 *
 * - **Go templates.** `write-helm-chart` shows Helm chart sources, which are Go
 *   templates that happen to produce YAML. `{{- if .Values… }}` is not YAML and
 *   is not meant to be.
 * - **Duplicate-key illustrations.** A good-versus-bad pair in one fence is a
 *   documented idiom in this corpus's guides, and duplicate keys are exactly what
 *   makes the bad half bad.
 *
 * Pinning exemptions to `file:line` would rot on the first edit above them, and a
 * rotted exemption either fails a clean file or silently covers a new defect.
 * Keying on the error class costs some precision — an accidental duplicate key in
 * a real config example would pass — and buys an exemption list that cannot drift
 * out of date. Every exempted fence is REPORTED rather than skipped silently, so
 * the set stays visible and a reviewer can see it grow.
 *
 * Scope: English content only. English is canonical, and a translated `yaml`
 * fence that diverges from it is `check-i18n-fence-parity.js`'s business.
 *
 * Usage:
 *   node scripts/check-yaml-fences.js
 *   node scripts/check-yaml-fences.js --json
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { extractFences, TREES, contentKey } from './lib/fences.js';

const argv = process.argv.slice(2);
let JSON_OUT = false;
let rootArg = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const name = eq >= 0 ? arg.slice(0, eq) : arg;
  if (name === '--json') {
    JSON_OUT = true;
  } else if (name === '--root') {
    // Read-only, and the reason this file is testable at all: the checks need a
    // corpus to run against, while `js-yaml` has to resolve from the repository
    // that installed it. Pointing the real script at a fixture tree separates
    // those, where copying the script into a throwaway repo could not.
    rootArg = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (rootArg === undefined || rootArg === '' || rootArg.startsWith('--')) {
      console.error('ERROR: --root requires a value');
      process.exit(2);
    }
  } else {
    console.error(`ERROR: unknown argument '${arg}'`);
    process.exit(2);
  }
}

const ROOT = rootArg
  ? resolve(rootArg)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
  console.error(`ERROR: --root is not a directory: '${ROOT}'`);
  process.exit(2);
}

/** Every English content file the checker also covers. */
function englishFiles() {
  const out = [];
  for (const tree of TREES) {
    const base = join(ROOT, tree);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const rel = tree === 'skills' ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
      if (contentKey(rel) === null) continue;
      const abs = join(ROOT, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Why a fence that does not parse is allowed to. Returns null when it is not.
 * Order matters only for reporting; the two classes do not overlap in practice.
 */
function exemption(body, message) {
  if (/\{\{.*\}\}/s.test(body)) return 'go-template';
  if (/duplicated mapping key/i.test(message)) return 'duplicate-key-illustration';
  return null;
}

const failures = [];
const exempted = [];
let checked = 0;

for (const rel of englishFiles()) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  for (const f of extractFences(text)) {
    if (f.lang !== 'yaml' && f.lang !== 'yml') continue;
    checked += 1;
    try {
      // `loadAll`, not `load`: a multi-document fence is legal YAML and must not
      // be reported as broken.
      yaml.loadAll(f.body);
    } catch (e) {
      const message = String(e.message).split('\n')[0];
      const why = exemption(f.body, message);
      const hit = { file: rel, line: f.line, message: message.slice(0, 120) };
      if (why) exempted.push({ ...hit, exemption: why });
      else failures.push(hit);
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ checked, failures, exempted }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

console.log(`yaml fences checked: ${checked}`);
// Reported, never skipped silently: an exemption list nobody can see is one
// nobody notices growing.
if (exempted.length) {
  const byClass = new Map();
  for (const e of exempted) byClass.set(e.exemption, (byClass.get(e.exemption) || 0) + 1);
  console.log(`exempted: ${exempted.length}  (${[...byClass.entries()].map(([k, v]) => `${k}=${v}`).join('  ')})`);
  for (const e of exempted) console.log(`  ${e.file}:${e.line}  [${e.exemption}]`);
}

if (failures.length === 0) {
  console.log('\nOK: every yaml-tagged fence parses, or is an exempted class.');
  process.exit(0);
}

console.log(`\n${failures.length} yaml-tagged fence(s) do not parse:`);
for (const f of failures) {
  console.log(`  ${f.file}:${f.line}`);
  console.log(`      ${f.message}`);
}
console.log('');
console.log('A fence tagged `yaml` is frozen to English by #472, so a mislabelled one');
console.log('freezes content that should have been translatable. Either fix the YAML, or');
console.log('— if it is a reference table a human reads rather than a machine — retag it');
console.log('`text` and let translators localise it.');
process.exit(1);
