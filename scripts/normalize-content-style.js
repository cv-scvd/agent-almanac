#!/usr/bin/env node
// Deterministic content-style normalizer for skills, agents, teams, guides, i18n.
// Companion to scripts/check-content-style.js — it rewrites exactly what the
// checker flags, using the SAME fence-state machine so 4-backtick examples that
// wrap 3-backtick fences are never corrupted.
//
// Two transforms, both line-type-local (so the diff shape is provable):
//   separators : decorative table separator rows -> compact `|---|---|`
//                (3 dashes/column, alignment colons preserved)
//   fences     : untagged opening code fences    -> add a language tag
//                (heuristic detection of bash/console/json/yaml/r/diff; `text` fallback)
//
// It PREVIEWS by default and writes only when `--write` is passed (#490). The inverse —
// write by default, `--dry` to preview — is what this file used to do, and it is the shape
// #486 inverted in the i18n normalizer after a read-only probe agent typed the bare command
// and silently rewrote 281 files. Every later measurement of that backlog was then wrong
// and self-consistent. The blast radius here is larger, not smaller: `--scope all` is
// skills/ agents/ teams/ guides/ i18n/, and the *default* scope is still every English
// content file. The destructive mode must not be the one you get by typing the obvious
// command.
//
// `--dry` is retained as an explicit no-op so old invocations keep working and keep
// meaning what they meant. Passing both `--write` and `--dry` is an error rather than a
// guess.
//
// Two further guards follow the same reasoning: it refuses to write into a dirty scope
// (`git checkout --` is the only undo, and it would destroy uncommitted work), and it
// announces the write on stderr before touching anything.
//
// Usage:
//   node scripts/normalize-content-style.js --mode <separators|fences|both> --scope <english|all>
//   node scripts/normalize-content-style.js --mode both --files a.md b.md ...
//   node scripts/normalize-content-style.js --write            # apply; default is preview

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CONTENT_GLOBS = ["skills/", "agents/", "teams/", "guides/", "i18n/"];
const ENGLISH_GLOBS = ["skills/", "agents/", "teams/", "guides/"];

function isContentFile(p) {
  if (!CONTENT_GLOBS.some((g) => p.startsWith(g))) return false;
  if (p.includes("/_template")) return false;
  return p.endsWith(".md");
}

// ── Predicates copied verbatim from check-content-style.js ──────────────────
function isSeparatorRow(line) {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  return /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(t);
}
function isDecorativeSeparator(line) {
  return isSeparatorRow(line) && /----/.test(line);
}
const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

// ── Separator rewrite ───────────────────────────────────────────────────────
// Compact a decorative separator row to 3 dashes/column, preserving indentation,
// leading/trailing pipe presence, column count, and alignment colons.
function compactSeparator(line) {
  const indentMatch = line.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  let t = line.trim();
  const hasLead = t.startsWith("|");
  const hasTrail = t.endsWith("|");
  if (hasLead) t = t.slice(1);
  if (hasTrail) t = t.slice(0, -1);
  const cells = t.split("|").map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return ":---:";
    if (left) return ":---";
    if (right) return "---:";
    return "---";
  });
  return indent + (hasLead ? "|" : "") + cells.join("|") + (hasTrail ? "|" : "");
}

// ── Fence language heuristic ────────────────────────────────────────────────
// Decide a language tag from the block's content lines. The corpus's untagged
// blocks are overwhelmingly structured prose/output (example dialogues, ASCII
// diagrams, protocol templates, reference tables) for which `text` is the
// styleguide-blessed and CORRECT tag. Prose-based heuristics (yaml on `User:`
// dialogue, json on `[...]` diagrams) produce mostly false positives, so the
// only language we INFER is JSON — and only when it actually parses, which has
// effectively zero false-positive risk on prose. Everything else is `text`.
// (This also guarantees identical tags across the 10 i18n locales, since code
// blocks stay English: a block that parses as JSON in the source parses in
// every translation, and a prose block is `text` in all of them.)
function isJson(s) {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}
function guessLanguage(contentLines) {
  const lines = contentLines.filter((l) => l.trim() !== "");
  if (lines.length === 0) return "text";
  // whole block is one JSON value
  if (isJson(lines.join("\n"))) return "json";
  // JSON Lines: every non-empty line is its own JSON value
  if (lines.every((l) => isJson(l))) return "json";
  return "text";
}

