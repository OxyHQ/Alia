#!/usr/bin/env bash
#
# The Cloudflare cutover scripts must still be able to FAIL.
#
# ## What this is protecting
#
# On 2026-08-26 `alia.onl` lost its address record for fifteen minutes and then
# lost `TXT "v=spf1 -all"` permanently, to the same one-line mistake made twice:
# `dns_records?name=$HOSTNAME` filters by NAME and not by type, and both the
# cutover and the recovery workflow read `.result[0]` from it as though a
# hostname carried exactly one record. The migration deleted the apex CNAME. The
# recovery then PUT a CNAME over what was by then the SPF record, read
# `.result[0]` back, found the CNAME it had just written, and reported success.
#
# Nothing about a green run distinguished that from a correct one. So the fix is
# gated against fixtures shaped like the apex that provoked it, and every case
# states the exit code it demands and what the message must name — "it exited 1"
# is satisfied by a crash.
#
# ## Why a stub and not a recording
#
# Deliberately the REAL scripts and the REAL `run:` block lifted out of the YAML,
# spawned the way a runner spawns them, against a Cloudflare that is a state
# machine rather than a fixed reply. Two of the defects here are only visible in
# STATE — a delete that answers `success: true` and changes nothing reads
# identically to one that worked, and so does a write that lands on the wrong
# record. A stub that replayed canned responses could not tell those apart,
# which is the same blindness that let the incident through.
#
# ## The control
#
# `pre-incident` cases run the historical `run:` blocks, pasted verbatim from
# `d41a42ac^` and from `origin/main` before this change, against those same
# fixtures. They must reproduce the failure — including the one that exits ZERO
# while destroying the SPF record, because that is what the incident looked like
# from the outside. A harness whose control passes is measuring nothing.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
sandbox="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
sandbox="$(realpath "$sandbox")"

