/**
 * Unit tests for `scripts/lib/translation-status.js`.
 *
 * There was no test file for `generate-translation-status.js` at all, which is how #473 and
 * #532 both survived in the same twelve lines. The script is also unrunnable as a test: it
 * walks ten locales over an NTFS mount and takes ~10 minutes (#305). Extracting the verdict
 * into a pure function is what makes these assertions possible at all.
 *
 * Each test below names the failure it exists to catch. The three that matter most:
 *
 *   - a CRLF copy of an English body is still a scaffold (#532),
 *   - a scaffold stays a scaffold after English moves on (#473 — the window),
 *   - a scaffold assembled from two different English revisions is still a scaffold
 *     (surgical mirror propagation, which is why comparing against the `source_commit`
 *     blob does not work — measured on the four `harden-github-repo-security` files).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
  stripFrontmatter,
  openLines,
  substantiveLines,
  classifyTranslation,
  buildEnglishProseHistory,
  translationKey,
  MIN_LINES_TO_JUDGE,
} from '../lib/translation-status.js';
import { TREES } from '../lib/fences.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── fixtures ────────────────────────────────────────────────────────────────

const ENGLISH_BODY = [
  '# Create R Package',
  '',
  '## When to Use',
  '',
  'Use this skill when starting a new R package from scratch.',
  'It covers the directory layout and the DESCRIPTION file.',
  '',
  '## Procedure',
  '',
  '1. Run the scaffolding command shown below.',
  '',
  '```bash',
  'usethis::create_package("mypkg")',
  '```',
  '',
  'Verify the package directory was created before continuing.',
  'The DESCRIPTION file must name an author and a maintainer.',
  '',
].join('\n');

const withFrontmatter = (body, extra = '') => [
  '---',
  'name: create-r-package',
  'description: Scaffold an R package',
  extra,
  '---',
  body,
].filter((l) => l !== '').join('\n');

/** Every substantive line of `body`, as the English pool would hold them. */
const poolOf = (...bodies) => new Set(bodies.flatMap((b) => substantiveLines(b)));

// ── stripFrontmatter ────────────────────────────────────────────────────────

test('stripFrontmatter returns the body after the second delimiter', () => {
  const body = stripFrontmatter(withFrontmatter(ENGLISH_BODY));
  assert.ok(body.startsWith('# Create R Package'));
  assert.ok(!body.includes('description: Scaffold'));
});

test('stripFrontmatter normalises CRLF and lone CR (#532)', () => {
  // The defect: split on '\n' left an interior '\r' on every line, so byte comparison
  // against an LF source failed and the scaffold was recounted as a translation.
  const crlf = withFrontmatter(ENGLISH_BODY).replace(/\n/g, '\r\n');
  assert.equal(stripFrontmatter(crlf), stripFrontmatter(withFrontmatter(ENGLISH_BODY)));
  assert.ok(!stripFrontmatter(crlf).includes('\r'));

  const cr = withFrontmatter(ENGLISH_BODY).replace(/\n/g, '\r');
  assert.ok(!stripFrontmatter(cr).includes('\r'));
});

test('a file with no closing frontmatter delimiter keeps its whole text, normalised', () => {
  const text = '---\r\nname: x\r\n# heading\r\nbody line that is long enough\r\n';
  // Nothing is stripped — there is no second delimiter — but CRLF is still normalised, so
  // the fallback path cannot smuggle carriage returns into the comparison either.
  assert.equal(stripFrontmatter(text), '---\nname: x\n# heading\nbody line that is long enough\n');
});

// ── fence handling ──────────────────────────────────────────────────────────

test('frozen fence bodies are excluded, localisable ones are kept', () => {
  const text = [
    'Prose above the fence.',
    '```bash',
    'echo "this is keep-in-English by design"',
    '```',
    '```text',
    'This table is translatable prose.',
    '```',
  ].join('\n');
  const lines = openLines(text);
  // The frozen `bash` body and BOTH delimiter lines of each fence are gone.
  assert.ok(!lines.some((l) => l.includes('keep-in-English')));
  assert.ok(!lines.some((l) => l.startsWith('```')));
  // The `text` fence body survives — it is translatable, so English in it is evidence.
  assert.ok(lines.some((l) => l.includes('translatable prose')));
});

test('substantiveLines drops markdown scaffolding that matches in every locale', () => {
  const lines = substantiveLines('# Hi\n\n---\n1.\n**Note:**\nA line long enough to compare.\n');
  assert.deepEqual(lines, ['A line long enough to compare.']);
});

