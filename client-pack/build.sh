#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${COUCHCOOP_GSW_ROOT:?Set COUCHCOOP_GSW_ROOT to a GSW checkout}"
RECEIVER="$COUCHCOOP_GSW_ROOT/experiments/render-stream/receiver"
EDITOR="${COUCH_PACK_GODOT:-$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64}"
[[ "$("$EDITOR" --version)" = 4.5.1.stable.official.* ]] || { echo 'non-mono Godot 4.5.1 required' >&2; exit 1; }
[[ -f "$RECEIVER/rs_live_client.gd" ]] || { echo 'GSW receiver scripts unavailable' >&2; exit 1; }
mkdir -p "$HERE/build"
python3 - "$HERE" "$RECEIVER" <<'PY'
import hashlib, json, shutil, sys
from pathlib import Path
here, receiver = map(Path, sys.argv[1:])
stage = here / 'build/project'
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir()
for name in ['project.godot', 'export_presets.cfg']:
    shutil.copy2(here / name, stage / name)
shutil.copytree(here / 'couch', stage / 'couch')
target = stage / 'couch/receiver'
target.mkdir()
sources = {}
for source in sorted(receiver.glob('*.gd')):
    shutil.copy2(source, target / source.name)
    sources[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
(here / 'build/receiver-sources.json').write_text(json.dumps(sources, indent=2) + '\n')
PY
run_editor() {
  local log="$1"
  shift
  if ! env -u DISPLAY -u WAYLAND_DISPLAY timeout 120 "$EDITOR" --headless --path "$HERE/build/project" "$@" > "$HERE/build/$log" 2>&1; then
    tail -50 "$HERE/build/$log" >&2
    return 1
  fi
  if rg 'SCRIPT ERROR:|Parse Error:|Failed to load script|ERROR:' "$HERE/build/$log"; then return 1; fi
}
run_editor import.log --import
run_editor export.log --export-pack Pack "$HERE/build/seat.pck"
node "$HERE/tests/inspect-pack.mjs" "$HERE/build/seat.pck" > "$HERE/build/pack-files.json"
python3 - "$HERE/build" <<'PY'
import hashlib, json, sys
from pathlib import Path
out = Path(sys.argv[1])
pack = out / 'seat.pck'
sha = hashlib.sha256(pack.read_bytes()).hexdigest()
pack.replace(out / (sha + '.pck'))
(out / 'manifest.json').write_text(json.dumps({
    'packVersion': 'couch-seat-spike-1', 'sha256': sha, 'entry': 'res://couch/entry.tscn'
}, indent=2) + '\n')
PY
echo "client pack: $HERE/build/manifest.json"
