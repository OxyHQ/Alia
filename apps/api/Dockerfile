# ============================================
# Alia API - Production Dockerfile
# ============================================
# Multi-stage build for minimal image size
# Inspired by OpenClaw's security hardening patterns

# --- Stage 1: Builder ---
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=apps/api

# Copy API source
COPY apps/api/ ./apps/api/

# Build the API
RUN npm run build --workspace=apps/api

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# Install curl for health checks
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/

# Install production dependencies only
RUN npm ci --workspace=apps/api --omit=dev

# Copy built output from builder
COPY --from=builder /build/apps/api/dist ./apps/api/dist

# Allow non-root user to write temp files
RUN chown -R node:node /app

# Security hardening: Run as non-root user
# The node:22-bookworm-slim image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Health check for orchestrators (k8s, DO App Platform)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health/live || exit 1

CMD ["node", "apps/api/dist/index.js"]
