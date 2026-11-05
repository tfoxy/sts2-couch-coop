#!/usr/bin/env bash
# Self-test for scripts/build-render-stream.sh: it builds the new renderer's parts only when stale, and deploys
# render-capture/ by rename. Synthetic: a throwaway copy of the script beside stub build scripts that count their
# runs, against a throwaway godot-scene-web git repo with the paths the stamps read. No cargo, no cmake, no game.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
real_gsw="${COUCHCOOP_GSW_ROOT:-$(cd "$here/../.." && pwd)/godot-scene-web}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

couch="$tmp/couch"
gsw="$tmp/gsw"
payload="$tmp/payload"
mkdir -p "$couch/scripts/lib" "$couch/eng/render-capture" "$couch/.sts2" "$payload"
cp "$here/build-render-stream.sh" "$couch/scripts/"
cp "$here/lib/render-capture-stamp.sh" "$couch/scripts/lib/"
printf '{"calibration":1}\n' > "$couch/eng/render-capture/calibration-0001.json"

# Stubs: count the run, then write what the real script writes (the capture stub stamps exactly as the real one).
cat > "$couch/scripts/build-render-stream-client.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo core >> "$repo_root/runs"
out="$repo_root/.sts2/render-stream-client-web"; mkdir -p "$out"
printf 'glue\n' > "$out/rs_gsw_wasm_client.js"; printf 'wasm\n' > "$out/rs_gsw_wasm_bg.wasm"
printf '{"rs_core_tree":"%s"}\n' "$(bash "$COUCHCOOP_GSW_ROOT/packages/render-stream-client/scripts/core-tree.sh" "$COUCHCOOP_GSW_ROOT")" > "$out/build.json"
EOF
cat > "$couch/scripts/build-render-capture.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/lib/render-capture-stamp.sh"
echo capture >> "$repo_root/runs"
out="$COUCHCOOP_RENDER_CAPTURE_OUT"; mkdir -p "$out"
calibration="$(render_capture_calibration_source "$repo_root")"
stamp="$(render_capture_stamp "$COUCHCOOP_GSW_ROOT" "$repo_root" "$calibration")"
for name in librender_stream_capture.so render_stream_capture.gdextension librender_stream_net.so; do
  printf '%s %s\n' "$name" "$stamp" > "$out/$name"
done
cp "$calibration" "$out/calibration"
printf '%s\n' "$stamp" > "$out/source-stamp"
EOF
chmod +x "$couch/scripts/"*.sh

# The GSW stand-in: the real core-tree.sh and every path either stamp reads.
mkdir -p "$gsw/packages/render-stream-client/scripts" "$gsw/experiments/render-stream/scripts"
cp "$real_gsw/packages/render-stream-client/scripts/core-tree.sh" "$gsw/packages/render-stream-client/scripts/"
for dir in experiments/render-stream/rs-core experiments/render-stream/web/gsw-rs packages/canvas/rust-draw-list \
  packages/canvas/rust-prototype experiments/render-stream/capture experiments/render-stream/third_party/basis_universal \
  experiments/render-stream/rs-net; do
  mkdir -p "$gsw/$dir"; printf 'src\n' > "$gsw/$dir/file.txt"
done
printf 'build\n' > "$gsw/experiments/render-stream/scripts/build-rs-net.sh"
git -C "$gsw" init -q
git -C "$gsw" -c user.email=t@t -c user.name=t add -A
git -C "$gsw" -c user.email=t@t -c user.name=t commit -qm init

