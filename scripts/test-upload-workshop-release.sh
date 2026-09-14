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
# assert_uploaded <workspace> [count]: a release publishes one upload PER LANE, so a run can add
# several lines at once; the whole log is asserted after they are all accounted for.
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

fixture="$test_root/fixture"
assets="$fixture/assets"
payload="$fixture/payload/couchcoop"
mkdir -p "$assets" "$payload/frontend/icons" "$payload/frontend/.vite" "$payload/frontend/app" "$payload/licenses/npm"

for file in \
  LICENSE NOTICE THIRD_PARTY_NOTICES.md couchcoop.json build-info.txt couchcoop.dll \
  CouchCoop.Mod.dll CouchCoop.Mod.Contracts.dll CouchCoop.MirrorProtocol.dll CouchCoop.Spirectl.dll QRCoder.dll DeviceDetector.NET.dll LiteDB.dll Microsoft.Extensions.DependencyInjection.Abstractions.dll Microsoft.Extensions.Logging.Abstractions.dll System.Diagnostics.DiagnosticSource.dll YamlDotNet.dll \
  frontend/index.html frontend/app-boot frontend/manifest.webmanifest frontend/icons/icon.svg frontend/.vite/manifest.json \
  licenses/QRCoder-1.6.0-MIT.txt licenses/DeviceDetector.NET-6.5.2-Apache-2.0.txt licenses/LiteDB-5.0.21-MIT.txt licenses/Microsoft.Extensions.DependencyInjection.Abstractions-10.0.10-MIT.txt licenses/Microsoft.Extensions.Logging.Abstractions-10.0.10-MIT.txt licenses/System.Diagnostics.DiagnosticSource-10.0.10-MIT.txt licenses/YamlDotNet-18.1.0-MIT.txt licenses/spirectl-LICENSE licenses/spirectl-NOTICE licenses/godot-scene-web-LICENSE \
  licenses/HarfBuzz-LICENSE licenses/Emscripten-LICENSE licenses/OpenSans-LICENSE licenses/npm-dependencies.tsv \
  licenses/npm/example.LICENSE frontend/app/example.js; do
  mkdir -p "$(dirname "$payload/$file")"
  printf 'fixture %s\n' "$file" > "$payload/$file"
done

# The build metadata lives INSIDE the payload now (as .txt, because STS2 reads every root-level .json
# in a mod directory as a manifest), and the verifier holds the manifest's min_game_version to the
# lane build-info.txt declares. So a lane fixture is a payload, not just a filename.
write_payload() {
  local root="$1" lane="$2" min
  min="$(release_lane_min_game_version "$lane")"
  if [[ -n "$min" ]]; then
    jq -n --arg min "$min" '{id: "couchcoop", version: "0.1.0", min_game_version: $min}' > "$root/couchcoop.json"
  else
    jq -n '{id: "couchcoop", version: "0.1.0"}' > "$root/couchcoop.json"
  fi
  jq -n --arg lane "$lane" '{
    schemaVersion: "couchcoop-release-build-info/v1",
    sourceCommit: "0000000000000000000000000000000000000000",
    tag: "v0.1.0",
    version: "0.1.0",
    dependencies: {sts2References: {lane: $lane, id: "FuYnAloft.Sts2.References", version: "0.0.0-fixture"}}
  }' > "$root/build-info.txt"
}

# <archive path> <payload parent dir>: one zip plus the one checksum file that still ships with it.
# <archive path> <payload parent dir> [lane]: one zip, and its line APPENDED to the release-wide
# checksum file, which is what package-release.sh publishes -- one file naming every lane's archive.
publish_assets() {
  local archive="$1" payload_parent="$2" lane="${3:-stable}" sums
  (cd "$payload_parent" && zip -X -q -r "$archive" couchcoop)
  sums="$(dirname "$archive")/$(release_checksums_name "$(basename "$archive")" "$lane").SHA256SUMS"
  (cd "$(dirname "$archive")" && sha256sum "$(basename "$archive")" >> "$sums")
}

write_payload "$payload" stable
publish_assets "$assets/couchcoop-v0.1.0.zip" "$fixture/payload"

# The beta lane's archive sits in the same directory, which is the whole hazard: only the --lane flag
# may decide which of the two is published, never "newest by sort -V".
beta_payload="$fixture/beta-payload/couchcoop"
mkdir -p "$(dirname "$beta_payload")"
cp -a "$payload" "$beta_payload"
write_payload "$beta_payload" public-beta
publish_assets "$assets/couchcoop-v0.1.0-public-beta.zip" "$fixture/beta-payload" public-beta

