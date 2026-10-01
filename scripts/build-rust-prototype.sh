#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gsw_root="${COUCHCOOP_GSW_ROOT:-$(cd "$repo_root/.." && pwd)/godot-scene-web}"
build_script="$gsw_root/packages/canvas/rust-prototype/scripts/build-web.sh"
if [[ ! -f "$build_script" ]]; then
  echo "Rust renderer source missing: $build_script (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi

export GSW_RUST_PROTOTYPE_OUT="$repo_root/.sts2/rust-prototype-web"
bash "$build_script"
for name in rust_prototype.js rust_prototype_bg.wasm; do
  if [[ ! -s "$GSW_RUST_PROTOTYPE_OUT/$name" ]]; then
    echo "Rust renderer build did not produce $GSW_RUST_PROTOTYPE_OUT/$name" >&2
    exit 1
  fi
done
