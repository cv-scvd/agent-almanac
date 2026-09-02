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
| `wirecap.py` | Captures the request body a Claude Code session actually sends, by standing in as `ANTHROPIC_BASE_URL`. Answers locally — nothing is forwarded — and redacts credential headers before anything reaches disk. Use it when the question is "what is in the context?", which a session cannot be asked, because its self-report on that is unsound in both directions |
| `check-redaction.sh` | Shape-tier deny-list scanner for a **draft about to leave the machine**. Implements the scanner `skills/redact-for-public-disclosure` Step 3 and `skills/enforce-redaction-gate` Step 2 both specify and neither shipped. Guards third-party internals — minified identifier shapes, byte offsets, operator home paths, store slugs, credential shapes — that the skill's category table rates publishable "Never — until vendor-documented" |
| `translator-stamp.mjs` | Keeps the `translator:` frontmatter field honest on scaffolds (#545). Classifies every translated file by the STUB / UNJUDGED verdicts of `generate-translation-status.js --verdicts` (`no-novel-lines` or `no-script` — not byte equality), repairs the field only in STUB-verdict files, and lists UNJUDGED and translated-but-stamped files for a human attribution call. Reads the stub value from `scripts/translate-content.sh` rather than duplicating it, so the two cannot drift silently, and exits 2 on any locale/tree pair the verdict scan did not cover |

## Running

Everything here is dependency-free and runnable from the repository root:

```bash
python3 tools/capgeom.py --verify             # re-derive every published figure, assert, print counts
python3 tools/capgeom.py --selftest-negative  # mutate recorded figures, assert --verify goes red
python3 tools/capgeom.py --arms               # the ARMS registry (echo instrument) as a table
python3 tools/capgeom.py --wire               # the wire-measured arms (#722)
python3 tools/capgeom.py --span 170 147

python3 tools/wirecap.py --verify                       # self-test: capture verbatim, redact secrets
python3 tools/wirecap.py --port 8788 --out over.jsonl   # then point ANTHROPIC_BASE_URL at it
python3 tools/wirecap.py --diff over.jsonl under.jsonl

bash tools/check-redaction.sh --verify        # seed each shape, assert the gate catches it
bash tools/check-redaction.sh --labels        # what is checked, without the patterns
bash tools/check-redaction.sh DRAFT.md        # exit 0 clean / N findings / 2 COULD NOT RUN

node tools/translator-stamp.mjs               # preview: classify, list the repair set, change nothing
node tools/translator-stamp.mjs --write       # repair byte-equal stubs only
node tools/translator-stamp.mjs --verify      # exit 0 clean / 1 a stub asserts a review / 2 COULD NOT MEASURE
```

**`translator-stamp.mjs` also exits 2 when it cannot measure** — zero STUB verdicts parsed, or no
quoted value in the scaffolder — because a corpus with no stubs and a verdict format that changed
look identical from the outside, and only one of them is good news.

**`check-redaction.sh` exits 2 when it cannot run, and 2 must never be read as a pass.**
`enforce-redaction-gate` names the trap it is built against: a wrapper shaped
`scanner && ok || echo CLEAN` treats a *tool error* — a bad flag, an unreadable file — as a clean
result, so the gate reports success precisely when it has checked nothing. Its `--verify` seeds
each of its six shapes **individually**, because a gate that catches five and is blind to the
sixth passes any self-test that seeds only one.

It scans a draft, not the tree, which is why it is here and not in `scripts/` and why no CI job
runs it — a draft is not a tracked file. It is also **not** `npm run validate:security`: that gate
guards *our* committed content against leaking *our* credentials outward to people who install the
skills. This one guards a *third party's* internals on the way out. Neither substitutes for the
other, and the first real use of this one caught four findings in a probe script already staged
for a public commit.

**Know what it is second-best to before you extend it (#751).** A shape-tier deny-list reaches an
internal name one spelling at a time: this one cleared `_n` described in prose, then — a round
later, after a shape was added for that — cleared a verbatim bundle span quoted as `${…}`. Same
class, two escapes. The better question is **provenance over spans**: does this published text
appear verbatim in the artifact being audited? That needs no list and cannot be escaped by
respelling. It also needs a measured false-positive rate first, because a shipped binary is full
of ordinary English.

Two consequences for anyone touching this file. **Widening the identifier shapes to catch more
minified names is not worth doing** — those rotate every release and carry nothing attributable;
they are belt-and-braces against a careless paste, not the control. And a provenance tool is not
automatically safe here either: one that tokenizes before asking provenance never asks about a
span containing no identifier-shaped token, which is a shape dependency hiding inside a
provenance design.

**A `--verify` nobody has watched fail is a green light of unknown wiring.** `capgeom.py
--selftest-negative` is the answer to that for this directory: it mutates a recorded figure in
memory — never the file on disk, so there is no mutant to strand — and asserts `--verify` exits
non-zero for each, plus that the unmutated baseline is still green. A survivor means that figure
is published but unchecked.

**It covers the named mutation set, not literally every figure**, and the difference is not
academic: three line-arm figures were published-but-unchecked until a review looked for them, and
their mutations would have survived silently. The pre-existing `ARMS` and `BEHAVIOURAL` registries
are outside the set too — nudging an `ARMS` width survives, since only `measured` feeds the
reconstruction count. Add a mutation when you add a figure.

## Adding one

Give it a `--verify` (or `--selftest`) mode that re-derives its own published claims and exits
non-zero when one stops following. A tool that only computes is a calculator; a tool that
checks its own back-catalogue is a ratchet, and it will catch the error you were about to make.
`capgeom.py` rejected an entry of its own registry on first run — a bracket end credited to the
wrong kind of position — which is the entire argument for the convention.

Then add a row to the table above.
