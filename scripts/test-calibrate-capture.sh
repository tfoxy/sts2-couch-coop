#!/usr/bin/env bash
# Synthetic calibration refresh checks; no game executable or committed record is changed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/couch/scripts" "$work/gsw/experiments/render-stream/capture/tools" "$work/bin"
cp "$here/calibrate-capture.sh" "$here/calibrate-windows-capture.sh" "$work/couch/scripts/"
cat > "$work/gsw/experiments/render-stream/capture/tools/calibrate.py" <<'PY'
import json, os, sys
from pathlib import Path
CALIBRATOR_VERSION = "9"
data = Path(os.environ['CAPTURE_TEST_RECORD']).read_bytes()
if '--out' in sys.argv:
    Path(sys.argv[sys.argv.index('--out') + 1]).write_bytes(data)
elif '--pe-identity' in sys.argv:
    print(json.dumps(json.loads(data)['engine']))
else:
    print(os.environ.get('CAPTURE_TEST_VERIFICATION', 'verified: 37/37'))
PY
cat > "$work/bin/readelf" <<'SH'
#!/usr/bin/env bash
printf 'Build ID: dddddddddddddddddddddddddddddddddddddddd\n'
SH
chmod +x "$work/bin/readelf"
git -C "$work/gsw" init -q
git -C "$work/gsw" -c user.email=t@t -c user.name=t add -A
git -C "$work/gsw" -c user.email=t@t -c user.name=t commit -qm fixture
printf 'exe' > "$work/engine"
printf 'header' > "$work/header.h"
export CAPTURE_TEST_RECORD="$work/template" COUCHCOOP_GSW_ROOT="$work/gsw"
export PATH="$work/bin:$PATH"
checks=0
calibrate() {
  bash "$work/couch/scripts/calibrate-capture.sh" --platform "$platform" --exe "$work/engine" \
    --header "$work/header.h" "$@" > "$work/output" 2>&1
}
accept() { if ! calibrate "$@"; then cat "$work/output"; exit 1; fi; checks=$((checks+1)); }
reject() {
  local reason="$1"; shift
  if calibrate "$@"; then echo "FAIL: accepted $reason" >&2; exit 1; fi
  grep -q -- "$reason" "$work/output" || { cat "$work/output"; exit 1; }
  if [[ -f "$work/record-before" ]]; then
    cmp "$work/record-before" "$record"
    cmp "$work/source-before" "$source"
  fi
  checks=$((checks+1))
}
for platform in linux windows; do
  python3 -I - "$work" "$platform" <<'PY'
import hashlib, json, sys
from pathlib import Path
work = Path(sys.argv[1]); platform = sys.argv[2]
engine = dict(platform=f'{platform}-x86_64', sha256=hashlib.sha256((work / 'engine').read_bytes()).hexdigest(),
              version_string='MegaDot v4.5.1.m.14.mono.custom_build')
if platform == 'windows':
    engine.update(size_of_image=8192, time_date_stamp=123, codeview_id='a'*32 + ':1', image_sha256='a'*64)
else:
    engine['build_id'] = 'd'*40
record = dict(engine=engine, calibrator=dict(version='9', header_sha256='e'*64), slots=dict(old=1))
(work / 'template').write_text(json.dumps(record))
PY
  if [[ "$platform" == linux ]]; then id8=dddddddd; else id8=aaaaaaaa; fi
  record="$work/couch/eng/render-capture/$platform/megadot-4.5.1-m14-$id8.json"
  source="${record%.json}.source.json"
  rm -f "$work/record-before" "$work/source-before"
  reject 'no existing engine record to refresh' --refresh
  accept --game-build v0.1.0 --steam-build 123
  python3 -I - "$source" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1]); source = json.loads(path.read_text())
source['calibrator']['gswCommit'] = 'b'*40
source['provenance'] = dict(command='original calibration', mergedSources=[dict(calibrator=dict(version='8'))])
path.write_text(json.dumps(source, indent=2) + '\n')
PY
  cp "$record" "$work/record-before"
  cp "$source" "$work/source-before"
  calibrator="$work/gsw/experiments/render-stream/capture/tools/calibrate.py"
  cp "$calibrator" "$work/calibrator-clean"
  printf '\n# Local edit.\n' >> "$calibrator"
  reject 'modified GSW calibrator tools' --refresh
  git -C "$work/gsw" add experiments/render-stream/capture/tools/calibrate.py
  reject 'modified GSW calibrator tools' --refresh
  cp "$work/calibrator-clean" "$calibrator"
  git -C "$work/gsw" add experiments/render-stream/capture/tools/calibrate.py
  printf '# Local helper.\n' > "$work/gsw/experiments/render-stream/capture/tools/helper.py"
  reject 'modified GSW calibrator tools' --refresh
  rm "$work/gsw/experiments/render-stream/capture/tools/helper.py"
  python3 -I - "$work/template" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1]); record = json.loads(path.read_text())
