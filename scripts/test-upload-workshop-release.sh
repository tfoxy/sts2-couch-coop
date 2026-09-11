#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/upload-workshop-release.sh"
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

for command in jq zip unzip sha256sum; do
  command -v "$command" >/dev/null || fail "missing test prerequisite: $command"
done

fixture="$test_root/fixture"
assets="$fixture/assets"
payload="$fixture/payload/couchcoop"
mkdir -p "$assets" "$payload/frontend/icons" "$payload/frontend/.vite" "$payload/frontend/app" "$payload/licenses/npm"

for file in \
  LICENSE NOTICE THIRD_PARTY_NOTICES.md couchcoop.json couchcoop.dll \
  CouchCoop.Mod.dll CouchCoop.Mod.Contracts.dll CouchCoop.MirrorProtocol.dll CouchCoop.Spirectl.dll QRCoder.dll \
  frontend/index.html frontend/app-boot frontend/manifest.webmanifest frontend/icons/icon.svg frontend/.vite/manifest.json \
  licenses/QRCoder-1.6.0-MIT.txt licenses/spirectl-LICENSE licenses/spirectl-NOTICE licenses/godot-scene-web-LICENSE \
  licenses/HarfBuzz-LICENSE licenses/Emscripten-LICENSE licenses/OpenSans-LICENSE licenses/npm-dependencies.tsv \
  licenses/npm/example.LICENSE frontend/app/example.js; do
  mkdir -p "$(dirname "$payload/$file")"
  printf 'fixture %s\n' "$file" > "$payload/$file"
done
jq -n '{id: "couchcoop", version: "0.1.0"}' > "$payload/couchcoop.json"

(cd "$fixture/payload" && zip -X -q -r "$assets/couchcoop-v0.1.0.zip" couchcoop)
contents_tmp="$fixture/contents.ndjson"
while IFS= read -r -d '' file; do
  relative="${file#$fixture/payload/}"
  jq -cn --arg path "$relative" --arg sha256 "$(sha256sum "$file" | cut -d ' ' -f 1)" --argjson size "$(stat -c %s "$file")" \
    '{path: $path, size: $size, sha256: $sha256}' >> "$contents_tmp"
done < <(find "$payload" -type f -print0 | sort -z)
jq -s '{schemaVersion: "couchcoop-release-contents/v1", files: .}' "$contents_tmp" > "$assets/couchcoop-v0.1.0.contents.json"
(cd "$assets" && sha256sum couchcoop-v0.1.0.zip couchcoop-v0.1.0.contents.json > couchcoop-v0.1.0.SHA256SUMS)

uploader_dir="$fixture/uploader"
workspace="$uploader_dir/Workspace"
mkdir -p "$workspace"
printf 'primary preview' > "$workspace/image.png"
jq -n '{
  title: "CouchCoop",
  description: "Fixture source description",
  visibility: "private",
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
assert_eq private "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Release v0.1.0' "$(jq -r '.changeNote' "$workspace/workshop.json")"
assert_eq CouchCoop "$(jq -r '.title' "$workspace/workshop.json")"
assert_eq 'Fixture source description' "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq false "$(jq 'has("minBranch") or has("maxBranch")' "$workspace/workshop.json")"
assert_eq "upload -w $workspace" "$(cat "$fixture/uploader.log")"

MOCK_RELEASE_ASSETS="$assets" \
MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$mock_bin:$PATH" \
bash "$script" --visibility public

assert_eq public "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq 'Fixture source description' "$(jq -r '.description' "$workspace/workshop.json")"
assert_eq 1234567890 "$(tr -d '\n' < "$workspace/mod_id.txt")"
assert_eq "$(printf 'upload -w %s\nupload -w %s' "$workspace" "$workspace")" "$(cat "$fixture/uploader.log")"

MOCK_UPLOADER_LOG="$fixture/uploader.log" \
COUCHCOOP_WORKSHOP_UPLOADER_DIR="$uploader_dir" \
PATH="$blocked_gh_bin:$PATH" \
bash "$script" --dist "$assets" --visibility unlisted

assert_eq unlisted "$(jq -r '.visibility' "$workspace/workshop.json")"
assert_eq "$(printf 'upload -w %s\nupload -w %s\nupload -w %s' "$workspace" "$workspace" "$workspace")" "$(cat "$fixture/uploader.log")"

echo "test-upload-workshop-release: ok"
