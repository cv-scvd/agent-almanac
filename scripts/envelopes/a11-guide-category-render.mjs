/**
 * Envelope for integrity checks A11 and A12 — guide category render coverage (#644).
 *
 * A11 exists because `check-readmes` cannot own this assertion. That gate regenerates with the
 * generator's own category ordering and diffs the result against the file, so generator and
 * check agreed perfectly about a category neither rendered: the `investigation` guide was
 * absent from every generated index while `npm run check-readmes` exited 0. A gate that
 * consults the same source as its subject measures nothing.
 *
 * So A11 compares the OTHER side — the registry's guide entries — against the rendered
 * `guides/README.md`. This is the committed record of which of that claim actually fires:
 *
 *   npm run gate-envelope -- --spec scripts/envelopes/a11-guide-category-render.mjs
 *
 * Result on the first run, 2026-08-18, against A11's first version:
 *
 *     gate-envelope: 3 killed, 1 survived as documented of 5 case(s).
 *     [WRONG-RED] the A11 extraction pattern drifts and matches nothing
 *
 * That row was a real defect in A11, not a mis-specified case, and it is the reason the
 * third case exists. Under `set -euo pipefail` the bare `a11_cats=$(grep ... | ...)`
 * assignment aborted the whole script the moment grep matched nothing: red, but with no
 * diagnostic, with A11's zero-check dead, and with A12 and all of categories B and C never
 * reached. A `|| true` on the extraction fixed it. Re-measured after that fix:
 *
 *     gate-envelope: 4 killed, 1 survived as documented of 5 case(s).
 *
 * Note the first case. It is not a synthetic break — it restores `guides/README.md` to the
 * exact state `main` was in before this PR, which is what makes it evidence that A11 would
 * have caught #644 rather than merely that A11 can go red.
 *
 * The `expect: null` case at the end pins A11's scope boundary as a measurement rather than
 * a prose claim: A11 is a CATEGORY-level assertion and does not notice a single guide missing
 * from a rendered category. That case is genuinely covered — by `check-readmes`, which
 * regenerates the file — and this envelope's gate is `validate-integrity.sh`, so it correctly
 * reports green here. If it ever starts being killed, A11's scope grew and this comment is
 * the thing that went stale.
 */

export const gate = { command: ['bash', 'scripts/validate-integrity.sh'] };

export const cases = [
  {
    // The #644 defect itself, restored byte-for-byte: the section the four-category literal
    // omitted. The registry still declares and uses `investigation`; the index no longer
    // renders it. This is the state every gate in the repo passed on.
    label: 'the pre-#644 state — the investigation section absent from the rendered index',
    file: 'guides/README.md',
    find: `
## Investigation

*Methodology guides for legitimate research, audit, and reverse-engineering of integration surfaces*

### [Reverse-Engineering a CLI Harness](reverse-engineering-a-cli-harness.md)
Five-phase methodology for legitimate integration research against a closed-source CLI harness — baseline, flag discovery, dark-launch detection, wire capture, redaction discipline.`,
    replace: '',
    expect: "guide category 'investigation' has no '## Investigation' heading",
  },
  {
    // The likelier drift than #644, and the reason A11 reads the guides' own `category:`
    // fields rather than the `categories:` block keys: a value no category block declares
    // still renders (the helper appends it), so the index and the registry disagree about a
    // heading name. A block-keyed rule would not see this at all.
    label: "a guide's category is typo'd, so it renders under a heading nothing declares",
    file: 'guides/_registry.yml',
    find: '    category: investigation',
    replace: '    category: investigatoin',
    expect: "guide category 'investigatoin' has no '## Investigatoin' heading",
  },
  {
    // The vacuous pass this check exists to prevent. A drifted extraction pattern yields an
    // empty category list, and an empty list satisfies a for-loop trivially — every category
    // would go unchecked while the run stayed green. A11 reports FAIL on zero instead.
    label: 'the A11 extraction pattern drifts and matches nothing',
    file: 'scripts/validate-integrity.sh',
    find: "grep -E '^    category: ' guides/_registry.yml",
    replace: "grep -E '^    categoree: ' guides/_registry.yml",
    expect: 'A11 extracted 0 guide categories',
  },
  {
    // A12: the total no validator compared to disk before #644. `total_skills` is checked by
    // validate-skills.yml, agents and teams by A4/A5, guides by nothing.
    label: 'total_guides drifts from the guides on disk',
    file: 'guides/_registry.yml',
    find: 'total_guides: 35',
    replace: 'total_guides: 36',
    expect: 'guides disk=35 registry=36',
  },
  {
    // A11's scope boundary, measured. The guide's category heading survives, so A11 is
    // satisfied and SHOULD be: it asserts that every category reaches the index, not that
    // every guide does. `check-readmes` owns the per-guide claim and does catch this — it is
    // simply a different gate than the one this envelope runs.
    label: 'a single guide dropped from a category that still has other guides',
    file: 'guides/README.md',
    find: `### [Agent Memory Hygiene](agent-memory-hygiene.md)
Three-layer model — weights, retrieval, behavior — for diagnosing what kind of forgetting a memory problem actually needs and applying the right tool.`,
    replace: '',
    expect: null,
    why: 'A11 is category-level by design; the per-guide claim belongs to check-readmes, which regenerates the file.',
  },
];
