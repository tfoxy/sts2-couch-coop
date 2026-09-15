#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/upload-workshop-release.sh"
# shellcheck source=lib/release-lanes.sh
source "$repo_root/scripts/lib/release-lanes.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-workshop-upload-tests.XXXXXX")"
trap 'rm -rf "$test_root"' EXIT

fail() {
  echo "test-upload-workshop-release: $*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "expected '$1', got '$2'"
}

# The mock uploader appends one line per invocation; every leg asserts the whole log, so the
# exact argv of every upload so far is checked, including which workspace it was pointed at.
expected_log=""
# assert_uploaded <workspace> [count]: a release is ONE archive and therefore ONE revision, so a
# run adds exactly one line unless a leg says otherwise.
assert_uploaded() {
  local workspace="$1" count="${2:-1}" i
  for (( i = 0; i < count; i++ )); do
    expected_log+="upload -w $workspace"$'\n'
  done
  assert_eq "${expected_log%$'\n'}" "$(cat "$fixture/uploader.log")"
}

for command in jq zip unzip sha256sum; do
  command -v "$command" >/dev/null || fail "missing test prerequisite: $command"
done

# The lanes a release carries. One payload carries all of them, so this is not a selection any
# more -- it is the list a workspace's lane.txt has to allow in full, and the list of lane
# directories the payload has to hold.
mapfile -t lanes < <(release_lane_discover "$repo_root/eng/Sts2.ReferenceSdk")
[[ ${#lanes[@]} -ge 2 ]] || fail "this test's lane.txt legs need at least two reference lanes"
# The assemblies that vary by lane, and therefore ship under lanes/<floor>/ instead of at the
# payload root. Read from the reviewed table so this fixture follows the real layout.
mapfile -t lane_assemblies < <(release_lane_assembly_names)

fixture="$test_root/fixture"
assets="$fixture/assets"
payload="$fixture/payload/couchcoop"
mkdir -p "$assets" "$fixture/all-revisions" "$payload/frontend/icons" "$payload/frontend/.vite" \
  "$payload/frontend/app" "$payload/licenses/npm"

# The payload's INTERNAL shape is scripts/verify-release-archive.sh's contract, not this script's:
# the uploader reads only the couchcoop/ root and build-info.txt's version, and copies the rest
# verbatim. So this fixture only has to be a payload that gate accepts -- it follows that gate's
# layout rather than restating it, and nothing else in this file depends on the shape.
#
# The SHARED tree, at the payload root. The two lane-varying assemblies are deliberately absent
# here: the gate refuses CouchCoop.Mod.dll or CouchCoop.Spirectl.dll at the root, because a lane's
# build sitting in the loader-neutral tree would be served to every player whatever branch they are
# on. They are written per lane below.
for file in \
  LICENSE NOTICE THIRD_PARTY_NOTICES.md couchcoop.json build-info.txt couchcoop.dll \
  CouchCoop.Mod.Contracts.dll CouchCoop.MirrorProtocol.dll QRCoder.dll DeviceDetector.NET.dll LiteDB.dll Microsoft.Extensions.DependencyInjection.Abstractions.dll Microsoft.Extensions.Logging.Abstractions.dll System.Diagnostics.DiagnosticSource.dll YamlDotNet.dll \
  frontend/index.html frontend/app-boot frontend/manifest.webmanifest frontend/icons/icon.svg frontend/.vite/manifest.json \
  licenses/QRCoder-1.6.0-MIT.txt licenses/DeviceDetector.NET-6.5.2-Apache-2.0.txt licenses/LiteDB-5.0.21-MIT.txt licenses/Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt licenses/Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt licenses/System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt licenses/YamlDotNet-18.1.0-MIT.txt licenses/spirectl-LICENSE licenses/spirectl-NOTICE licenses/godot-scene-web-LICENSE \
  licenses/HarfBuzz-LICENSE licenses/Emscripten-LICENSE licenses/OpenSans-LICENSE licenses/npm-dependencies.tsv \
  licenses/npm/example.LICENSE frontend/app/example.js; do
  mkdir -p "$(dirname "$payload/$file")"
  printf 'fixture %s\n' "$file" > "$payload/$file"
done

# One directory per lane, named after that lane's game floor, holding only the lane-varying
# assemblies. A release payload carries EVERY lane -- that is the whole point of the merged shape --
# so this fixture carries every lane the reference SDK declares.
for lane in "${lanes[@]}"; do
  lane_dir="$payload/lanes/$(release_lane_dir_name "$lane")"
  mkdir -p "$lane_dir"
  for file in "${lane_assemblies[@]}"; do
    printf 'fixture %s %s\n' "$lane" "$file" > "$lane_dir/$file"
  done
done

# The manifest floor and the build-info lane records are read from the reviewed table rather than
# written out here, so this fixture cannot drift away from what the release gate expects of a real
# payload. Two things it has to get right, because the gate recomputes both:
#   * the manifest declares the LOWEST floor among the lanes carried, not the first lane's -- a
#     higher one would make the one payload refuse to load on the older branch it also serves;
#   * build-info.txt's sts2References is a set KEYED BY LANE (schema v2), and the lane set it
#     declares has to be exactly the set of lanes/<floor>/ directories that ship.
write_payload() {
  local root="$1" lane references="{}"
  jq -n --arg min "$(release_payload_min_game_version "${lanes[@]}")" \
    '{id: "couchcoop", version: "0.1.0", min_game_version: $min}' > "$root/couchcoop.json"
  for lane in "${lanes[@]}"; do
    references="$(jq -n --argjson acc "$references" --arg lane "$lane" \
      --arg build "$(release_lane_game_build "$lane")" \
      --arg floor "$(release_lane_game_floor "$lane")" \
      --arg api "$(release_lane_game_api "$lane")" \
      --arg directory "$(release_lane_dir_name "$lane")" \
      '$acc + {($lane): {id: "FuYnAloft.Sts2.References", version: "0.0.0-fixture",
                         nugetContentHash: "fixture", gameBuild: $build, minGameVersion: $floor,
                         bridgeGameApi: $api, laneDirectory: $directory,
                         nugetLockSha256: "fixture"}}')"
  done
  jq -n --argjson references "$references" '{
    schemaVersion: "couchcoop-release-build-info/v2",
    sourceCommit: "0000000000000000000000000000000000000000",
    tag: "v0.1.0",
    version: "0.1.0",
    dependencies: {sts2References: $references}
  }' > "$root/build-info.txt"
}

