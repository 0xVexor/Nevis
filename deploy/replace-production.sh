#!/usr/bin/env bash
# One-time reset of the manual Nevis installation on vexor-server.
set -Eeuo pipefail

if [[ $# != 3 || $(id -u) != 0 || $(hostname -s) != vexor-server ]]; then
  echo "Run as root on vexor-server: $0 IMAGE_TAR VERSION WEB_ENTRY" >&2
  exit 2
fi

image_tar=$1
version=$2
web_entry=$3
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $web_entry =~ ^assets/index-[A-Za-z0-9_-]+\.js$ ]]
image="nevis-next:$version"
compose=/opt/nevis/compose.yaml
data=/var/lib/nevis
domain=https://nevis.manaz.pro

# Check the original installation before touching it.
[[ -f $compose && ! -L $compose && -d $data && ! -L $data ]]
! mountpoint -q "$data"
[[ $(docker compose -f "$compose" config --images | wc -l) == 1 ]]
grep -qE '^    image: nevis-next:[0-9]+\.[0-9]+\.[0-9]+$' "$compose"
docker load -i "$image_tar"
[[ $(docker image inspect -f '{{.Os}}/{{.Architecture}} {{.Config.User}}' "$image") == 'linux/amd64 65532:65532' ]]

workdir=$(mktemp -d /var/lib/nevis-reset.XXXXXXXX)
cp -p "$compose" "$workdir/compose.before"
sed -E "s|^    image: nevis-next:[0-9]+\.[0-9]+\.[0-9]+$|    image: $image|" "$compose" > "$workdir/compose.next"
[[ $(docker compose --project-directory /opt/nevis -f "$workdir/compose.next" config --images) == "$image" ]]

rollback() {
  local status=$?
  trap - EXIT
  if [[ -d $workdir/data.before ]]; then
    echo 'Deployment did not pass the live checks. Restoring the previous service.' >&2
    docker compose -f "$compose" stop app || true
    if [[ -d $data ]]; then mv -T "$data" "$workdir/data.failed"; fi
    mv -T "$workdir/data.before" "$data" || exit 1
    cp -p "$workdir/compose.before" "$compose" || exit 1
  fi
  docker compose -f "$compose" up -d app || exit 1
  rm -rf -- "$workdir"
  exit "$status"
}
trap rollback EXIT

docker compose -f "$compose" stop app
mv -T "$data" "$workdir/data.before"
install -d -o 65532 -g 65532 -m 700 "$data"
install -m 600 "$workdir/compose.next" "$compose"
docker compose -f "$compose" up -d --force-recreate app

ready=false
for attempt in {1..30}; do
  if curl -fsS --max-time 4 "$domain/v1/health" -o "$workdir/health" &&
    grep -q '"ok":true' "$workdir/health" &&
    curl -fsS --max-time 4 "$domain/?release=$version" -o "$workdir/index.html" &&
    grep -Fq "$web_entry" "$workdir/index.html" &&
    curl -fsS --max-time 4 "$domain/$web_entry" -o /dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[[ $ready == true ]]
[[ -s $data/nevis.db ]]

trap - EXIT
rm -rf -- "$workdir"
docker compose -f "$compose" ps app
echo "Nevis $version is live at $domain with a fresh database."