cleanup() {
  if [[ "$sandbox" == "$temporary_root"/* && -d "$sandbox" ]]; then
    rm -rf -- "$sandbox"
  else
    echo "Refusing to remove unexpected sandbox: $sandbox" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$sandbox/bin"

# ---------------------------------------------------------------------------
# The stub. It is on PATH ahead of the real curl, so the scripts under test are
# unmodified and know nothing about it.
#
# It refuses arguments it does not understand rather than guessing: a workflow
# that grows a new curl flag must make this loud, because a stub that quietly
# mis-parses is a harness that reports on something other than the code.
# ---------------------------------------------------------------------------
cat > "$sandbox/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

state=$CF_STUB_STATE
method=GET
out=/dev/stdout
want_code=0
data=''
url=''

while [ $# -gt 0 ]; do
  case "$1" in
    -s|-S|-sS|-Ss|--silent|--show-error) ;;
    -H|--header) shift ;;
    -X) method=$2; shift ;;
    -o) out=$2; shift ;;
    --data|--data-raw|-d) data=$2; shift ;;
    --max-time) shift ;;
    -w)
      case "$2" in
        '%{http_code}') want_code=1 ;;
        *) echo "stub curl: unsupported -w format '$2'" >&2; exit 99 ;;
      esac
      shift ;;
    http://*|https://*) url=$1 ;;
    *) echo "stub curl: unrecognised argument '$1' — the caller changed and this stub would have guessed" >&2; exit 99 ;;
  esac
  shift
done

[ -n "$url" ] || { echo "stub curl: no URL" >&2; exit 99; }

path=${url#https://api.cloudflare.com/client/v4/}
# A fetch of the site itself, not the API. The workflows check whether a
# hostname answers; the case says what it answers.
if [ "$path" = "$url" ]; then
  printf '' > "$out"
  if [ "$want_code" = 1 ]; then printf '%s' "${CF_STUB_SITE_CODE:-000}"; fi
  exit 0
fi
query=''
case "$path" in *\?*) query=${path#*\?}; path=${path%%\?*} ;; esac

param() { printf '%s' "$query" | tr '&' '\n' | sed -n "s/^$1=//p" | head -1; }

echo "$method /$path${query:+?$query}" >> "$CF_STUB_LOG"

emit() {
  printf '%s' "$2" > "$out"
  if [ "$want_code" = 1 ]; then printf '%s' "$1"; fi
  exit 0
}

edit() { jq "$@" "$state" > "$state.next" && mv "$state.next" "$state"; }
fault=${CF_STUB_FAULT:-none}

# A bounded burst of 429s, so the retry path is exercised without the harness
# waiting on a real rate limit.
seen=$(( $(cat "$CF_STUB_STATE.requests" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$seen" > "$CF_STUB_STATE.requests"
if [ "$seen" -le "${CF_STUB_429_FIRST:-0}" ]; then
  emit 429 '{"success":false,"errors":[{"code":10000,"message":"Rate limited."}]}'
fi

fail() { emit "$1" "{\"success\":false,\"errors\":[{\"code\":$2,\"message\":\"$3\"}]}"; }

case "$path" in
  user/tokens/verify)
    emit 200 '{"success":true,"result":{"status":"active"}}' ;;

  zones)
    name=$(param name)
    emit 200 "$(jq -c --arg n "$name" \
      'if .zone.name == $n then {success:true,errors:[],result:[.zone]} else {success:true,errors:[],result:[]} end' "$state")" ;;

  zones/*/dns_records)
    zid=${path#zones/}; zid=${zid%%/*}
    [ "$zid" = "$(jq -r '.zone.id' "$state")" ] || fail 404 7003 "Could not route to zone."
    case "$method" in
      GET)
        name=$(param name); type=$(param type)
        emit 200 "$(jq -c --arg n "$name" --arg t "$type" \
          '{success:true,errors:[],result:[.records[] | select(.name == $n) | select($t == "" or .type == $t)]}' "$state")" ;;
      POST)
        if [ "$fault" = "write-noop" ]; then
          emit 200 '{"success":true,"errors":[],"result":{"id":"phantom"}}'
        fi
        id="new-$(jq -r '.records | length' "$state")"
        edit --argjson r "$(jq -c --arg id "$id" '. + {id:$id}' <<<"$data")" '.records += [$r]'
        emit 200 "{\"success\":true,\"errors\":[],\"result\":{\"id\":\"$id\"}}" ;;
      *) fail 405 0 "method not allowed" ;;
    esac ;;

  zones/*/dns_records/*)
    rid=${path##*/}
    case "$method" in
      DELETE)
        case "$fault" in
          delete-noop) : ;;
          # A delete that takes more than it was asked for. Not a thing
          # Cloudflare does — it is what a WIDENED filter in the script under
          # test would look like from the outside, and the whole point of the
          # survivor check is to notice it.
          delete-collateral)
            edit --arg id "$rid" '.records |= map(select(.id != $id and .type != "TXT"))' ;;
          *) edit --arg id "$rid" '.records |= map(select(.id != $id))' ;;
        esac
        emit 200 "{\"success\":true,\"errors\":[],\"result\":{\"id\":\"$rid\"}}" ;;
      PUT)
        if [ "$fault" != "write-noop" ]; then
          edit --arg id "$rid" --argjson r "$data" '.records |= map(if .id == $id then ($r + {id:$id}) else . end)'
        fi
        emit 200 "{\"success\":true,\"errors\":[],\"result\":{\"id\":\"$rid\"}}" ;;
      *) fail 405 0 "method not allowed" ;;
    esac ;;

  accounts/*/pages/projects/*/deployments)
    p=${path#accounts/*/pages/projects/}; p=${p%/deployments}
    jq -e --arg p "$p" '.projects[$p]' "$state" >/dev/null || fail 404 8000007 "Project not found."
    page=$(param page); per=$(param per_page)
    emit 200 "$(jq -c --arg p "$p" --argjson page "${page:-1}" --argjson per "${per:-25}" '
      .projects[$p].deployments as $all
      | {success:true, errors:[],
         result:[$all[(($page - 1) * $per):($page * $per)][] | {id:.}],
         result_info:{page:$page, per_page:$per, total_count:($all|length)}}' "$state")" ;;

  accounts/*/pages/projects/*/deployments/*)
    p=${path#accounts/*/pages/projects/}; d=${p#*/deployments/}; p=${p%%/deployments/*}
    [ "$method" = DELETE ] || fail 405 0 "method not allowed"
    if [ "$fault" = "deployment-undeletable" ]; then
      fail 400 8000035 "Deployment is the live deployment."
    fi
    edit --arg p "$p" --arg d "$d" '.projects[$p].deployments |= map(select(. != $d))'
    emit 200 '{"success":true,"errors":[],"result":null}' ;;

  accounts/*/workers/domains)
    emit 200 "$(jq -c '{success:true, errors:[], result:[.worker_domains[]? | {hostname:., service:"alia-app", environment:"production", id:"wd-1"}]}' "$state")" ;;

  accounts/*/pages/projects/*/domains)
    p=${path#accounts/*/pages/projects/}; p=${p%/domains}
    jq -e --arg p "$p" '.projects[$p]' "$state" >/dev/null || fail 404 8000007 "Project not found."
    case "$method" in
      POST)
        name=$(jq -r '.name' <<<"$data")
        if jq -e --arg p "$p" --arg n "$name" '.projects[$p].domains | index($n)' "$state" >/dev/null; then
          fail 409 8000021 "A domain with that name already exists."
        fi
        edit --arg p "$p" --arg n "$name" '.projects[$p].domains += [$n]'
        emit 200 "{\"success\":true,\"errors\":[],\"result\":{\"name\":\"$name\"}}" ;;
      *)
        emit 200 "$(jq -c --arg p "$p" '{success:true, errors:[], result:[.projects[$p].domains[] | {name:., status:"active"}]}' "$state")" ;;
    esac ;;

  accounts/*/pages/projects/*)
    p=${path##*/}
    case "$method" in
      GET)
        jq -e --arg p "$p" '.projects[$p]' "$state" >/dev/null || fail 404 8000007 "Project not found."
        emit 200 "$(jq -c --arg p "$p" '{success:true, errors:[], result:{name:$p, created_on:"2025-01-01T00:00:00Z"}}' "$state")" ;;
      DELETE)
        jq -e --arg p "$p" '.projects[$p]' "$state" >/dev/null || fail 404 8000007 "Project not found."
        if [ "$(jq -r --arg p "$p" '.projects[$p].deployments | length' "$state")" != "0" ]; then
          fail 400 8000076 "Your project has too many deployments to be deleted, follow this guide to delete them: https://cfl.re/3CXesln"
        fi
        if [ "$fault" != "project-delete-noop" ]; then
          edit --arg p "$p" 'del(.projects[$p])'
        fi
        emit 200 '{"success":true,"errors":[],"result":null}' ;;
      *) fail 405 0 "method not allowed" ;;
    esac ;;

  *) echo "stub curl: no route for $method /$path" >&2; exit 99 ;;
esac
STUB
chmod +x "$sandbox/bin/curl"

