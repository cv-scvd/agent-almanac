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
# BLOCKED is not terminal. GitHub's mergeStateStatus has no PENDING value: a PR whose REQUIRED
# checks are still running reports BLOCKED, exactly like one whose checks are red — and every
# merge re-triggers the next PR's required checks. So BLOCKED is polled like UNKNOWN and only
# reported after the poll budget is spent. (The first draft skipped it on sight and would have
# merged one PR per run on any repo with required checks; the adversarial review caught it.)
#
# The decision table is the part that drifts, so it is a function and --verify pins it — per
# pattern alternative, and with mixed pairs that make arm ORDER load-bearing. --verify also
# drives `run` through a fake gh (GH=fakegh) for the merge, conflict, blocked and unreadable
# paths, so the wiring between the table and the side effects is pinned too, offline.
#
# USAGE
#     tools/merge-dependabot.sh [--repo OWNER/NAME] [--dry-run] [--max-polls N] [--interval S] [PR...]
#     tools/merge-dependabot.sh --verify        pin the decision table and the run wiring; no network, no gh
#
#   PR...        numbers to handle, in order. Default: every open PR by app/dependabot, oldest first.
#   --dry-run    print the decision for each PR; merge nothing, comment nothing; exit 0 when done.
#   --max-polls  how many times to re-read a PR while it is UNKNOWN or BLOCKED (default 15).
#   --interval   seconds between polls (default 6).
#   GH=<cmd>     the gh executable or shell function to use (default gh); --verify uses a fake.
#
# EXIT: 0 every PR merged, or --dry-run completed; 1 at least one PR not merged (conflict left
# for Dependabot, blocked after the poll budget, verdict not MERGED); 2 could not run (gh
# missing or not authenticated, repo unknown, PR list unreadable, bad arguments). 2 is never a
# pass.
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
GH="${GH:-gh}"

die() { printf 'merge-dependabot: %s\n' "$*" >&2; exit 2; }

# decide MERGEABLE MERGESTATE → merge | rebase | blocked | skip | wait
# Inputs are GitHub's `mergeable` (MERGEABLE|CONFLICTING|UNKNOWN) and `mergeStateStatus`
# (CLEAN|UNSTABLE|HAS_HOOKS|BEHIND|BLOCKED|DIRTY|DRAFT|UNKNOWN). Arm order is load-bearing and
# pinned by --verify: a conflict wins over anything, BLOCKED is polled, DRAFT is left alone, and
# anything unrecognised is polled rather than guessed at.
decide() {
  local m="$1" s="$2"
  case "$m/$s" in
    MERGEABLE/CLEAN|MERGEABLE/UNSTABLE|MERGEABLE/HAS_HOOKS|MERGEABLE/BEHIND) printf merge ;;
    CONFLICTING/*|*/DIRTY) printf rebase ;;
    */BLOCKED) printf blocked ;;
    */DRAFT) printf skip ;;
    *) printf wait ;;
  esac
}

