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