// ── the three failures this rewrite exists to fix ───────────────────────────

test('a scaffold is a scaffold after English moves on (#473 — the window)', () => {
  const scaffold = withFrontmatter(ENGLISH_BODY, '  source_commit: abc1234');
  const englishNow = `${ENGLISH_BODY}\nA paragraph added to English after the scaffold was made.\n`;
  // Pool spans history: the old body AND the current one.
  const pool = poolOf(ENGLISH_BODY, englishNow);

  const verdict = classifyTranslation({ translatedText: scaffold, locale: 'de', englishLines: pool });
  assert.equal(verdict.stub, true);
  assert.equal(verdict.reason, 'no-novel-lines');

  // And the point of the historical pool: comparing against current English ALONE would
  // still call it a stub here only because the old lines survived the edit. Delete one and
  // the single-revision comparison collapses, while the pooled one does not.
  const englishRewritten = ENGLISH_BODY
    .replace('Verify the package directory was created before continuing.', 'Confirm the directory exists.');
  assert.equal(
    classifyTranslation({ translatedText: scaffold, locale: 'de', englishLines: poolOf(englishRewritten) }).stub,
    false,
    'sanity: a single-revision pool loses the scaffold, which is exactly defect #473',
  );
  assert.equal(
    classifyTranslation({ translatedText: scaffold, locale: 'de', englishLines: poolOf(ENGLISH_BODY, englishRewritten) }).stub,
    true,
    'the historical pool keeps it',
  );
});

test('a CRLF scaffold is still a scaffold (#532)', () => {
  const scaffold = withFrontmatter(ENGLISH_BODY).replace(/\n/g, '\r\n');
  const verdict = classifyTranslation({ translatedText: scaffold, locale: 'de', englishLines: poolOf(ENGLISH_BODY) });
  assert.equal(verdict.stub, true, 'CRLF must not launder a scaffold into the translated count');
  assert.equal(verdict.novel, 0);
});

test('a scaffold surgically patched from a later revision is still a scaffold', () => {
  // The measured shape of the four `harden-github-repo-security` files: an old English body
  // with one paragraph spliced in from a newer English revision. It equals NO single
  // revision, which is why comparing against the `source_commit` blob fails.
  const englishNew = ENGLISH_BODY
    .replace('The DESCRIPTION file must name an author and a maintainer.',
      'The DESCRIPTION file must name an author, a maintainer and a licence.');
  const frankenstein = withFrontmatter(
    ENGLISH_BODY.replace('The DESCRIPTION file must name an author and a maintainer.',
      'The DESCRIPTION file must name an author, a maintainer and a licence.'),
  );

  // Neither single revision explains it...
  assert.equal(classifyTranslation({ translatedText: frankenstein, locale: 'de', englishLines: poolOf(ENGLISH_BODY) }).stub, false);
  // ...but the union of revisions does.
  assert.equal(
    classifyTranslation({ translatedText: frankenstein, locale: 'de', englishLines: poolOf(ENGLISH_BODY, englishNew) }).stub,
    true,
  );
});

// ── the other side: genuine translations must survive ───────────────────────

test('a genuine translation is not a scaffold', () => {
  const german = withFrontmatter([
    '# R-Paket erstellen',
    '',
    '## Wann zu verwenden',
    '',
    'Verwende diese Faehigkeit, wenn du ein neues R-Paket beginnst.',
    'Sie behandelt das Verzeichnislayout und die DESCRIPTION-Datei.',
    '',
    '```bash',
    'usethis::create_package("mypkg")',
    '```',
    '',
    'Pruefe, dass das Paketverzeichnis angelegt wurde, bevor du fortfaehrst.',
    'Die DESCRIPTION-Datei muss Autor und Betreuer nennen.',
  ].join('\n'));
  const verdict = classifyTranslation({ translatedText: german, locale: 'de', englishLines: poolOf(ENGLISH_BODY) });
  assert.equal(verdict.stub, false);
  assert.equal(verdict.reason, 'has-novel-lines');
});

