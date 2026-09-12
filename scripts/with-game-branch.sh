#!/usr/bin/env bash
# Run a command against a chosen STS2 game install.
#
# CouchCoop finds the game twice, through two resolvers that do not talk to each other:
#
#   1. the `sts2` CLI's config stack — `sts2.config.yaml` + `sts2.local.yaml` in one directory,
#      chosen by `SPIRECTL_CONFIG_DIR`, `--config`, or a walk up from the working directory;
#   2. this repo's own MSBuild reader in `Directory.Build.props`, which regex-reads
#      `sts2.local.yaml` for `game.assembliesDir` / `game.modsDir` / `game.path`, plus
#      `scripts/build-local-mod.sh`, which asks the CLI and falls back to the same sed reader.
#
# `sts2 game deploy --build` exports only SPIRECTL_DEPLOY_OUTPUT_DIR, SPIRECTL_DEPLOY_PROJECT_ROOT
# and SPIRECTL_DEPLOY_MOD_NAME to the build command -- never the assemblies dir. So
# `sts2 --config beta.yaml game deploy --build` compiles against whichever assemblies the MSBuild
# reader found (the STABLE install) and installs that binary into the beta install's mods dir. The
# build succeeds, the deploy succeeds, and the binary is wrong.
#
# This wrapper is the one switch that feeds both resolvers, plus the assertion that the install you
# got is the install you asked for -- because when a configured `game.path` is not a valid install
# root, the CLI silently falls back to Steam autodiscovery and retargets the stable install.
#
# It also pins each branch's `toolchain.dir`. `.sts2/toolchain` here is a symlink to spirectl's
# shared decompile corpus, and `toolchain.dir` defaults to a RELATIVE `.sts2/toolchain` anchored on
# whichever directory the CLI picked -- which under `sts2 --config <file>` is the working
# directory. A branch recovery with no explicit value therefore lands on the shared corpus and
# replaces stable sources with the branch's, invisibly.
#
# Docs: docs/configuration.md "Two game installs on one machine".
# Self-test: scripts/test-with-game-branch.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
registry_root="$repo_root/.sts2/branches"
# The four config files a branch directory links back to the repo root, so the committed baseline
# config, the build profiles, the hooks and the hot-reload project still layer in. `.sts2` is
# gitignored, so nothing a branch directory holds is ever committed.
linked_config_files=(sts2.config.yaml sts2.profiles.yaml sts2.hooks.yaml sts2.hot-reload.yaml)
recorded_identity_name="recorded-release-info.json"

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/with-game-branch.sh list
  scripts/with-game-branch.sh setup <branch> --game-path <dir> [--assemblies-dir <dir>] [--force]
  scripts/with-game-branch.sh <branch> -- <command...>

  list    registered branches, the install each resolves to, and its build identity
  setup   register <branch> against an install root (writes ignored local state only)
  run     select <branch> for one command, feeding BOTH game-install resolvers

  `stable` (or `default`) means the repo root's own sts2.local.yaml -- today's behaviour,
  unchanged. Any other name is a directory under .sts2/branches/ written by `setup`.
EOF
}

die() { printf 'with-game-branch: %s\n' "$1" >&2; exit 1; }
note() { printf 'with-game-branch: %s\n' "$1" >&2; }

is_stable() { [ "$1" = "stable" ] || [ "$1" = "default" ]; }

# A branch name becomes a directory name and an instance name, so keep it boring. Rejecting `.`,
# `..` and anything with a slash is what stops `setup ../../etc` writing outside the registry.
validate_branch_name() {
  case "$1" in
    list|setup|'') die "'$1' is not a usable branch name." ;;
  esac
  if ! printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
    die "branch name '$1' must match [A-Za-z0-9][A-Za-z0-9._-]* (no slashes, no leading dot)."
  fi
  case "$1" in
    *..*) die "branch name '$1' must not contain '..'." ;;
  esac
}

