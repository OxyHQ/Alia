#!/usr/bin/env bash
#
# Retire a Cloudflare Pages project, deployments and all.
#
#   delete-pages-project.sh <project>
#
# WHY THIS IS NOT ONE DELETE. A Pages project always serves
# `<project>.pages.dev` and Cloudflare offers no way to switch that off, so a
# frontend that has moved to a Worker keeps a second, unretired copy of itself
# on the internet — one that is in no CORS allowlist, renders the interface and
# fails every call. Deleting the project is the whole point of the migration,
# and on 2026-08-26 it answered:
#
#   {"code":8000076,"message":"Your project has too many deployments to be
#    deleted, follow this guide to delete them: https://cfl.re/3CXesln"}
#
# So the deployments go first. There can be hundreds, the API rate-limits, and a
# step whose worst case does not fit inside its job is a step whose own error
# message is unreachable in exactly the case it was written for — the defect
# #436 fixed in these same files. Hence a wall-clock budget, a backoff that
# counts against it, and a message that says what to do when it runs out.
#
# THE ACTIVE PRODUCTION DEPLOYMENT NEVER GOES, and that is not a failure. Run
# 32919327793 deleted 239 of `alia-app`'s 240 and stopped on the last one:
#
#   {"code":8000034,"message":"You cannot delete the active production
#    deployment."}
#
# `?force=true` moves the aliased deployments and not that one. So a page whose
# every refusal is 8000034 means the purge has done all it can, and the run
# continues to the project delete — which is the only thing the purge was ever
# for. A page that stalls for ANY other reason is still a hard failure. The
# difference is the error code and nothing looser: an exception keyed on "the
# last one left" or "one deployment remaining" would swallow the stalls this
# guard exists to catch.
#
# THE PAGINATION IS "ALWAYS PAGE 1", DELIBERATELY. Walking pages 1..N while
# deleting from underneath shifts every later page up by as many rows as were
# removed, so entries slide past the cursor and survive. Re-reading the first
# page until it comes back empty cannot skip anything. Its risk is the opposite
# one — spinning forever on a deployment that refuses to go — and that is what
# the no-progress guard below is for.
#
# IT REFUSES A PROJECT THAT STILL SERVES A CUSTOM DOMAIN. Deleting one of those
# is an outage, and this is reachable from a workflow whose only input is a
# project name.
#
# EVERY DESTRUCTIVE CALL IS READ BACK. `success: true` from a call that changed
# nothing and from one that worked are the same response.
#
# `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` come from the environment
# and neither is printed; the account id is a secret, so logged URLs are paths
# with it elided.

set -euo pipefail

project=${1:-}
api=https://api.cloudflare.com/client/v4
budget=${PAGES_RETIRE_DEADLINE_SECONDS:-600}
page_size=${PAGES_RETIRE_PAGE_SIZE:-25}

[ -n "$project" ] || { echo "::error::usage: delete-pages-project.sh <project>"; exit 2; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN is empty"; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::CLOUDFLARE_ACCOUNT_ID is empty"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

base="$api/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$project"
deadline=$((SECONDS + budget))

# One request, with the retry policy in one place. Prints the HTTP code on
# stdout and everything else on stderr, so a caller may capture it.
cf() {
  local method=$1 url=$2 out=$3 shown=$4
  local attempt=0 code wait
  while :; do
    attempt=$((attempt + 1))
    code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$url")
    case "$code" in
      429|500|502|503|504)
        wait=$((attempt * 5))
        if [ "$SECONDS" -ge "$deadline" ]; then
          echo "::error::$method $shown answered $code and the ${budget}s budget is spent" >&2
          return 1
        fi
        if [ "$attempt" -ge 6 ]; then
          echo "::error::$method $shown answered $code on $attempt consecutive attempts" >&2
          return 1
        fi
        echo "  $method $shown -> http=$code, waiting ${wait}s (attempt $attempt)" >&2
        sleep "$wait"
        ;;
      *)
        printf '%s' "$code"
        return 0
        ;;
    esac
  done
}

# A project still holding a hostname is a live site. Refuse before anything else.
code=$(cf GET "$base/domains" "$work/domains.json" "pages/projects/$project/domains")
if [ "$(jq -r '.success' "$work/domains.json")" = "true" ]; then
  domains=$(jq -r '[.result[].name] | join(", ")' "$work/domains.json")
  if [ -n "$domains" ]; then
    echo "::error::$project still serves $domains. Detach the custom domain before retiring the project, or this deletes a live site."
    exit 1
  fi
  echo "$project holds no custom domain — safe to retire"
elif [ "$code" = "404" ]; then
  echo "$project does not exist — nothing to retire"
  exit 0
else
  echo "::error::could not read the domains of $project (http=$code): $(jq -c '.errors // []' "$work/domains.json")"
  exit 1
fi

# The cheap path first: a project few enough deployments to delete outright
# never needs the purge, and asking is one request.
delete_project() {
  code=$(cf DELETE "$base" "$work/delete.json" "pages/projects/$project")
  echo "delete $project -> http=$code success=$(jq -r '.success' "$work/delete.json")"
}

