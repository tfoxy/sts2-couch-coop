#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
stage="$repo_root/.ci-artifacts/iphone-safari-arm/field-repro"
webkit_base="$repo_root/.ci-artifacts/iphone-webkit/baseline"
webkit_field="$repo_root/.ci-artifacts/iphone-webkit/field-repro"
trap 'rm -rf "$repo_root/.ci-artifacts/iphone-safari-arm" "$repo_root/.ci-artifacts/iphone-webkit"' EXIT HUP INT TERM
rm -rf "$repo_root/.ci-artifacts/iphone-safari-arm"
mkdir -p "$stage"
printf '{"category":"success","phase":"post-final-delta","failureClass":null,"ok":true,"presentations":6,"acks":6,"hostSocketOpen":true,"seatSocketOpen":true,"viewError":false,"crash":false,"animationFrames":30,"responsive":true,"requiredMessages":6,"failures":[],"profile":"field-repro"}\n' >"$stage/iphone-safari-result.json"
printf '[]\n' >"$stage/iphone-safari-timeline.json"
printf '{"visit":1,"t":1,"kind":"lifecycle","state":"load"}\n' >"$stage/browser-lifecycle.jsonl"
node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null
node --input-type=module - "$repo_root" "$stage" <<'NODE'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , root, stage] = process.argv;
const resultPath = join(stage, "iphone-safari-result.json");
const timelinePath = join(stage, "iphone-safari-timeline.json");
const provenance = { run_id: "43297670080", run_attempt: "2", head_sha: "a".repeat(40) };
const result = {
  ...JSON.parse(readFileSync(resultPath, "utf8")), provenance,
  commands: [{ command: "check-arithmetic", elapsedMs: 4, outcome: "success" }],
  lastSafeResult: {
    navigation: { originEqualsHarness: true, pathIsRoot: true, aboutBlank: false, handleCount: 1 },
    page: { readyState: "complete", lifecycleMetaPresent: true, lifecycleNonceValid: true, seatSelectorPresent: true },
  },
};
const timeline = [{ t: 0, kind: "provenance", provenance }, { t: 4, kind: "passed" }];
const persist = (value = result, rows = timeline) => {
  writeFileSync(resultPath, JSON.stringify(value) + "\n");
  writeFileSync(timelinePath, JSON.stringify(rows) + "\n");
};
const validate = () => execFileSync(process.execPath,
  [join(root, "scripts/validate-iphone-artifact-stage.mjs"), "safari", stage], { stdio: "pipe" });
writeFileSync(join(stage, "iphone-safari-host.log"), "synthetic harness started\nGET / -> shell\n");
persist();
validate();
persist({ ...result, provenance: { run_id: null, run_attempt: null, head_sha: null },
  commands: [], lastSafeResult: { navigation: null, page: null } });
validate();

const rawUrl = "http://127.0.0.1:23339/?token=private-url";
const nonce = "0123456789abcdef0123456789abcdef";
persist();
const hostLogPath = join(stage, "iphone-safari-host.log");
for (const [label, content] of [
  ["raw host URL", `listening at ${rawUrl}\n`],
  ["raw HTTPS host URL", "listening at https://localhost/\n"],
  ["raw host visit", `GET / -> shell visit=${nonce}\n`],
  ["bare host nonce", `identifier ${nonce}\n`],
]) {
  writeFileSync(hostLogPath, content);
  assert.throws(validate, undefined, `artifact validator accepted ${label}`);
}
writeFileSync(hostLogPath, "synthetic harness started\nGET / -> shell visit=<redacted>\nGET /ws\n");
validate();
writeFileSync(hostLogPath, `{"baseUrl":"${rawUrl}"}\nGET / -> shell visit=${nonce}\nGET /ws\n`);
const redactCommand = readFileSync(join(root, ".github/workflows/macos-check.yml"), "utf8")
  .split("\n").find(line => line.includes("sed -E") && line.includes("visit=<redacted>"));
assert.ok(redactCommand, "workflow host log redaction is missing");
execFileSync("bash", ["-c", `${redactCommand}\nmv "$harness_err.redacted" "$harness_err"`],
  { env: { ...process.env, harness_err: hostLogPath } });
assert.equal(readFileSync(hostLogPath, "utf8"),
  '{"baseUrl":"<redacted-url>"}\nGET / -> shell visit=<redacted>\nGET /ws\n');
