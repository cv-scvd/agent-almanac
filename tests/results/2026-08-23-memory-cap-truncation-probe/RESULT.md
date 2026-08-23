## Run: 2026-08-23-memory-cap-truncation-probe

**Observer**: Claude (Opus 5, two interactive Claude Code sessions on one machine) | **Issue**: #407 | **Relates**: `anthropics/claude-code#82056`, `anthropics/claude-code#85595`

### Objective

`skills/manage-memory` documented the auto-memory index cap as 200 lines and never mentioned the
size cap, so #407 set out to correct it. Correcting it means writing a number into a public skill,
and the repo's own rule (`skills/create-skill`, "unverified tool-behavior claims", PR #409) is that
a confidently-stated claim about tool behavior gets verified rather than accepted — including when
the confident statement is ours.

Two claims needed evidence before they could be encoded:

1. The size cap counts **UTF-16 code units**, not UTF-8 bytes and not Unicode code points —
   reported externally in `anthropics/claude-code#82056` (v2.1.238 Windows; v2.1.237 Linux).
2. Where the cut actually lands, which decides what a budget check should report.

This run reproduces (1), and produces **two deltas** on (2) that the external reports do not carry.

### Environment

| Field | Value |
|---|---|
| Binaries | Claude Code **2.1.237** and **2.1.238**, invoked directly from `~/.local/share/claude/versions/`; **2.1.241** via the `claude` launcher, which resolves to the same directory. Same binaries, different entry paths — a reproducer following this table literally would not reproduce the 2.1.241 runs. |
| Platform | Ubuntu 24.04.4 LTS on WSL2, kernel 6.18.33.2-microsoft-standard-WSL2, x86_64 |
| Build flavour | linux-x64 |
| Fixture filesystem | ext4 under `/tmp` — deliberately **not** the `/mnt/d` NTFS mount, where in-place rewrites no-op |
| Session type | `claude -p` (print mode) only |
| Date | 2026-08-23 |

**This is a Linux data point.** The externally-cited v2.1.238 result was produced on native
Windows; a Windows-specific boundary cannot be confirmed or refuted from here.

### Method

Seven fixtures, each written as **bytes** (Python text mode rewrites CRLF and would destroy the
`crlf` arm), each placed at the project-slug path the harness reads. Every line carries a unique
canary token, so the cut is read out of the model's answer rather than inferred:

```
cd <arm dir> && printf '%s' "Reply with only the highest-numbered CANARY-NNN token present in your memory index, and nothing else." \
  | claude -p --tools ""
```

Generator: [`memcap-fixture.py`](memcap-fixture.py) in this directory. It emits the exact bytes
probed (verified by sha256 against the probed fixtures, 7/7 match).

**`--tools ""` is mandatory, and this is the trap worth publishing.** With tools enabled the model
answers by *reading `MEMORY.md` off disk*, returns the file's last line for every arm, and produces
a clean, internally consistent, completely wrong table showing that truncation does not exist.
`--tools` is also variadic and eats a positional prompt (`Error: Input must be provided either
through stdin or as a prompt argument when using --print`), so the prompt goes on stdin.

### Fixtures

| arm | filler | width (code points) | lines | EOL | UTF-8 bytes | UTF-16 units | code points | astral | what it discriminates |
|---|---|---:|---:|---|---:|---:|---:|---:|---|
| `ascii` | `x` | 126 | 200 | LF | 25,399 | 25,399 | 25,399 | 0 | baseline |
| `cjk` | `中` | 126 | 200 | LF | 71,399 | 25,399 | 25,399 | 0 | same units, 2.81x the bytes — is the cap bytes? |
| `astral` | emoji | 126 | 200 | LF | 94,399 | 48,399 | 25,399 | 23,000 | same code points as `cjk` — is the cap code points? |
| `ascii200` | `x` | 200 | 200 | LF | 40,199 | 40,199 | 40,199 | 0 | second width, to bracket the cap |
| `wide2000` | `x` | 2,000 | 200 | LF | 400,199 | 400,199 | 400,199 | 0 | cap lands deep inside a line — whole-line or partial? |
| `lines300` | `x` | 20 | 300 | LF | 6,299 | 6,299 | 6,299 | 0 | far under the size cap — does the line cap bite alone? |
| `crlf` | `x` | 126 | 200 | CRLF | 25,598 | 25,598 | 25,598 | 0 | do carriage returns count? |

