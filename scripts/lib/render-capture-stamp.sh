#!/usr/bin/env bash
# The source stamp of a staged render-stream capture (scripts/build-render-capture.sh): one sha256 over every
# input that changes the staged files, so scripts/build-render-stream.sh can skip a build whose stamp still
# matches. Sourced, not run.
#
# Inputs, in order:
#   - the git tree ids at HEAD of godot-scene-web's capture sources (capture/, third_party/basis_universal/ it
#     compiles in), the net module (rs-net/, its vendored wtransport included) and build-rs-net.sh;
#   - a hash of their uncommitted state (`git diff HEAD --binary`, then every untracked, unignored file), so a
#     dirty GSW checkout is stamped by its content rather than by HEAD alone;
#   - this repo's build-render-capture.sh and the calibration records it stages.
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
  local gsw_root="$1" repo_root="$2" calibration="$3" target="${4:-linux}" digest
  digest="$(set -o pipefail; render_capture_stamp_inputs "$gsw_root" "$repo_root" "$calibration" "$target" | sha256sum)" || return 1
  printf 'render-capture-stamp/1 %s\n' "${digest%% *}"
}

# The stamp's input lines (see the header), for render_capture_stamp and for a reader asking why it changed.
render_capture_stamp_inputs() {
  local gsw_root="$1" repo_root="$2" calibration="$3" target="${4:-linux}" path id untracked diff_hash
  local paths=("${render_capture_gsw_paths[@]}")
  if [[ "$target" == windows ]]; then
    paths+=(experiments/render-stream/scripts/lib/llvm-mingw.sh experiments/render-stream/scripts/w-imports.py)
  fi
  printf 'target %s\n' "$target"
  for path in "${paths[@]}"; do
    id="$(git -C "$gsw_root" rev-parse "HEAD:$path")" || return 1
    printf '%s %s\n' "$id" "$path"
  done
  diff_hash="$(set -o pipefail; git -C "$gsw_root" diff HEAD --binary -- "${paths[@]}" | sha256sum)" || return 1
  printf 'diff %s\n' "${diff_hash%% *}"
  while IFS= read -r -d '' untracked; do
    printf 'untracked %s %s\n' "$(sha256sum < "$gsw_root/$untracked" | cut -d' ' -f1)" "$untracked"
  done < <(git -C "$gsw_root" ls-files -z --others --exclude-standard -- "${paths[@]}")
  printf 'script %s\n' "$(sha256sum < "$repo_root/scripts/build-render-capture.sh" | cut -d' ' -f1)"
  if [[ "$target" == windows ]]; then
    for path in "$repo_root"/eng/render-capture/windows/*.json; do
      [[ -f "$path" ]] || continue
      printf 'record %s %s\n' "$(basename "$path")" "$(sha256sum < "$path" | cut -d' ' -f1)"
    done
  else
    printf 'staging %s\n' "$(sha256sum < "$repo_root/scripts/lib/render-capture-stamp.sh" | cut -d' ' -f1)"
    for path in "$repo_root"/eng/render-capture/linux/*.json; do
      [[ -f "$path" ]] || continue
      printf 'record %s %s\n' "$(basename "$path")" "$(sha256sum < "$path" | cut -d' ' -f1)"
    done
    if [[ -n "$calibration" ]]; then
      [[ -s "$calibration" ]] || return 1
      printf 'calibration %s\n' "$(sha256sum < "$calibration" | cut -d' ' -f1)"
    fi
  fi
}

# Optional extra Linux record for development; committed candidates are always staged as well.
render_capture_calibration_source() {
  printf '%s\n' "${COUCHCOOP_RENDER_CAPTURE_CALIBRATION_SOURCE:-}"
}

# STS2 treats *.json as manifests, so candidates have extensionless lane names.
render_capture_stage_linux_records() {
  local repo_root="$1" out="$2" calibration="$3" record count=0
  if [[ -n "$calibration" && ! -s "$calibration" ]]; then
    echo "capture calibration source is missing: $calibration" >&2; return 1
  fi
  rm -f "$out/calibration" "$out"/calibration.*
  for record in "$repo_root"/eng/render-capture/linux/*.json; do
    [[ -f "$record" && "$record" != *.source.json ]] || continue
    cp "$record" "$out/calibration.$(basename "$record" .json)"
    count=$((count + 1))
  done
  [[ "$count" -gt 0 ]] || { echo 'no committed Linux capture records' >&2; return 1; }
  if [[ -n "$calibration" ]]; then cp "$calibration" "$out/calibration.0-operator"; fi
}
