# ============================================
# Alia Integrations — Production Dockerfile
# ============================================
# Unified service: messaging gateways + bots + browser + terminal
# Includes: Node.js, Chromium (Playwright), JRE, signal-cli

# --- Toolchain: bun + the compilers native modules (node-pty) build with ---
FROM node:22-bookworm-slim AS toolchain

# Install build tools for native modules (node-pty requires python3 + make + g++) and Bun
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl unzip git && \
    curl -fsSL https://bun.com/install -o /tmp/install-bun.sh && \
    bash /tmp/install-bun.sh && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/install-bun.sh && \
    rm -rf /var/lib/apt/lists/*

# Rewrite git+ssh:// to git+https:// so cloning works without SSH keys
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# --- Stage 1: Builder ---
FROM toolchain AS builder

WORKDIR /build

# Copy root workspace files
COPY package.json bun.lock ./
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

# Install all dependencies (including devDependencies for build).
# --frozen-lockfile is intentionally omitted: bun's frozen check reports false
# drift for this monorepo (re-resolves ^/~ transitive ranges against the live
# registry) even against a freshly regenerated bun.lock. bun.lock remains the
# resolution baseline. Matches packages/api/Dockerfile.
RUN bun install --filter @alia/integrations

# Copy source
COPY packages/integrations/ ./packages/integrations/

# Build TypeScript
RUN bun run --filter @alia/integrations build

# --- Production dependencies only ---
FROM toolchain AS production-deps

# Same install environment the runtime stage used to give this install.
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy root workspace files
COPY package.json bun.lock ./
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

# Install production dependencies only.
# See builder stage: --frozen-lockfile omitted due to bun's false-drift check.
RUN bun install --production --filter @alia/integrations

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# Install system dependencies:
# - curl: health checks
# - chromium: Playwright browser automation
# - default-jre-headless: signal-cli runtime
# - python3, make, g++: node-pty native build
# - git: required by bun for git dependencies (libsignal)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      unzip \
      chromium \
      default-jre-headless \
      python3 \
      make \
      g++ \
      ca-certificates \
      git \
      wget && \
    curl -fsSL https://bun.com/install -o /tmp/install-bun.sh && \
    bash /tmp/install-bun.sh && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/install-bun.sh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install signal-cli
ARG SIGNAL_CLI_VERSION=0.13.24
RUN wget -q "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" -O /tmp/signal-cli.tar.gz && \
    tar xf /tmp/signal-cli.tar.gz -C /opt/ && \
    ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli && \
    rm /tmp/signal-cli.tar.gz

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# The unprivileged "node" user owns /app and everything copied into it. Each
# COPY below sets the owner itself: a trailing `chown -R` over the installed
# tree rewrote every file into a second layer and shipped node_modules twice,
# which every Fargate task pulled on every rollout.
RUN chown node:node /app

# Production dependencies and the workspace manifests, built in `production-deps`
# on this same Debian/glibc base so native modules match.
COPY --from=production-deps --chown=node:node /app/ ./

# Copy built output from builder
COPY --from=builder --chown=node:node /build/packages/integrations/dist ./packages/integrations/dist

# The migrations, which are DATA and are therefore not in `dist`.
#
# `src/db/migrate.ts` resolves them as `join(__dirname, '..', '..', 'drizzle')`,
# which from `dist/db/` is `/app/packages/integrations/drizzle` — a path that did
# not exist in this image. Nothing noticed because nothing had ever run the
# migrator from a container: `drizzle-kit` is a devDependency and cannot be
# reached from here, and `db:migrate` is a `bun` script run against a developer's
# own checkout.
#
# It fails loudly rather than silently — @oxy.so/db's `readJournal` throws naming
# the missing path — but it fails at the one-shot migration task, i.e. after a
# full ARM64 build, on the step whose whole job is to run before the rollout.
#
# `packages/api/Dockerfile:116` is the control: it has always copied its own
# `drizzle` directory, for exactly this reason.
COPY --from=builder --chown=node:node /build/packages/integrations/drizzle ./packages/integrations/drizzle

# Create signal-cli data directory
RUN mkdir -p /app/signal-data && chown node:node /app/signal-data

# Security: run as non-root
USER node

ENV NODE_ENV=production
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1

CMD ["node", "packages/integrations/dist/index.js"]
