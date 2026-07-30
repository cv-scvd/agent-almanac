# DRAFT — Feature request for `nvidia/skills` (NOT POSTED)

> **Status: draft, unposted.** Re-drafted 2026-07-29 from the merged gap analysis
> ([`nvidia-skills-gap-analysis.md`](nvidia-skills-gap-analysis.md) §5, PR #422).
> The original draft lived only in a session scratchpad and was lost when the
> scratchpad was wiped; this copy is tracked in-repo so that cannot recur.
>
> **Do not post without the maintainer's decision.** Post target would be
> `github.com/nvidia/skills` → new Issue (feature request).

## Why an issue and not a PR

A direct skill contribution into `nvidia/skills` is not open to us. Verified
2026-07-24 against that repo's `CONTRIBUTING.md`, `PULL_REQUEST_TEMPLATE.md` and
`external-contributors.yml`:

- catalog onboarding requires the **source repo live under an NVIDIA-owned GitHub
  org** — a `pjt222/` repo does not qualify;
- each skill needs a **maintainer-run internal IP review**;
- contributions require **DCO sign-off**.

So the only available "enhance the catalog" path is a feature-request issue
proposing that NVIDIA author the missing rung themselves. Everything below is a
proposal about *their* catalog; it asks nothing of our repos and transfers no code.

---

## Draft issue body

**Title:** `[Feature request] tilegym: a descent bridge from an autotuned cuTile kernel to hand-tuned SASS`

### Summary

The TileGym/cuTile family is, as far as I can tell, the only kernel-*authoring*
family in the catalog, and its skills stop cleanly at the cuTile IR. Every
conversion seam I can find goes **sideways** — `converting-cutile-to-triton`,
`converting-cutile-to-julia` — and `tilegym-improve-cutile-kernel-perf` explicitly
notes that cuTile does not drop to PTX.

Meanwhile `references/ir-dump-guide.md` in that same skill already teaches agents to
read SASS diagnostically (`cuobjdump --dump-sass`, MUFU counts, spotting an
`STG.E.128` that regressed to `STG.E.U16`), including on sm_120.

So the catalog reads SASS to decide *what cuTile config to change*, but there is no
skill for the case where the answer is "the tile DSL cannot express this." I would
like to request a skill that closes that last rung.

### The gap, concretely

Reading the catalog as an abstraction ladder:

| Rung | Layer | Covered by |
|---:|---|---|
| 6 | Framework config | MBridge, Dynamo, DeepStream, Omniverse |
| 5 | GPU library API | cuDF, cuOpt, cuPyNumeric, DALI |
| 4 | Tile DSL (auto TC/TMA) | **TileGym / cuTile** |
| 3 | PTX / inline asm | — |
| 2 | SASS **read** / diagnose | `tilegym-improve-cutile-kernel-perf` (`ir-dump-guide.md`) |
| 1 | SASS/cubin **author** + byte-patch | — **nothing** |

Rung 2 is covered. Rung 1 is empty. The asymmetry is what makes the request
concrete: an agent following `ir-dump-guide.md` can already tell you the generated
SASS is wrong, and then has nowhere to go except back up to rung 4 and guess again.

### What the skill would do

A two-stage handoff, with the cuTile autotuner as the upstream generator:

1. **Generate** — `tilegym-cutile-autotuning` produces a near-optimal tile
   size/occupancy/TMA configuration for the target shape, plus a cubin and an
   upper-bound reference number.
2. **Descend** — for the residual the tile DSL cannot express, hand-edit the cubin:
   instruction scheduling, control-word/stall packing, scoreboard allocation,
   and per-arch tensor-core issue tuning (on Ampere, e.g. `HMMA.16816` stall
   counts, `IMMA` S04→S02).

`ir-dump-guide.md` is already the natural handoff point — it is the last artifact
that both stages agree on.

### Why this is worth NVIDIA's time rather than a third party's

Rung 1 is the rung where being the vendor matters most:

- **Correctness is unforgiving and undocumented.** A wrong stall count in a control
  word is not a slow kernel — it is a silently wrong result or a hung GPU. There is
  no public authoritative encoding reference for the control fields; the community
  works from reverse-engineered tables that go stale every architecture.
- **The knowledge is per-architecture and expires.** A skill authored against
  reverse-engineered sm_86 tables cannot be trusted on sm_90/sm_120. NVIDIA is the
  only party who can write it once and keep it true across a generation.
- **It protects the rung above it.** Right now, an agent that finds a cuTile ceiling
  has no sanctioned next step, so it either stops or improvises unsafely. A
  documented descent path keeps that traffic inside the catalog's trust contract
  (skill-card, evals, SkillSpector, OMS signing) instead of outside it.

### Scope suggestions

Keeping it deliberately narrow, since the risk profile is unusual for the catalog:

- **In scope:** read/index/patch a cubin in place; encode control words for one named
  architecture; verify a round-trip is byte-identical before and after a no-op patch;
  re-run the `ir-dump-guide` checks against the patched binary; a measured
  before/after against the autotuned baseline.
- **Out of scope (please):** cross-architecture SASS translation (Ampere→Hopper etc.)
  — the value here is precisely that it is last-mile and arch-specific; a
  translation seam would inherit the staleness problem that motivates the request.
- **Natural evals:** the round-trip byte-identity check is a clean pass/fail, and the
  negative case ("the tile DSL *can* express this — do not descend") is an unusually
  well-defined `expected_skill: null` scenario.

### Where this comes from

I maintain a single-GPU, deliberately library-free CUDA/SASS project (GA104 sm_86,
laptop RTX 3070 Ti) where hand-editing cubins is the normal last step, and I recently
gap-analysed the `nvidia/skills` catalog against my own skill set. The ladder above is
the summary of that analysis. Every other rung I looked at was covered by NVIDIA at
least as well as by anything I have; this was the one place where the catalog stops
short of its own diagnostic tooling.

Happy to share concrete failure cases (control-word encodings, scoreboard hazards,
the round-trip verification approach) if that would be useful input — though I
understand the catalog's IP-review and org-ownership requirements mean the authoring
itself would need to be NVIDIA-side.

---

## Notes for the maintainer (not part of the issue body)

- **Tone check:** written as a user request about NVIDIA's catalog, not as a pitch for
  our skills. No claim of ownership, no ask for reciprocal adoption, no link back to
  our repos. That is deliberate — the org-ownership rule makes any "adopt our work"
  framing a dead end, and the request stands on its own merits without it.
- **What we do NOT disclose:** no cuasmR internals, no control-code tables, no
  measured numbers from our repo. The offer at the end is an offer to discuss, not a
  disclosure. If posting, keep it that way.
- **If posted, record it:** add the issue URL to
  [`nvidia-skills-gap-analysis.md`](nvidia-skills-gap-analysis.md) §5 so the report and
  the request stay linked.
- **Related work in this repo:** epic #421 (package the bare-metal SASS domain as
  `gpu-optimization` skills) and epic #429 (borrow NVIDIA governance controls) are the
  inward-facing half of the same analysis and are independent of whether this is ever
  posted.
