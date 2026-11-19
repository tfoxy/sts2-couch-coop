#!/usr/bin/env bash
# Synthetic Mach-O fixtures exercise Linux staging without Apple tools or a GSW build.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
make_bundle() {
  python3 -I - "$1" "${2:-valid}" <<'PY'
from pathlib import Path
import struct, sys
out, mode = Path(sys.argv[1]), sys.argv[2]
out.mkdir(parents=True, exist_ok=True)
def dylib_command(cmd, name):
    name = name.encode() + b'\0'
    length = (24 + len(name) + 7) & ~7
    return struct.pack('<6I', cmd, length, 24, 0, 0, 0) + name + bytes(length - 24 - len(name))
def subtype(cpu, location):
    if cpu == 0x0100000C:
        return 0
    if mode == 'capabilities':
        return 0x80000003
    for prefix, value in [('x86_64h', 8), ('unknown', 0xffffffff)]:
        if mode in (prefix + '-both', prefix + '-' + location):
            return value
    return 3
def thin(cpu, name):
    imported = '/opt/homebrew/lib/libz.dylib' if mode == 'homebrew' else '/usr/lib/libSystem.B.dylib'
    identity = '@rpath/' + name if mode != 'identity' else '/tmp/wrong.dylib'
    commands = dylib_command(0xC, imported) + dylib_command(0xD, identity)
    count = 2
    if mode != 'unsigned':
        commands += struct.pack('<4I', 0x1D, 16, 32 + len(commands) + 16, 8)
        count += 1
    return struct.pack('<8I', 0xFEEDFACF, cpu, subtype(cpu, 'thin'), 6, count, len(commands), 0, 0) + commands + b'signed!!'
for name in ('librender_stream_capture.dylib', 'librender_stream_net.dylib'):
    cpus = [0x0100000C] if mode == 'missing' else [0x0100000C, 0x01000007]
    entries, payload, offset = [], bytearray(), 8 + 20 * len(cpus)
    for cpu in cpus:
        image = thin(cpu, name)
        entries.append(struct.pack('>5I', cpu, subtype(cpu, 'fat'), offset, len(image), 0))
        payload += image
        offset += len(image)
    (out / name).write_bytes(struct.pack('>2I', 0xCAFEBABE, len(cpus)) + b''.join(entries) + payload)
(out / 'render_stream_capture.gdextension').write_text(
    '[configuration]\nentry_symbol = "grc_library_init"\n[libraries]\n'
    'linux.x86_64 = "old.so"\nmacos.arm64 = "old.dylib"\n[dependencies]\n')
(out / 'build-info.txt').write_text('Xcode 16.4\nBuild version 16F6\n15.5\nApple clang version fixture\nrunner_image=macos-15-arm64\nrunner_image_version=fixture\n')
PY
}
if [[ "${1:-}" == --fixture ]]; then make_bundle "$2" "${3:-valid}"; exit 0; fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
couch="$scratch/couch"
gsw="$scratch/gsw"
mkdir -p "$couch/scripts/lib" "$gsw/experiments/render-stream/calibration/abi"
cp "$repo_root/scripts/build-render-capture.sh" "$couch/scripts/"
cp "$repo_root/scripts/lib/render-capture-stamp.sh" "$repo_root/scripts/lib/render-capture-macos.py" "$couch/scripts/lib/"
printf 'table\n' > "$gsw/experiments/render-stream/calibration/abi/godot-4.5.1-rendering-server.json"
stage() {
  COUCHCOOP_GSW_ROOT="$gsw" bash "$couch/scripts/build-render-capture.sh" --target macos --from "$scratch/bundle"
}
make_bundle "$scratch/bundle"
stage > "$scratch/result"
out="$couch/.sts2/render-capture/macos"
cmp "$scratch/bundle/librender_stream_net.dylib" "$out/librender_stream_net.dylib"
[[ -s "$out/abi-table.godot-4.5.1-rendering-server" ]]
[[ "$(sed -n '/^macos\./p' "$out/render_stream_capture.gdextension" | wc -l | tr -d ' ')" == 2 ]]
! grep -q '^linux\.' "$out/render_stream_capture.gdextension"
grep -qx 'entry_symbol = "grc_library_init"' "$out/render_stream_capture.gdextension"
! compgen -G "$out/calibration.*" >/dev/null
mkdir -p "$couch/eng/render-capture/macos"
printf 'record\n' > "$couch/eng/render-capture/macos/megadot-4.5.1-m12-1234abcd.json"
printf 'source\n' > "$couch/eng/render-capture/macos/megadot-4.5.1-m12-1234abcd.source.json"
stage >/dev/null
[[ -s "$out/calibration.megadot-4.5.1-m12-1234abcd" && ! -e "$out/calibration.megadot-4.5.1-m12-1234abcd.source" ]]
rm "$couch/eng/render-capture/macos/megadot-4.5.1-m12-1234abcd.json"
stage >/dev/null
! compgen -G "$out/calibration.*" >/dev/null
for mode in missing homebrew identity unsigned x86_64h-both x86_64h-fat x86_64h-thin unknown-both unknown-fat unknown-thin; do
  make_bundle "$scratch/bundle" "$mode"
  if stage >"$scratch/$mode.log" 2>&1; then echo "FAIL: accepted $mode" >&2; exit 1; fi
done
make_bundle "$scratch/bundle" capabilities
stage >/dev/null
# Native mode invokes both builders with the macOS target, then stages the same bundle.
mkdir -p "$scratch/bin" "$gsw/experiments/render-stream/scripts" "$gsw/experiments/render-stream/capture/build/macos"
printf '#!/bin/sh\necho Darwin\n' > "$scratch/bin/uname"
chmod +x "$scratch/bin/uname"
for script in build-capture build-rs-net; do
  cat > "$gsw/experiments/render-stream/scripts/$script.sh" <<'SH'
#!/usr/bin/env bash
[[ "$*" == '--target macos' ]] || exit 1
printf '%s\n' "$0" >> "$COUCHCOOP_GSW_ROOT/builds"
SH
done
make_bundle "$gsw/experiments/render-stream/capture/build/macos/bundle"
PATH="$scratch/bin:$PATH" COUCHCOOP_GSW_ROOT="$gsw" bash "$couch/scripts/build-render-capture.sh" --target macos >/dev/null
[[ "$(wc -l < "$gsw/builds" | tr -d ' ')" == 2 ]]
python3 -I "$repo_root/scripts/lib/render-capture-macos-info.py" "$scratch/bundle" 0123456789abcdef > "$scratch/info.json"
jq -e '.godotSceneWeb == "0123456789abcdef" and .xcode == "Xcode 16.4" and .sdk == "15.5" and .runnerImage == "macos-15-arm64" and (.sha256 | length == 2) and (.sha256["librender_stream_net.dylib"] | test("^[0-9a-f]{64}$"))' "$scratch/info.json" >/dev/null
echo 'test-build-render-capture-macos: 16 cases passed'
