#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock
out="${1:-$WRAPPER_ROOT/../../.sts2/bench/android-webview/logcat.txt}"
mkdir -p "$(dirname "$out")"
adb_device logcat -d -v epoch -s CouchCoopWebView:I '*:S' > "$out"
printf '%s\n' "$out"