# A dist directory holding only the stable lane, for a --lane public-beta run that must not fall back.
stable_only="$fixture/stable-only"
mkdir -p "$stable_only"
cp "$assets/couchcoop-v0.1.0.zip" "$assets/couchcoop-v0.1.0.SHA256SUMS" "$stable_only/"

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

# A beta-named archive carrying a stable payload: the name says public-beta, build-info.txt says
# stable, and the gate must refuse it rather than publish the wrong game branch to the beta item.
mislabelled="$fixture/mislabelled"
mkdir -p "$mislabelled"
publish_assets "$mislabelled/couchcoop-v0.1.0-public-beta.zip" "$fixture/payload" public-beta

uploader_dir="$fixture/uploader"
workspace="$uploader_dir/Workspace"
mkdir -p "$workspace"
printf 'primary preview' > "$workspace/image.png"
# "public" is deliberately NOT the script's default: a run that omits --visibility must leave it
# alone, so this value is what makes that assertion able to fail.
jq -n '{
  title: "CouchCoop",
  description: "Fixture source description",
  visibility: "public",
  changeNote: "",
  tags: [],
  dependencies: [],
  contentDescriptors: [],
  minBranch: "public",
  maxBranch: "public"
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
  contentDescriptors: []
}' > "$dev_workspace/workshop.json"
printf '9999999999\n' > "$dev_workspace/mod_id.txt"

changelog="$fixture/CHANGELOG.md"
cat > "$changelog" <<'EOF'
# Changelog

## [0.1.0] - 2026-01-01

### Changed

- A fixture change a player would read.
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
# Each upload is one Workshop REVISION, and a release publishes one per lane. The mock records the
# workshop.json of every invocation so a multi-lane run can be asserted revision by revision -- the
# workspace file only ever holds the last one.
cat > "$uploader_dir/ModUploader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  echo '1.0.0+84e755cea6bcfa014df3165c882f1824259245c6'
  exit 0
