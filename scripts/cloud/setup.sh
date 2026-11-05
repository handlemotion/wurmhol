#!/bin/bash
# Claude Code cloud environment setup script for Wurmhol (from Omni). Paste this file, unchanged,
# into the environment's "Setup script" field on claude.ai.
#
# It installs machine tools only: it runs as root before Claude Code starts, and the resulting
# filesystem is snapshotted and reused, so nothing here keeps running and no secret is read.
# Every step is idempotent. Per-session work (`pnpm install`, local D1, env files from Doppler)
# lives in .claude/hooks/cloud-session-start.sh. Downloads are pinned and checksum-verified.
set -euo pipefail

[ "$(uname -m)" = "x86_64" ] || {
  echo "setup.sh: only linux x86_64 is pinned" >&2
  exit 1
}

install_tarball() {
  local url=$1 sha256=$2 tarball
  shift 2
  tarball="$(mktemp)"
  curl -fsSL --retry 3 -o "$tarball" "$url"
  echo "$sha256  $tarball" | sha256sum -c --quiet
  tar -xf "$tarball" "$@"
  rm -f "$tarball"
}

# Node, matching .nvmrc, beside the image's own; the SessionStart hook puts /opt/node/bin first.
node_version=26.13.0
node_sha256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$node_version" ]; then
  rm -rf /opt/node && mkdir -p /opt/node
  install_tarball "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" \
    "$node_sha256" -J -C /opt/node --strip-components=1
fi
export PATH="/opt/node/bin:$PATH"

# pnpm, matching package.json `packageManager`.
pnpm_version=12.16.1
if [ "$(/opt/node/bin/pnpm --version 2>/dev/null)" != "$pnpm_version" ]; then
  npm install -g --silent "pnpm@$pnpm_version"
fi

# Doppler CLI, from its GitHub release (cli.doppler.com is not on the default allowlist).
doppler_version=3.77.1
doppler_sha256=001f89a42629f9cb827cd86683c4c2dbf87c6299a8d6130643b98044bf5ed80a
if [ "$(doppler --version 2>/dev/null)" != "v$doppler_version" ]; then
  install_tarball \
    "https://github.com/DopplerHQ/cli/releases/download/$doppler_version/doppler_${doppler_version}_linux_amd64.tar.gz" \
    "$doppler_sha256" -z -C /usr/local/bin doppler
fi
