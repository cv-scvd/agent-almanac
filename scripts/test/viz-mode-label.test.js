/**
 * The `bind_modes` annotation must name as many modes as `app.js` actually binds (#639).
 *
 * A PUT annotation is a comment, so nothing derives it and nothing regenerates it — putior
 * reads the comment and copies its label verbatim into `viz/public/data/workflow.mmd`,
 * which the published workflow page fetches at runtime. A stale label is therefore a wrong
 * statement on a published page, produced faithfully by the pipeline.
 *
 * `npm run check:diagram-nodes` is green on exactly this defect **by construction**, and
 * its own header says so with this example: it compares node IDS in both directions and
 * nothing else. `bind_modes` exists on both sides; only its label was wrong. Labels,
 * `node_type`, edges and source-side staleness are all outside what it can see. So the
 * gate that catches this has to be a different gate, and this is it.
 *
 * ## What it asserts, and the limit
 *
 * The COUNT of modes named in the label against the count of bound modes. That is the
 * defect class: a mode is added to `modes` and the label is not extended — which is how
 * Campfire went missing from the moment it was added. It deliberately does NOT check the
 * names: the label renders `workflow` as "Flow" and `2d` as "2D", so a name-level check
 * would need a second mapping to drift out of step with. A rename with no count change
 * still slips through; that is a smaller and quieter defect than an omission, and pinning
 * it would cost a mapping table nobody maintains.
 *
 * `ci-scripts.yml` carries no `paths:` filter (#641), so this test runs on a `viz/`-only
 * PR — which is the whole reason it can live in `scripts/test/` at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_JS = resolve(REPO_ROOT, 'viz', 'js', 'app.js');

/** Modes bound at runtime, from the `modes` map `setActiveMode` switches over. */
export function boundModes(source) {
  const match = source.match(/^const modes = \{(.*?)\};$/m);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((pair) => pair.split(':')[0].trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** Modes named in the `bind_modes` PUT label, from its parenthesised slash-list. */
export function labelledModes(source) {
  const annotation = source.match(/put id:"bind_modes",\s*label:"([^"]*)"/);
  if (!annotation) return null;
  const list = annotation[1].match(/\(([^)]*)\)/);
  if (!list) return null;
  return list[1].split('/').map((name) => name.trim()).filter(Boolean);
}

test('the bind_modes label names as many modes as app.js binds', () => {
  const source = readFileSync(APP_JS, 'utf8');

  const bound = boundModes(source);
  const labelled = labelledModes(source);

  assert.ok(bound, 'the `const modes = { … }` map must be findable — this test is its only reader');
  assert.ok(labelled, 'the bind_modes annotation must carry a parenthesised mode list');
  assert.equal(
    labelled.length,
    bound.length,
    `the label names ${labelled.length} modes (${labelled.join('/')}) but ${bound.length} are `
    + `bound (${bound.join(', ')}). The label is copied verbatim into workflow.mmd and served `
    + `to readers, so this is a wrong statement on a published page — and check:diagram-nodes `
    + `cannot see it, because the node IDs agree and only the label differs (#639).`,
  );
});

test('the parsers fail loudly rather than returning a passing shape', () => {
  // Both helpers return null when they cannot find their subject, so a refactor that moves
  // the modes map or the annotation makes the test go RED rather than silently comparing
  // two empty lists — the vacuous green this repo keeps paying for elsewhere (#486).
  assert.equal(boundModes('nothing here'), null);
  assert.equal(labelledModes('nothing here'), null);
  assert.equal(labelledModes('// put id:"bind_modes", label:"No list here"'), null,
    'a label with no parenthesised list is unparseable, not empty');
  assert.deepEqual(boundModes("const modes = { '2d': a, hive: null };"), ['2d', 'hive']);
  assert.deepEqual(labelledModes('// put id:"bind_modes", label:"Bind mode switching (A/B/C)"'),
    ['A', 'B', 'C']);
});