test('a near-English compressed tier is not a scaffold on one differing line', () => {
  // caveman-lite is SPECIFIED to keep grammar, articles and full sentences, and measures
  // ~90% verbatim English lines corpus-wide. Any similarity threshold that catches a
  // scaffold also condemns this tier for meeting its spec — hence a zero-evidence rule.
  const caveman = withFrontmatter(
    ENGLISH_BODY.replace('Use this skill when starting a new R package from scratch.',
      'Use skill when start new R package from scratch.'),
  );
  const verdict = classifyTranslation({ translatedText: caveman, locale: 'caveman-lite', englishLines: poolOf(ENGLISH_BODY) });
  assert.equal(verdict.stub, false);
  assert.equal(verdict.novel, 1);
});

test('an identical body under a locale with no script rule still needs prose evidence', () => {
  const verdict = classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY),
    locale: 'caveman',
    englishLines: poolOf(ENGLISH_BODY),
  });
  assert.equal(verdict.stub, true);
});

// ── the script rule ─────────────────────────────────────────────────────────

test('a CJK-script locale with no CJK is a scaffold regardless of prose', () => {
  // Decisive: a Japanese document containing zero kana and zero han is not Japanese. This
  // fires even when the prose comparison cannot, e.g. against an empty pool.
  const verdict = classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY),
    locale: 'ja',
    englishLines: new Set(),
  });
  assert.equal(verdict.stub, true);
  assert.equal(verdict.reason, 'no-script');
});

test('the script rule reads the body, not the frontmatter', () => {
  // A scaffold whose frontmatter names the locale in its own script must not pass.
  const scaffold = withFrontmatter(ENGLISH_BODY, '  name_native: 日本語');
  assert.equal(classifyTranslation({ translatedText: scaffold, locale: 'ja', englishLines: new Set() }).stub, true);
});

test('a translated CJK file passes the script rule and then the prose rule', () => {
  const japanese = withFrontmatter([
    '# Rパッケージの作成',
    '',
    'このスキルは新しいRパッケージを最初から作成するときに使用します。',
    'ディレクトリ構成とDESCRIPTIONファイルについて説明します。',
    'パッケージディレクトリが作成されたことを確認してから続行してください。',
    'DESCRIPTIONファイルには著者と管理者を記載する必要があります。',
    'この手順は一度だけ実行してください。',
  ].join('\n'));
  const verdict = classifyTranslation({ translatedText: japanese, locale: 'ja', englishLines: poolOf(ENGLISH_BODY) });
  assert.equal(verdict.stub, false);
  assert.equal(verdict.reason, 'has-novel-lines');
});

test('zh-CN does not accept kana as evidence of Chinese', () => {
  // Kana only — no han. `行` would be a Han character and would defeat the point.
  const kanaOnly = withFrontmatter(`${ENGLISH_BODY}\nこれはひらがなだけのぎょうです。\n`);
  assert.equal(classifyTranslation({ translatedText: kanaOnly, locale: 'zh-CN', englishLines: poolOf(ENGLISH_BODY) }).reason, 'no-script');
  assert.equal(classifyTranslation({ translatedText: kanaOnly, locale: 'ja', englishLines: poolOf(ENGLISH_BODY) }).reason, 'has-novel-lines');
});

// ── the lenient residue, stated rather than hidden ──────────────────────────

test('a verdict that did not measure reports novel as null, never 0', () => {
  // The `--verdicts` list is what a maintainer reads before deleting files. A `0` there
  // means "compared, nothing novel". These three paths return BEFORE the comparison runs,
  // and reporting 0 fabricates a measurement in the one place it does the most damage:
  // `(no-script, 0/57)` reads open-and-shut for a file that may carry forty novel lines.
  const english = poolOf(ENGLISH_BODY);

  const noScript = classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY), locale: 'ja', englishLines: english,
  });
  assert.equal(noScript.reason, 'no-script');
  assert.equal(noScript.novel, null);

  const noSource = classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY), locale: 'de', englishLines: undefined,
  });
  assert.equal(noSource.reason, 'no-source');
  assert.equal(noSource.novel, null);

  const short = classifyTranslation({
    translatedText: withFrontmatter('# Title\n\nOne single line of prose here.\n'),
    locale: 'de',
    englishLines: english,
  });
  assert.equal(short.reason, 'insufficient');
  assert.equal(short.novel, null);

  // And the paths that DO measure still report a number, including zero.
  assert.equal(classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY), locale: 'de', englishLines: english,
  }).novel, 0);
});

