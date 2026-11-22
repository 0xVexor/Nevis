#!/usr/bin/env bash
# A copy of everything the server keeps, to another folder (run it from cron, e.g. every night; the server itself also takes a daily
# database backup into DATA_DIR/backup and keeps the last 14). Usage:  backup.sh /var/lib/nevis /mnt/backups/nevis
set -euo pipefail
DATA="${1:?data dir}"; DEST="${2:?destination dir}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$DEST/$STAMP"
# a consistent copy of the database taken now (safe while the server runs); BIN is the nevis-server binary
BIN="${NEVIS_BIN:-/opt/nevis/bin/nevis-server}"
DATA_DIR="$DATA" "$BIN" backup "$DEST/$STAMP" >/dev/null
LATEST="$(ls -1 "$DEST/$STAMP"/nevis-*.db | tail -1)"
mv "$LATEST" "$DEST/$STAMP/nevis.db"
# attachments: files named by their content, so copying only adds
[ -d "$DATA/blobs" ] && rsync -a "$DATA/blobs/" "$DEST/blobs/" || true
echo "backed up the database and the attachments into $DEST ($STAMP)"
