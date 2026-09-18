#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
bash -n "$repo_root/scripts/run-iphone-safari-simulator.sh"
node "$repo_root/scripts/test-iphone-safari-simulator.mjs"

if [ "$(uname -s)" != "Darwin" ]; then
  artifact_dir=$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-safari-capability.XXXXXX")
  trap 'rm -rf "$artifact_dir"' EXIT HUP INT TERM
  set +e
  "$repo_root/scripts/run-iphone-safari-simulator.sh" \
    --artifact-dir "$artifact_dir" \
    --harness-url http://127.0.0.1:1/ >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -eq 78 ]
  node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (result.ok !== false || result.category !== "capability" || result.reason !== "macos-required") process.exit(1);
  ' "$artifact_dir/iphone-safari-result.json"
  [ "$(cat "$artifact_dir/iphone-safari-timeline.json")" = "[]" ]
fi

printf '%s\n' 'iphone-safari shell runner: ok'