# <archive path> <payload parent dir>: one zip and the one checksum file beside it. A release
# publishes exactly these two assets.
publish_assets() {
  local archive="$1" payload_parent="$2"
  (cd "$payload_parent" && zip -X -q -r "$archive" couchcoop)
  (cd "$(dirname "$archive")" && sha256sum "$(basename "$archive")" >> "${archive%.zip}.SHA256SUMS")
}

write_payload "$payload"
publish_assets "$assets/couchcoop-v0.1.0.zip" "$fixture/payload"

# A dist directory still holding a lane-suffixed archive from the retired two-archive shape. It is a
# SECOND release archive as far as this script is concerned, and must be refused rather than half
# published -- that leftover is exactly how an old payload reaches an item.
stale_lane_suffix="$fixture/stale-lane-suffix"
mkdir -p "$stale_lane_suffix"
cp "$assets"/couchcoop-v0.1.0.* "$stale_lane_suffix/"
cp "$assets/couchcoop-v0.1.0.zip" "$stale_lane_suffix/couchcoop-v0.1.0-${lanes[1]}.zip"

# A --snapshot build, which is not publishable: a Workshop item copies an archive that exists as a
# GitHub Release, and a snapshot has no tag.
snapshot_dist="$fixture/snapshot-dist"
mkdir -p "$snapshot_dist"
# A snapshot payload declares the version package-release.sh stamps for it, so the gate's
# archive-name-to-payload-version check is exercised rather than side-stepped.
snapshot_payload="$fixture/snapshot-payload"
cp -a "$fixture/payload" "$snapshot_payload"
for f in couchcoop.json build-info.txt; do
  jq '.version = "0.1.1+snapshot.abcdef123456"' "$snapshot_payload/couchcoop/$f" > "$snapshot_payload/couchcoop/$f.tmp"
  mv "$snapshot_payload/couchcoop/$f.tmp" "$snapshot_payload/couchcoop/$f"
done
publish_assets "$snapshot_dist/couchcoop-snapshot-abcdef123456.zip" "$snapshot_payload"