fi
printf '%s\n' "$*" >> "$MOCK_UPLOADER_LOG"
workspace="${@: -1}"
# nullglob, not ls: under `set -o pipefail` a non-matching glob makes ls exit 2 and takes the
# whole mock down on the very first upload, when there is nothing to count yet.
shopt -s nullglob
existing=( "$(dirname "$MOCK_UPLOADER_LOG")"/revision-*.json )
index=$(( ${#existing[@]} + 1 ))
cp "$workspace/workshop.json" "$(dirname "$MOCK_UPLOADER_LOG")/revision-$index.json"
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
expect_refused unverified-localized-uploader 'needs the PR #12-capable uploader' --yes --dist "$assets" --lane stable
mv "$fixture/localized-uploader-marker.json" "$uploader_dir/.couchcoop-localized-uploader.json"
rm "$fixture/uploader.log"

# Leg 1: the DEFAULT run -- no arguments beyond the confirmation -- publishes EVERY lane of the
# latest GitHub Release to the public listing, one revision each, and leaves the item's visibility
# alone. This is the shape a maintainer actually types.
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --yes

assert_uploaded "$workspace" 2
assert_eq public "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Couch Co-op' "$(jq -r '.title' "$workspace/workshop.json")"
assert_eq "$(<"$repo_root/workshop/description.en.md")" "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq english "$(jq -r '.language' "$workspace/workshop.json")"
assert_eq 13 "$(jq -r '.localizations | length' "$workspace/workshop.json")"
assert_file "$workspace/stale.txt"
assert_file "$workspace/previews/old.gif"
[[ ! -e "$workspace/content/old.txt" ]] || fail "stale payload survived"

# Each revision is linked to the game branch its payload was built for -- that is what makes ONE
# item serve both branches, and it is the whole point of the two-revision shape.
assert_eq public "$(revision 1 .minBranch)"
assert_eq public "$(revision 1 .maxBranch)"
assert_eq public-beta "$(revision 2 .minBranch)"
assert_eq public-beta "$(revision 2 .maxBranch)"
assert_eq english "$(revision 1 .language)"
assert_eq 13 "$(revision 1 '.localizations | length')"
assert_eq null "$(revision 2 .localizations)"

# The change list rides on the default lane's revision and the other points at it, because Steam
# shows one note per revision and the list should not be duplicated.
grep -qF 'A fixture change a player would read.' <<<"$(revision 1 .changeNote)" \
  || fail "stable revision does not carry the changelog: $(revision 1 .changeNote)"
# A revision's heading has to name the version and the game build: the Steam page shows only a
# branch chip, so without this a reader cannot tell what a revision even is.
grep -qF 'Release v0.1.0 — Slay the Spire 2 v0.107.1' <<<"$(revision 1 .changeNote)" \
  || fail "stable heading lacks the version or the game build: $(revision 1 .changeNote)"
grep -qF 'Release v0.1.0 (public-beta) — Slay the Spire 2 v0.111.0' <<<"$(revision 2 .changeNote)" \
  || fail "beta heading lacks the version or the game build: $(revision 2 .changeNote)"
grep -qF 'A fixture change a player would read.' <<<"$(revision 2 .changeNote)" \
  && fail "beta revision should point at the stable revision, not repeat the list"
grep -qF 'stable revision' <<<"$(revision 2 .changeNote)" \
  || fail "beta revision does not point at the stable one: $(revision 2 .changeNote)"

# Leg 2: publishing to the PUBLIC listing is never a by-product of a half-typed command.
expect_refused no-confirmation 'stdin is not a terminal and --yes was not passed' --dist "$assets"

# Leg 3: an explicit --visibility still rewrites it, even for a published item.
rm -f "$fixture"/revision-*.json
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --yes --visibility private --lane stable

assert_uploaded "$workspace"
assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq "$(<"$repo_root/workshop/description.en.md")" "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq 13 "$(jq -r '.localizations | length' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"

# Leg 4: --lane narrows a run to one revision.
assert_eq 1 "$(ls "$fixture"/revision-*.json | wc -l)"

# Leg 5: --dist reads a locally built release, with gh poisoned so it cannot silently fall back.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --yes --dist "$assets" --lane public-beta

assert_uploaded "$workspace"
assert_eq public-beta "$(jq -r '.minBranch' "$workspace/workshop.json")"
assert_eq v0.111.0 "$(jq -r '.min_game_version' "$workspace/content/couchcoop.json")"

# Leg 6: a first publish -- no mod_id.txt yet -- applies the default visibility over whatever the
# workspace declared, and the uploader writes the new item ID.
rm -f "$workspace/mod_id.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --yes --dist "$assets" --lane stable

assert_uploaded "$workspace"
assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"

primary_config_before="$(sha256sum < "$workspace/workshop.json")"

# Leg 7: --workspace publishes a second item with the same uploader binary, needs no confirmation
# (it is not the public listing), and does not touch the default workspace.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane public-beta --workspace "$dev_workspace"

assert_file "$dev_workspace/content/couchcoop.json"
assert_eq unlisted "$(jq -r '.visibility' "$dev_workspace/workshop.json")"
assert_eq 'CouchCoop DEV' "$(jq -r '.title' "$dev_workspace/workshop.json")"
assert_eq 9999999999 "$(tr -d '\n' < "$dev_workspace/mod_id.txt")"
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
  bash "$script" --dist "$assets" --lane public-beta --workspace dev-workspace
)
assert_uploaded "$dev_workspace"

# Leg 9: the environment selects the same workspace without a flag, and the flag beats an unusable
# environment value rather than consulting it.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$dev_workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane stable
assert_uploaded "$dev_workspace"
assert_eq "$primary_config_before" "$(sha256sum < "$workspace/workshop.json")"

MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$fixture/no-such-workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane stable --workspace "$dev_workspace"
assert_uploaded "$dev_workspace"

# Leg 10: workspace preconditions apply to the SELECTED workspace, not the default one.
broken_workspace="$fixture/broken-workspace"
mkdir -p "$broken_workspace"
cp "$dev_workspace/workshop.json" "$broken_workspace/workshop.json"
head -c 1100000 /dev/zero > "$broken_workspace/image.png"
expect_refused oversize-preview 'must be smaller than 1 MiB' \
  --dist "$assets" --workspace "$broken_workspace"

# Leg 11: a dist directory holding TWO releases is refused, not resolved by "newest wins". A stale
# archive from an earlier build is exactly how the wrong payload reaches an item.
two_releases="$fixture/two-releases"
mkdir -p "$two_releases"
cp "$assets"/couchcoop-v0.1.0* "$two_releases/"
cp "$assets/couchcoop-v0.1.0.zip" "$two_releases/couchcoop-v0.0.9.zip"
expect_refused two-releases 'holds 2 different releases' \
  --dist "$two_releases" --workspace "$dev_workspace"

# Leg 12: the lane is verified against the payload's own build-info.txt, so a mislabelled filename
# cannot publish the stable payload as the beta revision.
expect_refused mislabelled-lane "built for lane 'stable', not the requested 'public-beta'" \
  --dist "$mislabelled" --lane public-beta --workspace "$dev_workspace"

# Leg 13: an unknown lane is a usage error, not a guess, and so is an ambiguous one.
expect_refused unknown-lane 'unknown release lane' \
  --dist "$assets" --lane experimental --workspace "$dev_workspace"
expect_refused repeated-lane 'may be specified only once' \
  --dist "$assets" --lane stable --lane public-beta --workspace "$dev_workspace"

# Leg 14: a workspace may declare which lanes it carries, checked for EVERY lane BEFORE anything is
# uploaded -- a two-lane run must not publish one and then refuse the other.
printf 'public-beta\n' > "$dev_workspace/lane.txt"
expect_refused workspace-lane-mismatch "may publish lane(s) [public-beta], but this run publishes 'stable'" \
  --dist "$assets" --workspace "$dev_workspace"

# ...and a workspace that carries BOTH names both, which is what one item serving two branch-linked
# revisions needs. lane.txt stays local: the uploader never receives it.
printf 'public-beta\nstable\n' > "$dev_workspace/lane.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"
assert_uploaded "$dev_workspace" 2
[[ ! -e "$dev_workspace/content/lane.txt" ]] || fail "lane.txt leaked into the uploaded content"
rm -f "$dev_workspace/lane.txt"

# Leg 15: a snapshot is refused for an ordinary workspace and published by a DEV CHANNEL, which is
# what one is for. The opt-in is a marker file, so it travels with the item.
expect_refused snapshot-no-dev-channel 'is not a dev channel' \
  --dist "$snapshot_dist" --lane stable --workspace "$dev_workspace"

printf '' > "$dev_workspace/dev-channel"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$snapshot_dist" --lane stable --workspace "$dev_workspace"
assert_uploaded "$dev_workspace"
[[ ! -e "$dev_workspace/content/dev-channel" ]] || fail "dev-channel marker leaked into the uploaded content"
# A snapshot's filename carries only a commit sha, so a heading built from it says nothing about
# which version the build is OF. It comes from the payload for exactly that reason.
grep -qF 'Test build 0.1.1+snapshot.abcdef123456 — Slay the Spire 2 v0.107.1' \
  <<<"$(jq -r '.changeNote' "$dev_workspace/workshop.json")" \
  || fail "snapshot heading lost the base version: $(jq -r '.changeNote' "$dev_workspace/workshop.json")"

# ...and the public listing still refuses one even with a dev channel sitting beside it.
expect_refused snapshot-public 'is not a dev channel' --yes --dist "$snapshot_dist" --lane stable
rm -f "$dev_workspace/dev-channel"

# Leg 16: the two ways an upload can end badly are told apart. A k_EResultTimeout is a slow commit
# that lands, so the run reports it and carries on with a distinct exit code; anything else is a real
# failure and must stop the release rather than leave it half published.
real_uploader="$uploader_dir/ModUploader"
cp "$real_uploader" "$fixture/ModUploader.real"

cat > "$real_uploader" <<'MOCKEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_UPLOADER_LOG"
echo "Error occurred while uploading to the workshop! Result: k_EResultTimeout"
exit 1
MOCKEOF
chmod +x "$real_uploader"
timeout_status=0
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace" >"$fixture/timeout.out" 2>&1 || timeout_status=$?
assert_eq 3 "$timeout_status"
grep -qF 'VERIFY on the item page' "$fixture/timeout.out" || fail "a timeout must tell the operator to verify"
assert_uploaded "$dev_workspace" 2

cat > "$real_uploader" <<'MOCKEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_UPLOADER_LOG"
echo "something genuinely broke"
exit 7
MOCKEOF
chmod +x "$real_uploader"
broken_status=0
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace" >"$fixture/broken.out" 2>&1 || broken_status=$?
assert_eq 1 "$broken_status"
grep -qF 'failed to upload' "$fixture/broken.out" || fail "a real failure must say so"
# It stopped at the FIRST lane instead of publishing the second.
assert_uploaded "$dev_workspace" 1
cp "$fixture/ModUploader.real" "$real_uploader"

echo "test-upload-workshop-release: ok"
