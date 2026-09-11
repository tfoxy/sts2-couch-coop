#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-forbidden-patterns.sh [--json]" >&2
  exit 2
fi

repo_root="${COUCHCOOP_VALIDATE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
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

collect_matches() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  local rg_status

  set +e
  matches="$(rg -n "$pattern" "$@" \
    --glob '!**/bin/**' \
    --glob '!**/obj/**' \
    --glob '!**/node_modules/**' \
    --glob '!**/dist/**' \
    --glob '!**/test-results/**' \
    --glob '!**/playwright-report/**' \
    --glob '!scripts/validate-forbidden-patterns.sh')"
  rg_status=$?
  set -e

  if [[ $rg_status -gt 1 ]]; then
    printf '%s\n' "$matches" >&2
    exit "$rg_status"
  fi

  if [[ -n "$matches" ]]; then
    failures+=("$label: $matches")
  fi
}

collect_tracked_matches() {
  local label="$1"
  local pattern="$2"
  local matches
  local rg_status

  set +e
  matches="$(git grep -nI -E -e "$pattern" --)"
  rg_status=$?
  set -e

  if [[ $rg_status -gt 1 ]]; then
    printf '%s\n' "$matches" >&2
    exit "$rg_status"
  fi

  if [[ -n "$matches" ]]; then
    failures+=("$label: $matches")
  fi
}

cd "$repo_root"

collect_matches "Vue Router usage" "Vue Router|vue-router" frontend src tests
collect_matches "ASP.NET/Kestrel hosting usage" "Kestrel|WebApplication|AspNetCore|Microsoft\\.AspNetCore|HttpListener" src tests
# Reject an executable CLI dependency, not prose that names the game/tool or a local `sts2` variable.
collect_matches "sts2 CLI runtime invocation" "(ProcessStartInfo|ProcessStart|spawn(Sync)?|exec(File)?(Sync)?)\\s*\\([^)]*[\\\"']sts2(\\.exe)?[\\\"']|\\b(sts2-cli|Sts2Cli)\\b" src frontend tests
# A generic card-play term occurs in game-facing tests. Only dedicated screen renderer scaffold is forbidden.
collect_matches "screen-specific gameplay renderer scaffold" "\\b(class|interface|record|struct)\\s+(CombatRenderer|MapRenderer|NeowRenderer|LobbyRenderer|RewardRenderer|ShopRenderer|RestRenderer|EventRenderer|GameplayAction|ActionRenderer)\\b" src frontend tests
# `\\b` keeps `.webm` distinct from the shipped `.webmanifest` PWA resources.
collect_matches "generated asset artifact reference" "__sts2_assets__|(^|/)(screenshots|playwright-report|test-results)/|\\.webm\\b|trace\\.zip\\b" src frontend tests

# Published source and docs must never embed the developer's checkout, home, or observed local install layout.
# Build the patterns from fragments so this policy file is not itself a forbidden example.
developer_home_prefix="/home/"
developer_home_account="user"
local_editor_prefix="/opt/"
local_editor_name="Godot"
steam_dir="\\.steam/"
steam_client="steam"
collect_tracked_matches \
  "machine-specific developer path" \
  "${developer_home_prefix}${developer_home_account}(/|$)|${local_editor_prefix}${local_editor_name}|${steam_dir}${steam_client}"

set +e
unignored_artifacts="$(git ls-files --cached --others --exclude-standard \
  | rg -n '(^|/)(__sts2_assets__|screenshots|playwright-report|test-results|dist|node_modules)(/|$)|\.(dll|webm|mp4|trace|zip)$')"
artifact_status=$?
set -e

if [[ $artifact_status -gt 1 ]]; then
  printf '%s\n' "$unignored_artifacts" >&2
  exit "$artifact_status"
fi

if [[ -n "$unignored_artifacts" ]]; then
  failures+=("generated asset artifacts are not ignored: $unignored_artifacts")
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
    echo "validate-forbidden-patterns: ok"
  else
    printf 'forbidden pattern validation failed:\n'
    printf ' - %s\n' "${failures[@]}"
    exit 1
  fi
fi
