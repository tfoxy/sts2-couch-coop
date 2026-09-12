#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="$repo_root/scripts/verify-release-archive.sh"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-release-verifier-tests.XXXXXX")"
trap 'rm -rf "$fixture_root"' EXIT

fail() {
  echo "test-verify-release-archive: $*" >&2
  exit 1
}

write_build_info() {
  local root="$1" lane="$2" version="$3"
  jq -n --arg lane "$lane" --arg version "$version" '{
    schemaVersion: "couchcoop-release-build-info/v1",
    sourceCommit: "0000000000000000000000000000000000000000",
    tag: null,
    version: $version,
    dependencies: {sts2References: {lane: $lane, id: "FuYnAloft.Sts2.References", version: "0.0.0-fixture"}}
  }' > "$root/build-info.txt"
}

make_valid_payload() {
  local root="$1" lane="${2:-stable}" file min
  mkdir -p "$root/frontend" "$root/licenses/npm"
  for file in \
    LICENSE NOTICE THIRD_PARTY_NOTICES.md \
    couchcoop.dll CouchCoop.Mod.dll CouchCoop.Mod.Contracts.dll \
    CouchCoop.MirrorProtocol.dll CouchCoop.Spirectl.dll QRCoder.dll; do
    printf 'fixture\n' > "$root/$file"
  done
  min="$(release_lane_min_game_version "$lane")"
  if [[ -n "$min" ]]; then
    jq -n --arg min "$min" '{version: "1.2.3", min_game_version: $min}' > "$root/couchcoop.json"
  else
    printf '{"version":"1.2.3"}\n' > "$root/couchcoop.json"
  fi
  write_build_info "$root" "$lane" 1.2.3
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

# A copy of the valid payload, ready to be broken one way.
clone_payload() {
  local label="$1"
  local source="${2:-$valid}"
  local case_dir="$fixture_root/$label/couchcoop"
  mkdir -p "$(dirname "$case_dir")"
  cp -a "$source" "$case_dir"
  printf '%s\n' "$case_dir"
}

expect_reject() {
  local label="$1"
  shift
  if "$@" >"$fixture_root/$label.log" 2>&1; then
    echo "verifier unexpectedly accepted fixture: $label" >&2
    exit 1
  fi
}

expect_reject_saying() {
  local label="$1" needle="$2"
  shift 2
  expect_reject "$label" "$@"
  grep -q -- "$needle" "$fixture_root/$label.log" \
    || fail "$label was rejected, but not for '$needle': $(cat "$fixture_root/$label.log")"
}

valid="$fixture_root/valid/couchcoop"
make_valid_payload "$valid"
"$verifier" --payload "$valid" --version 1.2.3 --lane stable >/dev/null

for artifact in source-map.pdb source-map.map Spirectl.Sts2.dll sts2.dll Sentry.dll unexpected.bin \
  hot-reload/CouchCoop.Mod.HotReload.dll \
  hot-reload/CouchCoop.Mod.dll \
  hot-reload/CouchCoop.Mod.Contracts.dll \
  hot-reload/CouchCoop.MirrorProtocol.dll \
  hot-reload/CouchCoop.Spirectl.dll; do
  case_dir="$(clone_payload "${artifact//./-}")"
  mkdir -p "$(dirname "$case_dir/$artifact")"
  printf 'forbidden\n' > "$case_dir/$artifact"
  expect_reject "${artifact//./-}" "$verifier" --payload "$case_dir" --version 1.2.3 --lane stable
done

empty_hot_reload="$(clone_payload empty-hot-reload)"
mkdir "$empty_hot_reload/hot-reload"
expect_reject empty-hot-reload "$verifier" --payload "$empty_hot_reload" --version 1.2.3 --lane stable

for symbol in \
  CouchCoopHotReloadProtocol \
  DescribeSpirectlHotReloadStatusJson \
  RequestSpirectlHotReloadJsonAsync; do
  case_dir="$(clone_payload "loader-${symbol}")"
  printf 'fixture %s\n' "$symbol" > "$case_dir/couchcoop.dll"
  expect_reject "loader-${symbol}" "$verifier" --payload "$case_dir" --version 1.2.3 --lane stable
done

missing_license="$(clone_payload missing-license)"
rm "$missing_license/NOTICE"
expect_reject missing-license "$verifier" --payload "$missing_license" --version 1.2.3 --lane stable

# ------------------------------------------------------------------------------------------------
# build-info.txt: required, and the record the manifest is held to.
# ------------------------------------------------------------------------------------------------
missing_build_info="$(clone_payload missing-build-info)"
rm "$missing_build_info/build-info.txt"
expect_reject_saying missing-build-info 'missing: build-info.txt' \
  "$verifier" --payload "$missing_build_info" --version 1.2.3 --lane stable

# A .json in the payload root is scanned as a mod manifest by STS2, and Godot only hides a
# dot-prefixed file on Unix -- on Windows both of these would load as a manifest and fail with no id.
for stray in build-info.json .build-info.json extra.json; do
  label="stray$(printf '%s' "$stray" | tr '.' '-')"
  case_dir="$(clone_payload "$label")"
  cp "$case_dir/build-info.txt" "$case_dir/$stray"
  expect_reject_saying "$label" 'scans as a mod manifest' \
    "$verifier" --payload "$case_dir" --version 1.2.3 --lane stable
done

wrong_lane="$(clone_payload wrong-lane)"
write_build_info "$wrong_lane" public-beta 1.2.3
expect_reject_saying wrong-lane "built for lane 'public-beta'" \
  "$verifier" --payload "$wrong_lane" --version 1.2.3 --lane stable

unreviewed_lane="$(clone_payload unreviewed-lane)"
write_build_info "$unreviewed_lane" experimental 1.2.3
expect_reject_saying unreviewed-lane 'unreviewed lane: experimental' \
  "$verifier" --payload "$unreviewed_lane" --version 1.2.3 --lane stable

wrong_build_info_version="$(clone_payload wrong-build-info-version)"
write_build_info "$wrong_build_info_version" stable 9.9.9
expect_reject_saying wrong-build-info-version "build-info.txt version is '9.9.9'" \
  "$verifier" --payload "$wrong_build_info_version" --version 1.2.3 --lane stable

wrong_manifest_version="$(clone_payload wrong-manifest-version)"
printf '{"version":"9.9.9"}\n' > "$wrong_manifest_version/couchcoop.json"
expect_reject wrong-manifest-version "$verifier" --payload "$wrong_manifest_version" --version 1.2.3 --lane stable

# ------------------------------------------------------------------------------------------------
# min_game_version: per lane, and never a value the game cannot parse. GAME_VERSION_INVALID fails
# the mod on EVERY game build, so a malformed floor is worse than no floor at all.
# ------------------------------------------------------------------------------------------------
beta_valid="$fixture_root/beta-valid/couchcoop"
make_valid_payload "$beta_valid" public-beta
"$verifier" --payload "$beta_valid" --version 1.2.3 --lane public-beta >/dev/null
[[ "$(jq -r '.min_game_version' "$beta_valid/couchcoop.json")" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "the public-beta fixture floor is not vMAJOR.MINOR.PATCH"

beta_no_floor="$(clone_payload beta-no-floor "$beta_valid")"
jq 'del(.min_game_version)' "$beta_valid/couchcoop.json" > "$beta_no_floor/couchcoop.json"
expect_reject_saying beta-no-floor "min_game_version is 'unset'" \
  "$verifier" --payload "$beta_no_floor" --version 1.2.3 --lane public-beta

beta_malformed_floor="$(clone_payload beta-malformed-floor "$beta_valid")"
jq '.min_game_version = "0.111"' "$beta_valid/couchcoop.json" > "$beta_malformed_floor/couchcoop.json"
expect_reject_saying beta-malformed-floor 'does not parse as' \
  "$verifier" --payload "$beta_malformed_floor" --version 1.2.3 --lane public-beta

beta_wrong_floor="$(clone_payload beta-wrong-floor "$beta_valid")"
jq '.min_game_version = "v0.99.0"' "$beta_valid/couchcoop.json" > "$beta_wrong_floor/couchcoop.json"
expect_reject_saying beta-wrong-floor "min_game_version is 'v0.99.0'" \
  "$verifier" --payload "$beta_wrong_floor" --version 1.2.3 --lane public-beta

stable_with_floor="$(clone_payload stable-with-floor)"
jq '.min_game_version = "v0.107.1"' "$valid/couchcoop.json" > "$stable_with_floor/couchcoop.json"
expect_reject_saying stable-with-floor "lane stable requires 'unset'" \
  "$verifier" --payload "$stable_with_floor" --version 1.2.3 --lane stable

# ------------------------------------------------------------------------------------------------
# Archive mode.
# ------------------------------------------------------------------------------------------------
valid_archive="$fixture_root/valid.zip"
(cd "$fixture_root/valid" && zip -X -q -r "$valid_archive" couchcoop)
"$verifier" --archive "$valid_archive" >/dev/null
"$verifier" --archive "$valid_archive" --lane stable --version 1.2.3 >/dev/null
expect_reject_saying archive-wrong-lane "built for lane 'stable'" \
  "$verifier" --archive "$valid_archive" --lane public-beta
expect_reject_saying archive-wrong-version "build-info.txt version is '1.2.3'" \
  "$verifier" --archive "$valid_archive" --version 9.9.9

beta_archive="$fixture_root/beta-valid.zip"
(cd "$fixture_root/beta-valid" && zip -X -q -r "$beta_archive" couchcoop)
"$verifier" --archive "$beta_archive" --lane public-beta --version 1.2.3 >/dev/null

# The contents manifest is no longer published, so the gate must be able to recompute it.
recomputed="$fixture_root/recomputed-contents.json"
"$verifier" --archive "$valid_archive" --emit-contents "$recomputed" >/dev/null
jq -e '
  .schemaVersion == "couchcoop-release-contents/v1"
  and (.files | length) > 20
  and all(.files[];
    (.path | startswith("couchcoop/"))
    and (.size | type == "number" and . > 0)
    and (.sha256 | test("^[0-9a-f]{64}$")))
' "$recomputed" >/dev/null || fail "recomputed contents manifest is not a valid v1 document"
diff -u \
  <(jq -r '.files[].path' "$recomputed" | LC_ALL=C sort) \
  <(unzip -Z1 "$valid_archive" | sed -n '/[^\/]$/p' | LC_ALL=C sort) \
  || fail "recomputed contents manifest does not list exactly the archive's files"
assert_sha="$(jq -r '.files[] | select(.path == "couchcoop/NOTICE") | .sha256' "$recomputed")"
[[ "$assert_sha" == "$(sha256sum < "$valid/NOTICE" | cut -d ' ' -f 1)" ]] \
  || fail "recomputed contents manifest hashed couchcoop/NOTICE wrong"

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

missing_build_info_archive="$fixture_root/missing-build-info.zip"
python3 - "$valid_archive" "$missing_build_info_archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w") as target:
    for info in source.infolist():
        if info.filename == "couchcoop/build-info.txt":
            continue
        target.writestr(info, source.read(info.filename))
PY
expect_reject_saying missing-build-info-archive 'missing: build-info.txt' \
  "$verifier" --archive "$missing_build_info_archive"

# Extracting every entry IS the CRC check: a payload byte rewritten under the stored CRC must fail.
corrupt_archive="$fixture_root/corrupt-entry.zip"
python3 - "$valid_archive" "$corrupt_archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_STORED) as target:
    for info in source.infolist():
        target.writestr(info.filename, source.read(info.filename))

with zipfile.ZipFile(sys.argv[2]) as archive:
    info = archive.getinfo("couchcoop/NOTICE")
    data_offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra or b"")

with open(sys.argv[2], "r+b") as handle:
    handle.seek(data_offset)
    original = handle.read(1)
    handle.seek(data_offset)
    handle.write(bytes([original[0] ^ 0xFF]))
PY
expect_reject_saying corrupt-entry 'did not extract cleanly' "$verifier" --archive "$corrupt_archive"

traversal_archive="$fixture_root/traversal.zip"
python3 - "$traversal_archive" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("couchcoop/../escape.txt", "escape")
PY
expect_reject traversal "$verifier" --archive "$traversal_archive"

echo "test-verify-release-archive: ok"
