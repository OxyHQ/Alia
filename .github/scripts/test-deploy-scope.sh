#!/usr/bin/env bash
# Fixture tests for deploy-scope.sh. `gh` is replaced by a stub on PATH that
# answers each endpoint from FAKE_* variables (already in the shape the real
# `--jq` filter would print), so every decision can be driven both ways — in
# particular the ones that must NOT release, which are the ones that can lose
# a commit if they go wrong.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/deploy-scope.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

mkdir "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"/actions/workflows/"*"/runs"*"status=success"*)
    [[ "${FAKE_FAIL_CI:-}" == 1 ]] && exit 1
    printf '%s\n' "${FAKE_CI_COUNT:-0}" ;;
  *"/actions/workflows/"*"/runs"*)
    # Per-commit CI push runs: FAKE_CI_RUNS_FOR lists the commits that have one.
    [[ "${FAKE_FAIL_RUNS:-}" == 1 ]] && exit 1
    sha="$(grep -oE 'head_sha=[0-9a-f]{40}' <<<"$args" | cut -d= -f2)"
    if [[ " ${FAKE_CI_RUNS_FOR:-} " == *" $sha "* ]]; then echo 1; else echo 0; fi ;;
  *"/compare/"*".commits[]"*)
    [[ "${FAKE_FAIL_GATE_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_GATE_COMPARE" ;;
  *"/git/ref/heads/main"*)
    [[ "${FAKE_FAIL_HEAD:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_HEAD" ;;
  *"/actions/caches"*)
    [[ "${FAKE_FAIL_MARKER:-}" == 1 ]] && exit 1
    printf '%s\n' "${FAKE_MARKER:-}" ;;
  *"/compare/"*)
    [[ "${FAKE_FAIL_COMPARE:-}" == 1 ]] && exit 1
    printf '%s\n' "$FAKE_COMPARE" ;;
  *) echo "unexpected gh call: $args" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/gh"

sha=1111111111111111111111111111111111111111
older=2222222222222222222222222222222222222222
newer=3333333333333333333333333333333333333333
prefix=alia-release-api-
docs='(\.md$|^docs/)'
integrations='^(packages/integrations/|packages/[^/]+/package\.json$|bun\.lock$)'

failures=0
# run <expected exit> <expected output line or ''> <env...> -- <args...>
run() {
  local want_rc="$1" want_line="$2"
  shift 2
  local -a env=()
  while [[ "$1" != -- ]]; do
    env+=("$1")
    shift
  done
  shift
  local output="$work/output" rc=0
  : >"$output"
  env PATH="$work/bin:$PATH" RELEASE_SHA="$sha" GITHUB_REPOSITORY=OxyHQ/Alia \
    GITHUB_OUTPUT="$output" GH_TOKEN=x GITHUB_EVENT_NAME=workflow_run "${env[@]}" \
    bash "$script" "$@" >"$work/log" 2>&1 || rc=$?
  if [[ "$rc" != "$want_rc" ]] || { [[ -n "$want_line" ]] && ! grep -qxF "$want_line" "$output"; }; then
    echo "FAIL: $* (${env[*]}): exit $rc, output: $(tr '\n' ' ' <"$output")"
    sed 's/^/    /' "$work/log"
    failures=$((failures + 1))
  fi
}

# gate
run 0 current=true FAKE_HEAD=$sha -- gate
# main moved on to a commit whose CI runs: hold.
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n1\n%s' $newer)" \
  FAKE_CI_RUNS_FOR=$newer -- gate
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n2\n%s\n%s' $older $newer)" \
  FAKE_CI_RUNS_FOR=$older -- gate
# main moved on only by pushes that start no CI (auto-merge): release.
run 0 current=true FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n2\n%s\n%s' $older $newer)" \
  -- gate
# Anything that cannot prove the newer commits are CI-less: hold or fail.
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'diverged\n1\n%s' $newer)" -- gate
run 0 current=false FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n250\n%s' $newer)" -- gate
run 1 '' FAKE_HEAD=$newer FAKE_FAIL_GATE_COMPARE=1 -- gate
run 1 '' FAKE_HEAD=$newer "FAKE_GATE_COMPARE=$(printf 'ahead\n1\n%s' $newer)" FAKE_FAIL_RUNS=1 -- gate
run 1 '' FAKE_FAIL_HEAD=1 -- gate
run 1 '' GITHUB_EVENT_NAME=workflow_dispatch FAKE_CI_COUNT=0 FAKE_HEAD=$sha -- gate
run 1 '' GITHUB_EVENT_NAME=workflow_dispatch FAKE_FAIL_CI=1 FAKE_HEAD=$sha -- gate
run 0 current=true GITHUB_EVENT_NAME=workflow_dispatch FAKE_CI_COUNT=1 FAKE_HEAD=$sha -- gate
run 1 '' RELEASE_SHA=main FAKE_HEAD=$sha -- gate

# target: holds, each with its evidence
run 0 api=false FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n2\nREADME.md\ndocs/a.mdx')" \
  -- target api exclude "$docs" $prefix
run 0 api=false FAKE_MARKER=$prefix$sha "FAKE_COMPARE=$(printf 'identical\n0')" \
  -- target api exclude "$docs" $prefix
run 0 api=false FAKE_MARKER=$prefix$newer "FAKE_COMPARE=$(printf 'behind\n0')" \
  -- target api exclude "$docs" $prefix
run 0 integrations=false FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n1\npackages/app/x.ts')" \
  -- target integrations include "$integrations" $prefix

# target: releases
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n2\nREADME.md\npackages/api/src/x.ts')" \
  -- target api exclude "$docs" $prefix
run 0 integrations=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n2\npackages/app/x.ts\npackages/alia-chat/package.json')" \
  -- target integrations include "$integrations" $prefix
# A rename out of scope still counts the path it left.
run 0 integrations=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n1\nlegacy/x.ts\npackages/integrations/x.ts')" \
  -- target integrations include "$integrations" $prefix

# target: unsure, so release
run 0 api=true FAKE_MARKER= -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=${prefix}garbage -- target api exclude "$docs" $prefix
run 0 api=true FAKE_FAIL_MARKER=1 -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older FAKE_FAIL_COMPARE=1 -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'diverged\n1\nREADME.md')" \
  -- target api exclude "$docs" $prefix
run 0 api=true FAKE_MARKER=$prefix$older "FAKE_COMPARE=$(printf 'ahead\n300\nREADME.md')" \
  -- target api exclude "$docs" $prefix
run 0 api=true GITHUB_EVENT_NAME=workflow_dispatch FAKE_FAIL_MARKER=1 \
  -- target api exclude "$docs" $prefix

# usage errors
run 1 '' -- target api sideways "$docs" $prefix
run 1 '' -- target api exclude "$docs"
run 1 '' -- nonsense

if ((failures > 0)); then
  echo "test-deploy-scope: $failures case(s) failed"
  exit 1
fi
echo "test-deploy-scope: OK"
