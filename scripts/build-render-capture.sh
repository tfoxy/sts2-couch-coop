#!/usr/bin/env bash
# Build a target's capture and net module into ignored .sts2/render-capture/<target>/.
# Calibration records are extensionless: STS2 scans every *.json as a mod manifest.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib/render-capture-stamp.sh"
target=linux
from=""
fmod_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fmod-only) fmod_only=1; shift ;;
    --target|--from)
      [[ $# -ge 2 && -n "$2" ]] || { echo "$1 requires a value" >&2; exit 2; }
      if [[ "$1" == --target ]]; then target="$2"; else from="$2"; fi
      shift 2 ;;
    *) echo 'usage: scripts/build-render-capture.sh [--target linux|windows|macos] [--from <macos bundle>] [--fmod-only]' >&2; exit 2 ;;
  esac
done
if [[ "$target" != linux && "$target" != windows && "$target" != macos ]] || [[ -n "$from" && "$target" != macos ]]; then
  echo 'render capture: --from is only supported with --target macos' >&2; exit 2
fi
if [[ "$target" == macos ]]; then
  [[ "$(uname -s)" == Darwin || ( "$(uname -s)" == Linux && -n "$from" ) ]] || {
    echo 'render capture: macos needs a macOS host, or --from <prebuilt bundle> on Linux' >&2; exit 2;
  }
elif [[ "$(uname -sm)" != 'Linux x86_64' ]]; then
  echo "render capture: target $target needs a Linux x86_64 build host" >&2; exit 1
fi
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
gsw_root="$(cd "$gsw_root" 2>/dev/null && pwd -P || printf '%s' "$gsw_root")"
capture_src="$gsw_root/experiments/render-stream/capture"
net_build="$gsw_root/experiments/render-stream/scripts/build-rs-net.sh"
out_root="${COUCHCOOP_RENDER_CAPTURE_OUT:-$repo_root/.sts2/render-capture}"
out="$out_root/$target"
calibration_src="$(render_capture_calibration_source "$repo_root" || true)"
# The FMOD module has its own build tree and never links to an FMOD SDK.
build_fmod() {
  local cmake_bin="${CMAKE:-$(command -v cmake || true)}" fmod_build="$out_root/fmod-$target"
  [[ -x "$cmake_bin" ]] || cmake_bin=/snap/bin/cmake
  local args=(-DCMAKE_BUILD_TYPE=RelWithDebInfo)
  if [[ "$target" == windows ]]; then
    source "$gsw_root/experiments/render-stream/scripts/lib/llvm-mingw.sh"
    llvm_mingw_ensure
    args+=(-DCMAKE_TOOLCHAIN_FILE="$capture_src/cmake/llvm-mingw-x86_64.cmake" -DGRC_LLVM_MINGW_ROOT="$LLVM_MINGW_ROOT" -DBUILD_TESTING=OFF)
  elif [[ "$target" == macos ]]; then
    if [[ -n "$from" ]]; then
      [[ -s "$from/libgrc_fmod.dylib" ]] || { echo 'render capture: macos bundle is missing libgrc_fmod.dylib' >&2; return 1; }
      mkdir -p "$out"
      cp "$from/libgrc_fmod.dylib" "$out/"
      return
    fi
    args+=('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64' -DBUILD_TESTING=OFF)
  fi
  "$cmake_bin" -S "$gsw_root/experiments/render-stream/fmod" -B "$fmod_build" "${args[@]}"
  "$cmake_bin" --build "$fmod_build" -j"${COUCHCOOP_BUILD_JOBS:-2}"
  mkdir -p "$out"
  case "$target" in
    windows) cp "$fmod_build/grc_fmod.dll" "$out/" ;;
    macos) cp "$fmod_build/libgrc_fmod.dylib" "$out/" ;;
    linux) cp "$fmod_build/libgrc_fmod.so" "$out/" ;;
  esac
}
if [[ "$fmod_only" == 1 || "${COUCHCOOP_STREAM_AUDIO:-}" == gsw ]]; then build_fmod; fi
if [[ "$fmod_only" == 1 ]]; then exit 0; fi
if [[ "$target" == macos ]]; then
  if [[ -z "$from" ]]; then
    bash "$gsw_root/experiments/render-stream/scripts/build-capture.sh" --target macos
    bash "$net_build" --target macos
    from="$capture_src/build/macos/bundle"
  fi
  for name in librender_stream_capture.dylib librender_stream_net.dylib render_stream_capture.gdextension build-info.txt; do
    [[ -s "$from/$name" ]] || { echo "render capture: missing macos bundle file: $from/$name" >&2; exit 1; }
  done
  python3 -I "$repo_root/scripts/lib/render-capture-macos.py" \
    "$from/librender_stream_capture.dylib" "$from/librender_stream_net.dylib"
  mkdir -p "$out"
  rm -f "$out/source-stamp" "$out"/calibration.*
  cp "$from/librender_stream_capture.dylib" "$from/librender_stream_net.dylib" "$from/build-info.txt" "$out/"
  python3 -I - "$from/render_stream_capture.gdextension" "$out/render_stream_capture.gdextension" <<'PYEXT'
from pathlib import Path
import sys
lines, libraries = [], False
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.strip().startswith('['):
        libraries = line.strip() == '[libraries]'
        lines.append(line)
        if libraries:
            lines += [f'macos.{arch} = "librender_stream_capture.dylib"' for arch in ('arm64', 'x86_64')]
    elif not libraries or not line.strip() or line.lstrip().startswith(';'):
        lines.append(line)
if '[libraries]' not in lines:
    sys.exit('render capture: descriptor has no [libraries] section')
Path(sys.argv[2]).write_text('\n'.join(lines) + '\n')
PYEXT
  for record in "$repo_root"/eng/render-capture/macos/*.json; do
    [[ -f "$record" && "$record" != *.source.json ]] || continue
    cp "$record" "$out/calibration.$(basename "$record" .json)"
  done
  render_capture_stage_abi_tables "$gsw_root" "$out"
  echo "render capture staged in $out"
  exit 0
fi
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
    --expect-exports grc_library_init,grc_carrier_register,grc_audio_cue_get_v1,grc_audio_link_attach_v1,grc_audio_link_in \
    "$out/render_stream_capture.dll"
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
  render_capture_stage_abi_tables "$gsw_root" "$out"
else
  "$cmake_bin" -S "$capture_src" -B "$build_dir" -DCMAKE_BUILD_TYPE=RelWithDebInfo
  "$cmake_bin" --build "$build_dir" --target render_stream_capture -j"$(nproc)"
  cp "$build_dir/librender_stream_capture.so" "$out/librender_stream_capture.so"
  strip --strip-debug "$out/librender_stream_capture.so"
  sed 's#^linux.x86_64 = .*#linux.x86_64 = "librender_stream_capture.so"#' \
    "$build_dir/render_stream_capture.gdextension" > "$out/render_stream_capture.gdextension"
  grep -qx 'linux.x86_64 = "librender_stream_capture.so"' "$out/render_stream_capture.gdextension"
  render_capture_stage_linux_records "$repo_root" "$out" "$calibration_src"
  render_capture_stage_abi_tables "$gsw_root" "$out"
  bash "$net_build" --no-test
  cp "$capture_src/build/librender_stream_net.so" "$out/librender_stream_net.so"
fi
if [[ -n "$stamp" ]]; then
  printf '%s\n' "$stamp" > "$out/source-stamp"
else
  echo 'render capture: sources could not be stamped; the next build rebuilds' >&2
fi
echo "render capture staged in $out"
