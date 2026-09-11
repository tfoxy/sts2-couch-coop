#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-no-sts2-cli-runtime.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
patterns="(ProcessStartInfo|ProcessStart|spawn(Sync)?|exec(File)?(Sync)?)\\s*\\([^)]*[\"']sts2(\\.exe)?[\"']|FileName\\s*=\\s*[\"']sts2(\\.exe)?[\"']|\\b(sts2-cli|Sts2Cli)\\b"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

set +e
matches="$(
  cd "$repo_root"
  rg -n "$patterns" src frontend tests \
    --glob '!**/bin/**' \
    --glob '!**/obj/**' \
    --glob '!**/dist/**' \
    --glob '!**/node_modules/**' \
    --glob '!**/playwright-report/**' \
    --glob '!scripts/validate-no-sts2-cli-runtime.sh'
)"
status=$?
set -e

if [[ "$status" -gt 1 ]]; then
  if $json; then
    printf '{"ok":false,"error":'
    json_escape "runtime source scan failed"
    printf '}\n'
  else
    echo "runtime source scan failed" >&2
  fi
  exit "$status"
fi

if [[ -n "$matches" ]]; then
  if $json; then
    printf '{"ok":false,"check":"no-sts2-cli-runtime","patterns":'
    json_escape "$patterns"
    printf ',"matches":'
    json_escape "$matches"
    printf '}\n'
  else
    printf '%s\n' "$matches"
    echo "runtime path contains forbidden sts2 CLI process access" >&2
  fi
  exit 1
fi

if $json; then
  printf '{"ok":true,"check":"no-sts2-cli-runtime","patterns":'
  json_escape "$patterns"
  printf ',"scanned":["src","frontend","tests"]}\n'
else
  echo "no-sts2-cli-runtime: ok"
fi
