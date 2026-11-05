#!/usr/bin/env bash
# Build the streaming seat's render-stream capture (godot-scene-web experiments/render-stream/capture, only the
# `render_stream_capture` library) into ignored `.sts2/render-capture/`, laid out the way a packaged mod carries it
# and the way StreamingSeatLaunch finds it:
#
#   librender_stream_capture.so        the GDExtension library (debug info stripped; same -O2 as the gates run)
#   render_stream_capture.gdextension  its descriptor, library path RELATIVE (Godot resolves it beside the file)
#   calibration                        the committed engine record, eng/render-capture/calibration-*.json
#   librender_stream_net.so            the net module (GSW rs-net, carrier-design.md D8): the WebTransport carrier
#                                      `wt` and wss. The capture dlopens it from beside its own library, and only
#                                      when the seat lists `wt` or sets a TLS pair.
#   source-stamp                       render-capture-stamp/1 (scripts/lib/render-capture-stamp.sh): what these
#                                      were built from, which scripts/build-render-stream.sh compares to skip a
#                                      build that is still fresh. It is not deployed.
#
# The calibration is deliberately extensionless: STS2 reads every `*.json` under a mod's folder as a mod manifest.
# Honours COUCHCOOP_GSW_ROOT like build-render-stream-client.sh. Nothing it writes is committed. The seat is
# Linux-only, so there is no other platform's library here. The net module is built by GSW's own
# experiments/render-stream/scripts/build-rs-net.sh (cargo, offline, from rs-net/Cargo.lock), which writes into that
# checkout's ignored rs-net/target/ and capture/build/; it is copied from there.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/render-capture-stamp.sh
source "$repo_root/scripts/lib/render-capture-stamp.sh"
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
# Physical path: from a worktree the default goes through the .worktrees/godot-scene-web symlink, and cargo keys its
# units on the path it is handed, so the same crates built via both paths poison one shared target dir.
gsw_root="$(cd "$gsw_root" 2>/dev/null && pwd -P || printf '%s' "$gsw_root")"
capture_src="$gsw_root/experiments/render-stream/capture"
net_build="$gsw_root/experiments/render-stream/scripts/build-rs-net.sh"
out="${COUCHCOOP_RENDER_CAPTURE_OUT:-$repo_root/.sts2/render-capture}"
calibration_src="$(render_capture_calibration_source "$repo_root" || true)"

if [[ ! -f "$capture_src/CMakeLists.txt" ]]; then
  echo "render-stream capture source missing: $capture_src (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi
if [[ ! -f "$net_build" ]]; then
  echo "render-stream net module build script missing: $net_build (set COUCHCOOP_GSW_ROOT to the GSW checkout)" >&2
  exit 1
fi
if [[ -z "$calibration_src" || ! -s "$calibration_src" ]]; then
  echo "no committed capture calibration record under $repo_root/eng/render-capture/" >&2
  exit 1
fi
cmake_bin="${CMAKE:-$(command -v cmake || true)}"
[[ -x "$cmake_bin" ]] || cmake_bin=/snap/bin/cmake
[[ -x "$cmake_bin" ]] || { echo "cmake is required to build the render-stream capture" >&2; exit 1; }

# Stamped BEFORE building: a source that moves while the build runs then reads as stale next time, never as fresh.
stamp="$(render_capture_stamp "$gsw_root" "$repo_root" "$calibration_src" || true)"
build_dir="$out/build"
mkdir -p "$out"
rm -f "$out/source-stamp"
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

# The net module. --no-test: its crate tests are GSW's gate, not this build's.
bash "$net_build" --no-test
net_lib="$gsw_root/experiments/render-stream/capture/build/librender_stream_net.so"
[[ -s "$net_lib" ]] || { echo "net module build did not produce $net_lib" >&2; exit 1; }
cp "$net_lib" "$out/librender_stream_net.so"

for name in librender_stream_capture.so render_stream_capture.gdextension calibration librender_stream_net.so; do
  [[ -s "$out/$name" ]] || { echo "render capture staging missing $out/$name" >&2; exit 1; }
done
if [[ -n "$stamp" ]]; then
  printf '%s\n' "$stamp" > "$out/source-stamp"
else
  echo "render capture: GSW sources could not be stamped; the next build-render-stream.sh rebuilds" >&2
fi
echo "render capture staged in $out"
