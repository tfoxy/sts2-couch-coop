#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$root/scripts/validate-macos-iphone-workflow.sh"
workflow="$root/.github/workflows/macos-check.yml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

run_validator() {
  COUCHCOOP_WORKFLOW_PATH="$1" bash "$validator" 2>&1
}

expect_reject() {
  label="$1"
  path="$2"
  expected="$3"
  if output="$(run_validator "$path")"; then
    echo "expected $label workflow fixture to fail" >&2
    exit 1
  fi
  printf '%s\n' "$output" | grep -Fq "$expected" || {
    echo "missing $label diagnostic: $output" >&2
    exit 1
  }
}

run_validator "$workflow" >/dev/null

cp "$workflow" "$tmp/real.yml"
printf '\n# %s\n' "COUCHCOOP_E2E_"'REAL_URL' >> "$tmp/real.yml"
expect_reject real-mode "$tmp/real.yml" "real-server URL must never enter Actions"

cp "$workflow" "$tmp/fixture.yml"
printf '\n# %s\n' "macos-"'fixture' >> "$tmp/fixture.yml"
expect_reject fixture "$tmp/fixture.yml" "obsolete fixture/Steam identifier"

cp "$workflow" "$tmp/artifact.yml"
sed 's#path: sources/sts2-couch-coop/.ci-artifacts/iphone-webkit#path: ../outside#' \
  "$workflow" > "$tmp/artifact.yml"
expect_reject artifact "$tmp/artifact.yml" "artifact upload path must be the reviewed"

cp "$workflow" "$tmp/godot-sha.yml"
sed '0,/f00ee565e9d3682584117ef8865f5ff6d8f571fbf2733075ee06b9e0953261b8/s//deadbeef/' \
  "$workflow" > "$tmp/godot-sha.yml"
expect_reject godot-sha "$tmp/godot-sha.yml" "both Mac jobs must verify the pinned Godot .NET SHA-256"

cp "$workflow" "$tmp/godot-fixture.yml"
sed '0,/--godot-harmony-fixture/s//--removed-godot-fixture/' "$workflow" > "$tmp/godot-fixture.yml"
expect_reject godot-fixture "$tmp/godot-fixture.yml" "both Mac jobs must run stock and ad-hoc-hardened"

cp "$workflow" "$tmp/metadata.yml"
sed '0,/-p:Sts2GameApi=v111/s//-p:Sts2GameApi=removed/' "$workflow" > "$tmp/metadata.yml"
expect_reject metadata "$tmp/metadata.yml" "public-beta metadata guards must use API v111"

cp "$workflow" "$tmp/intel-simulator.yml"
printf '\n# %s\n' 'iphone-safari-intel' >> "$tmp/intel-simulator.yml"
expect_reject intel-simulator "$tmp/intel-simulator.yml" "Intel must not stage or upload iPhone Simulator artifacts"

cp "$workflow" "$tmp/field-profile.yml"
sed '0,/\.ci-artifacts\/iphone-webkit\/field-repro/s//.ci-artifacts\/iphone-webkit\/removed/' \
  "$workflow" > "$tmp/field-profile.yml"
expect_reject field-profile "$tmp/field-profile.yml" "field-reproduction WebKit profile validation is missing"

cp "$workflow" "$tmp/retention.yml"
sed '0,/retention-days: 3/s//retention-days: 4/' "$workflow" > "$tmp/retention.yml"
expect_reject retention "$tmp/retention.yml" "both synthetic artifact uploads must retain data for three days"

sed '0,/@[0-9a-f]\{40\}/s//@main/' "$workflow" > "$tmp/unpinned-action.yml"
expect_reject unpinned-action "$tmp/unpinned-action.yml" "every workflow action must be pinned to a full commit SHA"

cp "$workflow" "$tmp/timeout.yml"
sed '/name: Check workflow policy/{n;/timeout-minutes:/d;}' "$workflow" > "$tmp/timeout.yml"
expect_reject timeout "$tmp/timeout.yml" "named workflow steps without"

echo "macOS/iPhone workflow policy tests passed"
