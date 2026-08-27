# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `resolveHermesHome()` returned `$HERMES_HOME` raw while its other two tiers returned `resolve()`d absolute paths, so the function's documented return type held for two of its three code paths. All three now normalize before returning. This fixes the **inconsistent contract, not the relativity**: a relative `HERMES_HOME` remains anchored to `process.cwd()`, now once at the source instead of once at each of the four call sites that wrapped the result in `resolve()` again — two invocations launched from different directories still see different homes, which is inherent to a relative path. A whitespace-only value is now treated as unset, on the argument that `" "` is a quoting accident rather than a directory name; the value that is *used* is never trimmed, so a legitimate path with a leading or trailing space survives byte-for-byte. The pre-existing `$HERMES_HOME` test used an absolute fixture and so passed identically with the bug present; three tests now discriminate (#611).

## [1.9.1] - 2026-08-26

The first release to actually reach npm since `1.3.0`. `1.9.0` was tagged on 2026-08-19 and its publish failed with `E404` on the PUT; the credential behind it was later measured dead (`E401` on `whoami`). This release carries that fix and the content that accumulated behind it.

**`cli/` is byte-identical to `1.9.0`.** This is a content release, not a code one — every breaking change described under `[1.9.0]` still applies and still describes the CLI you get. Read that section before upgrading from `1.3.0`.

### Added
- **`verify-memory-integrity` skill** — validates an agent memory store end to end: frontmatter, link targets, index coverage in both directions, and orphan detection. Ships with `references/EXAMPLES.md`. Skills **370 → 371**, domains unchanged at 66.
- `references/EXAMPLES.md` for `prune-agent-memory` and `repair-broken-references`, extracting long examples out of the SKILL.md bodies under the agentskills.io progressive-disclosure pattern.

### Changed
- `manage-memory`, `prune-agent-memory`, `repair-broken-references` and `validate-references` substantially rewritten — the four memory-maintenance skills now describe one consistent store shape and cross-reference each other rather than each restating the format.
- `agents/librarian.md` — capabilities and skill list brought in line with the memory skills above.
- `guides/protecting-github-repositories.md` — branch-protection guidance rewritten against the live ruleset API, including that reading which rules bind a branch and reading who bypasses them are two separate calls.

