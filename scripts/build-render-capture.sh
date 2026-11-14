#!/usr/bin/env bash
# Build a target's capture and net module into ignored .sts2/render-capture/<target>/.
# Calibration records are extensionless: STS2 scans every *.json as a mod manifest.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib/render-capture-stamp.sh"
target=linux
if [[ "${1:-}" == --target && $# -eq 2 ]]; then target="$2"; shift 2; fi
if [[ $# -ne 0 || ( "$target" != linux && "$target" != windows ) ]]; then
  echo 'usage: scripts/build-render-capture.sh [--target linux|windows]' >&2; exit 2
fi
if [[ "$(uname -sm)" != 'Linux x86_64' ]]; then
  echo "render capture: target $target needs a Linux x86_64 build host" >&2; exit 1
fi
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
gsw_root="$(cd "$gsw_root" 2>/dev/null && pwd -P || printf '%s' "$gsw_root")"
capture_src="$gsw_root/experiments/render-stream/capture"
net_build="$gsw_root/experiments/render-stream/scripts/build-rs-net.sh"
out_root="${COUCHCOOP_RENDER_CAPTURE_OUT:-$repo_root/.sts2/render-capture}"
out="$out_root/$target"
calibration_src="$(render_capture_calibration_source "$repo_root" || true)"
[[ -f "$capture_src/CMakeLists.txt" && -f "$net_build" ]] || {
  echo "render-stream capture sources missing: $gsw_root (set COUCHCOOP_GSW_ROOT)" >&2; exit 1;
}
cmake_bin="${CMAKE:-$(command -v cmake || true)}"
[[ -x "$cmake_bin" ]] || cmake_bin=/snap/bin/cmake
[[ -x "$cmake_bin" ]] || { echo 'cmake is required to build the render-stream capture' >&2; exit 1; }
# Stamp before building, so sources moving during the build are stale next time.
stamp="$(render_capture_stamp "$gsw_root" "$repo_root" "$calibration_src" "$target" || true)"
build_dir="$out_root/build-$target"
mkdir -p "$out"
rm -f "$out/source-stamp"
if [[ "$target" == windows ]]; then
  source "$gsw_root/experiments/render-stream/scripts/lib/llvm-mingw.sh"
  llvm_mingw_ensure
  "$cmake_bin" -S "$capture_src" -B "$build_dir" \
    -DCMAKE_TOOLCHAIN_FILE="$capture_src/cmake/llvm-mingw-x86_64.cmake" \
    -DGRC_LLVM_MINGW_ROOT="$LLVM_MINGW_ROOT" -DCMAKE_BUILD_TYPE=RelWithDebInfo
  "$cmake_bin" --build "$build_dir" --target render_stream_capture -j"$(nproc)"
  cp "$build_dir/bin/render_stream_capture.dll" "$out/render_stream_capture.dll"
  "$LLVM_MINGW_ROOT/bin/llvm-strip" --strip-debug "$out/render_stream_capture.dll"
  sed 's#^windows.x86_64 = .*#windows.x86_64 = "render_stream_capture.dll"#' \
    "$build_dir/render_stream_capture.gdextension" > "$out/render_stream_capture.gdextension"
  grep -qx 'windows.x86_64 = "render_stream_capture.dll"' "$out/render_stream_capture.gdextension"
  python3 -I "$gsw_root/experiments/render-stream/scripts/w-imports.py" \
    --objdump "$LLVM_MINGW_ROOT/bin/llvm-objdump" \
    --expect-exports grc_library_init,grc_carrier_register "$out/render_stream_capture.dll"
  bash "$net_build" --target windows
  cp "$capture_src/build-windows/rs-net/render_stream_net.dll" "$out/render_stream_net.dll"
  llvm_mingw_record "$out/toolchain.json"
  cp "$LLVM_MINGW_ROOT/LICENSE.TXT" "$out/llvm-mingw-LICENSE.txt"
  # Remove retired records before copying the current candidate set.
  rm -f "$out"/calibration.*
  for record in "$repo_root"/eng/render-capture/windows/*.json; do
    [[ -f "$record" && "$record" != *.source.json ]] || continue
    cp "$record" "$out/calibration.$(basename "$record" .json)"
  done
else
  "$cmake_bin" -S "$capture_src" -B "$build_dir" -DCMAKE_BUILD_TYPE=RelWithDebInfo
  "$cmake_bin" --build "$build_dir" --target render_stream_capture -j"$(nproc)"
  cp "$build_dir/librender_stream_capture.so" "$out/librender_stream_capture.so"
  strip --strip-debug "$out/librender_stream_capture.so"
  sed 's#^linux.x86_64 = .*#linux.x86_64 = "librender_stream_capture.so"#' \
    "$build_dir/render_stream_capture.gdextension" > "$out/render_stream_capture.gdextension"
  grep -qx 'linux.x86_64 = "librender_stream_capture.so"' "$out/render_stream_capture.gdextension"
  render_capture_stage_linux_records "$repo_root" "$out" "$calibration_src"
  bash "$net_build" --no-test
  cp "$capture_src/build/librender_stream_net.so" "$out/librender_stream_net.so"
fi
if [[ -n "$stamp" ]]; then
  printf '%s\n' "$stamp" > "$out/source-stamp"
else
  echo 'render capture: sources could not be stamped; the next build rebuilds' >&2
fi
echo "render capture staged in $out"
