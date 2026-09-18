#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
bash -n "$repo_root/scripts/run-iphone-safari-simulator.sh"
node "$repo_root/scripts/test-iphone-safari-simulator.mjs"

preflight_line=$(grep -n 'iphone-harness-preflight.mjs' "$repo_root/scripts/run-iphone-safari-simulator.sh" | cut -d: -f1)
inventory_line=$(grep -n 'simctl list runtimes' "$repo_root/scripts/run-iphone-safari-simulator.sh" | cut -d: -f1)
[ "$preflight_line" -lt "$inventory_line" ] || {
  echo 'iPhone harness preflight must warm the server before CoreSimulator startup' >&2
  exit 1
}
grep -Fq 'AbortSignal.timeout(30_000)' "$repo_root/scripts/lib/iphone-harness-preflight.mjs" || {
  echo 'iPhone harness cold-start preflight must keep its bounded 30-second allowance' >&2
  exit 1
}
grep -Fq 'const SessionCreateTimeoutMs = 120_000;' "$repo_root/scripts/run-iphone-safari-simulator.mjs" || {
  echo 'cold iPhone SafariDriver session creation must keep its bounded two-minute allowance' >&2
  exit 1
}
grep -Fq 'pageLoadStrategy: "none"' "$repo_root/scripts/run-iphone-safari-simulator.mjs" || {
  echo 'iPhone SafariDriver navigation must not block on the complete field workload' >&2
  exit 1
}
grep -Fq 'el.click();return true;' "$repo_root/scripts/run-iphone-safari-simulator.mjs" || {
  echo 'the iPhone seat activation must use the proven semantic click path' >&2
  exit 1
}
grep -Fq 'waitForSeatSocket(3_000)' "$repo_root/scripts/run-iphone-safari-simulator.mjs" || {
  echo 'the iPhone seat activation must retain its bounded focus-race retry' >&2
  exit 1
}

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
