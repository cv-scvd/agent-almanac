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
 * 1. **CRLF is normalised before parsing.** 68 translated SKILL.md carry CRLF
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

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_BUFFER = 2048 * 1024 * 1024;

/**
 * The ONLY fence info-string tags a translation may localise. Everything else
 * is frozen — its body must match the English source byte-for-byte.
 *
 * The polarity is deliberate and is the whole design. An allowlist of "code"
 * tags has to enumerate every language the corpus will ever use, and anything
 * it forgets is unguarded by default. This corpus already carries `logql` (50
 * fences), `bibtex` (20), `jsonl` (10), `traceql` (10), `powershell` (10) and
 * `language` (10) — all of which a hand-written code list misses. All but
 * `language` are at zero violations today (`language` has one), so closing the
 * hole costs one finding now and an unbounded number later. It also NARROWS the
 * retag escape hatch: because the tag is read off the translated file and never
 * compared to English, retagging a ```yaml fence still removes it from the gate
 * — default-deny shrinks the escape set from unbounded to {text, markdown, md}
 * rather than closing it. Closing it needs tag-sequence parity (#481).
 *
 * `text` and `markdown` are exempt because they carry reference tables,
 * decision flows and report templates that a human reads or fills in — a German
 * reviewer should be able to emit a German report. Byte parity on `markdown`
 * would fire 268 times to catch 3 real defects and would forbid the thing the
 * locale exists for.
 *
 * Untagged fences are frozen, not exempt. Measured cost: zero — there are no
 * untagged fence openers in either tree, because `guides/content-styleguide.md`
 * already requires a tag. The remedy for a future one is to tag the English
 * source.
 *
 * Adding a tag here requires naming which machine consumes that fence.
 *
 * Single source of truth for both the checker and the normalizer. A second copy
 * would drift, and the two disagreeing means the repair tool rewrites fences the
 * gate does not flag, or leaves flagged ones alone.
 */
export const LOCALISABLE_TAGS = new Set(['text', 'markdown', 'md']);

/** True when a fence's body must match an English revision byte-for-byte. */
export const isGated = (fence) => !LOCALISABLE_TAGS.has(fence.lang);

/** English content trees that have translated mirrors under `i18n/<locale>/`. */
export const TREES = ['skills', 'agents', 'teams', 'guides'];

/**
 * Repo-relative English content path -> stable `<tree>/<id>` key, or null when
 * the path is not translatable content.
 *
 * Uses the second-to-last segment for `SKILL.md` so that pre-flatten historical
 * paths (`skills/<domain>/<id>/SKILL.md`, ~42% of the blobs in history) key to
 * the same id as today's `skills/<id>/SKILL.md`.
 */
export function contentKey(relPath) {
  const parts = relPath.split('/');
  if (parts.length < 2 || !TREES.includes(parts[0])) return null;
  // Both branches below must agree on what an id is, and on which ids are not content.
  // They did not: the exclusion lived only in the flat branch, so
  // `contentKey('skills/_template/SKILL.md')` returned `skills/_template` — a key the
  // English history index then carried, which would have made a translated `_template`
  // a rewrite target (#519). skills/ holds most of the corpus, so the general claim that
  // deriving both the path and the key from this function removes the need for a second
  // exclusion list was false exactly where it mattered most.
  if (parts[parts.length - 1] === 'SKILL.md') {
    if (parts.length < 3) return null;
    // Second-to-last, never parts[1]: pre-flatten paths are
    // `skills/<domain>/<id>/SKILL.md`, and keying off parts[1] would silently key a whole
    // domain — ~42% of the blobs in history — to the wrong id.
    const id = parts[parts.length - 2];
    if (isExcludedId(id)) return null;
    return `${parts[0]}/${id}`;
  }
  if (parts.length === 2 && parts[1].endsWith('.md')) {
    const id = parts[1].slice(0, -3);
    if (isExcludedId(id)) return null;
    return `${parts[0]}/${id}`;
  }
  return null;
}

/**
 * Names that live inside a content tree without being content.
 *
 * Takes a RAW path segment and strips a `.md` suffix itself, so the two branches above can
 * hand it the same kind of thing. They could not before: the flat branch stripped the
 * extension before testing while the nested branch passed a bare directory segment, which
 * made `contentKey('skills/README.md/SKILL.md')` return `skills/README.md` instead of null
 * while `contentKey('skills/README.md')` correctly returned null. Unreachable today only
 * because every caller happens to `statSync(...).isFile()` afterwards — which is the
 * "unreachable because of ambient state" framing #519 exists to reject.
 */
