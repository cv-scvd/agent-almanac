/**
 * Unit tests for `scripts/check-bare-substitutions.js` (#647).
 *
 * The envelope (`scripts/envelopes/bare-substitution-lint.mjs`) proves the check goes red
 * against the real corpus. These cover the parsing decisions that envelope cannot reach,
 * because each of them was a bug that made the check report the WRONG verdict rather than no
 * verdict — and a wrong verdict on a lint is worse than none, since it is read as an all-clear.
 *
 * Each test names the specific misreading it exists to catch. Four of them are regressions found
 * by running the check against this repo and disbelieving its first output — the arithmetic
 * expansion, the multi-line span, `|| return`, and the helper's own assertion style.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-bare-substitutions.js');

/**
 * Run the check over a throwaway git repo containing one script.
 *
 * A real repo, not a bare directory, because the check asks `git ls-files` rather than walking
 * the filesystem — a walk over this repo followed the `.claude/skills` symlink farm and did not
 * finish in 60 seconds.
 */
function checkScript(body, name = 'probe.sh') {
  const dir = mkdtempSync(join(tmpdir(), 'bare-subs-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', name), body);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const output = execFileSync('node', [CHECK, '--root', dir, '--warn', '--list'], {
      cwd: dir, encoding: 'utf8',
    });
    // Counts, not a substring search on the whole output. The first version of this helper
    // returned the raw text and every test asserted `doesNotMatch(/UNGUARDED/)` — which fails
    // against a clean run, because the SUMMARY line reads `UNGUARDED: 0`. Eight tests went red
    // on a check that was working. Asserting on the label instead of the finding is the same
    // instrument error the repo records elsewhere; the fix is to read the number.
    const count = (label) => Number((output.match(new RegExp(`${label}:\\s+(\\d+)`)) || [])[1] ?? -1);
    return {
      output,
      scanned: Number((output.match(/scanned: (\d+)/) || [])[1] ?? -1),
      unguarded: count('UNGUARDED'),
      safe: count('closed safe list\\)'),
      annotated: count('# abort-ok:\\)'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HEAD = '#!/usr/bin/env bash\nset -euo pipefail\n';

test('a bare grep assignment is reported', () => {
  const out = checkScript(`${HEAD}x=$(grep foo bar.txt)\n`);
  assert.equal(out.scanned, 1);
  assert.equal(out.unguarded, 1);
  assert.match(out.output, /can abort the script/);
});

test('a guarded one is not', () => {
  const out = checkScript(`${HEAD}x=$(grep foo bar.txt || true)\n`);
  assert.equal(out.unguarded, 0);
});

test('`|| return` counts as a guard', () => {
  // Not cosmetic: `wf_event_paths` in validate-integrity.sh is guarded exactly this way, and
  // the first version of the GUARD pattern reported the repo's most carefully-handled site as
  // unguarded. A checker whose first output is wrong about its own repo gets ignored.
  const out = checkScript(`${HEAD}f() {\n  local a\n  a=$(grep x y || return 1)\n  echo "$a"\n}\n`);
  assert.equal(out.unguarded, 0);
});

test('arithmetic expansion is not a command substitution', () => {
  // `$((` is not `$(`. The first pattern matched it, so every `count=$((count + 1))` in the
  // corpus was reported with a "pipeline" consisting of the variable's own name — 10 findings
  // indistinguishable at a glance from the real ones.
  const out = checkScript(`${HEAD}n=0\nn=$((n + 1))\n`);
  assert.equal(out.unguarded, 0);
});

test('a guard on the last line of a multi-line substitution is found', () => {
  // The span scanner counted parens on raw text, so an embedded awk program containing
  // `sub(/x/, "", line)` drove the depth negative on parens that were never openers. The span
  // ended mid-program, above the real `|| true`, and a guarded site was reported UNGUARDED.
  const body = `${HEAD}x=$(printf '%s\\n' "$y" \\
  | awk '
      /^a/ { sub(/^a/, "", $0); print }
    ' \\
  | sed 's/b/c/' || true)
`;
  const out = checkScript(body);
  assert.equal(out.unguarded, 0);
});

test('a pipeline of only safe commands needs no guard', () => {
  const out = checkScript(`${HEAD}x=$(printf 'a\\nb\\n' | sort | uniq | wc -l)\n`);
  assert.equal(out.safe, 1);
  assert.equal(out.unguarded, 0);
});

test('an unknown command is treated as unsafe — the safe list is the enumerated one', () => {
  // Default-deny. A dangerous-command list would wave `jq` through on the day someone first
  // uses it; enumerating the safe side means the unknown case fails closed.
  const out = checkScript(`${HEAD}x=$(printf 'a' | jq -R .)\n`);
  assert.equal(out.unguarded, 1);
});

test('`# abort-ok:` exempts a site and its text is not otherwise interpreted', () => {
  const out = checkScript(`${HEAD}x=$(grep foo bar.txt) # abort-ok: bar.txt is generated one line above\n`);
  assert.equal(out.annotated, 1);
  assert.equal(out.unguarded, 0);
});

test('a script without set -e is out of scope', () => {
  // The hazard there is a silently empty value, not a vanished run. Reporting it would bury
  // the findings that actually kill a gate.
  const out = checkScript('#!/usr/bin/env bash\nx=$(grep foo bar.txt)\n');
  assert.equal(out.unguarded, 0);
});

test('`local x=$(…)` is skipped, and that is the documented limit', () => {
  // It genuinely cannot abort — the status becomes `local`'s, always 0. Pinned as a test so
  // the exemption reads as a decision rather than as a gap someone should quietly close.
  const out = checkScript(`${HEAD}f() {\n  local x=$(grep foo bar.txt)\n  echo "$x"\n}\n`);
  assert.equal(out.unguarded, 0);
});
