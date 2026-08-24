#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"

cleanup() {
  rm -rf -- "$test_directory"
}
trap cleanup EXIT

index_digest="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
runtime_digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
config_digest="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
layer_digest="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

docker() {
  local reference="${*: -1}"
  printf '%s\n' "$reference" >>"$RESOLVER_TEST_LOG"

  if [[ "$reference" == *"@$index_digest" ]]; then
    if [[ "$RESOLVER_TEST_SCENARIO" == "index-unavailable" ]]; then
      echo "manifest unknown" >&2
      return 1
    fi
    if [[ "$RESOLVER_TEST_SCENARIO" == "duplicate-runtime" ]]; then
      jq -cn \
        --arg runtime "$runtime_digest" \
        '{
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            {digest: $runtime, platform: {os: "linux", architecture: "arm64"}},
            {digest: $runtime, platform: {os: "linux", architecture: "arm64"}}
          ]
        }'
      return 0
    fi
    jq -cn \
      --arg runtime "$runtime_digest" '
        {
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            {digest: $runtime, platform: {os: "linux", architecture: "arm64"}},
            {
              digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              platform: {os: "unknown", architecture: "unknown"},
              annotations: {"vnd.docker.reference.type": "attestation-manifest"}
            }
          ]
        }'
    return 0
  fi

  if [[ "$reference" == *"@$runtime_digest" ]]; then
    local runtime_count_file="${RESOLVER_TEST_LOG}.runtime-count"
    local runtime_count=0
    if [[ -f "$runtime_count_file" ]]; then
      runtime_count="$(<"$runtime_count_file")"
    fi
    runtime_count=$((runtime_count + 1))
    printf '%s\n' "$runtime_count" >"$runtime_count_file"

    if [[ "$RESOLVER_TEST_SCENARIO" == "runtime-unavailable-once" &&
          "$runtime_count" == "1" ]] ||
      [[ "$RESOLVER_TEST_SCENARIO" == "runtime-unavailable" ]]; then
      echo "manifest unknown" >&2
      return 1
    fi
    if [[ "$RESOLVER_TEST_SCENARIO" == "runtime-is-index" ]]; then
      printf '%s\n' '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}'
      return 0
    fi
    jq -cn \
      --arg config "$config_digest" \
      --arg layer "$layer_digest" '
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          config: {digest: $config},
          layers: [{digest: $layer}]
        }'
    return 0
  fi

  echo "unexpected reference: $reference" >&2
  return 1
}
export -f docker
export index_digest runtime_digest config_digest layer_digest

run_resolver() {
  local case_name="$1"
  local scenario="$2"
  local expected_status="$3"
  local case_directory="$test_directory/$case_name"
  mkdir -p "$case_directory"
  export RESOLVER_TEST_LOG="$case_directory/docker.log"
  export RESOLVER_TEST_SCENARIO="$scenario"

  local status=0
  IMAGE_REPOSITORY=registry.example/oxy/alia \
    INDEX_DIGEST="$index_digest" \
    MAX_ATTEMPTS=3 \
    POLL_INTERVAL_SECS=0 \
    bash "$repository_root/.github/scripts/resolve-ecr-platform-digest.sh" \
    >"$case_directory/output.log" \
    2>"$case_directory/error.log" || status=$?

  if [[ "$status" != "$expected_status" ]]; then
    echo "case $case_name exited $status, expected $expected_status" >&2
    cat "$case_directory/error.log" >&2
    exit 1
  fi
}

run_resolver happy-path healthy 0
grep -Fx "$runtime_digest" "$test_directory/happy-path/output.log" >/dev/null
[[ "$(wc -l <"$test_directory/happy-path/docker.log")" == "2" ]]

run_resolver bounded-readiness runtime-unavailable-once 0
grep -Fx "$runtime_digest" "$test_directory/bounded-readiness/output.log" >/dev/null
[[ "$(wc -l <"$test_directory/bounded-readiness/docker.log")" == "3" ]]
grep -F "Runtime manifest is not readable yet" "$test_directory/bounded-readiness/error.log" >/dev/null

run_resolver persistent-read-failure runtime-unavailable 1
[[ "$(grep -Fc "@$runtime_digest" "$test_directory/persistent-read-failure/docker.log")" == "3" ]]
grep -F "after 3 read attempts" "$test_directory/persistent-read-failure/error.log" >/dev/null

run_resolver duplicate-runtime duplicate-runtime 1
[[ "$(wc -l <"$test_directory/duplicate-runtime/docker.log")" == "1" ]]
grep -F "Expected exactly one valid linux/arm64 runtime descriptor" "$test_directory/duplicate-runtime/error.log" >/dev/null

run_resolver runtime-is-index runtime-is-index 1
grep -F "is not a runnable image manifest" "$test_directory/runtime-is-index/error.log" >/dev/null

run_resolver index-unavailable index-unavailable 1
[[ "$(wc -l <"$test_directory/index-unavailable/docker.log")" == "3" ]]

echo "ECR platform digest resolver tests passed (6 cases)."
