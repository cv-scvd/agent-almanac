# Translations

This directory contains translations of agent-almanac content into multiple languages. Translations follow a parallel directory tree structure that mirrors the English source.

## Supported Locales

| Code | Language | Skills | Agents | Teams | Guides | Status |
|---|---|---|---|---|---|---|
| de | Deutsch (German) | 317/328 | 3/66 | 1/15 | 1/19 | Active |
| zh-CN | 简体中文 (Simplified Chinese) | 317/328 | 3/66 | 1/15 | 1/19 | Active |
| ja | 日本語 (Japanese) | 317/328 | 3/66 | 1/15 | 1/19 | Active |
| es | Español (Spanish) | 317/328 | 3/66 | 1/15 | 1/19 | Active |

## Directory Structure

```text
i18n/
  _config.yml                    # Locale configuration
  README.md                      # This file
  <locale>/
    skills/<skill-name>/SKILL.md # Translated skills
    agents/<agent-name>.md       # Translated agents
    teams/<team-name>.md         # Translated teams
    guides/<guide-name>.md       # Translated guides
    translation_status.yml       # Auto-generated coverage report
```

## What Gets Translated vs Stays English

| Content Type | Translate | Keep English |
|---|---|---|
| **Skills** | description, section headings, prose, pitfalls, validation text | name (=ID), allowed-tools, code blocks, tags, domain, language |
| **Agents** | description, Purpose, Capabilities, Usage Scenarios, Limitations | name (=ID), tools list, model, priority, skills list |
| **Teams** | description, Purpose, Coordination Pattern prose, Usage Scenarios | name (=ID), lead, members[].id, coordination type, CONFIG block |
| **Guides** | title, description, all prose sections, troubleshooting | code blocks, command examples, file paths, YAML config examples |

### Code fences: which are frozen

