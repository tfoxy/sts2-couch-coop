#!/usr/bin/env bash
# Check committed engine records against their identities and calibrator inputs before release builds.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gsw_root="${COUCHCOOP_GSW_ROOT:-$repo_root/../godot-scene-web}"
calibrator="$gsw_root/experiments/render-stream/capture/tools/calibrate.py"
header= exes=()
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 ]] || { echo 'usage: check-render-capture-records.sh [--exe ENGINE_ID=PATH]... [--header H]' >&2; exit 2; }
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
python3 -I - "$repo_root" "$calibrator" "${exes[@]}" <<'PY'
import hashlib, json, re, sys
from pathlib import Path
root, calibrator = map(Path, sys.argv[1:3])
def require(ok, message):
    if not ok: raise ValueError(message)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
try:
    match = re.search(r'^CALIBRATOR_VERSION\s*=\s*[\'"]([^\'"]+)', calibrator.read_text(), re.M)
    require(match is not None, 'cannot read GSW calibrator version')
    version = match.group(1)
    records = {}
    for os, label in (('linux', 'Linux'), ('windows', 'Windows')):
        directory = root / 'eng/render-capture' / os
        identities = set()
        for path in sorted(directory.glob('*.source.json')):
            require(path.with_name(path.name.replace('.source.json', '.json')).is_file(), f'{label} orphan source record')
        for path in sorted(directory.glob('*.json')):
            if path.name.endswith('.source.json'): continue
            engine_id = path.stem
            prefix = f'{label} {engine_id}'
            record = json.loads(path.read_text())
            source = json.loads(path.with_suffix('.source.json').read_text())
            require(source['schema'] == 'couchcoop-render-capture-record-source/2', f'{prefix}: source schema')
            require(source['engineId'] == engine_id, f'{prefix}: source engineId')
            name = re.fullmatch(r'megadot-(\d+\.\d+\.\d+)-m(\d+)-([0-9a-f]{8})', engine_id)
            require(name is not None, f'{prefix}: invalid engineId name')
            require(sha(path) == source['recordSha256'], f'{prefix}: record sha256')
            engine = record['engine']
            require(engine['sha256'] == source['exeSha256'], f'{prefix}: exe sha256')
            require(engine['platform'] == source['platform'] == f'{os}-x86_64', f'{prefix}: platform')
            if os == 'linux':
                build_id = engine['build_id']
                require(isinstance(build_id, str) and re.fullmatch(r'[0-9a-f]{8,}', build_id) is not None
                        and len(build_id) % 2 == 0, f'{prefix}: invalid GNU build-id')
                require(source['elfIdentity']['build_id'] == build_id, f'{prefix}: GNU build-id')
                require(record['calibrator']['header_sha256'] == source['calibrator']['headerSha256'],
                        f'{prefix}: calibrator header sha256')
                identity, id8 = build_id, build_id[:8]
            else:
                for key in ('size_of_image', 'time_date_stamp', 'codeview_id', 'image_sha256'):
                    require(source['peIdentity'][key] == engine[key], f'{prefix}: PE {key}')
                codeview_id = engine['codeview_id']
                require(isinstance(codeview_id, str) and re.fullmatch(r'[0-9a-f]{32}:\d+', codeview_id) is not None,
                        f'{prefix}: invalid PE codeview_id')
                identity = tuple(engine[key] for key in ('size_of_image', 'time_date_stamp', 'codeview_id'))
                id8 = codeview_id[:8]
            require(name.group(3) == id8, f'{prefix}: engineId id8')
            require(identity not in identities, f'{prefix}: duplicate engine identity')
            identities.add(identity)
            engine_version = re.match(r'^MegaDot v(\d+\.\d+\.\d+)\.m\.(\d+)(?:\.|$)', engine['version_string'])
            require(engine_version is not None and engine_version.groups() == name.group(1, 2),
                    f'{prefix}: engineId version')
            require(record['calibrator']['version'] == source['calibrator']['version'] == version,
                    f'{prefix}: calibrator version')
            records.setdefault(engine_id, []).append(source)
            print(f'{label} capture record: {engine_id} ok')
    for value in sys.argv[3:]:
        engine_id, separator, exe = value.partition('=')
        require(separator and engine_id in records, f'unknown --exe engineId: {engine_id}')
        require(len(records[engine_id]) == 1, f'ambiguous --exe engineId: {engine_id}')
        require(sha(Path(exe)) == records[engine_id][0]['exeSha256'], f'{engine_id}: supplied exe sha256')
except (ValueError, KeyError, OSError, TypeError) as exc:
    sys.exit(f'render capture records: {exc}')
PY
if [[ ${#exes[@]} -gt 0 ]]; then
  for value in "${exes[@]}"; do
    engine_id="${value%%=*}"; exe="${value#*=}"
    record="$repo_root/eng/render-capture/linux/$engine_id.json"
    [[ -f "$record" ]] || record="$repo_root/eng/render-capture/windows/$engine_id.json"
    output="$(python3 -I "$calibrator" --verify-record "$record" --binary "$exe" --header "$header")"
    printf '%s\n' "$output"
    python3 -I -c 'import re, sys
counts = re.findall(r"^verified: ([1-9][0-9]*)/([0-9]+)$", sys.stdin.read(), re.M)
sys.exit(0 if len(counts) == 1 and counts[0][0] == counts[0][1] else "expected all checks verified")' <<< "$output"
  done
fi
