/**
 * Envelope for the generated-artifact inventory gate (#590) — does it go red, and on which class?
 *
 * The gate's whole claim is that `generated-artifacts.yml` cannot silently stop being true. That
 * is a claim about SEVERAL failure modes, not one, so testing a single mutation would prove the
 * gate fires without proving it covers what it advertises. Each case below is a different way the
 * inventory can rot.
 *
 * The gate here is `npm run check:generated-artifacts` — the command CI runs, not the inner
 * script. A mutation that dies against `node scripts/…` but survives the npm indirection is the
 * wiring failure this repo has shipped before.
 *
 * Result at introduction, 2026-08-26:
 *
 *     gate-envelope: 6 killed, 1 survived as documented of 7 case(s).
 *
 * The documented survivor pins the reverse sweep's stated blind spot as a MEASUREMENT rather than
 * a promise: the sweep matches npm scripts named build- / generate- / update-prefixed, so a generator hidden
 * behind a differently-named script is invisible to it and covered only by the forward assertion.
 * `generated-artifacts.yml`'s header says so; this row is the proof, and the day it starts being
 * killed the sweep has widened and the header needs updating.
 *
 *   node scripts/gate-envelope.js --spec scripts/envelopes/generated-artifacts.mjs
 */

export const gate = { command: ['npm', 'run', 'check:generated-artifacts'] };

export const cases = [
  {
    label: 'REVERSE: a new generator behind an npm script named build*',
    // The property #590 asks for in its own words — "a table nobody can add a row to without
    // naming a reader". Someone adds a generator and forgets the inventory.
    file: 'package.json',
    find: '    "build-dreams": "node scripts/build-dreams.js",',
    replace: '    "build-dreams": "node scripts/build-dreams.js",\n'
      + '    "build-unlisted-thing": "node scripts/build-unlisted-thing.js",',
    expect: 'scripts/build-unlisted-thing.js',
  },
  {
    label: 'REVERSE: a new generator invoked only from viz/build.sh',
    // Source 2 of the sweep, and the reason it exists. viz/package.json has NO script for
    // build-wordmark.R or build-terminal-glyphs.js, so an npm-script-only sweep would miss two
    // real generators — one of which feeds cli/lib/glyph-data.json, which ships to npm. Deleting
    // source 2 must therefore be caught, and this row is what catches it.
    file: 'viz/build.sh',
    find: 'node build-terminal-glyphs.js',
    replace: 'node build-terminal-glyphs.js\nnode build-unlisted-viz-thing.js',
    expect: 'viz/build-unlisted-viz-thing.js',
  },
  {
    label: 'FORWARD: an artifact path that no longer matches anything tracked',
    // The artifact moved or was deleted and the row still claims it. Silent otherwise: nothing
    // else in the repo reads this file's paths.
    file: 'generated-artifacts.yml',
    find: '    paths: [dreams/atlas.html]',
    replace: '    paths: [dreams/atlas-renamed.html]',
    expect: 'matches no tracked file',
  },
  {
    label: 'FORWARD: a named generator that does not exist',
    file: 'generated-artifacts.yml',
    find: '    generator: scripts/build-dreams.js',
    replace: '    generator: scripts/build-dreams-renamed.js',
    expect: 'does not exist',
  },
  {
    label: 'FORWARD: a gate the row claims but its workflow no longer runs',
    // The rot this repo has actually shipped: a gate is renamed or dropped and the documentation
    // asserting it stays behind. Same shape as debt-ratchet's advisory-gate forward assertion.
    file: 'generated-artifacts.yml',
    find: '      command: npm run check-dreams',
    replace: '      command: npm run check-dreams-renamed',
    expect: 'does not appear in',
  },
  {
    label: 'FORWARD: an unread edge that does not say what being unread costs',
    // `gate.kind: none` is a legitimate answer — #590 says "the decision not to have one is
    // recorded with its reason". This makes the reason mandatory rather than customary, so a row
    // cannot be downgraded to unread by deleting one line.
    file: 'generated-artifacts.yml',
    find: '    ships_to_npm: true\n    unread_edge:',
    replace: '    ships_to_npm: true\n    unread_edge_removed:',
    expect: 'no `unread_edge` explains',
  },
  {
    label: 'DOCUMENTED LIMIT: a generator behind a script named neither build- / generate- / update-prefixed',
    // Survivor by construction, and the honest boundary of the design. The sweep keys on script
    // NAME, so `postprocess-something` running a generator is invisible to it. This is stated in
    // generated-artifacts.yml's header as the `token: none` analogue; the row makes it a measured
    // fact rather than a claim. If this ever starts being killed, the sweep widened — update the
    // header, do not delete this case.
    file: 'package.json',
    find: '    "build-dreams": "node scripts/build-dreams.js",',
    replace: '    "build-dreams": "node scripts/build-dreams.js",\n'
      + '    "postprocess-thing": "node scripts/postprocess-thing.js",',
    expect: null,
    why: 'the reverse sweep matches script NAMES; a generator behind an unmatched name is '
      + 'covered only by the forward assertion, exactly as debt-ratchet.yml marks `token: none`.',
  },
];
