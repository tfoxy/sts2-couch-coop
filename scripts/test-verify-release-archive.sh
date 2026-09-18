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

loader_project="$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj"
grep -Fq 'Include="System.Diagnostics.DiagnosticSource"' "$loader_project" \
  || fail "loader does not pin the bundled DiagnosticSource package"
grep -Fq 'Version="[10.0.10]"' "$loader_project" \
  || fail "loader does not pin DiagnosticSource 10.0.10 exactly"
grep -Fq 'CopyToPublishDirectory="PreserveNewest"' "$loader_project" \
  || fail "loader does not copy DiagnosticSource into release publish output"

lane_assemblies=()
while IFS= read -r assembly; do lane_assemblies+=("$assembly"); done < <(release_lane_assembly_names)
known_lanes=()
while IFS= read -r lane; do known_lanes+=("$lane"); done < <(release_lane_known_names)

# ------------------------------------------------------------------------------------------------
# The lane table itself. A lane that exists on disk but is unreviewed here (or the reverse) would
# leave a payload that passes the gate and still strands a branch, so the two lists must agree.
# ------------------------------------------------------------------------------------------------
diff \
  <(printf '%s\n' "${known_lanes[@]}" | LC_ALL=C sort) \
  <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk" | LC_ALL=C sort) \
  || fail "release_lane_known_names does not match the lanes in eng/Sts2.ReferenceSdk"
for lane in "${known_lanes[@]}"; do
  [[ "$(release_lane_game_floor "$lane")" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "lane $lane has no vMAJOR.MINOR.PATCH floor"
  [[ "$(release_lane_dir_name "$lane")" == "$(release_lane_game_floor "$lane" | tr -d v)" ]] \
    || fail "lane $lane directory name is not its bare floor"
  [[ "$(release_lane_from_dir_name "$(release_lane_dir_name "$lane")")" == "$lane" ]] \
    || fail "lane $lane does not round-trip through its directory name"
  release_lane_game_api "$lane" >/dev/null || fail "lane $lane has no reviewed bridge API lane"
  release_lane_game_build "$lane" >/dev/null || fail "lane $lane has no reviewed game build"
  release_lane_steam_branch "$lane" >/dev/null || fail "lane $lane has no reviewed Steam branch"
done
# The merged floor is the LOWEST lane floor, never the newest: too high and the one payload refuses
# to load on the older branch whose lane it also carries.
[[ "$(release_payload_min_game_version stable public-beta)" == "$(release_lane_game_floor stable)" ]] \
  || fail "the merged floor is not the lowest lane floor"
[[ "$(release_payload_min_game_version public-beta)" == "$(release_lane_game_floor public-beta)" ]] \
  || fail "a single-lane payload does not declare that lane's own floor"
[[ "$(printf '%s\n' v9.10.2 v10.2.1 v9.99.99 | release_semver_tag_latest)" == "v10.2.1" ]] \
  || fail "tag semantic ordering does not preserve the v prefix"

write_build_info() { # write_build_info <root> <version> <lane>...
  local root="$1" version="$2" lane
  shift 2
  local references="{}"
  for lane in "$@"; do
    references="$(jq -n --argjson acc "$references" --arg lane "$lane" \
      --arg directory "$(release_lane_dir_name "$lane")" \
      --arg floor "$(release_lane_game_floor "$lane")" \
      '$acc + {($lane): {id: "FuYnAloft.Sts2.References", version: "0.0.0-fixture",
                         nugetContentHash: "fixture", gameBuild: $floor, minGameVersion: $floor,
                         bridgeGameApi: "v0", laneDirectory: $directory,
                         nugetLockSha256: "fixture"}}')"
  done
  jq -n --argjson references "$references" --arg version "$version" '{
    schemaVersion: "couchcoop-release-build-info/v2",
    sourceCommit: "0000000000000000000000000000000000000000",
    tag: null,
    version: $version,
    dependencies: {sts2References: $references}
  }' > "$root/build-info.txt"
}

