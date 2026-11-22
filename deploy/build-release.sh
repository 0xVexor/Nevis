#!/usr/bin/env bash
# Builds what goes on a server: the web app (static files) and the server binary for Linux (amd64 and arm64), in one folder.
#   deploy/build-release.sh [version]      → release/nevis-<version>/  and  release/nevis-<version>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(git describe --tags --always 2>/dev/null || echo dev)}"
OUT="release/nevis-$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT/web" "$OUT/bin"
corepack pnpm --filter web build
cp -R apps/web/dist/. "$OUT/web/"
for arch in amd64 arm64; do
  (cd server && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags="-s -w" -o "../$OUT/bin/nevis-server-linux-$arch" ./cmd/nevis-server)
done
cp deploy/nevis.service deploy/Caddyfile deploy/docker-compose.yml deploy/Dockerfile deploy/env.example deploy/backup.sh "$OUT/" 2>/dev/null || true
cp docs/deploy.md "$OUT/DEPLOY.md" 2>/dev/null || true
tar -C release -czf "release/nevis-$VERSION.tar.gz" "nevis-$VERSION"
echo "built $OUT and release/nevis-$VERSION.tar.gz"
