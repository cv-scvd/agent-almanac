/**
 * Envelope for integrity check A10 — content-type literals outside JavaScript (#585).
 *
 * A10 asserts eight non-JavaScript content-type lists against `scripts/lib/content-types.js`.
 * This is the committed record of which of those assertions actually fire, produced by breaking
 * each one and watching the gate. Run it after touching A10, `content-types.js`, `NESTING`, or
 * any of the sites A10 reads:
 *
 *   npm run gate-envelope -- --spec scripts/envelopes/a10-content-type-literals.mjs
 *
 * Every `find` string below must match exactly the number of sites the case declares (`sites`,
 * default 1); the runner refuses otherwise, because a mutation that silently matches nothing
 * makes the whole envelope pass while proving nothing. Two cases here needed re-anchoring after
 * A10's own comments began quoting the commands they guard, creating a second match site — the
 * runner caught that rather than mutating an arbitrary one.
 *
 * Note the `expect: null` case at the end. It is not a failure — it is A10's one documented
 * non-guarantee, measured rather than asserted in prose.
 */

export const gate = { command: ['bash', 'scripts/validate-integrity.sh'] };

export const cases = [
  {
    label: 'a fifth tree added to the SSOT',
    file: 'scripts/lib/content-types.js',
    find: "Object.freeze(['skills', 'agents', 'teams', 'guides'])",
    replace: "Object.freeze(['skills', 'agents', 'teams', 'guides', 'workflows'])",
    expect: 'but CONTENT_TYPES is',
  },
  {
    // The parse dying must FAIL, never pass quietly with an empty list — every site downstream
    // would otherwise go unchecked while the run stayed green.
    label: 'the SSOT parse breaks (const renamed)',
    file: 'scripts/lib/content-types.js',
    find: 'export const CONTENT_TYPES = Object.freeze',
    replace: 'export const CONTENT_TYPES_RENAMED = Object.freeze',
    expect: 'could not parse CONTENT_TYPES',
  },
  {
    // NESTING parsing to something non-empty that the SSOT does not contain. `skills: 1` would
    // instead yield an EMPTY list, caught one guard earlier by a different message — which is
    // how this case was mis-specified on its first writing.
    label: 'NESTING names a tree the SSOT does not have',
    // File corrected 2026-08-18: `NESTING` moved to scripts/lib/i18n-targets.js in #552
    // (9ad1b4019), and this case kept naming its old home. It has been silently INCONCLUSIVE
    // ever since — pre-existing rot, found only by running the envelope while working on #641.
    // The envelope is deliberately not in CI, which is exactly how a fixture rots unnoticed;
    // the count guard is what turns that rot into a visible refusal rather than a false pass.
    file: 'scripts/lib/i18n-targets.js',
    find: 'const NESTING = { skills: true, agents: false, teams: false, guides: false };',
    replace: 'const NESTING = { workflows: true, agents: false, teams: false, guides: false };',
    expect: 'derived no nested trees',
  },
  {
    label: 'a tree dropped from the full loop in validate-integrity.sh',
    file: 'scripts/validate-integrity.sh',
    find: 'for content_type in skills agents teams guides; do',
    replace: 'for content_type in skills agents teams; do',
    expect: 'must be full',
  },
  {
    label: 'a tree dropped from the full loop in the CI workflow',
    file: '.github/workflows/validate-translations.yml',
    find: 'for content_type in skills agents teams guides; do',
    replace: 'for content_type in skills agents teams; do',
    expect: 'must be full',
  },
  {
    // The case an "at least one full loop" rule let through: one loop degrades to the EXACT flat
    // form while another full loop survives, so a >=1 counter stays satisfied. This is why the
    // per-site rule exists.
    label: 'one full loop degrades to the exact flat form',
    file: '.github/workflows/validate-translations.yml',
    find: 'for content_type in skills agents teams guides; do',
    replace: 'for content_type in agents teams guides; do',
    expect: 'must be full',
  },
  {
    // The reverse direction, so the rule is two-sided rather than a rubber stamp that only ever
    // demands more trees.
    label: 'a loop keeps the full list after losing its nested branch',
    file: '.github/workflows/validate-translations.yml',
    find: 'if [ "$content_type" = "skills" ]; then',
    replace: 'if [ "$content_type" = "nothing" ]; then',
    expect: 'must be flat',
  },
  {
    label: "a case arm removed from the scaffolder's accept-rule",
    file: 'scripts/translate-content.sh',
    find: '  guides)\n    SOURCE_FILE="$ROOT/guides/$ID.md"',
    replace: '  guidez)\n    SOURCE_FILE="$ROOT/guides/$ID.md"',
    expect: 'case arms (the accept-rule)',
  },
  {
    label: 'the unknown-type message drifts from the accept-rule',
    file: 'scripts/translate-content.sh',
    find: 'Use: skills, agents, teams, guides',
    replace: 'Use: skills, agents, teams',
    expect: 'unknown-type message',
  },
  {
    // Per-FILE, not global: a pattern still matching the other file would otherwise satisfy a
    // global guard while this file went entirely unread.
    label: 'the loop pattern drifts in one file so that file is unread',
    file: 'scripts/validate-integrity.sh',
    find: 'for content_type in skills agents teams guides; do',
    replace: 'for ctype in skills agents teams guides; do',
    expect: "no 'for content_type in' loop in scripts/validate-integrity.sh",
  },
  {
    // B5's reference corpus: the same flat/nested split in a different shape, missed by #585's
    // inventory and by A10's first version.
    label: "B5's flat find drops a tree",
    file: 'scripts/validate-integrity.sh',
    // `-not` is in the command and not in A10's comment quoting it, which is what makes this
    // unique — the comment created a second match site and the runner refused to guess.
    find: "find agents teams guides -name '*.md' -not",
    replace: "find agents teams -name '*.md' -not",
    expect: "B5's flat find walks",
  },
  {
    label: "B5's SKILL.md find loses the nested tree",
    file: 'scripts/validate-integrity.sh',
    find: "find skills -name 'SKILL.md' -exec",
    replace: "find guides -name 'SKILL.md' -exec",
    expect: "B5's SKILL.md find walks",
  },
  // REMOVED 2026-08-18 (#641): 'the trigger path for a file A10 reads is removed'.
  // The property it measured no longer exists — validate-integrity.yml lost its paths filter so
  // the job could become a required status check, leaving no per-input path entry to delete.
  // A10d's successor property (an ABSENT filter reads as universal, a broken or empty one does
  // NOT) is covered by the two A10d cases at the end of this file. Recorded as a removal rather
  // than deleted quietly: a case that vanishes looks identical in the tally to one that never
  // existed, and this file's whole job is to be readable as a record.
  {
    // THE DOCUMENTED LIMIT, measured rather than asserted. Co-deletion removes the loop's nested
    // branch AND its list entry in one edit, leaving a well-formed flat loop with no signal in
    // the file that it ever handled the nested tree. The per-site rule cannot see it by
    // construction; the loop-only counter catches only TOTAL degradation, and here
    // validate-integrity.sh's full loop survives. Distinguishing "deliberately stopped handling
    // skills" from "accidentally stopped" needs a human-declared expectation.
    label: 'PARTIAL co-deletion of a loop branch and its tree',
    file: '.github/workflows/validate-translations.yml',
    find: [
      '          for content_type in skills agents teams guides; do',
      '            for locale_dir in i18n/*/"$content_type"/; do',
      '              [ ! -d "$locale_dir" ] && continue',
      '              locale=$(basename "$(dirname "$locale_dir")")',
      '              if [ "$content_type" = "skills" ]; then',
    ].join('\n'),
    replace: [
      '          for content_type in agents teams guides; do',
      '            for locale_dir in i18n/*/"$content_type"/; do',
      '              [ ! -d "$locale_dir" ] && continue',
      '              locale=$(basename "$(dirname "$locale_dir")")',
      '              if [ "$content_type" = "nope" ]; then',
    ].join('\n'),
    expect: null,
    why: "A10's one non-guarantee: co-deletion erases the signal the per-site rule keys on, and one full loop still remains so the counter is satisfied.",
  },
  {
    // A10d's THREE-state reader (#641). #641 removed this workflow's paths filter so the job
    // could become a required status check, and taught A10d that an absent filter means
    // universal coverage. The danger in that teaching is folding a BROKEN parse into the same
    // "universal" verdict — a drifted pattern would then report the strongest possible coverage
    // while having read nothing, which is the vacuous pass this whole file exists to measure.
    //
    // Here the `paths:` key is present and yields zero entries. That is state 2, and it must
    // FAIL rather than be mistaken for state "no filter at all".
    label: 'A10d: a paths: key that yields no entries is NOT universal coverage',
    file: '.github/workflows/validate-integrity.yml',
    find: '  pull_request:\n  workflow_dispatch:',
    replace: '  pull_request:\n    paths:\n  workflow_dispatch:',
    expect: 'trigger coverage UNCHECKED',
  },
  {
    // The other failure state: no pull_request block at all. Distinct from an empty filter and
    // from no filter, and equally must not read as universal.
    label: 'A10d: a missing pull_request block is NOT universal coverage',
    file: '.github/workflows/validate-integrity.yml',
    find: '  pull_request:\n  workflow_dispatch:',
    replace: '  workflow_dispatch:',
    expect: 'trigger coverage UNCHECKED',
  },
];
