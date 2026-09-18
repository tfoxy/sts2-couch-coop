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

cp "$workflow" "$tmp/timeout.yml"
sed '/name: Check workflow policy/{n;/timeout-minutes:/d;}' "$workflow" > "$tmp/timeout.yml"
expect_reject timeout "$tmp/timeout.yml" "named workflow steps without"

echo "macOS/iPhone workflow policy tests passed"
