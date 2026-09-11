#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/probe-hot-reload-dev-loop.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ok=true
checks=()
failures=()

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

add_check() {
  local name="$1"
  local status="$2"
  local detail="$3"

  checks+=("$name|$status|$detail")
  if [[ "$status" != "ok" ]]; then
    ok=false
    failures+=("$name: $detail")
    if ! $json; then
      printf '%s: failed: %s\n' "$name" "$detail" >&2
    fi
  elif ! $json; then
    printf '%s: ok\n' "$name"
  fi
}

require_file() {
  local path="$1"
  local name="$2"

  if [[ -f "$path" ]]; then
    add_check "$name" ok "$path exists"
  else
    add_check "$name" failed "$path is missing"
  fi
}

require_executable() {
  local path="$1"
  local name="$2"

  if [[ -x "$path" ]]; then
    add_check "$name" ok "$path is executable"
  else
    add_check "$name" failed "$path is not executable"
  fi
}

require_pattern() {
  local path="$1"
  local pattern="$2"
  local name="$3"
  local detail="$4"

  if rg -q -- "$pattern" "$path"; then
    add_check "$name" ok "$detail"
  else
    add_check "$name" failed "$detail"
  fi
}

require_file "frontend/package.json" "frontend_package"
require_file "frontend/vite.config.ts" "vite_config"
require_file "sts2.hot-reload.yaml" "hot_reload_yaml"
require_file "sts2.profiles.yaml" "profiles_yaml"
require_file "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" "loader_protocol_source"
require_file "src/CouchCoop.Mod.Loader/CouchCoopModEntry.HotReload.cs" "loader_hot_reload_initializer"
require_file "src/CouchCoop.Mod.HotReload/CouchCoopHotLogic.cs" "hot_reload_logic_source"

require_pattern "frontend/package.json" '"dev": "vite --host 127\.0\.0\.1"' "frontend_dev_script" "dev script must bind Vite to loopback"
require_pattern "frontend/package.json" '"build:watch": "vite build --watch"' "frontend_build_watch_script" "build:watch must rebuild static SPA output"
require_pattern "frontend/package.json" '"test": "vitest run"' "frontend_vitest_script" "frontend test script must remain available"
require_pattern "frontend/package.json" '"test:e2e": "playwright test"' "frontend_playwright_script" "frontend e2e script must remain available"

require_pattern "frontend/vite.config.ts" 'host: "127\.0\.0\.1"' "vite_loopback_host" "Vite server host must be loopback-only"
require_pattern "frontend/vite.config.ts" 'COUCHCOOP_DEV_PROXY_TARGET' "vite_proxy_target_env" "Vite proxy target must be configurable"
require_pattern "frontend/vite.config.ts" 'http://127\.0\.0\.1:13337' "vite_default_proxy_target" "Vite proxy must default to local CouchCoop browser server"
require_pattern "frontend/vite.config.ts" 'loopbackHosts' "vite_loopback_guard" "Vite proxy must validate loopback hosts"
require_pattern "frontend/vite.config.ts" '"/ws"' "vite_ws_proxy" "Vite must proxy same-origin /ws"
require_pattern "frontend/vite.config.ts" 'ws: true' "vite_ws_upgrade_proxy" "Vite /ws proxy must support WebSocket upgrades"
require_pattern "frontend/vite.config.ts" '"/res"' "vite_res_proxy" "Vite must proxy same-origin /res"
require_pattern "frontend/vite.config.ts" 'strict: true' "vite_fs_strict" "Vite dev server filesystem access must stay strict"
require_pattern "frontend/vite.config.ts" 'COUCHCOOP_FRONTEND_OUT_DIR' "vite_out_dir_env" "Static build output must support explicit deploy output override"
require_pattern "frontend/vite.config.ts" 'sts2.local.yaml' "vite_local_config_out_dir" "Static build output must read local STS2 config when present"
require_pattern "frontend/vite.config.ts" 'modsDir' "vite_mods_dir_out_dir" "Static build output must support game.modsDir"
require_pattern "frontend/vite.config.ts" 'couchcoop/frontend' "vite_deployed_frontend" "Static build output must target deployed mod frontend"
require_pattern "frontend/vite.config.ts" 'emptyOutDir: true' "vite_static_empty_out_dir" "Static build output must replace stale assets"
require_pattern "frontend/vite.config.ts" 'assetsDir: "app"' "vite_static_assets_dir" "Static build output must place built assets under app/"

