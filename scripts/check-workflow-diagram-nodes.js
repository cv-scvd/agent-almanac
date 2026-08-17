#!/usr/bin/env node
/**
 * check-workflow-diagram-nodes.js
 *
 * Node-set parity between the PUT annotations in `viz/` and the committed
 * Mermaid diagram at `viz/public/data/workflow.mmd` (#590, dependency-free
 * slice).
 *
 * `viz/public/data/workflow.mmd` is generated, committed, and fetched at
 * runtime by `viz/js/workflow.js` — the same staleness shape #363 fixed for
 * `skills.json`, except the deploy job never regenerates this one. Nothing in
 * the repository has ever compared it against its source. This does, in one
 * direction each:
 *
 *   missing-node  an id is annotated in `viz/` and has no node in the diagram
 *   orphan-node   a node id is in the diagram and no longer annotated in `viz/`
 *
 * ## What it CANNOT see — read this before quoting a clean run
 *
 * Node identity only. All of the following are invisible to it:
 *
 *   - **Labels.** `bind_modes` reads "Bind mode switching (2D/3D/Hive/Chord/
 *     Flow)" and five is not six — Campfire is bound and unlisted. That text
 *     comes from the annotation in `viz/js/app.js`, so a faithful regeneration
 *     reproduces the wrong label and this check stays green through it.
 *   - **`node_type`.** An `input` retyped to `process` moves the node's shape
 *     and its `class` line; the id is unchanged, so nothing here fires.
 *   - **Edges.** `input:`/`output:` chains build the `-->` block. A rewired
 *     graph with the same node set is clean here.
 *   - **Source-side annotation staleness.** An annotation describing code that
 *     no longer does that is a correct annotation to this tool.
 *
 * It also parses only LINE-ANCHORED node definitions — `^  id[…]`, one per
 * line, which is what putior emits. A node defined inline on an edge line
 * (`a --> b[…]`) is not seen. That restriction is deliberate: scanning
 * anywhere on the line makes every label containing `word[` or `word(` a
 * phantom node, and a checker that invents nodes is worse than one with a
 * stated boundary.
 *
 * ## The ruler, before the finding
 *
 * Three separate ways to build this instrument produce a wrong count, and two
 * of them were live while writing it. Measured on `6ab3728a7`:
 *
 *   - Anchoring the diagram scan on `[` alone reports FIVE missing nodes where
 *     one is real: `read_registries`, `fetch_data`, `glyph_mapping` and
 *     `resolve_glyph` render as `id(["…"])` because they are `node_type:
 *     "input"`. Four fifths of that finding would be the instrument.
 *   - Not mirroring the generator's own `exclude` adds two more:
 *     `build-workflow.R` and `build-workflow.js` annotate themselves and are
 *     excluded from their own scan. Hence PATTERN and EXCLUDE below are parsed
 *     OUT of `build-workflow.R` rather than restated here — the A10 move, so
 *     the two cannot drift.
 *   - Walking the filesystem instead of asking git scans 7,177 files instead
 *     of 72 and adds two more findings: `viz/renv/library/` is present in a
 *     working checkout, gitignored, and ships putior's own annotated examples.
 *     Enumeration is `git ls-files -co --exclude-standard`, so `node_modules/`
 *     and `renv/library/` are excluded by the repo's own ignore rules rather
 *     than by a second list that could disagree with them. (The walk also took
 *     over two minutes on this NTFS mount against an instant `git ls-files`,
 *     but the correctness argument is the one that decides it.)
 *
 * Two of these were live while writing the tool; the third is the one to be
 * careful about quoting. `rg 'put id:' viz/renv/…/putior/examples/` returns
 * THIRTY-TWO lines and only TWO of them are reachable, because the rest sit
 * inside R string literals as `put id:\"…\"` — demo code that writes example
 * files, not annotations in the scanned form. The measured delta is 2, and a
 * "32 vendored annotations" line would have been a number produced by a
 * pattern rather than by the instrument.
 *
 * There is a corollary this tool does NOT resolve: `build-workflow.R` passes
 * putior no exclusion for `renv/` or `node_modules/` at all, so whether a
 * regeneration would ingest anything from them depends on putior's internal
 * filtering. That is unverified — #601 says the lockfile cannot produce a
 * working generator, which is also why this gate ships warn-only. Its claim is
 * therefore about the repository's own `viz/` sources, not about what a
 * regeneration would emit.
 *
 * Annotations are read as single-line `put id:"…"`. putior's multi-line form
 * is not parsed; nothing in `viz/` uses it.
 *
 * Exit 0 = the node sets agree (or `--warn`). Exit 1 = a parity finding.
 * Exit 2 = the question could not be answered, and must never read as a pass.
 *
 * Usage:
 *   node scripts/check-workflow-diagram-nodes.js
 *   node scripts/check-workflow-diagram-nodes.js --warn
 *   node scripts/check-workflow-diagram-nodes.js --json
 *   node scripts/check-workflow-diagram-nodes.js --root <dir>
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Fail closed. This is "I cannot tell you", never a verdict. */
function refuse(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) refuse(`${name} requires a value`);
  return v;
}

