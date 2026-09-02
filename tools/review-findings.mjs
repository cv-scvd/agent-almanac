#!/usr/bin/env node
/**
 * review-findings.mjs — turn a review-workflow's task output into the findings file the next
 * round needs, plus a verdict table on stdout.
 *
 * The lens → refuter review workflows this repository runs (see #778 for the seed that should
 * replace the inline copies) return `{ lenses: [{ lens, filesRead, notes, verified, … }],
 * surviving, blocking }`, where each `verified` finding carries the reviewer's claim, evidence
 * and fix beside the refuter's `verdict`. The Workflow tool truncates that result in the
 * notification, so the file to read is the task output under the session's `tasks/` directory —
 * a JSON document whose `result` is the return value (as an object, or as a JSON string).
 *
 * Output: a markdown file with one section per lens, every serious finding first (severity,
 * adjusted severity, REFUTED or holds, location, claim, evidence, fix, refuter reasoning), then
 * the notes; and on stdout one tab-separated row per serious finding
 * (`lens id severity holds|REFUTED adjustedSeverity location`), the note counts per lens, the
 * workflow's log lines, and any `round1NotApplied` ids a round-2 run reported.
 *
 * Usage:
 *   node tools/review-findings.mjs <task-output.json> <findings.md> [title]
 *   node tools/review-findings.mjs --verify
 *
 * Exit 0 on success; 1 if `--verify` fails; 2 on usage, an unreadable input, or an input that
 * carries no `lenses` array — a file that parses but is not a review result is refused, not
 * rendered empty.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read a task output and return the review result object, or throw with a reason. */
export function loadResult(inPath) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(inPath, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${inPath} as JSON: ${err.message}`);
  }
  const result = typeof doc.result === 'string' ? JSON.parse(doc.result) : (doc.result ?? doc);
  if (!result || !Array.isArray(result.lenses)) throw new Error(`${inPath} carries no \`lenses\` array — not a review result`);
  return { result, logs: Array.isArray(doc.logs) ? doc.logs : [] };
}

/** Render the findings markdown and the stdout table from a result. Pure. */
export function render(result, logs, title) {
  let out = `# ${title}\n\nsurviving serious: ${result.surviving ?? '?'}, blocking: ${result.blocking ?? '?'}\n\n`;
  const rows = [];
  const noteCounts = [];
  const notApplied = [];
  for (const L of result.lenses) {
    const verified = Array.isArray(L.verified) ? L.verified : [];
    const notes = Array.isArray(L.notes) ? L.notes : [];
    out += `## lens: ${L.lens}\n\n`;
    if (Array.isArray(L.round1NotApplied) && L.round1NotApplied.length) {
      out += `round-1 not applied: ${L.round1NotApplied.join(', ')}\n\n`;
      notApplied.push(...L.round1NotApplied.map((id) => `${L.lens}:${id}`));
    }
    for (const f of verified) {
      const v = f.verdict || {};
      out += `### ${f.id} [${f.severity} → ${v.adjustedSeverity ?? '?'}${v.refuted ? ' REFUTED' : ''}] ${f.file} @ ${f.location}\n\n`
        + `**Claim:** ${f.claim}\n\n**Evidence:** ${f.evidence}\n\n**Fix:** ${f.fix}\n\n**Refuter:** ${v.reasoning ?? ''}\n\n`;
      rows.push([L.lens, f.id, f.severity, v.refuted ? 'REFUTED' : 'holds', v.adjustedSeverity ?? '?', String(f.location ?? '').slice(0, 70)].join('\t'));
    }
    for (const n of notes) {
      out += `### ${n.id} [note] ${n.file} @ ${n.location}\n\n**Claim:** ${n.claim}\n\n**Evidence:** ${n.evidence}\n\n**Fix:** ${n.fix}\n\n`;
    }
    noteCounts.push(`${L.lens}=${notes.length}`);
  }
  const table = [...rows, `notes: ${noteCounts.join(' ')}`, `logs: ${logs.join(' | ')}`];
  if (notApplied.length) table.push(`round-1 not applied: ${notApplied.join(', ')}`);
  return { markdown: out, table: table.join('\n') };
}