export PATH="$sandbox/bin:$PATH"
export CLOUDFLARE_API_TOKEN=stub-token
export CLOUDFLARE_ACCOUNT_ID=stub-account
export CF_STUB_STATE="$sandbox/state.json"
export CF_STUB_LOG="$sandbox/requests.log"
# The runner sets both. A lifted `run:` block that writes a step summary dies on
# `set -u` without them, which would read as the step being broken.
export GITHUB_STEP_SUMMARY="$sandbox/summary.md"
export GITHUB_ENV="$sandbox/github.env"

# ---------------------------------------------------------------------------
# Lifting a `run:` block out of the YAML, so what executes here is the text the
# runner executes and not a paraphrase that can drift from it.
# ---------------------------------------------------------------------------
extract_run() {
  local file=$1 step=$2 block
  block=$(awk -v want="      - name: $step" '
    $0 == want { found = 1; next }
    found && !inrun && /^        run: \|/ { inrun = 1; next }
    found && !inrun && /^      - / { exit }
    inrun {
      if ($0 ~ /^[[:space:]]*$/) { print ""; next }
      if ($0 !~ /^          /) exit
      print substr($0, 11)
    }
  ' "$repo/.github/workflows/$file")
  # A silently empty extraction is a harness that tests nothing and says OK.
  [ -n "$block" ] || { echo "extract_run: found no run: block for '$step' in $file" >&2; exit 1; }
  printf '%s\n' "$block"
}

failures=0
cases=0

# Fixtures name a zone and its records; a case may add Pages projects.
state() { jq -n "$@" > "$CF_STUB_STATE"; }

APEX_WITH_SPF='{
  zone: {id:"zone-1", name:"alia.onl"},
  records: [
    {id:"c1", type:"CNAME", name:"alia.onl", content:"alia-app.pages.dev", proxied:true, ttl:1},
    {id:"t1", type:"TXT", name:"alia.onl", content:"v=spf1 -all", proxied:false, ttl:1}
  ],
  projects: {}
}'

APEX_SPF_ONLY='{
  zone: {id:"zone-1", name:"alia.onl"},
  records: [
    {id:"t1", type:"TXT", name:"alia.onl", content:"v=spf1 -all", proxied:false, ttl:1}
  ],
  projects: {}
}'

APEX_CROWDED='{
  zone: {id:"zone-1", name:"alia.onl"},
  records: [
    {id:"a1", type:"A", name:"alia.onl", content:"203.0.113.10", proxied:true, ttl:1},
    {id:"a2", type:"A", name:"alia.onl", content:"203.0.113.11", proxied:true, ttl:1},
    {id:"q1", type:"AAAA", name:"alia.onl", content:"2001:db8::1", proxied:true, ttl:1},
    {id:"t1", type:"TXT", name:"alia.onl", content:"v=spf1 -all", proxied:false, ttl:1},
    {id:"m1", type:"MX", name:"alia.onl", content:"mx.example.net", proxied:false, ttl:1}
  ],
  projects: {}
}'

# Runs one command against a fresh stub, capturing output and exit code.
attempt() {
  : > "$CF_STUB_LOG"
  rm -f "$CF_STUB_STATE.requests"
  set +e
  ATTEMPT_OUTPUT=$( "$@" 2>&1 )
  ATTEMPT_STATUS=$?
  set -e
}

# Runs a lifted `run:` block. `/tmp` paths are hardcoded in the workflows, so
# every one the block names is cleared first: a stale file from an earlier case
# would otherwise stand in for a request this one never made.
# `$KEEP` names files a previous step in the same case wrote and this one reads
# — `/tmp/deleted-records.json` is the whole seam between the delete and the
# restore, and scrubbing it would test the restore against a case that never
# happened.
KEEP=""
attempt_block() {
  local block=$1; shift
  printf '%s\n' "$block" > "$sandbox/step.sh"
  local f scrub=()
  mapfile -t scrub < <(grep -o '/tmp/[A-Za-z0-9_.-]*' "$sandbox/step.sh" | sort -u)
  for f in ${scrub[@]+"${scrub[@]}"}; do
    case " $KEEP " in *" $f "*) continue ;; esac
    rm -f "$f"
  done
  attempt env "$@" bash "$sandbox/step.sh"
}

