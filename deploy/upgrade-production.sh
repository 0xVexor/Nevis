#!/usr/bin/env bash
# Update the manual production installation, optionally appending invitation codes.
set -Eeuo pipefail

if [[ ( $# != 3 && $# != 4 ) || $(id -u) != 0 || $(hostname -s) != vexor-server ]]; then
  echo "Run as root on vexor-server: $0 IMAGE_TAR VERSION WEB_ENTRY [INVITE_FILE]" >&2
  exit 2
fi

archive=$1
version=$2
web_entry=$3
invites=${4:-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $web_entry =~ ^assets/index-[A-Za-z0-9_-]+\.js$ ]]
image=nevis-next:$version
compose=/opt/nevis/compose.yaml
env_file=/opt/nevis/.env
domain=https://nevis.manaz.pro

umask 077
exec 9>/opt/nevis/.upgrade.lock
flock -n 9
[[ -f $compose && ! -L $compose && -f $env_file && ! -L $env_file && -s /var/lib/nevis/nevis.db ]]
[[ $(docker compose -f "$compose" config --images | wc -l) == 1 ]]
grep -qE '^    image: nevis-next:[0-9]+\.[0-9]+\.[0-9]+$' "$compose"
docker load -i "$archive"
[[ $(docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Config.User}}' "$image") == 'linux/amd64 65532:65532' ]]

workdir=$(mktemp -d /opt/nevis/.upgrade.XXXXXXXX)
switched=false
rollback() {
  local status=$?
  trap - EXIT
  if $switched; then
    echo 'Restoring the previous production configuration.' >&2
    install -m 600 "$workdir/compose.before" "$compose" &&
      install -m 600 "$workdir/env.before" "$env_file" &&
      docker compose -f "$compose" up -d --force-recreate app || exit 1
  fi
  rm -rf -- "$workdir"
  exit "$status"
}
trap rollback EXIT
cp -p "$compose" "$workdir/compose.before"
cp -p "$env_file" "$workdir/env.before"
sed -E "s|^    image: nevis-next:[0-9]+\.[0-9]+\.[0-9]+$|    image: $image|" "$compose" > "$workdir/compose.next"
[[ $(docker compose --project-directory /opt/nevis -f "$workdir/compose.next" config --images) == "$image" ]]
if [[ -n $invites ]]; then
  python3 - "$env_file" "$invites" "$workdir/env.next" <<'PY'
import re
import sys
from pathlib import Path

env, invites, output = map(Path, sys.argv[1:])
codes = invites.read_text().splitlines()
if len(codes) != 10 or len(set(codes)) != 10 or not all(re.fullmatch(r"[0-9a-f]{32}", code) for code in codes):
    sys.exit("Expected 10 distinct hexadecimal invitations")

settings = env.read_text()
if re.findall(r"^REGISTRATION=(.*)$", settings, flags=re.M) != ["invite"]:
    sys.exit("Expected invite-only registration")
existing = re.findall(r"^INVITE_CODES=(.*)$", settings, flags=re.M)
if len(existing) != 1 or not re.fullmatch(r"[A-Za-z0-9,_-]*", existing[0]):
    sys.exit("Unexpected existing invitation configuration")
updated = ",".join(dict.fromkeys(filter(None, existing[0].split(",") + codes)))
output.write_text(re.sub(r"^INVITE_CODES=.*$", "INVITE_CODES=" + updated, settings, count=1, flags=re.M))
PY
fi

switched=true
install -m 600 "$workdir/compose.next" "$compose"
if [[ -n $invites ]]; then
  install -m 600 "$workdir/env.next" "$env_file"
fi
docker compose -f "$compose" up -d --force-recreate app

ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 4 "$domain/v1/health" -o "$workdir/health" &&
    grep -q '"ok":true' "$workdir/health" && grep -q '"registration":"invite"' "$workdir/health" &&
    curl -fsS --max-time 4 "$domain/?release=$version" -o "$workdir/index.html" &&
    grep -Fq "$web_entry" "$workdir/index.html" &&
    curl -fsS --max-time 4 "$domain/$web_entry" -o /dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true && -s /var/lib/nevis/nevis.db ]]
switched=false
echo "Nevis $version is live at $domain."
if [[ -n $invites ]]; then
  echo 'Ten invite codes were added.'
fi
