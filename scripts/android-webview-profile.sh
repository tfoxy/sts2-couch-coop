#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock

: "${STREAMLINE_COUNTERS_FILE:?Set a file containing the exact comma-separated Mali counters.}"
: "${STREAMLINE_DURATION_SECONDS:?Set a bounded capture duration in seconds.}"
: "${STREAMLINE_APC_OUT:?Set the host output .apc path.}"
[[ ! -e "$STREAMLINE_APC_OUT" ]] || { echo 'refusing to overwrite existing APC output' >&2; exit 2; }
[[ -f "$STREAMLINE_COUNTERS_FILE" ]] || { echo 'counter file is missing' >&2; exit 2; }
[[ "$STREAMLINE_DURATION_SECONDS" =~ ^[1-9][0-9]?$ ]] || { echo 'duration must be 1..99 seconds' >&2; exit 2; }
counters="$(tr -d '[:space:]' < "$STREAMLINE_COUNTERS_FILE")"
[[ "$counters" == *gpu* || "$counters" == *GPU* || "$counters" == *Mali* ]] || { echo 'counter input has no Mali/GPU counter' >&2; exit 2; }
[[ "$counters" =~ ^[A-Za-z0-9_,.-]+$ ]] || { echo 'counter input contains unsafe characters' >&2; exit 2; }
gatord="${STREAMLINE_GATORD_PATH:-./gatord}"
pid="$(adb_device shell pidof "$WRAPPER_PACKAGE" | tr -d '\r' | awk '{print $1}')"
[[ "$pid" =~ ^[0-9]+$ ]] || { echo 'wrapper process is not running' >&2; exit 2; }
run_id="${COUCHCOOP_LIVEQA_PID}-$(date +%s%N)-${RANDOM}"
capture="cc-webview-${run_id}.apc"
remote_pid_file="cc-webview-${run_id}.pid"
original_harden="$(adb_device shell getprop security.perf_harden | tr -d '\r')"
restore_harden() {
  node "$LIVE_LOCK_HELPER" assert \
    --owner "$COUCHCOOP_LIVEQA_OWNER" --pid "$COUCHCOOP_LIVEQA_PID" \
    --resource "exclusive:android:${ADB_SERIAL}" >/dev/null 2>&1 || return 0
  [[ "$(adb_device shell getprop security.perf_harden | tr -d '\r')" == 0 ]] && adb_device shell setprop security.perf_harden "$original_harden" || true
}
adb_pid=''
stop_owned_capture() {
  [[ -n "$adb_pid" ]] && kill "$adb_pid" 2>/dev/null || true
  local remote_pid cmdline
  remote_pid="$(adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") cat $(shell_quote "$remote_pid_file")" 2>/dev/null | tr -d '\r')"
  [[ "$remote_pid" =~ ^[0-9]+$ ]] || return 0
  cmdline="$(adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") cat /proc/${remote_pid}/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" == *gatord* && "$cmdline" == *"$capture"* ]]; then
    adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") kill -TERM $(shell_quote "$remote_pid")" || true
    for _ in 1 2 3 4 5; do adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") kill -0 $(shell_quote "$remote_pid")" 2>/dev/null || break; sleep 1; done
  fi
}
trap 'stop_owned_capture; restore_harden; exit 130' INT TERM
trap restore_harden EXIT
adb_device shell setprop security.perf_harden 0
mkdir -p "$(dirname "$STREAMLINE_APC_OUT")"
raw_log="${STREAMLINE_APC_OUT}.gatord.log"; raw_tar="${STREAMLINE_APC_OUT}.raw.tar.gz"
inner_command="echo \$\$ > $(shell_quote "$remote_pid_file"); exec $(shell_quote "$gatord") -C $(shell_quote "$counters") -i $(shell_quote "$pid") -S no -t $(shell_quote "$STREAMLINE_DURATION_SECONDS") -o $(shell_quote "$capture")"
adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") sh -c $(shell_quote "$inner_command")" >"$raw_log" 2>&1 &
adb_pid=$!
wait "$adb_pid"
adb_pid=''
adb_device exec-out run-as "$WRAPPER_PACKAGE" tar -czf - "$capture" | tar -xzf - -C "$(dirname "$STREAMLINE_APC_OUT")"
mv "$(dirname "$STREAMLINE_APC_OUT")/$capture" "$STREAMLINE_APC_OUT"
adb_device exec-out run-as "$WRAPPER_PACKAGE" tar -czf - "$capture" > "$raw_tar"
[[ -f "$STREAMLINE_APC_OUT/captured.xml" && -f "$STREAMLINE_APC_OUT/0000000000" ]] || { echo 'APC missing captured.xml or frame data' >&2; exit 1; }
adb_device shell "run-as $(shell_quote "$WRAPPER_PACKAGE") rm -rf $(shell_quote "$capture") $(shell_quote "$remote_pid_file")"
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({scope:"global GPU counters; CPU process attribution",pid:Number(process.argv[2]),durationSeconds:Number(process.argv[3]),capture:process.argv[4],counterList:process.argv[5],gatordLog:process.argv[6],rawTar:process.argv[7]})+"\n")' "${STREAMLINE_APC_OUT}.json" "$pid" "$STREAMLINE_DURATION_SECONDS" "$STREAMLINE_APC_OUT" "$counters" "$raw_log" "$raw_tar"
echo "$STREAMLINE_APC_OUT"