delete_project
if [ "$(jq -r '.success' "$work/delete.json")" != "true" ]; then
  if ! jq -e '.errors[]? | select(.code == 8000076)' "$work/delete.json" >/dev/null; then
    echo "::error::delete failed: $(jq -c '.errors' "$work/delete.json")"
    exit 1
  fi

  jq -r '.errors[0].message' "$work/delete.json"
  echo "purging deployments (budget ${budget}s)"
  deleted=0
  pass=0
  while :; do
    pass=$((pass + 1))
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error::the ${budget}s budget ran out with $deleted deployment(s) deleted and more still listed. Nothing is broken — the project is intact and this is safe to run again, which resumes where it stopped. Raise PAGES_RETIRE_DEADLINE_SECONDS if it keeps running out."
      exit 1
    fi

    # Always page 1: deleting from a paginated list shifts everything after the
    # cursor, so a 1..N walk skips rows. This cannot.
    code=$(cf GET "$base/deployments?page=1&per_page=$page_size" "$work/page.json" \
      "pages/projects/$project/deployments")
    [ "$(jq -r '.success' "$work/page.json")" = "true" ] \
      || { echo "::error::could not list deployments (http=$code): $(jq -c '.errors // []' "$work/page.json")"; exit 1; }

    listed=$(jq -r '.result | length' "$work/page.json")
    total=$(jq -r '.result_info.total_count // "?"' "$work/page.json")
    [ "$listed" != "0" ] || break
    echo "pass $pass: $listed of $total remaining (${SECONDS}s of ${budget}s, $deleted deleted)"

    progressed=0
    immovable=0
    while read -r id; do
      [ -n "$id" ] || continue
      # `force=true` is what lets the aliased deployments go. It does NOT move
      # the active production one — Cloudflare refuses that by rule, 8000034.
      code=$(cf DELETE "$base/deployments/$id?force=true" "$work/dd.json" \
        "pages/projects/$project/deployments/$id")
      if [ "$(jq -r '.success' "$work/dd.json")" = "true" ]; then
        deleted=$((deleted + 1))
        progressed=$((progressed + 1))
      elif jq -e '.errors[]? | select(.code == 8000034)' "$work/dd.json" >/dev/null; then
        # Identified by ERROR CODE, never by id or by position on the page.
        # Which deployment is the production one is Cloudflare's answer to give,
        # and "the last one left" is a guess that is wrong the moment a page
        # comes back in a different order.
        immovable=$((immovable + 1))
        echo "  $id is the active production deployment; Cloudflare does not allow deleting it (8000034)"
      else
        echo "  $id would not delete (http=$code): $(jq -c '.errors // []' "$work/dd.json")"
      fi
      [ "$SECONDS" -lt "$deadline" ] || break
    done < <(jq -r '.result[].id' "$work/page.json")

    if [ "$progressed" = "0" ]; then
      # Everything still listed is the production deployment. The purge exists
      # only to satisfy 8000076, so there is nothing left for it to do and the
      # project delete is the next thing to try — it is the step that was the
      # point.
      if [ "$immovable" = "$listed" ]; then
        echo "$listed remaining deployment(s), all of them the active production deployment that Cloudflare will not delete (8000034) — the purge is done; continuing to the project"
        break
      fi
      # The only way the always-page-1 loop can spin. A pass that deletes
      # nothing for any OTHER reason will do the same forever, so it stops here
      # with the API's own refusal already in the log above. The difference is
      # the error code and nothing else: an exception keyed on anything looser
      # would swallow the failures this guard exists for.
      echo "::error::a page of $listed deployment(s) and none of them could be deleted — see the refusals above"
      exit 1
    fi
  done
  echo "deployments purged: $deleted deleted"

  delete_project
  if [ "$(jq -r '.success' "$work/delete.json")" != "true" ]; then
    # 8000076 again, after the purge, means purging was not the way in. Say so
    # in those words: leaving a workflow retrying something the API does not
    # permit is worse than saying it has to be done by hand.
    if jq -e '.errors[]? | select(.code == 8000076)' "$work/delete.json" >/dev/null; then
      echo "::error::$project still answers 8000076 after deleting $deleted deployment(s), with only the active production deployment left — and Cloudflare refuses to delete that one (8000034). Purging is not a way in for this project: it CANNOT be retired through the API. Delete it in the dashboard (Workers & Pages -> $project -> Settings -> Delete project), which is allowed to remove the production deployment. Re-running this will not change the answer."
      exit 1
    fi
    echo "::error::delete still failed after purging $deleted deployment(s): $(jq -c '.errors' "$work/delete.json")"
    exit 1
  fi
fi

# Read back the project ITSELF, not the account's project list. The list is
# paginated at 25 by default, so a `grep` over its first page reports a project
# absent as readily when it is on page two.
code=$(cf GET "$base" "$work/gone.json" "pages/projects/$project")
if [ "$code" = "404" ] || [ "$(jq -r '.success' "$work/gone.json")" != "true" ]; then
  echo "$project is gone (GET -> http=$code)"
  exit 0
fi
echo "::error::$project still exists after a delete that reported success"
exit 1
