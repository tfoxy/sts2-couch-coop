#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gsw_root="${COUCHCOOP_GSW_ROOT:-$(cd "$repo_root/.." && pwd)/godot-scene-web}"
build_script="$gsw_root/packages/canvas/msdf-generator/scripts/build-web.sh"
if [[ ! -f "$build_script" ]]; then
  echo "MSDF generator source missing: $build_script (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi

export GSW_MSDF_GENERATOR_OUT="$repo_root/.sts2/msdf-generator-web"
bash "$build_script"
for name in msdf_generator.js msdf_generator_bg.wasm; do
  if [[ ! -s "$GSW_MSDF_GENERATOR_OUT/$name" ]]; then
    echo "MSDF generator build did not produce $GSW_MSDF_GENERATOR_OUT/$name" >&2
    exit 1
  fi
done
