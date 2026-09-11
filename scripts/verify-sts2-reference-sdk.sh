#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_dir="$repo_root/eng/Sts2.ReferenceSdk"
project="$sdk_dir/Sts2.ReferenceSdk.csproj"
lockfile="$sdk_dir/packages.lock.json"

[[ -f "$project" && -f "$lockfile" ]] || {
  echo "STS2 reference SDK audit inputs are missing" >&2
  exit 1
}

grep -Fq 'Version="[0.107.0-beta]"' "$project" || {
  echo "STS2 reference package must use the reviewed exact version" >&2
  exit 1
}
[[ "$(grep -Fc 'ExcludeAssets="all"' "$project")" == "2" ]] || {
  echo "all reference SDK packages must exclude automatic NuGet assets" >&2
  exit 1
}
[[ "$(grep -Fc 'PrivateAssets="all"' "$project")" == "2" ]] || {
  echo "all reference SDK packages must remain private build inputs" >&2
  exit 1
}

jq -e '
  .version == 1
  and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].type == "Direct"
  and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].requested == "[0.107.0-beta, 0.107.0-beta]"
  and .dependencies["net9.0"]["FuYnAloft.Sts2.References"].resolved == "0.107.0-beta"
  and (.dependencies["net9.0"]["FuYnAloft.Sts2.References"].contentHash | type == "string" and length > 0)
  and .dependencies["net9.0"].GodotSharp.type == "Direct"
  and .dependencies["net9.0"].GodotSharp.requested == "[4.5.1, 4.5.1]"
  and .dependencies["net9.0"].GodotSharp.resolved == "4.5.1"
  and (.dependencies["net9.0"].GodotSharp.contentHash | type == "string" and length > 0)
' "$lockfile" >/dev/null || {
  echo "STS2 reference SDK lockfile does not match the reviewed inputs" >&2
  exit 1
}

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-reference-sdk.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

DOTNET_ROLL_FORWARD=Major dotnet restore "$project" --locked-mode
DOTNET_ROLL_FORWARD=Major dotnet build "$project" --no-restore \
  -c Release -o "$work_dir" -p:ContinuousIntegrationBuild=true \
  -p:DebugSymbols=false -p:DebugType=None

expected="$work_dir/expected.txt"
actual="$work_dir/actual.txt"
printf '%s\n' \
  0Harmony.dll \
  CouchCoop.Sts2.ReferenceSdk.dll \
  GodotSharp.dll \
  MonoMod.Backports.dll \
  MonoMod.ILHelpers.dll \
  Sentry.dll \
  SmartFormat.dll \
  SmartFormat.ZString.dll \
  Steamworks.NET.dll \
  sts2.dll | LC_ALL=C sort > "$expected"
find "$work_dir" -maxdepth 1 -type f -name '*.dll' -printf '%f\n' | LC_ALL=C sort > "$actual"
diff -u "$expected" "$actual" || {
  echo "STS2 reference SDK output does not match the reviewed assembly allowlist" >&2
  exit 1
}

echo "verify-sts2-reference-sdk: ok (FuYnAloft.Sts2.References 0.107.0-beta)"
