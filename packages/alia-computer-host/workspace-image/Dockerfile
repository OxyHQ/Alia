# The image every actor's computer runs: node, python3, git and bash, nothing
# that listens, run as uid 1000 with `/workspace` as its only writable mount.
#
# Adapted from OpenMuse `apps/computer/Dockerfile` (MIT, see ../NOTICE).
#
# The host refuses to attach to a container whose image is not EXACTLY the
# reference it was configured with (`ALIA_COMPUTER_IMAGE`, pinned by digest in
# production), so a rebuilt image takes effect only for containers created after
# the host is told about it. The entrypoint is `sleep infinity` on purpose: the
# container does nothing on its own; every process in it is a `docker exec` the
# host started, under `timeout`.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash python3 git coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/alia /workspace \
    && chown 1000:1000 /workspace

COPY files.py /opt/alia/files.py
RUN chmod 0555 /opt/alia/files.py

ENV HOME=/workspace LANG=C.UTF-8
WORKDIR /workspace
USER 1000:1000
VOLUME ["/workspace"]
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