function isExcludedId(id) {
  const stem = id.endsWith('.md') ? id.slice(0, -3) : id;
  return stem.startsWith('_') || stem === 'README';
}

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
    'git', ['log', '--format=%x00%H', '--name-only', '--', ...TREES],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_BUFFER },
  );

  const specs = [];
  const seen = new Set();
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('\x00')) { commit = line.slice(1).trim(); continue; }
    if (!line || !commit || contentKey(line) === null) continue;
    const spec = `${commit}:${line}`;
    if (seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
  }

  const history = new Map();
  const add = (key, text) => {
    if (key === null) return;
    if (!history.has(key)) history.set(key, new Set());
    const set = history.get(key);
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
      add(contentKey(specs[index].slice(specs[index].indexOf(':') + 1)),
        buf.slice(offset, offset + size).toString('utf8'));
      offset += size + 1;
      index++;
    }
  }

  // An uncommitted English edit is a legal basis too. The working tree is also
  // kept separately as `history.current`, keyed the same way: the deleted-fence
  // check needs the fences English has NOW, with their tags, not the flattened
  // union of every body that ever existed.
  const current = new Map();
  for (const tree of TREES) {
    const base = join(ROOT, tree);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (entry.startsWith('_')) continue;
      const p = tree === 'skills' ? join(base, entry, 'SKILL.md') : join(base, entry);
      if (!existsSync(p) || !statSync(p).isFile()) continue;
      const rel = tree === 'skills' ? `${tree}/${entry}/SKILL.md` : `${tree}/${entry}`;
      const key = contentKey(rel);
      if (key === null) continue;
      const text = readFileSync(p, 'utf8');
      add(key, text);
      current.set(key, extractFences(text));
    }
  }

  history.current = current;
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
 * The document's fence structure as one comparable string: every fence's tag, in order.
 *
 * Info-string tags are never translated — they are the machine-readable part of the fence,
 * and the keep-in-English rule freezes them in every locale. So a translated file's shape
 * must equal its English source's shape at *some* revision, and a shape appearing in no
 * revision means the mask cannot be trusted (#561).
 *
 * Shape rather than count, because the failure this detects leaves the count intact. A stray
 * ```` ```bash ```` opener cannot close anything (a closer carries no trailing text), but it
 * *opens*, so the real opener below it is swallowed into the body and the real closer closes
 * the stray fence instead. Measured on a two-fence body: count 1 -> 1, shape `yaml` -> `bash`,
 * and five lines of prose vanish from comparison. A count check sees nothing.
 *
 * Tags, not bodies: #477's backlog leaves 1,220+ translated fence *bodies* diverging from
 * English, so gating on bodies would refuse to judge much of the corpus.
 *
 * **Terminated fences only.** An unterminated fence is not frozen (#558) — it masks nothing —
 * so it does not describe the mask and must not perturb the shape. Excluding it here is what
 * lets the shape comparison stand alone: #558's stray *unterminated* opener leaves the shape
 * unchanged and its file stays judgeable, while a stray *terminated* opener changes the shape
 * and is caught. An earlier attempt kept unterminated fences in the shape and paid for it with
 * a second condition ("did the mask hide lines?"), which left a worse bypass open: a stray
 * ```` ```text ```` opener is localisable, so it hides nothing, yet it still phase-flips and
 * EXPOSES the real frozen body — whose keep-in-English lines are absent from the English prose
 * pool and therefore read as novel. That turned a scaffold into `has-novel-lines`, a positive
 * claim of translation. Mask corruption is symmetric; hiding is only half of it.
 *
 * Joined on `,` rather than `|`, and that is not cosmetic. `lang` is the first token of the
 * info string split on `/[\s{,]/`, so a comma can never occur inside a tag — but a pipe can.
 * A single fence tagged ```` ```bash|yaml ```` produced the shape `bash|yaml`, colliding with
 * the shape of two fences `bash` and `yaml`. That let one gated fence wrapping an entire body
 * match a two-fence English shape, hide everything, and land `insufficient` — translated.
 *
 * @param {string} text
 * @returns {string} e.g. `bash,yaml,markdown`; `''` for a file with no terminated fences
 */
export function fenceShape(text) {
  return extractFences(text)
    .filter((f) => !f.unterminated)
    .map((f) => f.lang || '')
    .join(',');
}

/**
 * Does any fence body contain a line that would itself have opened a fence?
 *
 * The phase flip's invariant fingerprint, and the half `fenceShape` structurally cannot see.
 * A stray opener carrying the SAME tag as the fence below it is terminated by that fence's
 * real closer and takes over its position in the shape string — so the shape stays
 * byte-identical while the mask is completely wrong. Shape equality cannot close this,
 * because the attack preserves shape by construction. Measured: a 5-line body drops to 3,
 * lands `insufficient`, and is counted as translated, with one added line.
 *
 * What it looks for is the swallowed opener itself: inside a fence body, a line with the same
 * delimiter character, a run at least as long as the enclosing fence's, and a non-empty info
 * string. Such a line is unreachable in a well-formed document — it would have closed the
 * fence if its info string were empty, and it cannot appear as content because the parser
 * would have ended the fence before reaching it.
 *
 * Deliberately not fooled by legitimate fence-in-fence documentation, which this corpus writes
 * with a longer outer run (a ````` ````markdown ````` wrapping ```` ```r ````): the inner run
 * is SHORTER than the enclosing one, so it fails the length test. Nor by a ```` ``` ```` line
 * inside a `~~~` fence, which is ordinary content — the delimiter characters differ.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasSwallowedOpener(text) {
  return extractFences(text).some((fence) => {
    return toLines(fence.body).some((line) => {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      return Boolean(
        match
        && match[1][0] === fence.delim
        && match[1].length >= fence.len
        && match[2].trim() !== '',
      );
    });
  });
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
        // Exposed for hasSwallowedOpener, which must apply CommonMark's own closer rule
        // (same character, run at least as long) to lines INSIDE the body.
        delim: open.delim,
        len: open.len,
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
      delim: open.delim,
      len: open.len,
      line: open.line,
      bodyStart: open.bodyStart,
      bodyEnd: lines.length,
      unterminated: true,
    });
  }

  return out;
}
