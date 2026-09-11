#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock
out="${1:-$WRAPPER_ROOT/../../.sts2/bench/android-webview/webview-version.txt}"
mkdir -p "$(dirname "$out")"
adb_device shell dumpsys webviewupdate > "$out"
printf '%s\n' "$out"
