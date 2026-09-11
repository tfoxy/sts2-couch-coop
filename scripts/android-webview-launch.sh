#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock

content_width=''
content_height=''
content_left=''
content_top=''
density_dpi=''
viewport_width=''
viewport_height=''
device_scale_factor=''
refresh_rate_hz=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --content-width-px) content_width="${2:?missing value}"; shift 2 ;;
    --content-height-px) content_height="${2:?missing value}"; shift 2 ;;
    --content-left-px) content_left="${2:?missing value}"; shift 2 ;;
    --content-top-px) content_top="${2:?missing value}"; shift 2 ;;
    --density-dpi) density_dpi="${2:?missing value}"; shift 2 ;;
    --viewport-width) viewport_width="${2:?missing value}"; shift 2 ;;
    --viewport-height) viewport_height="${2:?missing value}"; shift 2 ;;
    --device-scale-factor) device_scale_factor="${2:?missing value}"; shift 2 ;;
    --refresh-rate-hz) refresh_rate_hz="${2:?missing value}"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) [[ -z "$url" ]] || { echo 'only one URL is allowed' >&2; exit 2; }; url="$1"; shift ;;
  esac
done
url="${url:-http://127.0.0.1:13400/}"
[[ "$url" =~ ^http://127\.0\.0\.1:[0-9]+/ ]] || { echo 'URL must be an http://127.0.0.1:<port>/ URL.' >&2; exit 2; }
geometry_values=("$content_width" "$content_height" "$content_left" "$content_top" "$density_dpi")
geometry_count=0
for value in "${geometry_values[@]}"; do [[ -n "$value" ]] && ((geometry_count += 1)); done
[[ "$geometry_count" == 0 || "$geometry_count" == 5 ]] || { echo 'content geometry requires width, height, left, top, and density together' >&2; exit 2; }
if [[ "$geometry_count" == 5 ]]; then
  for value in "${geometry_values[@]}"; do [[ "$value" =~ ^[0-9]+$ ]] || { echo 'content geometry values must be integers' >&2; exit 2; }; done
fi
calibration_values=("$viewport_width" "$viewport_height" "$device_scale_factor")
calibration_count=0
for value in "${calibration_values[@]}"; do [[ -n "$value" ]] && ((calibration_count += 1)); done
[[ "$calibration_count" == 0 || "$calibration_count" == 3 ]] || { echo 'CDP calibration requires viewport width, height, and device scale together' >&2; exit 2; }
if [[ "$calibration_count" == 3 ]]; then
  [[ "$viewport_width" =~ ^[0-9]+$ && "$viewport_height" =~ ^[0-9]+$ && "$device_scale_factor" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo 'invalid CDP calibration values' >&2; exit 2; }
fi
if [[ -n "$refresh_rate_hz" ]]; then
  [[ "$refresh_rate_hz" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk "BEGIN { exit !($refresh_rate_hz > 0) }" || { echo 'refresh rate must be a positive number' >&2; exit 2; }
fi
host_port="${url#http://127.0.0.1:}"; host_port="${host_port%%/*}"
reverse="tcp:${host_port}"
cdp_port="${CDP_PORT:-9222}"; [[ "$cdp_port" =~ ^[0-9]+$ ]] || { echo 'CDP_PORT must be numeric' >&2; exit 2; }
require_live_resource "exclusive:browser:${cdp_port}"
forward="tcp:${cdp_port}"
run_id="$(date +%s%N)-$$"
started_host_ns="$(date +%s%N)"
created_reverse=false
created_forward=false
created_calibrator=false
calibrator_pid=''

rollback() {
  local status=$?
  trap - EXIT INT TERM
  if "$created_calibrator"; then stop_owned_calibrator "$calibrator_pid" "$pid_file"; forget_owned calibrators "$calibrator_pid"; fi
  if "$created_forward"; then remove_owned_tunnel forwards "$forward" "$expected_socket" || true; fi
  if "$created_reverse"; then remove_owned_tunnel reverses "$reverse" "$reverse" || true; fi
  exit "$status"
}
trap rollback EXIT INT TERM

if tunnel_target reverses "$reverse" >/dev/null; then
  owned_tunnel_matches reverses "$reverse" "$reverse" || { echo "refusing existing reverse $reverse; its serial, local endpoint, or target is not owned by this wrapper session" >&2; exit 2; }
else
  adb_device reverse --no-rebind "$reverse" "$reverse"
  record_owned reverses "$reverse" "$reverse"
  created_reverse=true
fi

# Deliver the URL to onNewIntent even when Android brings an existing task back
# from behind Chrome. Without SINGLE_TOP, that launch can retain the old page.
remote_command="am start -f 0x20000000 -n $(shell_quote "$WRAPPER_ACTIVITY") --es $(shell_quote "$EXTRA_URL") $(shell_quote "$url") --es $(shell_quote 'coop.couch.webview.RUN_ID') $(shell_quote "$run_id")"
if [[ "$calibration_count" == 3 ]]; then
  remote_command+=" --ez $(shell_quote 'coop.couch.webview.DEFER_LOAD') true"
fi
if [[ -n "$refresh_rate_hz" ]]; then
  remote_command+=" --ef $(shell_quote 'coop.couch.webview.REFRESH_RATE_HZ') $(shell_quote "$refresh_rate_hz")"
fi
if [[ "$geometry_count" == 5 ]]; then
  remote_command+=" --ei $(shell_quote 'coop.couch.webview.CONTENT_WIDTH_PX') $(shell_quote "$content_width")"
  remote_command+=" --ei $(shell_quote 'coop.couch.webview.CONTENT_HEIGHT_PX') $(shell_quote "$content_height")"
  remote_command+=" --ei $(shell_quote 'coop.couch.webview.CONTENT_LEFT_PX') $(shell_quote "$content_left")"
  remote_command+=" --ei $(shell_quote 'coop.couch.webview.CONTENT_TOP_PX') $(shell_quote "$content_top")"
  remote_command+=" --ei $(shell_quote 'coop.couch.webview.DENSITY_DPI') $(shell_quote "$density_dpi")"
fi
adb_device shell "$remote_command"
pid_ready_attempts="${PID_READY_ATTEMPTS:-${READY_ATTEMPTS:-20}}"
pid_ready_delay_seconds="${PID_READY_DELAY_SECONDS:-1}"
[[ "$pid_ready_attempts" =~ ^[1-9][0-9]*$ ]] || { echo 'PID_READY_ATTEMPTS must be a positive integer' >&2; exit 2; }
[[ "$pid_ready_delay_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo 'PID_READY_DELAY_SECONDS must be nonnegative' >&2; exit 2; }
pid=''
for attempt in $(seq 1 "$pid_ready_attempts"); do
  # A cold install can return from am start before its process is visible. pidof
  # legitimately exits nonzero in that interval, so sample it without allowing
  # set -e/pipefail to skip ownership rollback.
  pidof_output="$(adb_device shell pidof "$WRAPPER_PACKAGE" 2>/dev/null || true)"
  pid="$(tr -d '\r' <<< "$pidof_output" | awk 'NF == 1 && $1 ~ /^[0-9]+$/ { print $1 }')"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then break; fi
  pid=''
  [[ "$attempt" == "$pid_ready_attempts" ]] || sleep "$pid_ready_delay_seconds"
done
[[ -n "$pid" ]] || { echo "wrapper process did not appear after ${pid_ready_attempts} pidof attempts for ${WRAPPER_PACKAGE}; am start was issued" >&2; exit 2; }
expected_socket="localabstract:webview_devtools_remote_${pid}"
if tunnel_target forwards "$forward" >/dev/null; then
  if owned_tunnel_matches forwards "$forward" "$expected_socket"; then
    : # A repeat launch in the same process can reuse the verified owned mapping.
  elif prior_target="$(owned_target forwards "$forward")" && owned_tunnel_matches forwards "$forward" "$prior_target"; then
    remove_owned_tunnel forwards "$forward" "$prior_target"
    adb_device forward --no-rebind "$forward" "$expected_socket"
    record_owned forwards "$forward" "$expected_socket"
    created_forward=true
  else
    echo "refusing existing forward $forward; its serial, local endpoint, or target is not owned by this wrapper session" >&2; exit 2
  fi
else
  adb_device forward --no-rebind "$forward" "$expected_socket"
  record_owned forwards "$forward" "$expected_socket"
  created_forward=true
fi
if [[ "$calibration_count" == 3 ]]; then
  output_dir="${COUCHCOOP_ANDROID_WEBVIEW_OUTPUT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.sts2/android-webview-wrapper}"
  mkdir -p "$output_dir"
  report="$output_dir/cdp-calibration-${run_id}.jsonl"
  pid_file="$(state_file calibrator.pid)"
  node "$(dirname "$0")/android-webview-cdp-calibrate.mjs" --endpoint "http://127.0.0.1:${cdp_port}" --url "$url" --viewport-width "$viewport_width" --viewport-height "$viewport_height" --device-scale-factor "$device_scale_factor" --report "$report" --pid-file "$pid_file" --native-width-px "${content_width:-0}" --native-height-px "${content_height:-0}" &
  calibrator_pid=$!
  record_calibrator "$calibrator_pid" "$pid_file"
  created_calibrator=true
fi

for attempt in $(seq 1 "${READY_ATTEMPTS:-20}"); do
  if adb_device logcat --pid "$pid" -d -v epoch -s CouchCoopWebView:I '*:S' |
      grep -F 'ready pageCommitVisible' |
      grep -F "run=${run_id} url=${url}" > /dev/null; then
    trap - EXIT INT TERM
    echo "ready startedHostNs=${started_host_ns} url=$url cdp=http://127.0.0.1:${cdp_port}"
    exit 0
  fi
  sleep 1
done
echo "wrapper did not report pageCommitVisible readiness for run=${run_id} url=${url}" >&2
exit 1
