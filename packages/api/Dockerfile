# ============================================
# Alia API - Production Dockerfile
# ============================================
# Multi-stage build, multi-arch (linux/amd64 + linux/arm64 / AWS Graviton).
#
# - oven/bun is pinned to the version in the root package.json's
#   "packageManager" field for reproducible installs; scripts/check-bun-pin.mjs
#   fails CI when they disagree.
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
# - The runtime image is the SAME pinned oven/bun slim image (Debian/glibc) the
#   dependencies were installed with, and runs as its non-root `bun` user.
#
# Runtime: Bun since 2026-10 (Node 22 before). Bun runs the same esbuild bundle
# (ESM, platform=node) unchanged. Measured on the built dist against Postgres 17
# and Redis, Bun vs Node side by side: all migrator phases and the seeder apply,
# /health/ready answers 200, socket.io (polling and websocket) and the
# `/ws/mcp` noServer upgrade router share the server exactly as on Node, SSE
# frames arrive unbuffered, a client disconnect fires `res.on('close')`, multer
# uploads parse, BullMQ workers and the socket.io Redis adapter start and stop,
# the provider egress block refuses fetch/http(s).request/get, the 65 s
# keep-alive closes an idle socket at 66 s on both, and SIGTERM ends in a
# graceful exit 0. Idle RSS: ~175 MB on Bun against ~330 MB on Node.
#
# One Node-only property does NOT carry over and is why `undici` is no longer a
# dependency: under Bun, `import { Agent } from 'undici'` is Bun's built-in stub
# and a `dispatcher` passed to fetch is ignored (measured: a lookup that refuses
# everything was never called). Nothing used it; see lib/public-host.ts.
#
# Rolling back to Node is reverting the change that made this switch: it
# restores the node:22-bookworm-slim runtime stage AND every one-shot command
# that names `bun` (MIGRATION_RUNTIME and the post-rollout command in
# deploy-aws.yml, production-chat-canary.yml).
# They must always name the runtime this image ships;
# `src/__tests__/dockerfileRuntime.test.ts` holds them together.

# Base image: oven/bun 1.4.3 (the root package.json's "packageManager"), slim.
# The DIGEST is what the build pulls; the tag is only for readers, and BuildKit
# ignores it when a digest is present. Both stages name the same reference, so
# the runtime is the exact Bun and libc the dependencies were installed with.
# A Bun bump needs the new tag's multi-arch index digest (linux/arm64 included)
# in BOTH lines, then a re-pin of `alia` in .github/scripts/reviewed-images.json,
# which is the owner's review of the new base.

# --- Stage 1: Install dependencies and build the API bundle ---
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS builder

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
# Not built here, and still required: `bun install` reads EVERY workspace
# manifest named in the root `workspaces` array before it resolves anything, so
# a member whose package.json is missing from the build context fails the
# install outright ("Workspace not found"), whatever `--filter` says.
COPY packages/alia-server/package.json ./packages/alia-server/
COPY packages/alia-canvas/package.json ./packages/alia-canvas/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/alia-codea/package.json ./packages/alia-codea/
COPY packages/alia-codea/webview-ui/package.json ./packages/alia-codea/webview-ui/
COPY packages/alia-cowork/package.json ./packages/alia-cowork/
COPY packages/alia-codea-cli/package.json ./packages/alia-codea-cli/
COPY packages/alia-computer-host/package.json ./packages/alia-computer-host/

# Skip heavy browser/desktop binaries pulled by unrelated workspaces.
# The API itself ships no browser and depends on neither Playwright nor
# Stagehand (its `browser` tool is Clarity-only); PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
# stays only because alia-cowork's postinstall runs `playwright install`.
# ffmpeg-static (declared in packages/api "trustedDependencies") still fetches its
# arch-specific binary so audio features work on the target architecture.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1

# Install only the @alia/api workspace and its transitive dependencies. This
# keeps the image lean and avoids building native modules from unrelated
# workspaces (e.g. node-pty in the Electron app) that are irrelevant to the API.
#
# --frozen-lockfile installs bun.lock verbatim or fails the build. It was left
# out while bun 1.3.14's frozen check falsely reported drift for this monorepo
# (it failed even on a freshly regenerated, idempotent bun.lock); on 1.4.3 this
# exact filtered install passes from a cold cache.
RUN bun install --frozen-lockfile --filter "@alia/api"

