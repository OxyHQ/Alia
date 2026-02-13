# ============================================
# Alia Integrations — Production Dockerfile
# ============================================
# Unified service: messaging gateways + bots + browser + terminal
# Includes: Node.js, Chromium (Playwright), JRE, signal-cli

# --- Stage 1: Builder ---
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/integrations/package.json ./apps/integrations/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=apps/integrations

# Copy source
COPY apps/integrations/ ./apps/integrations/

# Build TypeScript
RUN npm run build --workspace=apps/integrations

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
      chromium \
      default-jre-headless \
      python3 \
      make \
      g++ \
      ca-certificates \
      wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install signal-cli
ARG SIGNAL_CLI_VERSION=0.13.12
RUN wget -q "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz" -O /tmp/signal-cli.tar.gz && \
    tar xf /tmp/signal-cli.tar.gz -C /opt/ && \
    ln -s "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli && \
    rm /tmp/signal-cli.tar.gz

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/integrations/package.json ./apps/integrations/

# Install production dependencies only
RUN npm ci --workspace=apps/integrations --omit=dev

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
