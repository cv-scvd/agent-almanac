---
name: write-continue-here
description: >
  Write a CONTINUE_HERE.md file capturing current session state so a fresh
  Claude Code session can pick up where this one left off. Covers assessing
  recent work, structuring the continuation file with objective, completed,
  in-progress, next-steps, and context sections, and verifying the file is
  actionable. Use when ending a session with unfinished work, handing off
  context between sessions, or preserving task state that git alone cannot
  capture.
license: MIT
allowed-tools: Read Write Bash Grep Glob
metadata:
  author: Philipp Thoss
  version: "1.1"
  domain: general
  complexity: basic
  language: multi
  tags: session, continuity, handoff, context, workflow, write
---

# Write Continue Here

Write a structured continuation file so the next session starts with full context.

## When to Use

- Ending a session with work still in progress
- Handing off a complex task between sessions
- Preserving intent, failed approaches, and next steps that git cannot capture
- Before closing Claude Code when mid-task

## Inputs

- **Required**: An active session with recent work to summarize
- **Optional**: Specific instructions about what to emphasize in the handoff

## Procedure

### Step 1: Assess Session State

Gather facts about recent work:

```bash
git log --oneline -5
git status
git diff --stat
```

Review the conversation context: what was the objective, what was completed, what is partially done, what was tried and failed, what decisions were made.

Record every measurement you will cite in a **facts file** (`handoff-facts.md`, outside the repository or ignored by it): one line per fact, each naming the command that produced it and quoting its output verbatim — the range you actually read, not the range you meant. A claim in the handoff that traces to no line here is an assertion; an output paraphrased here is an extrapolation the verifier cannot see.

**Expected:** Clear understanding of current task state — completed items, in-progress items, and planned next steps — and a facts file behind every number, sha, quoted output and status line you intend to write.

**On failure:** If not in a git repository, skip git commands. The continuation file can still capture conversational context and task state.

### Step 2: Write CONTINUE_HERE.md

Write the file as `CONTINUE_HERE.draft.md` at the project root — it becomes `CONTINUE_HERE.md` only after Step 3 — using the structure below. Every section must contain actionable content, not placeholders. Where a claim is not measured, tag it in place as `inferred`, `not re-measured`, `by-construction`, or `the operator's call`; a tag is allowed only where the facts file records why the measurement was not taken, and never on a sha, count, or status line a reader would act on.

```markdown
# Continue Here

> Last updated: YYYY-MM-DDTHH:MM:SSZ | Branch: current-branch-name

## Objective
One-paragraph description of what we are trying to accomplish and why.

## Completed
- [x] Finished item with key file paths (e.g., `src/feature.R`)
- [x] Decisions made and their rationale

## In Progress
- [ ] Partially complete work — describe current state (branch, file:line)
- [ ] Known issues with partial work

## Next Steps
1. Immediate next action (most important)
2. Subsequent actions in priority order
3. **[USER]** Items needing user input or decision

## Context
- Failed approaches and why they did not work
- Key constraints or trade-offs discovered
- Relevant issue/PR links
```

Guidelines:
- **Objective**: Capture the WHY — git log shows what changed, not why
- **Completed**: Mark items clearly done to prevent re-work
- **In Progress**: This is the highest-value section — partial state is hardest to reconstruct
- **Next Steps**: Number by priority. Prefix user-dependent items with `**[USER]**`
- **Context**: Record negative space — what was tried and rejected, and why

**Expected:** A CONTINUE_HERE.md file at the project root with all 5 sections populated with real content from the current session. The timestamp and branch are accurate.

**On failure:** If Write fails, check file permissions. The file should be created in the project root (same directory as `.git/`). Verify `.gitignore` contains `CONTINUE_HERE.md` — if not, add it.

### Step 3: Verify the Draft, Then Install It

Read back `CONTINUE_HERE.draft.md` and confirm:
- Timestamp is current (within the last few minutes)
- Branch name matches `git branch --show-current`
- All 5 sections contain real content (no template placeholders)
- Next Steps are numbered and actionable
- In Progress items describe current state specifically enough to resume