# ------------------------------------------------------------------------------------------------
# Reading config without requiring the CLI.
#
# `yaml_value` is deliberately the same shape as the reader in scripts/build-local-mod.sh: a
# flat key match at any indentation. It shares that script's limitation (a same-named key in
# another block would match first) on purpose -- the point of this wrapper is that the CLI and the
# MSBuild reader agree, so the fallback must read what the MSBuild reader reads.
# ------------------------------------------------------------------------------------------------
yaml_value() { # yaml_value <file> <key>
  [ -f "$1" ] || return 0
  sed -nE "s/^[[:space:]]*${2}[[:space:]]*:[[:space:]]*\"([^\"]*)\"[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${2}[[:space:]]*:[[:space:]]*'([^']*)'[[:space:]]*(#.*)?$/\1/p;
           s/^[[:space:]]*${2}[[:space:]]*:[[:space:]]*([^#[:space:]][^#]*)[[:space:]]*(#.*)?$/\1/p" "$1" \
    | head -n 1 | sed -E 's/[[:space:]]+$//'
}

# `toolchain.dir` cannot go through yaml_value: a bare `dir` key is far too generic to match at any
# indentation, and getting it wrong here points a decompile corpus somewhere expensive. This one
# reads a key from inside ONE top-level block, and stops at the next top-level key.
yaml_block_value() { # yaml_block_value <file> <block> <key>
  [ -f "$1" ] || return 0
  awk -v block="$2" -v key="$3" '
    /^[^[:space:]#]/ { inblock = ($0 ~ "^" block "[[:space:]]*:") ; next }
    inblock && $0 ~ "^[[:space:]]+" key "[[:space:]]*:" {
      sub("^[[:space:]]+" key "[[:space:]]*:[[:space:]]*", "")
      sub(/[[:space:]]*#.*$/, "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      sub(/[[:space:]]+$/, "")
      print; exit
    }
  ' "$1"
}

# Flat "key": "value" out of release_info.json. jq when it is there, sed when it is not; this runs
# on a contributor machine that may have neither jq nor the sts2 CLI installed.
json_field() { # json_field <file> <key>
  [ -f "$1" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$2" '.[$k] // empty | tostring' "$1" 2>/dev/null || true
    return 0
  fi
  tr -d '\n' < "$1" \
    | sed -nE "s/.*\"${2}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p;
               s/.*\"${2}\"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p" \
    | head -n 1
}

# Absolute and normalised for comparison: the PARENT path is resolved physically, the last
# component is left exactly as written and never dereferenced -- the symlink checks below depend on
# still being able to see that a `mods` or `SlayTheSpire2` entry IS a symlink. A path that does not
# exist passes through unchanged.
canonical() { # canonical <path>
  if [ -e "$1" ]; then
    (cd "$(dirname "$1")" >/dev/null 2>&1 && printf '%s/%s\n' "$(pwd -P)" "$(basename "$1")")
  else
    printf '%s\n' "$1"
  fi
}

yaml_quote() { # yaml_quote <value> -- a double-quoted YAML scalar; install paths contain spaces
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# ------------------------------------------------------------------------------------------------
# Branch -> config directory.
# ------------------------------------------------------------------------------------------------
branch_config_dir() { # branch_config_dir <branch>
  if is_stable "$1"; then printf '%s\n' "$repo_root"; else printf '%s/%s\n' "$registry_root" "$1"; fi
}

# Where a branch's decompile corpus belongs. `.sts2/toolchain` in this checkout is a SYMLINK to
# `../../spirectl/.sts2/toolchain/` -- a corpus shared with the spirectl repo, built from the stable
# game -- so it must never be a branch's recovery target. `sts2 project recover` rewrites
# `<toolchain.dir>/decompile/`, and a corpus carries no game-version marker, so a beta recovery
# landing there replaces spirectl's stable sources with beta ones invisibly. ~154 MB, ~20 minutes.
branch_toolchain_dir() { # branch_toolchain_dir <branch>
  printf '%s/.sts2/toolchain-%s\n' "$repo_root" "$1"
}

# The corpus root the CLI would use, given a config dir. `toolchain.dir` is anchored on the config
# directory when it is relative (and its DEFAULT is the relative `.sts2/toolchain`), which is the
# whole hazard: verified by running `project recover` against throwaway configs and watching where
# `<toolchain.dir>/manifests` appeared.
resolved_toolchain_dir() { # resolved_toolchain_dir <config-dir>
  local configured
  configured="$(yaml_block_value "$1/sts2.local.yaml" toolchain dir)"
  if [ -z "$configured" ]; then printf '%s/.sts2/toolchain\n' "$1"; return 0; fi
  case "$configured" in
    /*) printf '%s\n' "$configured" ;;
    *)  printf '%s/%s\n' "$1" "$configured" ;;
  esac
}

require_registered() { # require_registered <branch> -- sets nothing, exits on failure
  local branch="$1" dir
  dir="$(branch_config_dir "$branch")"
  if is_stable "$branch"; then
    [ -f "$dir/sts2.local.yaml" ] || die "no sts2.local.yaml at the repo root; create it with game.path and game.assembliesDir (docs/configuration.md)."
    return 0
  fi
  if [ ! -f "$dir/sts2.local.yaml" ]; then
    die "game branch '$branch' is not registered (expected $dir/sts2.local.yaml).

Register it against that install root first:
  scripts/with-game-branch.sh setup $branch --game-path <install dir>

Registered branches: $(list_branch_names | tr '\n' ' ')stable"
  fi
}

list_branch_names() {
  [ -d "$registry_root" ] || return 0
  local dir
  for dir in "$registry_root"/*/; do
    [ -f "${dir}sts2.local.yaml" ] || continue
    basename "$dir"
  done
}

# ------------------------------------------------------------------------------------------------
# Resolving the install for a branch.
#
# Sets: RES_GAME_PATH RES_ASSEMBLIES_DIR RES_MODS_DIR RES_SOURCE RES_GAME_PATH_SOURCE
# ------------------------------------------------------------------------------------------------
resolve_install() { # resolve_install <config-dir>
  local config_dir="$1" json=""
  RES_GAME_PATH=""; RES_ASSEMBLIES_DIR=""; RES_MODS_DIR=""
  RES_SOURCE="yaml"; RES_GAME_PATH_SOURCE=""

  if command -v sts2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    json="$( (cd "$repo_root" && SPIRECTL_CONFIG_DIR="$config_dir" \
      sts2 --json config resolve gamePath assembliesDir modsDir) 2>/dev/null || true)"
  fi

  if [ -n "$json" ] && printf '%s' "$json" | jq -e . >/dev/null 2>&1; then
    RES_SOURCE="cli"
    RES_GAME_PATH="$(printf '%s' "$json" | jq -r '.gamePath // empty')"
    RES_ASSEMBLIES_DIR="$(printf '%s' "$json" | jq -r '.assembliesDir // empty')"
    RES_MODS_DIR="$(printf '%s' "$json" | jq -r '.modsDir // empty')"
    RES_GAME_PATH_SOURCE="$(printf '%s' "$json" | jq -r '.sources.gamePath // empty')"
    RES_ERRORS="$(printf '%s' "$json" | jq -r '(.errors // []) | map("\(.key): \(.message)") | join("; ")')"
  else
    # No CLI (or no jq): read the same file the MSBuild reader reads. The shipped mod must never
    # require the sts2 CLI, and neither must this.
    RES_ERRORS=""
    RES_GAME_PATH="$(yaml_value "$config_dir/sts2.local.yaml" path)"
    RES_ASSEMBLIES_DIR="$(yaml_value "$config_dir/sts2.local.yaml" assembliesDir)"
    RES_MODS_DIR="$(yaml_value "$config_dir/sts2.local.yaml" modsDir)"
    if [ -z "$RES_MODS_DIR" ] && [ -n "$RES_GAME_PATH" ]; then
      RES_MODS_DIR="$RES_GAME_PATH/mods"
    fi
  fi
  # Explicit: under `set -e` a function whose last command fails takes the whole script down with
  # no message, and "no game.path configured" must reach the assertion below rather than exit here.
  return 0
}

# The `data_sts2_*` directory the CLI would accept: it needs BOTH sts2.dll and GodotSharp.dll. An
# install root missing either one is not an install root as far as the CLI is concerned, which is
# exactly when it falls back to Steam autodiscovery.
find_assemblies_dir() { # find_assemblies_dir <game-path>
  local dir
  for dir in "$1"/data_sts2_*/; do
    [ -d "$dir" ] || continue
    [ -f "${dir}sts2.dll" ] && [ -f "${dir}GodotSharp.dll" ] || continue
    printf '%s\n' "${dir%/}"
    return 0
  done
  return 1
}

identity_line() { # identity_line <release_info.json>
  local version commit branch date
  version="$(json_field "$1" version)"
  commit="$(json_field "$1" commit)"
  branch="$(json_field "$1" branch)"
  date="$(json_field "$1" date)"
  printf '%s commit %s branch %s (%s)' "${version:-?}" "${commit:-?}" "${branch:-?}" "${date:-?}"
}

# ------------------------------------------------------------------------------------------------
# Assertions. This is the point of the script: prove the install you got is the install you asked
# for, BEFORE a build compiles against it or a deploy writes into it.
# ------------------------------------------------------------------------------------------------
assert_install() { # assert_install <branch> <config-dir>
  local branch="$1" config_dir="$2" local_config="$2/sts2.local.yaml"
  local configured

  resolve_install "$config_dir"

  [ -n "$RES_GAME_PATH" ] || die "no game install resolved for branch '$branch' from $local_config${RES_ERRORS:+ ($RES_ERRORS)}.

Set game.path and game.assembliesDir there, or re-run setup with --game-path."

  configured="$(yaml_value "$local_config" path)"
  if [ -n "$configured" ]; then
    if [ "$(canonical "$configured")" != "$(canonical "$RES_GAME_PATH")" ]; then
      die "the install the CLI resolved is NOT the install this branch configures.

  branch '$branch' configures  $configured
  the CLI resolved             $RES_GAME_PATH  (source: ${RES_GAME_PATH_SOURCE:-unknown})

That is the Steam autodiscovery fallback firing: when a configured game.path is not a valid
install root, the CLI quietly resolves a different install instead of failing. A build here would
compile against the wrong assemblies and a deploy would install into the wrong mods dir.

An install root is only valid when it holds a data_sts2_* directory containing BOTH sts2.dll and
GodotSharp.dll. Check that first."
    fi
  fi
  if [ "$RES_GAME_PATH_SOURCE" = "discovered" ]; then
    die "branch '$branch' resolved its install through Steam autodiscovery, not its own config.
Resolved: $RES_GAME_PATH
Set game.path in $local_config to the install you mean."
  fi

  [ -d "$RES_GAME_PATH" ] || die "resolved game path does not exist: $RES_GAME_PATH"
  [ -f "$RES_GAME_PATH/release_info.json" ] \
    || die "no release_info.json under $RES_GAME_PATH -- that is not a game install root, or it is a partial download still in progress."

  local discovered_assemblies
  if ! discovered_assemblies="$(find_assemblies_dir "$RES_GAME_PATH")"; then
    die "no data_sts2_* directory containing both sts2.dll and GodotSharp.dll under $RES_GAME_PATH.
The CLI treats that as 'not an install' and falls back to Steam autodiscovery, so this must be
fixed rather than worked around."
  fi

  [ -n "$RES_ASSEMBLIES_DIR" ] || RES_ASSEMBLIES_DIR="$discovered_assemblies"
  [ -d "$RES_ASSEMBLIES_DIR" ] || die "resolved assemblies dir does not exist: $RES_ASSEMBLIES_DIR"
  [ -f "$RES_ASSEMBLIES_DIR/sts2.dll" ] \
    || die "no sts2.dll in $RES_ASSEMBLIES_DIR -- builds would resolve STS2 references from a directory that has none."
  if [ "$(canonical "$RES_ASSEMBLIES_DIR")" != "$(canonical "$discovered_assemblies")" ]; then
    note "WARNING  configured assembliesDir is not the one under the resolved install:
             configured $RES_ASSEMBLIES_DIR
             install    $discovered_assemblies"
  fi

  # The two symlink traps that make one branch silently drive the other's files. `mods/` shared
  # between installs means each deploy re-points the other (build-local-mod.sh deletes stale
  # top-level DLLs and regenerates hot-reload/ and frontend/ in place). A symlinked game BINARY
  # makes Godot resolve /proc/self/exe to the OTHER install and load its mods/ instead.
  if [ -n "$RES_MODS_DIR" ] && [ -L "$RES_MODS_DIR" ]; then
    die "$RES_MODS_DIR is a SYMLINK. Two installs must never share a mods directory: every deploy
deletes the other install's top-level DLLs and regenerates hot-reload/ and frontend/ in place, so
each branch silently re-points the other. Make it a real directory."
  fi
  local exe
  for exe in SlayTheSpire2 SlayTheSpire2.exe SlayTheSpire2.x86_64; do
    if [ -L "$RES_GAME_PATH/$exe" ]; then
      die "$RES_GAME_PATH/$exe is a SYMLINK. Godot resolves the executable through /proc/self/exe,
which follows symlinks, so the game would treat the OTHER install as its own and load that
install's mods/. Copy or hard-link the binary instead (SlayTheSpire2.pck may stay a symlink)."
    fi
  done

  if [ -z "$RES_MODS_DIR" ]; then
    RES_MODS_DIR="$RES_GAME_PATH/mods"
    note "WARNING  no mods directory resolved; assuming $RES_MODS_DIR"
  elif [ ! -d "$RES_MODS_DIR" ]; then
    note "WARNING  mods directory does not exist yet: $RES_MODS_DIR (a deploy will create it)"
  fi

  # The decompile corpus. Not fatal -- only `project recover` writes one, and refusing every other
  # command over it would be wrong -- but a branch pointed at the shared corpus is the expensive
  # mistake, so say so every time rather than once.
  RES_TOOLCHAIN_DIR="$(resolved_toolchain_dir "$config_dir")"
  RES_TOOLCHAIN_NOTE=""
  if is_stable "$branch"; then
    if [ "$(canonical "$RES_TOOLCHAIN_DIR")" = "$(canonical "$repo_root/.sts2/toolchain")" ]; then
      RES_TOOLCHAIN_NOTE="  (shared with spirectl; correct for stable)"
    fi
  elif [ -z "$(yaml_block_value "$local_config" toolchain dir)" ]; then
    note "WARNING  branch '$branch' sets no toolchain.dir, so a \`project recover\` for it would
             write a second decompile corpus at
               $RES_TOOLCHAIN_DIR
             -- nested inside the branch registry under SPIRECTL_CONFIG_DIR, and landing on
             .sts2/toolchain (spirectl's SHARED corpus) under \`sts2 --config <file>\`. Add
               toolchain:
                 dir: $(branch_toolchain_dir "$branch")
             to $local_config, or re-run setup --force."
  elif [ "$(canonical "$RES_TOOLCHAIN_DIR")" = "$(canonical "$repo_root/.sts2/toolchain")" ]; then
    note "WARNING  branch '$branch' points toolchain.dir at $RES_TOOLCHAIN_DIR, which is the
             corpus SHARED with the spirectl repo and built from the stable game. A
             \`project recover\` here would overwrite it with this branch's sources, with nothing
             in the output saying which game build produced them. Use
               $(branch_toolchain_dir "$branch")"
  fi
}

check_identity_drift() { # check_identity_drift <config-dir> <game-path>
  local recorded="$1/$recorded_identity_name" live="$2/release_info.json"
  [ -f "$recorded" ] || return 0
  [ -f "$live" ] || return 0
  if cmp -s "$recorded" "$live"; then return 0; fi
  note "WARNING  this install's build identity has DRIFTED since setup registered it.
           at setup  $(identity_line "$recorded")
           now       $(identity_line "$live")
           The branch updated. Re-run setup --force to re-record, and expect a rebuild."
}

# ------------------------------------------------------------------------------------------------
# list
# ------------------------------------------------------------------------------------------------
cmd_list() {
  local names name dir gp label
  names="$(printf 'stable\n'; list_branch_names)"
  printf '%-14s %s\n' "BRANCH" "INSTALL"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    dir="$(branch_config_dir "$name")"
    if [ ! -f "$dir/sts2.local.yaml" ]; then
      printf '%-14s %s\n' "$name" "(no sts2.local.yaml at $dir)"
      continue
    fi
    resolve_install "$dir"
    gp="${RES_GAME_PATH:-(unresolved)}"
    label=""
    if [ "$RES_GAME_PATH_SOURCE" = "discovered" ]; then
      label="  [STEAM AUTODISCOVERY -- not this branch's config]"
    fi
    printf '%-14s %s%s\n' "$name" "$gp" "$label"
    if [ -n "$RES_GAME_PATH" ] && [ -f "$RES_GAME_PATH/release_info.json" ]; then
      printf '%-14s   build %s\n' "" "$(identity_line "$RES_GAME_PATH/release_info.json")"
      if [ -f "$dir/$recorded_identity_name" ] \
         && ! cmp -s "$dir/$recorded_identity_name" "$RES_GAME_PATH/release_info.json"; then
        printf '%-14s   drift since setup: %s\n' "" "$(identity_line "$dir/$recorded_identity_name")"
      fi
    else
      printf '%-14s   build (no release_info.json)\n' ""
    fi
    printf '%-14s   config %s\n' "" "$dir"
    printf '%-14s   corpus %s\n' "" "$(resolved_toolchain_dir "$dir")"
  done <<< "$names"
  if command -v sts2 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    printf '\nresolver: sts2 --json config resolve\n'
  else
    printf '\nresolver: sts2.local.yaml (sed fallback; sts2 CLI or jq not installed)\n'
  fi
}

# ------------------------------------------------------------------------------------------------
# setup
# ------------------------------------------------------------------------------------------------
cmd_setup() {
  local branch="${1:-}" game_path="" assemblies_dir="" force=""
  shift || true
  [ -n "$branch" ] || { usage; exit 2; }
  if is_stable "$branch"; then
    die "'$branch' is not registered here -- it IS the repo root's sts2.local.yaml.
Edit $repo_root/sts2.local.yaml to change which install the stable branch means."
  fi
  validate_branch_name "$branch"

  while [ $# -gt 0 ]; do
    case "$1" in
      --game-path) game_path="${2:-}"; shift 2 ;;
      --assemblies-dir) assemblies_dir="${2:-}"; shift 2 ;;
      --force) force=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown setup option '$1'" ;;
    esac
  done

  [ -n "$game_path" ] || die "setup needs --game-path <install dir>."
  [ -d "$game_path" ] || die "--game-path '$game_path' is not a directory."
  game_path="$(canonical "$game_path")"

  [ -f "$game_path/release_info.json" ] \
    || die "no release_info.json under $game_path -- that is not a game install root (a download still in progress looks like this)."

  if [ -z "$assemblies_dir" ]; then
    assemblies_dir="$(find_assemblies_dir "$game_path")" \
      || die "no data_sts2_* directory containing both sts2.dll and GodotSharp.dll under $game_path.
Pass --assemblies-dir explicitly if this install lays them out differently -- but note the CLI
applies the same test to decide whether $game_path is an install at all."
  fi
  [ -d "$assemblies_dir" ] || die "--assemblies-dir '$assemblies_dir' is not a directory."
  assemblies_dir="$(canonical "$assemblies_dir")"
  [ -f "$assemblies_dir/sts2.dll" ] || die "no sts2.dll in $assemblies_dir."

  # Registering a second name for the SAME install is worse than useless: it reads as isolation
  # while both names deploy into one mods directory.
  local stable_path
  stable_path="$(yaml_value "$repo_root/sts2.local.yaml" path)"
  if [ -n "$stable_path" ] && [ "$(canonical "$stable_path")" = "$game_path" ]; then
    die "$game_path is already the 'stable' branch's install (repo root sts2.local.yaml).
Registering a second name for one install gives two names that deploy into the same mods dir."
  fi

  local dir="$registry_root/$branch" toolchain_dir
  toolchain_dir="$(branch_toolchain_dir "$branch")"

  if [ -f "$dir/sts2.local.yaml" ] && [ -z "$force" ]; then
    die "branch '$branch' is already registered at $dir.
Re-run with --force to rewrite it (hand edits to its sts2.local.yaml will be lost)."
  fi

  mkdir -p "$dir"
  # --force rewrites the file from scratch, so a key somebody added by hand -- a different
  # toolchain.dir above all -- is gone. Keep the old file next to it so the loss is recoverable,
  # and say so when the value we are about to write disagrees with what was there.
  local backup=""
  if [ -f "$dir/sts2.local.yaml" ]; then
    backup="$dir/sts2.local.yaml.replaced"
    cp "$dir/sts2.local.yaml" "$backup"
    local previous_toolchain
    previous_toolchain="$(yaml_block_value "$dir/sts2.local.yaml" toolchain dir)"
    if [ -n "$previous_toolchain" ] && [ "$previous_toolchain" != "$toolchain_dir" ]; then
      note "WARNING  --force is replacing a hand-set toolchain.dir:
             was  $previous_toolchain
             now  $toolchain_dir
             Point --game-path at the install that corpus was built from, or edit the new file."
    fi
  fi
  local f
  for f in "${linked_config_files[@]}"; do
    if [ -e "$repo_root/$f" ]; then
      ln -sfn "$repo_root/$f" "$dir/$f"
    else
      note "WARNING  $repo_root/$f does not exist; not linked"
    fi
  done

  cat > "$dir/sts2.local.yaml" <<EOF
# Generated by scripts/with-game-branch.sh setup -- game branch '$branch'.
#
# SPIRECTL_CONFIG_DIR points the whole sts2 config stack at THIS directory, so every sts2
# invocation inside \`with-game-branch.sh $branch -- ...\` reads these paths with no --config flag
# to forget. The repo root's own sts2.local.yaml does NOT layer in: the stack is exactly
# <this dir>/sts2.config.yaml + <this dir>/sts2.local.yaml, and sts2.config.yaml here is a symlink
# back to the committed one. Machine setup the repo root file carries -- game.launchArgs,
# game.disableBackgroundThrottle, tools.gdrePath -- must be copied into this file if this branch
# needs it.
#
# Hand edits survive a normal setup: it refuses to overwrite this file without --force. \`--force\`
# REWRITES IT FROM SCRATCH, so every key added by hand is lost; the previous file is kept beside
# this one as sts2.local.yaml.replaced.
game:
  path: $(yaml_quote "$game_path")
  assembliesDir: $(yaml_quote "$assemblies_dir")

toolchain:
  # ABSOLUTE, and never \`.sts2/toolchain\`. In this checkout \`.sts2/toolchain\` is a SYMLINK to
  # ../../spirectl/.sts2/toolchain/ -- a decompile corpus shared with the spirectl repo, built from
  # the STABLE game. \`sts2 project recover --kind decompile\` rewrites <toolchain.dir>/decompile/,
  # and a corpus records no game version anywhere a reader would notice, so a recovery for this
  # branch landing there would silently replace spirectl's stable sources with this branch's. It is
  # ~154 MB and ~20 minutes to regenerate. Relative values (and the default, \`.sts2/toolchain\`)
  # anchor on whichever directory the CLI picked -- this one under SPIRECTL_CONFIG_DIR, but the
  # WORKING directory under \`--config <file>\`, where the default lands squarely on the shared
  # corpus. An absolute path is the only spelling that is right under both.
  dir: $(yaml_quote "$toolchain_dir")

project:
  # Pinned ABSOLUTE on purpose. sts2 resolves a profile's or hook's relative command, its cwd, and
  # \${profileDir} against the directory holding the profiles/hooks FILE -- which, with the config
  # stack moved here, would be this directory. A symlinked sts2.hooks.yaml therefore loads fine and
  # then resolves \`scripts/probe-...\` to <this dir>/scripts/probe-..., which does not exist.
  # Naming the repo-root files outright puts that base directory back at the repo root.
  profilesFile: $(yaml_quote "$repo_root/sts2.profiles.yaml")
  hooksFile: $(yaml_quote "$repo_root/sts2.hooks.yaml")

instances:
  # Deliberately EMPTY, and do not copy the repo root's \`symlinkUserDataDirs: [couch-coop]\` here.
  # CouchCoop's asset cache lives at user://couch-coop/assets/couchcoop-asset-cache-v<N>, where N is
  # spirectl's AssetPayloadVersion -- there is no game-version component. Sharing that directory
  # between two game branches serves one branch the other's cached bytes.
  symlinkUserDataDirs: []
EOF

  # Redirect rather than `cp`: an install's release_info.json can be mode 755, and a recorded
  # identity that looks executable invites somebody to wonder whether it is.
  cat "$game_path/release_info.json" > "$dir/$recorded_identity_name"

  printf 'registered game branch %s\n' "$branch" >&2
  printf '  config dir   %s\n' "$dir" >&2
  printf '  game path    %s\n' "$game_path" >&2
  printf '  assemblies   %s\n' "$assemblies_dir" >&2
  printf '  corpus       %s\n' "$toolchain_dir" >&2
  printf '  build        %s\n' "$(identity_line "$dir/$recorded_identity_name")" >&2
  printf '  linked       %s\n' "${linked_config_files[*]}" >&2
  if [ -n "$backup" ]; then printf '  replaced     %s\n' "$backup" >&2; fi
  printf '\nrun against it with:\n  scripts/with-game-branch.sh %s -- <command...>\n' "$branch" >&2
}

# ------------------------------------------------------------------------------------------------
# run
# ------------------------------------------------------------------------------------------------
cmd_run() {
  local branch="$1"; shift
  [ "${1:-}" = "--" ] || die "the run form needs a '--' before the command:
  scripts/with-game-branch.sh $branch -- <command...>"
  shift
  [ $# -gt 0 ] || die "no command after '--'."

  is_stable "$branch" || validate_branch_name "$branch"
  require_registered "$branch"

  local config_dir local_config
  config_dir="$(branch_config_dir "$branch")"
  local_config="$config_dir/sts2.local.yaml"

  assert_install "$branch" "$config_dir"
  check_identity_drift "$config_dir" "$RES_GAME_PATH"

  # Feed BOTH resolvers, every time. Half of this set is what closes the deploy-drift trap:
  # `sts2 game deploy --build` inherits the parent environment for the build command but exports
  # only its own SPIRECTL_DEPLOY_* variables, so the assemblies dir has to already be in the
  # environment or the build silently compiles against whatever the MSBuild reader found.
  export SPIRECTL_CONFIG_DIR="$config_dir"
  export STS2_ASSEMBLIES_DIR="$RES_ASSEMBLIES_DIR"
  # MSBuild surfaces environment variables as properties, so this sets the Directory.Build.props
  # property with no -p: flag. Verified: `dotnet msbuild <proj> -getProperty:Sts2AssembliesDir`
  # follows this file with the variable set and the repo root's without it.
  export CouchCoopLocalConfigPath="$local_config"

  # COUCHCOOP_LOCAL_MOD_DIR outranks COUCHCOOP_GAME_MODS_DIR in Directory.Build.props, so setting
  # it from the install would DEFEAT the scratch-dir safety valve every worktree build relies on.
  # An already-set COUCHCOOP_LOCAL_MOD_DIR, or a scratch COUCHCOOP_GAME_MODS_DIR, therefore wins.
  local mod_dir mod_dir_note=""
  if [ -n "${COUCHCOOP_LOCAL_MOD_DIR:-}" ]; then
    mod_dir="$COUCHCOOP_LOCAL_MOD_DIR"; mod_dir_note="  (from COUCHCOOP_LOCAL_MOD_DIR)"
  elif [ -n "${COUCHCOOP_GAME_MODS_DIR:-}" ]; then
    mod_dir="$COUCHCOOP_GAME_MODS_DIR/couchcoop"; mod_dir_note="  (scratch, from COUCHCOOP_GAME_MODS_DIR)"
  else
    mod_dir="$RES_MODS_DIR/couchcoop"
  fi
  export COUCHCOOP_LOCAL_MOD_DIR="$mod_dir"

  # A named instance gives the game its own bridge socket and its own Godot user dir (sts2 passes
  # --user-dir), so two branches never share save state or the asset cache. NOT XDG_DATA_HOME --
  # that redirects far more than the game's user dir. Stable keeps the unnamed default instance.
  local instance_line="(default -- stable)"
  if ! is_stable "$branch"; then
    if [ -n "${SPIRECTL_INSTANCE:-}" ]; then
      instance_line="$SPIRECTL_INSTANCE  (kept from the environment)"
    else
      export SPIRECTL_INSTANCE="$branch"
      instance_line="$branch"
    fi
  fi

  {
    printf 'with-game-branch: branch %s\n' "$branch"
    printf '  config dir   %s\n' "$config_dir"
    printf '  game path    %s\n' "$RES_GAME_PATH"
    printf '  assemblies   %s\n' "$RES_ASSEMBLIES_DIR"
    printf '  mods dir     %s\n' "$RES_MODS_DIR"
    printf '  mod output   %s%s\n' "$mod_dir" "$mod_dir_note"
    printf '  corpus       %s%s\n' "$RES_TOOLCHAIN_DIR" "$RES_TOOLCHAIN_NOTE"
    printf '  instance     %s\n' "$instance_line"
    printf '  build        %s\n' "$(identity_line "$RES_GAME_PATH/release_info.json")"
    printf '  resolved by  %s\n' "$([ "$RES_SOURCE" = "cli" ] && echo 'sts2 --json config resolve' || echo 'sts2.local.yaml (sed fallback; sts2 CLI or jq not installed)')"
  } >&2

  exec "$@"
}

# ------------------------------------------------------------------------------------------------
case "${1:-}" in
  ''|-h|--help) usage; exit "$([ -z "${1:-}" ] && echo 2 || echo 0)" ;;
  list) shift; [ $# -eq 0 ] || die "list takes no arguments."; cmd_list ;;
  setup) shift; cmd_setup "$@" ;;
  # A leading dash is a mistyped flag, not a branch name; saying so beats the missing-'--' error.
  -*) usage; die "unknown option '$1'." ;;
  *) cmd_run "$@" ;;
esac