# read_state N → "MERGEABLE CLEAN" style pair, normalised: empty or null fields become UNKNOWN.
# Returns 1 when gh itself failed (unreadable PR), which is different from "still computing".
read_state() {
  local raw
  raw="$("$GH" pr view "$1" -R "$REPO" --json mergeable,mergeStateStatus --jq '"\(.mergeable // "UNKNOWN") \(.mergeStateStatus // "UNKNOWN")"' 2>/dev/null)" || return 1
  raw="${raw//null/UNKNOWN}"
  [ -n "$raw" ] || raw='UNKNOWN UNKNOWN'
  printf '%s\n' "$raw"
}

run() {
  local dry=0 max_polls=15 interval=6
  local -a prs=()
  REPO=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --max-polls) [ $# -ge 2 ] || die "--max-polls needs a value"; max_polls="$2"; shift 2 ;;
      --interval) [ $# -ge 2 ] || die "--interval needs a value"; interval="$2"; shift 2 ;;
      -*) die "unknown argument: $1" ;;
      *) [[ "$1" =~ ^[0-9]+$ ]] || die "not a PR number: $1"; prs+=("$1"); shift ;;
    esac
  done
  [[ "$max_polls" =~ ^[0-9]+$ ]] && [ "$max_polls" -ge 1 ] || die "--max-polls must be a positive integer"
  [[ "$interval" =~ ^[0-9]+$ ]] || die "--interval must be a non-negative integer"
  command -v "$GH" >/dev/null 2>&1 || die "$GH not installed"
  "$GH" auth status >/dev/null 2>&1 || die "$GH not authenticated"
  if [ -z "$REPO" ]; then
    REPO="$("$GH" repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || die "cannot resolve repo; pass --repo"
    [ -n "$REPO" ] || die "cannot resolve repo; pass --repo"
  fi
  if [ ${#prs[@]} -eq 0 ]; then
    local listed
    listed="$("$GH" pr list -R "$REPO" --author app/dependabot --state open --json number --jq 'sort_by(.number) | .[].number' 2>/dev/null)" || die "cannot list Dependabot PRs in $REPO"
    local x
    while IFS= read -r x; do [ -n "$x" ] && prs+=("$x"); done <<< "$listed"
  fi
  if [ ${#prs[@]} -eq 0 ]; then printf 'no open Dependabot PRs in %s\n' "$REPO"; exit 0; fi

  local failed=0 n i m s d verdict state unreadable err
  printf '%-6s %-12s %-10s %-8s %s\n' PR mergeable state action verdict
  for n in "${prs[@]}"; do
    d=wait; m=UNKNOWN; s=UNKNOWN; unreadable=0
    for ((i = 1; i <= max_polls; i++)); do
      if state="$(read_state "$n")"; then
        unreadable=0
        read -r m s <<< "$state"
      else
        unreadable=$((unreadable + 1))
        [ "$unreadable" -ge 2 ] && break
      fi
      d="$(decide "$m" "$s")"
      case "$d" in wait|blocked) ;; *) break ;; esac
      [ "$i" -lt "$max_polls" ] && sleep "$interval"
    done
    verdict=-
    if [ "$unreadable" -ge 2 ]; then
      d=unreadable; verdict="could not read PR #$n twice"; [ "$dry" -eq 1 ] || failed=1
    else
      case "$d" in
        merge)
          if [ "$dry" -eq 1 ]; then verdict="would merge"; else
            err="$("$GH" pr merge "$n" -R "$REPO" --merge --delete-branch 2>&1 >/dev/null)"
            verdict="$("$GH" pr view "$n" -R "$REPO" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:9] // "-")"' 2>/dev/null)" \
              || verdict="$("$GH" pr view "$n" -R "$REPO" --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid[0:9] // "-")"' 2>/dev/null)" \
              || verdict=""
            case "$verdict" in
              "MERGED -"|MERGED\ *) [ "$verdict" = "MERGED -" ] && { verdict="MERGED but no merge commit reported"; failed=1; } ;;
              "") verdict="verdict unreadable after merge attempt"; failed=1 ;;
              *) verdict="$verdict — ${err%%$'\n'*}"; failed=1 ;;
            esac
          fi ;;
        rebase)
          if [ "$dry" -eq 1 ]; then verdict="would comment @dependabot rebase"; else
            "$GH" pr comment "$n" -R "$REPO" --body "@dependabot rebase" >/dev/null 2>&1 && verdict="asked to rebase; re-run later" || verdict="conflict; could not post rebase comment"
            failed=1
          fi ;;
        blocked) verdict="blocked after $max_polls poll(s): required checks pending or red, or review required"; [ "$dry" -eq 1 ] || failed=1 ;;
        wait) verdict="still $m/$s after $max_polls poll(s)"; [ "$dry" -eq 1 ] || failed=1 ;;
        skip) verdict="draft; not touched"; [ "$dry" -eq 1 ] || failed=1 ;;
      esac
    fi
    printf '%-6s %-12s %-10s %-8s %s\n' "#$n" "$m" "$s" "$d" "$verdict"
  done
  exit "$failed"
}

# A fake gh for --verify: PR 101 is clean, 102 conflicting, 103 blocked forever, 104 unreadable,
# 105 clean but the merge leaves it OPEN (a refused merge), 106 a draft.
fakegh() {
  case "$1 $2" in
    "auth status") return 0 ;;
    "repo view") printf 'o/r\n' ;;
    "pr list") printf '101\n102\n' ;;
    "pr merge") return 0 ;;
    "pr comment") return 0 ;;
    "pr view")
      local n="$3"
      case "$*" in
        *mergeable,mergeStateStatus*)
          case "$n" in
            101) printf 'MERGEABLE CLEAN\n' ;;
            102) printf 'CONFLICTING DIRTY\n' ;;
            103) printf 'MERGEABLE BLOCKED\n' ;;
            104) return 1 ;;
            105) printf 'MERGEABLE CLEAN\n' ;;
            106) printf 'MERGEABLE DRAFT\n' ;;
            *) printf 'null null\n' ;;
          esac ;;
        *state,mergeCommit*)
          case "$n" in
            101) printf 'MERGED 0123456ab\n' ;;
            105) printf 'OPEN -\n' ;;
            *) printf 'OPEN -\n' ;;
          esac ;;
      esac ;;
    *) return 1 ;;
  esac
}

