# tools/

Reusable analysis tooling for agent-almanac, accumulated as work turns up a calculation worth
keeping.

**`tools/` is not `scripts/`.** `scripts/` holds the repository's own machinery — the gates CI
runs, the generators, the envelopes — and it is wired into `package.json`, CI workflows and
test discovery. `tools/` holds utilities meant to be run by a person, repeatedly, across
sessions: the arithmetic behind an investigation, a probe helper, a one-off that turned out not
to be one-off. Nothing here is a gate and nothing here blocks a merge.

The rule that produced this directory: **when a calculation gets done twice, it becomes a tool.**
A throwaway heredoc leaves nothing behind and cannot be checked; the same arithmetic in a file
with a `--verify` mode can be re-run by anyone, including the next session.

## Layout

| Tool | Purpose |
|---|---|
| `capgeom.py` | Geometry and reconstruction arithmetic for auto-memory index cap probes. Holds the arm registry from `tests/results/2026-08-23-memory-cap-truncation-probe/`, derives every published bound from it, and refuses to agree with a figure that no longer follows from its recorded arm |

## Running

Everything here is dependency-free and runnable from the repository root:

```bash
python3 tools/capgeom.py --verify     # re-derive every published figure, assert, print counts
python3 tools/capgeom.py --arms       # the arm registry as a table
python3 tools/capgeom.py --span 170 147
```

## Adding one

Give it a `--verify` (or `--selftest`) mode that re-derives its own published claims and exits
non-zero when one stops following. A tool that only computes is a calculator; a tool that
checks its own back-catalogue is a ratchet, and it will catch the error you were about to make.
`capgeom.py` rejected an entry of its own registry on first run — a bracket end credited to the
wrong kind of position — which is the entire argument for the convention.

Then add a row to the table above.
