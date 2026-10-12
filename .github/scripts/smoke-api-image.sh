#!/usr/bin/env bash
# Boot the built API image the way ECS runs it, against a throwaway Postgres,
# and fail unless the production runtime (Bun as PID 1, the image's own user,
# entrypoint and CMD) can:
#   1. refuse a misconfigured boot with a NON-ZERO exit (ECS reads the code),
#   2. apply the migrator with the commands the deploy runs (`all` once, since
#      the database is empty, then the deploy's own `pre` and `post`), and run
#      deploy-aws.yml's post-rollout command shape (`/bin/sh -c 'bun ... && bun ...'`),
#   3. serve /health/ready with 200 from the image's default CMD,
#   4. answer the socket.io engine handshake and the `/ws/mcp` WebSocket upgrade
#      on the same server (the noServer upgrade router in lib/mcp-relay.ts),
#   5. run as Bun at PID 1, so SIGTERM reaches the process itself,
#   6. turn SIGTERM (`docker stop`, as ECS does on a rollout) into the graceful
#      shutdown and exit 0.
# A unit suite cannot see any of these: they are properties of the image.
set -euo pipefail

: "${IMAGE:?IMAGE required}"
: "${DATABASE_URL:?DATABASE_URL required (a throwaway database named alia)}"
PORT="${PORT:-3001}"
NAME="alia-api-smoke-$$"

# Placeholder Oxy credentials: the boot guard requires the variables, nothing
# here authenticates. api.oxy.so is pinned to loopback so no background service
# in the container talks to the real Oxy with them.
RUN_ARGS=(
  --network host
  --add-host api.oxy.so:127.0.0.1
  -e DATABASE_URL
  -e PORT="$PORT"
  -e OXY_API_URL=https://api.oxy.so
  -e OXY_SERVICE_API_KEY=ci-smoke
  -e OXY_SERVICE_API_SECRET=ci-smoke
)

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 1. A refused boot must exit non-zero. No DATABASE_URL: the first boot guard.
refused_log=$(mktemp)
set +e
timeout 60 docker run --rm --network host -e DATABASE_URL= "$IMAGE" >"$refused_log" 2>&1
refused=$?
set -e
if [ "$refused" = 0 ] || [ "$refused" = 124 ]; then
  cat "$refused_log" || true
  echo "::error::a boot without DATABASE_URL exited $refused; it must exit non-zero, promptly"
  exit 1
fi
echo "Refused boot exited $refused."

# 2. Migrations and the seeder, as the deploy runs them.
for phase in all pre post; do
  docker run --rm "${RUN_ARGS[@]}" "$IMAGE" \
    bun packages/api/dist/db/migrate.js --target-database=alia --phase="$phase"
done
docker run --rm "${RUN_ARGS[@]}" "$IMAGE" /bin/sh -c \
  'bun packages/api/dist/db/migrate.js --target-database=alia --phase=post && bun packages/api/dist/scripts/seed.js --target-database=alia'

# 3. The server, from the image's own CMD.
docker run -d --name "$NAME" "${RUN_ARGS[@]}" "$IMAGE" >/dev/null

ready=
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; then
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
  echo "::error::the API image never answered /health/ready"
  exit 1
fi

# 4. Both upgrade consumers on the one server.
handshake=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/socket.io/?EIO=4&transport=polling")
case "$handshake" in
  0\{\"sid\":*) ;;
  *)
    echo "::error::socket.io engine handshake answered '$handshake'"
    exit 1
    ;;
esac
upgrade=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "http://127.0.0.1:$PORT/ws/mcp" 2>/dev/null || true)
if [ "$upgrade" != 101 ]; then
  echo "::error::the /ws/mcp WebSocket upgrade answered '$upgrade', expected 101"
  exit 1
fi

# 5. PID 1 must be Bun running the bundle: the entrypoint execs the CMD, so a
# wrapper shell left at PID 1 would swallow the SIGTERM tested below.
pid1=$(docker exec "$NAME" cat /proc/1/cmdline | tr '\0' ' ')
case "$pid1" in
  "bun packages/api/dist/index.js "*) ;;
  *)
    echo "::error::PID 1 is '$pid1', expected 'bun packages/api/dist/index.js'"
    exit 1
    ;;
esac

# 6. Graceful SIGTERM. 35 s is above index.ts's 30 s force-exit, so a timeout
# here is the process hanging, not docker giving up early.
docker stop -t 35 "$NAME" >/dev/null
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
logs=$(docker logs "$NAME" 2>&1)
if [ "$exit_code" != 0 ] || ! grep -q 'Graceful shutdown complete' <<<"$logs"; then
  printf '%s\n' "$logs"
  echo "::error::SIGTERM did not end in a graceful exit 0 (exit code $exit_code)"
  exit 1
fi

echo "API image smoke passed: refused boot non-zero, migrations + seed, /health/ready, socket.io + /ws/mcp upgrades, PID 1 = Bun, graceful SIGTERM"