make_valid_payload() { # make_valid_payload <root> [lane]...
  local root="$1" file lane directory
  shift
  local lanes=("$@")
  [[ ${#lanes[@]} -gt 0 ]] || lanes=("${known_lanes[@]}")
  mkdir -p "$root/frontend" "$root/licenses/npm"
  # The shared tree: byte-identical across lanes, so it ships once, at the payload root.
  for file in \
    LICENSE NOTICE THIRD_PARTY_NOTICES.md \
    couchcoop.dll CouchCoop.Mod.Contracts.dll \
    CouchCoop.MirrorProtocol.dll QRCoder.dll DeviceDetector.NET.dll LiteDB.dll \
    Microsoft.Extensions.DependencyInjection.Abstractions.dll Microsoft.Extensions.Logging.Abstractions.dll \
    System.Diagnostics.DiagnosticSource.dll YamlDotNet.dll; do
    printf 'fixture\n' > "$root/$file"
  done
  # One directory per lane, named by that lane's floor, holding only the lane-varying assemblies.
  for lane in "${lanes[@]}"; do
    directory="$(release_lane_dir_name "$lane")"
    mkdir -p "$root/lanes/$directory"
    for file in "${lane_assemblies[@]}"; do
      printf 'fixture %s\n' "$lane" > "$root/lanes/$directory/$file"
    done
  done
  jq -n --arg min "$(release_payload_min_game_version "${lanes[@]}")" \
    '{version: "1.2.3", min_game_version: $min}' > "$root/couchcoop.json"
  write_build_info "$root" 1.2.3 "${lanes[@]}"
  printf '<!doctype html>\n' > "$root/frontend/index.html"
  printf 'app/index-fixture.js\n' > "$root/frontend/app-boot"
  for file in \
    QRCoder-1.6.0-MIT.txt DeviceDetector.NET-6.5.2-Apache-2.0.txt LiteDB-5.0.21-MIT.txt \
    Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt \
    System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt YamlDotNet-18.1.0-MIT.txt spirectl-LICENSE spirectl-NOTICE \
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

# The reviewed full-release invocation: every lane named, plus --complete.
all_lane_args=()
for lane in "${known_lanes[@]}"; do all_lane_args+=(--lane "$lane"); done

valid="$fixture_root/valid/couchcoop"
make_valid_payload "$valid"
"$verifier" --payload "$valid" --version 1.2.3 "${all_lane_args[@]}" --complete >/dev/null

for artifact in source-map.pdb source-map.map Spirectl.Sts2.dll sts2.dll Sentry.dll unexpected.bin \
  hot-reload/CouchCoop.Mod.HotReload.dll \
  hot-reload/CouchCoop.Mod.dll \
  hot-reload/CouchCoop.Mod.Contracts.dll \
  hot-reload/CouchCoop.MirrorProtocol.dll \
  hot-reload/CouchCoop.Spirectl.dll; do
  case_dir="$(clone_payload "${artifact//./-}")"
  mkdir -p "$(dirname "$case_dir/$artifact")"
  printf 'forbidden\n' > "$case_dir/$artifact"
  expect_reject "${artifact//./-}" "$verifier" --payload "$case_dir" --version 1.2.3 "${all_lane_args[@]}"
done

empty_hot_reload="$(clone_payload empty-hot-reload)"
mkdir "$empty_hot_reload/hot-reload"
expect_reject empty-hot-reload "$verifier" --payload "$empty_hot_reload" --version 1.2.3 "${all_lane_args[@]}"

for symbol in \
  CouchCoopHotReloadProtocol \
  DescribeSpirectlHotReloadStatusJson \
  RequestSpirectlHotReloadJsonAsync; do
  case_dir="$(clone_payload "loader-${symbol}")"
  printf 'fixture %s\n' "$symbol" > "$case_dir/couchcoop.dll"
  expect_reject "loader-${symbol}" "$verifier" --payload "$case_dir" --version 1.2.3 "${all_lane_args[@]}"
done

missing_license="$(clone_payload missing-license)"
rm "$missing_license/NOTICE"
expect_reject missing-license "$verifier" --payload "$missing_license" --version 1.2.3 "${all_lane_args[@]}"

# ------------------------------------------------------------------------------------------------
# The merged layout: one payload, one lane directory per game branch, named by that lane's floor.
# ------------------------------------------------------------------------------------------------
# A lane assembly at the root is one lane's build sitting in the shared tree, which is the failure
# the whole layout exists to prevent.
for assembly in "${lane_assemblies[@]}"; do
  label="root-$assembly"
  case_dir="$(clone_payload "$label")"
  cp "$case_dir/lanes/$(release_lane_dir_name stable)/$assembly" "$case_dir/$assembly"
  expect_reject_saying "$label" 'lane assembly at its root' \
    "$verifier" --payload "$case_dir" --version 1.2.3 "${all_lane_args[@]}"
done

no_lanes="$(clone_payload no-lanes)"
rm -rf "$no_lanes/lanes"
expect_reject_saying no-lanes 'carries no lanes/' \
  "$verifier" --payload "$no_lanes" --version 1.2.3 "${all_lane_args[@]}"

unknown_lane_dir="$(clone_payload unknown-lane-dir)"
mkdir -p "$unknown_lane_dir/lanes/9.9.9"
for assembly in "${lane_assemblies[@]}"; do printf 'fixture\n' > "$unknown_lane_dir/lanes/9.9.9/$assembly"; done
expect_reject_saying unknown-lane-dir 'not a reviewed lane' \
  "$verifier" --payload "$unknown_lane_dir" --version 1.2.3 "${all_lane_args[@]}"

# A half-populated lane directory is worse than a missing lane: the selector picks it and the mod
# fails at load with a file-not-found nobody can act on.
incomplete_lane="$(clone_payload incomplete-lane)"
rm "$incomplete_lane/lanes/$(release_lane_dir_name public-beta)/CouchCoop.Spirectl.dll"
expect_reject_saying incomplete-lane 'is missing: CouchCoop.Spirectl.dll' \
  "$verifier" --payload "$incomplete_lane" --version 1.2.3 "${all_lane_args[@]}"

# Nothing but the lane assemblies may live under a lane directory -- above all a .json, which STS2
# would scan as a second mod manifest, and a *.deps.json, which is what would land there by accident.
for stray in CouchCoop.Mod.deps.json CouchCoop.Mod.runtimeconfig.json lane.json notes.txt; do
  label="lane-stray-$(printf '%s' "$stray" | tr '.' '-')"
  case_dir="$(clone_payload "$label")"
  printf 'fixture\n' > "$case_dir/lanes/$(release_lane_dir_name stable)/$stray"
  expect_reject "$label" "$verifier" --payload "$case_dir" --version 1.2.3 "${all_lane_args[@]}"
done

nested_lane="$(clone_payload nested-lane)"
mkdir -p "$nested_lane/lanes/$(release_lane_dir_name stable)/nested"
printf 'fixture\n' > "$nested_lane/lanes/$(release_lane_dir_name stable)/nested/CouchCoop.Mod.dll"
expect_reject_saying nested-lane 'not allowlisted' \
  "$verifier" --payload "$nested_lane" --version 1.2.3 "${all_lane_args[@]}"

# A deliberate single-lane build (COUCHCOOP_RELEASE_STS2_LANE) is valid; publishing one is not, and
# --complete is where the two part company.
single_lane="$fixture_root/single-lane/couchcoop"
make_valid_payload "$single_lane" stable
"$verifier" --payload "$single_lane" --version 1.2.3 --lane stable >/dev/null
expect_reject_saying single-lane-complete 'not complete' \
  "$verifier" --payload "$single_lane" --version 1.2.3 --lane stable --complete
expect_reject_saying single-lane-missing-lane 'does not carry the requested lane: public-beta' \
  "$verifier" --payload "$single_lane" --version 1.2.3 --lane public-beta
# A single-lane payload declares ITS lane's floor, not the release-wide one.
beta_only="$fixture_root/beta-only/couchcoop"
make_valid_payload "$beta_only" public-beta
"$verifier" --payload "$beta_only" --version 1.2.3 --lane public-beta >/dev/null
[[ "$(jq -r '.min_game_version' "$beta_only/couchcoop.json")" == "$(release_lane_game_floor public-beta)" ]] \
  || fail "the public-beta-only fixture does not declare the public-beta floor"

expect_reject_saying unusable-requested-lane 'unusable lane name' \
  "$verifier" --payload "$valid" --version 1.2.3 --lane 'Not A Lane'
expect_reject_saying unreviewed-requested-lane 'unreviewed lane name' \
  "$verifier" --payload "$valid" --version 1.2.3 --lane experimental

# ------------------------------------------------------------------------------------------------
# build-info.txt: required, and the record the manifest and the lane directories are held to.
# ------------------------------------------------------------------------------------------------
missing_build_info="$(clone_payload missing-build-info)"
rm "$missing_build_info/build-info.txt"
expect_reject_saying missing-build-info 'missing: build-info.txt' \
  "$verifier" --payload "$missing_build_info" --version 1.2.3 "${all_lane_args[@]}"

# A .json in the payload root is scanned as a mod manifest by STS2, and Godot only hides a
# dot-prefixed file on Unix -- on Windows both of these would load as a manifest and fail with no id.
for stray in build-info.json .build-info.json extra.json; do
  label="stray$(printf '%s' "$stray" | tr '.' '-')"
  case_dir="$(clone_payload "$label")"
  cp "$case_dir/build-info.txt" "$case_dir/$stray"
  expect_reject_saying "$label" 'scans as a mod manifest' \
    "$verifier" --payload "$case_dir" --version 1.2.3 "${all_lane_args[@]}"
done

# The pre-merge shape: one {lane, id, version} object. It can only ever describe one lane, so a
# payload still carrying it must fail rather than be read as "the lane it happens to name".
v1_build_info="$(clone_payload v1-build-info)"
jq '.schemaVersion = "couchcoop-release-build-info/v1"
    | .dependencies.sts2References = {lane: "stable", id: "FuYnAloft.Sts2.References", version: "0.0.0-fixture"}' \
  "$valid/build-info.txt" > "$v1_build_info/build-info.txt"
expect_reject_saying v1-build-info 'build-info.txt is invalid' \
  "$verifier" --payload "$v1_build_info" --version 1.2.3 "${all_lane_args[@]}"

missing_lane_record="$(clone_payload missing-lane-record)"
write_build_info "$missing_lane_record" 1.2.3 stable
expect_reject_saying missing-lane-record 'do not match the shipped lanes' \
  "$verifier" --payload "$missing_lane_record" --version 1.2.3 "${all_lane_args[@]}"

unreviewed_lane="$(clone_payload unreviewed-lane)"
jq '.dependencies.sts2References |= (. + {experimental: (.stable)})' "$valid/build-info.txt" \
  > "$unreviewed_lane/build-info.txt"
expect_reject_saying unreviewed-lane 'unreviewed lane: experimental' \
  "$verifier" --payload "$unreviewed_lane" --version 1.2.3 "${all_lane_args[@]}"

wrong_lane_directory="$(clone_payload wrong-lane-directory)"
jq '.dependencies.sts2References.stable.laneDirectory = "0.99.9"' "$valid/build-info.txt" \
  > "$wrong_lane_directory/build-info.txt"
expect_reject_saying wrong-lane-directory 'somewhere other than lanes/' \
  "$verifier" --payload "$wrong_lane_directory" --version 1.2.3 "${all_lane_args[@]}"

wrong_lane_floor="$(clone_payload wrong-lane-floor)"
jq '.dependencies.sts2References.stable.minGameVersion = "v0.99.9"' "$valid/build-info.txt" \
  > "$wrong_lane_floor/build-info.txt"
expect_reject_saying wrong-lane-floor 'not the reviewed' \
  "$verifier" --payload "$wrong_lane_floor" --version 1.2.3 "${all_lane_args[@]}"

wrong_build_info_version="$(clone_payload wrong-build-info-version)"
write_build_info "$wrong_build_info_version" 9.9.9 "${known_lanes[@]}"
expect_reject_saying wrong-build-info-version "build-info.txt version is '9.9.9'" \
  "$verifier" --payload "$wrong_build_info_version" --version 1.2.3 "${all_lane_args[@]}"

wrong_manifest_version="$(clone_payload wrong-manifest-version)"
printf '{"version":"9.9.9"}\n' > "$wrong_manifest_version/couchcoop.json"
expect_reject wrong-manifest-version "$verifier" --payload "$wrong_manifest_version" --version 1.2.3 "${all_lane_args[@]}"

# ------------------------------------------------------------------------------------------------
# min_game_version: the LOWEST floor among the lanes the payload carries, and never a value the game
# cannot parse. GAME_VERSION_INVALID fails the mod on EVERY game build, so a malformed floor is
# worse than no floor at all -- and a floor that is too HIGH makes the one merged payload refuse to
# load on the older branch whose lane it is carrying.
# ------------------------------------------------------------------------------------------------
no_floor="$(clone_payload no-floor)"
jq 'del(.min_game_version)' "$valid/couchcoop.json" > "$no_floor/couchcoop.json"
expect_reject_saying no-floor "min_game_version is 'unset'" \
  "$verifier" --payload "$no_floor" --version 1.2.3 "${all_lane_args[@]}"

malformed_floor="$(clone_payload malformed-floor)"
jq '.min_game_version = "0.107"' "$valid/couchcoop.json" > "$malformed_floor/couchcoop.json"
expect_reject_saying malformed-floor 'does not parse as' \
  "$verifier" --payload "$malformed_floor" --version 1.2.3 "${all_lane_args[@]}"

newest_floor="$(clone_payload newest-floor)"
jq --arg floor "$(release_lane_game_floor public-beta)" '.min_game_version = $floor' \
  "$valid/couchcoop.json" > "$newest_floor/couchcoop.json"
expect_reject_saying newest-floor "require '$(release_lane_game_floor stable)'" \
  "$verifier" --payload "$newest_floor" --version 1.2.3 "${all_lane_args[@]}"

# ------------------------------------------------------------------------------------------------
# Archive mode.
# ------------------------------------------------------------------------------------------------
valid_archive="$fixture_root/valid.zip"
(cd "$fixture_root/valid" && zip -X -q -r "$valid_archive" couchcoop)
"$verifier" --archive "$valid_archive" >/dev/null
"$verifier" --archive "$valid_archive" "${all_lane_args[@]}" --complete --version 1.2.3 >/dev/null
missing_checksum="$fixture_root/missing-entry.SHA256SUMS"
printf '%s  %s\n%s  %s\n' \
  "$(release_sha256 "$valid_archive")" "$(basename "$valid_archive")" \
  "$(release_sha256 "$valid_archive")" "not-present.zip" > "$missing_checksum"
expect_reject_saying checksum-missing-entry 'names missing file: not-present.zip' \
  "$verifier" --archive "$valid_archive" --checksums "$missing_checksum"
expect_reject_saying archive-wrong-version "build-info.txt version is '1.2.3'" \
  "$verifier" --archive "$valid_archive" --version 9.9.9

single_lane_archive="$fixture_root/single-lane.zip"
(cd "$fixture_root/single-lane" && zip -X -q -r "$single_lane_archive" couchcoop)
"$verifier" --archive "$single_lane_archive" --lane stable --version 1.2.3 >/dev/null
expect_reject_saying archive-incomplete 'not complete' \
  "$verifier" --archive "$single_lane_archive" --complete

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
jq -e --arg path "couchcoop/lanes/$(release_lane_dir_name public-beta)/CouchCoop.Mod.dll" \
  'any(.files[]; .path == $path)' "$recomputed" >/dev/null \
  || fail "recomputed contents manifest does not list the lane assemblies"
diff -u \
  <(jq -r '.files[].path' "$recomputed" | LC_ALL=C sort) \
  <(unzip -Z1 "$valid_archive" | sed -n '/[^\/]$/p' | LC_ALL=C sort) \
  || fail "recomputed contents manifest does not list exactly the archive's files"
assert_sha="$(jq -r '.files[] | select(.path == "couchcoop/NOTICE") | .sha256' "$recomputed")"
[[ "$assert_sha" == "$(release_sha256 "$valid/NOTICE")" ]] \
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