validate();
const mutations = [
  ["raw result URL", value => { value.url = rawUrl; }],
  ["raw result nonce", value => { value.nonce = nonce; }],
  ["raw navigation URL", value => { value.lastSafeResult.navigation.url = rawUrl; }],
  ["raw page nonce", value => { value.lastSafeResult.page.nonce = nonce; }],
  ["raw ready state", value => { value.lastSafeResult.page.readyState = rawUrl; }],
  ["nonce in boolean field", value => { value.lastSafeResult.page.lifecycleNonceValid = nonce; }],
  ["unknown safe result field", value => { value.lastSafeResult.extra = true; }],
  ["raw command URL", value => { value.commands[0].url = rawUrl; }],
  ["raw driver message", value => { value.commands[0].message = rawUrl; }],
  ["unknown command", value => { value.commands[0].command = "unreviewed-command"; }],
  ["unknown outcome", value => { value.commands[0].outcome = "unreviewed-outcome"; }],
  ["negative timing", value => { value.commands[0].elapsedMs = -1; }],
  ["raw provenance URL", value => { value.provenance.url = rawUrl; }],
  ["raw provenance value", value => { value.provenance.run_id = rawUrl; }],
];
for (const [label, mutate] of mutations) {
  const candidate = structuredClone(result);
  mutate(candidate);
  persist(candidate);
  assert.throws(validate, undefined, `artifact validator accepted ${label}`);
}
persist(result, [{ ...timeline[0], url: rawUrl }]);
assert.throws(validate, undefined, "artifact validator accepted a raw timeline URL");
persist(result, [{ ...timeline[0], provenance: { ...provenance, nonce } }]);
assert.throws(validate, undefined, "artifact validator accepted a raw timeline nonce");
persist();
validate();
console.log(`Safari diagnostic artifact tests: 3 accepted, ${mutations.length + 2} rejected`);
console.log("Safari host log tests: 2 redacted logs accepted, 4 unsafe logs rejected");
NODE
mkdir -p "$webkit_base" "$webkit_field"
printf '{"category":"success","phase":"post-final-delta","failureClass":null,"ok":true,"presentations":2,"acks":2,"animationFrames":30,"responsive":true,"crash":false,"viewError":false,"hostSocketOpen":true,"seatSocketOpen":true,"journeyValid":true,"profile":"baseline","pageErrorCategories":[]}\n' >"$webkit_base/iphone-webkit-result.json"
printf '{"category":"success","phase":"post-final-delta","failureClass":null,"ok":true,"presentations":6,"acks":6,"animationFrames":30,"responsive":true,"crash":false,"viewError":false,"hostSocketOpen":true,"seatSocketOpen":true,"journeyValid":true,"profile":"field-repro","pageErrorCategories":[]}\n' >"$webkit_field/iphone-webkit-result.json"
for webkit_stage in "$webkit_base" "$webkit_field"; do
  printf '[]\n' >"$webkit_stage/iphone-webkit-timeline.json"
  printf '{"visit":1,"t":1,"kind":"lifecycle","state":"load"}\n' >"$webkit_stage/browser-lifecycle.jsonl"
done
node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" webkit "$webkit_base" >/dev/null
node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" webkit "$webkit_field" >/dev/null
printf '{bad\n' >"$webkit_base/iphone-webkit-result.json"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" webkit "$webkit_base" >/dev/null 2>&1; then echo "artifact validator accepted malformed JSON" >&2; exit 1; fi
printf '{"category":"success","phase":"post-final-delta","failureClass":null,"ok":true,"presentations":6,"acks":6,"animationFrames":30,"responsive":true,"crash":false,"viewError":false,"hostSocketOpen":true,"seatSocketOpen":true,"journeyValid":true,"profile":"field-repro","pageErrorCategories":[]}\n' >"$webkit_base/iphone-webkit-result.json"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" webkit "$webkit_base" >/dev/null 2>&1; then echo "artifact validator accepted a result from the wrong profile" >&2; exit 1; fi
printf '{"category":"success","phase":"post-final-delta","failureClass":null,"ok":true,"presentations":2,"acks":2,"animationFrames":30,"responsive":true,"crash":false,"viewError":false,"hostSocketOpen":true,"seatSocketOpen":true,"journeyValid":true,"profile":"wrong","pageErrorCategories":[],"secret":"x"}\n' >"$webkit_base/iphone-webkit-result.json"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" webkit "$webkit_base" >/dev/null 2>&1; then echo "artifact validator accepted wrong schema" >&2; exit 1; fi
printf 'forbidden\n' >"$stage/game-binary.dll"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact allowlist accepted an unreviewed file" >&2
  exit 1
fi
rm -f "$stage/game-binary.dll"
printf 'trace\n' >"$stage/trace.zip"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact allowlist accepted a trace" >&2
  exit 1
fi
rm -f "$stage/trace.zip"
printf 'not-a-png\n' >"$stage/iphone-safari-failure.png"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact validator accepted an invalid PNG" >&2
  exit 1
fi
rm -f "$stage/iphone-safari-failure.png"
printf '{bad\n' >"$stage/browser-lifecycle.jsonl"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact validator accepted malformed JSONL" >&2
  exit 1
fi
printf '{"visit":1,"t":1,"kind":"lifecycle","state":"secret"}\n' >"$stage/browser-lifecycle.jsonl"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact validator accepted an unbounded lifecycle value" >&2
  exit 1
fi
rm -f "$stage/browser-lifecycle.jsonl"
printf '{"visit":1,"t":1,"kind":"lifecycle","state":"load"}\n' >"$stage/browser-lifecycle.jsonl"
truncate -s 65537 "$stage/iphone-safari-timeline.json"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact validator accepted an oversized JSON artifact" >&2
  exit 1
fi
rm -f "$stage/iphone-safari-timeline.json"
printf '[]\n' >"$stage/iphone-safari-timeline.json"
rm -f "$stage/browser-lifecycle.jsonl"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact validator accepted a missing required lifecycle" >&2
  exit 1
fi
printf '{"visit":1,"t":1,"kind":"lifecycle","state":"load"}\n' >"$stage/browser-lifecycle.jsonl"
ln -s /tmp "$stage/escape"
if node "$repo_root/scripts/validate-iphone-artifact-stage.mjs" safari "$stage" >/dev/null 2>&1; then
  echo "artifact allowlist accepted a symlink escape" >&2
  exit 1
fi
printf '%s\n' 'iPhone artifact stage tests: ok'
