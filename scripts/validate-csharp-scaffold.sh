#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
fi

failures=()

check_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    failures+=("missing file: $path")
  fi
}

check_contains() {
  local path="$1"
  local needle="$2"
  if [[ -f "$path" ]] && ! rg -q --fixed-strings "$needle" "$path"; then
    failures+=("$path does not contain: $needle")
  fi
}

check_file "src/CouchCoop.Mod/CouchCoop.Mod.csproj"
check_file "src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj"
check_file "src/CouchCoop.Mod/CouchCoopMod.cs"
check_file "src/CouchCoop.Mod.Loader/CouchCoopModEntry.cs"
check_file "src/CouchCoop.Mod/Protocol/BrowserEnvelope.cs"

check_contains "src/CouchCoop.Mod/CouchCoop.Mod.csproj" "Spirectl.Sts2.csproj"
check_contains "src/CouchCoop.Mod/CouchCoop.Mod.csproj" "EnableSts2LiveHost=true"
check_contains "src/CouchCoop.Mod/CouchCoop.Mod.csproj" "AssemblyName=CouchCoop.Spirectl"
check_contains "src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" "sts2.dll"
check_contains "src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" "GodotSharp.dll"
check_contains "src/CouchCoop.Mod/CouchCoopMod.cs" "Sts2EmbeddableRuntimeFactory.Create"
check_contains "src/CouchCoop.Mod/Protocol/BrowserEnvelope.cs" "System.Text.Json"

if rg -n "\b(Newtonsoft|JsonConvert|JObject|JToken)\b" src >/tmp/couchcoop_newtonsoft_matches.txt; then
  failures+=("Newtonsoft JSON usage found in src")
fi

cli_invocation="(ProcessStartInfo|ProcessStart|spawn(Sync)?|exec(File)?(Sync)?)\\s*\\([^)]*[\"']sts2(\\.exe)?[\"']|FileName\\s*=\\s*[\"']sts2(\\.exe)?[\"']|\\b(sts2-cli|Sts2Cli)\\b"
if rg -n "$cli_invocation" src >/tmp/couchcoop_sts2_cli_matches.txt; then
  failures+=("sts2 CLI invocation string found in src")
fi

if rg -n "sts2-couch-coop-v1|CouchCoopV1" src >/tmp/couchcoop_v1_matches.txt; then
  failures+=("v1 source dependency or copied path found in src")
fi

if rg -n "SpirectlEmbeddingCompatibility|Spirectl\\.BridgeMod\\.Embedding|Spirectl\\.BridgeMod\\.Sts2Host|Spirectl\\.Proto\\.V1|RenderSnapshotRequest|RenderSnapshotResult|RenderActionRequest|RenderAssetBatchRequest" src tests >/tmp/couchcoop_spirectl_compat_matches.txt; then
  failures+=("spirectl compatibility translation usage found in src or tests")
fi

if rg -n --glob '!SpirectlEmbeddedAssemblyBoundaryTests.cs' --glob '!HotReloadInteropTests.cs' "Spirectl\\.Sts2\\.(BridgeRuntime|BridgeRuntimeBootstrap|BridgeRuntimeServices|Core\\.(Artifacts\\.IScreenshotProvider|Combat\\.ICombatPreviewProvider|ConsoleCommands|Debugging|Fixtures|HotReload|Lifecycle|Map\\.IMapDrawingsProvider|Mods|Restore|Scenarios|SceneInspection\\.IRuntimeSceneProvider|Transport)|Live\\.Sts2(RuntimeSceneProvider|ScreenshotProvider|SpineGeometryProbe|PerfReportEnvelope))" src tests >/tmp/couchcoop_bridge_boundary_matches.txt; then
  failures+=("Couch source or tests reference bridge-only shared-runtime APIs")
fi

if $json; then
  if ((${#failures[@]} == 0)); then
    printf '{"ok":true,"failures":[]}\n'
  else
    json_escape() {
      local value="$1"
      value="${value//\\/\\\\}"
      value="${value//\"/\\\"}"
      value="${value//$'\n'/\\n}"
      printf '"%s"' "$value"
    }

    printf '{"ok":false,"failures":['
    for i in "${!failures[@]}"; do
      if ((i > 0)); then
        printf ','
      fi
      json_escape "${failures[$i]}"
    done
    printf ']}\n'
    exit 1
  fi
else
  if ((${#failures[@]} == 0)); then
    printf 'C# scaffold validation passed.\n'
  else
    printf 'C# scaffold validation failed:\n'
    printf ' - %s\n' "${failures[@]}"
    exit 1
  fi
fi
