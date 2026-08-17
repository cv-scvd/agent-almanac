/**
 * Envelope for the debt ratchet (#591) — what does it actually enforce, at corpus scale?
 *
 * `scripts/test/debt-ratchet.test.js` proves the behaviour against throwaway fixtures. This
 * proves the WIRING: the gate here is `npm run ratchet`, the exact command
 * `.github/workflows/validate-skills.yml` runs, so a mutation that dies against the inner script
 * but survives the npm indirection cannot pass unnoticed. Every case mutates a real translation
 * or the real ratchet file, against the real 3,644-file corpus.
 *
 * Each run takes about two and a half minutes on a WSL/NTFS checkout (the fence gate walks every
 * English revision, and git object reads cross a filesystem boundary there), so the whole envelope
 * is roughly fifteen. On a native filesystem it is seconds — the same walk finishes in under a
 * second on the GitHub runner. This is a local tool either way; the number is here so nobody
 * mistakes a long run for a hang.
 *
 * Result at introduction, 2026-08-17, after an adversarial review added the inventory case:
 *
 *     gate-envelope: 3 killed, 1 survived as documented of 4 case(s).
 *
 * The documented survivor is the important row. It is the ratchet's scope boundary, measured
 * rather than asserted: adding a body divergence — the #477 class — leaves the ratchet green on
 * purpose, because that class is unratcheted and #591 forbids ratcheting members nobody has read.
 * If it ever starts being killed, either the scope changed or something is enforcing a count it
 * should not be.
 *
 *   node scripts/gate-envelope.js --spec scripts/envelopes/debt-ratchet.mjs
 */

export const gate = { command: ['npm', 'run', 'ratchet'] };

const TARGET = 'i18n/de/skills/create-dockerfile/SKILL.md';

export const cases = [
  {
    label: 'ADDED DEBT: a frozen fence retagged to text in a file no member list names',
    // The #481 escape, introduced into a clean file. The fence gate itself is warn-only in CI, so
    // it would report this and exit 0; the ratchet is the only thing that turns it red. The body
    // is untouched and already matched English, so nothing but the tag sequence moves.
    file: TARGET,
    find: '```bash',
    replace: '```text',
    expect: `added debt — ${TARGET} [tag-sequence]`,
  },
  {
    label: 'STALE MEMBER: a member listed that the gate no longer reports',
    // The direction a `observed <= declared` ratchet misses entirely. #591 requires the file to
    // move in the same commit as the repair, so a listed-but-absent member must fail rather than
    // quietly pass — otherwise a repaired member leaves a permanent free slot behind it.
    file: 'debt-ratchet.yml',
    find: '      - { file: i18n/es/skills/harden-github-repo-security/SKILL.md, kind: tag-drift }',
    replace: [
      '      - { file: i18n/es/skills/harden-github-repo-security/SKILL.md, kind: tag-drift }',
      `      - { file: ${TARGET}, kind: tag-drift }`,
    ].join('\n'),
    expect: `stale member — ${TARGET} [tag-drift]`,
  },
  {
    label: 'INVENTORY: deleting an entry whose command another entry also carries',
    // The reverse sweep matched on the command alone until a review caught it, and this is the
    // live case that exposed it: two entries carry `check-translation-freshness.js --warn` and
    // differ only in their workflow, so under command-only matching the surviving entry "covered"
    // the deleted one's line and the sweep stayed green. Deleting an inventory entry has to be
    // visible, or the inventory decays silently, which is the failure it exists to prevent.
    file: 'debt-ratchet.yml',
    find: [
      '  - id: translation-freshness-translations',
      '    workflow: .github/workflows/validate-translations.yml',
      '    command: node scripts/check-translation-freshness.js --warn',
      '    token: "--warn"',
      '    exit: unnamed — "#625"',
      '    ratcheted: false',
      '',
    ].join('\n'),
    replace: '',
    expect: '.github/workflows/validate-translations.yml runs a warn-only step',
  },
  {
    label: 'DOCUMENTED LIMIT: a new body divergence does NOT move the ratchet',
    // `EXPOSE 3000` -> `EXPOSE 3001` inside a frozen ```dockerfile fence. The gate reports a new
    // gated violation (and a stale-basis-claim, since this file carries fence_basis_commit), and
    // the ratchet stays green — both kinds are listed under `unratcheted` in debt-ratchet.yml.
    file: TARGET,
    find: 'EXPOSE 3000',
    replace: 'EXPOSE 3001',
    expect: null,
    why: 'the #477 divergence class is deliberately unratcheted — its members have not been read, and forcing payment on unread debt is worse than warn-only. #477 flipping the gate to blocking is what covers it.',
  },
];