failures=0
run() { COUCHCOOP_GSW_ROOT="$gsw" "$couch/scripts/build-render-stream.sh" --payload "$payload" "$@" 2>/dev/null; }
expect() {
  local label="$1" want_core="$2" want_capture="$3" want_replaced="$4" summary
  : > "$couch/runs"
  summary="$(run)"
  local core capture replaced
  core="$(jq -r .core <<<"$summary")"; capture="$(jq -r .capture <<<"$summary")"
  replaced="$(jq -r .payloadFilesReplaced <<<"$summary")"
  if [[ "$core" == "$want_core" && "$capture" == "$want_capture" && "$replaced" == "$want_replaced" ]] \
    && [[ "$(grep -c core "$couch/runs" || true)" == "$([[ $want_core == built ]] && echo 1 || echo 0)" ]] \
    && [[ "$(grep -c capture "$couch/runs" || true)" == "$([[ $want_capture == built ]] && echo 1 || echo 0)" ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label: core=$core capture=$capture replaced=$replaced runs=$(tr '\n' ' ' < "$couch/runs")" >&2
    failures=$((failures + 1))
  fi
}

expect "first run builds both and deploys four files" built built 4
expect "second run skips both and replaces nothing" skipped skipped 0
for name in librender_stream_capture.so render_stream_capture.gdextension calibration librender_stream_net.so; do
  [[ -s "$payload/render-capture/$name" ]] || { echo "FAIL payload lacks render-capture/$name" >&2; failures=$((failures + 1)); }
done

printf 'edit\n' >> "$gsw/experiments/render-stream/capture/file.txt"
# A rebuild from different sources changes the three built files; the calibration is copied unchanged.
expect "an uncommitted capture edit rebuilds the capture only" skipped built 3
expect "the same dirty content is fresh" skipped skipped 0
printf 'new\n' > "$gsw/experiments/render-stream/rs-net/new.rs"
expect "an untracked net-module file rebuilds the capture" skipped built 3
git -C "$gsw" -c user.email=t@t -c user.name=t add -A
git -C "$gsw" -c user.email=t@t -c user.name=t commit -qm capture
expect "committing it changes the tree ids: rebuild" skipped built 3

printf 'edit\n' >> "$gsw/experiments/render-stream/rs-core/file.txt"
expect "a dirty core path rebuilds the core (a -dirty tree names no exact source)" built skipped 0
expect "and keeps rebuilding while dirty" built skipped 0
git -C "$gsw" -c user.email=t@t -c user.name=t commit -qam core
expect "committed: core rebuilt once" built skipped 0
expect "then fresh" skipped skipped 0

printf '{"calibration":2}\n' > "$couch/eng/render-capture/calibration-0002.json"
expect "a newer calibration record rebuilds the capture" skipped built 4

rm "$couch/.sts2/render-capture/librender_stream_net.so"
expect "a missing staged file rebuilds the capture (same bytes: nothing to redeploy)" skipped built 0

ino_before="$(stat -c %i "$payload/render-capture/librender_stream_capture.so")"
printf 'edit\n' >> "$gsw/experiments/render-stream/third_party/basis_universal/file.txt"
expect "a basis_universal edit rebuilds and redeploys" skipped built 3
ino_after="$(stat -c %i "$payload/render-capture/librender_stream_capture.so")"
if [[ "$ino_before" == "$ino_after" ]]; then
  echo "FAIL a changed library was rewritten in place (a running seat would read the new bytes)" >&2
  failures=$((failures + 1))
else
  echo "ok   a changed library is replaced by rename, never rewritten in place"
fi

: > "$couch/runs"
skipped="$(COUCHCOOP_SKIP_RENDER_STREAM=1 COUCHCOOP_GSW_ROOT="$gsw" "$couch/scripts/build-render-stream.sh" --payload "$payload" 2>/dev/null)"
if [[ "$(jq -r .renderStream <<<"$skipped")" == skipped && ! -s "$couch/runs" ]]; then
  echo "ok   COUCHCOOP_SKIP_RENDER_STREAM=1 builds nothing"
else
  echo "FAIL COUCHCOOP_SKIP_RENDER_STREAM=1: $skipped" >&2
  failures=$((failures + 1))
fi

if (( failures > 0 )); then
  echo "test-build-render-stream: $failures failure(s)" >&2
  exit 1
fi
echo "test-build-render-stream: ok"
