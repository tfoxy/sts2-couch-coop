#!/usr/bin/env bash
# Build the "Use new renderer (Beta)" core: godot-scene-web's render-stream client wasm
# (packages/render-stream-client/scripts/build-web.sh) into ignored local state, where the frontend's
# `renderStreamClientAssets()` Vite plugin serves it. Honours COUCHCOOP_GSW_ROOT like
# build-rust-prototype.sh. Nothing it writes is committed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gsw_root="${COUCHCOOP_GSW_ROOT:-$(cd "$repo_root/.." && pwd)/godot-scene-web}"
build_script="$gsw_root/packages/render-stream-client/scripts/build-web.sh"
if [[ ! -f "$build_script" ]]; then
  echo "render-stream client source missing: $build_script (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi

export GSW_RENDER_STREAM_CLIENT_OUT="$repo_root/.sts2/render-stream-client-web"
bash "$build_script"
for name in rs_gsw_wasm_client.js rs_gsw_wasm_bg.wasm build.json; do
  if [[ ! -s "$GSW_RENDER_STREAM_CLIENT_OUT/$name" ]]; then
    echo "render-stream client build did not produce $GSW_RENDER_STREAM_CLIENT_OUT/$name" >&2
    exit 1
  fi
done
