# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- `cli/adapters/hermes.js` + `cli/lib/detector.js`: the Hermes home is now resolved via `cli/lib/hermes-home.js` — `$HERMES_HOME` first (authoritative on every platform), then the Windows-native default `%LOCALAPPDATA%\hermes` (accepted only when its `config.yaml` exists), then `~/.hermes` (the Unix default, and the legitimate home for Hermes inside WSL). Previously `detect()` and both install bases hardcoded `homedir()/.hermes`, so a Windows-native Hermes install was invisible to `detect` and installs, and only a manual directory junction made anything fire (#604). The two HOME-redirected test blocks now also pin `HERMES_HOME` and clear `LOCALAPPDATA`, which fixes the hermes broken-symlink audit case leaking to the real user profile on Windows — `os.homedir()` ignores `$HOME` on win32, so the old steering never reached it.
- i18n stub detection: a stray fence opener that *pairs* with a real fence inverted the document's fence phase and hid prose from comparison. An added ```` ```bash ```` cannot close anything (a closer carries no trailing text) but it opens, so the real opener was swallowed into its body and the real closer closed the stray fence. Measured: `total` 5 → 3, verdict `no-novel-lines` (a scaffold) → `insufficient`, which is counted as **translated**. One added line laundered a scaffold. #558 fixed only the *unterminated* case and passes this fixture. Detected now by comparing the file's fence **shape** — the ordered list of info-string tags, which are keep-in-English in every locale — against every shape its English source has ever had. Shape, not count: the flip leaves the count unchanged. Tags, not bodies: #477's backlog leaves 1,220+ bodies diverging, so a body comparison would refuse to judge much of the corpus. Terminated fences only, so #558's unterminated case keeps its `stub` verdict — and so the check needs no second "did the mask hide lines?" condition, which an earlier draft carried and which left a worse hole open: a stray ```` ```text ```` opener is localisable, hides nothing, and instead **exposes** the real frozen body, whose keep-in-English lines then read as novel prose and reported `has-novel-lines` — a positive claim of translation. (#561)
- `scripts/generate-readmes.js` — the published README translations table counted files, not translations, so every cell was `translated + stubs`: it read `de 383/500 (76.6%)` where `i18n/de/translation_status.yml` measured `347/500 (69.4%)`. The table now renders the status files' figures verbatim (denominators and `pct` included, so the two surfaces cannot disagree by rounding) and breaks `stubs` out as its own column. Existence counting survives only for a locale with no status file, and such a cell is marked `*`. (#560)

### Added
- `unjudged` count in every `translation_status.yml`, and an `UNJUDGED` line in `translation:status --verdicts`. A file whose fence mask cannot be trusted is counted as neither translated nor stub: counting it translated inflates coverage, and calling it a stub routes a possibly fully-translated file into a remedy that deletes it. (#561)
- `scripts/check-readme-translation-parity.js` + integrity check B13 — gates the README table against `i18n/*/translation_status.yml`. It parses both committed artifacts and never calls the generator: a regenerate-and-compare gate agrees with any generator bug, which is why `check-readmes` passed throughout (it also runs only in `release.yml`). Iterates locales rather than table rows, so a deleted row is visible. (#560)

### Changed
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

[Unreleased]: https://github.com/pjt222/agent-almanac/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/pjt222/agent-almanac/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/pjt222/agent-almanac/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pjt222/agent-almanac/releases/tag/v1.1.0
