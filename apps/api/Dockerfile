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
# - All apps/*/package.json manifests are copied first so bun can resolve the
#   workspace graph. Bun hoists real dependencies to the root node_modules;
#   that single tree is copied into the runtime image (esbuild externalizes
#   node_modules, so the bundle resolves against it at runtime).
# - The runtime image is a slim Node image and runs as a non-root user.

# Bun version pinned to "packageManager" in the root package.json for
# reproducible installs across build hosts / architectures.
ARG BUN_VERSION=1.3.10
ARG NODE_VERSION=22

# --- Stage 1: Install dependencies and build the API bundle ---
FROM oven/bun:${BUN_VERSION}-slim AS builder

WORKDIR /build

# Root manifests + lockfile first for better layer caching.
COPY package.json bun.lockb ./
# All workspace manifests (required so bun can resolve the workspace graph).
# Directory structure is preserved.
COPY apps/api/package.json ./apps/api/
COPY apps/app/package.json ./apps/app/
COPY apps/alia-chat/package.json ./apps/alia-chat/
COPY apps/alia-canvas/package.json ./apps/alia-canvas/
COPY apps/alia-docker-host/package.json ./apps/alia-docker-host/
COPY apps/integrations/package.json ./apps/integrations/
COPY apps/alia-console/package.json ./apps/alia-console/
COPY apps/alia-gateway-admin/package.json ./apps/alia-gateway-admin/
COPY apps/alia-codea/package.json ./apps/alia-codea/
COPY apps/alia-cowork/package.json ./apps/alia-cowork/
COPY apps/alia-codea-cli/package.json ./apps/alia-codea-cli/
COPY apps/alia-gateway/package.json ./apps/alia-gateway/

# Skip heavy browser/desktop binaries pulled by unrelated workspaces.
# ffmpeg-static (declared in apps/api "trustedDependencies") still fetches its
# arch-specific binary so audio features work on the target architecture.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# Install only the @alia/api workspace and its transitive dependencies. This
# keeps the image lean and avoids building native modules from unrelated
# workspaces (e.g. node-pty in the Electron app) that are irrelevant to the API.
#
# --frozen-lockfile is intentionally NOT used: bun's frozen check reports false
# drift for this mixed monorepo (root-level dependencies + overrides spanning 13
# workspaces) even against a freshly regenerated lockfile, on every bun version
# tested. bun.lockb remains the resolution baseline for locked versions.
RUN bun install --filter "@alia/api"

# Copy API source and build the bundle.
COPY apps/api/ ./apps/api/
RUN bun run --filter @alia/api build

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
COPY --from=builder /build/package.json /build/bun.lockb ./
COPY --from=builder /build/apps/api/package.json ./apps/api/package.json

# Built application bundle.
COPY --from=builder /build/apps/api/dist ./apps/api/dist

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

CMD ["node", "apps/api/dist/index.js"]
