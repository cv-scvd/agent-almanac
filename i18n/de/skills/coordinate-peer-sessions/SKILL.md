---
name: coordinate-peer-sessions
description: >
  Coordinate safely with a peer interactive session sharing the same git
  worktree — establish whether one is present, declare path scope before the
  first edit, survive a contended index lock, and review the whole branch
  before opening a PR. Activate when starting work in a repository that may
  already be occupied, when a git command fails with `index.lock: File exists`,
  when `guard:snapshot` refuses because a snapshot already exists, or when a
  commit turns out to contain a file this session never edited. Distinct from
  subagent concurrency: a peer session cannot be bracketed, because no baseline
  exists from before its edits.
license: MIT
allowed-tools: Read Bash Grep Glob
metadata:
  author: Philipp Thoss
  version: "1.0"
  domain: git
  complexity: intermediate
  language: multi
  tags: git, coordination, worktree, concurrency, safety
  locale: de
  source_locale: en
  source_commit: 01c46053b
  fence_basis_commit: 01c46053b
  translator: "Claude + human review"
  translation_date: "2026-08-17"
---

# Coordinate Peer Sessions

Establish and hold a working agreement with a second interactive session sharing one git
worktree. Every other concurrency control in this library assumes you started the other
process and can bracket it. A peer session cannot be bracketed: it may have been editing
before you arrived, so no baseline predates its work and every detector fires after the
collision rather than before it. The control this skill applies is an agreement about paths,
established before the first edit.

## When to Use

- Starting work in a repository that may already be occupied by another session.
- A git command fails with `fatal: Unable to create '.git/index.lock': File exists.`
- `npm run guard:snapshot` refuses because a snapshot already exists and you did not arm it.
- A commit or branch contains a file this session never edited.
- A generated artifact is stale and nothing this session did explains it.

## Inputs

- **Required**: a git worktree that may be shared, and permission to run `ps` and `git` in the
  same environment as the peer.
- **Optional**: `scope_paths` — the paths this session intends to touch (default: derive them
  from the task before editing anything).
- **Optional**: `base_ref` — the ref to diff the branch against when reviewing (default:
  `origin/main`).

## Procedure

### Step 1: Establish whether the worktree is occupied

There is no enumeration of peer sessions. `ListAgents` lists agents you can message, not
arbitrary interactive sessions someone else started. Look for processes and traces instead.

```bash
ps -eo pid,etime,args | rg -i 'claude|git ' | rg -v ' rg '
git status --short
git branch --sort=-committerdate | head -5
git log --oneline --all --since='2 hours ago' | head
```

**Expected:** either a positive signal — a long-running `git` process, an unrecognised branch
or recent commit, an unexpected modified file — or no signal at all.

**On failure:** if `ps` is unavailable or the output is ambiguous, **treat the worktree as
occupied**. Inconclusive is not the same as empty, and the asymmetry is large: assuming a peer
who is absent costs one unread message, assuming solitude costs a commit.

### Step 2: Declare path scope before the first edit

Both adjectives matter. *Before the first edit*, because by commit time the tree has already
been shared. *Path scope*, because two sessions on unrelated tasks still collide in one file.

```text
This session: scripts/, scripts/test/, debt-ratchet.yml
Peer session: README.md, docs/
Shared, ask before editing: CLAUDE.md, package.json, the registries
```

Record it where the other session can read it — a message to the human running both, a line
in `CONTINUE_HERE.md`, or a comment on the issue.

**Expected:** a written division naming directories and files, including an explicit list of
contested files that belong to neither session.

**On failure:** if the peer cannot be reached, narrow unilaterally instead: restrict this
session to files it creates, avoid every shared file, and say so in the PR description. A
one-sided declaration is weaker than an agreement and much stronger than nothing.

### Step 3: Work with explicit staging

```bash
git add scripts/check-thing.js scripts/test/thing.test.js
git commit -F msg.txt
```

Never `git add -A`, `git add --all` or `git add .` — none can distinguish this session's work
from a neighbour's untracked file. Note the residual gap: `git add <directory>` on a directory
holding a stray file is indistinguishable from legitimate staging, so name files when the
directory is contested.

**Expected:** `git status --short` after staging shows only paths this session authored.

**On failure:** if a deny rule blocks the command, that is the control working. If no deny
rule fires, do not conclude one exists — verify where it lives before relying on it (Step 6).

### Step 4: Survive a contended index lock

One `.git/index` is shared, and a peer's `git status` rewrites it under a lock. An ordinary
read on their side fails an ordinary write on yours.