### Fixed
- **The release path published nothing for three months.** `release.yml` authenticated with a secret named `NPM_TOKEN_2` that was dead, then deleted; the workflow kept referencing the deleted name, and a missing GitHub secret resolves to the empty string rather than failing. Repointed at `NPM_TOKEN` (#696, #746).
- **`release.yml` never checked that the git tag matched `package.json`.** `npm publish` takes its version from the manifest and ignores the ref; `gh release create` takes its title from the ref and ignores the manifest. A mismatch was silent and green: tagging `v1.9.1` against a manifest reading `1.9.0` would have published 1.9.0 — a free version, so the PUT succeeds — under a release titled "Release v1.9.1", leaving `npm i agent-almanac@1.9.1` a permanent `E404`. Guarded on the tag path.
- `package-lock.json` declared `1.3.0` while `package.json` declared `1.9.0` — the earlier bump was hand-edited. Both now move together via `npm version`.

## [1.9.0] - 2026-08-19

The last release of the JavaScript CLI. The version number is deliberate: `2.0.0` is held for the Rust port (#256), so this line ends at `1.9.x`.

**Read the Breaking section before upgrading.** The number says minor; three of the changes below are breaking in fact. Nothing has been released since `1.3.0` (2026-05-04), and the changes accumulated in that window include a Node floor raise. A minor version is a weaker warning than these changes deserve, and this notice is the compensation for it.

### Breaking
- **Node.js 22.12.0 or newer is now required** (`engines.node` was `>=18.0.0`). The floor was raised on 2026-06-04 when the CLI moved to commander 15 — a month after `1.3.0` shipped — so this is the first published release that carries it. Node 18 and Node 20 users must upgrade Node; `npm install` will warn rather than fail, so an unattended install can leave a CLI that cannot start.
- **`almanac audit` now exits non-zero when it finds problems** (#439). It previously exited `0` unconditionally, so any script, CI step, or pre-commit hook that ran `audit` was passing regardless of what the audit said. Those callers will now start failing — which is the point, but it will look like a new breakage rather than a newly visible old one. Adapter crashes are also marked structurally rather than being reported as ordinary findings.
- **`--version` now reports the real version** (#456). `cli/index.js` hardcoded `.version('0.1.0')`, so the *published* `1.3.0` binary answers `--version` with `0.1.0`, and has answered wrongly for every release since `0.1.0`. Anything that parses `--version` will see it jump from `0.1.0` to `1.9.0`. That jump is this bug being fixed, not a version skip; the value now derives from the package manifest and cannot drift again.

### Fixed
- `cli/index.js` — `--version` no longer hardcoded; derived from the manifest (#456). See Breaking.
- `cli/lib/` chalk factory — the colour fallback was broken, silently degrading output rather than falling back cleanly (#455, #457).
- `opencode` adapter audit — the `ok` line counted entries that were not valid, so a passing audit could overstate what it had checked (#445).
- `claude-code` adapter audit — `base` is now declared; it was referenced undeclared (#365, #373).
- js-yaml 5 compatibility — namespace imports, after the ESM default export was removed upstream.
- `scripts/lib/english-history.js` + `scripts/lib/translation-status.js` — the comment table documenting the shared English-history walk was falsified by #597 and never updated. Tag-sequence parity (#481) added a **sixth** collector over that walk, `history.sequences` (`scripts/lib/fences.js`), which the table did not list; `rg -n 'sequence' scripts/lib/english-history.js` returned nothing. The stale clauses were not a matter of changing "five" to "six": the new member goes **both** ways under a shrunk pool, so the three-way tally ("two tighten, two loosen, one is untouched") could not survive it. Losing the revision whose sequence matched turns a legitimate translation into a retag finding (strict); losing the last revision with the same fence count demotes a real retag to `unalignable`, which is expressly not a finding (lenient). The table now says which five sort and why the sixth does not. Also corrected: the walk has **three production** callers, not two — `scripts/measure-tag-sequence-parity.js` is named as a consumer rather than scoped out, because `fences.js` cites it as the reproducer for the tag-sequence finding set. The qualifier is load-bearing: `rg walkEnglishHistory` returns a fourth call site in `scripts/test/`, and an unqualified "three" would be a count refuted by the obvious grep — #599's own defect, reintroduced by its fix. Nothing asserts these counts mechanically; there is no gate here and no mutation was run. (#599)
- `cli/adapters/hermes.js` + `cli/lib/detector.js`: the Hermes home is now resolved via `cli/lib/hermes-home.js` — `$HERMES_HOME` first (authoritative on every platform), then the Windows-native default `%LOCALAPPDATA%\hermes` (accepted only when its `config.yaml` exists), then `~/.hermes` (the Unix default, and the legitimate home for Hermes inside WSL). Previously `detect()` and both install bases hardcoded `homedir()/.hermes`, so a Windows-native Hermes install was invisible to `detect` and installs, and only a manual directory junction made anything fire (#604). The two HOME-redirected test blocks now also pin `HERMES_HOME` and clear `LOCALAPPDATA`, which fixes the hermes broken-symlink audit case leaking to the real user profile on Windows — `os.homedir()` ignores `$HOME` on win32, so the old steering never reached it.
- i18n stub detection: a stray fence opener that *pairs* with a real fence inverted the document's fence phase and hid prose from comparison. An added ```` ```bash ```` cannot close anything (a closer carries no trailing text) but it opens, so the real opener was swallowed into its body and the real closer closed the stray fence. Measured: `total` 5 → 3, verdict `no-novel-lines` (a scaffold) → `insufficient`, which is counted as **translated**. One added line laundered a scaffold. #558 fixed only the *unterminated* case and passes this fixture. Detected now by comparing the file's fence **shape** — the ordered list of info-string tags, which are keep-in-English in every locale — against every shape its English source has ever had. Shape, not count: the flip leaves the count unchanged. Tags, not bodies: #477's backlog leaves 1,220+ bodies diverging, so a body comparison would refuse to judge much of the corpus. Terminated fences only, so #558's unterminated case keeps its `stub` verdict — and so the check needs no second "did the mask hide lines?" condition, which an earlier draft carried and which left a worse hole open: a stray ```` ```text ```` opener is localisable, hides nothing, and instead **exposes** the real frozen body, whose keep-in-English lines then read as novel prose and reported `has-novel-lines` — a positive claim of translation. (#561)
- `scripts/generate-readmes.js` — the published README translations table counted files, not translations, so every cell was `translated + stubs`: it read `de 383/500 (76.6%)` where `i18n/de/translation_status.yml` measured `347/500 (69.4%)`. The table now renders the status files' figures verbatim (denominators and `pct` included, so the two surfaces cannot disagree by rounding) and breaks `stubs` out as its own column. Existence counting survives only for a locale with no status file, and such a cell is marked `*`. (#560)

### Added
- Broken symlinks are now reported in six adapter audits (#438). A dangling link previously read as a healthy install.
- `unjudged` count in every `translation_status.yml`, and an `UNJUDGED` line in `translation:status --verdicts`. A file whose fence mask cannot be trusted is counted as neither translated nor stub: counting it translated inflates coverage, and calling it a stub routes a possibly fully-translated file into a remedy that deletes it. (#561)
- `scripts/check-readme-translation-parity.js` + integrity check B13 — gates the README table against `i18n/*/translation_status.yml`. It parses both committed artifacts and never calls the generator: a regenerate-and-compare gate agrees with any generator bug, which is why `check-readmes` passed throughout (it also runs only in `release.yml`). Iterates locales rather than table rows, so a deleted row is visible. (#560)

### Changed
- Content shipped in the package, counted from the registries at the `v1.3.0` tag rather than from a directory listing: **skills 350 → 370**, **agents 72 → 75**, **teams 17 → 22**, **guides 26 → 35**. (The tag is the right baseline, not the release-prep commit before it — a 26th guide landed in the merge that got tagged, and `release.yml` publishes the tag's tree.)
- Packaging: the authoring templates — `skills/_template/`, `agents/_template.md`, `teams/_template.md`, `guides/_template.md` — are no longer published (#669). They are scaffolding for authoring new content, not content, and shipping them meant a consumer globbing the installed directories counted one more of each kind than the registries declare (371 skills against a registry, README and `check-readmes` that all say 370). With them excluded, every shipped count now equals its registry exactly: 370 skills, 75 agents, 22 teams, 35 guides. Nothing under `cli/` references any of them, so the exclusion is invisible to the CLI itself.
- CI: `update-readmes.yml` now runs `translation:status` **before** `generate-readmes.js`. With the table deriving from the status files, the old order rendered last cycle's numbers while the same commit overwrote the file it read. The job also asserts parity before auto-committing, and `scripts/lib/translation-status.js` was added to its trigger paths — the #553 lib extraction meant a change to what counts as an untranslated scaffold did not regenerate the counts it decides. (#560)

## [1.3.0] - 2026-05-03

### Added
- `empirical-investigator` agent (72nd agent) — dedicated persona for the `investigation` domain (wire capture, feature flag probing, version baseline monitoring, responsible disclosure)
- Caveman Spellbook: 6 compression locales — `caveman-lite`, `caveman`, `caveman-ultra`, `wenyan-lite`, `wenyan`, `wenyan-ultra` — a homage to JuliusBrussee/caveman
- **All 10 locales now at 350/350 (100%) skill coverage** — caveman/wenyan trio of trios completed in 14 waves; de/es/ja/zh-CN coverage gap closed (+96 SKILL.md files in coverage closure wave)
- `scripts/bulk-scaffold-caveman.sh` for fast bulk locale scaffolding (single git-hash call)
- Translation scaffolding step embedded in all 6 content creation/evolution meta-skills (`create-skill`, `create-agent`, `create-team`, `evolve-skill`, `evolve-agent`, `evolve-team`)
- `caveman-spellbook` team (9-member wave-parallel) for caveman/wenyan compression translation
- `coverage-closure` ad-hoc team activation for original-locale gap closure (4 parallel translators)
- `guides/installation.md` (26th guide) — OS-aware install runbook covering Linux, macOS, Windows native, WSL2, Codespaces, and devcontainers; consolidates plugin install, global CLI install, prereqs (CRLF/longpaths/symlinks for Windows), MCP server commands per platform, verification gates, and updating
- README install section streamlined: three labelled paths (zero-install reference, plugin, global CLI) with verification step; deep details deferred to the new Installation guide
- `.github/workflows/deploy-pages.yml` path filter expanded to trigger Pages redeploy on registry / i18n / workflow changes (previously only `viz/**` triggered, leaving Pages stale after content updates)

### Fixed
- i18n: structural quality pass — 28 translation files updated to match restructured sources (missing Step 14/11 in create-* skills, missing Step 4.5 in evolve-* skills, render-icon-pipeline rewritten 6-step→3-step)
- i18n: cleared 140 stale translations across de/zh-CN/ja/es (issue #243)
- i18n: normalized ~970 source_commit values to 8-char short hashes; resolved ~647 false-positive stale warnings
- i18n: fixed scaffold-before-creation source_commit race (source_commit now captured at scaffold time, not at source creation)
- `scripts/generate-translation-status.js` — was counting file existence as "translated", masking 70 caveman/wenyan stubs per locale + 3 stubs per original locale. Now uses body-equality vs English source to discriminate translated files from scaffolded stubs; emits separate `stubs` count. **Scope correction (see #560):** this fixed that one script. `scripts/generate-readmes.js` kept counting file existence for the published README table until #560, so the front-page number stayed wrong — and body-equality itself was replaced in #553, because a surgically-patched mirror equals no English revision.
- `scripts/translate-content.sh` — skills branch sed `/^  tags:/a\\` was injecting locale fields between `tags:` and the first list item, breaking the YAML list. Now uses end-of-frontmatter insertion (matches agents/teams/guides pattern). Surfaced when zh-CN translator hit 5 broken stubs in coverage-closure wave.
- `.gitignore` — added `.claude/settings*.json` (per-user dev config); fixed missing newline that merged `*.knit.md` and `CONTINUE_HERE.md` rules

### Changed
- CI: GitHub Actions Node runtime bumped to Node 24 (5 workflows)
- i18n: `_config.yml` now documents 10 locales (was 4)
- `package.json` version bumped to 1.3.0

## [1.2.0] - 2026-04-16

### Added
- `investigation` domain: 4 reverse-engineering skills (`conduct-empirical-wire-capture`, `monitor-binary-version-baselines`, `probe-feature-flag-state`, `redact-for-public-disclosure`)
- `web-scraping` domain: `rotate-scraping-proxies` skill; `headless-web-scraping` re-homed here
- `choose-loop-wakeup-interval` skill (synoptic domain)
- 2 new guides: `reverse-engineering-a-cli-harness`, `self-continuation-loops-playbook` (new `investigation` category)
- Claude Code plugin manifest (`.claude-plugin/plugin.json`)
- AI edge CLI adapter for installing almanac on edge LLMs
- i18n translations for `rotate-scraping-proxies` (de, zh-CN, ja, es)
- Glyphs for 6 new entities + `glyph_loop_clock` icon

### Fixed
- TUI: wire g/s keys for kindle/scatter; correct tending status display
- Viz: restore full agent/team node set (was incorrectly filtered by locale)
- Viz: preload hive icons on mode switch; batch requests for mobile compatibility
- Plugin manifest: remove invalid `agents` field

## [1.1.0] - 2026-03-23

First published release.

[Unreleased]: https://github.com/pjt222/agent-almanac/compare/v1.9.1...HEAD
[1.9.1]: https://github.com/pjt222/agent-almanac/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/pjt222/agent-almanac/compare/v1.3.0...v1.9.0
[1.3.0]: https://github.com/pjt222/agent-almanac/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/pjt222/agent-almanac/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pjt222/agent-almanac/releases/tag/v1.1.0
