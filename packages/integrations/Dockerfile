# ============================================
# Alia Integrations — Production Dockerfile
# ============================================
# Unified service: messaging gateways + bots + browser + terminal
# Includes: Node.js, Chromium (Playwright), Java 21 (Temurin), signal-cli

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

# Install production dependencies only.
# See builder stage: --frozen-lockfile omitted due to bun's false-drift check.
RUN bun install --production --filter @alia/integrations

# node-pty has no linux prebuild, so its `install` script compiles it with
# node-gyp — and bun never runs that script here: the root `trustedDependencies`
# names a package, which REPLACES bun's default trust list rather than extending
# it, so node-pty landed with no `build/Release/pty.node` and
# `import('node-pty')` threw in every container. The build is run explicitly,
# on this stage's Debian/glibc and Node (the runtime's own base), with the
# node-gyp npm bundles; `post-install.js` then prunes the object files so only
# `pty.node` ships. Trusting node-pty in package.json instead would make every
# Linux `bun install` (CI, developers) need node-gyp on PATH.
RUN cd "$(dirname "$(node -p "require.resolve('node-pty/package.json', { paths: ['/app/packages/integrations'] })")")" && \
    node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild && \
    node scripts/post-install.js && \
    rm -rf /root/.cache/node-gyp && \
    cd /app/packages/integrations && node -e "require('node-pty')"

# --- Java 21 + signal-cli ---
# signal-cli 0.13.x needs Java 21 and bookworm's JRE is 17, so the runtime is
# Eclipse Temurin's, pinned by checksum per architecture.
#
# The upstream libsignal-client jar has no linux-aarch64 JNI library; the one
# embedded below comes from exquo/signal-libs-build (the build signal-cli's wiki
# points to), pinned to the libsignal version the jar is, and needs glibc 2.30.
# LIBSIGNAL_VERSION must follow SIGNAL_CLI_VERSION: the jar path below fails the
# build if they drift.
FROM toolchain AS signal-cli

ARG TARGETARCH
ARG TEMURIN_TAG=jdk-21.0.12.1+1
ARG TEMURIN_VERSION=21.0.12.1_1
ARG TEMURIN_SHA256_ARM64=14be1f35ebdbd1f6e8d57eb911a3ffb74d6d9aa255abc5daf2b1302002cf2cf2
ARG TEMURIN_SHA256_AMD64=2413149700df0f7d440500a84a8f764c535f21e5a5e87d38328b64eec2c5b500
ARG SIGNAL_CLI_VERSION=0.13.24
ARG SIGNAL_CLI_SHA256=5e0e37a662e2e64f87e7c5183a1b73628823b89590707c54e48b084be65dd43f
ARG LIBSIGNAL_VERSION=0.87.0
ARG LIBSIGNAL_SHA256_ARM64=25df41f49e90b803492de25b18c6c006fc488bd55891537beafd87bd234e2f00

COPY packages/integrations/docker/libsignal-jar.py /tmp/libsignal-jar.py

RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) jdk_arch=aarch64; java_arch=aarch64; jdk_sha="$TEMURIN_SHA256_ARM64" ;; \
      amd64) jdk_arch=x64; java_arch=amd64; jdk_sha="$TEMURIN_SHA256_AMD64" ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    tag="$(printf %s "$TEMURIN_TAG" | sed 's/+/%2B/')"; \
    curl -fsSL -o /tmp/jre.tar.gz "https://github.com/adoptium/temurin21-binaries/releases/download/${tag}/OpenJDK21U-jre_${jdk_arch}_linux_hotspot_${TEMURIN_VERSION}.tar.gz"; \
    echo "${jdk_sha}  /tmp/jre.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/java/openjdk; \
    tar xzf /tmp/jre.tar.gz -C /opt/java/openjdk --strip-components=1; \
    curl -fsSL -o /tmp/signal-cli.tar.gz "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz"; \
    echo "${SIGNAL_CLI_SHA256}  /tmp/signal-cli.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/signal-cli; \
    tar xzf /tmp/signal-cli.tar.gz -C /opt/signal-cli --strip-components=1; \
    jar="/opt/signal-cli/lib/libsignal-client-${LIBSIGNAL_VERSION}.jar"; \
    test -f "$jar" || { echo "signal-cli ${SIGNAL_CLI_VERSION} does not ship $jar; bump LIBSIGNAL_VERSION" >&2; exit 1; }; \
    if [ "$java_arch" = aarch64 ]; then \
      curl -fsSL -o /tmp/libsignal.tar.gz "https://github.com/exquo/signal-libs-build/releases/download/libsignal_v${LIBSIGNAL_VERSION}/libsignal_jni.so-v${LIBSIGNAL_VERSION}-aarch64-unknown-linux-gnu.tar.gz"; \
      echo "${LIBSIGNAL_SHA256_ARM64}  /tmp/libsignal.tar.gz" | sha256sum -c -; \
      tar xzf /tmp/libsignal.tar.gz -C /tmp libsignal_jni.so; \
      python3 /tmp/libsignal-jar.py "$jar" aarch64 /tmp/libsignal_jni.so; \
    else \
      python3 /tmp/libsignal-jar.py "$jar" "$java_arch"; \
    fi; \
    rm -f /tmp/*.tar.gz /tmp/libsignal_jni.so

# --- Stage 2: Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# Install system dependencies:
# - curl: health checks
# - chromium: Playwright browser automation
# Nothing is compiled or installed with bun here: node_modules (with node-pty's
# native build) comes from `production-deps`, Java and signal-cli from
# `signal-cli`.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      chromium \
      ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
COPY --from=signal-cli /opt/java/openjdk /opt/java/openjdk
COPY --from=signal-cli /opt/signal-cli /opt/signal-cli
RUN ln -s /opt/signal-cli/bin/signal-cli /usr/local/bin/signal-cli

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

# Create signal-cli data directory, and fail the build rather than the feature
# if the pty binding, Java or signal-cli cannot load. node-pty is resolved from
# the package, as `dist/` resolves it: the image's install uses bun's isolated
# linker (bunfig.toml is not in the build context), so /app/node_modules has no
# top-level node-pty.
RUN mkdir -p /app/signal-data && chown node:node /app/signal-data && \
    cd packages/integrations && node -e "require('node-pty')" && \
    java -version && \
    signal-cli --version

# Security: run as non-root
USER node

ENV NODE_ENV=production
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3005/health || exit 1

CMD ["node", "packages/integrations/dist/index.js"]