### Observations — highest canary visible, two runs per cell

| arm | 2.1.237 | 2.1.238 | 2.1.241 |
|---|---|---|---|
| `ascii` | 196 / 196 | 196 / 196 | 196 / 196 |
| `crlf` | 195 / 195 | 195 / 195 | 195 / 195 |
| `wide2000` | 012 / 012 | 012 / 012 | 012 / 012 |
| `astral` | 103 / 103 | 103 / 103 | 103 / 103 |
| `cjk` | — | — | 196 / 196 |
| `ascii200` | — | — | 124 / 124 |
| `lines300` | — | — | 200 / 200 |

**30 probes in this table, of which 24 form the three-version matrix** (the four arms run on all
three versions); two runs per cell, zero disagreement anywhere. Auto-memory does load under
`claude -p` on all three versions.

### Verdicts

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | The cap counts UTF-16 code units | **CONFIRMED** | `cjk` cuts at the same line as `ascii` while carrying 2.81x the UTF-8 bytes, so not bytes. `astral` cuts at 103 against `ascii`'s 196 — ratio 1.903 against a UTF-16-per-line ratio of 242/127 = 1.906 — while holding the same code-point count as `cjk`, so not code points. |
| 2 | The size cap is ~25,000 | **BRACKETED** to [24,958, 25,018) | Kept-prefix lengths for N whole lines: `ascii`/`cjk` 127N−1, `ascii200` 201N−1, `astral` 242N−1, `crlf` 128N−2. Intersecting `L(kept) <= cap < L(kept+1)` over the four widths gives the bracket; 25,000 sits inside it. Counting the trailing EOL shifts it to [24,960, 25,019) — same conclusion. |
| 3 | Whichever cap binds first applies | **CONFIRMED, both directions** | `lines300` is 300 lines / 6,299 units and cuts at 200 — the line cap biting alone. The other six arms exceed both and every one cuts on size. |
| 4 | **Truncation is whole-line** | **MEASURED** | `wide2000` settles it with a large margin: lines are 2,001 units, the cap lands deep inside line 13, and that line's canary occupies units 24,012–24,022 — comfortably under the cap. Line 13 is absent. A partial-line-kept implementation cannot produce that. |
| 5 | **Carriage returns count toward the cap** | **MEASURED** | `crlf` cuts one line earlier than `ascii` on identical visible content — 199 extra CR units, one line lost. A budget quoted in lines is therefore EOL-dependent. At this line width a CRLF index loses roughly one line per 128; the penalty grows as lines get shorter, since the EOL's share of the budget scales inversely with width — 2/128 against 1/127 at 126 code points, but 2/22 against 1/21 at 20. |
| 6 | The boundary changed between releases | **REFUTED for linux-x64 across 2.1.237–2.1.241** | Identical results on all three, byte-identical fixtures (sha256-checked before probing). Scope note: the external Linux replication reports `ccd-cli 2.1.237` while this run used the official Claude Code 2.1.237 build; if those are not the same artifact, "same version" is carrying more weight than it should. |

### What the skills ship, checked against this run

The dual-cap block that `manage-memory` and `verify-memory-integrity` now carry reports the first
line dropped as the first line whose cumulative UTF-16 size exceeds 25,000, measured over the
content that actually loads — YAML frontmatter and block-level HTML comments are stripped before
the index is loaded and excluded from both limits, so a block that measured the raw file would
over-report. None of the seven fixtures carries either, so the strip does not affect these
predictions; it was added after a fleet measurement over-reported one real store by 1.7 points of
cap. Run against these seven fixtures the block predicts every measured cut:

