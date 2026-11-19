#!/usr/bin/env bash
# Exercise the release/snapshot macOS requirement before any build or network access.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/couch/scripts/lib" "$scratch/bin"
cp "$repo_root/scripts/package-release.sh" "$scratch/couch/scripts/"
cp "$repo_root/scripts/lib/release-"*.sh "$scratch/couch/scripts/lib/"
cat > "$scratch/bin/git" <<'SH'
#!/usr/bin/env bash
# Stop after the macOS preflight, before packaging begins.
printf 'dirty fixture\n'
SH
chmod +x "$scratch/bin/git"
run_reject() {
  local label="$1" needle="$2"; shift 2
  if PATH="$scratch/bin:$PATH" "$@" > "$scratch/$label.log" 2>&1; then
    echo "FAIL: accepted $label" >&2; exit 1
  fi
  grep -Fq "$needle" "$scratch/$label.log"
}
export COUCHCOOP_MACOS_CAPTURE_DIR=
export COUCHCOOP_RELEASE_STAGED=0
run_reject release 'releases require COUCHCOOP_MACOS_CAPTURE_DIR' bash "$scratch/couch/scripts/package-release.sh"
run_reject snapshot 'snapshot omits render-capture/macos/' bash "$scratch/couch/scripts/package-release.sh" --snapshot
export COUCHCOOP_MACOS_CAPTURE_DIR="$scratch/bundle"
mkdir -p "$COUCHCOOP_MACOS_CAPTURE_DIR"
run_reject incomplete 'missing macOS capture file' bash "$scratch/couch/scripts/package-release.sh" --snapshot
bash "$repo_root/scripts/test-build-render-capture-macos.sh" --fixture "$COUCHCOOP_MACOS_CAPTURE_DIR"
run_reject complete 'requires a clean working tree' bash "$scratch/couch/scripts/package-release.sh"
! grep -q 'omits render-capture/macos/' "$scratch/complete.log"
# Execute the packaging licence step with a recorder instead of Cargo or Python.
awk '
  /^# The net module statically links its crates/ { selected = 1; next }
  selected && /^$/ { exit }
  selected { print }
' "$repo_root/scripts/package-release.sh" > "$scratch/net-licenses.sh"
python3() { printf '%s\n' "$@" > "$scratch/license-args"; }
source_parent="$scratch/sources"
license_dir="$scratch/licenses"
macos_capture_dir=
source "$scratch/net-licenses.sh"
[[ "$(wc -l < "$scratch/license-args")" -eq 3 ]]
! grep -Fxq -- --macos "$scratch/license-args"
macos_capture_dir="$scratch/bundle"
source "$scratch/net-licenses.sh"
[[ "$(wc -l < "$scratch/license-args")" -eq 4 ]]
grep -Fxq -- --macos "$scratch/license-args"
echo 'test-package-release-macos: 6 cases passed'
