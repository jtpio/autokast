#!/usr/bin/env bash
# Builds a JupyterLite site with a fresh copy of the example workspace and serves it,
# so every recording starts from the same files. Needs jupyterlite-core and
# jupyterlite-pyodide-kernel on the PATH.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
port="${1:-8000}"
root="$(mktemp -d)"
cp -r "$here/../jupyterlab/workspace" "$root/work"

cd "$root"
jupyter lite build --contents work --output-dir site
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory site