test('a file too short to judge is reported insufficient, not a scaffold', () => {
  const tiny = withFrontmatter('# Title\n\nOne single line of prose here.\n');
  const verdict = classifyTranslation({ translatedText: tiny, locale: 'de', englishLines: poolOf(ENGLISH_BODY) });
  assert.equal(verdict.stub, false);
  assert.equal(verdict.reason, 'insufficient');
  assert.ok(verdict.total < MIN_LINES_TO_JUDGE);
});

// The boundary, pinned on BOTH sides with literal counts. Asserting
// `total < MIN_LINES_TO_JUDGE` against the imported constant is self-referential and
// cannot fix a value: mutating 5 to 2, 3 or 4 survives it. These two do not — the fixtures
// are built to have exactly 5 and exactly 4 substantive lines by construction.
const lineOfLength = (n, i) => `Fixture prose line ${i}`.padEnd(n, 'x');

test('exactly MIN_LINES_TO_JUDGE substantive lines is enough to judge', () => {
  const body = Array.from({ length: 5 }, (_, i) => lineOfLength(20, i)).join('\n\n');
  const verdict = classifyTranslation({
    translatedText: withFrontmatter(body), locale: 'de', englishLines: poolOf(body),
  });
  assert.equal(verdict.total, 5, 'fixture must sit exactly on the boundary');
  assert.equal(verdict.reason, 'no-novel-lines');
  assert.equal(verdict.stub, true);
});

test('one line below the boundary is not judged', () => {
  const body = Array.from({ length: 4 }, (_, i) => lineOfLength(20, i)).join('\n\n');
  const verdict = classifyTranslation({
    translatedText: withFrontmatter(body), locale: 'de', englishLines: poolOf(body),
  });
  assert.equal(verdict.total, 4);
  assert.equal(verdict.reason, 'insufficient');
  assert.equal(verdict.stub, false);
});

test('MIN_COMPARABLE_LINE_CHARS is pinned at both ends too', () => {
  // A 12-character line counts; an 11-character one does not. Without this, `>=` mutates to
  // `>` and nothing notices.
  const twelve = 'abcdefghijkl';
  const eleven = 'abcdefghijk';
  assert.equal(twelve.length, 12);
  assert.deepEqual(substantiveLines(`${twelve}\n${eleven}\n`), [twelve]);
});

test('a translation whose English source is gone is reported no-source', () => {
  const verdict = classifyTranslation({
    translatedText: withFrontmatter(ENGLISH_BODY),
    locale: 'de',
    englishLines: undefined,
  });
  assert.equal(verdict.stub, false);
  assert.equal(verdict.reason, 'no-source');
});

// ── the pool key ────────────────────────────────────────────────────────────

test('translationKey agrees with contentKey, including on what is not content', () => {
  assert.equal(translationKey('skills', 'create-r-package'), 'skills/create-r-package');
  assert.equal(translationKey('guides', 'agent-best-practices'), 'guides/agent-best-practices');
  assert.equal(translationKey('agents', 'r-developer'), 'agents/r-developer');
  // The reason this helper exists rather than a second `${tree}/${id}` in the caller: a
  // mirror of a template or a README keys to nothing, reports `no-source`, and is counted
  // as translated. Both branches must exclude them, which is what #519 was about.
  assert.equal(translationKey('skills', '_template'), null);
  assert.equal(translationKey('guides', '_template'), null);
  assert.equal(translationKey('teams', 'README'), null);
});

test('every content tree present in i18n/ is one the scan walks', () => {
  // `generate-translation-status.js` iterates `TREES`, and `buildEnglishProseHistory` pools
  // from `TREES` — one list, so they cannot disagree. What they CAN both miss is a tree that
  // exists in the corpus and is in neither: it would be silently absent from every coverage
  // number, with no error. Mutating `contentTypes` away from `TREES` in the script survives
  // the unit suite (no seam), so this asserts the corpus-level invariant instead.
  const i18nDir = join(REPO_ROOT, 'i18n');
  const found = new Set();
  for (const locale of readdirSync(i18nDir)) {
    const localeDir = join(i18nDir, locale);
    if (!statSync(localeDir).isDirectory()) continue;
    for (const entry of readdirSync(localeDir)) {
      if (statSync(join(localeDir, entry)).isDirectory()) found.add(entry);
    }
  }
  const unscanned = [...found].filter((tree) => !TREES.includes(tree)).sort();
  assert.deepEqual(unscanned, [],
    `i18n/ carries content tree(s) the status scan never visits: ${unscanned.join(', ')}`);
});

