#!/usr/bin/env node
/**
 * agent-report.mjs — recover a subagent's final report from its transcript.
 *
 * A subagent's report reaches the lead as a notification that is truncated past a few thousand
 * characters, and a subagent whose Write tool is blocked (as `advocatus-diaboli`'s was in the
 * 2026-09-02 session, for a 35 KB ADR review) cannot save the report itself. The full text is
 * still in its transcript — `<session>/subagents/agent-<name>-<hash>.jsonl`, one JSON object per
 * line, assistant messages carrying `content: [{ type: 'text', text }]` blocks. This tool pulls
 * the LAST assistant text block containing a marker (the report's title line) and writes it to a
 * file verbatim, so the lead can save the deliverable where the subagent could not.
 *
 * Usage:
 *   node tools/agent-report.mjs <transcript.jsonl> <marker> <out.md>
 *   node tools/agent-report.mjs --verify
 *
 * Exit 0 on success; 1 if no assistant text carries the marker, or `--verify` fails; 2 on usage
 * or an unreadable transcript. Malformed lines are skipped (a transcript can hold partial writes),
 * but a transcript with NO parseable line is refused rather than reported as "marker not found".
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The last assistant text block containing `marker`, or null. Throws if nothing parsed. */
export function lastReport(transcriptText, marker) {
  const lines = transcriptText.split('\n').filter((l) => l.trim() !== '');
  let parsed = 0;
  let found = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    parsed += 1;
    const msg = entry?.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(marker)) found = block.text;
    }
  }
  if (parsed === 0) throw new Error('no parseable JSON line in the transcript');
  return found;
}

function verify() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-report-'));
  try {
    const checks = [];
    const check = (name, ok) => { checks.push([name, ok]); if (!ok) console.error(`FAIL: ${name}`); };
    const entry = (role, blocks) => JSON.stringify({ message: { role, content: blocks } });
    const transcript = [
      entry('user', [{ type: 'text', text: '# Report — not this one, wrong role' }]),
      entry('assistant', [{ type: 'text', text: '# Report\n\nfirst draft' }]),
      '{"partial": tru',
      entry('assistant', [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'text', text: 'interim text without the marker' }]),
      entry('assistant', [{ type: 'text', text: '# Report\n\nfinal text\n' }]),
    ].join('\n');
    check('picks the LAST assistant block with the marker', lastReport(transcript, '# Report') === '# Report\n\nfinal text\n');
    check('a user block with the marker is not a report', lastReport(entry('user', [{ type: 'text', text: '# Report' }]), '# Report') === null);
    check('marker absent → null', lastReport(transcript, '# Elsewhere') === null);
    let threw = false;
    try { lastReport('not json\nnor this', '# Report'); } catch { threw = true; }
    check('nothing parseable is refused, not null', threw);

    // The CLI end to end: writes the file verbatim, exit codes as documented.
    const t = join(dir, 't.jsonl');
    writeFileSync(t, transcript);
    const out = join(dir, 'out.md');
    check('cli: found → 0', main([t, '# Report', out]) === 0 && readFileSync(out, 'utf8') === '# Report\n\nfinal text\n');
    check('cli: not found → 1', main([t, '# Elsewhere', join(dir, 'none.md')]) === 1);
    check('cli: unreadable → 2', main([join(dir, 'missing.jsonl'), '# Report', out]) === 2);
    check('cli: usage → 2', main(['only-one']) === 2);

    const failed = checks.filter(([, ok]) => !ok).length;
    console.log(`agent-report --verify: ${checks.length - failed}/${checks.length} checks passed`);
    return failed ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv[0] === '--verify') return verify();
  if (argv.length !== 3 || argv.some((a) => a.startsWith('--'))) {
    console.error('Usage: node tools/agent-report.mjs <transcript.jsonl> <marker> <out.md> | --verify');
    return 2;
  }
  const [transcript, marker, outPath] = argv;
  let text;
  try {
    text = readFileSync(transcript, 'utf8');
  } catch (err) {
    console.error(`agent-report: cannot read ${transcript}: ${err.message}`);
    return 2;
  }
  let found;
  try {
    found = lastReport(text, marker);
  } catch (err) {
    console.error(`agent-report: ${err.message}`);
    return 2;
  }
  if (found === null) {
    console.error(`agent-report: no assistant text containing ${JSON.stringify(marker)} in ${transcript}`);
    return 1;
  }
  writeFileSync(outPath, found.endsWith('\n') ? found : `${found}\n`);
  console.log(`${found.length} chars → ${outPath}`);
  return 0;
}

// realpath on both sides; no try/catch, so a resolution failure throws rather than exiting 0.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