check() {
  local name=$1 want_status=$2; shift 2
  cases=$((cases + 1))
  local problems=()
  [ "$ATTEMPT_STATUS" = "$want_status" ] \
    || problems+=("exited $ATTEMPT_STATUS, expected $want_status")
  local rule
  for rule in "$@"; do
    case "$rule" in
      says:*)     grep -qF -- "${rule#says:}" <<<"$ATTEMPT_OUTPUT" || problems+=("said nothing about '${rule#says:}'") ;;
      silent:*)   grep -qF -- "${rule#silent:}" <<<"$ATTEMPT_OUTPUT" && problems+=("mentioned '${rule#silent:}' and should not have") ;;
      jq:*)       jq -e "${rule#jq:}" "$CF_STUB_STATE" >/dev/null || problems+=("state failed ${rule#jq:}") ;;
      file:*)     local spec=${rule#file:}
                  jq -e "${spec#*:}" "${spec%%:*}" >/dev/null 2>&1 \
                    || problems+=("${spec%%:*} failed ${spec#*:}") ;;
      requests:*) local want=${rule#requests:}; local got
                  got=$(grep -cF -- "${want%%=*}" "$CF_STUB_LOG" || true)
                  [ "$got" = "${want##*=}" ] || problems+=("${want%%=*} happened $got times, expected ${want##*=}") ;;
      *) echo "unknown rule '$rule'" >&2; exit 1 ;;
    esac
  done
  if [ ${#problems[@]} -gt 0 ]; then
    failures=$((failures + 1))
    echo "FAIL  $name"
    printf '        %s\n' "${problems[@]}"
    printf '        output: %s\n' "$(tr '\n' '|' <<<"$ATTEMPT_OUTPUT")"
  else
    echo "ok    $name"
  fi
}

clear_records="$repo/.github/scripts/cloudflare-clear-address-records.sh"
set_spf="$repo/.github/scripts/cloudflare-set-spf.sh"
delete_project="$repo/.github/scripts/delete-pages-project.sh"

# ===========================================================================
# The apex, and the record that must survive it
# ===========================================================================

BIND_STEP=$(extract_run bind-pages-domain.yml 'The address record is a proxied CNAME to the Pages project')
# `bind-pages-domain.yml` carries its OWN copy of the delete, because it runs no
# action at all and therefore cannot check the repository out to reach a script.
# If it ever started delegating, every case below would be testing the script
# for a second time and the copy that actually runs during a recovery — the one
# that has to work when nothing else does — would be the only untested thing
# here. So the harness refuses to proceed rather than quietly measuring twice.
# Comment lines are stripped first. The block explains in prose that the script
# holds the other copy of the filter, and a check that matched that sentence
# would be reading the paragraph about the code instead of the code — the same
# way the static check below skips comments.
BIND_CODE=$(grep -v '^[[:space:]]*#' <<<"$BIND_STEP")
if grep -q '\.github/scripts/' <<<"$BIND_CODE"; then
  echo "the bind step delegates to a script; it must be self-contained, and these cases would then test the script twice" >&2
  exit 1
fi
# Presence, not spelling. Requiring the canonical spacing here would make a
# respaced copy exit with "no longer filters by record type", which is false and
# points away from the real answer — the byte-identical check below owns the
# spelling and names both locations when they diverge.
if ! grep -q 'AAAA' <<<"$BIND_CODE"; then
  echo "the bind step no longer filters by record type; this harness is pointed at the wrong text" >&2
  exit 1
fi

state "$APEX_WITH_SPF"
CF_STUB_FAULT=none attempt_block "$BIND_STEP" \
  HOSTNAME=alia.onl PROJECT=alia-canvas ZONE=alia.onl ZONE_ID=zone-1 \
  CLOUDFLARE_API_TOKEN=stub-token
check 'binding an apex of [CNAME, TXT] keeps the SPF record' 0 \
  'says:deleting CNAME -> alia-app.pages.dev' \
  'jq:[.records[] | select(.type == "TXT" and .content == "v=spf1 -all")] | length == 1' \
  'jq:[.records[] | select(.type == "CNAME")] | length == 1' \
  'jq:.records[] | select(.type == "CNAME") | .content == "alia-canvas.pages.dev" and .proxied == true'

state "$APEX_CROWDED"
attempt bash "$clear_records" alia.onl alia.onl
check 'an apex of [A, A, AAAA, TXT, MX] loses only the three address records' 0 \
  'jq:[.records[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME")] | length == 0' \
  'jq:[.records[] | .type] | sort == ["MX","TXT"]' \
  'requests:DELETE /zones/zone-1/dns_records/=3'

state "$APEX_WITH_SPF"
CF_STUB_FAULT=delete-noop attempt bash "$clear_records" alia.onl alia.onl
check 'a DELETE that reports success and changes nothing still fails the guard' 1 \
  'says:address record(s) still present' \
  'jq:[.records[] | select(.type == "CNAME")] | length == 1'

state "$APEX_CROWDED"
CF_STUB_FAULT=delete-collateral attempt bash "$clear_records" alia.onl alia.onl
check 'a delete that takes a record it was not asked for is caught and named' 1 \
  'says:not an address record was destroyed' \
  'says:TXT v=spf1 -all'

state "$APEX_WITH_SPF"
attempt bash "$clear_records" alia.onl www.alia.onl
check 'a hostname with no address record is a successful no-op' 0 \
  'says:nothing to delete' \
  'jq:.records | length == 2'

# THE SAME FIXTURES THROUGH THE OTHER COPY. Every case above exercises the
# script that `migrate-pages-to-worker.yml` calls; these run the block that
# lives inside `bind-pages-domain.yml`, which is a different body of shell that
# has to behave identically. Testing one and asserting the filters match would
# leave the recovery path's error handling — the delete check, the read-back,
# the survivor check — entirely unmeasured.
bind_env=(HOSTNAME=alia.onl PROJECT=alia-canvas ZONE=alia.onl ZONE_ID=zone-1
          CLOUDFLARE_API_TOKEN=stub-token)

state "$APEX_CROWDED"
attempt_block "$BIND_STEP" "${bind_env[@]}"
check 'bind, on [A, A, AAAA, TXT, MX]: three go, the TXT and the MX stay' 0 \
  'jq:[.records[] | .type] | sort == ["CNAME","MX","TXT"]' \
  'jq:.records[] | select(.type == "CNAME") | .content == "alia-canvas.pages.dev"' \
  'jq:[.records[] | select(.type == "TXT" and .content == "v=spf1 -all")] | length == 1' \
  'requests:DELETE /zones/zone-1/dns_records/=3'

state "$APEX_WITH_SPF"
CF_STUB_FAULT=delete-noop attempt_block "$BIND_STEP" "${bind_env[@]}"
check 'bind, on a DELETE that reports success and changes nothing: still red' 1 \
  'says:address record(s) still present' \
  'silent:creating CNAME' \
  'jq:[.records[] | select(.content == "alia-canvas.pages.dev")] | length == 0'

state "$APEX_CROWDED"
CF_STUB_FAULT=delete-collateral attempt_block "$BIND_STEP" "${bind_env[@]}"
check 'bind, on a delete that takes a record it was not asked for: caught and named' 1 \
  'says:not an address record was destroyed' \
  'says:TXT v=spf1 -all'

state "$APEX_WITH_SPF"
CF_STUB_FAULT=write-noop attempt_block "$BIND_STEP" "${bind_env[@]}"
check 'bind, on a create that reports success and writes nothing: still red' 1 \
  'says:CNAME record(s), expected exactly 1'

# ===========================================================================
# The control: the code as it stood, against the same fixtures
# ===========================================================================

# Verbatim from `d41a42ac^`, the step that took `alia.onl` down. `.result[0]` is
# the CNAME, so the site loses its address record and the read-back then counts
# an SPF record that never blocked anything.
PRE_INCIDENT_DELETE=$(cat <<'OLD'
set -euo pipefail
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=$ZONE" -o /tmp/z.json
zone=$(jq -r '.result[0].id // empty' /tmp/z.json)
[ -n "$zone" ] || { echo "::error::zone $ZONE not found"; exit 1; }
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?name=$HOSTNAME" -o /tmp/r.json
rec=$(jq -r '.result[0].id // empty' /tmp/r.json)
if [ -z "$rec" ]; then
  echo "no record to delete — continuing"
else
  echo "deleting $(jq -r '.result[0].type + " -> " + .result[0].content' /tmp/r.json)"
  curl -sS -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$zone/dns_records/$rec" -o /tmp/rd.json
  [ "$(jq -r '.success' /tmp/rd.json)" = "true" ] \
    || { echo "::error::record delete failed: $(jq -c '.errors' /tmp/rd.json)"; exit 1; }
fi
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?name=$HOSTNAME" -o /tmp/r2.json
left=$(jq -r '.result|length' /tmp/r2.json)
echo "records for $HOSTNAME now: $left"
[ "$left" = "0" ] || { echo "::error::$left record(s) still present"; exit 1; }
OLD
)

state "$APEX_WITH_SPF"
attempt_block "$PRE_INCIDENT_DELETE" HOSTNAME=alia.onl ZONE=alia.onl \
  CLOUDFLARE_API_TOKEN=stub-token
check 'CONTROL: the old delete reproduces run 32913715892 line for line' 1 \
  'says:deleting CNAME -> alia-app.pages.dev' \
  'says:records for alia.onl now: 1' \
  'says:1 record(s) still present'

# Verbatim from `bind-pages-domain.yml` as it stood on `origin/main`, run
# against the apex it was pointed at during the recovery: the CNAME is gone and
# the SPF record is `.result[0]`. This is the case that must exit ZERO while
# destroying it — a green run is exactly what the operator saw.
PRE_INCIDENT_BIND=$(cat <<'OLD'
set -euo pipefail
target="${PROJECT}.pages.dev"
curl -sS -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$HOSTNAME" -o /tmp/rec.json
rec=$(jq -r '.result[0].id // empty' /tmp/rec.json)
body=$(jq -nc --arg n "$HOSTNAME" --arg c "$target" \
  '{type:"CNAME",name:$n,content:$c,proxied:true,ttl:1}')
if [ -n "$rec" ]; then
  echo "replacing existing record ($(jq -r '.result[0].type + " -> " + .result[0].content' /tmp/rec.json))"
  curl -sS -X PUT -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
    --data "$body" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$rec" -o /tmp/put.json
else
  echo "no record exists; creating one"
  curl -sS -X POST -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
    --data "$body" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" -o /tmp/put.json
fi
[ "$(jq -r '.success' /tmp/put.json)" = "true" ] || { echo "::error::record write failed: $(jq -c '.errors' /tmp/put.json)"; exit 1; }
curl -sS -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$HOSTNAME" -o /tmp/after.json
got_type=$(jq -r '.result[0].type // "-"' /tmp/after.json)
got_content=$(jq -r '.result[0].content // "-"' /tmp/after.json)
got_proxied=$(jq -r '.result[0].proxied // "-"' /tmp/after.json)
echo "record now: $got_type $HOSTNAME -> $got_content proxied=$got_proxied"
[ "$got_type" = "CNAME" ] || { echo "::error::type is $got_type, expected CNAME"; exit 1; }
[ "$got_content" = "${PROJECT}.pages.dev" ] || { echo "::error::content is $got_content, expected ${PROJECT}.pages.dev"; exit 1; }
[ "$got_proxied" = "true" ] || { echo "::error::record is not proxied"; exit 1; }
OLD
)

state "$APEX_SPF_ONLY"
attempt_block "$PRE_INCIDENT_BIND" HOSTNAME=alia.onl PROJECT=alia-app ZONE_ID=zone-1 \
  CF_TOKEN=stub-token
check 'CONTROL: the old bind destroys the SPF record and reports success' 0 \
  'says:replacing existing record (TXT -> v=spf1 -all)' \
  'jq:[.records[] | select(.type == "TXT")] | length == 0'

state "$APEX_SPF_ONLY"
attempt_block "$BIND_STEP" HOSTNAME=alia.onl PROJECT=alia-app ZONE=alia.onl ZONE_ID=zone-1 \
  CLOUDFLARE_API_TOKEN=stub-token
check 'the same fixture, the same workflow, and the SPF record survives' 0 \
  'says:nothing to delete' \
  'silent:replacing existing record' \
  'jq:[.records[] | select(.type == "TXT" and .content == "v=spf1 -all")] | length == 1' \
  'jq:[.records[] | select(.type == "CNAME" and .content == "alia-app.pages.dev")] | length == 1'

# ===========================================================================
# Putting the SPF record back
# ===========================================================================

state '{zone:{id:"zone-1",name:"alia.onl"},
        records:[{id:"c1",type:"CNAME",name:"alia.onl",content:"alia-app.pages.dev",proxied:true,ttl:1}],
        projects:{}}'