require_pattern "sts2.hot-reload.yaml" 'schemaVersion: spirectl\.hot-reload-project/v0' "hot_reload_schema" "Hot-reload project schema must match spirectl v0"
require_pattern "sts2.hot-reload.yaml" 'projectId: couchcoop' "hot_reload_project_id" "Hot-reload project id must be couchcoop"
require_pattern "sts2.hot-reload.yaml" 'shellModId: couchcoop' "hot_reload_shell_mod_id" "Hot-reload shell mod id must be couchcoop"
require_pattern "sts2.hot-reload.yaml" 'logicProject: CouchCoop\.Mod\.HotReload' "hot_reload_logic_project" "Hot-reload logic project must be CouchCoop.Mod.HotReload"
require_pattern "sts2.hot-reload.yaml" 'logicArtifactPath: \$\{profileDir\}/\.sts2/hot-reload/CouchCoop\.Mod\.HotReload\.dll' "hot_reload_logic_artifact" "Hot-reload logic artifact path must stay under .sts2/hot-reload"
require_pattern "sts2.hot-reload.yaml" 'expectedContractVersion: 1' "hot_reload_contract_version" "Hot-reload expected contract version must be stable"
require_pattern "sts2.hot-reload.yaml" 'id: spirectl\.m57\.hot-reload-shell' "hot_reload_protocol_id" "Hot-reload protocol id must match spirectl shell"
require_pattern "sts2.hot-reload.yaml" 'version: 0' "hot_reload_protocol_version" "Hot-reload protocol version must match spirectl v0"

require_pattern "sts2.profiles.yaml" 'couchcoop-hot-reload-build:' "profiles_hot_reload_build" "Hot-reload build profile must exist"
require_pattern "sts2.profiles.yaml" 'src/CouchCoop\.Mod\.HotReload/CouchCoop\.Mod\.HotReload\.csproj' "profiles_logic_project_build" "Hot-reload profile must build only reloadable logic project"
require_pattern "sts2.profiles.yaml" '-p:HotReloadDeployDir=\$\{profileDir\}/\.sts2/hot-reload' "profiles_hot_reload_deploy_dir" "Hot-reload profile must deploy logic artifact under .sts2/hot-reload"

require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'ProtocolId = "spirectl\.m57\.hot-reload-shell"' "loader_protocol_id" "Loader protocol id must match project YAML"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'ProtocolVersion = 0' "loader_protocol_version" "Loader protocol version must match spirectl v0"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'ContractVersion = 1' "loader_contract_version" "Loader contract version must remain independent from protocol version"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'LogicAssemblyName = "CouchCoop\.Mod\.HotReload"' "loader_logic_assembly" "Loader must target the reloadable logic assembly"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'LogicTypeName = "CouchCoop\.Mod\.HotReload\.CouchCoopHotLogic"' "loader_logic_type" "Loader must target the reloadable logic type"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'LayoutMethodName = "DescribeOverlayLayoutJson"' "loader_layout_method" "Loader must call the reloadable layout method"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'CreateGenerationMethodName = "CreateGeneration"' "loader_generation_method" "Loader must call the reloadable server generation method"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'reload_contract_version_mismatch' "loader_restart_required_report" "Loader must report restart-required contract mismatches"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoopHotReloadProtocol.cs" 'RefreshQrHostPanelLayout' "loader_refresh_bridge" "Loader must refresh the installed QR host panels after successful reload"
require_pattern "src/CouchCoop.Mod.Loader/CouchCoop.Mod.Loader.csproj" 'CouchCoopEnableHotReload' "loader_hot_reload_compile_gate" "Loader must compile the hot-reload protocol only for local builds"

require_pattern "src/CouchCoop.Mod.HotReload/CouchCoopHotLogic.cs" 'public static string DescribeOverlayLayoutJson\(\)' "logic_layout_entrypoint" "Reloadable logic must expose layout entrypoint"
require_pattern "src/CouchCoop.Mod.HotReload/CouchCoopHotLogic.cs" 'CreateGeneration' "logic_generation_entrypoint" "Reloadable logic must expose server generation entrypoint"
require_pattern "src/CouchCoop.Mod.HotReload/CouchCoopHotLogic.cs" 'CouchCoopOverlayLayout' "logic_layout_dto" "Reloadable logic must return QR overlay layout data"

for command in \
  'npm --prefix frontend run dev' \
  'npm --prefix frontend run build:watch' \
  'sts2 --mode dev --json dev mod-reload --project \. --build --wait'; do
  require_pattern "docs/configuration.md" "$command" "configuration_command_$command" "configuration docs must document $command"
done

require_executable "scripts/probe-hot-reload-dev-loop.sh" "probe_executable"

if $json; then
  printf '{"ok":'
  if $ok; then
    printf 'true'
  else
    printf 'false'
  fi
  printf ',"checks":['
  for i in "${!checks[@]}"; do
    IFS='|' read -r name status detail <<<"${checks[$i]}"
    if ((i > 0)); then
      printf ','
    fi
    printf '{"name":'
    json_escape "$name"
    printf ',"ok":'
    if [[ "$status" == "ok" ]]; then
      printf 'true'
    else
      printf 'false'
    fi
    printf ',"detail":'
    json_escape "$detail"
    printf '}'
  done
  printf '],"failures":['
  for i in "${!failures[@]}"; do
    if ((i > 0)); then
      printf ','
    fi
    json_escape "${failures[$i]}"
  done
  printf ']}\n'
fi

if ! $ok; then
  exit 1
fi