record['slots'].update(viewport_create=2, texture_proxy_create=3, texture_set_size_override=4)
record['calibrator']['header_sha256'] = 'f'*64
path.write_text(json.dumps(record))
PY
  cp "$work/template" "$work/refreshed-template"
  reject 'existing engine record differs' --game-build v0.1.1
  for verification in 'verified: 36/37' 'verified: 0/0' 'no verification summary' $'verified: 37/37\nverified: 37/37'; do
    export CAPTURE_TEST_VERIFICATION="$verification"
    reject 'expected all checks verified' --refresh
  done
  unset CAPTURE_TEST_VERIFICATION
  # The filename remains the same for these mutations, but the executable identity does not.
  for field in sha256 version_string platform old-identity; do
    python3 -I - "$work" "$platform" "$field" <<'PY'
import json, sys
from pathlib import Path
work = Path(sys.argv[1]); platform, field = sys.argv[2:]
record = json.loads((work / 'refreshed-template').read_text())
if field == 'sha256': record['engine'][field] = '0'*64
elif field == 'version_string': record['engine'][field] += '.changed'
elif field == 'platform': record['engine'][field] = 'other-x86_64'
elif platform == 'windows': record['engine']['time_date_stamp'] += 1
else: record['engine']['build_id'] = 'd'*39 + 'e'
(work / 'template').write_text(json.dumps(record))
PY
    case "$field" in
      sha256) reason='executable sha256' ;;
      version_string) reason='existing engine source differs' ;;
      platform) reason='expected a' ;;
      old-identity) if [[ "$platform" == windows ]]; then reason='existing engine source differs'; else reason='executable identity'; fi ;;
    esac
    reject "$reason" --refresh
  done
  cp "$work/refreshed-template" "$work/template"
  accept --refresh
  cmp "$work/template" "$record"
  python3 -I - "$source" "$work/source-before" "$record" "$work/gsw" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path
source, before = (json.loads(Path(p).read_text()) for p in sys.argv[1:3])
assert source['gameBuildsSeen'] == before['gameBuildsSeen']
for key in ('engineId', 'platform', 'exeSha256', 'elfIdentity', 'peIdentity'):
    assert source.get(key) == before.get(key)
assert source['recordSha256'] == hashlib.sha256(Path(sys.argv[3]).read_bytes()).hexdigest()
assert source['calibrator'] == dict(version='9', headerSha256='f'*64,
    gswCommit=subprocess.check_output(['git', '-C', sys.argv[4], 'rev-parse', 'HEAD'], text=True).strip())
assert source['provenance']['mergedSources'] == before['provenance']['mergedSources'] + [
    dict(calibrator=before['calibrator'], provenance=dict(command='original calibration'))]
assert '--refresh' in source['provenance']['command']
PY
  checks=$((checks+1))
  cp "$record" "$work/record-before"
  cp "$source" "$work/source-before"
  accept --refresh
  cmp "$work/source-before" "$source"
  checks=$((checks+1))
  # A refresh with identical inputs must still retain any earlier provenance.
  python3 -I - "$source" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1]); source = json.loads(path.read_text())
source['provenance']['basis'] = 'Earlier evidence with the same calibrator.'
path.write_text(json.dumps(source, indent=2) + '\n')
PY
  cp "$source" "$work/source-before"
  accept --refresh
  python3 -I - "$source" "$work/source-before" <<'PY'
import json, sys
from pathlib import Path
source, before = (json.loads(Path(p).read_text()) for p in sys.argv[1:])
provenance = dict(before['provenance'])
merged = provenance.pop('mergedSources')
assert source['provenance']['mergedSources'] == merged + [dict(calibrator=before['calibrator'], provenance=provenance)]
PY
  checks=$((checks+1))
done
echo "calibrate capture: $checks checks passed"
