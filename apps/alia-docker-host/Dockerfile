FROM node:22-bookworm-slim AS builder

# Install Bun
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
# --frozen-lockfile is intentionally omitted: bun's frozen check reports false
# drift for this monorepo (re-resolves ^/~ transitive ranges against the live
# registry) even against a freshly regenerated bun.lock. bun.lock remains the
# resolution baseline. Matches apps/api/Dockerfile.
RUN bun install
COPY tsconfig.json ./
COPY src/ ./src/
RUN bunx tsc

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
# See builder stage: --frozen-lockfile omitted due to bun's false-drift check.
RUN bun install --production
COPY --from=builder /app/dist ./dist

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:9090/health || exit 1

CMD ["node", "dist/index.js"]
