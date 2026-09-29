#!/usr/bin/env bash
# Builds the MCP server Worker: installs dependencies, bundles src/ to a
# single minified ESM module, then generates ../../30-mcp/worker-script.yaml
# from that bundle. Deterministic: the same committed inputs always produce
# the same bundle and the same generated manifest (see scripts/bundle.mjs
# and scripts/generate-worker-script.mjs for exactly what "inputs" means).
#
# Node: uses `node` from PATH if present, otherwise downloads a pinned Node
# 22 LTS linux-x64 build (the musl build from unofficial-builds on Alpine),
# verified against its release's SHASUMS256.txt, into a cache directory
# outside this repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION="22.23.3"
if [[ -e /lib/ld-musl-x86_64.so.1 ]]; then
  NODE_DIST_NAME="node-v${NODE_VERSION}-linux-x64-musl"
  NODE_DIST_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}"
else
  NODE_DIST_NAME="node-v${NODE_VERSION}-linux-x64"
  NODE_DIST_URL="https://nodejs.org/dist/v${NODE_VERSION}"
fi
NODE_TARBALL="${NODE_DIST_NAME}.tar.xz"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/cloud-basis"
NODE_DIR="$CACHE_ROOT/$NODE_DIST_NAME"

log() { printf '%s\n' "$*" >&2; }

if command -v node >/dev/null 2>&1; then
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  log "build.sh: using node from PATH ($(node --version))"
else
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    log "build.sh: downloading node v${NODE_VERSION} (linux-x64) into $CACHE_ROOT"
    mkdir -p "$CACHE_ROOT"
    WORK_DIR="$(mktemp -d)"
    trap 'rm -rf "$WORK_DIR"' EXIT

    curl -fsSL -o "$WORK_DIR/$NODE_TARBALL" "$NODE_DIST_URL/$NODE_TARBALL"
    curl -fsSL -o "$WORK_DIR/SHASUMS256.txt" "$NODE_DIST_URL/SHASUMS256.txt"

    EXPECTED_SHA="$(grep " ${NODE_TARBALL}\$" "$WORK_DIR/SHASUMS256.txt" | cut -d ' ' -f 1)"
    if [[ -z "$EXPECTED_SHA" ]]; then
      log "build.sh: ${NODE_TARBALL} not listed in nodejs.org's SHASUMS256.txt"
      exit 1
    fi
    ACTUAL_SHA="$(sha256sum "$WORK_DIR/$NODE_TARBALL" | cut -d ' ' -f 1)"
    if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
      log "build.sh: node tarball checksum mismatch (expected $EXPECTED_SHA, got $ACTUAL_SHA)"
      exit 1
    fi

    tar -xJf "$WORK_DIR/$NODE_TARBALL" -C "$CACHE_ROOT"
    trap - EXIT
    rm -rf "$WORK_DIR"
  fi
  NODE_BIN_DIR="$NODE_DIR/bin"
  log "build.sh: using cached node v${NODE_VERSION} from $NODE_DIR"
fi

export PATH="$NODE_BIN_DIR:$PATH"

npm ci
node scripts/bundle.mjs
node scripts/generate-worker-script.mjs

log "build.sh: done"
