#!/usr/bin/env bash
# Synthetic release-record checks: no game, toolchain or calibration work required.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/couch/scripts/lib" "$work/couch/eng/render-capture/"{linux,windows} "$work/gsw/experiments/render-stream/capture/tools"
cp "$here/check-render-capture-records.sh" "$work/couch/scripts/"
cp "$here/lib/"release-{lanes,portable}.sh "$work/couch/scripts/lib/"
calibrator="$work/gsw/experiments/render-stream/capture/tools/calibrate.py"
cat > "$calibrator" <<'PY'
import sys
CALIBRATOR_VERSION = "9"
assert '--header' in sys.argv
print('verified: 14/14')
PY
printf 'exe' > "$work/engine.exe"
printf 'header' > "$work/header.h"
reset_fixture() {
  rm -f "$work/couch/eng/render-capture/"{linux,windows}/*.json
  cp "$here/lib/release-lanes.sh" "$work/couch/scripts/lib/"
  sed -i 's/CALIBRATOR_VERSION = "10"/CALIBRATOR_VERSION = "9"/' "$calibrator"
  python3 -I - "$work" <<'PY'
import hashlib, json, sys
from pathlib import Path
work = Path(sys.argv[1])
root = work / 'couch/eng/render-capture'
record = dict(engine=dict(platform='windows-x86_64', sha256=hashlib.sha256(b'exe').hexdigest(),
    size_of_image=8192, time_date_stamp=123, codeview_id=None, image_sha256='a'*64), calibrator=dict(version='9'))
data = json.dumps(record).encode()
source = dict(schema='couchcoop-render-capture-record-source/1', lane='stable', platform='windows-x86_64',
    gameBuild='v0.107.1', exeSha256=record['engine']['sha256'], recordSha256=hashlib.sha256(data).hexdigest(),
    peIdentity={k: record['engine'][k] for k in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256')},
    calibrator=dict(version='9', gswCommit='a'*40))
(root / 'windows/stable.json').write_bytes(data)
(root / 'windows/stable.source.json').write_text(json.dumps(source))
record = dict(engine=dict(platform='linux-x86_64', sha256='c'*64, build_id='d'*40),
    calibrator=dict(version='9', header_sha256='e'*64))
data = json.dumps(record).encode()
source = dict(schema='couchcoop-render-capture-record-source/1', lane='beta-v113', platform='linux-x86_64',
    gameBuild='v0.113.0', exeSha256=record['engine']['sha256'], recordSha256=hashlib.sha256(data).hexdigest(),
    elfIdentity=dict(build_id=record['engine']['build_id']), calibrator=dict(version='9', headerSha256='e'*64))
(root / 'linux/beta-v113.json').write_bytes(data)
(root / 'linux/beta-v113.source.json').write_text(json.dumps(source))
(root / 'calibration-linux.json').write_text(json.dumps(dict(engine=dict(platform='linux-x86_64'), calibrator=dict(version='9'))))
PY
}
mutate() {
  python3 -I - "$work/couch/eng/render-capture/${2:-windows}" "$1" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1]); mode = sys.argv[2]
lane = 'beta-v113' if root.name == 'linux' else 'stable'
record_path = root / f'{lane}.json'; source_path = root / f'{lane}.source.json'
record = json.loads(record_path.read_text()); source = json.loads(source_path.read_text())
if mode == 'sha': record['extra'] = True
elif mode == 'platform': record['engine']['platform'] = source['platform'] = 'unsupported-x86_64'
elif mode == 'identity':
    if root.name == 'linux': source['elfIdentity']['build_id'] = 'f'*40
    else: source['peIdentity']['size_of_image'] += 1
elif mode == 'build-id': record['engine']['build_id'] = source['elfIdentity']['build_id'] = ''
elif mode == 'header': source['calibrator']['headerSha256'] = 'f'*64
elif mode == 'schema': source['schema'] = 'unknown'
elif mode == 'lane': source['lane'] = 'public-beta'
elif mode == 'exe': source['exeSha256'] = 'b'*64
elif mode == 'version': record['calibrator']['version'] = source['calibrator']['version'] = '8'
elif mode == 'game': source['gameBuild'] = 'v0.0.1'
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
grep -q 'public-beta absent' "$work/output"
accept --exe "stable=$work/engine.exe" --header "$work/header.h"
reject '--header is required' --exe "stable=$work/engine.exe"
for pair in 'sha:record sha256' 'platform:platform' 'identity:PE size_of_image' 'lane:source lane' 'exe:exe sha256' 'version:calibrator version' 'game:stale gameBuild'; do
  reset_fixture; mutate "${pair%%:*}"; reject "${pair#*:}"
done
reset_fixture
sed -i 's/v0.107.1/v0.107.2/g' "$work/couch/scripts/lib/release-lanes.sh"
reject 'stale gameBuild'
reset_fixture
sed -i 's/CALIBRATOR_VERSION = "9"/CALIBRATOR_VERSION = "10"/' "$calibrator"
reject 'calibrator version'
reset_fixture
mv "$work/couch/eng/render-capture/windows/stable.json" "$work/couch/eng/render-capture/windows/nightly.json"
mv "$work/couch/eng/render-capture/windows/stable.source.json" "$work/couch/eng/render-capture/windows/nightly.source.json"
reject 'unknown lane: nightly'
reset_fixture
printf 'wrong exe' > "$work/wrong.exe"
reject 'supplied exe sha256' --exe "stable=$work/wrong.exe" --header "$work/header.h"
reset_fixture
rm "$work/couch/eng/render-capture/windows/stable.json"
reject 'orphan source record'
for pair in 'sha:record sha256' 'platform:platform' 'identity:GNU build-id' 'build-id:invalid GNU build-id' 'header:calibrator header sha256' 'schema:source schema' 'lane:source lane' 'exe:exe sha256' 'version:calibrator version' 'game:stale gameBuild'; do
  reset_fixture; mutate "${pair%%:*}" linux; reject "Linux beta-v113: ${pair#*:}"
done
reset_fixture
sed -i 's/v0.113.0/v0.114.0/g' "$work/couch/scripts/lib/release-lanes.sh"
reject 'Linux beta-v113: stale gameBuild'
reset_fixture
rm "$work/couch/eng/render-capture/linux/beta-v113.json"
reject 'Linux orphan source record'
reset_fixture
rm "$work/couch/eng/render-capture/linux/beta-v113.source.json"
reject 'beta-v113.source.json'
reset_fixture
mv "$work/couch/eng/render-capture/linux/beta-v113.json" "$work/couch/eng/render-capture/linux/nightly.json"
mv "$work/couch/eng/render-capture/linux/beta-v113.source.json" "$work/couch/eng/render-capture/linux/nightly.source.json"
reject 'Linux unknown lane: nightly'
echo "render capture records: $checks checks passed"
