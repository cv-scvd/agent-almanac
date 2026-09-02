#!/usr/bin/env node
/**
 * translator-stamp.mjs — keep the `translator:` frontmatter field honest on scaffolds (#545).
 *
 * A scaffold is a byte copy of its English source, so its `translator:` value must not claim a
 * translation or a review happened. `scripts/translate-content.sh` stamps the stub value; this
 * tool answers, for the corpus that already exists, "which byte-equal stubs still carry a value
 * that asserts more than that?" — and repairs exactly those, nothing else.
 *
 *   node tools/translator-stamp.mjs            # preview: classify every stamped file, change nothing
 *   node tools/translator-stamp.mjs --write    # rewrite the field in byte-equal stubs only
 *   node tools/translator-stamp.mjs --verify   # exit 1 if any byte-equal stub carries a non-stub value
 *
 * Stub-ness is decided by BODY EQUALITY, never by this field: the verdicts come from
 * `scripts/generate-translation-status.js --verdicts` (an inspection mode that writes nothing).
 * A file whose body carries translated lines is left alone whatever its field says — that is a
 * human attribution decision, and the preview lists such files so a PR body can carry them.
 *
 * The stub value is READ from the scaffolder, not duplicated here, so the tool and the scaffolder
 * cannot disagree silently; if the scaffolder no longer stamps a quoted value, every mode exits 2.
 * `stubValueFromScaffolder` is exported so `scripts/test/translator-stamp.test.js` can pin the
 * same rule against the documentation.
 *
 * Exit codes: 0 clean (or write done); 1 verify found violations; 2 the tool could not measure —
 * verdicts unparseable, zero STUB verdicts (a format change, not a clean corpus), or the stub
 * value missing from the scaffolder. Exit 2 is never a pass.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCAFFOLDER = join(ROOT, 'scripts', 'translate-content.sh');
const VERDICTS_SCRIPT = join(ROOT, 'scripts', 'generate-translation-status.js');

class CannotMeasure extends Error {}

/**
 * The value the scaffolder stamps today — the single source of truth. Throws `CannotMeasure`
 * when the scaffolder carries no quoted value or more than one distinct value.
 */
export function stubValueFromScaffolder(scaffolderPath = SCAFFOLDER) {
  const source = readFileSync(scaffolderPath, 'utf8');
  const matches = [...source.matchAll(/translator: \\"([^"\\]+)\\"/g)].map((m) => m[1]);
  if (matches.length === 0) throw new CannotMeasure(`no quoted translator value found in ${scaffolderPath}`);
  const distinct = new Set(matches);
  if (distinct.size !== 1) {
    throw new CannotMeasure(`scaffolder stamps ${distinct.size} different translator values: ${[...distinct].join(' | ')}`);
  }
  return matches[0];
}

/** Body-equality verdicts. Only STUB and UNJUDGED are listed; everything else is translated. */
function verdicts() {
  const out = execFileSync(process.execPath, [VERDICTS_SCRIPT, '--verdicts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const stub = new Set();
  const unjudged = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(STUB|UNJUDGED)\s+(\S+)/.exec(line);
    if (!m) continue;
    (m[1] === 'STUB' ? stub : unjudged).add(m[2]);
  }
  if (stub.size === 0) throw new CannotMeasure('zero STUB verdicts parsed — the verdict format changed, not the corpus');
  return { stub, unjudged };
}

/** Every tracked i18n markdown file carrying a translator field, with the field's value and line. */
function stampedFiles() {
  const listed = execFileSync('git', ['ls-files', '-z', 'i18n/*.md', 'i18n/**/*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && p !== 'i18n/README.md');
  const result = [];
  for (const rel of listed) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    if (lines[0] !== '---') continue;
    const close = lines.indexOf('---', 1);
    if (close === -1) continue;
    for (let i = 1; i < close; i += 1) {
      const m = /^(\s*)translator:\s*(.*?)\s*$/.exec(lines[i]);
      if (!m) continue;
      result.push({ rel, lineIndex: i, indent: m[1], raw: m[2], value: m[2].replace(/^"(.*)"$/, '$1'), lines, eol });
      break;
    }
  }
  return result;
}

function byValue(entries) {
  const groups = new Map();
  for (const e of entries) groups.set(e.value, (groups.get(e.value) ?? 0) + 1);
  return [...groups].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${String(n).padStart(6)}  ${v}`).join('\n');
}

function main(argv) {
  const args = new Set(argv);
  const known = new Set(['--write', '--verify']);
  for (const arg of args) {
    if (!known.has(arg)) {
      console.error(`unknown argument: ${arg}`);
      return 2;
    }
  }
  if (args.has('--write') && args.has('--verify')) {
    console.error('--write and --verify are separate runs; verify after writing');
    return 2;
  }

  const stubValue = stubValueFromScaffolder();
  const { stub, unjudged } = verdicts();
  const stamped = stampedFiles();

  const repair = [];     // byte-equal stubs whose field asserts more than "stub"
  const clean = [];      // byte-equal stubs already carrying the stub value
  const translated = []; // body carries translated lines — leave, list
  const unjudgedList = [];
  for (const entry of stamped) {
    if (stub.has(entry.rel)) {
      (entry.value === stubValue ? clean : repair).push(entry);
    } else if (unjudged.has(entry.rel)) {
      unjudgedList.push(entry);
    } else {
      translated.push(entry);
    }
  }

  console.log(`stub value (from scaffolder): "${stubValue}"`);
  console.log(`files with a translator field: ${stamped.length}`);
  console.log(`  byte-equal stubs needing repair: ${repair.length}`);
  console.log(`  byte-equal stubs already correct: ${clean.length}`);
  console.log(`  unjudged (fence mask untrustworthy, left alone): ${unjudgedList.length}`);
  console.log(`  translated bodies (left alone, attribution is a human call): ${translated.length}`);

  if (args.has('--verify')) {
    if (repair.length === 0) {
      console.log('OK: no byte-equal stub asserts a translation or review');
      return 0;
    }
    console.log('\nVIOLATIONS — byte-equal stubs carrying a non-stub attribution:');
    for (const e of repair) console.log(`  ${e.rel}  (${e.raw})`);
    return 1;
  }

  console.log('\nrepair set by current value:');
  console.log(byValue(repair) || '  (none)');
  console.log('\ntranslated-but-stamped, by current value (NOT touched):');
  console.log(byValue(translated.filter((e) => e.value !== stubValue)) || '  (none)');

  if (!args.has('--write')) {
    console.log('\npreview only — pass --write to rewrite the repair set');
    console.log('\nrepair set:');
    for (const e of repair) console.log(`  ${e.rel}`);
    return 0;
  }

  let written = 0;
  for (const e of repair) {
    e.lines[e.lineIndex] = `${e.indent}translator: "${stubValue}"`;
    writeFileSync(join(ROOT, e.rel), e.lines.join(e.eol));
    written += 1;
  }
  console.log(`\nwrote ${written} file(s); run --verify to confirm`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CannotMeasure) {
      console.error(`translator-stamp: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
