#!/usr/bin/env bash
set -euo pipefail

json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-hosted-server.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOTNET_ROLL_FORWARD=Major dotnet build "$repo_root/tests/CouchCoop.Mod.Tests/CouchCoop.Mod.Tests.csproj" --nologo >/dev/stderr
output="$(DOTNET_ROLL_FORWARD=Major dotnet run --project "$repo_root/tests/CouchCoop.Mod.Tests/CouchCoop.Mod.Tests.csproj" --no-build)"

if $json; then
  printf '%s\n' "$output"
else
  echo "validate-hosted-server: ok"
fi