attempt bash "$set_spf" alia.onl alia.onl 'v=spf1 -all'
check 'an apex with no SPF record gains exactly one' 0 \
  'says:no SPF record exists; creating one' \
  'says:TXT alia.onl -> v=spf1 -all' \
  'jq:[.records[] | select(.type == "TXT")] | length == 1' \
  'jq:[.records[] | select(.type == "CNAME" and .content == "alia-app.pages.dev")] | length == 1'

attempt bash "$set_spf" alia.onl alia.onl 'v=spf1 -all'
check 'running it again writes nothing' 0 \
  'says:already correct' \
  'requests:POST /zones/zone-1/dns_records=0' \
  'requests:PUT /zones/zone-1/dns_records/=0' \
  'jq:[.records[] | select(.type == "TXT")] | length == 1'

state '{zone:{id:"zone-1",name:"alia.onl"},
        records:[{id:"t1",type:"TXT",name:"alia.onl",content:"v=spf1 include:legacy.example ~all",proxied:false,ttl:1},
                 {id:"t2",type:"TXT",name:"alia.onl",content:"google-site-verification=abc",proxied:false,ttl:1}],
        projects:{}}'
attempt bash "$set_spf" alia.onl alia.onl 'v=spf1 -all'
check 'a stale SPF value is replaced and the verification record beside it is not' 0 \
  'says:replacing TXT alia.onl -> v=spf1 include:legacy.example ~all' \
  'jq:.records[] | select(.id == "t1") | .content == "v=spf1 -all"' \
  'jq:.records[] | select(.id == "t2") | .content == "google-site-verification=abc"'

