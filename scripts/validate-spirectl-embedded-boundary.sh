#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/validate-spirectl-embedded-boundary.sh [--json]" >&2
}

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -ne 0 ]]; then
  usage
  exit 2
fi

[[ -n "${COUCHCOOP_GAME_MODS_DIR:-}" ]] || {
  echo "COUCHCOOP_GAME_MODS_DIR must point at a scratch mod directory" >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spirectl_root="$(cd "$repo_root/../spirectl" && pwd)"
shared_project="$spirectl_root/bridge-mod/src/Spirectl.Sts2/Spirectl.Sts2.csproj"
mod_project="$repo_root/src/CouchCoop.Mod/CouchCoop.Mod.csproj"
shared_output_dir="$spirectl_root/bridge-mod/src/Spirectl.Sts2/bin/Release/net9.0"
mod_output_dir="$repo_root/src/CouchCoop.Mod/bin/Release/net9.0"

[[ -f "$shared_project" && -f "$mod_project" ]] || {
  echo "missing Couch or spirectl project" >&2
  exit 1
}

assemblies_dir="${STS2_ASSEMBLIES_DIR:-}"
if [[ -z "$assemblies_dir" && -f "$repo_root/sts2.local.yaml" ]]; then
  assemblies_dir="$(sed -nE "s/^[[:space:]]*assembliesDir:[[:space:]]*['\"]?([^#'\"]+)['\"]?[[:space:]]*(#.*)?$/\\1/p" "$repo_root/sts2.local.yaml" | head -n 1 | xargs)"
fi
[[ -n "$assemblies_dir" && -d "$assemblies_dir" ]] || {
  echo "set STS2_ASSEMBLIES_DIR or configure game.assembliesDir in sts2.local.yaml" >&2
  exit 2
}

# MSBuild owns the project-reference path after property expansion. Do not replace this with a source-text
# check: a sibling worktree or a property override can change the effective reference without changing the XML.
metadata="$(DOTNET_ROLL_FORWARD=Major dotnet msbuild "$mod_project" -nologo \
  -p:Configuration=Release -p:CouchCoopBuildToLocalMods=false \
  -getProperty:AssemblyName -getItem:ProjectReference)"
reference_path="$(jq -er '.Items.ProjectReference[] | select(.FullPath | endswith("Spirectl.Sts2.csproj")) | .FullPath' <<<"$metadata")"
reference_properties="$(jq -er '.Items.ProjectReference[] | select(.FullPath | endswith("Spirectl.Sts2.csproj")) | .AdditionalProperties' <<<"$metadata")"
assembly_name="$(jq -er '.Properties.AssemblyName' <<<"$metadata")"
[[ "$(realpath "$reference_path")" == "$(realpath "$shared_project")" ]] || {
  echo "Couch project reference does not resolve to this spirectl checkout: $reference_path" >&2
  exit 1
}
[[ "$assembly_name" == "CouchCoop.Mod" && "$reference_properties" == *"AssemblyName=CouchCoop.Spirectl"* ]] || {
  echo "Couch project reference is missing its private shared-runtime identity" >&2
  exit 1
}

audit_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-embedded-boundary.XXXXXX")"
trap 'rm -rf "$audit_dir"' EXIT

# Build each identity serially and retain each artifact before the second build changes the shared project's
# output name. Identity metadata changes the DLL by a small fixed amount, so compare size rather than bytes.
DOTNET_ROLL_FORWARD=Major dotnet build "$shared_project" -c Release -m:1 --nologo \
  -p:EnableSts2LiveHost=true -p:Sts2AssembliesDir="$assemblies_dir" >/dev/null
cp "$shared_output_dir/Spirectl.Sts2.dll" "$audit_dir/Spirectl.Sts2.dll"
cp "$shared_output_dir/Spirectl.Sts2.pdb" "$audit_dir/Spirectl.Sts2.pdb"

DOTNET_ROLL_FORWARD=Major dotnet build "$mod_project" -c Release -m:1 --nologo \
  -p:CouchCoopBuildToLocalMods=false -p:Sts2AssembliesDir="$assemblies_dir" >/dev/null
cp "$shared_output_dir/CouchCoop.Spirectl.dll" "$audit_dir/CouchCoop.Spirectl.dll"
cp "$shared_output_dir/CouchCoop.Spirectl.pdb" "$audit_dir/CouchCoop.Spirectl.pdb"

if [[ ! -f "$mod_output_dir/CouchCoop.Spirectl.dll" || -e "$mod_output_dir/Spirectl.Sts2.dll" ]] \
  || find "$mod_output_dir" -maxdepth 1 -type f -name 'Spirectl.BridgeMod*.dll' -print -quit | grep -q .; then
  echo "Couch output has the wrong shared-runtime artifact identity" >&2
  exit 1
fi

bridge_dll_bytes="$(stat -c %s "$audit_dir/Spirectl.Sts2.dll")"
couch_dll_bytes="$(stat -c %s "$audit_dir/CouchCoop.Spirectl.dll")"
bridge_pdb_bytes="$(stat -c %s "$audit_dir/Spirectl.Sts2.pdb")"
couch_pdb_bytes="$(stat -c %s "$audit_dir/CouchCoop.Spirectl.pdb")"
size_delta=$(( bridge_dll_bytes > couch_dll_bytes ? bridge_dll_bytes - couch_dll_bytes : couch_dll_bytes - bridge_dll_bytes ))
pdb_size_delta=$(( bridge_pdb_bytes > couch_pdb_bytes ? bridge_pdb_bytes - couch_pdb_bytes : couch_pdb_bytes - bridge_pdb_bytes ))
(( size_delta <= 4096 )) || {
  echo "Couch and bridge shared-runtime DLL sizes diverged unexpectedly: $bridge_dll_bytes vs $couch_dll_bytes" >&2
  exit 1
}
(( pdb_size_delta <= 4096 )) || {
  echo "Couch and bridge shared-runtime PDB sizes diverged: $bridge_pdb_bytes vs $couch_pdb_bytes" >&2
  exit 1
}

if $json; then
  jq -cn \
    --arg projectReference "$reference_path" \
    --arg assemblyName "$assembly_name" \
    --arg bridgeDllBytes "$bridge_dll_bytes" \
    --arg couchDllBytes "$couch_dll_bytes" \
    --arg bridgePdbBytes "$bridge_pdb_bytes" \
    --arg couchPdbBytes "$couch_pdb_bytes" \
    '{ok:true, projectReference:$projectReference, assemblyName:$assemblyName, bridgeDllBytes:($bridgeDllBytes|tonumber), couchDllBytes:($couchDllBytes|tonumber), bridgePdbBytes:($bridgePdbBytes|tonumber), couchPdbBytes:($couchPdbBytes|tonumber), defaultNamedRuntimeInCouchOutput:false}'
else
  echo "validate-spirectl-embedded-boundary: ok"
fi
