#!/usr/bin/env bash
# Calibrate and verify a Windows executable offline; no game process is launched.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib/release-lanes.sh"
lane= exe= game_build= steam_build= header= version_name=MegaDot
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'calibrate Windows capture: options require values' >&2; exit 2; }
  case "$1" in
    --lane) lane="$2" ;; --exe) exe="$2" ;; --game-build) game_build="$2" ;;
    --steam-build) steam_build="$2" ;; --header) header="$2" ;; --version-name) version_name="$2" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
release_lane_is_known "$lane" || { echo "unknown lane: $lane" >&2; exit 2; }
[[ "$game_build" == "$(release_lane_game_build "$lane")" ]] || { echo "game build differs from lane $lane" >&2; exit 2; }
[[ -f "$exe" && -f "$header" ]] || { echo '--exe and --header must name existing files' >&2; exit 2; }
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
gsw_root="$(cd "$gsw_root" && pwd -P)"
calibrator="$gsw_root/experiments/render-stream/capture/tools/calibrate.py"
mkdir -p "$repo_root/.local" "$repo_root/eng/render-capture/windows"
work="$(mktemp -d "$repo_root/.local/windows-calibration.XXXXXX")"
trap 'rm -rf "$work"' EXIT
python3 -I "$calibrator" --binary "$exe" --header "$header" --version-name "$version_name" --out "$work/record"
python3 -I "$calibrator" --pe-identity "$exe" > "$work/identity"
python3 -I "$calibrator" --verify-record "$work/record" --binary "$exe" --header "$header" | tee "$work/verification"
grep -qx 'verified: 14/14' "$work/verification" || { echo 'expected verified: 14/14' >&2; exit 1; }
python3 -I - "$work" "$lane" "$game_build" "$steam_build" "$(git -C "$gsw_root" rev-parse HEAD)" <<'PY'
import hashlib, json, sys
from pathlib import Path
work = Path(sys.argv[1])
record = json.loads((work / 'record').read_text())
identity = json.loads((work / 'identity').read_text())
if record['engine']['platform'] != 'windows-x86_64':
    sys.exit('expected a Windows x86_64 executable')
source = dict(schema='couchcoop-render-capture-record-source/1', lane=sys.argv[2], platform='windows-x86_64',
              gameBuild=sys.argv[3], steamBuildId=sys.argv[4] or None, exeSha256=identity['sha256'],
              peIdentity={k: identity[k] for k in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256')},
              recordSha256=hashlib.sha256((work / 'record').read_bytes()).hexdigest(),
              calibrator=dict(version=record['calibrator']['version'], gswCommit=sys.argv[5]))
(work / 'source').write_text(json.dumps(source, indent=2) + '\n')
PY
cp "$work/record" "$repo_root/eng/render-capture/windows/$lane.json"
cp "$work/source" "$repo_root/eng/render-capture/windows/$lane.source.json"
echo "Windows capture record: $lane ($game_build) verified: 14/14"