```bash
ps -eo pid,etime,args | rg 'git ' | rg -v ' rg '

for attempt in 1 2 3 4 5; do
  git commit -F msg.txt && break
  echo "attempt $attempt blocked; waiting"
  sleep 5
done
```

**Expected:** the retry succeeds, usually on the first or second attempt — a peer's
`git status` completes in well under a second.

**On failure:** do not delete `.git/index.lock` while any git process exists. The message's
advice to terminate processes is written for a single-user repository where a stale lock
means a crash; here it usually means a live command. Remove the lock only when no git process
is running and its mtime rules out any command still in flight, and prefer asking the human.

### Step 5: Read the guard's output as a bystander

The guard's mechanics are documented in
`guides/creating-workflows.md`, section "Sharing the worktree with a peer session". Two rules
follow for a shared tree.

```bash
npm run guard:verify   # look
```

**Expected:** you read the report and act on your own judgement of the changed-file list.

**On failure:** never run `npm run guard:release` on a slot you did not arm — the snapshot
records no owner, so a release from the wrong session drops the incumbent's baseline as soon
as the tree compares clean. Never follow the `git reset --mixed <baseline>` line a failed
verify prints unless you armed that snapshot; it is recovery advice addressed to someone else
and following it drops their commit. A clean verify means the tree has not moved, never that
the other run has finished.

### Step 6: Verify where the preventive control actually lives

A permission rule can deny the dangerous staging forms. Whether it protects a collaborator
depends on which settings file holds it, and that must be read rather than assumed.

```bash
cat .claude/settings.local.json
```

**Expected:** a definite answer about this clone. A repo-local `deny` list travels with the
repository; a rule in `~/.claude/settings.json` protects only the machine it is on.

**On failure:** if the repo-local file has an empty `deny` list, state that plainly wherever
the guarantee is described. Documenting a control that does not travel is worse than
documenting none, because the next reader stops being careful.

### Step 7: Review the whole branch before opening a PR

```bash
git diff "${BASE_REF:-origin/main}" --name-only
git log "${BASE_REF:-origin/main}"..HEAD --stat
```

A `git show` on the tip cannot reveal what an earlier commit swept in.

**Expected:** every file in the diff is one this session intended to touch.

**On failure:** if an unrecognised file appears, establish who authored it before removing it
from the branch — it is someone's work. Prefer returning it to its owner over deleting it. If
a generated artifact is stale for no reason you can name, investigate before regenerating:
regenerating turns the check green and destroys the only signal that the corpus moved.

## Validation

- [ ] Occupancy was checked before the first edit, not after the first failure
- [ ] A path-scope division exists in writing, including the contested-file list
- [ ] Every commit was staged with explicit paths; no `git add -A`/`--all`/`.` was run
- [ ] No `.git/index.lock` was deleted while a git process existed
- [ ] No guard slot was released that this session did not arm
- [ ] The location of the staging deny rule was read from disk, not assumed
- [ ] The whole branch was diffed against its base before the PR was opened

## Common Pitfalls

- **Declaring scope by task instead of by path**: "you take CI, I take i18n" divides the work
  and not the tree; both sides then edit the same workflow file and the same root instructions.
- **Treating an inconclusive occupancy check as "nobody here"**: the check has no negative
  result, only a positive one and an absence of evidence.
- **Deleting the index lock because the error message says to**: that message assumes a single
  user and a crashed process. With a peer, it is usually a live command.
- **Releasing or acting on a guard slot you did not arm**: the snapshot has no owner field, so
  nothing stops you, and the failure output is recovery advice addressed to another session.
- **Reading a clean verify as "the other run finished"**: it reports tree movement, not run
  liveness — an incumbent whose fan-out has not written yet compares clean.
- **Assuming a deny rule protects everyone**: a rule in the user's home settings does not
  travel with a clone, and `git add <dir>` is not covered by any deny rule that could
  reasonably be written.
- **Regenerating a stale artifact before explaining it**: staleness is often the only evidence
  that a peer moved the corpus, and regenerating destroys it.

## Related Skills

- `commit-changes` -- explicit-path staging, which this skill depends on
- `create-pull-request` -- opens the PR whose branch Step 7 reviews
- `resolve-git-conflicts` -- for a collision that reached the index rather than the working tree
- `write-continue-here` -- one place a path-scope declaration can live across sessions
- `unleash-the-agents` -- subagent fan-out, the case this skill is explicitly *not* about
