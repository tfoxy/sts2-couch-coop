#!/usr/bin/env bash
# The dev build's "Use new renderer (Beta)" step (scripts/build-local-mod.sh runs it before the frontend build):
# build what the new renderer needs, ONLY when stale, and optionally deploy the streaming seat's capture into a mod
# payload exactly as scripts/package-release.sh lays it out.
#
#   core     godot-scene-web's render-stream client wasm (scripts/build-render-stream-client.sh, into ignored
#            .sts2/render-stream-client-web/). Fresh when its build.json `rs_core_tree` equals what
#            packages/render-stream-client/scripts/core-tree.sh says for the GSW checkout -- the same verdict the
#            frontend's renderStreamClientAssets() plugin gives. A `-dirty` tree id names no exact source, so a
#            dirty checkout always rebuilds (cargo keeps that cheap when nothing moved).
#   capture  the seat's capture extension, its calibration and the net module (scripts/build-render-capture.sh,
#            into .sts2/render-capture/). Fresh when its `source-stamp` equals render_capture_stamp's
#            (scripts/lib/render-capture-stamp.sh: GSW tree ids plus uncommitted content, this repo's script and
#            calibration).
#
# --payload <dir> then copies render-capture/ (capture, .gdextension, calibration, net module) into <dir>, where
# StreamingSeatLaunch finds it with no operator variable. A file whose bytes are unchanged is left alone; a changed
# one is replaced by rename, never rewritten in place, so a running seat that mapped the old library keeps it.
#
# COUCHCOOP_SKIP_RENDER_STREAM=1 skips all of it: the dev build then carries no new renderer (the panel says so).
# Honours COUCHCOOP_GSW_ROOT like the two build scripts. Prints one JSON summary line on stdout.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/render-capture-stamp.sh
source "$repo_root/scripts/lib/render-capture-stamp.sh"
gsw_root="${COUCHCOOP_GSW_ROOT:-$(cd "$repo_root/.." && pwd)/godot-scene-web}"
core_dir="$repo_root/.sts2/render-stream-client-web"
capture_dir="${COUCHCOOP_RENDER_CAPTURE_OUT:-$repo_root/.sts2/render-capture}"
payload=""

usage() {
  echo "usage: scripts/build-render-stream.sh [--payload <mod dir>]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload) payload="${2:-}"; [[ -n "$payload" ]] || { usage; exit 2; }; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

if [[ "${COUCHCOOP_SKIP_RENDER_STREAM:-}" == "1" ]]; then
  echo "render-stream: skipped (COUCHCOOP_SKIP_RENDER_STREAM=1); this build carries no new renderer" >&2
  printf '{"renderStream":"skipped"}\n'
  exit 0
fi

now_ms() { date +%s%3N; }
started="$(now_ms)"

# --- core -------------------------------------------------------------------------------------------------
core_verdict() {
  local expected built name
  for name in rs_gsw_wasm_client.js rs_gsw_wasm_bg.wasm build.json; do
    [[ -s "$core_dir/$name" ]] || { echo missing; return; }
  done
  expected="$(bash "$gsw_root/packages/render-stream-client/scripts/core-tree.sh" "$gsw_root" 2>/dev/null || true)"
  [[ "$expected" =~ ^[0-9a-f]{12}$ ]] || { echo "unverified:${expected:-none}"; return; }
  built="$(jq -r '.rs_core_tree // empty' "$core_dir/build.json" 2>/dev/null || true)"
  [[ "$built" == "$expected" ]] && echo fresh || echo "stale:${built:-none}->$expected"
}

core_started="$(now_ms)"
core_before="$(core_verdict)"
if [[ "$core_before" == fresh ]]; then
  core_action=skipped
  echo "render-stream: client core fresh ($(jq -r .rs_core_tree "$core_dir/build.json")), not rebuilt" >&2
else
  core_action=built
  echo "render-stream: client core $core_before; building" >&2
  COUCHCOOP_GSW_ROOT="$gsw_root" "$repo_root/scripts/build-render-stream-client.sh" >&2
fi
core_ms=$(( $(now_ms) - core_started ))

# --- capture + net module ---------------------------------------------------------------------------------
capture_started="$(now_ms)"
calibration="$(render_capture_calibration_source "$repo_root" || true)"
want_stamp=""
[[ -n "$calibration" && -s "$calibration" ]] && want_stamp="$(render_capture_stamp "$gsw_root" "$repo_root" "$calibration" || true)"
have_stamp="$(cat "$capture_dir/source-stamp" 2>/dev/null || true)"
capture_complete=1
for name in librender_stream_capture.so render_stream_capture.gdextension calibration librender_stream_net.so; do
  [[ -s "$capture_dir/$name" ]] || capture_complete=0
done
if [[ "$capture_complete" == 1 && -n "$want_stamp" && "$have_stamp" == "$want_stamp" ]]; then
  capture_action=skipped
  echo "render-stream: capture and net module fresh (${want_stamp#* }), not rebuilt" >&2
else
  capture_action=built
  if [[ "$capture_complete" != 1 ]]; then
    echo "render-stream: capture staging incomplete; building" >&2
  else
    echo "render-stream: capture sources changed; building" >&2
  fi
  COUCHCOOP_GSW_ROOT="$gsw_root" COUCHCOOP_RENDER_CAPTURE_OUT="$capture_dir" "$repo_root/scripts/build-render-capture.sh" >&2
fi
capture_ms=$(( $(now_ms) - capture_started ))

# --- deploy -----------------------------------------------------------------------------------------------
deployed=0
if [[ -n "$payload" ]]; then
  target="$payload/render-capture"
  mkdir -p "$target"
  for name in librender_stream_capture.so render_stream_capture.gdextension calibration librender_stream_net.so; do
    if ! cmp -s "$capture_dir/$name" "$target/$name"; then
      cp "$capture_dir/$name" "$target/.$name.tmp.$$"
      mv -f "$target/.$name.tmp.$$" "$target/$name"
      deployed=$(( deployed + 1 ))
    fi
  done
  echo "render-stream: render-capture/ in $target ($deployed file(s) replaced)" >&2
fi

printf '{"renderStream":"ready","core":"%s","coreMs":%d,"capture":"%s","captureMs":%d,"totalMs":%d,"payloadFilesReplaced":%d}\n' \
  "$core_action" "$core_ms" "$capture_action" "$capture_ms" "$(( $(now_ms) - started ))" "$deployed"