# Copy API source and build the bundle.
COPY packages/api/ ./packages/api/
# Build from the workspace directory rather than `bun run --filter`. With the
# hoisted linker + a filtered install, bun does not materialize
# apps/api/node_modules, and `bun run --filter` aborts trying to read it. Running
# the script in-place resolves esbuild up the tree to the root node_modules
# (which the hoisted install populated).
RUN cd packages/api && bun run build

# --- Stage 2: Production runtime ---
# The builder's own image: the runtime is the exact Bun and libc the dependency
# tree (ffmpeg-static's binary included) was installed against.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS runtime

# Runtime system libraries:
# - ca-certificates: outbound TLS (Redis TLS, Stripe, S3, Kaana and Oxy services).
# - curl: container HEALTHCHECK.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The unprivileged "bun" user (uid/gid 1000, as Node's "node" was) owns /app
# and everything copied into it. Each
# COPY below sets the owner itself: a trailing `chown -R` rewrote every file
# into a second layer and shipped the ~300 MB node_modules twice, which every
# Fargate task pulled on every rollout.
RUN chown bun:bun /app

# Dependencies (installed for the target architecture, hoisted to the root
# node_modules — this is what the externalized bundle resolves against).
COPY --from=builder --chown=bun:bun /build/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /build/package.json /build/bun.lock ./
COPY --from=builder --chown=bun:bun /build/packages/api/package.json ./packages/api/package.json

# Built application bundle.
COPY --from=builder --chown=bun:bun /build/packages/api/dist ./packages/api/dist

# The migration SQL and its journal.
#
# NOT optional and NOT covered by the line above: `dist/db/migrate.js` resolves
# `join(PACKAGE_ROOT, 'drizzle')` at runtime, where PACKAGE_ROOT is
# `/app/packages/api`. Without this the migrator starts fine and then dies with
#
#   Cannot read the migration journal at
#   /app/packages/api/drizzle/meta/_journal.json: ENOENT
#
# — which is what the first successful one-shot migration task actually hit,
# one layer below the `__dirname` defect that had been masking it. A bundler
# cannot inline these: they are data the migrator reads by path, not modules it
# imports, so `build.ts` will never pull them in however the entrypoint changes.
#
# `dockerfileShipsRuntimeData.test.ts` is the gate.
COPY --from=builder --chown=bun:bun /build/packages/api/drizzle ./packages/api/drizzle

# The system prompts.
#
# EXACTLY the same class as the line above, and missed for the same reason:
# `lib/prompt-loader.ts` resolves `join(__dirname, '../prompts', name + '.md')`
# at runtime, so these are data read by path and no bundler will inline them.
# Without this the running container logged, on EVERY request,
#
#   Error loading prompt  ENOENT: no such file or directory,
#   open '/app/packages/api/prompts/general-lite.md'
#   Error loading prompt  ENOENT: ... '/app/packages/api/prompts/base.md'
#
# and `loadPrompt` returns '' on failure, so production served with NO SYSTEM
# PROMPT AT ALL — degraded, never broken, and therefore invisible in every
# check that asks whether a request succeeded. Found in CloudWatch while
# tracing an unrelated failure, not by anything that was watching for it.
COPY --from=builder --chown=bun:bun /build/packages/api/prompts ./packages/api/prompts

# The same fact once more, for the skills Alia ships. `lib/skills/seed.ts`
# resolves `<package>/skills/<name>/SKILL.md` at runtime and the seed THROWS
# when the directory is absent — deliberately, because the alternative symptom
# is an empty Skills catalogue that reads as a product decision rather than as a
# missing COPY.
COPY --from=builder --chown=bun:bun /build/packages/api/skills ./packages/api/skills

# Security hardening: run as the unprivileged "bun" user shipped in the image.
USER bun

ENV NODE_ENV=production
# PORT is read at runtime. The app's own fallback is 4150 (src/index.ts), so the
# deployment must set PORT explicitly to match the 3001 documented here and used
# by the health check below.
EXPOSE 3001

# Liveness HEALTHCHECK — always 200 while the process is up, independent of
# database and Redis reachability. Honors $PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3001}/health/live" || exit 1

# The image's entrypoint execs this command, so Bun is PID 1 and receives
# SIGTERM itself; src/index.ts runs the graceful shutdown on it. Every one-shot
# that overrides this command names `bun` too. The base image puts a `node` on
# PATH, but it is a symlink to bun: there is no Node in this image, so
# `node <file>` would run Bun while claiming otherwise.
CMD ["bun", "packages/api/dist/index.js"]
