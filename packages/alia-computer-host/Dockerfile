# ============================================
# Alia computer host — the control API's image
# ============================================
# Built from the REPOSITORY ROOT (`docker build -f packages/alia-computer-host/Dockerfile .`),
# linux/arm64 for the Graviton host. Same shape as packages/api/Dockerfile:
# every workspace manifest is copied so bun can resolve the graph, only this
# workspace is installed.
#
# The image carries the Docker CLI (and nothing else of Docker): it drives the
# host's engine through the socket the systemd unit mounts. It never runs an
# actor's code itself — that happens in the workspace image, under gVisor.
#
# Runtime: Bun since 2026-10 (Node 22 before), on the same pinned oven/bun slim
# image (Debian/glibc) the dependencies are installed with. This process uses
# express, pino, postgres and `child_process.spawn('docker', …)`; it never loads
# playwright-core — only `dist/browser/worker-main.js` does, and that runs in
# the WORKSPACE image (workspace-image/Dockerfile), which stays on Node: it is
# also every actor's computer, where `node` is part of what an agent is given,
# and browser-isolation.ts starts the worker as /usr/local/bin/node.
# Measured on the built dist, Bun vs Node: /health and the ops drain answer,
# the Postgres store creates its tables, runDocker's stdin/stdout/stderr, exit
# codes, output cap, timeout and abort behave identically, and SIGTERM exits 0.
# Idle RSS ~60 MB on Bun against ~80 MB on Node.
#
# Rolling back to Node is reverting the change that made this switch. No
# command outside this file names the runtime: the systemd unit in oxy-infra
# (`alia-computer-host-userdata.sh`) runs the image's own CMD.

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
COPY packages/api/package.json ./packages/api/
COPY packages/app/package.json ./packages/app/
COPY packages/alia-chat/package.json ./packages/alia-chat/
COPY packages/alia-server/package.json ./packages/alia-server/
COPY packages/alia-canvas/package.json ./packages/alia-canvas/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/alia-codea/package.json ./packages/alia-codea/
COPY packages/alia-codea/webview-ui/package.json ./packages/alia-codea/webview-ui/
COPY packages/alia-cowork/package.json ./packages/alia-cowork/
COPY packages/alia-codea-cli/package.json ./packages/alia-codea-cli/
COPY packages/alia-computer-host/package.json ./packages/alia-computer-host/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN bun install --frozen-lockfile --filter "@alia/computer-host"
COPY packages/alia-computer-host/ ./packages/alia-computer-host/
RUN cd packages/alia-computer-host && ../../node_modules/.bin/tsc -p tsconfig.build.json

# Only the Docker CLI binary, from Docker's own image.
FROM docker:27-cli AS docker-cli

# The builder's own image: the exact Bun and libc the dependencies were
# installed against.
FROM oven/bun:${BUN_VERSION}-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/alia-computer-host/package.json ./packages/alia-computer-host/package.json
COPY --from=builder /build/packages/alia-computer-host/dist ./packages/alia-computer-host/dist
COPY packages/alia-computer-host/NOTICE ./packages/alia-computer-host/NOTICE

# Runs as root inside the container ONLY to reach the mounted Docker socket,
# whose group id differs per host; the systemd unit runs it with a read-only
# root filesystem, no added capabilities and no published port beyond 8080.
# Stated rather than inherited, so it does not depend on the base image's default.
USER root
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
# The image's entrypoint execs this, so Bun is PID 1 and receives the SIGTERM
# of the unit's `docker stop --time 15`. The `node` the base image puts on PATH
# is a symlink to bun: there is no Node in this image.
CMD ["bun", "packages/alia-computer-host/dist/index.js"]
