#!/usr/bin/env bash
set -euo pipefail

# Runs the CouchCoop.MirrorProtocol Exe test runner (SceneModel reader/applier, envelopes, join model, global
# transform index, wire-fixture parity). The library + its tests are game-assembly-FREE (they opt out of
# Sts2AssembliesDir), so this validates on a clean machine with no sts2.local.yaml present.
json=false
if [[ "${1:-}" == "--json" ]]; then
  json=true
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/validate-mirror-protocol.sh [--json]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
proj="$repo_root/tests/CouchCoop.MirrorProtocol.Tests/CouchCoop.MirrorProtocol.Tests.csproj"
DOTNET_ROLL_FORWARD=Major dotnet build "$proj" --nologo >/dev/stderr
output="$(DOTNET_ROLL_FORWARD=Major dotnet run --project "$proj" --no-build)"

if $json; then
  printf '%s\n' "$output"
else
  echo "validate-mirror-protocol: ok"
fi
