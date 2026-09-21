#!/usr/bin/env bash
# Offline contract pins for the device runner.  No adb/device/server is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/scripts/bench-phone-query-ab.sh"
WRAPPER="$ROOT/scripts/bench-phone-canvas-ab.sh"
TAB_TOOL="$ROOT/scripts/phone-bench-tab.mjs"
fail=0
check() {
  local name="$1"
  shift
  if "$@"; then echo "PASS  $name"; else echo "FAIL  $name" >&2; fail=1; fi
}

help="$($RUNNER --help)"
source="$(<"$RUNNER")"
check "generic runner parses as bash" bash -n "$RUNNER"
check "canvas wrapper parses as bash" bash -n "$WRAPPER"
check "named query flags documented" grep -Fq -- '--before-query <query>' <<<"$help"
check "window passthrough documented" grep -Fq -- '--window <a:b|auto>' <<<"$help"
check "default DOM stage arm documented" grep -Fq -- 'default stage=dom' <<<"$help"
check "default canvas stage arm documented" grep -Fq -- 'default stage=canvas' <<<"$help"
check "ABBA order is pinned" grep -Fq 'ARMS=("$BEFORE_NAME" "$AFTER_NAME" "$AFTER_NAME" "$BEFORE_NAME")' <<<"$source"
check "fresh intent tab opens per cell" grep -Fq 'phone-bench-tab.mjs" open' <<<"$source"
check "wrappers leave port-target closure to phone tab tool" bash -c '! grep -Fq "/json/close/" "$1" && ! grep -Fq "/json/close/" "$2"' _ "$RUNNER" "$WRAPPER"
check "phone tab tool owns the pre-open sweep" grep -Fq 'httpCloseBenchPort(args.cdpPort, args.url)' "$TAB_TOOL"
check "teardown evidence failure is non-retryable in both wrappers" bash -c 'grep -Fq "[ \"\$tab_status\" -eq 3 ]" "$1" && grep -Fq "[ \"\$tab_status\" -eq 3 ]" "$2"' _ "$RUNNER" "$WRAPPER"
check "phone tab tool has distinct teardown failure exit" grep -Fq 'process.exit(3)' "$TAB_TOOL"
check "foreground verified after each cell" grep -Fq 'phone-bench-tab.mjs" verify' <<<"$source"
check "required failure artifacts are retained" bash -c 'for x in procs lmk gpulog png; do grep -Fq "\${label}.${x}" <<<"$0" || exit 1; done' "$source"
check "SIGINT exits rather than continuing the matrix" grep -Fq "trap 'exit 130' INT" <<<"$source"
check "SIGTERM exits rather than continuing the matrix" grep -Fq "trap 'exit 143' TERM" <<<"$source"
check "cleanup is only on EXIT (no signal trap continuation)" bash -c '! grep -Fq "trap cleanup EXIT INT TERM" "$1" && grep -Fq "trap cleanup EXIT" "$1"' _ "$RUNNER"
check "generic runner is a separate entrypoint" bash -c '[ "$1" != "$2" ] && [ -x "$1" ]' _ "$RUNNER" "$WRAPPER"
check "four-cell DOM/canvas gate stays independent" grep -Fq 'ARMS="dom,canvas,canvas,dom"' "$WRAPPER"
check "canvas arm is canonical" grep -Fq 'canvas) query="stage=canvas&paintDump=1"' "$WRAPPER"
check "deleted canvas selectors stay absent" bash -c '! grep -Eq "pureCanvas|canvasRetained|canvasStaticBg|retainedForceDecline|retained-marker-timing" "$1"' _ "$WRAPPER"
# Keep the timestamp format as one remote-shell command. Passing the format as a separate
# adb argument makes Android toybox date see two operands because of its embedded space.
remote_date='shell "date '\''+%m-%d %H:%M:%S.000'\''"'
check "canvas timestamp is one remote-shell command" grep -Fq "$remote_date" "$WRAPPER"
check "query timestamp is one remote-shell command" grep -Fq "$remote_date" "$RUNNER"

[ "$fail" = 0 ] || exit 1
echo "phone-query-ab selftest: all offline contract pins pass"
