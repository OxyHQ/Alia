# ============================================
# Alia Integrations — Production Dockerfile
# ============================================
# Unified service: messaging gateways + bots + browser + terminal
# Includes: Node.js, Chromium (Playwright), JRE, signal-cli

# --- Stage 1: Builder ---
FROM node:22-bookworm-slim AS builder

# Install build tools for native modules (node-pty requires python3 + make + g++) and Bun
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl unzip git && \
    curl -fsSL https://bun.com/install -o /tmp/install-bun.sh && \
    bash /tmp/install-bun.sh && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm /tmp/install-bun.sh && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy root workspace files
COPY package.json bun.lock ./
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

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile --filter @alia/integrations

# Copy source
COPY apps/integrations/ ./apps/integrations/

# Build TypeScript
RUN bun run --filter @alia/integrations build

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# Install system dependencies:
# - curl: health checks
# - chromium: Playwright browser automation
# - default-jre-headless: signal-cli runtime
# - python3, make, g++: node-pty native build
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

# Copy root workspace files
COPY package.json bun.lock ./
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

# Install production dependencies only
RUN bun install --frozen-lockfile --production --filter @alia/integrations

# Copy built output from builder
COPY --from=builder /build/apps/integrations/dist ./apps/integrations/dist

# Create signal-cli data directory
RUN mkdir -p /app/signal-data && chown -R node:node /app

# Security: run as non-root
USER node

ENV NODE_ENV=production
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1

CMD ["node", "apps/integrations/dist/index.js"]
