#!/bin/bash
# Wurmhol: Claude Code cloud environment setup script, the reviewed source of truth. A one-repo
# environment pastes this file into its setup script field; a multi-repo environment's setup script
# runs every cloned repo's kickoff.sh, this one included, as root from that repo's root. So keep it
# self-contained, and pin shared paths (/opt/node, /usr/local/bin) to the same versions the other
# repos' scripts install (Omni's uses the same Node, pnpm, cf and Doppler).
#
# Machine tools only: it runs as root before Claude Code starts, the result is cached as a
# filesystem snapshot, and no secret is readable here. Every step is idempotent. Downloads are
# pinned and checksum-verified; to bump one, change the version and its sha256 from the release's
# published checksums.
set -euo pipefail

[ "$(uname -m)" = "x86_64" ] || {
  echo "kickoff.sh: only linux x86_64 is pinned" >&2
  exit 1
}

# install_tarball <url> <sha256> <tar args...>: download, verify, extract.
install_tarball() {
  local url=$1 sha256=$2 tarball
  shift 2
  tarball="$(mktemp)"
  curl -fsSL --retry 3 -o "$tarball" "$url"
  echo "$sha256  $tarball" | sha256sum -c --quiet
  tar -xf "$tarball" "$@"
  rm -f "$tarball"
}

# Node, matching .nvmrc, at /opt/node beside the image's own Node. Put /opt/node/bin first on PATH
# to use it.
node_version=26.13.0
node_sha256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$node_version" ]; then
  rm -rf /opt/node && mkdir -p /opt/node
  install_tarball "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" \
    "$node_sha256" -J -C /opt/node --strip-components=1
fi
export PATH="/opt/node/bin:$PATH"

# pnpm, matching package.json `packageManager`. Node 25+ no longer bundles corepack, so npm
# installs it into /opt/node/bin. Check that path, not PATH: an image's own pnpm can report the
# same version.
pnpm_version=12.16.1
if [ "$(/opt/node/bin/pnpm --version 2>/dev/null)" != "$pnpm_version" ]; then
  npm install -g --silent "pnpm@$pnpm_version"
fi

# Cloudflare CLI (`cf`), for inspecting the account. `wrangler` comes from the repo's deps.
cf_version=1.0.0-beta.26
npm ls -g "cf@$cf_version" >/dev/null 2>&1 || npm install -g --silent "cf@$cf_version"

# Doppler CLI, from its GitHub release.
doppler_version=3.77.1
doppler_sha256=001f89a42629f9cb827cd86683c4c2dbf87c6299a8d6130643b98044bf5ed80a
if [ "$(doppler --version 2>/dev/null)" != "v$doppler_version" ]; then
  install_tarball \
    "https://github.com/DopplerHQ/cli/releases/download/$doppler_version/doppler_${doppler_version}_linux_amd64.tar.gz" \
    "$doppler_sha256" -z -C /usr/local/bin doppler
fi

# gh-stack, the GitHub CLI extension for stacked PRs (`gh stack`), from its GitHub release. gh runs
# any executable at ~/.local/share/gh/extensions/gh-<name>/gh-<name> as `gh <name>`. The release
# publishes no checksum file; the sha256 is the downloaded asset's.
gh_stack_version=0.3.0
gh_stack_sha256=957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b
gh_stack_dir="${HOME:-/root}/.local/share/gh/extensions/gh-stack"
if [ "$("$gh_stack_dir/gh-stack" --version 2>/dev/null)" != "gh stack version $gh_stack_version" ]; then
  mkdir -p "$gh_stack_dir"
  curl -fsSL --retry 3 -o "$gh_stack_dir/gh-stack.tmp" \
    "https://github.com/github/gh-stack/releases/download/v$gh_stack_version/linux-amd64"
  echo "$gh_stack_sha256  $gh_stack_dir/gh-stack.tmp" | sha256sum -c --quiet
  chmod +x "$gh_stack_dir/gh-stack.tmp"
  mv "$gh_stack_dir/gh-stack.tmp" "$gh_stack_dir/gh-stack"
fi
