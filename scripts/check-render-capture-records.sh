#!/usr/bin/env bash
# Check committed engine records against lane and calibrator inputs before release builds.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib/release-lanes.sh"
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
calibrator="$gsw_root/experiments/render-stream/capture/tools/calibrate.py"
header= exes=()
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'usage: check-render-capture-records.sh [--exe L=PATH]... [--header H]' >&2; exit 2; }
  case "$1" in
    --exe) exes+=("$2") ;;
    --header) header="$2" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
if [[ ${#exes[@]} -gt 0 && ! -f "$header" ]]; then
  echo '--header is required with --exe for the calibrator verification' >&2; exit 2
fi
lanes='{}'
while IFS= read -r lane; do
  lanes="$(jq -c --arg lane "$lane" --arg build "$(release_lane_game_build "$lane")" '. + {($lane): $build}' <<< "$lanes")"
done < <(release_lane_known_names)
python3 -I - "$repo_root" "$calibrator" "$lanes" "${exes[@]}" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
root, calibrator = map(Path, sys.argv[1:3])
lanes = json.loads(sys.argv[3])
def require(ok, message):
    if not ok: raise ValueError(message)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
try:
    match = re.search(r'^CALIBRATOR_VERSION\s*=\s*[\'"]([^\'"]+)', calibrator.read_text(), re.M)
    require(match is not None, 'cannot read GSW calibrator version')
    version = match.group(1)
    for path in sorted((root / 'eng/render-capture').glob('calibration-*.json')):
        record = json.loads(path.read_text())
        require(record['engine']['platform'] == 'linux-x86_64', 'Linux record platform')
        require(record['calibrator']['version'] == version, 'Linux calibrator version')
    windows = root / 'eng/render-capture/windows'
    for path in sorted(windows.glob('*.source.json')):
        require(path.with_name(path.name.replace('.source.json', '.json')).is_file(), 'orphan source record')
    records = {}
    for path in sorted(windows.glob('*.json')):
        if path.name.endswith('.source.json'): continue
        lane = path.stem
        require(lane in lanes, f'unknown lane: {lane}')
        record = json.loads(path.read_text())
        source = json.loads(path.with_suffix('.source.json').read_text())
        require(source['schema'] == 'couchcoop-render-capture-record-source/1', 'source schema')
        require(source['lane'] == lane, f'{lane}: source lane')
        require(source['gameBuild'] == lanes[lane], f'{lane}: stale gameBuild')
        require(sha(path) == source['recordSha256'], f'{lane}: record sha256')
        engine = record['engine']
        require(engine['sha256'] == source['exeSha256'], f'{lane}: exe sha256')
        require(engine['platform'] == source['platform'] == 'windows-x86_64', f'{lane}: platform')
        for key in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256'):
            require(source['peIdentity'][key] == engine[key], f'{lane}: PE {key}')
        require(record['calibrator']['version'] == source['calibrator']['version'] == version, f'{lane}: calibrator version')
        records[lane] = source
        print(f'Windows capture record: {lane} ok')
    for lane in lanes.keys() - records.keys():
        print(f'Windows capture record: {lane} absent; streaming unavailable for this engine')
    for value in sys.argv[4:]:
        lane, separator, exe = value.partition('=')
        require(separator and lane in lanes, f'unknown --exe lane: {lane}')
        require(lane in records, f'{lane}: no record to verify')
        require(sha(Path(exe)) == records[lane]['exeSha256'], f'{lane}: supplied exe sha256')
except (ValueError, KeyError, OSError, TypeError) as exc:
    sys.exit(f'render capture records: {exc}')
PY
if [[ ${#exes[@]} -gt 0 ]]; then
  for value in "${exes[@]}"; do
    lane="${value%%=*}"; exe="${value#*=}"
    output="$(python3 -I "$calibrator" --verify-record "$repo_root/eng/render-capture/windows/$lane.json" --binary "$exe" --header "$header")"
    printf '%s\n' "$output"
    grep -qx 'verified: 14/14' <<< "$output" || { echo 'expected verified: 14/14' >&2; exit 1; }
  done
fi
