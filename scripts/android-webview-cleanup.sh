#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/android-webview-lib.sh"
require_live_lock
for kind in forwards reverses; do
  file="$(state_file "$kind")"
  [[ -f "$file" ]] || continue
  while IFS=$'\t' read -r mapping target; do
    [[ -n "$mapping" && -n "$target" ]] || continue
    remove_owned_tunnel "$kind" "$mapping" "$target" || true
  done < "$file"
  rm -f "$file"
done
file="$(state_file calibrators)"
if [[ -f "$file" ]]; then
  while IFS=$'\t' read -r pid pid_file; do
    [[ "$pid" =~ ^[0-9]+$ && -n "$pid_file" ]] || continue
    stop_owned_calibrator "$pid" "$pid_file"
  done < "$file"
  rm -f "$file"
fi