state '{zone:{id:"zone-1",name:"alia.onl"},
        records:[{id:"t1",type:"TXT",name:"alia.onl",content:"v=spf1 -all",proxied:false,ttl:1},
                 {id:"t2",type:"TXT",name:"alia.onl",content:"v=spf1 include:other ~all",proxied:false,ttl:1}],
        projects:{}}'
attempt bash "$set_spf" alia.onl alia.onl 'v=spf1 -all'
check 'two SPF records stop it rather than letting it choose' 1 \
  'says:publishes 2 SPF records' \
  'jq:[.records[] | select(.type == "TXT")] | length == 2'

state "$APEX_SPF_ONLY"
attempt bash "$set_spf" alia.onl alia.onl 'alia-app.pages.dev'
check 'a value that is not an SPF record is refused before any call' 1 \
  'says:is not an SPF record' \
  'requests:PUT=0' \
  'requests:POST=0'

state "$APEX_WITH_SPF"
CF_STUB_FAULT=write-noop attempt bash "$set_spf" alia.onl alia.onl 'v=spf1 include:mail.example -all'
check 'an SPF write that reports success and changes nothing fails the read-back' 1 \
  'says:reads' \
  'jq:.records[] | select(.id == "t1") | .content == "v=spf1 -all"'

# ===========================================================================
# The way back out of the window (#443), across the seam this change moved
# ===========================================================================

# The restore step cannot ask Cloudflare what used to be at a name, so the
# delete writes it down first. That file is now produced inside the shared
# script instead of beside the delete loop, which makes the two steps a seam —
# and a seam is a thing to run end to end rather than assert either half of.
CUT_STEP=$(extract_run migrate-pages-to-worker.yml 'Delete the DNS records so the Worker can write its own')
RESTORE_STEP=$(extract_run migrate-pages-to-worker.yml 'Put the hostname back if the cutover did not finish')
grep -q 'cloudflare-clear-address-records.sh' <<<"$CUT_STEP" \
  || { echo "the cutover delete no longer calls the shared script" >&2; exit 1; }
grep -q 'deleted-records.json' <<<"$RESTORE_STEP" \
  || { echo "the restore step no longer reads the recorded records" >&2; exit 1; }

cutover_env=(HOSTNAME=alia.onl ZONE=alia.onl PAGES_PROJECT=alia-app
             CLOUDFLARE_API_TOKEN=stub-token CLOUDFLARE_ACCOUNT_ID=stub-account)

state "$APEX_WITH_SPF"
KEEP=""
attempt_block "$CUT_STEP" "${cutover_env[@]}"
check 'the delete writes down the address records, and only those' 0 \
  'says:recorded for restore: ["CNAME -> alia-app.pages.dev"]' \
  'file:/tmp/deleted-records.json:length == 1' \
  'file:/tmp/deleted-records.json:.[0] | .type == "CNAME" and .content == "alia-app.pages.dev" and .proxied == true' \
  'file:/tmp/deleted-records.json:[.[] | select(.type == "TXT")] | length == 0'
KEEP=/tmp/deleted-records.json

# The window: the record is gone, the Worker never claimed the hostname, the
# site answers nothing. This is the fifteen minutes.
jq '.projects = {"alia-app": {domains: [], deployments: []}} | .worker_domains = []' \
  "$CF_STUB_STATE" > "$CF_STUB_STATE.t" && mv "$CF_STUB_STATE.t" "$CF_STUB_STATE"
