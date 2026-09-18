#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-artifacts.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gitignore="$repo_root/.gitignore"
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

check_ignored() {
  local path="$1"
  local label="$2"
  local probe="$path"

  # A round worktree links frontend/node_modules to the primary checkout. Git refuses to walk a path beneath a
  # symlink, even when the symlink itself is correctly ignored by the shared worktree exclude.
  if [[ "$path" == frontend/node_modules/* && -L "$repo_root/frontend/node_modules" ]]; then
    probe="frontend/node_modules"
  fi

  if ! git -C "$repo_root" check-ignore -q "$probe"; then
    failures+=(".gitignore does not ignore $label ($path)")
  fi
}

if [[ ! -f "$gitignore" ]]; then
  failures+=("missing .gitignore")
else
  check_ignored ".sts2/probe.json" ".sts2 artifacts"
  check_ignored ".sts2/artifacts/pc-lobby-qr-overlay/lobby.png" "QR overlay scenario screenshot"
  check_ignored ".sts2/artifacts/pc-lobby-qr-overlay/result.json" "QR overlay scenario structured evidence"
  check_ignored ".sts2/artifacts/pc-lobby-qr-overlay/generated-qr.png" "generated QR image artifacts"
  check_ignored "sts2.local.yaml" "local STS2 config"
  check_ignored "__sts2_assets__/asset.png" "generated STS2 assets"
  check_ignored "screenshots/browser.png" "screenshots"
  check_ignored ".sts2/baselines/pc.png" "visual baselines"
  check_ignored "game-dlls/sts2.dll" "copied STS2 DLLs"
  check_ignored "game-dlls/GodotSharp.dll" "copied Godot DLLs"
  check_ignored "src/CouchCoop.Mod/bin/Debug/out.txt" "C# bin output"
  check_ignored "src/CouchCoop.Mod/obj/project.assets.json" "C# obj output"
  check_ignored "dist/index.html" "root dist output"
  check_ignored "frontend/dist/index.html" "frontend dist output"
  check_ignored "node_modules/.package-lock.json" "root node_modules"
  check_ignored "frontend/node_modules/.package-lock.json" "frontend node_modules"
  check_ignored "frontend/test-results/smoke/error-context.md" "Playwright test results"
  check_ignored "frontend/playwright-report/index.html" "Playwright report"
  check_ignored "frontend/playwright-traces/smoke.zip" "Playwright traces"
  check_ignored "frontend/playwright-videos/smoke.webm" "Playwright videos"
  check_ignored "frontend/playwright-screenshots/smoke.png" "Playwright screenshots"
  check_ignored ".ci-artifacts/iphone-webkit/result.json" "staged synthetic iPhone diagnostics"
  check_ignored ".tmp/validate.log" "temporary files"
  check_ignored "logs/validate.log" "log directory"
  check_ignored "debug.log" "log files"
fi

if $json; then
  if ((${#failures[@]} == 0)); then
    printf '{"ok":true,"failures":[]}\n'
  else
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
    echo "validate-artifacts: ok"
  else
    printf 'artifact validation failed:\n'
    printf ' - %s\n' "${failures[@]}"
    exit 1
  fi
fi
