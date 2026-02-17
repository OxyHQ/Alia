FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

USER node

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:9090/health || exit 1

CMD ["node", "dist/index.js"]