CF_STUB_SITE_CODE=000 attempt_block "$RESTORE_STEP" "${cutover_env[@]}"
check 'a cutover that stopped inside the window puts the record back' 0 \
  'says:resolves to nothing' \
  'says:restoring CNAME -> alia-app.pages.dev' \
  'jq:[.records[] | select(.type == "CNAME" and .content == "alia-app.pages.dev")] | length == 1' \
  'jq:[.records[] | select(.type == "TXT" and .content == "v=spf1 -all")] | length == 1' \
  'jq:.projects["alia-app"].domains == ["alia.onl"]'

# The three conditions that must each end it as a no-op. A restore that undoes
# a cutover which worked is worse than no restore at all.
state "$APEX_WITH_SPF"
KEEP=""
attempt_block "$CUT_STEP" "${cutover_env[@]}"
KEEP=/tmp/deleted-records.json
jq '.projects = {"alia-app": {domains: [], deployments: []}} | .worker_domains = ["alia.onl"]' \
  "$CF_STUB_STATE" > "$CF_STUB_STATE.t" && mv "$CF_STUB_STATE.t" "$CF_STUB_STATE"
attempt_block "$RESTORE_STEP" "${cutover_env[@]}"
check 'a cutover the Worker completed is not undone' 0 \
  'says:the cutover got that far' \
  'jq:[.records[] | select(.type == "CNAME")] | length == 0' \
  'jq:.projects["alia-app"].domains == []'

state "$APEX_WITH_SPF"
KEEP=""
attempt_block "$CUT_STEP" "${cutover_env[@]}"
KEEP=/tmp/deleted-records.json
jq '.records += [{id:"c9",type:"CNAME",name:"alia.onl",content:"alia-app.pages.dev",proxied:true,ttl:1}]
    | .projects = {"alia-app": {domains: [], deployments: []}} | .worker_domains = []' \
  "$CF_STUB_STATE" > "$CF_STUB_STATE.t" && mv "$CF_STUB_STATE.t" "$CF_STUB_STATE"
attempt_block "$RESTORE_STEP" "${cutover_env[@]}"
check 'a hostname that already resolves is left alone' 0 \
  'says:it resolves, nothing to restore' \
  'jq:[.records[] | select(.type == "CNAME")] | length == 1'

state "$APEX_WITH_SPF"
KEEP=""
attempt_block "$RESTORE_STEP" "${cutover_env[@]}"
check 'a run that deleted nothing restores nothing' 0 \
  'says:no record was deleted' \
  'jq:.records | length == 2'

# ===========================================================================
# Retiring the Pages project
# ===========================================================================

pages_state() {
  jq -n --argjson n "$1" --argjson domains "$2" '{
    zone: {id:"zone-1", name:"alia.onl"},
    records: [],
    projects: {"alia-app": {domains: $domains, deployments: [range($n) | "dep-\(.)"]}}
  }' > "$CF_STUB_STATE"
}

pages_state 137 '[]'
attempt bash "$delete_project" alia-app
check 'a project of 137 deployments is paged through, purged and deleted' 0 \
  'says:too many deployments' \
  'says:deployments purged: 137 deleted' \
  'says:alia-app is gone' \
  'requests:DELETE /accounts/stub-account/pages/projects/alia-app/deployments/=137' \
  'jq:.projects == {}'

pages_state 3 '[]'
CF_STUB_FAULT=project-delete-noop attempt bash "$delete_project" alia-app
check 'a project delete that reports success and changes nothing fails the read-back' 1 \
  'says:still exists after a delete that reported success' \
  'jq:.projects["alia-app"] != null'

pages_state 4 '[]'
CF_STUB_429_FIRST=1 attempt bash "$delete_project" alia-app
check 'a rate-limited request is retried rather than read as a failure' 0 \
  'says:http=429' \
  'says:alia-app is gone'

pages_state 5 '["alia.onl"]'
attempt bash "$delete_project" alia-app
check 'a project still serving a custom domain is refused, untouched' 1 \
  'says:still serves alia.onl' \
  'requests:DELETE=0' \
  'jq:.projects["alia-app"].deployments | length == 5'

pages_state 6 '[]'
CF_STUB_FAULT=deployment-undeletable attempt bash "$delete_project" alia-app
check 'a deployment that will not delete stops the loop instead of spinning' 1 \
  'says:none of them could be deleted' \
  'jq:.projects["alia-app"].deployments | length == 6'

pages_state 40 '[]'
PAGES_RETIRE_DEADLINE_SECONDS=0 attempt bash "$delete_project" alia-app
check 'a spent budget is an error that says it is safe to re-run' 1 \
  'says:budget ran out' \
  'says:safe to run again' \
  'jq:.projects["alia-app"] != null'

pages_state 2 '[]'
attempt bash "$delete_project" no-such-project
check 'a project that does not exist is not an error' 0 \
  'says:does not exist' \
  'requests:DELETE=0'

# ===========================================================================
# Wiring: the fix has to be the code that runs
# ===========================================================================

