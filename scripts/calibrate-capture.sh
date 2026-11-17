#!/usr/bin/env bash
# Calibrate and verify an executable offline; no game process is launched.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe= game_build= steam_build= header= platform= version_name=MegaDot refresh=false
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --refresh ]]; then refresh=true; shift; continue; fi
  [[ $# -ge 2 ]] || { echo 'calibrate capture: options require values' >&2; exit 2; }
  case "$1" in
    --exe) exe="$2" ;; --game-build) game_build="$2" ;;
    --steam-build) steam_build="$2" ;; --header) header="$2" ;; --version-name) version_name="$2" ;;
    --platform) platform="$2" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ "$platform" == linux || "$platform" == windows ]] || { echo '--platform must be linux or windows' >&2; exit 2; }
[[ "$refresh" == true || -n "$game_build" ]] || { echo '--game-build is required for provenance' >&2; exit 2; }
[[ -f "$exe" && -f "$header" ]] || { echo '--exe and --header must name existing files' >&2; exit 2; }
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
gsw_root="$(cd "$gsw_root" && pwd -P)"
calibrator="$gsw_root/experiments/render-stream/capture/tools/calibrate.py"
gsw_tools_status="$(git -C "$gsw_root" status --porcelain -- experiments/render-stream/capture/tools/)"
if [[ -n "$gsw_tools_status" ]]; then
  echo 'calibrate capture: modified GSW calibrator tools; refusing to record commit provenance' >&2
  exit 1
fi
mkdir -p "$repo_root/.local" "$repo_root/eng/render-capture/$platform"
work="$(mktemp -d "$repo_root/.local/$platform-calibration.XXXXXX")"
trap 'rm -rf "$work"' EXIT
python3 -I "$calibrator" --binary "$exe" --header "$header" --version-name "$version_name" --out "$work/record"
if [[ "$platform" == windows ]]; then
  python3 -I "$calibrator" --pe-identity "$exe" > "$work/identity"
else
  readelf -n "$exe" > "$work/identity"
fi
python3 -I "$calibrator" --verify-record "$work/record" --binary "$exe" --header "$header" | tee "$work/verification"
python3 -I -c 'import re, sys
counts = re.findall(r"^verified: ([1-9][0-9]*)/([0-9]+)$", sys.stdin.read(), re.M)
sys.exit(0 if len(counts) == 1 and counts[0][0] == counts[0][1] else "expected all checks verified")' < "$work/verification"
python3 -I - "$work" "$repo_root/eng/render-capture/$platform" "$game_build" "$steam_build" "$(git -C "$gsw_root" rev-parse HEAD)" "$refresh" "$exe" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
work, directory = map(Path, sys.argv[1:3])
def require(ok, message):
    if not ok: sys.exit(message)
data = (work / 'record').read_bytes()
record = json.loads(data)
engine = record['engine']
platform = directory.name
refresh = sys.argv[6] == 'true'
require(engine['platform'] == f'{platform}-x86_64', f'expected a {platform} x86_64 executable')
require(engine['sha256'] == hashlib.sha256(Path(sys.argv[7]).read_bytes()).hexdigest(),
        'calibrated record differs from executable sha256')
version = re.match(r'^MegaDot v(\d+\.\d+\.\d+)\.m\.(\d+)(?:\.|$)', engine['version_string'])
require(version is not None, 'expected a MegaDot engine version')
if platform == 'windows':
    identity = json.loads((work / 'identity').read_text())
    codeview_id = engine['codeview_id']
    require(isinstance(codeview_id, str) and re.fullmatch(r'[0-9a-f]{32}:\d+', codeview_id) is not None,
            'expected a PE codeview_id')
    id8 = codeview_id[:8]
    identity_key = 'peIdentity'
    executable_identity = {k: identity[k] for k in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256')}
    require(engine['sha256'] == identity['sha256'], 'calibrated record differs from executable identity')
else:
    build_id = re.search(r'Build ID: ([0-9a-f]+)', (work / 'identity').read_text())
    require(build_id is not None, 'expected a GNU build-id')
    id8 = build_id[1][:8]
    identity_key = 'elfIdentity'
    executable_identity = dict(build_id=build_id[1])
require(all(engine[k] == v for k, v in executable_identity.items()),
        'calibrated record differs from executable identity')
engine_id = f'megadot-{version[1]}-m{version[2]}-{id8}'
seen = dict(gameBuild=sys.argv[3], steamBuildId=sys.argv[4] or None,
            basis='Executable calibrated and verified offline.')
record_path = directory / f'{engine_id}.json'
source_path = directory / f'{engine_id}.source.json'
calibrator = dict(version=record['calibrator']['version'], gswCommit=sys.argv[5],
                  headerSha256=record['calibrator']['header_sha256'])
command = f'scripts/calibrate-capture.sh --platform {platform} --exe <executable> --header <godot-header>'
command += ' --refresh' if refresh else ' --game-build <game-build> --steam-build <steam-build>'
if record_path.exists():
    previous_data = record_path.read_bytes()
    require(refresh or previous_data == data, 'existing engine record differs; refusing to replace it (use --refresh)')
    previous_record = json.loads(previous_data)
    source = json.loads(source_path.read_text())
    require(source['schema'] == 'couchcoop-render-capture-record-source/2' and source['engineId'] == engine_id
            and source['recordSha256'] == hashlib.sha256(previous_data).hexdigest()
            and source['platform'] == engine['platform']
            and source['exeSha256'] == engine['sha256'] and source[identity_key] == executable_identity
            and previous_record['engine'] == engine,
            'existing engine source differs from record')
    if refresh:
        provenance = dict(source.get('provenance', {}))
        merged = list(provenance.pop('mergedSources', []))
        prior = dict(calibrator=source['calibrator'])
        if provenance: prior['provenance'] = provenance
        if source['calibrator'] != calibrator or previous_data != data or provenance != dict(command=command):
            merged.append(prior)
        source.update(recordSha256=hashlib.sha256(data).hexdigest(), calibrator=calibrator,
                      provenance=dict(command=command, mergedSources=merged))
    elif not any(item['gameBuild'] == seen['gameBuild'] and item['steamBuildId'] == seen['steamBuildId']
                 for item in source['gameBuildsSeen']):
        source['gameBuildsSeen'].append(seen)
else:
    require(not refresh, 'no existing engine record to refresh')
    require(not source_path.exists(), 'orphan source record; refusing to replace it')
    source = dict(schema='couchcoop-render-capture-record-source/2', engineId=engine_id,
                  platform=engine['platform'], gameBuildsSeen=[seen], exeSha256=engine['sha256'],
                  recordSha256=hashlib.sha256(data).hexdigest(), calibrator=calibrator,
                  provenance=dict(command=command), **{identity_key: executable_identity})
record_path.write_bytes(data)
source_path.write_text(json.dumps(source, indent=2) + '\n')
print(f'{platform.title()} capture record: {engine_id} verified')
PY
