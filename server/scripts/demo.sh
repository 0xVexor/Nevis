#!/usr/bin/env bash
# M4 demo: builds the web app and the Go server, starts ONE server that serves both (same origin, as in production), prints the URL.
#   server/scripts/demo.sh            -> http://localhost:8788   (open registration, small proof of work, data in a temp folder)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
PNPM="${PNPM:-corepack pnpm}"
( cd "$root" && $PNPM --filter web build )
[ -f "$root/apps/web/dist/index.html" ] || { echo "the web build produced no dist/index.html" >&2; exit 1; }
tmp="$(mktemp -d)"
( cd "$root/server" && go build -o "$tmp/nevis-server" ./cmd/nevis-server )
echo "data: $tmp/data   (delete the folder to start clean)"
echo "open: http://localhost:${PORT:-8788}   (sign up on the page; the recovery key is shown once)"
PORT="${PORT:-8788}" LISTEN_HOST=127.0.0.1 DATA_DIR="$tmp/data" WEB_DIR="$root/apps/web/dist" REGISTRATION=open POW_BITS=8 \
  SESSION_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)" exec "$tmp/nevis-server"
