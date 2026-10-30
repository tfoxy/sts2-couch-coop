#!/usr/bin/env bash
# Build the streaming seat's render-stream capture (godot-scene-web experiments/render-stream/capture, only the
# `render_stream_capture` library) into ignored `.sts2/render-capture/`, laid out the way a packaged mod carries it
# and the way StreamingSeatLaunch finds it:
#
#   librender_stream_capture.so        the GDExtension library (debug info stripped; same -O2 as the gates run)
#   render_stream_capture.gdextension  its descriptor, library path RELATIVE (Godot resolves it beside the file)
#   calibration                        the committed engine record, eng/render-capture/calibration-*.json
#
# The calibration is deliberately extensionless: STS2 reads every `*.json` under a mod's folder as a mod manifest.
# Honours COUCHCOOP_GSW_ROOT like build-render-stream-client.sh. Nothing it writes is committed. The seat is
# Linux-only, so there is no other platform's library here.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gsw_root="${COUCHCOOP_GSW_ROOT:-$(cd "$repo_root/.." && pwd)/godot-scene-web}"
capture_src="$gsw_root/experiments/render-stream/capture"
out="${COUCHCOOP_RENDER_CAPTURE_OUT:-$repo_root/.sts2/render-capture}"
calibration_src="${COUCHCOOP_RENDER_CAPTURE_CALIBRATION_SOURCE:-}"
if [[ -z "$calibration_src" ]]; then
  calibration_src="$(ls "$repo_root"/eng/render-capture/calibration-*.json 2>/dev/null | LC_ALL=C sort | tail -n 1 || true)"
fi

if [[ ! -f "$capture_src/CMakeLists.txt" ]]; then
  echo "render-stream capture source missing: $capture_src (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi
if [[ -z "$calibration_src" || ! -s "$calibration_src" ]]; then
  echo "no committed capture calibration record under $repo_root/eng/render-capture/" >&2
  exit 1
fi
cmake_bin="${CMAKE:-$(command -v cmake || true)}"
[[ -x "$cmake_bin" ]] || cmake_bin=/snap/bin/cmake
[[ -x "$cmake_bin" ]] || { echo "cmake is required to build the render-stream capture" >&2; exit 1; }

build_dir="$out/build"
mkdir -p "$out"
"$cmake_bin" -S "$capture_src" -B "$build_dir" -DCMAKE_BUILD_TYPE=RelWithDebInfo
"$cmake_bin" --build "$build_dir" --target render_stream_capture -j"$(nproc)"

lib="$build_dir/librender_stream_capture.so"
[[ -s "$lib" ]] || { echo "capture build did not produce $lib" >&2; exit 1; }
cp "$lib" "$out/librender_stream_capture.so"
strip --strip-debug "$out/librender_stream_capture.so"
sed 's#^linux.x86_64 = .*#linux.x86_64 = "librender_stream_capture.so"#' \
  "$build_dir/render_stream_capture.gdextension" > "$out/render_stream_capture.gdextension"
grep -q '^linux.x86_64 = "librender_stream_capture.so"$' "$out/render_stream_capture.gdextension" \
  || { echo "capture descriptor has no linux.x86_64 library line" >&2; exit 1; }
cp "$calibration_src" "$out/calibration"
for name in librender_stream_capture.so render_stream_capture.gdextension calibration; do
  [[ -s "$out/$name" ]] || { echo "render capture staging missing $out/$name" >&2; exit 1; }
done
echo "render capture staged in $out"