# The property that the incident violated, stated so that correct code passes.
# `setup-mention-mcp-dns.yml` also takes `.result[0].id` from a record listing
# and PUTs over it — and is CORRECT, because its query is
# `dns_records?type=$type&name=$name`. The id can only be a record of the type
# it is about to write. What made the cutover and the recovery dangerous was
# indexing into a listing that had no `type=` at all, where position 0 is
# whichever record Cloudflare felt like returning first.
cases=$((cases + 1))
untyped=$(awk '
  FNR == 1 { pending = 0 }
  # A comment describing the defect is not the defect. Every file here explains
  # what went wrong, and matching that prose would make this green the day the
  # explanation is reworded and red for as long as it is accurate.
  /^[[:space:]]*#/ { next }
  {
    if (pending && FNR > at + 6) pending = 0
    # The index has to be read out of the file THAT query wrote. Without this
    # the check fires on any `.result[0]` that happens to sit nearby — the
    # enumeration step legitimately lists every type at a name, and reads
    # `.result[0].name_servers` of the ZONE lookup three lines later.
    if (pending && $0 ~ /\.result\[0\]/ && (out == "" || index($0, out) > 0)) {
      print FILENAME ":" at ": " text; pending = 0
    }
    if ($0 ~ /dns_records\?/ && $0 !~ /type=/) {
      pending = 1; at = FNR; text = $0; out = ""
      if (match($0, /-o [^ ]+/)) out = substr($0, RSTART + 3, RLENGTH - 3)
    }
  }
' "$repo"/.github/workflows/*.yml || true)
if [ -n "$untyped" ]; then
  failures=$((failures + 1))
  echo "FAIL  no workflow indexes into an untyped record listing"
  printf '        %s\n' "$untyped"
  echo "        \`?name=\` alone returns every type at the name. \`.result[0]\` on that is what deleted the apex CNAME and then overwrote the SPF record."
else
  echo "ok    no workflow indexes into an untyped record listing"
fi

# `bind-pages-domain.yml` deletes a DNS record itself and is the ONLY thing in
# `.github/workflows` allowed to, because it runs no action and so cannot reach
# a script. Exact in both directions: a second workflow growing its own delete
# is a failure, and this one losing its delete means it started delegating —
# which the extraction guard above would already have caught, but the two say it
# from opposite ends.
cases=$((cases + 1))
inline_delete=""
for workflow in "$repo"/.github/workflows/*.yml; do
  if grep -A2 -- '-X DELETE' "$workflow" | grep -qF dns_records; then
    inline_delete="$inline_delete$(basename "$workflow") "
  fi
done
if [ "$inline_delete" = "bind-pages-domain.yml " ]; then
  echo "ok    only the workflow that runs no action deletes a DNS record itself"
else
  failures=$((failures + 1))
  echo "FAIL  only the workflow that runs no action deletes a DNS record itself"
  echo "        found: ${inline_delete:-(none)}, expected: bind-pages-domain.yml"
  echo "        cloudflare-clear-address-records.sh owns this everywhere a checkout already exists."
fi

# The property the duplication is bought with. `bind-pages-domain.yml` runs no
# action at all — no checkout, no download, `curl` and `jq` and nothing else —
# so it still works when GitHub's content hosts are degraded, which this
# repository has seen and documented in its AGENTS.md. It is also the workflow
# reached for when the site is ALREADY down. The day someone adds a `uses:` to
# share one line of jq, the copy below stops being justified and this goes red.
cases=$((cases + 1))
if grep -q 'uses:' "$repo/.github/workflows/bind-pages-domain.yml"; then
  failures=$((failures + 1))
  echo "FAIL  the recovery workflow depends on nothing it has to download"
  printf '        %s\n' "$(grep -n 'uses:' "$repo/.github/workflows/bind-pages-domain.yml")"
  echo "        An action here turns 'I cannot download the repo' into 'I cannot repair DNS'."
else
  echo "ok    the recovery workflow depends on nothing it has to download"
fi

# ...and the price of that: two copies of the type filter, which may not drift.
# Byte for byte, spacing included, because "equivalent" is what two copies are
# right up until one of them is not. The floor matters as much as the equality:
# a reader that stopped finding filters would otherwise report a clean pass over
# nothing at all, which is what this check looks like when it silently breaks.
cases=$((cases + 1))
# Matched on the presence of AAAA inside a `select(...)`, NOT on the filter's
# exact spelling. Anchoring the pattern to the canonical text would make a copy
# that drifted invisible to the very check that exists to catch drift: it would
# stop matching, the count would fall to the copies that still agree, and the
# comparison would pass. Measured — respacing one copy left this green until the
# pattern stopped describing the answer it wanted.
mapfile -t filters < <(grep -rhoE 'select\([^)]*AAAA[^)]*\)' \
  "$repo"/.github/workflows "$repo"/.github/scripts | sort)
mapfile -t distinct < <(printf '%s\n' ${filters[@]+"${filters[@]}"} | sort -u)
if [ "${#filters[@]}" -lt 2 ]; then
  failures=$((failures + 1))
  echo "FAIL  every copy of the address-record filter is byte-identical"
  echo "        found ${#filters[@]} filter(s), expected at least 2 — the copies are the thing being compared"
elif [ "${#distinct[@]}" -ne 1 ]; then
  failures=$((failures + 1))
  echo "FAIL  every copy of the address-record filter is byte-identical"
  printf '        %s\n' ${distinct[@]+"${distinct[@]}"}
  printf '        %s\n' "$(grep -rn -E 'select\([^)]*AAAA[^)]*\)' "$repo"/.github/workflows "$repo"/.github/scripts | sed "s|$repo/||")"
else
  echo "ok    every copy of the address-record filter is byte-identical (${#filters[@]} copies)"
fi

for script in cloudflare-address-records.sh cloudflare-clear-address-records.sh cloudflare-set-spf.sh delete-pages-project.sh; do
  cases=$((cases + 1))
  if grep -rqF ".github/scripts/$script" "$repo/.github/workflows"; then
    echo "ok    $script is reachable from a workflow"
  else
    failures=$((failures + 1))
    echo "FAIL  $script is reachable from a workflow"
    echo "        nothing dispatches it, so these cases gate code that never runs"
  fi
done

echo
if [ "$failures" -gt 0 ]; then
  echo "test-cloudflare-cutover: $failures of $cases case(s) failed"
  exit 1
fi
echo "test-cloudflare-cutover: OK — $cases cases"
