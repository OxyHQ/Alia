#!/usr/bin/env bash

set -euo pipefail

: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"
: "${INDEX_DIGEST:?INDEX_DIGEST is required}"

TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-arm64}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-2}"

digest_pattern='^sha256:[0-9a-f]{64}$'
if [[ ! "$INDEX_DIGEST" =~ $digest_pattern ]]; then
  echo "::error::INDEX_DIGEST is not a sha256 digest: $INDEX_DIGEST" >&2
  exit 1
fi
if ! [[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::MAX_ATTEMPTS must be a positive integer." >&2
  exit 1
fi
if ! [[ "$POLL_INTERVAL_SECS" =~ ^[0-9]+$ ]]; then
  echo "::error::POLL_INTERVAL_SECS must be a non-negative integer." >&2
  exit 1
fi

error_file="$(mktemp)"
cleanup() {
  rm -f "$error_file"
}
trap cleanup EXIT

inspect_raw() {
  local digest="$1"
  docker buildx imagetools inspect --raw "$IMAGE_REPOSITORY@$digest" 2>"$error_file"
}

index_json=''
for (( attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1 )); do
  if index_json="$(inspect_raw "$INDEX_DIGEST")"; then
    break
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "::error::Registry did not expose image index $INDEX_DIGEST after $MAX_ATTEMPTS read attempts." >&2
    cat "$error_file" >&2
    exit 1
  fi
  echo "::warning::Image index is not readable yet (attempt $attempt/$MAX_ATTEMPTS); waiting for registry propagation." >&2
  sleep "$POLL_INTERVAL_SECS"
done

if ! jq -e '
  .mediaType == "application/vnd.oci.image.index.v1+json" or
  .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json"
' <<<"$index_json" >/dev/null; then
  echo "::error::Build digest $INDEX_DIGEST is not an OCI index or Docker manifest list; provenance/runtime selection is ambiguous." >&2
  exit 1
fi

mapfile -t runtime_digests < <(jq -r \
  --arg os "$TARGET_OS" \
  --arg architecture "$TARGET_ARCH" '
    [
      .manifests[]?
      | select(.platform.os == $os and .platform.architecture == $architecture)
      | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
      | .digest
    ]
    | .[]
  ' <<<"$index_json")

if (( ${#runtime_digests[@]} != 1 )) ||
  [[ ! "${runtime_digests[0]:-}" =~ $digest_pattern ]]; then
  echo "::error::Expected exactly one valid $TARGET_OS/$TARGET_ARCH runtime descriptor in $INDEX_DIGEST; found ${#runtime_digests[@]}." >&2
  exit 1
fi
runtime_digest="${runtime_digests[0]}"

runtime_json=''
for (( attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1 )); do
  if runtime_json="$(inspect_raw "$runtime_digest")"; then
    break
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "::error::Registry did not expose runtime manifest $runtime_digest after $MAX_ATTEMPTS read attempts." >&2
    cat "$error_file" >&2
    exit 1
  fi
  echo "::warning::Runtime manifest is not readable yet (attempt $attempt/$MAX_ATTEMPTS); waiting for registry propagation." >&2
  sleep "$POLL_INTERVAL_SECS"
done

if ! jq -e --arg pattern "$digest_pattern" '
  (
    .mediaType == "application/vnd.oci.image.manifest.v1+json" or
    .mediaType == "application/vnd.docker.distribution.manifest.v2+json"
  ) and
  (.config.digest | type == "string" and test($pattern)) and
  (.layers | type == "array" and length > 0) and
  all(.layers[]; .digest | type == "string" and test($pattern))
' <<<"$runtime_json" >/dev/null; then
  echo "::error::Selected $TARGET_OS/$TARGET_ARCH descriptor $runtime_digest is not a runnable image manifest." >&2
  exit 1
fi

printf '%s\n' "$runtime_digest"
