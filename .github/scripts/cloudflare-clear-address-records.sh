#!/usr/bin/env bash
#
# Delete every ADDRESS record at one hostname, and nothing else, ever.
#
#   cloudflare-clear-address-records.sh <zone-name> <hostname> [<record-file>]
#
# With a third argument it first writes the records it is about to delete there,
# as the JSON needed to recreate them. Cloudflare cannot be asked afterwards
# what used to be at a name, so the restore step in `migrate-pages-to-worker.yml`
# has this file or it has nothing.
#
# WHY THIS EXISTS AS ONE FILE. On 2026-08-26 the apex `alia.onl` carried two
# records, `CNAME -> alia-app.pages.dev` and `TXT "v=spf1 -all"`. Two different
# workflows reached for `dns_records?name=$HOSTNAME` — a query that filters by
# name and NOT by type — took `.result[0]`, and acted on it as though a hostname
# carried exactly one record:
#
#   * `migrate-pages-to-worker.yml` DELETED it. `.result[0]` was the CNAME, the
#     domain lost its only address record, and the site was down ~15 minutes.
#   * `bind-pages-domain.yml`, the RECOVERY workflow, then PUT a CNAME over
#     `.result[0]`, which by then was the SPF record. `v=spf1 -all` was gone,
#     and its own read-back — also `.result[0]` — read the CNAME it had just
#     written and reported success.
#
# The second is the worse defect: the tool you reach for when something is
# already broken destroyed a record nobody was thinking about, and said it had
# worked. So the operation lives here once and both callers get the same
# behaviour, over the one list of record types in
# `cloudflare-address-records.sh`.
#
# WHAT IT GUARANTEES, and asserts rather than assumes:
#
#   1. Only A, AAAA and CNAME are deleted — whatever
#      `cloudflare-address-records.sh` calls an address record, never a second
#      opinion held here.
#   2. Every record it is not deleting is enumerated BEFORE, by id, and its
#      survival is checked AFTER. An SPF record is not collateral this can lose
#      quietly — losing one turns this script red and names it.
#   3. Every DELETE's own response is read. A call that returns `success: true`
#      having changed nothing and one that genuinely changed something are
#      indistinguishable from the response alone, so the state is re-read at the
#      end and the count has to be zero.
#
# It is deliberately NOT idempotent-by-silence: a hostname with no address
# records is a normal, successful no-op, but a delete that does not take is a
# hard failure rather than something the next step discovers as a confusing
# 100117.
#
# `CLOUDFLARE_API_TOKEN` is read from the environment and never printed.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
zone_name=${1:-}
hostname=${2:-}
record_file=${3:-}
api=https://api.cloudflare.com/client/v4

if [ -z "$zone_name" ] || [ -z "$hostname" ]; then
  echo "::error::usage: cloudflare-clear-address-records.sh <zone-name> <hostname> [<record-file>]"
  exit 2
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN is empty"; exit 1; }

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

bash "$here/cloudflare-address-records.sh" "$zone_name" "$hostname" > "$work/before.json"
zone_id=$(jq -r '.zone_id' "$work/before.json")

# The prior state, in the log, before anything is destroyed. The run that caused
# the outage had no way afterwards to say what the record it deleted had been,
# or what the second record was.
echo "records at $hostname before:"
jq -r 'if (.all | length) == 0 then "  (none)"
       else (.all[] | "  \(.type)  \(.content)  proxied=\(.proxied)  ttl=\(.ttl)  id=\(.id)")
       end' "$work/before.json"

# Written BEFORE the first DELETE, because nothing can ask Cloudflare later what
# used to be here. Everything needed to recreate the record and nothing else.
if [ -n "$record_file" ]; then
  jq '[.address[] | {type, name, content, ttl, proxied}]' "$work/before.json" > "$record_file"
  echo "recorded for restore: $(jq -c '[.[] | .type + " -> " + .content]' "$record_file")"
fi

if [ "$(jq -r '.address | length' "$work/before.json")" = "0" ]; then
  echo "no address record at $hostname — nothing to delete"
else
  while read -r id; do
    [ -n "$id" ] || continue
    what=$(jq -r --arg id "$id" '.all[] | select(.id == $id) | .type + " -> " + .content' "$work/before.json")
    echo "deleting $what ($id)"
    code=$(curl -sS -o "$work/delete.json" -w '%{http_code}' -X DELETE \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "$api/zones/$zone_id/dns_records/$id")
    # Per record, not once for the batch: a failure in the middle would
    # otherwise be papered over by the next success.
    [ "$(jq -r '.success' "$work/delete.json")" = "true" ] \
      || { echo "::error::record delete failed for $what (http=$code): $(jq -c '.errors' "$work/delete.json")"; exit 1; }
  done < <(jq -r '.address[].id' "$work/before.json")
fi

# Read back. `success: true` is not evidence the field holds.
bash "$here/cloudflare-address-records.sh" "$zone_name" "$hostname" > "$work/after.json"

echo "records at $hostname after:"
jq -r 'if (.all | length) == 0 then "  (none)"
       else (.all[] | "  \(.type)  \(.content)  id=\(.id)")
       end' "$work/after.json"

# 1. The address records are gone. A DELETE that reports success and leaves the
#    record would otherwise surface much later as a 100117 that looks unrelated.
left=$(jq -r '.address | length' "$work/after.json")
if [ "$left" != "0" ]; then
  echo "::error::$left address record(s) still present at $hostname after deleting them — the DELETE reported success and changed nothing"
  exit 1
fi

# 2. Everything else is still there. This is the assertion the incident needed:
#    it fires if the type list ever widens, and it names the record that went.
#    On a correct run it costs one comparison.
missing=$(jq -r --slurpfile after "$work/after.json" '
  [$after[0].all[].id] as $ids
  | [.other[] | select(.id as $id | $ids | index($id) | not) | "\(.type) \(.content)"]
  | join(", ")' "$work/before.json")
if [ -n "$missing" ]; then
  echo "::error::a record that is not an address record was destroyed at $hostname: $missing"
  exit 1
fi

kept=$(jq -r '[.all[].type] | join(",")' "$work/after.json")
echo "address records at $hostname now: 0 (untouched at this name: ${kept:-none})"
