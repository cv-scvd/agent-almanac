# Security

## Disclaimer

This repository is provided under the [MIT License](LICENSE) — use it at your own risk. The authors make no guarantees about the security or safety of any content, including skills, agents, teams, guides, scripts, and the visualization pipeline.

## What This Repository Contains

<!-- AUTO:START:security-surface -->
- **Skills, agents, teams, guides**: Markdown and YAML documentation. 228 of 370 skills (~62%) declare `Bash` in their `allowed-tools`, meaning they instruct AI agents to execute shell commands when followed. Review any skill before letting an agent execute it.
- **Visualization pipeline** (`viz/`): A containerized R + Node.js + Vite build system with a Dockerfile, shell scripts, and an icon rendering pipeline. The Docker entrypoint serves content via a Python HTTP server.
- **Scripts** (`scripts/`): 33 top-level Node.js and shell tools — registry validation, README and translation generation, i18n gates, and a small number that deliberately mutate the working tree or run repository commands (`normalize-i18n-fences.js`, `mutation-check.js`, `gate-envelope.js`). Maintainer-invoked; `scripts/` is not in `package.json`'s `files` array, so none of it ships in the published package.
- **CLI** (`cli/`): The published package surface, and the only component that writes outside this repository. 13 adapters install content into other tools' configuration directories, at global (home) or PROJECT scope depending on the adapter and the `--scope` flag, using append-to-file, distill, file-per-item and symlink. Adapters: ai-edge, aider, claude-code, codex, copilot, cursor, gemini, hermes, openclaw, opencode, universal, vibe, windsurf.
- **Workflows** (`workflows/`): 2 executable orchestration scripts. They are not auto-installed and do not ship in the published package; the documented way to use one is to COPY its `.mjs` into `.claude/workflows/` by hand, after which Claude Code's Workflow tool runs it and it may spawn subagents with whatever tools those agents carry. Read one before copying it — that instruction is the whole security boundary.
- **Claude Code configuration** (`.claude/`): Agent discovery symlinks and permission settings.
<!-- AUTO:END:security-surface -->

## Reporting Issues

If you find a security issue, open a [GitHub issue](https://github.com/pjt222/agent-almanac/issues). There is no private disclosure process or guaranteed response timeline.

## Automated Scanning

- CodeQL uses GitHub's **server-managed default setup**, which commits no workflow YAML — so
  grepping `.github/workflows/` for it finds nothing. It runs on a **weekly** schedule and on
  pushes and pull requests against the default branch.
- **It does not run on pull requests from forks.** Measured, not assumed: our first external
  contribution (PR #589) reports *no checks at all*, while a same-day pull request from a local
  branch reports ten. If you are contributing from a fork, expect our automation to have told us
  nothing about your change — tracked as issue #689.
- The exact event coverage is GitHub's to define and ours only to read. Prefer the live
  configuration over this file: `gh api repos/pjt222/agent-almanac/code-scanning/default-setup`
  (needs `security-events` access, so an external reader will likely get a 403 — the schedule and
  the fork exclusion above are the parts that affect you)
- Dependabot is configured to monitor GitHub Actions and npm dependencies for known vulnerabilities
