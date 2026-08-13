# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

<!-- AUTO:START:overview -->
A documentation-first repository containing 34 guides, a skills library of 369 agentic skills, 75 agent definitions, 22 team compositions, and a curated set of code-driven workflow orchestration scripts, following the [Agent Skills open standard](https://agentskills.io). Almost all content is markdown and YAML; workflows are self-contained `.mjs` scripts run by Claude Code's Workflow tool.

The guides serve as the human entry point to the agentic system: practical walkthroughs explaining when, why, and how to interact with agents, teams, skills, and workflows through Claude Code.
<!-- AUTO:END:overview -->

## Architecture

### Five Content Types

1. **Guides** (`guides/` directory): Human-readable documentation organized into five categories (workflow, infrastructure, reference, design, investigation). Each guide has YAML frontmatter (`title`, `description`, `category`, `agents`, `teams`, `skills`) and follows a standard template (`guides/_template.md`). Guides serve as the human entry point to the agentic system.

2. **Skills** (`skills/` directory): Machine-consumable structured procedures that agentic systems execute. Each skill lives at `skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`, `allowed-tools`, `metadata`) and standardized sections (When to Use, Inputs, Procedure, Validation, Common Pitfalls, Related Skills). Skills are organized into logical domains via metadata tags (live count in the auto-generated registries section below), but the directory structure is flat.

3. **Agents** (`agents/` directory): Persona definitions for Claude Code subagents. Each agent is a markdown file with YAML frontmatter (`name`, `description`, `tools`, `model`, `priority`) defining *who* handles a task. Agents span development, compliance, review, project management, DevOps, MLOps, workflow visualization, esoteric, and specialty domains.

4. **Teams** (`teams/` directory): Predefined multi-agent compositions for complex workflows. Each team is a markdown file with YAML frontmatter (`name`, `description`, `lead`, `members[]`, `coordination`) and an embedded machine-readable configuration block. Teams define *who works together* — coordinated groups of agents with assigned roles and a defined coordination pattern.

5. **Workflows** (`workflows/` directory): Code-driven orchestration scripts run by Claude Code's Workflow tool. Each workflow is a self-contained `workflows/<name>.mjs` file with a top-of-file sidecar frontmatter comment block (the catalog source of truth, the analogue of the other types' YAML frontmatter), a pure-literal `export const meta`, and an async body using the injected `agent()` / `pipeline()` / `parallel()` / `phase()` / `log()` primitives. Where a **team** is a declarative roster the lead coordinates at runtime, a **workflow** fixes its phases and fan-out in code — its *control flow* is deterministic and rereadable, while the `agent()` outputs remain nondeterministic. Discovered from `.claude/workflows/<name>.mjs`, invocable as `Workflow({ name })` or `/<name>`. The library ships two reviewed seeds (`review-changes`, `batch-generate-waves`) and a `create-workflow` meta-skill; the `workflows/_registry.yml`, CLI install, and registry-sync validation remain deferred (Phase 2).

These five types complement each other: skills define *how* (procedure, validation, recovery), agents define *who* (persona, tools, style), teams define *who works together* (composition, roles, coordination), workflows define *how work is orchestrated* (code-driven control flow), and guides provide the background knowledge all draw from.

### Registries

<!-- AUTO:START:registries -->
- `skills/_registry.yml` is the machine-readable catalog of all 369 skills across 66 domains: r-packages (10), jigsawr (5), containerization (10), reporting (5), compliance (17), mcp-integration (6), web-dev (5), git (10), general (24), citations (3), data-serialization (2), review (11), bushcraft (4), esoteric (29), design (6), defensive (6), project-management (6), devops (13), observability (13), edge-computing (1), mlops (12), workflow-visualization (6), swarm (9), morphic (7), alchemy (4), tcg (3), intellectual-property (4), web-scraping (2), gardening (5), shiny (7), animal-training (2), mycology (2), prospecting (2), crafting (1), library-science (3), linguistics (1), travel (6), relocation (3), a2a-protocol (3), geometry (3), number-theory (3), stochastic-processes (3), theoretical-science (3), diffusion (4), hildegard (5), maintenance (5), blender (3), visualization (5), 3d-printing (3), lapidary (4), entomology (5), versioning (4), spectroscopy (6), chromatography (5), gpu-optimization (2), digital-logic (4), electromagnetism (4), levitation (3), i18n (1), synoptic (4), tensegrity (1), cli (4), open-source (2), investigation (9), memex (5), ocr (1).
- `agents/_registry.yml` is the machine-readable catalog of all 75 agents.
- `teams/_registry.yml` is the machine-readable catalog of all 22 teams.
- `guides/_registry.yml` is the machine-readable catalog of all 34 guides across 5 categories.

