#!/usr/bin/env bash
#
# Make the SPF record at one hostname say exactly one thing.
#
#   cloudflare-set-spf.sh <zone-name> <hostname> <value>
#
# WHY: `alia.onl` had `TXT "v=spf1 -all"` and lost it on 2026-08-26, when
# `bind-pages-domain.yml` PUT a CNAME over `.result[0]` of a query that filters
# by name and not by type. The record it replaced was the SPF one. This puts it
# back, and is the only thing in this repository that writes a TXT record.
#
# WHY -all IS THE RIGHT VALUE AND NOT A GUESS. Three independent readings agree
# and none of them is somebody's memory:
#
#   * The Cloudflare API's own description of the record, in the log of the run
#     that destroyed it: `replacing existing record (TXT -> v=spf1 -all)`,
#     printed from `.result[0].type + " -> " + .result[0].content` before the
#     PUT went out (run 32914185721, 2026-08-26T00:13:41Z).
#   * The run four minutes earlier had already established the apex held
#     exactly two records, so there was one TXT and that was it
#     (run 32913715892: `records for alia.onl now: 1` after the CNAME went).
#   * `_dmarc.alia.onl` publishes `v=DMARC1; p=reject; sp=reject; adkim=s;
#     aspf=s;` and the apex has no MX. A domain that rejects everything
#     unaligned and receives no mail is a domain that sends none, which is what
#     `-all` says. A different SPF value would contradict the DMARC record
#     standing next to it.
#
# `-all` MEANS THIS DOMAIN SENDS NO MAIL. If that ever stops being true the
# value changes here, as an input, rather than by deleting the record: no SPF at
# all is a weaker statement than `-all`, not a neutral one.
#
# WHAT IT WILL NOT DO:
#   * touch a TXT record that is not an SPF record. Verification tokens,
#     DKIM selectors and the like sit at the same name and are left alone.
#   * pick between two SPF records. More than one is a permanent error under
#     RFC 7208 §4.5 and a human has to say which survives, so it stops.
#   * touch an address record. It only ever writes `type: TXT`, and it asserts
#     the address records at the name are the same afterwards as before.
#
# Idempotent: a correct record already in place is a no-op that still reads
# back. `CLOUDFLARE_API_TOKEN` is read from the environment and never printed.

set -euo pipefail

zone_name=${1:-}
hostname=${2:-}
value=${3:-}
api=https://api.cloudflare.com/client/v4

if [ -z "$zone_name" ] || [ -z "$hostname" ] || [ -z "$value" ]; then
  echo "::error::usage: cloudflare-set-spf.sh <zone-name> <hostname> <value>"
  exit 2
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN is empty"; exit 1; }

# A typo in the value is a live mail policy. `v=spf1` is the only prefix that
# makes the record an SPF record at all, so anything else is a mistake being
# published rather than a policy being chosen.
case "$value" in
  'v=spf1'|'v=spf1 '*) ;;
  *) echo "::error::'$value' is not an SPF record — it must begin with v=spf1"; exit 1;;
esac

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Cloudflare has returned TXT `content` both bare and wrapped in quotes across
# API revisions, and `dig` always wraps it. An SPF value contains no quote of
# its own, so stripping them is lossless and makes the comparison mean what it
# looks like it means.
unquote() { tr -d '"'; }

curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$api/zones?name=$zone_name" -o "$work/zone.json"
[ "$(jq -r '.success' "$work/zone.json")" = "true" ] \
  || { echo "::error::zone lookup failed: $(jq -c '.errors' "$work/zone.json")"; exit 1; }
zone_id=$(jq -r '.result[0].id // empty' "$work/zone.json")
[ -n "$zone_id" ] || { echo "::error::zone $zone_name not found on this account"; exit 1; }

# Every record at the name, before. Nothing below may change any of them except
# the SPF record itself, and that is checked at the end rather than believed.
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$api/zones/$zone_id/dns_records?name=$hostname" -o "$work/all-before.json"
[ "$(jq -r '.success' "$work/all-before.json")" = "true" ] \
  || { echo "::error::record lookup failed: $(jq -c '.errors' "$work/all-before.json")"; exit 1; }
echo "records at $hostname before:"
jq -r 'if (.result | length) == 0 then "  (none)"
       else (.result[] | "  \(.type)  \(.content)  id=\(.id)")
       end' "$work/all-before.json"