const AS_JSON = process.argv.includes('--json');
const WARN_ONLY = process.argv.includes('--warn');
const ROOT = resolve(flagValue('--root', resolve(__dirname, '..')));

const GENERATOR = 'viz/build-workflow.R';
const DIAGRAM = 'viz/public/data/workflow.mmd';
const SOURCE_DIR = 'viz';

/**
 * Finding identity is the NODE, not the file.
 *
 * `check-debt-ratchet.js` keys a member on `file` + `kind`, so two findings of
 * one kind in one file would collapse into a single ratcheted member and
 * repairing either would leave the other silently covered. Encoding the node
 * into `file` keeps the ratchet exact-set per node without changing its key
 * model. `path` and `node` are published separately so nothing has to parse
 * this back apart.
 */
const memberKey = (path, node) => `${path}::${node}`;

/**
 * R string literal -> the regex it denotes.
 *
 * `"\\.(js|R)$"` in the file is the six characters `\\.(js` … on disk; the R
 * parser collapses `\\` to `\` before the regex engine ever sees it. Reading
 * the raw bytes and compiling them would give `\\.` — an escaped backslash —
 * which matches nothing here and would report every file as out of scope.
 */
function unescapeRString(raw) {
  return raw.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    return c;
  });
}

function compileOrRefuse(source, what) {
  try {
    return new RegExp(source);
  } catch (e) {
    refuse(`${GENERATOR}: ${what} '${source}' is not a usable regex — ${e.message}`);
  }
}

/**
 * Hoist the generator's own scan predicate instead of restating it.
 *
 * Both fields are required and both refuse on absence or ambiguity. A second
 * `pattern =` in the file means the wrong one could be picked silently, which
 * is the class of mistake that makes a checker's scope quietly differ from the
 * generator's while both look correct.
 */
function readGeneratorScope() {
  const path = join(ROOT, GENERATOR);
  if (!existsSync(path)) refuse(`no generator at ${GENERATOR} — its scan scope is what this check mirrors`);
  const text = readFileSync(path, 'utf8');

  const patternMatches = [...text.matchAll(/pattern\s*=\s*"((?:[^"\\]|\\.)*)"/g)];
  if (patternMatches.length === 0) refuse(`${GENERATOR}: no \`pattern = "…"\` found; cannot mirror the generator's file selection`);
  if (patternMatches.length > 1) refuse(`${GENERATOR}: ${patternMatches.length} \`pattern = "…"\` assignments; which one selects source files is ambiguous`);

  const excludeMatches = [...text.matchAll(/exclude\s*=\s*c\(([^)]*)\)/g)];
  if (excludeMatches.length === 0) refuse(`${GENERATOR}: no \`exclude = c(…)\` found; cannot mirror the generator's exclusions`);
  if (excludeMatches.length > 1) refuse(`${GENERATOR}: ${excludeMatches.length} \`exclude = c(…)\` vectors; which one applies is ambiguous`);

  const excludeSources = [...excludeMatches[0][1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unescapeRString(m[1]));
  if (excludeSources.length === 0) refuse(`${GENERATOR}: \`exclude = c(…)\` holds no string literals`);

  return {
    pattern: compileOrRefuse(unescapeRString(patternMatches[0][1]), 'pattern'),
    excludes: excludeSources.map((source) => compileOrRefuse(source, 'exclude entry')),
    excludeSources,
  };
}

/**
 * Tracked plus untracked-not-ignored, so a source file added in the working
 * tree counts before it is committed while ignored trees never do.
 */
function listSourceFiles(scope) {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '--', SOURCE_DIR], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) refuse(`could not enumerate ${SOURCE_DIR}/ — ${r.error.message}`);
  if (r.status !== 0) refuse(`git ls-files failed in ${ROOT} (exit ${r.status}) — ${(r.stderr || '').trim().slice(0, 300)}`);

  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((relPath) => scope.pattern.test(relPath))
    .filter((relPath) => !scope.excludes.some((re) => re.test(relPath)));
}