"Code blocks" above is enforced, not advisory (#472). A fenced block is **frozen**
unless its info-string tag is exactly `text`, `markdown`, or `md`. A frozen fence
body must be byte-identical to a fence body appearing in *some* revision of the
paired English file — any revision ever committed, so a faithful translation of an
older English source still passes and staleness stays
`check-translation-freshness.js`'s problem.

The exemption list is closed and **default-deny**. Untagged fences are frozen. Any
tag not named above — `logql`, `bibtex`, `powershell`, or one invented next year —
is frozen on arrival. Adding a tag requires a PR naming which machine consumes
that fence.

Frozen covers everything between the delimiters: comments, docstrings, string
literals, YAML values, placeholders. Translate the prose around the fence. When a
comment carries the only statement of an instruction, lift it into the prose
instead of translating it in place.

`text` and `markdown` stay localisable because they carry tables, decision flows
and report templates meant to be read or filled in by a person in their own
language.

```bash
npm run validate:i18n-fences                    # whole corpus
node scripts/check-i18n-fence-parity.js \
  --locale de --id create-r-package             # just the file you touched
npm run normalize:i18n-fences                   # PREVIEW the restore from source_commit
npm run normalize:i18n-fences -- --write        # apply it
npm run normalize:i18n-fences -- --tag yaml,json  # one #477 batch
```

The normalizer previews unless `--write` is passed, and refuses to write into a
dirty `i18n/` — `git checkout -- i18n/` is its only undo, and it would take your
uncommitted work with it (#486).

`--tag <list>` scopes a run to fences carrying those tags — the #477 batches. A
tag matching no divergent fence exits 2 rather than reporting zero, so a typo
cannot read as "this batch is already done".

`--tree <list>` scopes the same way across content trees. The normalizer covers
all four — `skills`, `agents`, `teams`, `guides` — so it repairs exactly what the
checker flags; it was skills-only until the mirror slice was cleared in #518. A
`--tree` naming a tree the selected `--locale` carries no translations for exits
2, for the same reason a `--tag` matching nothing does.

Runs **warn-only** in CI until the backlog clears (#477), then flips to blocking.

## Translation Frontmatter

Every translated file includes these fields in its YAML frontmatter:

```yaml
locale: de                              # Content locale (IETF BCP 47)
source_locale: en                       # Translated from
source_commit: abc1234                  # Git short hash of source at translation time
translator: "Claude + human review"     # Attribution
translation_date: "2026-03-15"          # ISO 8601
```

These fields enable freshness tracking: when the English source changes after the `source_commit`, the translation is flagged as stale.

## Contributing a Translation

### Using the translation-campaign team

For large-scale translation work, use the [translation-campaign](../teams/translation-campaign.md) team with wave-parallel coordination. See [Running a Translation Campaign](../guides/running-a-translation-campaign.md) for the end-to-end guide.

### Using the translator agent

For individual translations, use the `translator` agent and `translate-content` skill:

```text
"Use the translator agent to translate create-r-package into German"
```

### Manual workflow

1. **Scaffold**: `npm run translate:scaffold -- <content-type> <id> <locale>`
   - Copies the English source to `i18n/<locale>/<type>/<id>/`
   - Pre-fills translation frontmatter fields

2. **Translate**: Edit the scaffolded file
   - Translate all prose sections
   - Keep code blocks, IDs, tags, and tool names in English
   - Use domain-appropriate terminology

3. **Review**: Spot-check for accuracy and idiomatic phrasing

4. **Update status**: `npm run translation:status` regenerates `translation_status.yml`

## Quality Guidelines

- **Terminology consistency**: Use established translations for technical terms within each locale
- **Code blocks**: Never translate code, commands, file paths, or configuration values
- **IDs are stable**: Skill names, agent names, team names, and tag values stay in English
- **Frontmatter fields**: `name` always matches the English source (it is the ID)
- **Line count**: Translated SKILL.md files must stay under 500 lines
- **Cross-references**: Skill/agent/team references use English IDs, not translated names

## Freshness Tracking

Translations are tracked against the English source via `source_commit`. When the source file changes:

```bash
# Check which translations are stale
node scripts/check-translation-freshness.js

# Warn-only mode (used in CI)
node scripts/check-translation-freshness.js --warn
```

## Status Reports

Per-locale status files are auto-generated:

```bash
# Regenerate all translation_status.yml files
npm run translation:status
```

Each `translation_status.yml` reports four numbers per content type, and they do not mean
what a quick read suggests:

| field | meaning |
|---|---|
| `total` | English sources of that type, from the registry |
| `translated` | files that show evidence of translation |
| `stubs` | files that show **none** — scaffolds, still word-for-word English |
| `stale` | translated files whose English source changed after their `source_commit` |

Two things follow, and both have misled readers before:

- **`stale` is measured only over `translated`.** A stub is never also stale, because the
  scaffold verdict is reached first. So recognising a scaffold *lowers* `stale` with nothing
  translated — a falling `stale` number is not by itself progress.
- **`translated + stubs` is not `total`.** A locale that has never scaffolded an item has
  neither, so the remainder is untouched content.

The root `README.md` coverage table renders these same numbers, and only these — it reads the
status files rather than counting what exists on disk (#560). Its cells use two markers:

| marker | meaning |
|---|---|
| `*` | file count, not a measurement — that locale has no `translation_status.yml` yet |
| `-` | not measured (the `Stubs` column of a locale with no status file). Never `0`, which would read as "no stubs found" |

`scripts/check-readme-translation-parity.js` (integrity check B13) fails if the two ever
disagree. It parses both committed files rather than regenerating the table, so it still sees
a generator that goes back to counting files.

A file counts as a stub when every substantive prose line in it appeared verbatim in English
at some point, or when its locale is written in a script the file contains none of. Frozen
code fences are excluded from that comparison — they are keep-in-English in every locale by
design, so counting them would make every genuine translation look like a scaffold.

```bash
# The per-file list behind the stub count -- read this before deleting anything
npm run translation:status -- --verdicts

# How close the closest genuine translations came to being called scaffolds
npm run translation:status -- --margins
```

Use `--verdicts` before any bulk re-scaffold. A stub verdict is remediated by deleting the
file, so a wrong one destroys real work, and an aggregate count cannot be reviewed.

## See Also

- [Running a Translation Campaign](../guides/running-a-translation-campaign.md) -- end-to-end guide for large-scale translation
- [translation-campaign](../teams/translation-campaign.md) -- wave-parallel team for systematic localization
- [translator](../agents/translator.md) -- agent for individual translations
- [translate-content](../skills/translate-content/SKILL.md) -- skill for content translation
- [Root README](../README.md) -- project overview
