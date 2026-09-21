#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "phone-pipeline-cleanup-"));
try {
  const helper = join(root, "android-webview-lib.sh");
  const finalized = join(root, "finalized");
  writeFileSync(helper, "set -euo pipefail\n");
  const script = `set -uo pipefail
source ${JSON.stringify(helper)}
set +e
false | tee ${JSON.stringify(join(root, "bench.log"))}
bench_exit=\${PIPESTATUS[0]}
set -e
touch ${JSON.stringify(finalized)}
test "\$bench_exit" -eq 1
`;
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  assert.ok(existsSync(finalized), "nonzero bench subprocess reached finalization");
  for (const file of ["bench-phone-canvas-ab.sh", "bench-phone-query-ab.sh"]) {
    const source = readFileSync(resolve("scripts", file), "utf8");
    assert.match(source, /set \+e\n\s*node "\$SCRIPT_DIR\/bench-mirror-replay\.mjs"[\s\S]*?bench_(?:exit|status)=\$\{PIPESTATUS\[0\]\}\n\s*set -e/);
  }
  console.log("phone bench failing-pipeline cleanup test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
