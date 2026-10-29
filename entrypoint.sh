#!/bin/sh
set -eu

if [ "${ANGCHAT_CLOUD_DEPLOYMENT:-}" = "render" ]; then
  workspace=/data/workspace
  marker=/data/.angchat-workspace-seeded

  mkdir -p /data
  unset CHAT_WORKSPACE
  if [ ! -f "$marker" ]; then
    mkdir -p "$workspace"
    cp -a /app/. "$workspace/"
    printf '{"version":1,"path":"%s"}\n' "$workspace" > /data/workspace.local.json
    touch "$marker"
    chown -R node:node "$workspace" /data/workspace.local.json "$marker"
  fi
  chown node:node /data
fi

exec gosu node "$@"