Then verify it adversarially. Copy `workflows/verify-handoff.mjs` from agent-almanac into `.claude/workflows/` (workflows are not auto-installed) and run:

```js
Workflow({ name: 'verify-handoff', args: { drafts: [{
  key: 'this-repo',
  draft: '/abs/path/CONTINUE_HERE.draft.md',
  facts: '/abs/path/handoff-facts.md',
  sources: ['/abs/path/previous CONTINUE_HERE.md if one survives, or the plan the work follows'],
  context: 'what the file is, who consumes it, which repositories the agents must not read',
}], round: 1 } })
```

Apply its findings, pass the round's findings file among `sources`, and re-run with the next `round` until the run reports **0 blocking** findings. Only then install: `mv CONTINUE_HERE.draft.md CONTINUE_HERE.md`. If the workflow is not available, say so in the file's header rather than skipping the step silently.

**Expected:** The installed file reads as a clear, actionable handoff that a fresh session could use to immediately resume work, and every claim in it survived a verifier that could see the facts file.

**On failure:** Edit sections that contain placeholder text or are too vague. Each section should pass the test: "Could a fresh session act on this without asking clarifying questions?" A verifier finding you disagree with is answered in the file (tag the claim, cite the fact), never by deleting the finding.

## Validation

- [ ] CONTINUE_HERE.md exists at the project root
- [ ] File contains all 5 sections with real content (not placeholders)
- [ ] Timestamp and branch are accurate
- [ ] `.gitignore` includes `CONTINUE_HERE.md`
- [ ] Next Steps are numbered and actionable
- [ ] In Progress items specify enough detail to resume without questions
- [ ] Every number, sha, quoted output and status claim traces to a line of the facts file from Step 1 that names the command which produced it, or is tagged in place as `inferred`, `not re-measured`, `by-construction`, or `the operator's call` — and no sha, count, or status line a reader would act on carries a tag
- [ ] The draft was verified adversarially in Step 3 (`verify-handoff`, traceability + completeness + actionability, against the facts file and the previous edition if one survives, else the plan) and the last run reported 0 blocking findings before the draft was renamed to `CONTINUE_HERE.md`

## Common Pitfalls

- **Writing placeholders instead of content**: "TODO: fill in later" defeats the purpose. Every section must contain real information from the current session.
- **Duplicating git state**: Do not list every file changed — git already tracks that. Focus on intent, partial state, and next steps.
- **Forgetting the Context section**: Failed approaches are the most valuable thing to record. Without them, the next session will retry the same dead ends.
- **Overwriting without reading**: If CONTINUE_HERE.md already exists from a prior session, read it first — it may contain unfinished work from an earlier handoff.
- **Leaving stale files**: CONTINUE_HERE.md is ephemeral. After the next session consumes it, delete it. Stale files cause confusion.
- **Extrapolating a measurement**: "every run since the 20th" written from a `tail -6` that showed three days is an assertion, not a measurement. Quote the command that ran, and if the claim needs more days, read them. The verification workflow flags this only when the facts file records the command that actually ran — paste real output, never a paraphrased range.
- **Claiming a section is unchanged when part of it was regenerated**: a section can be byte-identical through its last paragraph and still contain a subsection rewritten today. Scope the claim to what you compared.
- **Pinning the absence of the last bad value**: a status line that says "not X" passes when the value drifts to Y. State the value.

## Related Skills

- `read-continue-here` — the complement: reading and acting on the continuation file at session start
- `bootstrap-agent-identity` — cold-start identity reconstruction that consumes the continuation file this skill produces
- `manage-memory` — durable cross-session knowledge (complements this ephemeral handoff)
- `commit-changes` — save work to git before writing the continuation file
- `write-claude-md` — project instructions where optional continuity guidance lives
- `coordinate-peer-sessions` — a peer sharing this worktree may consume the same `CONTINUE_HERE.md`; that skill is where a path-scope declaration belongs so the two sessions do not both act on it
