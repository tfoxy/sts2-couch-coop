#!/usr/bin/env bash
# The source stamp of a staged render-stream capture (scripts/build-render-capture.sh): one sha256 over every
# input that changes the four staged files, so scripts/build-render-stream.sh can skip a build whose stamp still
# matches. Sourced, not run.
#
# Inputs, in order:
#   - the git tree ids at HEAD of godot-scene-web's capture sources (capture/, third_party/basis_universal/ it
#     compiles in), the net module (rs-net/, its vendored wtransport included) and build-rs-net.sh;
#   - a hash of their uncommitted state (`git diff HEAD --binary`, then every untracked, unignored file), so a
#     dirty GSW checkout is stamped by its content rather than by HEAD alone;
#   - this repo's build-render-capture.sh and the calibration record it stages.
# Ignored output (capture/build/, rs-net/target/) is outside git's view and so outside the stamp.

render_capture_gsw_paths=(
  experiments/render-stream/capture
  experiments/render-stream/third_party/basis_universal
  experiments/render-stream/rs-net
  experiments/render-stream/scripts/build-rs-net.sh
)

# render_capture_stamp <gsw_root> <couch_repo_root> <calibration_file>: prints `render-capture-stamp/1 <sha256>`,
# or fails when the GSW checkout's git state cannot be read (the caller then rebuilds).
render_capture_stamp() {
  local gsw_root="$1" repo_root="$2" calibration="$3" digest
  digest="$(set -o pipefail; render_capture_stamp_inputs "$gsw_root" "$repo_root" "$calibration" | sha256sum)" || return 1
  printf 'render-capture-stamp/1 %s\n' "${digest%% *}"
}

# The stamp's input lines (see the header), for render_capture_stamp and for a reader asking why it changed.
render_capture_stamp_inputs() {
  local gsw_root="$1" repo_root="$2" calibration="$3" path id untracked diff_hash
  for path in "${render_capture_gsw_paths[@]}"; do
    id="$(git -C "$gsw_root" rev-parse "HEAD:$path")" || return 1
    printf '%s %s\n' "$id" "$path"
  done
  diff_hash="$(set -o pipefail; git -C "$gsw_root" diff HEAD --binary -- "${render_capture_gsw_paths[@]}" | sha256sum)" || return 1
  printf 'diff %s\n' "${diff_hash%% *}"
  while IFS= read -r -d '' untracked; do
    printf 'untracked %s %s\n' "$(sha256sum < "$gsw_root/$untracked" | cut -d' ' -f1)" "$untracked"
  done < <(git -C "$gsw_root" ls-files -z --others --exclude-standard -- "${render_capture_gsw_paths[@]}")
  printf 'script %s\n' "$(sha256sum < "$repo_root/scripts/build-render-capture.sh" | cut -d' ' -f1)"
  [[ -s "$calibration" ]] || return 1
  printf 'calibration %s\n' "$(sha256sum < "$calibration" | cut -d' ' -f1)"
}

# The calibration record build-render-capture.sh stages: COUCHCOOP_RENDER_CAPTURE_CALIBRATION_SOURCE, else the
# newest committed eng/render-capture/calibration-*.json.
render_capture_calibration_source() {
  local repo_root="$1"
  if [[ -n "${COUCHCOOP_RENDER_CAPTURE_CALIBRATION_SOURCE:-}" ]]; then
    printf '%s\n' "$COUCHCOOP_RENDER_CAPTURE_CALIBRATION_SOURCE"
    return 0
  fi
  ls "$repo_root"/eng/render-capture/calibration-*.json 2>/dev/null | LC_ALL=C sort | tail -n 1
}
