#!/usr/bin/env bash
# Exercise the actual checksum handoff shell from both workflows, without network or Apple tools.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
files=(librender_stream_capture.dylib librender_stream_net.dylib render_stream_capture.gdextension build-info.txt)
checks=0
for workflow in release macos-check; do
  case_root="$scratch/$workflow"
  mkdir -p "$case_root/macos-capture"
  awk '
    /^      - name: Build the pinned universal macOS capture$/ { selected = 1; next }
    selected && /^      - name:/ { exit }
    selected && /^        run: \|$/ { run = 1; next }
    selected && run && /^          / { sub(/^          /, ""); print }
  ' "$repo_root/.github/workflows/$workflow.yml" > "$case_root/build.sh"
  python3 - "$case_root/build.sh" <<'PY'
import shlex
import sys
from pathlib import Path

commands = [shlex.split(line) for line in Path(sys.argv[1]).read_text().splitlines()]
targets = next(i for i, args in enumerate(commands) if args[:3] == ["rustup", "target", "add"])
assert {"aarch64-apple-darwin", "x86_64-apple-darwin"} <= set(commands[targets][3:])
fetch = commands.index(["cargo", "fetch", "--locked", "--manifest-path",
                        "../godot-scene-web/experiments/render-stream/rs-net/Cargo.toml"])
build = commands.index(["bash", "../godot-scene-web/experiments/render-stream/scripts/build-rs-net.sh",
                        "--target", "macos"])
assert targets < build and fetch < build, "prepare both targets and crates before the offline build"
PY
  checks=$((checks + 3))
  awk '
    /^      - name: Verify the macOS artifact handoff$/ { selected = 1; next }
    selected && /^      - name:/ { exit }
    selected && /^        run: \|$/ { run = 1; next }
    selected && run && /^          / { sub(/^          /, ""); print }
  ' "$repo_root/.github/workflows/$workflow.yml" > "$case_root/verify.sh"
  [[ -s "$case_root/verify.sh" ]]
  reset_bundle() {
    local name
    for name in "${files[@]}"; do printf 'fixture %s\n' "$name" > "$case_root/macos-capture/$name"; done
    (cd "$case_root/macos-capture" && shasum -a 256 "${files[@]}" > SHA256SUMS)
  }
  verify() { (cd "$case_root" && bash verify.sh > result.log 2>&1); }
  reject() {
    if verify; then echo "FAIL: $workflow accepted $1" >&2; exit 1; fi
    checks=$((checks + 1))
  }
  reset_bundle
  verify
  checks=$((checks + 1))
  for name in "${files[@]}"; do
    reset_bundle
    printf 'tamper\n' >> "$case_root/macos-capture/$name"
    reject "tampered $name"
  done
  reset_bundle
  sed '$d' "$case_root/macos-capture/SHA256SUMS" > "$case_root/short-manifest"
  mv "$case_root/short-manifest" "$case_root/macos-capture/SHA256SUMS"
  reject 'missing manifest entry'
  reset_bundle
  printf 'unexpected\n' > "$case_root/macos-capture/test-binary"
  (cd "$case_root/macos-capture" && shasum -a 256 test-binary >> SHA256SUMS)
  reject 'extra manifest entry'
  reset_bundle
  # Four valid checksums can still omit a required file by repeating a different entry.
  head -1 "$case_root/macos-capture/SHA256SUMS" > "$case_root/duplicate-manifest"
  head -3 "$case_root/macos-capture/SHA256SUMS" >> "$case_root/duplicate-manifest"
  mv "$case_root/duplicate-manifest" "$case_root/macos-capture/SHA256SUMS"
  reject 'duplicate manifest entry'
  reset_bundle
  similar=()
  for name in "${files[@]}"; do
    replacement="${name//./X}"
    printf 'checked substitute\n' > "$case_root/macos-capture/$replacement"
    printf 'unchecked required file\n' > "$case_root/macos-capture/$name"
    similar+=("$replacement")
  done
  (cd "$case_root/macos-capture" && shasum -a 256 "${similar[@]}" > SHA256SUMS)
  reject 'similarly named files with periods replaced'
done
echo "macOS capture workflow handoff: $checks checks passed"
