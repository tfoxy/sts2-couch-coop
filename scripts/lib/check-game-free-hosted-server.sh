#!/usr/bin/env bash
# Compile against reference-only game assemblies; the harness must run without GodotSharp at runtime.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sdk_root="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-hosted-reference.XXXXXX")"
trap 'rm -rf "$sdk_root"' EXIT
cd "$repo_root"

# Pin the lane for both builds so an installed game's release_info.json cannot select another API.
dotnet build eng/Sts2.ReferenceSdk/public-beta/Sts2.ReferenceSdk.public-beta.csproj \
  -c Release -o "$sdk_root/public-beta" -p:RestoreLockedMode=true \
  -p:Sts2GameApi=v111 -p:CouchCoopBuildToLocalMods=false
DOTNET_ROLL_FORWARD="${DOTNET_ROLL_FORWARD:-Major}" \
  dotnet run --project tests/CouchCoop.HostedServerHarness -c Release \
  -p:Sts2AssembliesDir="$sdk_root/public-beta" -p:Sts2GameApi=v111 \
  -p:CouchCoopBuildToLocalMods=false -- --mode iphone-burst-self-test