When adding or removing skills, agents, teams, or guides, the corresponding registry must be updated to stay in sync.
<!-- AUTO:END:registries -->

### Plugin Packaging

The repository is packaged as a Claude Code plugin via `.claude-plugin/plugin.json`. When installed, Claude Code auto-discovers skills (`skills/*/SKILL.md`) and agents (`agents/*.md`). Teams are bundled but not auto-discovered — a session activates one by reading `teams/<name>.md` and spawning its members as subagents via the Agent tool (`subagent_type`), coordinating with SendMessage (see the activation instruction below). `TeamCreate` is deprecated and gated out of ordinary interactive sessions, surfacing only as a FleetView/cloud fallback. Workflows (`workflows/*.mjs`) are likewise bundled but not auto-installed — until the Phase-2 CLI adapter lands, install one by copying its `.mjs` into `.claude/workflows/` by hand. The plugin can be installed via a local marketplace (see README.md for setup). Validation: `claude plugin validate /path/to/agent-almanac`.

### Cross-References

Guides, skills, agents, and teams are cross-referenced. The parent project `CLAUDE.md` at `/mnt/d/dev/p/CLAUDE.md` references several guides via `@agent-almanac/guides/` paths. Skills reference related skills by relative path. Teams reference their member agents. The project `.claude/agents/` symlinks to `agents/` for Claude Code discovery.

## Editing Conventions

- SKILL.md files must retain the YAML frontmatter delimited by `---` and all standardized sections
- Each Procedure step uses the pattern: numbered step with sub-steps, then `**Expected:**` and `**On failure:**` blocks
- The `_registry.yml` must match the actual skills on disk (total count, paths, metadata)
- Guides use GitHub-flavored markdown with code blocks for all commands
- All R examples use `::` for package-qualified calls (e.g., `devtools::check()`) rather than `library()` calls

## Skill Validation

