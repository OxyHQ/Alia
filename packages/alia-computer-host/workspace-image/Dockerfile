# The image every actor's computer runs — node, python3, git and bash, nothing
# that listens, run as uid 1000 with `/workspace` as its only writable mount —
# and, with a different entrypoint, the agents' browser and its egress proxy.
#
# Adapted from OpenMuse `apps/computer/Dockerfile` and `apps/worker/Dockerfile`
# (MIT, see ../NOTICE).
#
# Built from the REPOSITORY ROOT (`docker build -f packages/alia-computer-host/
# workspace-image/Dockerfile .`), linux/arm64 for the Graviton host, because the
# browser worker is compiled from `packages/alia-computer-host/src/browser/`.
#
# ONE image for the shell and the browser, on purpose: it is the image already
# pinned by digest in SSM and pulled by the host at every start, so the browser
# needed no new repository, no IAM change and no replacement of the instance
# (oxy-infra runbook 47). The cost is ~300 MB of Chromium on disk in the shell
# image, where it is inert: the shell has no network, and nothing in it starts
# a browser unless the agent does so itself.
#
# The host refuses to attach to a container whose image is not EXACTLY the
# reference it was configured with (`ALIA_COMPUTER_IMAGE`), so a rebuilt image
# takes effect only for containers created after the host is told about it.
# The default entrypoint is `sleep infinity`: a computer does nothing on its
# own; every process in it is a `docker exec` the host started, under `timeout`.
# The browser and egress containers name their own entrypoint
# (`src/browser-isolation.ts`).

ARG BUN_VERSION=1.3.10

FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
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
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN bun install --filter "@alia/computer-host"
COPY packages/alia-computer-host/ ./packages/alia-computer-host/
RUN cd packages/alia-computer-host && ../../node_modules/.bin/tsc -p tsconfig.build.json

FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash python3 git coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/alia/browser/node_modules /workspace \
    && chown 1000:1000 /workspace

# The browser worker and egress proxy: their compiled code and their only two
# runtime dependencies, at the lockfile's versions.
COPY --from=builder /build/node_modules/playwright-core /opt/alia/browser/node_modules/playwright-core
COPY --from=builder /build/node_modules/zod /opt/alia/browser/node_modules/zod
COPY --from=builder /build/packages/alia-computer-host/dist/browser /opt/alia/browser/dist/browser
RUN echo '{"type":"module","private":true}' > /opt/alia/browser/package.json

# Chromium's headless shell (no full browser, no Firefox/WebKit) and the system
# libraries and fonts it needs. PLAYWRIGHT_BROWSERS_PATH is set only for this
# step and in the browser container's environment — not in the image's, which
# every computer's isolation check reads (`isolation.ts` ALLOWED_ENV).
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/alia/ms-playwright \
      node /opt/alia/browser/node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /tmp/* \
    && chmod -R a+rX /opt/alia/ms-playwright /opt/alia/browser

COPY packages/alia-computer-host/workspace-image/files.py /opt/alia/files.py
RUN chmod 0555 /opt/alia/files.py

# No VOLUME: a computer always mounts its own workspace volume at /workspace,
# and a declared volume would give the browser containers an anonymous one.
ENV HOME=/workspace LANG=C.UTF-8
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
