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
 * Every `find` string below must match exactly one site; the runner refuses otherwise, because a
 * mutation that silently matches nothing makes the whole envelope pass while proving nothing.
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
    file: 'scripts/check-i18n-fence-parity.js',
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
    find: "find agents teams guides -name '*.md'",
    replace: "find agents teams -name '*.md'",
    expect: "B5's flat find walks",
  },
  {
    label: "B5's SKILL.md find loses the nested tree",
    file: 'scripts/validate-integrity.sh',
    find: "find skills -name 'SKILL.md'",
    replace: "find guides -name 'SKILL.md'",
    expect: "B5's SKILL.md find walks",
  },
  {
    // A10d: the gate must be able to fire on the files it reads. Found by reading the CI job log
    // rather than the check's green — .github/workflows/validate-translations.yml was outside
    // validate-integrity.yml's trigger paths, so a PR editing only it bypassed A10 entirely.
    label: 'the trigger path for a file A10 reads is removed',
    file: '.github/workflows/validate-integrity.yml',
    find: "      - '.github/workflows/validate-translations.yml'\n  workflow_dispatch:",
    replace: '  workflow_dispatch:',
    expect: 'does not run on changes to it',
  },
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
];
