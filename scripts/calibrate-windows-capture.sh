#!/usr/bin/env bash
# Calibrate and verify a Windows executable offline; no game process is launched.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe= game_build= steam_build= header= version_name=MegaDot
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'calibrate Windows capture: options require values' >&2; exit 2; }
  case "$1" in
    --exe) exe="$2" ;; --game-build) game_build="$2" ;;
    --steam-build) steam_build="$2" ;; --header) header="$2" ;; --version-name) version_name="$2" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n "$game_build" ]] || { echo '--game-build is required for provenance' >&2; exit 2; }
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
python3 -I - "$work" "$repo_root/eng/render-capture/windows" "$game_build" "$steam_build" "$(git -C "$gsw_root" rev-parse HEAD)" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
work, directory = map(Path, sys.argv[1:3])
def require(ok, message):
    if not ok: sys.exit(message)
data = (work / 'record').read_bytes()
record = json.loads(data)
engine = record['engine']
identity = json.loads((work / 'identity').read_text())
require(engine['platform'] == 'windows-x86_64', 'expected a Windows x86_64 executable')
version = re.match(r'^MegaDot v(\d+\.\d+\.\d+)\.m\.(\d+)(?:\.|$)', engine['version_string'])
require(version is not None, 'expected a MegaDot engine version')
codeview_id = engine['codeview_id']
require(isinstance(codeview_id, str) and re.fullmatch(r'[0-9a-f]{32}:\d+', codeview_id) is not None,
        'expected a PE codeview_id')
engine_id = f'megadot-{version[1]}-m{version[2]}-{codeview_id[:8]}'
pe_identity = {k: identity[k] for k in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256')}
require(all(engine[k] == v for k, v in pe_identity.items()) and engine['sha256'] == identity['sha256'],
        'calibrated record differs from executable identity')
seen = dict(gameBuild=sys.argv[3], steamBuildId=sys.argv[4] or None,
            basis='Executable calibrated and verified offline.')
record_path = directory / f'{engine_id}.json'
source_path = directory / f'{engine_id}.source.json'
if record_path.exists():
    require(record_path.read_bytes() == data, 'existing engine record differs; refusing to replace it')
    source = json.loads(source_path.read_text())
    require(source['schema'] == 'couchcoop-render-capture-record-source/2' and source['engineId'] == engine_id
            and source['recordSha256'] == hashlib.sha256(data).hexdigest()
            and source['exeSha256'] == engine['sha256'] and source['peIdentity'] == pe_identity,
            'existing engine source differs from record')
    if not any(item['gameBuild'] == seen['gameBuild'] and item['steamBuildId'] == seen['steamBuildId']
               for item in source['gameBuildsSeen']):
        source['gameBuildsSeen'].append(seen)
        source_path.write_text(json.dumps(source, indent=2) + '\n')
else:
    require(not source_path.exists(), 'orphan source record; refusing to replace it')
    source = dict(schema='couchcoop-render-capture-record-source/2', engineId=engine_id,
                  platform='windows-x86_64', gameBuildsSeen=[seen], exeSha256=identity['sha256'],
                  peIdentity=pe_identity, recordSha256=hashlib.sha256(data).hexdigest(),
                  calibrator=dict(version=record['calibrator']['version'], gswCommit=sys.argv[5],
                                  headerSha256=record['calibrator']['header_sha256']))
    record_path.write_bytes(data)
    source_path.write_text(json.dumps(source, indent=2) + '\n')
print(f'Windows capture record: {engine_id} ({sys.argv[3]}) verified: 14/14')
PY
