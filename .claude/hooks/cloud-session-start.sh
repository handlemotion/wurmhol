#!/bin/bash
# SessionStart hook (from Omni): readies Wurmhol's local stack in Claude Code cloud sessions. A
# no-op anywhere else (Claude Code sets CLAUDE_CODE_REMOTE=true only in cloud sessions).
#
# Puts Node (.nvmrc) on PATH, installs deps, writes apps/worker/.dev.vars from Doppler when
# DOPPLER_TOKEN_WORKER is set (else from the example, with a random local secret), and migrates
# the local D1. Idempotent. Secret values go to gitignored files only, never printed.
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
log=/tmp/wurmhol-session-start.log
: >"$log"
trap 'echo "wurmhol: session start failed; see $log" >&2' ERR

node_bin=/opt/node/bin
if [ "$("$node_bin/node" --version 2>/dev/null)" != "v$(cat .nvmrc)" ] || [ ! -x "$node_bin/pnpm" ]; then
  echo "wurmhol: Node $(cat .nvmrc) or pnpm missing from $node_bin; running scripts/cloud/setup.sh" >&2
  bash scripts/cloud/setup.sh >>"$log" 2>&1
fi
export PATH="$node_bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -qs "$node_bin" "$CLAUDE_ENV_FILE"; then
  echo "export PATH=\"$node_bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

pnpm install --frozen-lockfile >>"$log" 2>&1

# The token's Doppler config layered over the example (Doppler wins). Rewrites only a file this
# hook wrote, never a hand-made one.
marker="# Written by .claude/hooks/cloud-session-start.sh; rewritten each session."
target=apps/worker/.dev.vars
example=apps/worker/.dev.vars.example
if [ ! -e "$target" ] || head -1 "$target" | grep -qxF "$marker"; then
  secrets=""
  if [ -n "${DOPPLER_TOKEN_WORKER:-}" ]; then
    secrets="$(DOPPLER_TOKEN="$DOPPLER_TOKEN_WORKER" doppler secrets download --no-file --format env 2>>"$log")" ||
      echo "wurmhol: Doppler download failed (see $log); using the example" >&2
  fi
  (
    umask 077
    {
      echo "$marker"
      if [ -n "$secrets" ]; then
        keys="$(printf '%s\n' "$secrets" | cut -d= -f1 | paste -sd'|' -)"
        grep -vE "^(${keys})=" "$example" || true
        printf '%s\n' "$secrets"
      else
        sed "s/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" "$example"
      fi
    } >"$target"
  )
fi

(cd apps/worker && CI=1 pnpm exec wrangler d1 migrations apply wurmhol --local) >>"$log" 2>&1

echo "wurmhol: deps installed, local D1 migrated. \`pnpm stack:serve\` serves the app on :8787. Log: $log"
