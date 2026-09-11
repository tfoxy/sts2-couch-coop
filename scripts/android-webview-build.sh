#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
cd "$WRAPPER_ROOT"
with_mise_android ./gradlew --no-daemon :app:assembleDebug
echo "$WRAPPER_ROOT/app/build/outputs/apk/debug/app-debug.apk"
