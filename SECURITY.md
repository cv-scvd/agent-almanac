# Security

## Disclaimer

This repository is provided under the [MIT License](LICENSE) — use it at your own risk. The authors make no guarantees about the security or safety of any content, including skills, agents, teams, guides, scripts, and the visualization pipeline.

## What This Repository Contains

<!-- AUTO:START:security-surface -->
- **Skills, agents, teams, guides**: Markdown and YAML documentation. 228 of 370 skills (~62%) declare `Bash` in their `allowed-tools`, meaning they instruct AI agents to execute shell commands when followed. Review any skill before letting an agent execute it.
- **Visualization pipeline** (`viz/`): A containerized R + Node.js + Vite build system with a Dockerfile, shell scripts, and an icon rendering pipeline. The Docker entrypoint serves content via a Python HTTP server.
- **Scripts** (`scripts/`): 33 Node.js and shell tools — registry validation, README and translation generation, i18n gates, and a small number that deliberately mutate the working tree or run repository commands (`normalize-i18n-fences.js`, `mutation-check.js`, `gate-envelope.js`). Maintainer-invoked; `scripts/` is not in `package.json`'s `files` array, so none of it ships in the published package.
- **CLI** (`cli/`): The published package surface. Installs skills, agents and teams into agent home directories by creating symlinks and writing rule files under `~/.claude/`, `~/.hermes/`, and the Cursor, Windsurf and Copilot configuration directories.
- **Claude Code configuration** (`.claude/`): Agent discovery symlinks and permission settings.
<!-- AUTO:END:security-surface -->

## Reporting Issues

If you find a security issue, open a [GitHub issue](https://github.com/pjt222/agent-almanac/issues). There is no private disclosure process or guaranteed response timeline.

## Automated Scanning

- CodeQL runs on every push and pull request, and on a **weekly** schedule. It uses GitHub's
  server-managed default setup, which commits no workflow YAML — so grepping `.github/workflows/`
  for it finds nothing. Read the live configuration rather than this line:
  `gh api repos/pjt222/agent-almanac/code-scanning/default-setup`
- Dependabot is configured to monitor GitHub Actions and npm dependencies for known vulnerabilities
