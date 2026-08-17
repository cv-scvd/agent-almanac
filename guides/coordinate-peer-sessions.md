---
title: "Coordinating Peer Sessions"
description: "Working safely when a second interactive session shares your worktree — declaring path scope before the first edit, index etiquette, and what the guard cannot see"
category: workflow
agents: []
teams: []
skills: [coordinate-peer-sessions, commit-changes, create-pull-request]
---

# Coordinating Peer Sessions

Everything else in this library about concurrency is about **subagents** — processes you
spawned, whose lifetime you control, which you can bracket with a guard because you were
there before they started. This guide is about the other case: a **peer session**, a second
interactive Claude Code session, driven by the same human, running in the same working tree,
which you did not start and cannot stop.

The distinction matters because the tools invert. For a subagent, you arm a detector first
and read it after. For a peer, there is no "first" — they may have been editing for an hour
before you opened the repository, and no snapshot exists from before their work. Detection is
retrospective by construction: by the time anything fires, the file is already staged. So the
procedure here leads with an agreement, not an instrument.

## When to Use This Guide

- You are starting work in a repository and something suggests another session is active — an
  unexpected modified file, a branch you did not create, a recent issue or PR you did not open.
- A `git` command fails with `fatal: Unable to create '.git/index.lock': File exists.`
- You are about to run a fan-out and want to know what the repo guard does and does not cover
  when you are not the only session in the tree.
- A collision already happened: your commit contains a file you never touched, or a
  generated artifact went stale for no reason you can explain.

## Prerequisites