function verify() {
  const dir = mkdtempSync(join(tmpdir(), 'review-findings-'));
  try {
    const result = {
      surviving: 1,
      blocking: 0,
      lenses: [{
        lens: 'alpha',
        filesRead: ['a'],
        round1NotApplied: ['G9'],
        verified: [
          { id: 'A1', severity: 'should-fix', file: 'x.js', location: 'line 1', claim: 'c1', evidence: 'e1', fix: 'f1', verdict: { refuted: false, reasoning: 'holds', adjustedSeverity: 'should-fix' } },
          { id: 'A2', severity: 'blocking', file: 'x.js', location: 'line 2', claim: 'c2', evidence: 'e2', fix: 'f2', verdict: { refuted: true, reasoning: 'no', adjustedSeverity: 'refuted' } },
        ],
        notes: [{ id: 'A3', severity: 'note', file: 'x.js', location: 'line 3', claim: 'c3', evidence: 'e3', fix: 'f3' }],
      }],
    };
    const checks = [];
    const check = (name, ok) => { checks.push([name, ok]); if (!ok) console.error(`FAIL: ${name}`); };

    // Both encodings of `result`: an object, and a JSON string (what the task file carries).
    for (const [label, doc] of [['object', { result, logs: ['l1'] }], ['string', { result: JSON.stringify(result), logs: ['l1'] }]]) {
      const p = join(dir, `${label}.json`);
      writeFileSync(p, JSON.stringify(doc));
      const loaded = loadResult(p);
      check(`${label}: lenses loaded`, loaded.result.lenses.length === 1 && loaded.logs[0] === 'l1');
      const { markdown, table } = render(loaded.result, loaded.logs, 'T');
      check(`${label}: heading`, markdown.startsWith('# T\n\nsurviving serious: 1, blocking: 0\n'));
      check(`${label}: serious first, REFUTED marked`, markdown.indexOf('### A1 [should-fix → should-fix]') < markdown.indexOf('### A2 [blocking → refuted REFUTED]'));
      check(`${label}: note after serious`, markdown.indexOf('### A2') < markdown.indexOf('### A3 [note]'));
      check(`${label}: not-applied line`, markdown.includes('round-1 not applied: G9\n'));
      const lines = table.split('\n');
      check(`${label}: table rows`, lines[0] === 'alpha\tA1\tshould-fix\tholds\tshould-fix\tline 1' && lines[1] === 'alpha\tA2\tblocking\tREFUTED\trefuted\tline 2');
      check(`${label}: note count and logs`, lines[2] === 'notes: alpha=1' && lines[3] === 'logs: l1' && lines[4] === 'round-1 not applied: alpha:G9');
    }
    // Refusals: not JSON; JSON without lenses.
    writeFileSync(join(dir, 'bad.json'), '{not json');
    let threw = false;
    try { loadResult(join(dir, 'bad.json')); } catch { threw = true; }
    check('not JSON is refused', threw);
    writeFileSync(join(dir, 'nolens.json'), JSON.stringify({ result: { surviving: 0 } }));
    threw = false;
    try { loadResult(join(dir, 'nolens.json')); } catch (err) { threw = /no `lenses` array/.test(err.message); }
    check('no lenses is refused with its reason', threw);

    const failed = checks.filter(([, ok]) => !ok).length;
    console.log(`review-findings --verify: ${checks.length - failed}/${checks.length} checks passed`);
    return failed ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv[0] === '--verify') return verify();
  if (argv.length < 2 || argv.some((a) => a.startsWith('--'))) {
    console.error('Usage: node tools/review-findings.mjs <task-output.json> <findings.md> [title] | --verify');
    return 2;
  }
  const [inPath, outPath, title = 'Review findings'] = argv;
  let loaded;
  try {
    loaded = loadResult(inPath);
  } catch (err) {
    console.error(`review-findings: ${err.message}`);
    return 2;
  }
  const { markdown, table } = render(loaded.result, loaded.logs, title);
  writeFileSync(outPath, markdown);
  console.log(table);
  return 0;
}

// realpath on both sides; no try/catch, so a resolution failure throws rather than exiting 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