function collectAnnotations(files) {
  const byNode = new Map();
  for (const relPath of files) {
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) continue; // deleted-but-still-listed; the diagram side will report it
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      const m = /put\s+id:\s*"([^"]+)"/.exec(line);
      if (m && !byNode.has(m[1])) byNode.set(m[1], relPath);
    }
  }
  return byNode;
}

/**
 * Node ids from the committed diagram.
 *
 * Shapes: `id["…"]`, `id[["…"]]`, `id(["…"])`, `id("…")`, `id{"…"}`. The
 * opening bracket class is deliberately wider than the three shapes putior
 * emits today for the node types `viz/` uses, because the remaining types
 * (`artifact`, `start`, `end`) cannot be observed while #601 blocks a
 * regeneration — a narrow class would silently report their nodes as orphans.
 *
 * `subgraph` is skipped explicitly. `subgraph build_data ["build-data.js"]`
 * would otherwise contribute a node named after the FILE, and every subgraph
 * would then read as an orphan.
 */
const SKIP_PREFIX = /^(%%|subgraph\b|end\b|class\b|classDef\b|style\b|linkStyle\b|flowchart\b|graph\b|direction\b)/;

function collectDiagramNodes(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || SKIP_PREFIX.test(trimmed)) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[\[|\(\[|\[|\(|\{)/.exec(trimmed);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function main() {
  const scope = readGeneratorScope();
  const sourceFiles = listSourceFiles(scope);
  if (sourceFiles.length === 0) {
    refuse(`no ${SOURCE_DIR}/ file matched the generator's pattern ${scope.pattern} — an empty scan reports no findings for the wrong reason`);
  }

  const annotations = collectAnnotations(sourceFiles);
  if (annotations.size === 0) {
    refuse(`scanned ${sourceFiles.length} file(s) and found no \`put id:"…"\` annotation — the diagram cannot be checked against nothing`);
  }

  const diagramPath = join(ROOT, DIAGRAM);
  if (!existsSync(diagramPath)) refuse(`no diagram at ${DIAGRAM}`);
  const diagramNodes = collectDiagramNodes(readFileSync(diagramPath, 'utf8'));
  if (diagramNodes.size === 0) {
    refuse(`${DIAGRAM} parsed to zero nodes — either it is empty or the node syntax changed, and both must refuse rather than report every annotation missing`);
  }

  const findings = [];
  for (const [node, path] of [...annotations].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!diagramNodes.has(node)) {
      findings.push({
        kind: 'missing-node',
        file: memberKey(path, node),
        path,
        node,
        detail: `annotated in ${path}, absent from ${DIAGRAM}`,
      });
    }
  }
  for (const node of [...diagramNodes].sort()) {
    if (!annotations.has(node)) {
      findings.push({
        kind: 'orphan-node',
        file: memberKey(DIAGRAM, node),
        path: DIAGRAM,
        node,
        detail: `a node in ${DIAGRAM} that no ${SOURCE_DIR}/ source annotates`,
      });
    }
  }

  const report = {
    root: ROOT,
    generator: GENERATOR,
    diagram: DIAGRAM,
    pattern: String(scope.pattern),
    excludes: scope.excludeSources,
    sourceFilesScanned: sourceFiles.length,
    annotationsFound: annotations.size,
    diagramNodes: diagramNodes.size,
    findings,
    // The ratchet validates its slice's `kinds` and `scanned_field` against
    // these rather than against "is it a number" — a kind nobody emits, or a
    // finding count named as a coverage floor, both select nothing and read as
    // a held ratchet.
    kinds: ['missing-node', 'orphan-node'],
    scannedFields: ['sourceFilesScanned', 'annotationsFound'],
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const f of findings) console.log(`${WARN_ONLY ? 'WARN' : 'FAIL'} [${f.kind}] ${f.node} — ${f.detail}`);
    console.log(`\nviz diagram node parity: ${sourceFilesScannedLine(report)}`);
    if (findings.length === 0) {
      console.log('OK: every annotated id has a node, and every node has an annotation.');
    } else {
      console.log(`${findings.length} parity finding(s). Regenerating the diagram needs a working putior (#601).`);
    }
  }

  process.exit(findings.length === 0 || WARN_ONLY ? 0 : 1);
}

function sourceFilesScannedLine(report) {
  return `${report.sourceFilesScanned} source file(s), ${report.annotationsFound} annotation(s), ${report.diagramNodes} diagram node(s)`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

export { collectDiagramNodes, unescapeRString, memberKey };
