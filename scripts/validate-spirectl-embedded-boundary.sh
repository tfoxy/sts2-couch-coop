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
  -p:Configuration=Release -p:CouchCoopBuildToLocalMods=false -p:Sts2AssembliesDir="$assemblies_dir" \
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
# The profile default lives in spirectl's project, so a reference that leaves the property out silently builds
# the Full profile. Say so here instead of letting the item-set comparison below pass by accident.
[[ ";$reference_properties;" == *";Sts2Profile=Embedded;"* ]] || {
  echo "Couch project reference does not select spirectl's embedded profile (Sts2Profile=Embedded): $reference_properties" >&2
  exit 1
}

# The premise: the copy Couch ships equals the upstream build of the same profile. The reference's own
# properties, minus its private assembly name, ARE the upstream build's properties; nothing here re-spells them.
reference_args=()
upstream_args=()
IFS=';' read -r -a property_list <<<"$reference_properties"
for property in "${property_list[@]}"; do
  [[ -n "$property" ]] || continue
  reference_args+=("-p:$property")
  [[ "$property" == AssemblyName=* ]] || upstream_args+=("-p:$property")
done

compile_items() {
  DOTNET_ROLL_FORWARD=Major dotnet msbuild "$shared_project" -nologo -getItem:Compile "$@" \
    | jq -r '.Items.Compile[].FullPath' | LC_ALL=C sort
}

# Evaluated Compile items, not artifact sizes: equality of what each build compiles does not depend on a
# tolerance. The identity is the only property the two builds may differ by.
reference_items="$(compile_items "${reference_args[@]}")"
upstream_items="$(compile_items "${upstream_args[@]}")"
embedded_items="$(compile_items -p:EnableSts2LiveHost=true -p:Sts2Profile=Embedded -p:Sts2AssembliesDir="$assemblies_dir")"
full_items="$(compile_items -p:EnableSts2LiveHost=true -p:Sts2Profile=Full -p:Sts2AssembliesDir="$assemblies_dir")"
[[ -n "$reference_items" ]] || {
  echo "the Couch project reference evaluates to no compile items" >&2
  exit 1
}
[[ "$reference_items" == "$upstream_items" ]] || {
  echo "the Couch reference and the upstream build of the same properties compile different sources:" >&2
  diff <(echo "$reference_items") <(echo "$upstream_items") >&2 || true
  exit 1
}
[[ "$reference_items" == "$embedded_items" ]] || {
  echo "the Couch reference does not compile spirectl's embedded profile:" >&2
  diff <(echo "$reference_items") <(echo "$embedded_items") >&2 || true
  exit 1
}
# The embedded profile is a strict trim of the full one: everything it compiles except its own stand-ins is in
# the full profile, and the full profile has files the embedded one leaves out.
dropped_count="$(LC_ALL=C comm -23 <(echo "$full_items") <(echo "$reference_items") | wc -l)"
stand_ins="$(LC_ALL=C comm -13 <(echo "$full_items") <(echo "$reference_items"))"
(( dropped_count > 0 )) || {
  echo "the embedded profile compiles everything the full profile does" >&2
  exit 1
}
if [[ -n "$stand_ins" ]] && grep -vq '/Profiles/Embedded/' <<<"$stand_ins"; then
  echo "the embedded profile compiles sources the full profile does not, outside Profiles/Embedded:" >&2
  grep -v '/Profiles/Embedded/' <<<"$stand_ins" >&2
  exit 1
fi
item_count="$(wc -l <<<"$reference_items")"
full_item_count="$(wc -l <<<"$full_items")"

audit_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-embedded-boundary.XXXXXX")"
trap 'rm -rf "$audit_dir"' EXIT

# Build each identity serially and retain each artifact before the second build changes the shared project's
# output name. The identity changes the DLL by a small fixed amount, so the built sizes are only a sanity check
# on top of the item-set equality above.
DOTNET_ROLL_FORWARD=Major dotnet build "$shared_project" -c Release -m:1 --nologo \
  "${upstream_args[@]}" >/dev/null
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

# The profile is stamped into the assembly as metadata; both artifacts must say they are the embedded one.
profile_stamp() {
  LC_ALL=C grep -aoP 'SpirectlSts2Profile[\x00-\x1f]{1,2}\K(Embedded|Full)' "$1" | head -n 1
}
upstream_profile="$(profile_stamp "$audit_dir/Spirectl.Sts2.dll")"
couch_profile="$(profile_stamp "$audit_dir/CouchCoop.Spirectl.dll")"
[[ "$upstream_profile" == "Embedded" && "$couch_profile" == "Embedded" ]] || {
  echo "built shared-runtime artifacts are not the embedded profile: upstream=$upstream_profile couch=$couch_profile" >&2
  exit 1
}

bridge_dll_bytes="$(stat -c %s "$audit_dir/Spirectl.Sts2.dll")"
couch_dll_bytes="$(stat -c %s "$audit_dir/CouchCoop.Spirectl.dll")"
bridge_pdb_bytes="$(stat -c %s "$audit_dir/Spirectl.Sts2.pdb")"
couch_pdb_bytes="$(stat -c %s "$audit_dir/CouchCoop.Spirectl.pdb")"
size_delta=$(( bridge_dll_bytes > couch_dll_bytes ? bridge_dll_bytes - couch_dll_bytes : couch_dll_bytes - bridge_dll_bytes ))
pdb_size_delta=$(( bridge_pdb_bytes > couch_pdb_bytes ? bridge_pdb_bytes - couch_pdb_bytes : couch_pdb_bytes - bridge_pdb_bytes ))
(( size_delta <= 4096 )) || {
  echo "Couch and upstream embedded-profile DLL sizes diverged unexpectedly: $bridge_dll_bytes vs $couch_dll_bytes" >&2
  exit 1
}
(( pdb_size_delta <= 4096 )) || {
  echo "Couch and upstream embedded-profile PDB sizes diverged: $bridge_pdb_bytes vs $couch_pdb_bytes" >&2
  exit 1
}

if $json; then
  jq -cn \
    --arg projectReference "$reference_path" \
    --arg assemblyName "$assembly_name" \
    --arg profile "$couch_profile" \
    --arg items "$item_count" \
    --arg fullItems "$full_item_count" \
    --arg dropped "$dropped_count" \
    --arg upstreamDllBytes "$bridge_dll_bytes" \
    --arg couchDllBytes "$couch_dll_bytes" \
    --arg upstreamPdbBytes "$bridge_pdb_bytes" \
    --arg couchPdbBytes "$couch_pdb_bytes" \
    '{ok:true, projectReference:$projectReference, assemblyName:$assemblyName, profile:$profile, compileItems:($items|tonumber), fullProfileCompileItems:($fullItems|tonumber), droppedFromFullProfile:($dropped|tonumber), upstreamDllBytes:($upstreamDllBytes|tonumber), couchDllBytes:($couchDllBytes|tonumber), upstreamPdbBytes:($upstreamPdbBytes|tonumber), couchPdbBytes:($couchPdbBytes|tonumber), defaultNamedRuntimeInCouchOutput:false}'
else
  echo "validate-spirectl-embedded-boundary: ok"
fi
