#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="$repo_root/sts2.local.yaml"
configuration="${COUCHCOOP_CONFIGURATION:-Debug}"
# `sts2 game deploy --build` exports the absolute directory it will copy into the mods folder.
# Honour it so the build and the deploy can never disagree about where the mod was written; an
# explicit --output (which sts2 also passes, via the `{deployOutputDir}` token) still wins.
output_dir="${SPIRECTL_DEPLOY_OUTPUT_DIR:-${COUCHCOOP_LOCAL_MOD_DIR:-}}"

usage() {
  cat >&2 <<'EOF'
usage: scripts/build-local-mod.sh [--output <dir>] [--configuration Debug|Release]

By default, builds into game.modsDir/couchcoop or game.path/mods/couchcoop, resolved via
`sts2 --json config resolve` (falling back to reading sts2.local.yaml directly).
Honours $SPIRECTL_DEPLOY_OUTPUT_DIR (set by `sts2 game deploy --build`) when no --output is given.
EOF
}

yaml_value() {
  local key="$1"
  [[ -f "$config_path" ]] || return 0
  sed -nE "s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*\"([^\"]*)\"[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*'([^']*)'[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${key}[[:space:]]*:[[:space:]]*([^#[:space:]][^#]*)[[:space:]]*(#.*)?$/\1/p" "$config_path" | head -n 1 | sed -E 's/[[:space:]]+$//'
}

# One resolve call, cached: `sts2 --json config resolve` is the single source of truth for the
# game paths (it merges sts2.config.yaml, sts2.local.yaml and sts2's own defaults, and returns
# absolute values). The sed reader above stays as the fallback so building the mod never REQUIRES
# the CLI to be installed -- the shipped mod must not depend on it.
resolved_config=""
resolved_config_loaded=""
load_resolved_config() {
  [[ -n "$resolved_config_loaded" ]] && return 0
  resolved_config_loaded=1
  command -v sts2 >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  resolved_config="$( (cd "$repo_root" && sts2 --json config resolve modsDir gamePath) 2>/dev/null || true)"
}

# config_value <resolved-key> <sts2.local.yaml-key>
config_value() {
  load_resolved_config
  local value=""
  if [[ -n "$resolved_config" ]]; then
    value="$(printf '%s' "$resolved_config" | jq -r --arg key "$1" '.[$key] // empty' 2>/dev/null || true)"
  fi
  if [[ -z "$value" ]]; then
    value="$(yaml_value "$2" || true)"
  fi
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      output_dir="${2:-}"
      shift 2
      ;;
    --configuration)
      configuration="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$config_path" ]]; then
  echo "Missing sts2.local.yaml; create it with game.path and game.assembliesDir." >&2
  exit 1
fi

if [[ -z "$output_dir" ]]; then
  mods_dir="$(config_value modsDir modsDir)"
  if [[ -z "$mods_dir" ]]; then
    game_path="$(config_value gamePath path)"
    if [[ -z "$game_path" ]]; then
      echo "Missing game.path in sts2.local.yaml; cannot choose a default mods output directory." >&2
      exit 1
    fi
    mods_dir="$game_path/mods"
  fi
  output_dir="$mods_dir/couchcoop"
fi

case "$output_dir" in
  /*) ;;
  *) output_dir="$repo_root/$output_dir" ;;
esac

mkdir -p "$output_dir"

# Remove stale top-level managed assemblies from a previous deploy before publishing. `dotnet publish`
# overwrites but never deletes pre-existing files, so a renamed-away assembly (e.g. the old
# Spirectl.Sts2.dll, now shipped as CouchCoop.Spirectl.dll) would otherwise linger in the mod dir and
# could be picked up at load time. Subdirectories (frontend/, hot-reload/) are regenerated separately
# below and are left untouched.
find "$output_dir" -maxdepth 1 -type f \( -name '*.dll' -o -name '*.pdb' \) -delete

dotnet publish "$repo_root/src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" \
  -c "$configuration" \
  -p:CouchCoopBuildToLocalMods=false \
  -p:CouchCoopEnableHotReload=true \
  -o "$output_dir"

# Drop stray JSON a previous deploy left in hot-reload/. `dotnet build` overwrites but never deletes, so a
# .deps.json / .runtimeconfig.json from before those were disabled would linger — and STS2's ModManager
# scans every non-dot-dir *.json under the mod as a manifest and logs an [ERROR] for each one missing 'id'.
rm -f "$output_dir/hot-reload/CouchCoop.Mod.HotReload.deps.json" \
      "$output_dir/hot-reload/CouchCoop.Mod.HotReload.runtimeconfig.json"

dotnet build "$repo_root/src/CouchCoop.Mod.HotReload/CouchCoop.Mod.HotReload.csproj" \
  -c "$configuration" \
  -p:CouchCoopEnableHotReload=true \
  -p:HotReloadDeployDir="$output_dir/hot-reload"

COUCHCOOP_FRONTEND_OUT_DIR="$output_dir/frontend" npm --prefix "$repo_root/frontend" run build

printf '{"outputDir":"%s","configuration":"%s"}\n' "$output_dir" "$configuration"