uploader_dir="$fixture/uploader"
workspace="$uploader_dir/Workspace"
mkdir -p "$workspace"
printf 'primary preview' > "$workspace/image.png"
# "public" is deliberately NOT the script's default: a run that omits --visibility must leave it
# alone, so this value is what makes that assertion able to fail. minBranch/maxBranch are here for
# the same reason: the real workspaces still carry them from the retired branch-linked shape, and a
# run has to DELETE them rather than pass them through.
jq -n '{
  title: "CouchCoop",
  description: "Fixture source description",
  visibility: "public",
  changeNote: "",
  tags: [],
  dependencies: [],
  contentDescriptors: [],
  minBranch: "public-beta",
  maxBranch: "public-beta"
}' > "$workspace/workshop.json"
printf 'stale content' > "$workspace/stale.txt"
mkdir -p "$workspace/content"
printf 'old payload' > "$workspace/content/old.txt"
mkdir -p "$workspace/previews"
printf 'old gallery' > "$workspace/previews/old.gif"
# An already-published item: the first legs update it, they do not create it.
printf '1234567890\n' > "$workspace/mod_id.txt"

# A second workspace outside the uploader directory, standing in for the unlisted DEV item.
dev_workspace="$fixture/dev-workspace"
mkdir -p "$dev_workspace"
printf 'dev preview' > "$dev_workspace/image.png"
jq -n '{
  title: "CouchCoop DEV",
  description: "Dev fixture description",
  visibility: "unlisted",
  changeNote: "",
  tags: [],
  dependencies: [],
  contentDescriptors: [],
  minBranch: "public-beta",
  maxBranch: "public-beta"
}' > "$dev_workspace/workshop.json"
printf '9999999999\n' > "$dev_workspace/mod_id.txt"

changelog="$fixture/CHANGELOG.md"
cat > "$changelog" <<'EOF'
# Changelog

## [0.1.0] - 2026-01-01

### Changed

