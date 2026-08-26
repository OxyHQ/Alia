#!/usr/bin/env bash
#
# What Cloudflare holds at one hostname, and which of it is an address record.
#
#   cloudflare-address-records.sh <zone-name> <hostname>
#
# Prints one JSON object on stdout:
#
#   {"zone_id": "...", "all": [...], "address": [...], "other": [...]}
#
# WHY IT IS ITS OWN FILE. "Which records are address records" is one fact, and
# on 2026-08-26 the repository had it wrong in one place and then wrong again in
# a second. `dns_records?name=$HOSTNAME` filters by name and NOT by type:
# `migrate-pages-to-worker.yml` deleted `.result[0]` of the apex listing and took
# `alia.onl` down for fifteen minutes, then `bind-pages-domain.yml`, recovering,
# PUT a CNAME over `.result[0]` of the same query and destroyed
# `TXT "v=spf1 -all"` while reporting success.
#
# Everything that asks the question now asks it here — the delete, the recovery
# bind, and the restore step that decides whether a hostname still resolves. A
# second list of types is how the two workflows came to disagree in the first
# place, and the restore path is the last place that should be able to.
#
# A, AAAA and CNAME, and nothing else. Those are the types that provoke
# Cloudflare's 100117 ("already has externally managed DNS records") when a
# Worker custom domain wants the hostname; everything else at the name blocks
# nothing and is somebody's mail policy, domain verification or DKIM selector.
#
# `CLOUDFLARE_API_TOKEN` is read from the environment and never printed.

set -euo pipefail

zone_name=${1:-}
hostname=${2:-}
api=https://api.cloudflare.com/client/v4

if [ -z "$zone_name" ] || [ -z "$hostname" ]; then
  echo "::error::usage: cloudflare-address-records.sh <zone-name> <hostname>" >&2
  exit 2
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::CLOUDFLARE_API_TOKEN is empty" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$api/zones?name=$zone_name" -o "$work/zone.json"
[ "$(jq -r '.success' "$work/zone.json")" = "true" ] \
  || { echo "::error::zone lookup failed: $(jq -c '.errors' "$work/zone.json")" >&2; exit 1; }
zone_id=$(jq -r '.result[0].id // empty' "$work/zone.json")
[ -n "$zone_id" ] || { echo "::error::zone $zone_name not found on this account" >&2; exit 1; }

curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$api/zones/$zone_id/dns_records?name=$hostname" -o "$work/records.json"
[ "$(jq -r '.success' "$work/records.json")" = "true" ] \
  || { echo "::error::record lookup failed: $(jq -c '.errors' "$work/records.json")" >&2; exit 1; }

# THE ONE DEFINITION. `other` is the complement of `address` rather than a
# hand-written inverse, because a hand-written inverse is a second definition
# and this file exists to not have one.
jq --arg zone "$zone_id" '
  [.result[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME")] as $address
  | {zone_id: $zone,
     all: .result,
     address: $address,
     other: [.result[] | select(.id as $id | [$address[].id] | index($id) | not)]}
' "$work/records.json"