verify() {
  local rc=0
  check() { local got; got="$(decide "$2" "$3")"; if [ "$got" = "$4" ]; then printf '  ok   %s\n' "$1"; else printf '  FAIL %s: got %s, want %s\n' "$1" "$got" "$4"; rc=1; fi; }
  printf 'decision table — one case per pattern alternative:\n'
  check "clean → merge"                 MERGEABLE CLEAN     merge
  check "unstable (non-required red)"   MERGEABLE UNSTABLE  merge
  check "has_hooks → merge"             MERGEABLE HAS_HOOKS merge
  check "behind (no strict up-to-date)" MERGEABLE BEHIND    merge
  check "conflicting → rebase"          CONFLICTING DIRTY   rebase
  check "dirty even if mergeable"       MERGEABLE DIRTY     rebase
  check "blocked → poll, not skip"      MERGEABLE BLOCKED   blocked
  check "draft → skip"                  MERGEABLE DRAFT     skip
  check "unknown → wait"                UNKNOWN UNKNOWN     wait
  check "unknown state → wait"          MERGEABLE UNKNOWN   wait
  check "unexpected pair → wait"        WHATEVER  ELSE      wait
  printf 'arm order — pairs that match two arms:\n'
  check "conflicting beats unknown"     CONFLICTING UNKNOWN rebase
  check "conflicting beats blocked"     CONFLICTING BLOCKED rebase
  check "blocked beats unknown"         UNKNOWN BLOCKED     blocked
  check "dirty beats draft"             MERGEABLE DIRTY     rebase

  printf 'run wiring through a fake gh:\n'
  local out rc2
  wcheck() { if eval "$2"; then printf '  ok   %s\n' "$1"; else printf '  FAIL %s\n' "$1"; rc=1; fi; }
  out="$(MERGE_DEPENDABOT_LIB=1 GH=fakegh bash -c 'source "$0"; run --repo o/r --interval 0 --max-polls 2 101 102 103 104 105 106' "$SELF" 2>&1)"; rc2=$?
  wcheck "clean PR merged, verdict from API"        "printf '%s' \"\$out\" | grep -q '^#101 .* merge .*MERGED 0123456ab'"
  wcheck "conflict → rebase requested"              "printf '%s' \"\$out\" | grep -q '^#102 .* rebase .*asked to rebase'"
  wcheck "blocked polled to budget, then reported"  "printf '%s' \"\$out\" | grep -q '^#103 .* blocked .*after 2 poll'"
  wcheck "unreadable PR reported, not polled 15x"   "printf '%s' \"\$out\" | grep -q '^#104 .* unreadable .*could not read'"
  wcheck "refused merge reported as not merged"     "printf '%s' \"\$out\" | grep -q '^#105 .* merge .*OPEN'"
  wcheck "draft left alone"                         "printf '%s' \"\$out\" | grep -q '^#106 .* skip .*draft'"
  wcheck "exit 1 when any PR is not merged"         "[ $rc2 -eq 1 ]"
  out="$(MERGE_DEPENDABOT_LIB=1 GH=fakegh bash -c 'source "$0"; run --repo o/r --interval 0 --max-polls 1 --dry-run 101 102 103' "$SELF" 2>&1)"; rc2=$?
  wcheck "dry-run prints decisions, exits 0"        "[ $rc2 -eq 0 ] && printf '%s' \"\$out\" | grep -q 'would merge' && printf '%s' \"\$out\" | grep -q 'would comment'"
  out="$(MERGE_DEPENDABOT_LIB=1 GH=fakegh bash -c 'source "$0"; run --repo o/r --interval 0 --max-polls 1 101 --max-polls' "$SELF" 2>&1)"; rc2=$?
  wcheck "missing option value → exit 2"            "[ $rc2 -eq 2 ]"
  out="$(MERGE_DEPENDABOT_LIB=1 GH=fakegh bash -c 'source "$0"; run --repo o/r -x' "$SELF" 2>&1)"; rc2=$?
  wcheck "unknown single-dash flag → exit 2"        "[ $rc2 -eq 2 ]"
  out="$(MERGE_DEPENDABOT_LIB=1 GH=fakegh bash -c 'source "$0"; run --repo o/r' "$SELF" 2>&1)"; rc2=$?
  wcheck "default PR list comes from gh pr list"    "printf '%s' \"\$out\" | grep -q '^#101 ' && printf '%s' \"\$out\" | grep -q '^#102 '"

  [ "$rc" -eq 0 ] && printf 'verify: decision table and run wiring pinned\n'
  exit "$rc"
}

# --verify's subshells source this file with MERGE_DEPENDABOT_LIB=1 to get the functions only;
# BASH_SOURCE/$0 cannot tell those apart because `bash -c '…' "$SELF"` sets $0 to the script.
if [ -z "${MERGE_DEPENDABOT_LIB:-}" ]; then
  case "${1:-}" in
    --verify) verify ;;
    -h|--help) sed -n '2,38p' "$SELF"; exit 0 ;;
    *) run "$@" ;;
  esac
fi
