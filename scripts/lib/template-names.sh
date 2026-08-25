#!/usr/bin/env bash
# template-names.sh -- the one shell definition of "this name is author scaffolding" (#672).
#
# Sourced by `validate-integrity.sh` and `sync-discovery-symlinks.sh`, which between them
# carried 19 hand-rolled `_template` exclusions in four spellings: `[[ "$name" ==
# "_template.md" ]]`, `-not -name '_template.md'`, `[ "$f" = "skills/_template/SKILL.md" ]`
# and `grep -v '^_template$'`.
#
# ## This list is one half of a PAIR
#
# The other half is `TEMPLATE_SEGMENTS` in `scripts/lib/content-paths.js`. A shell script
# cannot import an ES module, so the duplication is structural rather than lazy -- which is
# exactly the situation that produced the 19 sites in the first place, one level up. It is
# therefore GATED: `scripts/test/content-paths.test.js` parses this file and asserts the two
# lists are equal as sets, in both directions. Add a spelling to one and the suite goes red
# naming the other.
#
# Do not "simplify" the array to a `_template*` glob. The exact set is what makes the drift
# check in `templateSpellingDrift` able to fail at all; a prefix silently absorbs a new
# spelling and reports nothing. The reasoning is in that function's JSDoc.
#
# shellcheck shell=bash

# Every name a template goes by, matching content-paths.js's TEMPLATE_SEGMENTS exactly.
TEMPLATE_NAMES=('_template' '_template.md' '_template.mjs')

# Is this basename (or bare path segment) a template's name?
#
# Usage mirrors the `[[ ... ]] && continue` idiom it replaces, which is safe under `set -e`
# because a non-final command in an `&&` list does not trigger the exit.
is_template() { # <basename>
  local candidate
  for candidate in "${TEMPLATE_NAMES[@]}"; do
    [[ "$1" == "$candidate" ]] && return 0
  done
  return 1
}

# `find` predicates excluding every template name, for expansion into a find invocation:
#
#   find agents -maxdepth 1 -name '*.md' "${TEMPLATE_FIND_PRUNE[@]}" -not -name 'README.md'
#
# Built from the array above rather than written out, so a new spelling reaches the `find`
# sites and the `[[ ]]` sites together. Widening a find that previously excluded only
# `_template.md` is a no-op wherever `-name '*.md'` already constrains the match.
TEMPLATE_FIND_PRUNE=()
for _template_name in "${TEMPLATE_NAMES[@]}"; do
  TEMPLATE_FIND_PRUNE+=(-not -name "$_template_name")
done
unset _template_name

# Filter template ids out of a newline-separated id list on stdin.
#
# `-x` anchors whole-line and `-F` takes the patterns literally, so this is the exact-set
# semantics of `is_template` rather than the `grep -v '^_template$'` it replaces -- which was
# a fourth spelling of the rule, and covered only one of the three names.
strip_template_ids() {
  grep -vxF -f <(printf '%s\n' "${TEMPLATE_NAMES[@]}") || true
}
