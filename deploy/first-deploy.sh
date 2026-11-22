#!/bin/bash
# The first, manual deploy on vexor-server (run as root): loads the image, starts Nevis on the existing proxy network, and prints what is left.
# It never touches the old service; removing that is deploy/remove-old.sh, run after the new one answers on the domain.
set -euo pipefail
exec > >(tee /home/amirzad/nevis-setup.log) 2>&1
IMAGE_TAR="${1:-/home/amirzad/nevis-next-0.1.0.tar.gz}"
docker load -i "$IMAGE_TAR"
install -d -m 700 /opt/nevis
install -d -o 65532 -g 65532 -m 700 /var/lib/nevis
if [ ! -f /opt/nevis/.env ]; then
  umask 077
  { echo "SESSION_SECRET=$(openssl rand -hex 32)"; echo "INVITE_CODES=$(openssl rand -hex 8)"; echo "REGISTRATION=invite"; } > /opt/nevis/.env
fi
cat > /opt/nevis/compose.yaml <<'EOF'
name: nevis
services:
  app:
    image: nevis-next:0.1.0
    pull_policy: never
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    cpus: 1
    mem_limit: 768m
    pids_limit: 100
    env_file: /opt/nevis/.env
    environment:
      DATA_DIR: /data
      WEB_DIR: /web
      LISTEN_HOST: 0.0.0.0
      PORT: "8787"
    volumes:
      - /var/lib/nevis:/data
    networks: [ingress]
networks:
  ingress:
    external: true
    name: nevis-beta-ingress
EOF
docker compose -f /opt/nevis/compose.yaml up -d
sleep 4
IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "nevis-beta-ingress").IPAddress}}' nevis-app-1)"
echo "container nevis-app-1 at $IP"; curl -s "http://$IP:8787/v1/health"; echo
echo "INVITE CODE: $(grep ^INVITE_CODES= /opt/nevis/.env | cut -d= -f2)"
echo "NEXT: point the proxy's nevis-public-beta.yaml service at http://nevis-app-1:8787"
