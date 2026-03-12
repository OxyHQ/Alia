#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.3.10}"
BUN_INSTALL="${BUN_INSTALL:-$ROOT_DIR/.bun}"

export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$PATH"

if [ ! -x "$BUN_INSTALL/bin/bun" ]; then
  mkdir -p "$BUN_INSTALL"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}"
  else
    echo "error: Bun bootstrap requires curl or wget" >&2
    exit 1
  fi
fi

exec "$BUN_INSTALL/bin/bun" "$@"
