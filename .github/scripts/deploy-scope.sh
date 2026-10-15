#!/usr/bin/env bash
# What a CI-gated deploy releases, decided OUTSIDE its rollout lane.
#
# The deploys run on `workflow_run` of CI, so they start after CI passed on a
# push to main instead of racing it. That changes two things a `push` trigger
# used to give for free, and this script puts both back:
#
#  1. ORDER. Pushes start in push order; CI runs finish in whatever order they
#     finish. An older commit whose CI ends last would roll out over a newer one,
#     and a run queued for it would DISPLACE a newer release already pending in
#     the deploy's concurrency group (GitHub cancels a pending run when another
#     joins the group). So `gate` lets only main's CURRENT head through, and the
#     workflows run it in a job that sits outside the group. A skipped older
#     commit is released by the newer head's run, which carries it.
#
#  2. PATH SCOPE. `workflow_run` takes no `paths:` filter, and diffing only the
#     head commit would lose a skipped older commit that changed something the
#     head did not. So `target` diffs against the LAST commit this target
#     actually released, recorded by the deploy job as an Actions cache entry
#     (`<prefix><sha>`, written only from main, after a successful rollout).
#
# When unsure, release: no marker, an evicted marker, an API failure, a diff the
# compare API truncates, or history that does not line up all answer `true`.
# Only the decision NOT to release needs evidence.
#
# Usage:
#   deploy-scope.sh gate
#       Writes `current=true|false`. On workflow_dispatch it first requires a
#       successful CI run on push to main for RELEASE_SHA, and fails otherwise.
#   deploy-scope.sh target <name> <include|exclude> <ERE> <marker-prefix>
#       Writes `<name>=true|false`. `include`: release when a changed path
#       matches. `exclude`: release when a changed path does NOT match (the
#       `paths-ignore` shape). workflow_dispatch always releases.
#
# Env: RELEASE_SHA, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_OUTPUT, GH_TOKEN.
# Tested by test-deploy-scope.sh (Deploy Script Tests).

set -euo pipefail

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
EVENT="${GITHUB_EVENT_NAME:-}"
CI_WORKFLOW="${CI_WORKFLOW:-ci.yml}"
# The compare API lists at most 300 changed files; at that size the list may be
# truncated and cannot prove that nothing in scope changed.
COMPARE_FILE_CAP=300

if [[ ! "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::RELEASE_SHA must be a full lowercase commit id (got: $RELEASE_SHA)"
  exit 1
fi

out() { printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; }

cmd_gate() {
  if [[ "$EVENT" == workflow_dispatch ]]; then
    local count
    count="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/workflows/$CI_WORKFLOW/runs" \
      -f head_sha="$RELEASE_SHA" -f event=push -f branch=main -f status=success \
      --jq '.total_count')"
    if [[ ! "$count" =~ ^[0-9]+$ ]] || ((count < 1)); then
      echo "::error::CI has not succeeded on a push to main for $RELEASE_SHA; a manual release needs it too."
      exit 1
    fi
    echo "CI succeeded on main for $RELEASE_SHA."
  fi

  # No fallback: if main's head cannot be read, an older commit could roll out
  # over a newer one, so this fails the job rather than guessing.
  local head
  head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"
  if [[ "$head" != "$RELEASE_SHA" ]]; then
    echo "::notice::main has moved past $RELEASE_SHA (head is $head); the newer head's release carries this commit."
    out current false
    return
  fi
  echo "$RELEASE_SHA is main's head."
  out current true
}

cmd_target() {
  local name="$1" mode="$2" regex="$3" prefix="$4"
  if [[ "$mode" != include && "$mode" != exclude ]]; then
    echo "::error::mode must be include or exclude (got: $mode)"
    exit 1
  fi
  if [[ -z "$prefix" ]]; then
    echo "::error::a marker prefix is required"
    exit 1
  fi

  release() {
    echo "$name: release ($1)"
    out "$name" true
  }
  hold() {
    echo "$name: no release ($1)"
    out "$name" false
  }

  if [[ "$EVENT" == workflow_dispatch ]]; then
    release "manual dispatch"
    return
  fi

  local marker base
  if ! marker="$(gh api -X GET "repos/$GITHUB_REPOSITORY/actions/caches" \
    -f key="$prefix" -f ref=refs/heads/main -f sort=created_at -f direction=desc -F per_page=1 \
    --jq '.actions_caches[0].key // ""')"; then
    release "could not read the release marker"
    return
  fi
  base="${marker#"$prefix"}"
  if [[ -z "$marker" || ! "$base" =~ ^[0-9a-f]{40}$ ]]; then
    release "no release marker under $prefix"
    return
  fi

  local compare
  if ! compare="$(gh api "repos/$GITHUB_REPOSITORY/compare/$base...$RELEASE_SHA" \
    --jq '.status, (.files | length), (.files[] | .filename, (.previous_filename // empty))')"; then
    release "could not compare $base...$RELEASE_SHA"
    return
  fi

  local status count
  status="$(sed -n 1p <<<"$compare")"
  count="$(sed -n 2p <<<"$compare")"
  case "$status" in
    identical)
      hold "$RELEASE_SHA is already the released commit"
      return
      ;;
    behind)
      hold "the released commit $base is newer than $RELEASE_SHA"
      return
      ;;
    ahead) ;;
    *)
      release "history from $base is '$status'"
      return
      ;;
  esac
  if [[ ! "$count" =~ ^[0-9]+$ ]] || ((count >= COMPARE_FILE_CAP)); then
    release "$count changed files since $base; the list may be truncated"
    return
  fi

  local path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$mode" == include && "$path" =~ $regex ]] ||
      [[ "$mode" == exclude && ! "$path" =~ $regex ]]; then
      release "$path changed since $base"
      return
    fi
  done < <(sed -n '3,$p' <<<"$compare")
  hold "nothing in scope changed since $base"
}

case "${1:-}" in
  gate) cmd_gate ;;
  target)
    if (($# != 5)); then
      echo "::error::usage: deploy-scope.sh target <name> <include|exclude> <ERE> <marker-prefix>"
      exit 1
    fi
    cmd_target "$2" "$3" "$4" "$5"
    ;;
  *)
    echo "::error::usage: deploy-scope.sh gate | target <name> <include|exclude> <ERE> <marker-prefix>"
    exit 1
    ;;
esac