| arm | block predicts first dropped | implied last visible | measured |
|---|---:|---:|---:|
| `ascii` | 197 | 196 | 196 |
| `cjk` | 197 | 196 | 196 |
| `astral` | 104 | 103 | 103 |
| `ascii200` | 125 | 124 | 124 |
| `wide2000` | 13 | 12 | 12 |
| `lines300` | 201 (line-bound) | 200 | 200 |
| `crlf` | 196 | 195 | 195 |

Seven for seven, including the arm where the line cap binds instead. That comparison is pinned in
`scripts/test/memory-blocks.test.js`, which extracts the block from the SKILL.md and runs it, so a
future edit that breaks the arithmetic fails a test rather than shipping as prose.

**A precision limit that comes with it, stated because the test will be cited.** The block
hardcodes 25,000, while this run only bounds the cap to a 60-unit window. For these seven arms the
difference is immaterial — every arm's line boundaries fall far outside the window. For a line
width that places a cumulative boundary *inside* [24,958, 25,018), the block's prediction is
uncertain by one line and nothing here settles it. Seven-for-seven is evidence that the block's
model is right, not that its constant is exact.

### Where the external table and this run disagree

The external report gives the last loaded line as 197 (`ascii`, `cjk`) and 99 (`astral`); this run
measures 196 and 103. The unit finding those rows support is unaffected — it rests on the byte and
unit totals, which reproduce here exactly — but the boundary column does not reproduce on either
version it was reported against. (The totals reproduce exactly for the ASCII and CJK rows. The
astral row does not: its stated totals require 126 astral code points per line with the canary
prefix counted nowhere, which is why that fixture could not be rebuilt here.)

One observation, offered as inference and not as proof: all three externally reported values equal
`ceil(25000 / units-per-line)`, where every value measured here is the floor.

