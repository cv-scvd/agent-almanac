#!/usr/bin/env bash
# merge-dependabot.sh — merge open Dependabot PRs one at a time, the way the lockfile race forces.
#
# WHY
# ---
# Several Dependabot PRs touch the same lockfile. Merging one flips the others to UNKNOWN and
# then, often, CONFLICTING; a naive loop either merges a stale mergeability or gives up. The
# procedure that worked on 2026-09-02 (four PRs, one rebase) is: take them oldest first,
# re-poll mergeability before each merge, read the merge verdict from the API and never from
# gh's stderr (a post-merge local checkout can print a fatal error while the merge succeeded —
# git incident 4), and on a conflict ask Dependabot to rebase and come back later.
#
# The decision table is the part that drifts, so it is a function and --verify pins it.
#
# USAGE
#     tools/merge-dependabot.sh [--repo OWNER/NAME] [--dry-run] [--max-polls N] [--interval S] [PR...]
#     tools/merge-dependabot.sh --verify        pin the decision table; no network beyond `gh --version`
#
#   PR...        numbers to handle, in order. Default: every open PR by app/dependabot, oldest first.
#   --dry-run    print the decision for each PR; merge nothing, comment nothing.
#   --max-polls  how many times to re-read mergeability while it is UNKNOWN (default 15).
#   --interval   seconds between polls (default 6).
#
# EXIT: 0 every PR merged (or dry-run completed); 1 at least one PR not merged (conflict left for
# Dependabot, blocked, or the API did not report MERGED); 2 could not run (gh missing or not
# authenticated, repo unknown). 2 is never a pass.
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

die() { printf 'merge-dependabot: %s\n' "$*" >&2; exit 2; }

# decide MERGEABLE MERGESTATE → merge | rebase | wait | skip
# The two inputs are GitHub's `mergeable` (MERGEABLE|CONFLICTING|UNKNOWN) and
# `mergeStateStatus` (CLEAN|UNSTABLE|HAS_HOOKS|BEHIND|BLOCKED|DIRTY|DRAFT|UNKNOWN).
decide() {
  local m="$1" s="$2"
  case "$m/$s" in
    MERGEABLE/CLEAN|MERGEABLE/UNSTABLE|MERGEABLE/HAS_HOOKS|MERGEABLE/BEHIND) printf merge ;;
    CONFLICTING/*|*/DIRTY) printf rebase ;;
    */BLOCKED|*/DRAFT) printf skip ;;
    UNKNOWN/*|*/UNKNOWN) printf wait ;;
    *) printf skip ;;
  esac
}

run() {
  local repo="" dry=0 max_polls=15 interval=6
  local -a prs=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) repo="$2"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --max-polls) max_polls="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      --*) die "unknown argument: $1" ;;
      *) prs+=("$1"); shift ;;
    esac
  done
  command -v gh >/dev/null 2>&1 || die "gh not installed"
  gh auth status >/dev/null 2>&1 || die "gh not authenticated"
  if [ -z "$repo" ]; then
    repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || die "cannot resolve repo; pass --repo"
  fi
  if [ ${#prs[@]} -eq 0 ]; then
    mapfile -t prs < <(gh pr list -R "$repo" --author app/dependabot --state open --json number --jq 'sort_by(.number) | .[].number')
  fi
  if [ ${#prs[@]} -eq 0 ]; then printf 'no open Dependabot PRs in %s\n' "$repo"; exit 0; fi

  local failed=0 n i m s d verdict
  printf '%-6s %-12s %-10s %-8s %s\n' PR mergeable state action verdict
  for n in "${prs[@]}"; do
    d=wait; m=UNKNOWN; s=UNKNOWN
    for ((i = 0; i < max_polls; i++)); do
      read -r m s < <(gh pr view "$n" -R "$repo" --json mergeable,mergeStateStatus --jq '"\(.mergeable) \(.mergeStateStatus)"' 2>/dev/null || printf 'UNKNOWN UNKNOWN\n')
      d="$(decide "$m" "$s")"
      [ "$d" = wait ] || break
      sleep "$interval"
    done
    verdict=-
    case "$d" in
      merge)
        if [ "$dry" -eq 1 ]; then verdict="would merge"; else
          gh pr merge "$n" -R "$repo" --merge --delete-branch >/dev/null 2>&1
          verdict="$(gh pr view "$n" -R "$repo" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:9] // "-")"' 2>/dev/null)"
          case "$verdict" in MERGED*) ;; *) failed=1 ;; esac
        fi ;;
      rebase)
        if [ "$dry" -eq 1 ]; then verdict="would comment @dependabot rebase"; else
          gh pr comment "$n" -R "$repo" --body "@dependabot rebase" >/dev/null 2>&1 && verdict="asked to rebase; re-run later"
          failed=1
        fi ;;
      wait) verdict="still UNKNOWN after $max_polls polls"; failed=1 ;;
      skip) verdict="not touched (checks pending/red, or draft)"; failed=1 ;;
    esac
    printf '%-6s %-12s %-10s %-8s %s\n' "#$n" "$m" "$s" "$d" "$verdict"
  done
  exit "$failed"
}

verify() {
  local rc=0
  command -v gh >/dev/null 2>&1 || { printf 'verify: gh not installed (exit 2)\n'; exit 2; }
  check() { local got; got="$(decide "$2" "$3")"; if [ "$got" = "$4" ]; then printf '  ok   %s\n' "$1"; else printf '  FAIL %s: got %s, want %s\n' "$1" "$got" "$4"; rc=1; fi; }
  check "clean → merge"                 MERGEABLE CLEAN     merge
  check "unstable (non-required red)"   MERGEABLE UNSTABLE  merge
  check "behind (no strict up-to-date)" MERGEABLE BEHIND    merge
  check "conflicting → rebase"          CONFLICTING DIRTY   rebase
  check "dirty even if mergeable"       MERGEABLE DIRTY     rebase
  check "blocked → skip, never merge"   MERGEABLE BLOCKED   skip
  check "draft → skip"                  MERGEABLE DRAFT     skip
  check "unknown → wait"                UNKNOWN UNKNOWN     wait
  check "unknown state → wait"          MERGEABLE UNKNOWN   wait
  check "unexpected pair → skip"        WHATEVER  ELSE      skip
  [ "$rc" -eq 0 ] && printf 'verify: decision table pinned\n'
  exit "$rc"
}

case "${1:-}" in
  --verify) verify ;;
  -h|--help) sed -n '2,26p' "$SELF"; exit 0 ;;
  *) run "$@" ;;
esac
