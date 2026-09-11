#!/usr/bin/env bash
set -euo pipefail

json=0
if [[ "${1:-}" == "--json" ]]; then
  json=1
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-build-config.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

config_path="$tmp_dir/sts2.local.yaml"
game_path="$tmp_dir/fake-game"
mkdir -p "$game_path/data_sts2_linuxbsd_x86_64"

cat >"$config_path" <<EOF
game:
  path: $game_path
EOF

output_path="$tmp_dir/dotnet-build.log"
set +e
dotnet build "$repo_root/CouchCoop.sln" -p:CouchCoopLocalConfigPath="$config_path" >"$output_path" 2>&1
status=$?
set -e

expected="Missing required game.assembliesDir in sts2.local.yaml; CouchCoop will not infer assemblies from game.path."
output="$(cat "$output_path")"

if [[ $status -eq 0 ]]; then
  echo "expected dotnet build to fail when game.assembliesDir is missing" >&2
  exit 1
fi

if [[ "$output" != *"$expected"* ]]; then
  echo "expected setup error was not emitted" >&2
  echo "$output" >&2
  exit 1
fi

if [[ "$output" == *"$game_path/data_sts2_linuxbsd_x86_64"* ]]; then
  echo "build output shows game.path-derived assembly resolution" >&2
  echo "$output" >&2
  exit 1
fi

if [[ $json -eq 1 ]]; then
  printf '{"ok":true,"missingAssembliesDirError":true,"gamePathInference":false}\n'
else
  echo "validate-build-config: ok"
fi
