#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\b'/\\b}"
  value="${value//$'\f'/\\f}"
  value="${value//$'\e'/\\u001b}"
  printf '"%s"' "$value"
}

checks=(
  "dotnet-build|dotnet build"
  "frontend-test|npm --prefix frontend test"
  "frontend-e2e-smoke|npm --prefix frontend run test:e2e -- smoke"
  "validate-build-config|scripts/validate-build-config.sh --json"
  "validate-csharp-scaffold|scripts/validate-csharp-scaffold.sh --json"
  "validate-frontend-static|scripts/validate-frontend-static.sh --json"
  "validate-hosted-server|scripts/validate-hosted-server.sh --json"
  "validate-mirror-protocol|scripts/validate-mirror-protocol.sh --json"
  "hot-reload-dev-loop|scripts/probe-hot-reload-dev-loop.sh --json"
  "validate-no-sts2-cli-runtime|scripts/validate-no-sts2-cli-runtime.sh --json"
  "validate-artifacts|scripts/validate-artifacts.sh --json"
  "test-validate-forbidden-patterns|scripts/test-validate-forbidden-patterns.sh"
  "validate-forbidden-patterns|scripts/validate-forbidden-patterns.sh --json"
)

names=()
commands=()
statuses=()
outputs=()
ok=true

for check in "${checks[@]}"; do
  name="${check%%|*}"
  command="${check#*|}"
  output_path="$tmp_dir/$name.log"

  set +e
  (
    cd "$repo_root"
    bash -lc "$command"
  ) >"$output_path" 2>&1
  status=$?
  set -e

  output="$(cat "$output_path")"
  names+=("$name")
  commands+=("$command")
  statuses+=("$status")
  outputs+=("$output")

  if [[ $status -ne 0 ]]; then
    ok=false
  fi

  if ! $json; then
    if [[ $status -eq 0 ]]; then
      printf '%s: ok\n' "$name"
    else
      printf '%s: failed\n%s\n' "$name" "$output" >&2
    fi
  fi
done

if $json; then
  printf '{"ok":'
  if $ok; then
    printf 'true'
  else
    printf 'false'
  fi
  printf ',"checks":['
  for i in "${!names[@]}"; do
    if ((i > 0)); then
      printf ','
    fi
    printf '{"name":'
    json_escape "${names[$i]}"
    printf ',"command":'
    json_escape "${commands[$i]}"
    printf ',"ok":'
    if [[ "${statuses[$i]}" -eq 0 ]]; then
      printf 'true'
    else
      printf 'false'
    fi
    printf ',"exitCode":%s,"output":' "${statuses[$i]}"
    json_escape "${outputs[$i]}"
    printf '}'
  done
  printf ']}\n'
fi

if ! $ok; then
  exit 1
fi
