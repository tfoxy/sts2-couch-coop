#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
# Run through mise so paths and package versions resolve from this checkout's root mise.toml.
cd "$WRAPPER_ROOT/../.."
out="${1:-$PWD/.sts2/bench/android-webview/toolchain.txt}"
mkdir -p "$(dirname "$out")"
{
  mise --version
  mise ls --current
  mise exec -- bash -c 'command -v java; java -version; command -v sdkmanager; sdkmanager --version; printf "JAVA_HOME=%s\nANDROID_HOME=%s\nANDROID_SDK_ROOT=%s\nANDROID_COMPILE_SDK=%s\nANDROID_BUILD_TOOLS=%s\n" "$JAVA_HOME" "$ANDROID_HOME" "${ANDROID_SDK_ROOT:-}" "$ANDROID_COMPILE_SDK" "$ANDROID_BUILD_TOOLS"; sdkmanager --list_installed'
  sha256sum mise.toml tools/android-webview-wrapper/gradle/wrapper/gradle-wrapper.properties tools/android-webview-wrapper/gradle/wrapper/gradle-wrapper.jar tools/android-webview-wrapper/build.gradle tools/android-webview-wrapper/app/build.gradle
  cd "$WRAPPER_ROOT"
  with_mise_android ./gradlew --version
  apk=app/build/outputs/apk/debug/app-debug.apk
  if [[ -f "$apk" ]]; then sha256sum "$apk"; fi
} > "$out" 2>&1
printf '%s\n' "$out"
