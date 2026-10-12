#!/usr/bin/env bash
# Boot the built computer-host control API image with the SAME hardening the
# systemd unit in oxy-infra (`terraform-uswest2/files/alia-computer-host-userdata.sh`)
# applies — read-only root filesystem, a 16 MB noexec /tmp, every capability
# dropped, no-new-privileges, 256 pids, 512 MB — against a throwaway Postgres,
# and fail unless the image's runtime (Bun as PID 1, the image's own CMD) can:
#   1. refuse a production boot without DATABASE_URL with a NON-ZERO exit,
#   2. create its store and answer /health with 200 and the ops drain on 8081,
#      with no Docker socket mounted (the browser reset's `docker` call fails
#      and is logged, which is the spawn path working, not the engine),
#   3. run as Bun at PID 1, so the unit's `docker stop` SIGTERM reaches it,
#   4. exit 0 on that SIGTERM within the unit's 15 s.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway database)}"
NAME="alia-computer-host-smoke-$$"

HARDENING=(
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory 512m
  --network host
)
CONFIG=(
  -e ALIA_COMPUTER_IMAGE="oxy/alia-computer-workspace@sha256:$(printf '0%.0s' $(seq 64))"
  -e ALIA_COMPUTER_ALLOWED_ROLE_ARNS=arn:aws:iam::123456789012:role/oxy-alia-task
  -e ALIA_COMPUTER_DEPLOYMENT_ID=ci-smoke
)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. A refused boot must exit non-zero.
refused_log=$(mktemp)
set +e
timeout 60 docker run --rm "${HARDENING[@]}" "${CONFIG[@]}" "$IMAGE" >"$refused_log" 2>&1
refused=$?
set -e
if [ "$refused" = 0 ] || [ "$refused" = 124 ]; then
  cat "$refused_log" || true
  echo "::error::a production boot without DATABASE_URL exited $refused; it must exit non-zero, promptly"
  exit 1
fi
echo "Refused boot exited $refused."

# 2. The control API, from the image's own CMD.
docker run -d --name "$NAME" "${HARDENING[@]}" "${CONFIG[@]}" -e DATABASE_URL "$IMAGE" >/dev/null

ready=
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  docker logs "$NAME" || true
  echo "::error::the computer-host image never answered /health"
  exit 1
fi
drain=$(curl -fsS --max-time 10 -X POST http://127.0.0.1:8081/idle/drain)
if ! jq -e '.data.stop | type == "boolean"' <<<"$drain" >/dev/null; then
  echo "::error::the ops drain answered '$drain'"
  exit 1
fi

# 3. PID 1 must be Bun running the control API.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "bun packages/alia-computer-host/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'bun packages/alia-computer-host/dist/index.js'"
    exit 1
    ;;
esac

# 4. The unit stops it with `docker stop --time 15`.
docker stop -t 15 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
if [ "$exit_code" != 0 ]; then
  docker logs "$NAME" 2>&1 || true
  echo "::error::SIGTERM did not end in exit 0 (exit code $exit_code)"
  exit 1
fi

echo "Computer-host image smoke passed: refused boot non-zero, /health + ops drain under the unit's hardening, PID 1 = Bun, SIGTERM exit 0"