// ── the git path ────────────────────────────────────────────────────────────

test('buildEnglishProseHistory pools every revision a source has had', () => {
  const repo = mkdtempSync(join(tmpdir(), 'aa-tstatus-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');

    const skillDir = join(repo, 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    const path = join(skillDir, 'SKILL.md');

    const first = withFrontmatter('# Demo\n\nThe first revision said something specific here.\n');
    writeFileSync(path, first);
    git('add', '-A');
    git('commit', '-qm', 'first');

    const second = withFrontmatter('# Demo\n\nThe second revision says something else entirely.\n');
    writeFileSync(path, second);
    git('add', '-A');
    git('commit', '-qm', 'second');

    const history = buildEnglishProseHistory(repo);
    const lines = history.get('skills/demo-skill');
    assert.ok(lines, 'the skill must be keyed by contentKey');
    assert.ok(lines.has('The first revision said something specific here.'),
      'a line deleted from English is still English — this is what makes the detector survive surgical propagation');
    assert.ok(lines.has('The second revision says something else entirely.'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildEnglishProseHistory includes uncommitted English edits', () => {
  const repo = mkdtempSync(join(tmpdir(), 'aa-tstatus-wt-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');

    const skillDir = join(repo, 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), withFrontmatter('# Demo\n\nCommitted prose line for the base.\n'));
    git('add', '-A');
    git('commit', '-qm', 'base');

    writeFileSync(join(skillDir, 'SKILL.md'), withFrontmatter('# Demo\n\nUncommitted prose line in the working tree.\n'));

    const lines = buildEnglishProseHistory(repo).get('skills/demo-skill');
    assert.ok(lines.has('Uncommitted prose line in the working tree.'),
      'an uncommitted English edit is a legal basis, or every local scaffold reads as translated');
    assert.ok(lines.has('Committed prose line for the base.'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a missing blob does not shift the batch parser onto the wrong key', () => {
  // The batch loop walks `git cat-file --batch` output positionally: each `missing` header
  // must advance the spec index WITHOUT consuming a payload. If that skip is wrong, every
  // subsequent blob is attributed to the previous spec's key, and the pools are silently
  // wrong rather than empty — the worst available failure. Two skills are used so a
  // misalignment lands prose in the other one's basis, where it is visible.
  const repo = mkdtempSync(join(tmpdir(), 'aa-tstatus-missing-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');

    for (const [id, line] of [['alpha-skill', 'Alpha prose line, unique to alpha.'], ['beta-skill', 'Beta prose line, unique to beta.']]) {
      mkdirSync(join(repo, 'skills', id), { recursive: true });
      writeFileSync(join(repo, 'skills', id, 'SKILL.md'), withFrontmatter(`# ${id}\n\n${line}\n`));
    }
    git('add', '-A');
    git('commit', '-qm', 'two skills');

    // Delete one and commit: its path now appears in history at a commit where the OTHER
    // skill's blob is absent, so the walk emits specs that resolve to `missing`.
    rmSync(join(repo, 'skills', 'alpha-skill'), { recursive: true, force: true });
    git('add', '-A');
    git('commit', '-qm', 'delete alpha');

    const history = buildEnglishProseHistory(repo);
    assert.ok(history.get('skills/alpha-skill')?.has('Alpha prose line, unique to alpha.'));
    assert.ok(history.get('skills/beta-skill')?.has('Beta prose line, unique to beta.'));
    assert.equal(history.get('skills/beta-skill')?.has('Alpha prose line, unique to alpha.'), false,
      'a misaligned batch parse would cross-pollinate the two bases');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildEnglishProseHistory excludes templates and READMEs', () => {
  const repo = mkdtempSync(join(tmpdir(), 'aa-tstatus-tpl-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');

    mkdirSync(join(repo, 'skills', '_template'), { recursive: true });
    writeFileSync(join(repo, 'skills', '_template', 'SKILL.md'), withFrontmatter('# T\n\nTemplate prose line here.\n'));
    mkdirSync(join(repo, 'guides'), { recursive: true });
    writeFileSync(join(repo, 'guides', 'README.md'), '# Guides\n\nGenerated index prose line.\n');
    git('add', '-A');
    git('commit', '-qm', 'templates');

    const history = buildEnglishProseHistory(repo);
    assert.equal(history.get('skills/_template'), undefined);
    assert.equal(history.get('guides/README'), undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
