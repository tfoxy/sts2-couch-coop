#!/usr/bin/env bash
# Synthetic release-record checks: no game, toolchain or calibration work required.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/couch/scripts" "$work/couch/eng/render-capture/"{linux,windows} "$work/gsw/experiments/render-stream/capture/tools"
cp "$here/check-render-capture-records.sh" "$work/couch/scripts/"
calibrator="$work/gsw/experiments/render-stream/capture/tools/calibrate.py"
cat > "$calibrator" <<'PY'
import hashlib, json, sys
from pathlib import Path
CALIBRATOR_VERSION = "9"
assert '--header' in sys.argv
record = Path(sys.argv[sys.argv.index('--verify-record') + 1])
engine = json.loads(record.read_text())['engine']
assert record.parent.name == engine['platform'].split('-')[0]
binary = Path(sys.argv[sys.argv.index('--binary') + 1])
assert hashlib.sha256(binary.read_bytes()).hexdigest() == engine['sha256']
print('verified: 14/14')
PY
printf 'exe' > "$work/engine.exe"
printf 'linux-exe' > "$work/engine-linux"
printf 'header' > "$work/header.h"
windows_id=megadot-4.5.1-m12-aaaaaaaa
linux_id=megadot-4.5.1-m14-dddddddd
reset_fixture() {
  rm -f "$work/couch/eng/render-capture/"{linux,windows}/*.json
  sed -i -e 's/CALIBRATOR_VERSION = "10"/CALIBRATOR_VERSION = "9"/' \
    -e 's/verified: 13\/14/verified: 14\/14/' "$calibrator"
  python3 -I - "$work" "$windows_id" "$linux_id" <<'PY'
import hashlib, json, sys
from pathlib import Path
work = Path(sys.argv[1])
root = work / 'couch/eng/render-capture'
for os, engine_id, version, binary in [('windows', sys.argv[2], 12, 'engine.exe'), ('linux', sys.argv[3], 14, 'engine-linux')]:
    engine = dict(platform=f'{os}-x86_64', sha256=hashlib.sha256((work / binary).read_bytes()).hexdigest(),
                  version_string=f'MegaDot v4.5.1.m.{version}.mono.custom_build')
    if os == 'windows':
        engine.update(size_of_image=8192, time_date_stamp=123, codeview_id='a'*32 + ':1', image_sha256='a'*64)
    else:
        engine['build_id'] = 'd'*40
    record = dict(engine=engine, calibrator=dict(version='9', header_sha256='e'*64))
    data = json.dumps(record).encode()
    source = dict(schema='couchcoop-render-capture-record-source/2', engineId=engine_id, platform=engine['platform'],
        gameBuildsSeen=[dict(gameBuild='v0.0.1', steamBuildId='123', basis='Synthetic fixture.')],
        exeSha256=engine['sha256'], recordSha256=hashlib.sha256(data).hexdigest(),
        calibrator=dict(version='9', headerSha256='e'*64, gswCommit='a'*40))
    if os == 'windows':
        source['peIdentity'] = {k: engine[k] for k in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256')}
    else:
        source['elfIdentity'] = dict(build_id=engine['build_id'])
    (root / os / f'{engine_id}.json').write_bytes(data)
    (root / os / f'{engine_id}.source.json').write_text(json.dumps(source))
PY
}
mutate() {
  python3 -I - "$work/couch/eng/render-capture/${2:-windows}" "$1" "$windows_id" "$linux_id" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1]); mode = sys.argv[2]
engine_id = sys.argv[4] if root.name == 'linux' else sys.argv[3]
record_path = root / f'{engine_id}.json'; source_path = root / f'{engine_id}.source.json'
record = json.loads(record_path.read_text()); source = json.loads(source_path.read_text())
if mode == 'sha': record['extra'] = True
elif mode == 'platform': record['engine']['platform'] = source['platform'] = 'unsupported-x86_64'
elif mode == 'identity': source['elfIdentity']['build_id'] = 'f'*40
elif mode.startswith('pe-'):
    key = mode[3:]
    source['peIdentity'][key] = 'wrong' if isinstance(source['peIdentity'][key], str) else 0
elif mode == 'build-id': record['engine']['build_id'] = source['elfIdentity']['build_id'] = ''
elif mode == 'codeview': record['engine']['codeview_id'] = source['peIdentity']['codeview_id'] = None
elif mode == 'header': source['calibrator']['headerSha256'] = 'f'*64
elif mode == 'schema': source['schema'] = 'couchcoop-render-capture-record-source/1'
elif mode == 'engine-id': source['engineId'] = 'other'
elif mode == 'exe': source['exeSha256'] = 'b'*64
elif mode == 'version': record['calibrator']['version'] = source['calibrator']['version'] = '8'
elif mode == 'source-version': source['calibrator']['version'] = '8'
elif mode == 'engine-version': record['engine']['version_string'] = 'MegaDot v4.5.1.m.99.mono.custom_build'
elif mode == 'provenance': source['gameBuildsSeen'].append(dict(gameBuild='v9.9.9', steamBuildId='unknown', basis='Unrelated release.'))
elif mode in ('name', 'id8', 'duplicate'):
    if mode == 'name': renamed = 'nightly'
    elif mode == 'id8': renamed = engine_id[:-8] + 'ffffffff'
    else: renamed = engine_id.replace('-m12-', '-m13-').replace('-m14-', '-m15-')
    if mode != 'duplicate':
        record_path.unlink(); source_path.unlink()
    record_path = root / f'{renamed}.json'; source_path = root / f'{renamed}.source.json'
    source['engineId'] = renamed
else: raise ValueError(mode)
data = json.dumps(record).encode()
if mode != 'sha': source['recordSha256'] = hashlib.sha256(data).hexdigest()
record_path.write_bytes(data); source_path.write_text(json.dumps(source))
PY
}
run() { COUCHCOOP_GSW_ROOT="$work/gsw" bash "$work/couch/scripts/check-render-capture-records.sh" "$@" > "$work/output" 2>&1; }
checks=0
accept() { if ! run "$@"; then cat "$work/output"; exit 1; fi; checks=$((checks+1)); }
reject() {
  local reason="$1"; shift
  if run "$@"; then echo "FAIL: accepted $reason" >&2; exit 1; fi
  grep -q -- "$reason" "$work/output" || { cat "$work/output"; exit 1; }
  checks=$((checks+1))
}
reset_fixture; accept
[[ "$(wc -l < "$work/output")" -eq 2 ]]
grep -qx "Linux capture record: $linux_id ok" "$work/output"
grep -qx "Windows capture record: $windows_id ok" "$work/output"
accept --exe "$windows_id=$work/engine.exe" --exe "$linux_id=$work/engine-linux" --header "$work/header.h"
reject '--header is required' --exe "$windows_id=$work/engine.exe"
reject 'unknown --exe engineId: stable' --exe "stable=$work/engine.exe" --header "$work/header.h"
reject 'unknown --exe engineId' --exe "$windows_id" --header "$work/header.h"
reset_fixture
printf 'wrong exe' > "$work/wrong.exe"
reject 'supplied exe sha256' --exe "$windows_id=$work/wrong.exe" --header "$work/header.h"
reset_fixture
sed -i 's/CALIBRATOR_VERSION = "9"/CALIBRATOR_VERSION = "10"/' "$calibrator"
reject 'calibrator version'
reset_fixture
sed -i 's/verified: 14\/14/verified: 13\/14/' "$calibrator"
reject 'expected verified: 14/14' --exe "$windows_id=$work/engine.exe" --header "$work/header.h"
for os in linux windows; do
  for pair in 'sha:record sha256' 'platform:platform' 'schema:source schema' 'engine-id:source engineId' \
    'exe:exe sha256' 'version:calibrator version' 'source-version:calibrator version' \
    'name:invalid engineId name' 'id8:engineId id8' 'duplicate:duplicate engine identity' 'engine-version:engineId version'; do
    reset_fixture; mutate "${pair%%:*}" "$os"; reject "${pair#*:}"
  done
  reset_fixture; mutate provenance "$os"; accept
  if [[ "$os" == linux ]]; then engine_id="$linux_id"; else engine_id="$windows_id"; fi
  reset_fixture
  rm "$work/couch/eng/render-capture/$os/$engine_id.json"
  reject 'orphan source record'
  reset_fixture
  rm "$work/couch/eng/render-capture/$os/$engine_id.source.json"
  reject "$engine_id.source.json"
  reset_fixture
  reject 'supplied exe sha256' --exe "$engine_id=$work/wrong.exe" --header "$work/header.h"
done
for key in size_of_image time_date_stamp codeview_id image_sha256; do
  reset_fixture; mutate "pe-$key"; reject "PE $key"
done
reset_fixture; mutate codeview; reject 'invalid PE codeview_id'
for pair in 'identity:GNU build-id' 'build-id:invalid GNU build-id' 'header:calibrator header sha256'; do
  reset_fixture; mutate "${pair%%:*}" linux; reject "${pair#*:}"
done

# Exercise calibration writes in the same isolated fixture; no executable or committed record is changed.
cp "$here/calibrate-windows-capture.sh" "$work/couch/scripts/"
reset_fixture
cp "$work/couch/eng/render-capture/windows/$windows_id.json" "$work/calibration-template"
rm "$work/couch/eng/render-capture/windows/"*.json
cat > "$calibrator" <<'PY_CALIBRATOR'
import json, os, sys
from pathlib import Path
CALIBRATOR_VERSION = "9"
data = Path(os.environ['CAPTURE_TEST_RECORD']).read_bytes()
if '--out' in sys.argv:
    Path(sys.argv[sys.argv.index('--out') + 1]).write_bytes(data)
elif '--pe-identity' in sys.argv:
    print(json.dumps(json.loads(data)['engine']))
else:
    print('verified: 14/14')
PY_CALIBRATOR
git -C "$work/gsw" init -q
git -C "$work/gsw" -c user.email=t@t -c user.name=t add -A
git -C "$work/gsw" -c user.email=t@t -c user.name=t commit -qm fixture
calibrate() {
  CAPTURE_TEST_RECORD="$work/calibration-template" COUCHCOOP_GSW_ROOT="$work/gsw" \
    bash "$work/couch/scripts/calibrate-windows-capture.sh" --exe "$work/engine.exe" \
    --header "$work/header.h" --game-build "$1" --steam-build "$2" > "$work/output" 2>&1
}
calibrate v9.9.1 101
cmp "$work/calibration-template" "$work/couch/eng/render-capture/windows/$windows_id.json"
checks=$((checks+1))
python3 -I - "$work/couch/eng/render-capture/windows/$windows_id.source.json" <<'PY_SOURCE'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
source = json.loads(path.read_text())
assert source['schema'] == 'couchcoop-render-capture-record-source/2'
assert source['gameBuildsSeen'] == [dict(gameBuild='v9.9.1', steamBuildId='101',
                                      basis='Executable calibrated and verified offline.')]
source['provenance'] = dict(preserved='original source')
source['calibrator']['gswCommit'] = 'b'*40
path.write_text(json.dumps(source, indent=2) + '\n')
PY_SOURCE
calibrate v9.9.2 102
cmp "$work/calibration-template" "$work/couch/eng/render-capture/windows/$windows_id.json"
python3 -I - "$work/couch/eng/render-capture/windows/$windows_id.source.json" <<'PY_SOURCE'
import json, sys
from pathlib import Path
source = json.loads(Path(sys.argv[1]).read_text())
assert [(s['gameBuild'], s['steamBuildId']) for s in source['gameBuildsSeen']] == [('v9.9.1', '101'), ('v9.9.2', '102')]
assert source['provenance'] == dict(preserved='original source')
assert source['calibrator']['gswCommit'] == 'b'*40
PY_SOURCE
checks=$((checks+1))
cp "$work/couch/eng/render-capture/windows/$windows_id.source.json" "$work/source-before"
calibrate v9.9.2 102
cmp "$work/source-before" "$work/couch/eng/render-capture/windows/$windows_id.source.json"
checks=$((checks+1))
printf ' ' >> "$work/calibration-template"
if calibrate v9.9.3 103; then echo 'FAIL replaced an existing engine record' >&2; exit 1; fi
grep -q 'existing engine record differs' "$work/output"
cmp "$work/source-before" "$work/couch/eng/render-capture/windows/$windows_id.source.json"
checks=$((checks+1))
echo "render capture records: $checks checks passed"