- SKILL.md files must stay under 500 lines; extract extended examples to `references/EXAMPLES.md` using the progressive disclosure pattern
- The `references/` subdirectory pattern follows [agentskills.io progressive disclosure](https://agentskills.io/specification) — large code blocks (>15 lines), full configs, and multi-variant examples go in `references/EXAMPLES.md` with cross-references from the main SKILL.md
- CI enforces validation on all PRs touching `skills/` (`.github/workflows/validate-skills.yml`): frontmatter fields, required sections, line counts, and registry sync
- CI also runs a repo-wide line-endings gate (`.github/workflows/validate-line-endings.yml`) that fails any PR whose committed blobs contain CRLF. Check locally with `npm run validate:line-endings` (reads the index, non-mutating). Repair: `git add --renormalize .` — and if a new file type is flagged, declare it in `.gitattributes` as `text eol=lf`
- Changes under `scripts/` run `npm run test:scripts` (`.github/workflows/ci-scripts.yml`), the node:test suite in `scripts/test/`. Its `pretest:scripts` hook fails when the suite is empty — `node --test` exits 0 reporting `tests 0` when its glob matches nothing, so without that hook a rename or deletion leaves the job green having run nothing (#486)
- To validate locally before committing:
  ```bash
  # Check a single skill
  lines=$(wc -l < skills/<skill-name>/SKILL.md)
  [ "$lines" -le 500 ] && echo "OK ($lines lines)" || echo "FAIL ($lines lines > 500)"

  # Check all skills
  for f in skills/*/SKILL.md; do
    lines=$(wc -l < "$f")
    [ "$lines" -gt 500 ] && echo "OVER: $f ($lines lines)"
  done
  ```

## Proving a Gate Can Fail

A green check is evidence about the *check*, not about the subject. Before trusting a gate — and always before claiming to have tightened one — break the thing it guards and confirm the gate goes red.

`scripts/mutation-check.js` automates the envelope:

```bash
npm run mutation-check -- \
  --file cli/index.js \
  --delete-matching 'process.exitCode = auditExitCode' \
  --test 'npm run test:cli' \
  --expect-killed-by 2
```

Exit 0 means the mutant was killed and the check works. Exit 1 means it survived — the line is uncovered — or the run could not produce an honest verdict.

The tool refuses to guess. It requires a green baseline, backs the file up on disk before touching it, restores from an in-memory buffer (never `git checkout --`, which restores from the *index*), and reports `INCONCLUSIVE` rather than a kill whenever the test command could not be interpreted. It declines to run at all on a symlink, on an `--assume-unchanged`/`--skip-worktree` file, on a file with uncommitted changes, on a mutation matching more than one site without `--allow-multiple`, or while a stale `.mutation-check.bak` is present.

Three traps it exists to catch, all of which have shipped here:

- **A mutation that silently matched nothing** makes the exercise pass vacuously while looking correct. In-place `sed`/`perl -0pi` no-op on the NTFS mount, and bare `grep` resolves to ugrep locally but GNU grep in CI — which is why the tool is Node and compares content in memory rather than trusting the edit.
- **A mutation that merely breaks parsing is not coverage.** Deleting a line carrying a brace makes the file fail to load, and node:test reports that as one failing test — indistinguishable from a real kill. Mutants are syntax-checked first and reported `INVALID` if they do not parse. Note `node --check` parses a `.js` file as CommonJS, so the check is done through a temp file whose extension matches the package's module type; without that this guard is dead for every `.js` file in an ESM package.
- **A manual break-and-check proves the feature, not the coverage.** Running the CLI by hand and seeing the right behaviour is a demo; "removing this line fails these N tests" is coverage. In #458 the exit code was verified end to end by hand and written up in the commit, while deleting the fix line still left all 101 tests green.
- **A suite that discovers nothing reports success.** `node --test <glob>` prints `tests 0` and exits 0 when the glob matches no files, so a renamed or moved suite leaves its CI job green having run nothing. `test:scripts` guards this with a `pretest:scripts` hook; `test:cli` instead names its file, which fails loudly on rename but silently skips any *newly added* file. Whichever you pick, know which silence you bought (#486).
- **A guard must test the accept-rule itself, not a proxy for it.** `--locale` on the fence normalizer was validated with `existsSync('i18n/' + value)` while the scan accepted only directories carrying a `skills/` subtree. `de/skills`, `..` and `glossaries` all passed the guard and scanned nothing — the vacuous result the guard existed to reject. Hoist the consumer's own predicate into one list and validate membership in it, so the two cannot drift.

The same asymmetry applies to the *subject* of a check: a green gate proves something about the gate, and an unexplained **stale generated file** proves something about the corpus. `check-readmes` going stale is how a stray fixture commit was caught after `git status` read clean — investigate such staleness before regenerating it away.

## Guarding a Multi-Agent Run

`git status` cannot see a subagent that **committed**. Bracket any fan-out with Bash access in this repo:

```bash
npm run guard:snapshot   # before
npm run guard:verify     # after — exit 1 if anything moved
npm run guard:release    # when the run is genuinely over
```

It compares HEAD, branch, worktree status, **the content of every changed or untracked file**, and index flags. Content is load-bearing: overwriting a file that was already modified leaves its ` M path` status line byte-identical, and this repo is usually mid-edit. Index flags are included because `git update-index --skip-worktree` makes git report a modified file as clean from that point on, disarming every later check.

It fails closed — a missing, unreadable, or foreign snapshot exits 2 rather than reporting success, and exit 2 must never be read as a pass. `snapshot` refuses to overwrite and `verify` keeps the snapshot until `guard:release`, so a nested run cannot rebaseline the outer run's damage into a green. **Ignored paths are out of scope** (walking them means hashing `node_modules`), so a stray write to `CONTINUE_HERE.md` would not be seen (#493).

**A peer session may share this worktree.** "Foreign" above means a different repository or a different format version — those are the only two senses the guard knows. The snapshot records `formatVersion`, state, `takenAt` and `toplevel`, and **no owner**, so a second session in this repo clears both checks and `guard:release` there drops the incumbent's baseline as soon as the tree compares clean. Never release a slot you did not arm; wait for that run to release its own. The guard also cannot see a peer who was already working when you arrived, because no baseline exists from before their edits — so an occupied worktree is a case for agreeing on scope, not for inspecting harder. Declare path scope before your first *edit*, divide by paths rather than tasks (two agents on unrelated tasks still collide in one file), stage explicit paths — never `git add -A` — and review with `git diff origin/<base> --name-only` across the branch rather than `git show` on the tip. Full rationale in [Sharing the worktree with a peer session](guides/creating-workflows.md#sharing-the-worktree-with-a-peer-session).

Agents that may run shell commands should also carry the `REPO_SAFETY` preamble from `workflows/_template.mjs` — `mktemp -d` rather than a shared path, `cd "$DIR" || exit 1`, and a `git rev-parse --show-toplevel` assertion before anything destructive. The preamble is documentation; the guard is the control.

## Adding a New Skill

1. Create `skills/<skill-name>/SKILL.md` following the format of existing skills
2. Add the entry to `skills/_registry.yml` under the appropriate domain
3. Update `total_skills` count in `_registry.yml`
4. Symlink into `.claude/skills/`: `ln -s ../../skills/<skill-name> .claude/skills/<skill-name>`
5. Reference related skills in the new skill's "Related Skills" section
6. Run `npm run update-readmes` (or let CI auto-commit on push to main)
7. **Scaffold translations** (required — do not skip): `for locale in de zh-CN ja es; do npm run translate:scaffold -- skills <skill-name> "$locale"; done && npm run translation:status`
8. The meta-skill at `skills/create-skill/SKILL.md` documents this process in detail

## Adding a New Agent

1. Copy `agents/_template.md` to `agents/<agent-name>.md`
2. Fill in YAML frontmatter (required: `name`, `description`, `tools`, `model`, `version`, `author`)
3. List max 5 core skills in frontmatter `skills:` — identity skills only, no utility skills. List all remaining skills in the `## Available Skills` body section with `[core]` markers on the frontmatter ones
4. Write Purpose, Capabilities, Available Skills, Usage Scenarios, Best Practices, Examples, Limitations, and See Also sections
5. Add the entry to `agents/_registry.yml`
6. Run `npm run update-readmes` (or let CI auto-commit on push to main)
7. **Scaffold translations** (required — do not skip): `for locale in de zh-CN ja es; do npm run translate:scaffold -- agents <agent-name> "$locale"; done && npm run translation:status`
8. See `guides/agent-best-practices.md` for detailed guidance on the 5-skill limit and selection criteria

## Adding a New Team

1. Copy `teams/_template.md` to `teams/<team-name>.md`
2. Fill in YAML frontmatter (required: `name`, `description`, `lead`, `members[]`, `coordination`, `version`, `author`)
3. Write Purpose, Team Composition, Coordination Pattern, Task Decomposition, Configuration, Usage Scenarios, and Limitations sections
4. Include a `<!-- CONFIG:START -->` / `<!-- CONFIG:END -->` block with machine-readable YAML for tooling
5. Add the entry to `teams/_registry.yml` and update `total_teams` count
6. Run `npm run update-readmes` (or let CI auto-commit on push to main)
7. **Scaffold translations** (required — do not skip): `for locale in de zh-CN ja es; do npm run translate:scaffold -- teams <team-name> "$locale"; done && npm run translation:status`

Note: Teams are **not** auto-discovered like agents (from `.claude/agents/`). Do not create a `.claude/teams` symlink -- that path is reserved for `TeamCreate` runtime state (`~/.claude/teams/`). When a user asks to activate a team: (1) read the team definition from `teams/<team-name>.md`, (2) spawn each listed member as a subagent via the `Agent` tool (`subagent_type: "<member>"`), (3) coordinate them with `SendMessage` under the session's single implicit team, honoring the team's lead/coordination shape. `TeamCreate`/`team_name` are deprecated and gated out of ordinary interactive sessions (`ToolSearch("select:TeamCreate")` returns nothing there — verified against Claude Code binary v2.1.202, 2026-07-07, and re-verified interactively against v2.1.212, 2026-07-17; `team_name` behaviorally demonstrated ignored on v2.1.215, 2026-07-19 — see `tests/results/2026-07-17-team-infra-binary-probe/RESULT.md` including its Addendum); they are *asserted* to surface only as an environment-specific fallback in FleetView/cloud (not exercised by those captures — see #360).

## Adding a New Guide

1. Copy `guides/_template.md` to `guides/<guide-name>.md`
2. Fill in YAML frontmatter (required: `title`, `description`, `category`, `agents`, `teams`, `skills`)
3. Write sections following the template: When to Use, Prerequisites, Workflow Overview, core sections, Troubleshooting, Related Resources
4. Add the entry to `guides/_registry.yml` and update `total_guides` count
5. Run `npm run update-readmes` (or let CI auto-commit on push to main)

## README Automation

Dynamic sections in README files are auto-generated from the registries. Sections between `<!-- AUTO:START:name -->` and `<!-- AUTO:END:name -->` markers are replaced by `scripts/generate-readmes.js`. Four files (`guides/README.md`, `viz/README.md`, `teams/README.md`, `tests/README.md`) are fully generated — they carry no markers, so any hand edit to them is stale by definition. The other five are marker-based, and **deleting a marker pair is fatal** (exit 2), not stale: regenerating cannot restore a section that has nowhere to go.

`npm run check-readmes` runs on every PR touching a generated file, and on a daily schedule (`.github/workflows/validate-readmes.yml`). The schedule is not redundant — it is what catches drift when the auto-commit healer itself fails.

```bash
# Update all READMEs from registries
npm run update-readmes

# Check if READMEs are up to date (exits 1 if stale)
npm run check-readmes
```

CI auto-commits README updates when registry files change on `main` (`.github/workflows/update-readmes.yml`). Manual table updates in step 5 above are no longer needed — the script handles it.

## Viz Deploy Model

The visualization deploys to GitHub Pages from `.github/workflows/deploy-pages.yml`, which regenerates `viz/public/data/skills.json` before `vite build`. A registry change therefore reaches the page only through `build-data.js`, which reads three registries — `skills`, `agents`, `teams` — and every `skills/<id>/SKILL.md` body, from which it derives the node title, `metadata.tags`, and the entire skill-to-skill link set. The trigger paths therefore include `skills/*/SKILL.md` (#451). They deliberately exclude `guides/_registry.yml`, which no deploy step reads (#452), `skills/_template/SKILL.md`, which has no registry entry, and `agents/*.md` / `teams/*.md`, whose bodies `build-data.js` never opens.

The site makes three kinds of runtime fetch, and only the first is CI-derived:

| Fetched at runtime | Generated by | Derived on deploy |
|---|---|---|
| `data/skills.json` (`js/app.js`) | `build-data.js` | yes |
| `data/workflow.mmd` (`js/workflow.js`) | `Rscript build-workflow.R` | no — committed by hand |
| `locales/<code>.json` (`js/i18n.js`) | authored | n/a |

`data/workflow.mmd` is the same staleness shape #363 fixed for `skills.json`: generated, committed, runtime-fetched, and not regenerated by the deploy job. Regenerate it locally when the PUT annotations in `viz/` change.

The icon manifests (`icon-manifest.json`, `agent-icon-manifest.json`, `team-icon-manifest.json`) are *not* fetched at runtime at all. They are inputs to the R renderers in `viz/build.sh`, which produce committed PNGs. Regenerate them locally when glyphs change, via the full pipeline:

```bash
cd viz && bash build.sh          # never call Rscript directly
```

Note that `npm run build-manifest` builds skill manifests only — `build-icon-manifest.js` defaults to `['skill']`, and `build.sh` passes `--type all`.

`viz/public/data/skills.json` stays committed for local `npm run dev` and the Docker image. Because CI regenerates it on deploy, a stale committed copy no longer reaches the published site, but it can still drift from the registries in-tree; refresh it with `npm run build-data` in the same commit as the content change.

## Internationalization (i18n)

Translations live in the `i18n/` directory using a parallel tree structure. English sources remain canonical in `skills/`, `agents/`, `teams/`, `guides/`.

### Directory Structure

```
i18n/
  _config.yml                    # Locale configuration (de, zh-CN, ja, es)
  README.md                      # Contributor guide for translators
  <locale>/
    skills/<skill-name>/SKILL.md # Translated skill
    agents/<agent-name>.md       # Translated agent
    teams/<team-name>.md         # Translated team
    guides/<guide-name>.md       # Translated guide
    translation_status.yml       # Auto-generated coverage report
```

### Translation Rules

- Translate prose sections (descriptions, headings, pitfalls, validation text)
- Keep in English: `name` (=ID), code blocks, tool names, tags, domain, file paths, config values
- Every translated file has frontmatter fields: `locale`, `source_locale`, `source_commit`, `translator`, `translation_date`
- Translated SKILL.md files must stay under 500 lines

#### Which code fences are frozen

"Code blocks stay in English" was stated in four places and violated 1,220 times,
so it is now mechanical. A fenced block in any translated file is **frozen**
unless its info-string tag is exactly `text`, `markdown`, or `md`. Frozen means
the body must be byte-identical to a fence body appearing in *some* revision of
the paired English file.

The exemption list is **closed and default-deny**: an untagged fence, or any tag
not on that list — including tags nobody has used yet — is frozen on arrival.
Adding a tag to the list requires naming which machine consumes that fence. An
allowlist of "code" tags would leave `logql`, `bibtex`, `jsonl`, `traceql` and
`powershell` unguarded, and would let the scope be edited by retagging a
```` ```yaml ```` fence to ```` ```text ````.

Frozen covers everything inside the delimiters: comments, docstrings, string
literals, YAML values, placeholder tokens. Translate the prose *around* the
fence. If a comment carries the only statement of an instruction, lift it into
the step's prose rather than translating it in place.

`text` and `markdown` are exempt because they carry reference tables, decision
flows and report templates a human reads or fills in — a German reviewer should
be able to emit a German report.

This applies at every compression level. `guides/caveman-spellbook.md` already
lists code blocks under "What always survives"; compression is licensed for
prose only.

```bash
npm run validate:i18n-fences                    # whole corpus
node scripts/check-i18n-fence-parity.js \
  --locale de --id create-r-package             # just the file you touched
npm run normalize:i18n-fences                   # PREVIEW the English-body repair
npm run normalize:i18n-fences -- --write        # apply it
npm run normalize:i18n-fences -- --tag yaml     # one tag-scoped batch (#477)
```

The normalizer previews by default and writes only with `--write`, and refuses
to write into a dirty `i18n/` at all (#486) — a read-only probe agent once typed
the bare command and silently rewrote 281 files, after which every measurement
of the backlog was wrong and self-consistent.

`--tag <list>` scopes a run to fences carrying those tags. That is how the #477
backlog lands as reviewable, individually revertable batches rather than one
300-file diff — half the affected files are mixed-tag, so an unscoped run cannot
produce a single-tag slice. Scoping narrows what is repaired, never the
fence-count and tag-sequence checks that decide whether ordinal mapping is
trustworthy at all. A tag matching no divergent fence exits 2 rather than
reporting a clean-looking zero.

`--tree <list>` scopes the same way across content trees, and the normalizer now
covers all four — `skills`, `agents`, `teams`, `guides` — so it repairs exactly
what the checker flags. It was skills-only until the mirrors became the last
mechanically-repairable slice of #477 (87 fences / 11 files, cleared in #518).

Both scoping flags are validated against what the run actually reached, never
against a static list: a `--tag` matching no divergent fence exits 2, and so does
a `--tree` naming a tree the selected `--locale` carries no translations for.
Validating `--tree` corpus-wide instead let `--locale wenyan --tree guides` clear
both guards independently and report `files to change: 0` — six of the ten
locales carry `skills/` alone.

Runs **warn-only** in CI until the backlog clears (#477), then flips to blocking.
Warn is a temporary state with a named exit, not the design. Quote the current
count from the checker rather than from here — it was 1,307 at introduction and
drops with each batch.

### Translation Workflow

```bash
# Scaffold a translation (copies source, adds frontmatter)
npm run translate:scaffold -- <content-type> <id> <locale>

# Check translation freshness
npm run validate:translations

# Regenerate per-locale status files
npm run translation:status
```

### Adding a Translation

1. Scaffold: `npm run translate:scaffold -- skills create-r-package de`
2. Translate prose sections in the scaffolded file
3. Verify: `npm run validate:translations` (no stale warnings)
4. Update status: `npm run translation:status`