- A git worktree, and [Bracket the run](creating-workflows.md#bracket-the-run) read at least
  once — this guide assumes the guard exists and does not re-explain it.
- Ability to run `ps` and `git` in the same environment as the peer. Coordination across
  machines is out of scope; a peer here means a session sharing one filesystem.

## Workflow Overview

Four moves, in order. Only the first is unusual, and it is the one that does the work.

1. **Notice** — before your first edit, spend one command establishing whether you are alone.
2. **Declare** — state the paths you intend to touch, divided by path and not by task.
3. **Work** — stage explicit paths, never `git add -A`; expect the index to be busy.
4. **Review the branch, not the tip** — before opening a PR, check what the whole branch
   contains, because a collision that happened three commits ago will not appear in `git show`.

## Notice the peer before you edit

There is no reliable enumeration of peer sessions, and it is worth stating that plainly
rather than implying a tool exists. `ListAgents` lists agents *you* can message — subagents
you spawned, and your own sessions the harness knows about — not arbitrary interactive
sessions another person started. Nothing in this repository references it, and nothing
records peer-session state on disk.

What does work is looking for their processes and their traces:

```bash
# Their shell commands are visible even when their session is not.
ps -eo pid,etime,args | rg -i 'claude|git ' | rg -v ' rg '

# Traces in the repository itself.
git status --short
git branch --sort=-committerdate | head -5
git log --oneline --all --since='2 hours ago' | head
```

Two of these are stronger signals than they look. A long `etime` on a shell running
`git -C <repo> status` is a peer mid-sweep. And a branch or a commit you do not recognise,
on a repository you believed you had to yourself, is the cheapest possible warning.

Outside the tree, recent issues and pull requests opened by the same account are the other
tell:

```bash
gh pr list --state open --json number,title,headRefName,updatedAt
gh issue list --author "@me" --state open --limit 5
```

**Expect this to be inconclusive, and treat inconclusive as occupied.** The cost of assuming
a peer who is not there is that you stage explicit paths and write a scope line nobody reads.
The cost of assuming solitude is the incident this guide exists for.

## Declare path scope, not task scope

This is the whole procedure, and the two adjectives are both load-bearing.

**Before your first edit, not before your first commit.** By commit time the working tree has
already been shared for however long you were editing, and any detector fires after the fact.
The declaration is what makes the collision impossible, rather than visible.

**Divided by paths, not by tasks.** Two sessions working on unrelated tasks still collide in
one file. "I am doing the i18n work, you are doing the CI work" sounds like a division and is
not one: both touch `.github/workflows/`, both touch `CLAUDE.md`, and neither notices until
one of them overwrites the other. State directories and files:

```text
Session A: scripts/, scripts/test/, debt-ratchet.yml, .github/workflows/validate-skills.yml
Session B: README.md, docs/, .github/workflows/deploy-pages.yml
Shared, ask before editing: CLAUDE.md, package.json
```

The third line is the one people leave out. A repository has a handful of files that every
task eventually touches — the root instructions, the manifest, the registries — and pretending
they belong to one session is how the agreement quietly stops describing reality. Name them,
and agree that touching one is a message to the other session rather than a unilateral edit.

Where the declaration lives is less important than that it exists before the editing does: a
message to the human running both sessions, a line in `CONTINUE_HERE.md`, or a comment on the
issue. What must not happen is that it lives only in one session's reasoning.

## Sharing one index

Two sessions share one `.git/index`, and git serialises access to it with a lock file. A peer
running `git status` refreshes and rewrites the index, which takes the lock, so an ordinary
read on their side can fail an ordinary write on yours:

```text
fatal: Unable to create '/path/to/repo/.git/index.lock': File exists.

Another git process seems to be running in this repository, e.g.
an editor opened by 'git commit'. Please make sure all processes
are terminated then try again.
```

**Do not follow the last sentence of that message.** It is written for a single-user
repository, where a stale lock means a crashed process. With a peer in the tree, the lock is
far more likely to be a live command that will finish in under a second. Deleting it while
the peer is mid-write is how an index gets corrupted.

Check, then retry:

```bash
# Is a real git process holding it, or is it stale?
ps -eo pid,etime,args | rg 'git ' | rg -v ' rg '

# Retry rather than remove. A peer's `git status` finishes in well under a second.
for attempt in 1 2 3 4 5; do
  git commit -F msg.txt && break
  echo "attempt $attempt blocked; waiting"
  sleep 5
done
```

Only consider removing the lock when no git process exists **and** the file's mtime is old
enough that no plausible command is still running. Even then, prefer asking the human.

## What the guard covers, and what it cannot

The mechanics of `npm run guard:snapshot|verify|release` — what it compares, why file content
and index flags are included, and why ignored paths are out of scope — are documented once, in
[Sharing the worktree with a peer session](creating-workflows.md#sharing-the-worktree-with-a-peer-session).
Read it there; it is not repeated here.

What belongs in *this* guide is the consequence for coordination, which is a short and
uncomfortable list:

| The guard | Peer-session reality |
|---|---|
| Detects movement since **your** snapshot | Cannot see a peer who was working before you arrived |
| Records no owner | A release from the wrong session drops the incumbent's baseline |
| Reports tree movement | Not run liveness — an incumbent who has not written yet compares clean |
| Prints recovery advice on failure | That advice is addressed to whoever armed the snapshot |

The operating rules that follow: **never release a slot you did not arm**, and read a verify
you did not arm as reporting tree movement rather than telling you anything about the other
session. An occupied worktree is not a case the guard covers. It is a case for the agreement
in the previous section.

## Stage explicit paths — and know where the deny rule lives

`git add -A`, `git add --all` and `git add .` cannot distinguish your work from a neighbour's
untracked file. This is not a stylistic preference: the incident that produced all of this
was a peer's `git add -A` sweeping another session's file into a commit on the wrong branch.

A permission rule can deny those forms, and where that rule lives determines who it protects.
Checked on this repository:

```bash
# The repo-local settings file — what a collaborator gets by cloning.
cat .claude/settings.local.json
```

At the time of writing, this repository's `.claude/settings.local.json` carries `"deny": []`
and explicitly allows `Bash(git add:*)`. The deny rule that stops the dangerous forms is
configured **per machine**, in `~/.claude/settings.json`, and does not travel with a clone.

Say what that means rather than implying more safety than exists: on this machine the
preventive control is real and has been observed firing; for anyone else cloning this
repository, the discipline in this guide is the only control. Verify rather than assume —
run the command above rather than trusting this paragraph, which is a point-in-time reading.

And staging explicitly is narrower than it sounds. `git add <directory>` on a directory
holding a stray file is indistinguishable from legitimate staging, so it is not covered by
any deny rule that could reasonably be written. Name files when the directory is contested.

## When a collision has already happened

Review the whole branch rather than its tip. A `git show` on your last commit cannot reveal
what an earlier commit swept in:

```bash
git diff origin/main --name-only
git log origin/main..HEAD --stat
```

If a file appears that you never touched, do not quietly drop it — it is someone's work.
Establish which session authored it before removing it from the branch, and prefer moving it
to its owner over deleting it.

**Treat an unexplained stale generated file as evidence, not as a chore.** The incident behind
this guide was caught by `check-dreams` going red because an extra file made a committed
artifact stale, after `git status` had read clean. Regenerating first would have turned the
job green and buried the finding. When a generated artifact is stale for no reason you can
name, find the reason before you regenerate.

## Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| `Unable to create '.git/index.lock'` | A peer's `git status` or commit holds the index lock | Check `ps` for a live git process, then retry in a loop. Do not delete the lock file while a process exists |
| `guard:snapshot` refuses — a snapshot already exists | A peer armed the guard, or your own earlier run did not release | Do not release it. Establish whose it is; if it is yours and the tree moved intentionally, `guard:snapshot -- --force` then release |
| `guard:verify` reports movement you cannot explain | A peer edited files in your scope, or a background job of yours is mid-write | Read the changed-file list before acting. Never run the `git reset --mixed` line it prints unless you armed that snapshot |
| Your commit contains a file you never edited | `git add -A` or `git add <dir>` swept a peer's untracked file | Review with `git diff origin/main --name-only`; return the file to its owner rather than deleting it |
| A generated file is stale and nothing you did explains it | The corpus moved underneath you | Investigate before regenerating — the staleness is the only signal you have |
| You cannot tell whether a peer is active | There is no enumeration of peer sessions | Treat inconclusive as occupied. Declaring scope costs one message; assuming solitude costs a commit |

## Related Resources

- [Creating Workflows](creating-workflows.md) -- guard mechanics, and the containment preamble for agents that run shell commands
- [Coordinate Peer Sessions](../skills/coordinate-peer-sessions/SKILL.md) -- the machine-executable form of this procedure
- [Commit Changes](../skills/commit-changes/SKILL.md) -- explicit-path staging
- [Understanding the System](understanding-the-system.md) -- how agents, skills and teams relate, and why subagent concurrency is a different problem
