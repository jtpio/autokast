#!/usr/bin/env bash
# Starts JupyterLab for the example screencasts: no token, a fresh copy of the
# workspace and clean user settings, so every recording starts from the same state.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
port="${1:-8888}"
root="$(mktemp -d)"
cp -r "$here/workspace" "$root/work"
mkdir -p "$root/settings/@jupyterlab/apputils-extension"
echo '{ "fetchNews": "false", "checkForUpdates": false }' \
  > "$root/settings/@jupyterlab/apputils-extension/notification.jupyterlab-settings"

export JUPYTERLAB_SETTINGS_DIR="$root/settings"
export JUPYTERLAB_WORKSPACES_DIR="$root/workspaces"
exec jupyter lab --no-browser --allow-root --port "$port" \
  --IdentityProvider.token='' \
  --ServerApp.root_dir="$root/work"
