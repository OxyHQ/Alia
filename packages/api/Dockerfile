# ============================================
# Alia API - Production Dockerfile
# ============================================
# Multi-stage build, multi-arch (linux/amd64 + linux/arm64 / AWS Graviton).
#
# - oven/bun is pinned to the version in the root package.json's
#   "packageManager" field for reproducible installs.
# - Only the @alia/api workspace is installed (via --filter), so the image
#   stays lean and unrelated workspaces' native builds (e.g. node-pty in the
#   Electron app) are never compiled.
# - All packages/*/package.json manifests are copied first so bun can resolve the
#   workspace graph. The root bunfig.toml sets `linker = "hoisted"`, so bun
#   flattens real dependencies into the root node_modules (instead of the
#   bun 1.3 default "isolated" linker, which keeps them under node_modules/.bun
#   and exposes them only via per-workspace symlinks). That single hoisted tree
#   is copied into the runtime image; esbuild externalizes node_modules, so the
#   bundle resolves bare imports (pino, express, …) against it at runtime.
# - The runtime image is a slim Node image and runs as a non-root user.

# Bun version pinned to "packageManager" in the root package.json for
# reproducible installs across build hosts / architectures.
ARG BUN_VERSION=1.3.10
ARG NODE_VERSION=22

# --- Stage 1: Install dependencies and build the API bundle ---
FROM oven/bun:${BUN_VERSION}-slim AS builder

WORKDIR /build

# Root manifests + lockfile + bunfig first for better layer caching.
# bunfig.toml carries `linker = "hoisted"`, which the install below relies on so
# runtime deps land in the root node_modules the runtime stage copies.
COPY package.json bun.lock bunfig.toml ./
# All workspace manifests (required so bun can resolve the workspace graph).
# Directory structure is preserved.
COPY packages/api/package.json ./packages/api/
COPY packages/app/package.json ./packages/app/
COPY packages/alia-chat/package.json ./packages/alia-chat/
COPY packages/alia-canvas/package.json ./packages/alia-canvas/
COPY packages/alia-docker-host/package.json ./packages/alia-docker-host/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/alia-console/package.json ./packages/alia-console/
COPY packages/alia-gateway-admin/package.json ./packages/alia-gateway-admin/
COPY packages/alia-codea/package.json ./packages/alia-codea/
COPY packages/alia-codea/webview-ui/package.json ./packages/alia-codea/webview-ui/
COPY packages/alia-cowork/package.json ./packages/alia-cowork/
COPY packages/alia-codea-cli/package.json ./packages/alia-codea-cli/
COPY packages/alia-gateway/package.json ./packages/alia-gateway/
COPY packages/shared-types/package.json ./packages/shared-types/

# Skip heavy browser/desktop binaries pulled by unrelated workspaces.
# ffmpeg-static (declared in packages/api "trustedDependencies") still fetches its
# arch-specific binary so audio features work on the target architecture.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# Install only the @alia/api workspace and its transitive dependencies. This
# keeps the image lean and avoids building native modules from unrelated
# workspaces (e.g. node-pty in the Electron app) that are irrelevant to the API.
#
# --frozen-lockfile is intentionally NOT used: bun's frozen check reports false
# drift for this mixed monorepo. It re-resolves ^/~ transitive ranges against
# the live registry and fails even on a freshly regenerated, idempotent
# bun.lock, on every bun version tested (through 1.3.14) and independent of the
# root `overrides` block. bun.lock remains the resolution baseline for locked
# versions.
RUN bun install --filter "@alia/api"

# Copy API source and build the bundle.
COPY packages/api/ ./packages/api/
# Build from the workspace directory rather than `bun run --filter`. With the
# hoisted linker + a filtered install, bun does not materialize
# apps/api/node_modules, and `bun run --filter` aborts trying to read it. Running
# the script in-place lets Node resolve esbuild up the tree to the root
# node_modules (which the hoisted install populated).
RUN cd packages/api && bun run build

# --- Stage 2: Production runtime ---
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Runtime system libraries:
# - ca-certificates: outbound TLS (MongoDB Atlas, Redis TLS, Stripe, S3, providers).
# - curl: container HEALTHCHECK.
# - libglib2.0-0: required by @livekit/rtc-node's native module (libgio /
#   libgobject / libglib) — loaded at startup, so the process crashes without it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl libglib2.0-0 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies (installed for the target architecture, hoisted to the root
# node_modules — this is what the externalized bundle resolves against).
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json /build/bun.lock ./
COPY --from=builder /build/packages/api/package.json ./packages/api/package.json

# Built application bundle.
COPY --from=builder /build/packages/api/dist ./packages/api/dist

# Security hardening: run as the unprivileged "node" user shipped in the image.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
# PORT is read at runtime (defaults to 3001 in the app). EXPOSE documents it.
EXPOSE 3001

# Liveness HEALTHCHECK — always 200 while the process is up, independent of
# MongoDB/Redis reachability. Honors $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3001}/health/live" || exit 1

CMD ["node", "packages/api/dist/index.js"]
