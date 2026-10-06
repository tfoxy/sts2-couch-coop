#!/usr/bin/env bash
# Create a configured CouchCoop worktree, with optional sibling dependency worktrees.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/create-worktree.sh <name> [--spirectl-ref <ref>] [--godot-scene-web-ref <ref>]

Create a CouchCoop branch from local main. Without dependency refs, the checkout is
.worktrees/<name>. With either dependency ref, create a bundle at .worktrees/<name>/
containing the CouchCoop checkout and both dependency entries. Unspecified dependencies
are relative links to the shared checkouts.

No existing path or branch is refreshed or overwritten.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

if [[ $# -eq 1 && ( "$1" == -h || "$1" == --help ) ]]; then usage; exit 0; fi
if [[ $# -lt 1 ]]; then usage >&2; exit 2; fi

name="$1"
shift
[[ "$name" =~ ^[A-Za-z0-9._-]{1,64}$ && "$name" != .* ]] || die "invalid name '$name'; use 1-64 letters, digits, dots, underscores or hyphens, not starting with a dot"
[[ "$name" != spirectl && "$name" != godot-scene-web ]] || die "'$name' is reserved for a shared dependency link"

spirectl_ref=""
gsw_ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --spirectl-ref)
      [[ $# -ge 2 && -n "$2" ]] || die "--spirectl-ref requires a commit or ref"
      spirectl_ref="$2"; shift 2 ;;
    --godot-scene-web-ref)
      [[ $# -ge 2 && -n "$2" ]] || die "--godot-scene-web-ref requires a commit or ref"
      gsw_ref="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1'" ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this from the CouchCoop main checkout"
[[ "$(basename "$repo_root")" == sts2-couch-coop ]] || die "expected sts2-couch-coop, got '$repo_root'"
[[ "$(git -C "$repo_root" branch --show-current)" == main ]] || die "run this from the local main checkout"
[[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=all)" ]] || die "the main checkout has tracked or untracked changes; clean it before creating a worktree"

parent="$(dirname "$repo_root")"
spirectl_root="$parent/spirectl"
gsw_root="$parent/godot-scene-web"
for dep in "$spirectl_root" "$gsw_root"; do
  [[ -d "$dep" ]] || die "missing sibling repository: $dep"
  [[ "$(git -C "$dep" rev-parse --show-toplevel 2>/dev/null)" == "$dep" ]] || die "not a repository root: $dep"
done

[[ -f "$repo_root/sts2.local.yaml" ]] || die "missing $repo_root/sts2.local.yaml"
[[ -d "$repo_root/frontend/node_modules" ]] || die "missing $repo_root/frontend/node_modules; install frontend dependencies first"
[[ -d "$repo_root/godot-client/.godot" ]] || die "missing $repo_root/godot-client/.godot; open/build the Godot client once first"

has_spirectl=0
has_gsw=0
[[ -z "$spirectl_ref" ]] || has_spirectl=1
[[ -z "$gsw_ref" ]] || has_gsw=1
bundle=0
(( has_spirectl || has_gsw )) && bundle=1

worktrees_root="$repo_root/.worktrees"
workspace="$worktrees_root/$name"
if (( bundle )); then
  couch_path="$workspace/sts2-couch-coop"
else
  couch_path="$workspace"
fi
couch_branch="worktree/$name"
spirectl_branch="worktree/$name"
gsw_branch="worktree/$name"

[[ ! -e "$workspace" && ! -L "$workspace" ]] || die "destination already exists: $workspace"

preflight_repo() {
  local root="$1" branch="$2" ref="$3" label="$4"
  git -C "$root" show-ref --verify --quiet "refs/heads/$branch" && die "$label branch already exists: $branch"
  if [[ -n "$ref" ]]; then
    git -C "$root" rev-parse --verify --end-of-options "$ref^{commit}" >/dev/null 2>&1 || die "$label ref does not resolve to a commit: $ref"
  fi
}
preflight_repo "$repo_root" "$couch_branch" main CouchCoop
(( has_spirectl )) && preflight_repo "$spirectl_root" "$spirectl_branch" "$spirectl_ref" spirectl
(( has_gsw )) && preflight_repo "$gsw_root" "$gsw_branch" "$gsw_ref" godot-scene-web

root_links_created=()
workspace_links_created=()
created_roots=()
created_branches=()
cleanup() {
  local i
  for ((i=${#created_roots[@]}-1; i>=0; i--)); do
    git -C "${created_roots[$i]}" worktree remove --force "${created_paths[$i]}" >/dev/null 2>&1 || true
    git -C "${created_roots[$i]}" branch -D "${created_branches[$i]}" >/dev/null 2>&1 || true
  done
  for link in "${workspace_links_created[@]}"; do rm -f "$link"; done
  if (( bundle )); then rmdir "$workspace" 2>/dev/null || true; fi
  for link in "${root_links_created[@]}"; do rm -f "$link"; done
  rmdir "$worktrees_root" 2>/dev/null || true
}
created_paths=()
on_exit() { local status=$?; if (( status != 0 )); then cleanup; fi; }
trap on_exit EXIT

mkdir -p "$worktrees_root"
[[ ! -L "$worktrees_root" ]] || die "$worktrees_root must be a real directory, not a symlink"

ensure_shared_link() {
  local link="$1" target="$2" expected relative
  expected="$(realpath "$target")"
  if [[ -L "$link" ]]; then
    [[ "$(realpath "$link")" == "$expected" ]] || die "$link points somewhere unexpected: $(readlink "$link")"
    return
  fi
  [[ ! -e "$link" ]] || die "$link exists and is not the expected relative symlink"
  relative="$(realpath --relative-to="$(dirname "$link")" "$target")"
  ln -s "$relative" "$link"
  root_links_created+=("$link")
}
ensure_shared_link "$worktrees_root/spirectl" "$spirectl_root"
ensure_shared_link "$worktrees_root/godot-scene-web" "$gsw_root"

# These are shared by all linked worktrees. Bare patterns also match symlinked node_modules.
common_dir="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
exclude_file="$common_dir/info/exclude"
mkdir -p "$(dirname "$exclude_file")"
touch "$exclude_file"
for pattern in node_modules frontend/node_modules; do
  grep -qxF "$pattern" "$exclude_file" || printf '%s\n' "$pattern" >> "$exclude_file"
done

add_worktree() {
  local root="$1" branch="$2" ref="$3" dest="$4"
  local commit
  commit="$(git -C "$root" rev-parse --verify --end-of-options "$ref^{commit}")"
  git -C "$root" worktree add -b "$branch" "$dest" "$commit"
  created_roots+=("$root")
  created_paths+=("$dest")
  created_branches+=("$branch")
}

mkdir -p "$(dirname "$couch_path")"
add_worktree "$repo_root" "$couch_branch" main "$couch_path"
if (( bundle )); then
  if (( has_spirectl )); then
    add_worktree "$spirectl_root" "$spirectl_branch" "$spirectl_ref" "$workspace/spirectl"
  else
    ln -s ../spirectl "$workspace/spirectl"
    workspace_links_created+=("$workspace/spirectl")
  fi
  if (( has_gsw )); then
    add_worktree "$gsw_root" "$gsw_branch" "$gsw_ref" "$workspace/godot-scene-web"
  else
    ln -s ../godot-scene-web "$workspace/godot-scene-web"
    workspace_links_created+=("$workspace/godot-scene-web")
  fi
fi

# Worktree-local CouchCoop state: copy machine config and Godot's import cache, share npm and
# local agent/tool notes, and leave .sts2 empty and independent.
cp "$repo_root/sts2.local.yaml" "$couch_path/sts2.local.yaml"
mkdir -p "$couch_path/frontend" "$couch_path/godot-client" "$couch_path/.sts2"
node_modules_link="$couch_path/frontend/node_modules"
node_modules_rel="$(realpath --relative-to="$(dirname "$node_modules_link")" "$repo_root/frontend/node_modules")"
ln -s "$node_modules_rel" "$node_modules_link"
cp -a "$repo_root/godot-client/.godot" "$couch_path/godot-client/.godot"
if [[ -d "$repo_root/.ai" ]]; then
  ai_rel="$(realpath --relative-to="$couch_path" "$repo_root/.ai")"
  ln -s "$ai_rel" "$couch_path/.ai"
fi
(cd "$couch_path" && bash scripts/install-agent-config.sh)

trap - EXIT
printf 'created CouchCoop worktree: %s\nbranch: %s\n' "$couch_path" "$couch_branch"
if (( bundle )); then
  printf 'workspace: %s\n' "$workspace"
  (( has_spirectl )) && printf 'spirectl: %s (%s)\n' "$workspace/spirectl" "$spirectl_ref" || printf 'spirectl: %s -> shared main\n' "$workspace/spirectl"
  (( has_gsw )) && printf 'godot-scene-web: %s (%s)\n' "$workspace/godot-scene-web" "$gsw_ref" || printf 'godot-scene-web: %s -> shared main\n' "$workspace/godot-scene-web"
fi
printf 'build safety: set COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-%s before any C# build/run\n' "$name"