// ── File transform ──────────────────────────────────────────────────────────
// Returns {text, sepChanges, fenceChanges}. Fence-aware: only OUTSIDE-fence
// separators are rewritten; only OPENING untagged fences are tagged.
function transform(original, { doSep, doFence }) {
  const hadCRLF = /\r\n/.test(original);
  const lines = original.replace(/\r\n/g, "\n").split("\n");
  let sepChanges = 0;
  let fenceChanges = 0;
  let inFence = false;
  let markerChar = null;
  let markerLen = 0;
  let fenceOpenIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(FENCE_RE);
    if (m) {
      const ch = m[2][0];
      const len = m[2].length;
      const info = m[3].trim();
      if (!inFence) {
        inFence = true;
        markerChar = ch;
        markerLen = len;
        fenceOpenIdx = i;
        if (info === "" && doFence) {
          // collect block content until the matching close to guess language
          const content = [];
          for (let j = i + 1; j < lines.length; j++) {
            const cm = lines[j].match(FENCE_RE);
            if (cm && cm[2][0] === ch && cm[2].length >= len && cm[3].trim() === "") break;
            content.push(lines[j]);
          }
          const lang = guessLanguage(content);
          lines[i] = m[1] + m[2] + lang;
          fenceChanges++;
        }
      } else if (ch === markerChar && len >= markerLen && info === "") {
        inFence = false;
        markerChar = null;
        markerLen = 0;
        fenceOpenIdx = -1;
      }
      continue;
    }
    if (inFence) continue;
    if (doSep && isDecorativeSeparator(line)) {
      const compact = compactSeparator(line);
      if (compact !== line) {
        lines[i] = compact;
        sepChanges++;
      }
    }
  }
  let text = lines.join("\n");
  // Preserve original EOL style so EOL normalization stays a separate concern.
  if (hadCRLF) text = text.replace(/\n/g, "\r\n");
  return { text, sepChanges, fenceChanges };
}

// ── Scope resolution ────────────────────────────────────────────────────────
function listFiles(scope) {
  const globs = scope === "english" ? ENGLISH_GLOBS : CONTENT_GLOBS;
  const out = execSync(`git ls-files ${globs.join(" ")}`, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.split("\n").filter(isContentFile);
}

// ── Main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flagVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// Default-deny on flags. An unrecognised flag is a typo or a stale invocation, and
// silently ignoring it means the run does something other than what was asked.
const VALUE_FLAGS = new Set(["--mode", "--scope"]);
const BOOL_FLAGS = new Set(["--write", "--dry"]);
const filesIdx = argv.indexOf("--files");
for (let i = 0; i < argv.length; i += 1) {
  if (filesIdx >= 0 && i > filesIdx) break; // remaining args are filenames
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  if (a === "--files" || BOOL_FLAGS.has(a)) continue;
  if (VALUE_FLAGS.has(a)) { i += 1; continue; }
  console.error(`ERROR: unknown flag ${a}`);
  process.exit(2);
}

// Guessing which one the caller meant is how a preview becomes a write.
if (argv.includes("--write") && argv.includes("--dry")) {
  console.error("ERROR: --write and --dry contradict each other. Pass one.");
  process.exit(2);
}
const WRITE = argv.includes("--write");

const mode = flagVal("--mode") || "both";
if (!["separators", "fences", "both"].includes(mode)) {
  console.error(`ERROR: --mode must be separators|fences|both (got '${mode}')`);
  process.exit(2);
}
const doSep = mode === "separators" || mode === "both";
const doFence = mode === "fences" || mode === "both";

let files;
let pathspec;
if (filesIdx >= 0) {
  // Stop at the next flag. Filtering out only `--`-prefixed args left the VALUE of a
  // following flag in the list, so `--files a.md --mode both` treated 'both' as a file.
  files = [];
  for (let i = filesIdx + 1; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) break;
    files.push(argv[i]);
  }
  if (!files.length) {
    console.error("ERROR: --files requires at least one path");
    process.exit(2);
  }
  pathspec = files;
} else {
  const scope = flagVal("--scope") || "english";
  if (!["english", "all"].includes(scope)) {
    console.error(`ERROR: --scope must be english|all (got '${scope}')`);
    process.exit(2);
  }
  files = listFiles(scope);
  pathspec = scope === "english" ? ENGLISH_GLOBS : CONTENT_GLOBS;
}

// Refuse to write into a dirty scope. The only undo for a bad run is `git checkout --`,
// which would also destroy whatever uncommitted work was already there.
if (WRITE) {
  let status;
  try {
    status = execFileSync("git", ["status", "--porcelain", "--", ...pathspec], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`ERROR: could not determine whether the scope is clean: ${err.message}`);
    process.exit(2);
  }
  if (status.trim()) {
    console.error("ERROR: refusing to write into a dirty scope. Commit or stash first.");
    console.error(status.trimEnd());
    process.exit(2);
  }
  console.error(`normalize-content-style: WRITING to ${files.length} scanned file(s) in scope.`);
}

let totalSep = 0;
let totalFence = 0;
let sepFiles = 0;
let fenceFiles = 0;
let written = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const original = readFileSync(f, "utf8");
  const { text, sepChanges, fenceChanges } = transform(original, { doSep, doFence });
  if (sepChanges) {
    totalSep += sepChanges;
    sepFiles++;
  }
  if (fenceChanges) {
    totalFence += fenceChanges;
    fenceFiles++;
  }
  if (text !== original) {
    if (WRITE) writeFileSync(f, text);
    written++;
  }
}
console.log(`normalize-content-style (mode=${mode}${WRITE ? "" : ", PREVIEW"}):`);
if (doSep) console.log(`  separators compacted: ${totalSep} across ${sepFiles} files`);
if (doFence) console.log(`  fences tagged:        ${totalFence} across ${fenceFiles} files`);
console.log(`  files ${WRITE ? "written" : "to change"}: ${written} (of ${files.length} scanned)`);
if (!WRITE && written) console.log("  (preview only — pass --write to apply)");
