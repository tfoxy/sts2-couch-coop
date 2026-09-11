#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="$repo_root/scripts/verify-release-archive.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-verifier-tests.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

make_valid_payload() {
  local root="$1" file
  mkdir -p "$root/frontend" "$root/licenses/npm"
  for file in \
    LICENSE NOTICE THIRD_PARTY_NOTICES.md \
    couchcoop.dll CouchCoop.Mod.dll CouchCoop.Mod.Contracts.dll \
    CouchCoop.MirrorProtocol.dll CouchCoop.Spirectl.dll QRCoder.dll; do
    printf 'fixture\n' > "$root/$file"
  done
  printf '{"version":"1.2.3"}\n' > "$root/couchcoop.json"
  printf '<!doctype html>\n' > "$root/frontend/index.html"
  printf 'app/index-fixture.js\n' > "$root/frontend/app-boot"
  for file in \
    QRCoder-1.6.0-MIT.txt spirectl-LICENSE spirectl-NOTICE \
    godot-scene-web-LICENSE HarfBuzz-LICENSE Emscripten-LICENSE \
    OpenSans-LICENSE npm-dependencies.tsv; do
    printf 'fixture\n' > "$root/licenses/$file"
  done
  printf 'fixture\n' > "$root/licenses/npm/vue.LICENSE"
}

expect_reject() {
  local label="$1"
  shift
  if "$@" >"$fixture_root/$label.log" 2>&1; then
    echo "verifier unexpectedly accepted fixture: $label" >&2
    exit 1
  fi
}

valid="$fixture_root/valid/couchcoop"
make_valid_payload "$valid"
"$verifier" --payload "$valid" --version 1.2.3 >/dev/null

for artifact in source-map.pdb source-map.map Spirectl.Sts2.dll sts2.dll Sentry.dll unexpected.bin \
  hot-reload/CouchCoop.Mod.HotReload.dll \
  hot-reload/CouchCoop.Mod.dll \
  hot-reload/CouchCoop.Mod.Contracts.dll \
  hot-reload/CouchCoop.MirrorProtocol.dll \
  hot-reload/CouchCoop.Spirectl.dll; do
  case_dir="$fixture_root/${artifact//./-}/couchcoop"
  mkdir -p "$(dirname "$case_dir")"
  cp -a "$valid" "$case_dir"
  mkdir -p "$(dirname "$case_dir/$artifact")"
  printf 'forbidden\n' > "$case_dir/$artifact"
  expect_reject "${artifact//./-}" "$verifier" --payload "$case_dir" --version 1.2.3
done

empty_hot_reload="$fixture_root/empty-hot-reload/couchcoop"
mkdir -p "$(dirname "$empty_hot_reload")"
cp -a "$valid" "$empty_hot_reload"
mkdir "$empty_hot_reload/hot-reload"
expect_reject empty-hot-reload "$verifier" --payload "$empty_hot_reload" --version 1.2.3

for symbol in \
  CouchCoopHotReloadProtocol \
  DescribeSpirectlHotReloadStatusJson \
  RequestSpirectlHotReloadJsonAsync; do
  case_dir="$fixture_root/loader-${symbol}/couchcoop"
  mkdir -p "$(dirname "$case_dir")"
  cp -a "$valid" "$case_dir"
  printf 'fixture %s\n' "$symbol" > "$case_dir/couchcoop.dll"
  expect_reject "loader-${symbol}" "$verifier" --payload "$case_dir" --version 1.2.3
done

missing_license="$fixture_root/missing-license/couchcoop"
mkdir -p "$(dirname "$missing_license")"
cp -a "$valid" "$missing_license"
rm "$missing_license/NOTICE"
expect_reject missing-license "$verifier" --payload "$missing_license" --version 1.2.3

valid_archive="$fixture_root/valid.zip"
(cd "$fixture_root/valid" && zip -X -q -r "$valid_archive" couchcoop)
"$verifier" --archive "$valid_archive" >/dev/null

forbidden_loader_archive="$fixture_root/forbidden-loader-symbols.zip"
python3 - "$valid_archive" "$forbidden_loader_archive" <<'PY'
import sys
import zipfile

symbols = b"CouchCoopHotReloadProtocol DescribeSpirectlHotReloadStatusJson RequestSpirectlHotReloadJsonAsync"
with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
    for info in source.infolist():
        contents = symbols if info.filename == "couchcoop/couchcoop.dll" else source.read(info.filename)
        target.writestr(info, contents)
PY
expect_reject forbidden-loader-symbols-archive "$verifier" --archive "$forbidden_loader_archive"

empty_hot_reload_archive="$fixture_root/empty-hot-reload.zip"
python3 - "$valid_archive" "$empty_hot_reload_archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
    for info in source.infolist():
        target.writestr(info, source.read(info.filename))
    target.writestr("couchcoop/hot-reload/", "")
PY
expect_reject empty-hot-reload-archive "$verifier" --archive "$empty_hot_reload_archive"

traversal_archive="$fixture_root/traversal.zip"
python3 - "$traversal_archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("couchcoop/../escape.txt", "escape")
PY
expect_reject traversal "$verifier" --archive "$traversal_archive"

echo "test-verify-release-archive: ok"
