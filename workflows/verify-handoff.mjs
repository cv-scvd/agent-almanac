// ---
// name: verify-handoff
// description: Adversarially verify a CONTINUE_HERE draft against a facts file and its sources — traceability, completeness, actionability
// phases: Verify
// ---
//
// verify-handoff — promoted from the 2026-09-02 session scratchpad, where two ad-hoc
// runs of exactly this shape verified the companion and waystation handoffs and
// caught, among other things, a heartbeat claim extrapolated over five unread days,
// a "six phases" count for a seven-phase plan, and a value pin that was a denylist.
//
// A handoff file is a set of claims a fresh session will act on without checking.
// This workflow reads it as such: every number, sha, quoted string and status line
// must trace to a FACTS FILE (each fact naming the command that produced it), to a
// listed SOURCE (the previous edition, a plan, a repo file), or be tagged in the
// draft as inferred / not re-measured / the operator's call. Three lenses run in
// parallel per draft; findings are structured so the author can apply them and
// re-run.
//
// Invoke:
//   Workflow({ name: 'verify-handoff', args: {
//     drafts: [{
//       key: 'companion',                                   // label only
//       draft: '/abs/path/CONTINUE_HERE.draft.md',           // the file under review
//       facts: '/abs/path/handoff-facts.md',                 // command-per-claim fact base
//       sources: ['/abs/path/previous-edition.md', '...'],   // what completeness is measured against
//       context: 'one paragraph: what the file is, who consumes it, what round this is',
//     }],
//     round: 1,                                              // optional; varies labels and prompts on re-runs
//   }})
//
// The facts file is the load-bearing input. Its first lines should say so in its own
// words — the version that worked: "Every line names the command that produced it.
// Anything in a handoff draft that is not traceable to a line here, to the prior
// handoff, or to a repository file is an assertion and must be flagged."
//
// Capability contract: every agent here is read-only (Read tool on the listed files
// only) and is told not to read the working tree, which may be on another branch.
//
// Validating this file: see workflows/_template.mjs — top-level `return` is valid
// Workflow dialect but illegal raw ESM, so use the wrap-then-`node --check` recipe.

export const meta = {
  name: 'verify-handoff',
  description: 'Adversarially verify a CONTINUE_HERE draft against a facts file and its sources — traceability, completeness, actionability',
  phases: [
    { title: 'Verify', detail: 'three lenses per draft, in parallel; drafts pipeline independently' },
  ],
}

const drafts = Array.isArray(args?.drafts) ? args.drafts.filter((d) => d && d.draft && d.facts) : []
const round = Number.isInteger(args?.round) ? args.round : 1

if (!drafts.length) {
  log('verify-handoff: no drafts given. Pass args.drafts = [{ key, draft, facts, sources[], context }].')
  return { error: 'no drafts', usage: 'args.drafts = [{ key, draft, facts, sources: [], context }]' }
}

