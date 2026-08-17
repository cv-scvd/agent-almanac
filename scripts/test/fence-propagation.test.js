/**
 * fence-propagation.test.js — `scripts/check-fence-propagation.js` (#551).
 *
 * The tool exists because the parity gate CANNOT answer the question it answers: parity
 * accepts a gated body from any English revision, so a mirror that never followed an
 * English fence edit stays green forever. That makes one test load-bearing above the
 * rest — `flags a mirror that lags current English` — and it is written the way the
 * failure actually occurs: English moves, the mirror does not.
 *
 * Fixtures are plain directories, not git repos. The tool reads the working tree only,
 * which is the whole point of it; giving it history would reintroduce the blind spot.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO, 'scripts', 'check-fence-propagation.js');

const skill = (fence, tag = 'yaml') => [
  '---', 'name: demo-skill', 'description: A demo skill.', '---', '',
  '# Demo Skill', '', '## Procedure', '',
  '```' + tag, fence, '```', '',
].join('\n');

/**
 * A fixture root with one English skill and one mirror per entry in `mirrors`.
 * @param {{english: string, mirrors: Record<string, string|{body: string, tag: string}>}} spec
 */
function makeRoot(t, { english, mirrors, tree = 'skills', id = 'demo-skill' }) {
  const dir = mkdtempSync(join(tmpdir(), 'fence-prop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const englishFile = tree === 'skills'
    ? join(dir, 'skills', id, 'SKILL.md')
    : join(dir, tree, `${id}.md`);
  mkdirSync(dirname(englishFile), { recursive: true });
  writeFileSync(englishFile, english, 'utf8');

  for (const [locale, value] of Object.entries(mirrors)) {
    const spec = typeof value === 'string' ? { body: value, tag: 'yaml' } : value;
    const file = tree === 'skills'
      ? join(dir, 'i18n', locale, 'skills', id, 'SKILL.md')
      : join(dir, 'i18n', locale, tree, `${id}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, skill(spec.body, spec.tag), 'utf8');
  }
  return dir;
}

function run(dir, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, '--root', dir, '--json', ...extra], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
}

const LIVE = 'replicas: {{ .Values.replicaCount }}';
const MOVED = '{{- if not .Values.autoscaling.enabled }}\nreplicas: {{ .Values.replicaCount }}\n{{- end }}';

describe('check-fence-propagation (#551)', () => {
  it('is clean when every mirror carries the English body verbatim', (t) => {
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: { de: LIVE, ja: LIVE } });
    const { status, out } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 0);
    assert.deepEqual(out.findings, []);
    assert.equal(out.mirrorsCompared, 2);
    assert.equal(out.frozenFences, 1);
  });

  it('flags a mirror that lags current English — the case parity cannot see', (t) => {
    // English moved, the mirror did not. `check-i18n-fence-parity.js` accepts the
    // mirror because its body is in some English revision; this tool must not.
    const dir = makeRoot(t, { english: skill(MOVED), mirrors: { de: MOVED, ja: LIVE } });
    const { status, out } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 1);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].locale, 'ja');
    assert.equal(out.findings[0].kind, 'lags-english');
    assert.equal(out.findings[0].ordinal, 0);
    assert.equal(out.findings[0].tag, 'yaml');
  });

  it('compares WHOLE bodies, not the inserted lines', (t) => {
    // The trap the eleven-file propagation was verified against: a mirror can carry
    // the line you added and still differ elsewhere in the same fence, because it
    // matched a different historical revision to begin with. A substring check on
    // the insertion passes here; a body comparison must not.
    const english = skill(`${MOVED}\nimage: repo:{{ .Values.image.tag | default .Chart.AppVersion }}`);
    const stale = `${MOVED}\nimage: repo:{{ .Values.image.tag }}`;
    const dir = makeRoot(t, { english, mirrors: { de: stale } });
    const { status, out } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 1, 'a mirror carrying the insertion but stale elsewhere must still be flagged');
    assert.equal(out.findings[0].kind, 'lags-english');
  });

  it('ignores a fence that is not frozen', (t) => {
    // `text` is exempt by the closed exemption list, so a translated body there is
    // legitimate and must not be reported as a lag.
    const dir = makeRoot(t, {
      english: skill('report template', 'text'),
      mirrors: { de: { body: 'Berichtsvorlage', tag: 'text' } },
    });
    const { status, out } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 0);
    assert.equal(out.frozenFences, 0);
    assert.deepEqual(out.findings, []);
  });

  it('refuses to compare a mirror whose tag sequence differs', (t) => {
    // Ordinal mapping is unsound then — the same refusal normalize-i18n-fences.js
    // makes. Reporting it as a body lag would be a fabricated finding.
    const dir = makeRoot(t, {
      english: skill(LIVE),
      mirrors: { de: { body: LIVE, tag: 'bash' } },
    });
    const { status, out } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 1);
    assert.equal(out.findings[0].kind, 'unalignable');
    assert.equal(out.findings[0].locale, 'de');
  });

  it('refuses an id with no mirrors rather than reporting it clean', (t) => {
    // The vacuity refusal. A typo'd id returning "0 findings" is the answer this
    // tool exists never to give, and it is the exact shape that made an earlier
    // scoped gate report a clean-looking zero over nothing.
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: {} });
    const { status, stderr } = run(dir, ['--id', 'demo-skill']);
    assert.equal(status, 2);
    assert.match(stderr, /no translated mirrors/);
  });

  it('requires --id — it is not one keystroke from a corpus-wide run', (t) => {
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: { de: LIVE } });
    const r = spawnSync(process.execPath, [TOOL, '--root', dir], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--id is required/);
  });

  it('rejects an unknown argument instead of ignoring it', (t) => {
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: { de: LIVE } });
    const r = spawnSync(process.execPath, [TOOL, '--root', dir, '--id', 'demo-skill', '--wat'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unrecognised argument/);
  });

  it('resolves the tree by finding the id, and reports where it looked', (t) => {
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: { de: LIVE }, tree: 'guides', id: 'demo-guide' });
    const { status, out } = run(dir, ['--id', 'demo-guide']);
    assert.equal(status, 0);
    assert.equal(out.tree, 'guides');
  });

  it('rejects --tree naming a tree the id is not in', (t) => {
    const dir = makeRoot(t, { english: skill(LIVE), mirrors: { de: LIVE } });
    const r = spawnSync(process.execPath, [TOOL, '--root', dir, '--id', 'demo-skill', '--tree', 'guides'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no English source at/);
  });
});