| row | UTF-16 total | units/line | 25000 / units-per-line | ceil | floor | reported | measured here |
|---|---:|---:|---:|---:|---:|---:|---:|
| ASCII (external fixture) | 25,399 | 126.995 | 196.858 | 197 | 196 | 197 | 196 |
| CJK (external fixture) | 25,399 | 126.995 | 196.858 | 197 | 196 | 197 | 196 |
| astral (external fixture) | 50,599 | 252.995 | 98.816 | 99 | 98 | 99 | — not reproducible |
| astral (this run's fixture) | 48,399 | 241.995 | 103.310 | 104 | 103 | — | **103** |

The last row is the one that carries the argument: on a fixture under this run's control, the
measurement is the floor and not the ceil. The external astral row is listed with its own totals
rather than against this run's 103, because those are two different files and comparing them would
make the pattern look broken exactly where it is strongest.

A three-for-three fit to `ceil` is consistent with that column being computed from the cap rather
than read out of a model, which would also explain why the external `astral` fixture could not be
reconstructed from its stated totals (126 astral code points per line leaves no room for the canary
prefix). It is one hypothesis that survives after the version hypothesis was eliminated on both
cited versions; the way to settle it is the generator and the raw model replies, not the table.

**The direction matters.** The discrepancy is one line in the unsafe direction: a reader budgeting
from `ceil` believes one more line survives than does.

### Store identity — a slug transformation that changed

Measured on the same machine, both directions:

- **Read side**: with a different canary planted in each candidate slug directory for a project
  path containing `_`, the session loaded the hyphen-converted one.
- **Create side**: with both candidates deleted, the harness recreated exactly one — the
  hyphen-converted form.

`~/.claude/projects/` holds both forms for two real paths. The transformation itself is directly
measured on 2.1.241; its **date** is weaker evidence — the latest underscore-form mtime is
2026-03-22 and the earliest converted-form mtime is 2026-04-16, so the change falls in that window
*if no unrelated write moved either timestamp*. Directory mtimes move whenever contents change,
which makes this a plausible bracket rather than a measurement. What sits under the pre-flip slugs, counted directly:

| ghost store | contents | bytes |
|---|---|---:|
| `…-<project_a>/memory/` | `MEMORY.md` plus 2 topic files | 2,100 |
| `…-<project_b>/memory/` | 1 topic file, no index at all | 675 |

The slugs are elided: both are real private project identifiers, and the underscore is the only
part of them that carries the mechanism.

Three topic files and one orphaned index, 2,775 bytes. The first is not a stub: its converted-form
sibling holds 86 topic files under a 102-line index, so that store was in real use before it became
unreachable. Nothing will read the ghost again, and from inside a session that is indistinguishable
from "no such memory was ever written". Two project paths differing only by `_` versus `-` now also
collide onto one store.

This is the same false-negative class as an orphaned topic file, arriving one layer lower down, and
it is why `verify-memory-integrity` reports the resolved store path it measured rather than
assuming it.

### Boundaries

- One machine, linux-x64 builds, `claude -p` only. A Windows-specific boundary is not testable from
  here; CRLF — the obvious Windows-specific mechanism — moves the cut in the *other* direction.
- The instrument is the model's own report of what it can see, not a captured wire trace. Two runs
  per cell agreed everywhere, which bounds flakiness, not systematic error.
- The cap bracket is a bound from four line widths, not a read constant. A fifth width would
  narrow it.
- `~/.claude.json` was copied before invoking the older binaries in case a downgrade migrated
  state; it did not — no keys added or removed, and the five that changed are per-session activity
  counters.
- Every fixture directory created under `~/.claude/projects/` was removed afterwards, and the
  machine's real indexes were untouched throughout.

### Side finding: a probe fixture is indistinguishable from a real memory store

Each arm creates a real directory under `~/.claude/projects/<slug>/memory/` holding a real
`MEMORY.md`. Nothing marks it as synthetic. While this run was live, an independent inventory of
memory stores on the same machine counted 47 of them and had to discard 4 by name — the fixtures —
to get a true figure of 43.

That matters beyond tidiness, because it is the same failure this issue is about pointed the other
way: an orphan is a store the tooling cannot see, and a fixture is a non-store the tooling counts.

The fixture is one of **four** store-shaped things that a walk of `~/.claude/projects/` meets, and
three of the four should not be counted — each for a different reason. Counted on this machine
after the probe was cleaned up:

| shape | count here | count it? |
|---|---:|---|
| live store (`<slug>/memory/` with an index) | 43 | yes |
| `memory/` with no `MEMORY.md` | 2 | as a store with no catalog, which is its own finding |
| pre-flip ghost (`_`-form slug, live twin under the converted form) | 2 | no — unreachable, and counting it inflates the corpus |
| dated backup beside a live store (`memory.bak-…`) | 1 | no — a copy, not a store |
| probe fixture | 0 (removed) | no — a non-store |

53 slug directories, 45 with a `memory/`, 43 with an index. Every denominator in that sentence is
defensible and they are all different, which is the hazard: a figure quoted without saying which
one it counted is unfalsifiable. The same trap appeared one layer down while writing this — a
store reported as holding 91 files against 86, the difference being an `archive/` subdirectory the
harness never loads. The root-level count is the one that describes what loads.

**A mechanical detector for the ghost class**: on 2.1.241 the harness never emits a slug containing
`_`, so "slug contains `_`" has no false positives for it. It does not catch the general case — a
project that was renamed or moved leaves an equally unreachable store under a slug with no
underscore in it — which needs the weaker test "the slug does not round-trip to an existing path".

**A hazard for anyone tempted to repair this automatically**: the ghost's index is 226 bytes and
its live twin's is 102 lines. A merge that copies the ghost over the twin destroys 90 pointers. A
merge here has to be a link-set union, and reviewed rather than automatic.

Any tool that inventories memory stores, including `verify-memory-integrity`, reports over a
directory anyone can write into, and should report the store paths it counted rather than only the
total. Remove fixtures when a probe ends; verify the removal rather than assuming it.

### What this run does NOT claim

No statement here rests on inspecting a Claude Code build. The publishable claim is
"measurement shows the cap counts UTF-16 code units", version-stamped, and it stands on the
observations above alone. Identifiers, offsets and code shape from a shipped binary are
undocumented internals that rotate every release and do not belong in a public artifact.
