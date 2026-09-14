#!/usr/bin/env bash
set -euo pipefail

# The official uploader has not merged localized metadata support yet. Keep its source outside this
# repository (and ignored) while making the exact release-tool build reproducible.
readonly UPLoader_REPOSITORY="https://github.com/megacrit/sts2-mod-uploader.git"
readonly UPLoader_COMMIT="84e755cea6bcfa014df3165c882f1824259245c6"
readonly UPLoader_VERSION="1.0.0+84e755cea6bcfa014df3165c882f1824259245c6"

usage() {
  cat >&2 <<'EOF'
usage: scripts/install-localized-workshop-uploader.sh [--uploader-dir <directory>]

Build Mega Crit sts2-mod-uploader PR #12 at its pinned commit into local, ignored Workshop tooling.
Existing workspaces, Steam runtime configuration, previews, item IDs and logs are preserved.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uploader_dir="$repo_root/.sts2/uploader"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uploader-dir) uploader_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

for command in git dotnet jq sha256sum; do
  command -v "$command" >/dev/null || { echo "install-localized-workshop-uploader: missing required command: $command" >&2; exit 1; }
done
mkdir -p "$uploader_dir"
source_dir="$uploader_dir/.couchcoop-uploader-source"
if [[ ! -d "$source_dir/.git" ]]; then
  [[ ! -e "$source_dir" ]] || { echo "install-localized-workshop-uploader: source path is not a git checkout: $source_dir" >&2; exit 1; }
  git clone "$UPLoader_REPOSITORY" "$source_dir"
fi

git -C "$source_dir" fetch origin pull/12/head
git -C "$source_dir" cat-file -e "$UPLoader_COMMIT^{commit}" || {
  echo "install-localized-workshop-uploader: PR #12 did not provide $UPLoader_COMMIT" >&2
  exit 1
}
git -C "$source_dir" checkout --detach "$UPLoader_COMMIT"
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$UPLoader_COMMIT" ]] || {
  echo "install-localized-workshop-uploader: checked out an unexpected uploader revision" >&2
  exit 1
}

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-localized-uploader.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
dotnet publish "$source_dir/ModUploader.csproj" --configuration Release --output "$stage_dir/publish"
candidate="$stage_dir/publish/ModUploader"
[[ -x "$candidate" ]] || { echo "install-localized-workshop-uploader: publish did not produce ModUploader" >&2; exit 1; }
[[ "$($candidate --version)" == "$UPLoader_VERSION" ]] || {
  echo "install-localized-workshop-uploader: published uploader did not report $UPLoader_VERSION" >&2
  exit 1
}

# PR #12 adds no runtime dependencies. Copy the publish output's runtime files without traversing
# workspace directories or replacing the Steam app-id/session files owned by the maintainer.
while IFS= read -r -d '' runtime_file; do
  name="$(basename "$runtime_file")"
  case "$name" in steam_appid.txt|mod-uploader.log) continue ;; esac
  install -m 755 "$runtime_file" "$uploader_dir/$name"
done < <(find "$stage_dir/publish" -mindepth 1 -maxdepth 1 -type f -print0)

jq -n --arg repository "$UPLoader_REPOSITORY" --arg commit "$UPLoader_COMMIT" \
  --arg version "$UPLoader_VERSION" --arg sha256 "$(sha256sum "$uploader_dir/ModUploader" | awk '{print $1}')" \
  '{repository: $repository, commit: $commit, version: $version, modUploaderSha256: $sha256}' \
  > "$uploader_dir/.couchcoop-localized-uploader.json"
printf 'Installed localized ModUploader %s into %s\n' "$UPLoader_VERSION" "$uploader_dir"
