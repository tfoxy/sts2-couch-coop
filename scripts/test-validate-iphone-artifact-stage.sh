#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
stage="$repo_root/.ci-artifacts/artifact-policy-test"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
rm -rf "$stage"
mkdir -p "$stage"
printf '{}\n' >"$stage/iphone-safari-result.json"
node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null
printf 'forbidden\n' >"$stage/game-binary.dll"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact allowlist accepted an unreviewed file" >&2
  exit 1
fi
rm -f "$stage/game-binary.dll"
ln -s /tmp "$stage/escape"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact allowlist accepted a symlink escape" >&2
  exit 1
fi
printf '%s\n' 'iPhone artifact stage tests: ok'