# `&type=TXT` on the query, so no filter here has to know what an address
# record is — `cloudflare-clear-address-records.sh` owns the only list of DNS
# record types in this repository, and a second one is how two of them start
# disagreeing.
#
# It writes both files rather than printing: redirecting this function's stdout
# would send its own `::error::` line into a file instead of the log.
spf_records() {
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$api/zones/$zone_id/dns_records?name=$hostname&type=TXT" -o "$1"
  [ "$(jq -r '.success' "$1")" = "true" ] \
    || { echo "::error::TXT lookup failed: $(jq -c '.errors' "$1")"; exit 1; }
  jq '[.result[] | select((.content | ltrimstr("\"")) | startswith("v=spf1"))]' "$1" > "$2"
}

spf_records "$work/txt.json" "$work/spf.json"
count=$(jq -r 'length' "$work/spf.json")
echo "SPF records at $hostname: $count"

body=$(jq -nc --arg n "$hostname" --arg c "$value" '{type:"TXT",name:$n,content:$c,ttl:1}')

if [ "$count" -gt 1 ]; then
  jq -r '.[] | "  \(.content)  id=\(.id)"' "$work/spf.json"
  echo "::error::$hostname publishes $count SPF records. RFC 7208 makes that a permerror and this cannot choose between them — delete the wrong ones by hand first."
  exit 1
elif [ "$count" = "1" ]; then
  id=$(jq -r '.[0].id' "$work/spf.json")
  current=$(jq -r '.[0].content' "$work/spf.json" | unquote)
  # The record about to be overwritten says what it is. This is the exact shape
  # of the incident — a PUT landing on a record of another type — so the subject
  # is confirmed at the point of the write, not inferred from the query.
  [ "$(jq -r '.[0].type' "$work/spf.json")" = "TXT" ] \
    || { echo "::error::refusing to replace $(jq -r '.[0].type' "$work/spf.json") record $id with a TXT record"; exit 1; }
  if [ "$current" = "$value" ]; then
    echo "already correct: TXT $hostname -> $current — nothing to write"
  else
    echo "replacing TXT $hostname -> $current"
    code=$(curl -sS -o "$work/write.json" -w '%{http_code}' -X PUT \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
      --data "$body" "$api/zones/$zone_id/dns_records/$id")
    [ "$(jq -r '.success' "$work/write.json")" = "true" ] \
      || { echo "::error::SPF write failed (http=$code): $(jq -c '.errors' "$work/write.json")"; exit 1; }
  fi
else
  echo "no SPF record exists; creating one"
  code=$(curl -sS -o "$work/write.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    --data "$body" "$api/zones/$zone_id/dns_records")
  [ "$(jq -r '.success' "$work/write.json")" = "true" ] \
    || { echo "::error::SPF create failed (http=$code): $(jq -c '.errors' "$work/write.json")"; exit 1; }
fi

# Read back. A call that returns `success: true` having changed nothing and one
# that changed something are indistinguishable from the response alone, and the
# "already correct" branch above never issued a call at all — both end here.
spf_records "$work/txt-after.json" "$work/spf-after.json"
count=$(jq -r 'length' "$work/spf-after.json")
[ "$count" = "1" ] \
  || { echo "::error::$hostname has $count SPF record(s) after writing one"; exit 1; }
got=$(jq -r '.[0].content' "$work/spf-after.json" | unquote)
[ "$got" = "$value" ] \
  || { echo "::error::SPF at $hostname reads '$got', expected '$value'"; exit 1; }
echo "TXT $hostname -> $got"

# And every OTHER record at the name is still exactly where it was. Not a type
# list — the set of ids that are not the SPF record, which covers the address
# records, DKIM selectors and verification tokens without naming any of them.
# The incident this file answers was a DNS write destroying a record of another
# type; it would be a poor answer if it could do the same in reverse.
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$api/zones/$zone_id/dns_records?name=$hostname" -o "$work/all-after.json"
[ "$(jq -r '.success' "$work/all-after.json")" = "true" ] \
  || { echo "::error::read-back failed: $(jq -c '.errors' "$work/all-after.json")"; exit 1; }
spf_id=$(jq -r '.[0].id' "$work/spf-after.json")
lost=$(jq -r --arg spf "$spf_id" --slurpfile after "$work/all-after.json" '
  [$after[0].result[].id] as $ids
  | [.result[] | select(.id != $spf) | select(.id as $i | $ids | index($i) | not)
     | "\(.type) \(.content)"] | join(", ")' "$work/all-before.json")
[ -z "$lost" ] || { echo "::error::writing the SPF record destroyed another record at $hostname: $lost"; exit 1; }
echo "records at $hostname after:"
jq -r '.result[] | "  \(.type)  \(.content)  id=\(.id)"' "$work/all-after.json"
