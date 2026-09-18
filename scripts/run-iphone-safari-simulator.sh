#!/usr/bin/env bash
# Real iPhone 13 Simulator/SafariDriver leg. Nearby devices and prerelease runtimes are capability failures.
set -euo pipefail

artifact_dir=""
harness_url=""
for ((argument_index=1; argument_index<=$#; argument_index++)); do
  if [ "${!argument_index}" = "--artifact-dir" ]; then
    value_index=$((argument_index + 1))
    artifact_dir="${!value_index:-}"
  fi
done

persist_failure() {
  [ -n "$artifact_dir" ] || return 0
  mkdir -p "$artifact_dir"
  printf '{"category":"%s","ok":false,"reason":"%s"}\n' "$1" "$2" >"$artifact_dir/iphone-safari-result.json"
  [ -f "$artifact_dir/iphone-safari-timeline.json" ] || printf '[]\n' >"$artifact_dir/iphone-safari-timeline.json"
}
fail() {
  persist_failure "$1" "$2"
  printf '{"category":"%s","ok":false,"reason":"%s"}\n' "$1" "$2" >&2
  exit "${3:-1}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-dir) artifact_dir="${2:?--artifact-dir requires a path}"; shift 2 ;;
    --harness-url) harness_url="${2:?--harness-url requires a URL}"; shift 2 ;;
    --help) printf 'usage: %s --artifact-dir PATH --harness-url URL\n' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
done
if [ -z "$artifact_dir" ] || [ -z "$harness_url" ]; then fail capability missing-required-argument 64; fi
mkdir -p "$artifact_dir"

[ "$(uname -s)" = "Darwin" ] || fail capability macos-required 78
command -v xcrun >/dev/null 2>&1 || fail capability xcrun-unavailable 78
command -v safaridriver >/dev/null 2>&1 || fail capability safaridriver-unavailable 78
command -v node >/dev/null 2>&1 || fail capability node-unavailable 78
command -v curl >/dev/null 2>&1 || fail capability curl-unavailable 78

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
selection_dir=$(mktemp -d "${TMPDIR:-/tmp}/couchcoop-simulator-selection.XXXXXX")
driver_pid=""
device=""
created=0
restore_shutdown=0
cleanup() {
  if [ -n "$driver_pid" ]; then kill "$driver_pid" >/dev/null 2>&1 || true; fi
  if [ "$created" = 1 ] && [ -n "$device" ]; then
    xcrun simctl delete "$device" >/dev/null 2>&1 || true
  elif [ "$restore_shutdown" = 1 ] && [ -n "$device" ]; then
    xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
  fi
  rm -rf "$selection_dir"
}
trap cleanup EXIT HUP INT TERM

xcrun simctl list runtimes -j >"$selection_dir/runtimes.json" || fail capability runtime-inventory-failed 78
xcrun simctl list devicetypes -j >"$selection_dir/device-types.json" || fail capability device-type-inventory-failed 78
xcrun simctl list devices -j >"$selection_dir/devices.json" || fail capability device-inventory-failed 78
set +e
selection=$(node "$script_dir/lib/iphone-simulator-selection.mjs" \
  --runtimes "$selection_dir/runtimes.json" \
  --deviceTypes "$selection_dir/device-types.json" \
  --devices "$selection_dir/devices.json")
selection_status=$?
set -e
json_field() {
  COUCHCOOP_SELECTION_JSON="$selection" node -e \
    'const value=JSON.parse(process.env.COUCHCOOP_SELECTION_JSON)[process.argv[1]]; process.stdout.write(value == null ? "" : String(value))' "$1"
}
if [ "$selection_status" -ne 0 ]; then
  selection_reason=$(json_field reason)
  fail capability "${selection_reason:-simulator-selection-failed}" 78
fi

selection_action=$(json_field action)
runtime=$(json_field runtime)
device_type=$(json_field deviceType)
cleanup_action=$(json_field cleanup)
if [ "$selection_action" = "create" ]; then
  device=$(xcrun simctl create "CouchCoop ephemeral iPhone 13" "$device_type" "$runtime") \
    || fail capability iphone-13-create-failed 78
  [ "$cleanup_action" = "delete" ] || fail capability invalid-create-cleanup-policy 78
  created=1
else
  device=$(json_field udid)
  [ -n "$device" ] || fail capability iphone-13-udid-missing 78
  if [ "$cleanup_action" = "shutdown" ]; then restore_shutdown=1; fi
  [ "$cleanup_action" = "none" ] || [ "$cleanup_action" = "shutdown" ] \
    || fail capability invalid-reuse-cleanup-policy 78
fi

if [ "$created" = 1 ] || [ "$restore_shutdown" = 1 ]; then
  xcrun simctl boot "$device" >/dev/null 2>&1 || fail simulator-crash simulator-boot-failed
fi
xcrun simctl bootstatus "$device" -b || fail simulator-crash simulator-bootstatus-failed

# Prove the synthetic server speaks both transports before attributing a later failure to Safari.
node "$script_dir/lib/iphone-harness-preflight.mjs" "$harness_url" >/dev/null \
  || fail websocket harness-preflight-failed

# Never let Authorization Services turn a hosted run into an invisible password prompt. GitHub's macOS runner
# grants passwordless sudo; a local Mac without equivalent authority records a named capability result and the
# operator can enable SafariDriver once outside this automation.
if [ "$(id -u)" -eq 0 ]; then
  safaridriver --enable </dev/null >/dev/null 2>&1 || fail safaridriver enable-failed
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n safaridriver --enable </dev/null >/dev/null 2>&1 || fail safaridriver enable-failed
else
  fail safaridriver enable-requires-noninteractive-privilege
fi
safaridriver -p 4444 >/dev/null 2>&1 &
driver_pid=$!
driver_ready=0
driver_poll=0
while [ "$driver_poll" -lt 40 ]; do
  if curl -fsS http://127.0.0.1:4444/status >/dev/null 2>&1; then driver_ready=1; break; fi
  sleep 0.25
  driver_poll=$((driver_poll + 1))
done
[ "$driver_ready" = 1 ] || fail safaridriver start-failed

crash_since_ms=$(node -e 'process.stdout.write(String(Date.now()))')
set +e
node "$script_dir/run-iphone-safari-simulator.mjs" \
  --url "$harness_url" \
  --artifactDir "$artifact_dir" \
  --webdriver http://127.0.0.1:4444 \
  --udid "$device"
runner_status=$?
set -e

crash_status=0
node "$script_dir/lib/iphone-crash-metadata.mjs" \
  --sinceEpochMs "$crash_since_ms" \
  --output "$artifact_dir/iphone-safari-crash-metadata.json" || crash_status=$?
if [ "$crash_status" -eq 10 ]; then
  persist_failure simulator-crash matching-crash-report
  exit 1
fi
[ "$crash_status" -eq 0 ] || fail simulator-crash crash-report-inspection-failed
rm -f "$artifact_dir/iphone-safari-crash-metadata.json"
exit "$runner_status"
