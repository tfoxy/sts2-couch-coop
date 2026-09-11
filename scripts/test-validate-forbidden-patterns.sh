#!/usr/bin/env bash
# Fixture coverage for the source and tracked-artifact checks. No project files are scanned or changed.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
validator="$root/scripts/validate-forbidden-patterns.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/src" "$tmp/frontend" "$tmp/tests" "$tmp/scripts"
git -C "$tmp" init -q

expect_ok() {
  if ! COUCHCOOP_VALIDATE_REPO_ROOT="$tmp" bash "$validator" >/dev/null; then
    echo "expected fixture to pass" >&2
    return 1
  fi
}

expect_failure() {
  local label="$1" expected="$2"
  local output
  if output="$(COUCHCOOP_VALIDATE_REPO_ROOT="$tmp" bash "$validator" 2>&1)"; then
    echo "expected $label fixture to fail" >&2
    return 1
  fi
  grep -Fq "$expected" <<<"$output" || { echo "missing $label diagnostic: $output" >&2; return 1; }
  rm -f "$tmp/src/Bad.cs" "$tmp/frontend/bad.ts" "$tmp/screenshots/frame.png"
}

cat > "$tmp/src/Ordinary.cs" <<'EOF'
// `sts2 game close` is operator documentation, not a runtime invocation.
var sts2 = Sts2Assembly;
class CardPlay { }
EOF
printf '<link rel="manifest" href="/manifest.webmanifest">\n' > "$tmp/frontend/index.html"
expect_ok

printf 'var p = new ProcessStartInfo("sts2");\n' > "$tmp/src/Bad.cs"
expect_failure "CLI invocation" "sts2 CLI runtime invocation"

printf 'class CombatRenderer { }\n' > "$tmp/src/Bad.cs"
expect_failure "renderer scaffold" "screen-specific gameplay renderer scaffold"

printf 'const clip = "capture.webm";\n' > "$tmp/frontend/bad.ts"
expect_failure "artifact reference" "generated asset artifact reference"

mkdir -p "$tmp/screenshots"
touch "$tmp/screenshots/frame.png"
expect_failure "unignored artifact" "generated asset artifacts are not ignored"

developer_home_prefix="/home/"
developer_home_account="user"
printf 'const checkout = "%s%s/repo/project";\n' "$developer_home_prefix" "$developer_home_account" > "$tmp/scripts/private-path.mjs"
git -C "$tmp" add scripts/private-path.mjs
expect_failure "machine-specific developer path" "machine-specific developer path"
git -C "$tmp" rm --cached -q scripts/private-path.mjs
rm -f "$tmp/scripts/private-path.mjs"

echo "validate-forbidden-patterns fixture tests passed"
