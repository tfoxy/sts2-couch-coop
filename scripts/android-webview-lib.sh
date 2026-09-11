#!/usr/bin/env bash
set -euo pipefail

readonly WRAPPER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../tools/android-webview-wrapper" && pwd)"
readonly WRAPPER_PACKAGE='coop.couch.webview'
readonly WRAPPER_ACTIVITY='coop.couch.webview/.MainActivity'
readonly EXTRA_URL='coop.couch.webview.URL'
readonly WRAPPER_STATE_DIR="${COUCHCOOP_ANDROID_WEBVIEW_STATE_DIR:-${TMPDIR:-/tmp}/couchcoop-android-webview}"
readonly LIVE_LOCK_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/live-qa-lock.mjs"

require_live_lock() {
  local expected_owner expected_pid
  require_serial
  expected_owner="${COUCHCOOP_LIVEQA_OWNER:?Set the live-QA owner supplied by the coordinator.}"
  expected_pid="${COUCHCOOP_LIVEQA_PID:?Set the live-QA owner PID supplied by the coordinator.}"
  node "$LIVE_LOCK_HELPER" assert --owner "$expected_owner" --pid "$expected_pid" \
    --resource shared:install --resource "exclusive:android:${ADB_SERIAL}" || {
      echo "Android WebView lease does not cover ${ADB_SERIAL} for ${expected_owner} (${expected_pid})." >&2; exit 2;
    }
}

require_live_resource() {
  node "$LIVE_LOCK_HELPER" assert \
    --owner "${COUCHCOOP_LIVEQA_OWNER:?}" --pid "${COUCHCOOP_LIVEQA_PID:?}" \
    --resource "${1:?live-QA resource is required}"
}

require_serial() { : "${ADB_SERIAL:?Set ADB_SERIAL to the device serial selected by the coordinator.}"; }
adb_device() { require_serial; adb -s "$ADB_SERIAL" "$@"; }
state_file() {
  require_serial
  local safe_serial safe_owner
  safe_serial="${ADB_SERIAL//[^A-Za-z0-9_.-]/_}"
  safe_owner="${COUCHCOOP_LIVEQA_PID:?}"
  mkdir -p "$WRAPPER_STATE_DIR/$safe_serial/$safe_owner"
  printf '%s/%s/%s/%s\n' "$WRAPPER_STATE_DIR" "$safe_serial" "$safe_owner" "$1"
}

record_owned() {
  local kind=$1 mapping=$2 target=${3:?owned tunnel target is required} file
  file="$(state_file "$kind")"
  # Replace a stale record for this local endpoint; a ledger entry always names
  # the exact remote target that this session created.
  [[ -f "$file" ]] && awk -F '\t' -v mapping="$mapping" '$1 != mapping' "$file" > "${file}.next" || true
  [[ -f "${file}.next" ]] && mv "${file}.next" "$file"
  printf '%s\t%s\n' "$mapping" "$target" >> "$file"
}

owned_target() {
  local kind=$1 mapping=$2 file
  file="$(state_file "$kind")"
  [[ -f "$file" ]] || return 1
  awk -F '\t' -v mapping="$mapping" '$1 == mapping { if (++found > 1) exit 2; print $2 } END { exit found == 1 ? 0 : 1 }' "$file"
}

tunnel_command() {
  case "$1" in forwards) printf 'forward\n' ;; reverses) printf 'reverse\n' ;; *) return 2 ;; esac
}

tunnel_target() {
  local kind=$1 mapping=$2 command target
  command="$(tunnel_command "$kind")" || return $?
  # reverse --list is already device-scoped by -s; its first field is a transport name (e.g. UsbFfs), not the serial.
  target="$(adb_device "$command" --list | awk -v serial="$ADB_SERIAL" -v kind="$kind" -v mapping="$mapping" '(kind == "reverses" || $1 == serial) && $2 == mapping { if (++found > 1) exit 2; target=$3 } END { if (found == 1) print target; else exit found > 1 ? 2 : 1 }')" || return $?
  [[ -n "$target" ]] || return 1
  printf '%s\n' "$target"
}

owned_tunnel_matches() {
  local kind=$1 mapping=$2 expected=$3 recorded actual
  recorded="$(owned_target "$kind" "$mapping")" || return 1
  [[ "$recorded" == "$expected" ]] || return 1
  actual="$(tunnel_target "$kind" "$mapping")" || return 1
  [[ "$actual" == "$expected" ]]
}

remove_owned_tunnel() {
  local kind=$1 mapping=$2 expected=$3 command
  command="$(tunnel_command "$kind")" || return $?
  # Never remove a replacement that was installed after our ledger entry.
  if owned_tunnel_matches "$kind" "$mapping" "$expected"; then
    adb_device "$command" --remove "$mapping"
  fi
  forget_owned "$kind" "$mapping"
}

record_calibrator() { printf '%s\t%s\n' "${1:?calibrator pid is required}" "${2:?calibrator pid-file is required}" >> "$(state_file calibrators)"; }

stop_owned_calibrator() {
  local pid=$1 pid_file=$2 command
  [[ "$pid" =~ ^[0-9]+$ && -r "$pid_file" ]] || return 0
  [[ "$(tr -d '[:space:]' < "$pid_file" 2>/dev/null || true)" == "$pid" ]] || return 0
  command="$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  grep -Eq '/android-webview-cdp-calibrate\.mjs$' <<<"$command" || return 0
  grep -Fqx -- '--pid-file' <<<"$command" || return 0
  grep -Fqx -- "$pid_file" <<<"$command" || return 0
  kill "$pid" 2>/dev/null || true
}
forget_owned() {
  local file replacement
  file="$(state_file "$1")"
  [[ -f "$file" ]] || return 0
  replacement="${file}.next"
  awk -F '\t' -v mapping="$2" '$1 != mapping' "$file" > "$replacement"
  mv "$replacement" "$file"
}

shell_quote() {
  local value=$1
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

with_mise_android() { mise exec -- "$@"; }