- A fixture change a player would read.
- A `code span`, some **bold**, and a [link](https://example.invalid/x) a player would read.
- A wrapped bullet whose second line is indented, which must join the item it belongs to
  rather than escaping the list.
EOF
export CHANGELOG_FILE="$changelog"

mock_bin="$test_root/bin"
mkdir -p "$mock_bin"
cat > "$mock_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == release && "$2" == view ]]; then
  printf '{"tagName":"v0.1.0"}\n'
  exit 0
fi
if [[ "$1" == release && "$2" == download ]]; then
  destination=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) destination="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$MOCK_RELEASE_ASSETS"/* "$destination/"
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
EOF
# Each upload is one Workshop REVISION. The mock records the workshop.json of every invocation
# twice: once under a per-leg name the legs reset, and once in all-revisions/, which is never
# reset so the end of the file can sweep EVERY revision this test ever produced.
cat > "$uploader_dir/ModUploader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  echo '1.0.0+84e755cea6bcfa014df3165c882f1824259245c6'
  exit 0
fi
printf '%s\n' "$*" >> "$MOCK_UPLOADER_LOG"
workspace="${@: -1}"
fixture_dir="$(dirname "$MOCK_UPLOADER_LOG")"
# nullglob, not ls: under `set -o pipefail` a non-matching glob makes ls exit 2 and takes the
# whole mock down on the very first upload, when there is nothing to count yet.
shopt -s nullglob
existing=( "$fixture_dir"/revision-*.json )
cp "$workspace/workshop.json" "$fixture_dir/revision-$(( ${#existing[@]} + 1 )).json"
all=( "$fixture_dir"/all-revisions/*.json )
cp "$workspace/workshop.json" "$fixture_dir/all-revisions/$(( ${#all[@]} + 1 )).json"
if [[ ! -f "$workspace/mod_id.txt" ]]; then
  printf '1234567890\n' > "$workspace/mod_id.txt"
fi
EOF
chmod +x "$mock_bin/gh" "$uploader_dir/ModUploader"
jq -n \
  --arg commit '84e755cea6bcfa014df3165c882f1824259245c6' \
  --arg version '1.0.0+84e755cea6bcfa014df3165c882f1824259245c6' \
  --arg sha256 "$(sha256sum "$uploader_dir/ModUploader" | awk '{print $1}')" \
  '{commit: $commit, version: $version, modUploaderSha256: $sha256}' \
  > "$uploader_dir/.couchcoop-localized-uploader.json"

blocked_gh_bin="$test_root/blocked-gh"
mkdir -p "$blocked_gh_bin"
cat > "$blocked_gh_bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh must not be called in --dist mode" >&2
exit 99
EOF
chmod +x "$blocked_gh_bin/gh"

expect_refused() {
  local label="$1" needle="$2"
  shift 2
  local refused_status=0
  MOCK_UPLOADER_LOG="$fixture/uploader.log" \
  COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
  PATH="$blocked_gh_bin:$PATH" \
  bash "$script" "$@" >"$fixture/$label.out" 2>&1 || refused_status=$?
  [[ $refused_status -ne 0 ]] || fail "$label should have failed"
  # -F: these needles are refusal messages, which carry brackets and parentheses that a regex would
  # read as syntax -- a needle matching the output character for character must not silently fail.
  grep -qF -- "$needle" "$fixture/$label.out" \
    || fail "$label failed, but not for '$needle': $(cat "$fixture/$label.out")"
  assert_eq "${expected_log%$'\n'}" "$(cat "$fixture/uploader.log")"
}

revision() { jq -r "$2" "$fixture/revision-$1.json"; }

# A public upload must never silently feed localization fields to the old upstream uploader, which
# would deserialize and discard them. DEV workspaces do not need this gate.
mv "$uploader_dir/.couchcoop-localized-uploader.json" "$fixture/localized-uploader-marker.json"
: > "$fixture/uploader.log"
expect_refused unverified-localized-uploader 'needs the PR #12-capable uploader' --yes --dist "$assets"
mv "$fixture/localized-uploader-marker.json" "$uploader_dir/.couchcoop-localized-uploader.json"
rm "$fixture/uploader.log"

# Leg 1: the DEFAULT run -- no arguments beyond the confirmation -- publishes the latest GitHub
# Release to the public listing as ONE revision, and leaves the item's visibility alone. This is the
# shape a maintainer actually types.
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --yes

assert_uploaded "$workspace"
assert_eq public "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Couch Co-op' "$(jq -r '.title' "$workspace/workshop.json")"
assert_eq "$(<"$repo_root/workshop/description.en.md")" "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq english "$(jq -r '.language' "$workspace/workshop.json")"
assert_eq 13 "$(jq -r '.localizations | length' "$workspace/workshop.json")"
assert_file "$workspace/stale.txt"
assert_file "$workspace/previews/old.gif"
[[ ! -e "$workspace/content/old.txt" ]] || fail "stale payload survived"

# The item's content is the archive's payload, byte for byte. Asserting the whole tree rather than
# one manifest field keeps this test honest about what the uploader's job is, and independent of
# what the payload happens to contain.
diff -r "$payload" "$workspace/content" >/dev/null || fail "uploaded content is not the archive payload"

# THE REGRESSION THIS SHAPE EXISTS FOR: no revision may carry a branch link. A branch-linked
# revision is only served to its branch by the client's subscribe path; the periodic refresh takes
# the item's NEWEST revision branch-blind, so linking cannot keep two payloads apart on one item and
# every subscriber converges on whichever revision was uploaded last. The fixture workspace declares
# both keys, so passing them through is what this would catch.
assert_eq null "$(revision 1 .minBranch)"
assert_eq null "$(revision 1 .maxBranch)"
assert_eq null "$(jq -r '.minBranch' "$workspace/workshop.json")"
assert_eq null "$(jq -r '.maxBranch' "$workspace/workshop.json")"

assert_eq english "$(revision 1 .language)"
assert_eq 13 "$(revision 1 '.localizations | length')"

# One revision, one note: the changelog section under a heading that names the payload's version.
# The Steam page shows nothing else about what a revision is.
grep -qF 'A fixture change a player would read.' <<<"$(revision 1 .changeNote)" \
  || fail "the revision does not carry the changelog: $(revision 1 .changeNote)"

# A Steam change note is BBCode. Shipped as Markdown the section rendered "### Fixed" and "- item"
# literally, which made the release notes the one surface whose formatting did not survive.
note_bb="$(revision 1 .changeNote)"
grep -qF '[h3]Changed[/h3]' <<<"$note_bb" || fail "the heading was not converted to BBCode: $note_bb"
grep -qF '[list]' <<<"$note_bb" || fail "the bullets were not wrapped in a BBCode list: $note_bb"
grep -qF '[*]A fixture change a player would read.' <<<"$note_bb" \
  || fail "a bullet was not converted to a BBCode list item: $note_bb"
grep -qF '[i]code span[/i]' <<<"$note_bb" || fail "inline code was not converted: $note_bb"
grep -qF '[b]bold[/b]' <<<"$note_bb" || fail "bold was not converted: $note_bb"
grep -qF '[url=https://example.invalid/x]link[/url]' <<<"$note_bb" \
  || fail "a link was not converted: $note_bb"
# The wrapped continuation must be folded INTO its item. Left on its own line it falls outside the
# [*] and Steam renders it as a stray paragraph in the middle of the list.
grep -qF '[*]A wrapped bullet whose second line is indented, which must join the item it belongs to rather than escaping the list.' <<<"$note_bb" \
  || fail "a wrapped bullet was not folded into its list item: $note_bb"
grep -qE '^(###|- )' <<<"$note_bb" && fail "raw Markdown survived into the change note: $note_bb"
grep -qF 'Release v0.1.0' <<<"$(revision 1 .changeNote)" \
  || fail "the heading lacks the payload version: $(revision 1 .changeNote)"
# The revision must say which games it runs on. A subscriber cannot open the payload, and the branch
# chip that used to answer this went away with the branch links -- so a revision with no compatibility
# line tells the reader nothing about whether it is for the game they play.
note="$(revision 1 .changeNote)"
grep -qF "$(release_payload_min_game_version "${lanes[@]}") and newer" <<<"$note" \
  || fail "the note does not state the floor the payload requires: $note"
for lane_name in "${lanes[@]}"; do
  grep -qF "$(release_lane_game_build "$lane_name")" <<<"$note" \
    || fail "the note does not name lane $lane_name's game build: $note"
done

# REGRESSION, and the reason the two facts are generated by one function: the floor is what the
# payload REQUIRES and each lane's build is what it is BUILT FOR. Stating the builds as requirements
# ("works with v0.107.1 and v0.111.0") tells every player on the normal game that the mod will not run
# for them.
#
# Split on a period followed by WHITESPACE, exactly as test-release-body.sh does, and for the reason
# it documents: the two numbers sit one sentence apart, and splitting on bare periods shreds the
# version strings themselves -- `v0.111.0` becomes three fragments and the grep below can then never
# match, which is a check that passes because it can no longer see anything. Verified by mutation:
# adding the beta build to the requirement sentence must fail this.
note_floor="$(release_payload_min_game_version "${lanes[@]}")"
mapfile -t note_sentences < <(tr '\n' ' ' <<<"$note" | sed 's/\. /.\n/g')
for sentence in "${note_sentences[@]}"; do
  grep -qiE 'works with|require|needs' <<<"$sentence" || continue
  for lane_name in "${lanes[@]}"; do
    lane_build="$(release_lane_game_build "$lane_name")"
    # The default lane's build IS the floor, so requiring it is correct. Compare against the floor
    # rather than against the lane name: it is the version that makes the claim true or false.
    [[ "$lane_build" == "$note_floor" ]] && continue
    grep -qF "$lane_build" <<<"$sentence" \
      && fail "lane $lane_name is only built for $lane_build, but the note states it as a requirement: $sentence"
  done
done

# And it must never claim Steam hands out a build per branch. It does not -- one item, one revision,
# and the mod chooses at load time. That claim is what the retired shape asserted and never delivered.
grep -qiE 'steam (picks|selects|gives|chooses)|matching your branch' <<<"$note" \
  && fail "the note claims Steam selects a build by game branch: $note"

# Leg 2: publishing to the PUBLIC listing is never a by-product of a half-typed command.
expect_refused no-confirmation 'stdin is not a terminal and --yes was not passed' --dist "$assets"

# Leg 3: an explicit --visibility still rewrites it, even for a published item.
rm -f "$fixture"/revision-*.json
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --yes --visibility private

assert_uploaded "$workspace"
assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq "$(<"$repo_root/workshop/description.en.md")" "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq 13 "$(jq -r '.localizations | length' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"

# Leg 4: a release is one archive, so a run is one revision. There is nothing left to narrow.
assert_eq 1 "$(ls "$fixture"/revision-*.json | wc -l)"

# Leg 5: --dist reads a locally built release, with gh poisoned so it cannot silently fall back.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --yes --dist "$assets"

assert_uploaded "$workspace"
diff -r "$payload" "$workspace/content" >/dev/null || fail "--dist uploaded something other than the payload"

# Leg 6: a first publish -- no mod_id.txt yet -- applies the default visibility over whatever the
# workspace declared, and the uploader writes the new item ID.
rm -f "$workspace/mod_id.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --yes --dist "$assets"

assert_uploaded "$workspace"
assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"

primary_config_before="$(sha256sum < "$workspace/workshop.json")"

# Leg 7: --workspace publishes a second item with the same uploader binary, needs no confirmation
# (it is not the public listing), and does not touch the default workspace.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"

assert_file "$dev_workspace/content/couchcoop.json"
assert_eq unlisted "$(jq -r '.visibility' "$dev_workspace/workshop.json")"
assert_eq 'CouchCoop DEV' "$(jq -r '.title' "$dev_workspace/workshop.json")"
assert_eq 9999999999 "$(tr -d '\n' < "$dev_workspace/mod_id.txt")"
# A DEV workspace declares the branch keys too, and they are deleted there as well.
assert_eq null "$(jq -r '.minBranch' "$dev_workspace/workshop.json")"
[[ ! -e "$dev_workspace/previews" ]] || fail "--workspace run created a previews directory"
assert_eq "$primary_config_before" "$(sha256sum < "$workspace/workshop.json")"
assert_uploaded "$dev_workspace"

# Leg 8: a relative --workspace resolves against the CURRENT DIRECTORY, not $uploader_dir.
# ModUploader is invoked as `cd "$uploader_dir" && ./ModUploader -w "$workspace"`, so an
# unresolved relative path would be silently re-anchored there instead -- e.g. run from a repo
# root, `.sts2/uploader/Workspace.dev` would double into `.sts2/uploader/.sts2/uploader/Workspace.dev`.
(
  cd "$fixture"
  MOCK_UPLOADER_LOG="$fixture/uploader.log" \
  COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
  PATH="$blocked_gh_bin:$PATH" \
  bash "$script" --dist "$assets" --workspace dev-workspace
)
assert_uploaded "$dev_workspace"

# Leg 9: the environment selects the same workspace without a flag, and the flag beats an unusable
# environment value rather than consulting it.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$dev_workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets"
assert_uploaded "$dev_workspace"
assert_eq "$primary_config_before" "$(sha256sum < "$workspace/workshop.json")"

MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$fixture/no-such-workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"
assert_uploaded "$dev_workspace"

# Leg 10: workspace preconditions apply to the SELECTED workspace, not the default one.
broken_workspace="$fixture/broken-workspace"
mkdir -p "$broken_workspace"
cp "$dev_workspace/workshop.json" "$broken_workspace/workshop.json"
head -c 1100000 /dev/zero > "$broken_workspace/image.png"
expect_refused oversize-preview 'must be smaller than 1 MiB' \
  --dist "$assets" --workspace "$broken_workspace"

# Leg 11: a dist directory holding TWO release archives is refused, not resolved by "newest wins". A
# stale archive from an earlier build is exactly how the wrong payload reaches an item.
two_releases="$fixture/two-releases"
mkdir -p "$two_releases"
cp "$assets"/couchcoop-v0.1.0.* "$two_releases/"
cp "$assets/couchcoop-v0.1.0.zip" "$two_releases/couchcoop-v0.0.9.zip"
expect_refused two-releases 'holds 2 different release archives' \
  --dist "$two_releases" --workspace "$dev_workspace"

# ...and that also catches a leftover from the retired two-archive shape, which is the likelier
# stale file for a while yet.
expect_refused stale-lane-suffix 'holds 2 different release archives' \
  --dist "$stale_lane_suffix" --workspace "$dev_workspace"

# Leg 12: --lane is gone with the per-lane archives it selected, and an unknown flag is a usage
# error rather than a silently ignored argument.
expect_refused retired-lane-flag 'usage: scripts/upload-workshop-release.sh' \
  --dist "$assets" --lane "${lanes[0]}" --workspace "$dev_workspace"

# Leg 13: a workspace may declare which lanes it carries. One payload carries every lane, so a
# workspace has to allow them all -- a workspace pinned to a single lane can no longer publish a
# release at all, because no single-lane payload exists to give it.
printf '%s\n' "${lanes[1]}" > "$dev_workspace/lane.txt"
expect_refused workspace-lane-mismatch "may publish lane(s) [${lanes[1]}], but this release carries '${lanes[0]}'" \
  --dist "$assets" --workspace "$dev_workspace"

# ...and a workspace naming every lane publishes. lane.txt stays local: the uploader never
# receives it.
printf '%s\n' "${lanes[@]}" > "$dev_workspace/lane.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"
assert_uploaded "$dev_workspace"
[[ ! -e "$dev_workspace/content/lane.txt" ]] || fail "lane.txt leaked into the uploaded content"
rm -f "$dev_workspace/lane.txt"

# Leg 14: a snapshot is refused for an ordinary workspace and published by a DEV CHANNEL, which is
# what one is for. The opt-in is a marker file, so it travels with the item.
expect_refused snapshot-no-dev-channel 'is not a dev channel' \
  --dist "$snapshot_dist" --workspace "$dev_workspace"

printf '' > "$dev_workspace/dev-channel"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$snapshot_dist" --workspace "$dev_workspace"
assert_uploaded "$dev_workspace"
[[ ! -e "$dev_workspace/content/dev-channel" ]] || fail "dev-channel marker leaked into the uploaded content"
# A snapshot's filename carries only a commit sha, so a heading built from it says nothing about
# which version the build is OF. It comes from the payload for exactly that reason.
grep -qF 'Test build 0.1.1+snapshot.abcdef123456' \
  <<<"$(jq -r '.changeNote' "$dev_workspace/workshop.json")" \
  || fail "snapshot heading lost the base version: $(jq -r '.changeNote' "$dev_workspace/workshop.json")"

# ...and the public listing still refuses one even with a dev channel sitting beside it.
expect_refused snapshot-public 'is not a dev channel' --yes --dist "$snapshot_dist"
rm -f "$dev_workspace/dev-channel"

# Leg 15: a failed upload stops the release and says to look at the item page before retrying --
# an uploader's non-zero exit is a claim about the CLIENT, not about server state. There is no
# longer a "timeout but it committed" arm: that pathology belonged to the branch keys, which are
# not written any more, so k_EResultTimeout is now an ordinary failure like any other.
real_uploader="$uploader_dir/ModUploader"
cp "$real_uploader" "$fixture/ModUploader.real"

for failure in 'Error occurred while uploading to the workshop! Result: k_EResultTimeout' 'something genuinely broke'; do
  cat > "$real_uploader" <<MOCKEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$MOCK_UPLOADER_LOG"
echo "$failure"
exit 7
MOCKEOF
  chmod +x "$real_uploader"
  failed_status=0
  MOCK_UPLOADER_LOG="$fixture/uploader.log" \
  COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
  PATH="$blocked_gh_bin:$PATH" \
  bash "$script" --dist "$assets" --workspace "$dev_workspace" >"$fixture/failed.out" 2>&1 || failed_status=$?
  assert_eq 1 "$failed_status"
  grep -qF 'the upload failed' "$fixture/failed.out" || fail "a failed upload must say so: $failure"
  grep -qF 'Check the item page before retrying' "$fixture/failed.out" \
    || fail "a failed upload must tell the operator to verify: $failure"
  assert_uploaded "$dev_workspace"
done
cp "$fixture/ModUploader.real" "$real_uploader"

# The sweep: across every revision this test produced -- public and DEV, first publish and update,
# release and snapshot -- not one carries a branch link.
revision_count=0
for recorded in "$fixture"/all-revisions/*.json; do
  revision_count=$(( revision_count + 1 ))
  jq -e 'has("minBranch") or has("maxBranch") | not' "$recorded" >/dev/null \
    || fail "revision $recorded carries a branch link: $(jq -c '{minBranch, maxBranch}' "$recorded")"
done
[[ $revision_count -ge 10 ]] || fail "expected the sweep to cover every revision, saw $revision_count"

echo "test-upload-workshop-release: ok"
