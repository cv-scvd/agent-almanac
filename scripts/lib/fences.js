/**
 * fences.js
 *
 * Shared fenced-code-block extractor for the i18n fence-parity tooling (#472).
 * Used by `check-i18n-fence-parity.js` (which reports) and
 * `normalize-i18n-fences.js` (which rewrites), so the two can never disagree
 * about where a fence starts and ends.
 *
 * Two properties are load-bearing:
 *
 * 1. **CRLF is normalised before parsing.** 69 translated SKILL.md carry CRLF
 *    in the working tree while the committed blob is LF — `*.md text eol=lf`
 *    normalises on the way into the index, not on disk. In a JavaScript regex
 *    `\r` is a LineTerminator, so `.` does not match it and an unanchored `$`
 *    will not match before it. An extractor written the obvious way
 *    (`/^\s*```(\w*)\s*$/` happens to survive; `/^(\s*)(`{3,})(.*)$/` does not)
 *    silently finds ZERO fences in those files and reports them clean. A gate
 *    blind to 69 files is not a gate.
 *
 * 2. **The opening delimiter's run length and character are tracked.** A fence
 *    opened with four backticks may legally contain three-backtick fences —
 *    the skills corpus does this when documenting markdown itself. Closing on
 *    the first ``` would splice two blocks together and invent divergences.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLS_DIR = join(ROOT, 'skills');
const GIT_BUFFER = 2048 * 1024 * 1024;

/**
 * Fence info-string tags whose content must match the English source
 * byte-for-byte. These are the tags a reader copies and runs, or that an agent
 * executes as part of a procedure: localising them yields code that is wrong in
 * the target language's terms while looking authoritative.
 *
 * Tags NOT listed here (text, markdown, untagged, ...) may be localised — they
 * carry illustrative output, tables and templates, where the reader is served
 * by their own language.
 *
 * Single source of truth for both the checker and the normalizer. A second copy
 * would drift, and the two disagreeing means the repair tool rewrites fences the
 * gate does not flag, or leaves flagged ones alone.
 */
export const GATED_TAGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'console',
  'javascript', 'js', 'mjs', 'cjs', 'jsx', 'typescript', 'ts', 'tsx',
  'python', 'py', 'r', 'ruby', 'rb', 'perl', 'php', 'lua',
  'go', 'rust', 'rs', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'swift',
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'sql', 'graphql',
  'dockerfile', 'docker', 'nginx', 'apache', 'terraform', 'hcl',
  'html', 'css', 'scss', 'sass',
  'diff', 'patch', 'makefile', 'cmake', 'gitignore', 'protobuf', 'proto',
  'gotmpl', 'promql', 'latex', 'tex',
]);

export const isGated = (fence) => GATED_TAGS.has(fence.lang);

/**
 * Union of every fence body that has ever appeared in each English SKILL.md,
 * keyed by skill id, plus the current working tree.
 *
 * This is the violation basis: a translated fence body absent from this set
 * appears in no English revision, ever, so it cannot be explained by staleness
 * (which can only make a fence match an EARLIER revision) nor by a
 * `source_commit` bumped without retranslation (#405).
 *
 * Costs two git processes rather than one per revision.
 * @returns {Map<string, Set<string>>}
 */
export function buildEnglishFenceHistory() {
  const log = execFileSync(
    'git', ['log', '--format=%x00%H', '--name-only', '--', 'skills'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_BUFFER },
  );

  const specs = [];
  const seen = new Set();
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\x00')) { commit = line.slice(1).trim(); continue; }
    if (!line || !commit || !line.endsWith('SKILL.md')) continue;
    const spec = `${commit}:${line}`;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }

  const history = new Map();
  const add = (skill, text) => {
    if (!history.has(skill)) history.set(skill, new Set());
    const set = history.get(skill);
    for (const f of extractFences(text)) set.add(f.body);
  };

  if (specs.length) {
    const batch = spawnSync('git', ['cat-file', '--batch'], {
      cwd: ROOT,
      input: Buffer.from(specs.join('\n') + '\n', 'utf8'),
      maxBuffer: GIT_BUFFER,
    });
    if (batch.status !== 0) {
      console.error('ERROR: git cat-file --batch failed');
      console.error(batch.stderr?.toString().slice(0, 500));
      process.exit(1);
    }
    const buf = batch.stdout;
    let offset = 0;
    let index = 0;
    while (offset < buf.length && index < specs.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl < 0) break;
      const header = buf.slice(offset, nl).toString('utf8');
      offset = nl + 1;
      if (/ (missing|ambiguous)$/.test(header)) { index++; continue; }
      const size = Number.parseInt(header.split(' ')[2], 10);
      if (!Number.isFinite(size)) break;
      add(specs[index].split(':')[1].split('/')[1], buf.slice(offset, offset + size).toString('utf8'));
      offset += size + 1;
      index++;
    }
  }

  // An uncommitted English edit is a legal basis too.
  for (const skill of readdirSync(SKILLS_DIR)) {
    if (skill.startsWith('_')) continue;
    const p = join(SKILLS_DIR, skill, 'SKILL.md');
    if (existsSync(p)) add(skill, readFileSync(p, 'utf8'));
  }

  return history;
}

/**
 * @typedef {object} Fence
 * @property {string} lang      lowercased first token of the info string ('' when untagged)
 * @property {string} info      the full info string, trimmed
 * @property {string} body      fence content, LF-joined, delimiters excluded
 * @property {number} line      1-based line number of the opening delimiter
 * @property {number} bodyStart 0-based index of the first body line in `lines`
 * @property {number} bodyEnd   0-based index one past the last body line
 * @property {boolean} [unterminated] set when EOF arrived before a closing delimiter
 */

/** Split text into lines with CRLF (and lone CR) normalised to LF. */
export function toLines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

/**
 * Extract every fenced block from `text`.
 * @param {string} text
 * @returns {Fence[]}
 */
export function extractFences(text) {
  const lines = toLines(text);
  const out = [];
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(`{3,}|~{3,})([^\n]*)$/.exec(lines[i]);

    if (open === null) {
      if (match) {
        const info = match[3].trim();
        open = {
          delim: match[2][0],
          len: match[2].length,
          info,
          lang: (info.split(/[\s{,]/)[0] || '').replace(/[{}]/g, '').toLowerCase(),
          line: i + 1,
          bodyStart: i + 1,
        };
      }
      continue;
    }

    const closes = match
      && match[2][0] === open.delim
      && match[2].length >= open.len
      && match[3].trim() === '';

    if (closes) {
      out.push({
        lang: open.lang,
        info: open.info,
        body: lines.slice(open.bodyStart, i).join('\n'),
        line: open.line,
        bodyStart: open.bodyStart,
        bodyEnd: i,
      });
      open = null;
    }
  }

  if (open !== null) {
    out.push({
      lang: open.lang,
      info: open.info,
      body: lines.slice(open.bodyStart).join('\n'),
      line: open.line,
      bodyStart: open.bodyStart,
      bodyEnd: lines.length,
      unterminated: true,
    });
  }

  return out;
}
