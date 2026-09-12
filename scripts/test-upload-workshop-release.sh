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
assert_uploaded() {
  expected_log+="upload -w $1"$'\n'
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
  CouchCoop.Mod.dll CouchCoop.Mod.Contracts.dll CouchCoop.MirrorProtocol.dll CouchCoop.Spirectl.dll QRCoder.dll \
  frontend/index.html frontend/app-boot frontend/manifest.webmanifest frontend/icons/icon.svg frontend/.vite/manifest.json \
  licenses/QRCoder-1.6.0-MIT.txt licenses/spirectl-LICENSE licenses/spirectl-NOTICE licenses/godot-scene-web-LICENSE \
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
publish_assets() {
  local archive="$1" payload_parent="$2"
  (cd "$payload_parent" && zip -X -q -r "$archive" couchcoop)
  (cd "$(dirname "$archive")" && sha256sum "$(basename "$archive")" > "${archive%.zip}.SHA256SUMS")
}

write_payload "$payload" stable
publish_assets "$assets/couchcoop-v0.1.0.zip" "$fixture/payload"

# The beta lane's archive sits in the same directory, which is the whole hazard: only the --lane flag
# may decide which of the two is published, never "newest by sort -V".
beta_payload="$fixture/beta-payload/couchcoop"
mkdir -p "$(dirname "$beta_payload")"
cp -a "$payload" "$beta_payload"
write_payload "$beta_payload" public-beta
publish_assets "$assets/couchcoop-v0.1.0-public-beta.zip" "$fixture/beta-payload"

# A dist directory holding only the stable lane, for a --lane public-beta run that must not fall back.
stable_only="$fixture/stable-only"
mkdir -p "$stable_only"
cp "$assets/couchcoop-v0.1.0.zip" "$assets/couchcoop-v0.1.0.SHA256SUMS" "$stable_only/"

# A --snapshot build, which is not publishable: a Workshop item copies an archive that exists as a
# GitHub Release, and a snapshot has no tag.
snapshot_dist="$fixture/snapshot-dist"
mkdir -p "$snapshot_dist"
publish_assets "$snapshot_dist/couchcoop-snapshot-abcdef123456.zip" "$fixture/payload"

# A beta-named archive carrying a stable payload: the name says public-beta, build-info.txt says
# stable, and the gate must refuse it rather than publish the wrong game branch to the beta item.
mislabelled="$fixture/mislabelled"
mkdir -p "$mislabelled"
publish_assets "$mislabelled/couchcoop-v0.1.0-public-beta.zip" "$fixture/payload"

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
  contentDescriptors: []
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
cat > "$uploader_dir/ModUploader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_UPLOADER_LOG"
workspace="${@: -1}"
if [[ ! -f "$workspace/mod_id.txt" ]]; then
  printf '1234567890\n' > "$workspace/mod_id.txt"
fi
EOF
chmod +x "$mock_bin/gh" "$uploader_dir/ModUploader"

blocked_gh_bin="$test_root/blocked-gh"
mkdir -p "$blocked_gh_bin"
cat > "$blocked_gh_bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh must not be called in --dist mode" >&2
exit 99
EOF
chmod +x "$blocked_gh_bin/gh"

# Leg 1: a release upload of an already-published item leaves its declared visibility alone.
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script"

assert_file "$workspace/content/couchcoop.json"
[[ ! -e "$workspace/content/old.txt" ]] || fail "stale payload survived"
assert_file "$workspace/stale.txt"
assert_file "$workspace/mod_id.txt"
assert_file "$workspace/previews/old.gif"
assert_eq public "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Release v0.1.0' "$(jq -r '.changeNote' "$workspace/workshop.json")"
assert_eq CouchCoop "$(jq -r '.title' "$workspace/workshop.json")"
assert_eq 'Fixture source description' "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq false "$(jq 'has("minBranch") or has("maxBranch")' "$workspace/workshop.json")"
assert_uploaded "$workspace"

# Leg 2: an explicit --visibility still rewrites it, even for a published item.
MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --visibility private

assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Fixture source description' "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"
assert_uploaded "$workspace"

# Leg 3: the same, from a local release directory, with gh blocked.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --visibility unlisted

assert_eq unlisted "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_uploaded "$workspace"

# Leg 4: a first publish — no mod_id.txt yet — applies the default visibility, over whatever the
# workspace happened to declare, and the uploader writes the new item ID.
rm -f "$workspace/mod_id.txt"
assert_eq unlisted "$(jq -r '.visibility' "$workspace/workshop.json")"

MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets"

assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Release v0.1.0' "$(jq -r '.changeNote' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"
assert_uploaded "$workspace"

primary_config_before="$(sha256sum < "$workspace/workshop.json")"

# Leg 5: --workspace publishes a second workspace with the same uploader binary, leaves its
# unlisted visibility alone, and does not touch the default workspace.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"

assert_file "$dev_workspace/content/couchcoop.json"
assert_eq unlisted "$(jq -r '.visibility' "$dev_workspace/workshop.json")"
assert_eq 'Release v0.1.0' "$(jq -r '.changeNote' "$dev_workspace/workshop.json")"
assert_eq 'CouchCoop DEV' "$(jq -r '.title' "$dev_workspace/workshop.json")"
assert_eq 'Dev fixture description' "$(jq -r '.description' "$dev_workspace/workshop.json")"
assert_eq 9999999999 "$(tr -d '\n' < "$dev_workspace/mod_id.txt")"
[[ ! -e "$dev_workspace/previews" ]] || fail "--workspace run created a previews directory"
assert_eq "$primary_config_before" "$(sha256sum < "$workspace/workshop.json")"
assert_uploaded "$dev_workspace"

# Leg 6: COUCHCOOP_WORKSHOP_WORKSPACE_DIR selects the same workspace without a flag.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$dev_workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets"

assert_eq unlisted "$(jq -r '.visibility' "$dev_workspace/workshop.json")"
assert_eq "$primary_config_before" "$(sha256sum < "$workspace/workshop.json")"
assert_uploaded "$dev_workspace"

# Leg 7: the flag wins over the environment — an unusable env value must not be consulted.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
COUCHCOOP_WORKSHOP_WORKSPACE_DIR="$fixture/no-such-workspace" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"

assert_uploaded "$dev_workspace"

# Leg 8: workspace preconditions apply to the selected workspace, not to the default one.
broken_workspace="$fixture/broken-workspace"
mkdir -p "$broken_workspace"
cp "$dev_workspace/workshop.json" "$broken_workspace/workshop.json"
head -c 1048576 /dev/zero > "$broken_workspace/image.png"

status=0
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$broken_workspace" 2>"$fixture/broken.err" || status=$?
[[ $status -eq 1 ]] || fail "oversized preview in the selected workspace should fail, got status $status"
grep -q "smaller than 1 MiB: $broken_workspace/image.png" "$fixture/broken.err" \
  || fail "expected the size error to name the selected workspace: $(cat "$fixture/broken.err")"
assert_eq "${expected_log%$'\n'}" "$(cat "$fixture/uploader.log")"

# A run that must not reach the uploader: the log stays exactly as it was.
expect_refused() {
  local label="$1" needle="$2"
  shift 2
  local refused_status=0
  MOCK_UPLOADER_LOG="$fixture/uploader.log" \
  COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
  PATH="$blocked_gh_bin:$PATH" \
  bash "$script" "$@" >"$fixture/$label.out" 2>&1 || refused_status=$?
  [[ $refused_status -ne 0 ]] || fail "$label should have failed"
  grep -q -- "$needle" "$fixture/$label.out" \
    || fail "$label failed, but not for '$needle': $(cat "$fixture/$label.out")"
  assert_eq "${expected_log%$'\n'}" "$(cat "$fixture/uploader.log")"
}

# Leg 9: --lane publishes THAT lane's archive out of a directory holding both, and the beta payload
# carries the manifest floor that makes it refuse an older game.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane public-beta --workspace "$dev_workspace"

assert_eq public-beta "$(jq -r '.dependencies.sts2References.lane' "$dev_workspace/content/build-info.txt")"
assert_eq v0.111.0 "$(jq -r '.min_game_version' "$dev_workspace/content/couchcoop.json")"
assert_eq 'Release v0.1.0 (public-beta)' "$(jq -r '.changeNote' "$dev_workspace/workshop.json")"
assert_eq unlisted "$(jq -r '.visibility' "$dev_workspace/workshop.json")"
assert_uploaded "$dev_workspace"

# Leg 10: with both lanes present, the default stays the stable archive — the unsuffixed name the
# README's verification block and every download link point at — and its payload declares no floor.
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --workspace "$dev_workspace"

assert_eq stable "$(jq -r '.dependencies.sts2References.lane' "$dev_workspace/content/build-info.txt")"
assert_eq null "$(jq -r '.min_game_version // "null"' "$dev_workspace/content/couchcoop.json")"
assert_eq 'Release v0.1.0' "$(jq -r '.changeNote' "$dev_workspace/workshop.json")"
assert_uploaded "$dev_workspace"

# Leg 11: a lane with no archive in the directory fails; it never falls back to another lane's zip.
expect_refused missing-lane 'no lane public-beta release archive found' \
  --dist "$stable_only" --lane public-beta --workspace "$dev_workspace"

# Leg 12: a snapshot build is refused by name, and said so explicitly rather than as "none found".
expect_refused snapshot-dist 'holds only a snapshot archive for lane stable' \
  --dist "$snapshot_dist" --workspace "$dev_workspace"

# Leg 13: the lane is verified against the payload's own build-info.txt, so a mislabelled filename
# cannot publish the stable payload to the beta item.
expect_refused mislabelled-lane "built for lane 'stable', not the requested 'public-beta'" \
  --dist "$mislabelled" --lane public-beta --workspace "$dev_workspace"

# Leg 14: an unknown lane is a usage error, not a guess, and so is an ambiguous one.
expect_refused unknown-lane 'unknown release lane' \
  --dist "$assets" --lane experimental --workspace "$dev_workspace"
expect_refused repeated-lane 'may be specified only once' \
  --dist "$assets" --lane stable --lane public-beta --workspace "$dev_workspace"

# Leg 15: a workspace may pin itself to one lane, so the lane and the item cannot be mismatched.
# Publishing the public-beta payload to the public listing is the worst outcome available here.
printf 'public-beta\n' > "$dev_workspace/lane.txt"
expect_refused workspace-lane-mismatch "pinned to lane 'public-beta', but this run publishes lane 'stable'" \
  --dist "$assets" --workspace "$dev_workspace"

# ...and the matching lane still publishes. lane.txt stays local: the uploader never receives it.
printf 'stable\n' > "$dev_workspace/lane.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane stable --workspace "$dev_workspace"

assert_uploaded "$dev_workspace"
[[ ! -e "$dev_workspace/content/lane.txt" ]] || fail "lane.txt leaked into the uploaded content"

# An unpinned workspace stays unpinned: absent lane.txt must not start refusing anything, or every
# existing workspace breaks at once.
rm -f "$dev_workspace/lane.txt"
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --lane stable --workspace "$dev_workspace"

assert_uploaded "$dev_workspace"

echo "test-upload-workshop-release: ok"
