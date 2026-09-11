#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
mise install java android-sdk
: "${ANDROID_COMPILE_SDK:?root mise.toml must define ANDROID_COMPILE_SDK}"
: "${ANDROID_BUILD_TOOLS:?root mise.toml must define ANDROID_BUILD_TOOLS}"
set +e
yes | with_mise_android sdkmanager --licenses
pipe_status=("${PIPESTATUS[@]}")
set -e
if [[ "${pipe_status[1]}" -ne 0 ]]; then exit "${pipe_status[1]}"; fi
if [[ "${pipe_status[0]}" -ne 0 && "${pipe_status[0]}" -ne 141 ]]; then exit "${pipe_status[0]}"; fi
with_mise_android sdkmanager "platforms;android-${ANDROID_COMPILE_SDK}" "build-tools;${ANDROID_BUILD_TOOLS}"