const LENSES = [
  {
    key: 'traceability',
    prompt: () =>
      'LENS: TRACEABILITY. Every number, date, sha, command output, quoted string and status claim in ' +
      'the draft must be traceable to (a) the facts file, (b) a listed source, or (c) be explicitly marked ' +
      'in the draft as inferred, not re-measured, by-construction, or the operator\'s call. Read the draft ' +
      'line by line. For each claim that is NOT traceable, or that CONTRADICTS a source, report the draft ' +
      'line, the claim, and what the source actually says. Where a command is quoted as having produced ' +
      'an output, check it is the command the facts file records, not a reconstruction. Flag any claim ' +
      'the facts file says must not be asserted. Do not report style.',
  },
  {
    key: 'completeness',
    prompt: (d) =>
      'LENS: COMPLETENESS AGAINST THE SOURCES. If a previous edition of the handoff is among the sources: ' +
      '(1) is every section the draft claims to carry forward actually carried, paragraph by paragraph — ' +
      'report anything dropped or altered, and note that a subsection (e.g. a Links block) may sit inside ' +
      'a carried section and still have been rewritten; (2) did any Next Step or In-Progress item vanish ' +
      'without being marked resolved with evidence; (3) is anything the facts file records that the ' +
      'consuming session would need omitted. If the sources are a plan or spec instead: does the draft ' +
      'misstate any count, phase, definition of done, invariant, or open decision — quote the source where ' +
      'it differs; does it drop anything a bootstrap session needs; does it misdescribe any file it ' +
      'points at. Sources listed: ' + (d.sources || []).join('; '),
  },
  {
    key: 'actionability',
    prompt: () =>
      'LENS: ACTIONABILITY. Apply the write-continue-here test: could a fresh session act on this without ' +
      'asking clarifying questions? Check: the header timestamp/branch/state is specific; all five sections ' +
      '(Objective, Completed, In Progress, Next Steps, Context) exist with real content and no placeholders; ' +
      'Next Steps are numbered, in priority order, each an action (verb + object + where), with user ' +
      'decisions prefixed **[USER]** and defaults-with-override stated as such; every command runs as ' +
      'written from a stated cwd; In Progress describes partial state specifically; Context records failed ' +
      'approaches. Report anything vague, any step that is not an action, any [USER] item buried in a ' +
      'non-[USER] step, any internal contradiction between sections, and anything a fresh session would be ' +
      'tempted to redo because Completed does not make it clearly done.',
  },
]

const SCHEMA = {
  type: 'object',
  required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'location', 'claim', 'basis', 'fix'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'should-fix', 'note'] },
          location: { type: 'string', description: 'draft line number or section' },
          claim: { type: 'string', description: 'what the draft says, quoted' },
          basis: { type: 'string', description: 'what the source says, quoted; say whether verified or inferred' },
          fix: { type: 'string', description: 'the smallest edit that resolves it' },
        },
      },
    },
  },
}

phase('Verify')

const results = await pipeline(
  drafts,
  (d) =>
    parallel(
      LENSES.map((lens) => () =>
        agent(
          `You are adversarially verifying a session-handoff draft (round ${round}). ${d.context || ''}\n\n` +
            'Read ONLY these files (Read tool). Do not edit anything. Do NOT read the repository working ' +
            'tree — it may be checked out on a different branch while you work, so anything read there can ' +
            'be pre-change or unrelated.\n' +
            `- DRAFT under review: ${d.draft}\n` +
            `- FACTS FILE (measurements, each with the command that produced it; read every section): ${d.facts}\n` +
            (d.sources && d.sources.length ? '- SOURCES:\n' + d.sources.map((s) => `  - ${s}`).join('\n') + '\n' : '') +
            '\n' + lens.prompt(d) + '\n\n' +
            'Be concrete: quote the draft, quote the source. Severity: "blocking" only for a false claim a reader ' +
            'would act on, or a dropped section the draft claims to carry; "should-fix" for an untraceable or ' +
            'ambiguous claim or a non-actionable step; "note" for the rest. If the draft is clean under this ' +
            'lens, return an empty findings array and say so in the summary.',
          // Read-only analysis → an ADVISORY agent type, per the capability contract (#285).
          { label: `r${round}:${d.key || 'draft'}:${lens.key}`, phase: 'Verify', agentType: 'Explore', schema: SCHEMA, effort: 'high' },
        ),
      ),
    ).then((vs) => ({
      key: d.key || d.draft,
      lenses: LENSES.map((l, i) => ({
        lens: l.key,
        summary: vs[i] ? vs[i].summary : 'AGENT RETURNED NULL',
        findings: vs[i] ? vs[i].findings : [],
      })),
    })),
)

const out = {}
for (const r of results.filter(Boolean)) {
  out[r.key] = r.lenses
  const n = r.lenses.reduce((a, l) => a + l.findings.length, 0)
  const blocking = r.lenses.reduce((a, l) => a + l.findings.filter((f) => f.severity === 'blocking').length, 0)
  log(`${r.key}: ${n} finding(s) across ${r.lenses.length} lenses, ${blocking} blocking`)
}
return out
