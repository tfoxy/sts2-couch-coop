#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock
apk="$WRAPPER_ROOT/app/build/outputs/apk/debug/app-debug.apk"
[[ -f "$apk" ]] || { echo "missing APK; run mise run android-webview-build" >&2; exit 2; }
adb_device install -r "$apk"
