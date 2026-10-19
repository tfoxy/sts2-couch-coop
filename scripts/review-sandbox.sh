#!/usr/bin/env bash
# Run this TRUSTED copy, never the submitted version. Linux, bubblewrap,
# util-linux (unshare/setpriv), and iproute2 required.
# Inputs must be disposable exports, a trusted Node installation, a packages-only
# NuGet cache, and a directory containing only game reference assemblies.
# No credentials, .git, machine configs, sockets, personal files, or game saves.
set -euo pipefail
if [[ $# -lt 6 || $5 != -- ]]; then
  echo 'Usage: review-sandbox.sh EXPORT NODE_ROOT NUGET_PACKAGES GAME_REFS -- COMMAND [ARGS...]' >&2
  exit 2
fi
workspace=$(realpath -e -- "$1")
node_root=$(realpath -e -- "$2")
packages=$(realpath -e -- "$3")
game_refs=$(realpath -e -- "$4")
shift 5
for path in "$workspace" "$node_root" "$packages" "$game_refs"; do
  [[ -d $path && $path != / ]] || { echo 'Inputs must be specific directories' >&2; exit 2; }
done
[[ -f $workspace/.disposable-review-export ]] || {
  echo 'Refusing workspace without .disposable-review-export marker' >&2; exit 2;
}
if find "$workspace" -name .git -print -quit | read -r _; then
  echo 'Refusing a Git checkout; export source into disposable storage first' >&2
  exit 2
fi
# No inherited descriptors except stdio. Disconnect stdin and terminal access;
# logs should go to a regular file outside the export, then be read as data.
ulimit -c 0
ulimit -n 1024
# Configure a private network using only trusted system tools, then discard all
# setup capabilities before entering bubblewrap. Its --share-net retains THIS
# new namespace, never the host network. The synthetic address supports tests
# that require a non-loopback IPv4 address without adding any external route.
exec timeout --kill-after=10s 20m \
  unshare --user --map-current-user --keep-caps --net -- /bin/sh -ec '
    /usr/sbin/ip address add 192.0.2.1/32 dev lo
    /usr/sbin/ip link set lo up
    exec /usr/bin/setpriv --no-new-privs --bounding-set=-all \
      --inh-caps=-all --ambient-caps=-all "$@"
  ' review-network /usr/bin/bwrap \
  --unshare-all --share-net --unshare-user --disable-userns --die-with-parent --new-session \
  --cap-drop ALL --clearenv \
  --ro-bind /usr /usr --symlink usr/bin /bin \
  --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --file 3 /etc/passwd --file 4 /etc/group \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home \
  --dir /home/reviewer --dir /run \
  --bind "$workspace" /workspace \
  --ro-bind "$node_root" /opt/node \
  --ro-bind "$packages" /packages \
  --ro-bind "$game_refs" /game-refs \
  --setenv HOME /home/reviewer --setenv USER reviewer \
  --setenv PATH /opt/node/bin:/usr/bin:/bin \
  --setenv LANG C.UTF-8 --setenv TMPDIR /tmp \
  --setenv NUGET_PACKAGES /packages \
  --setenv DOTNET_CLI_TELEMETRY_OPTOUT 1 \
  --setenv DOTNET_SKIP_FIRST_TIME_EXPERIENCE 1 \
  --setenv STS2_ASSEMBLIES_DIR /game-refs \
  --setenv COUCHCOOP_GAME_MODS_DIR /tmp/mods \
  --chdir /workspace -- "$@" </dev/null \
  3<<<"reviewer:x:$(id -u):$(id -g):Reviewer:/home/reviewer:/bin/sh" \
  4<<<"reviewer:x:$(id -g):"
