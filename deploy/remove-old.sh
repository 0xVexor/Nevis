#!/bin/bash
# Removes the OLD Nevis (the nevis-beta container, its image, its data and its service files). Irreversible: there is no backup, by the owner's decision.
# Run it only after the new Nevis answers on the domain. The proxy network nevis-beta-ingress stays (the new service uses it).
set -uo pipefail
exec > >(tee /home/amirzad/nevis-remove-old.log) 2>&1
docker rm -f nevis-beta-app-1 || true
docker rmi nevis-sync:1.0.0-7a92dbf || true
systemctl disable --now nevis-sync 2>/dev/null || true
rm -f /etc/systemd/system/nevis-sync.service; systemctl daemon-reload
rm -rf /opt/nevis-beta /opt/nevis-beta-build-* /opt/nevis-sync /var/lib/nevis-sync /var/backups/nevis-sync /etc/nevis-sync.env /var/lib/nevis-deployment
echo "old Nevis removed"
docker ps --format '{{.Names}}' | grep -i nevis
