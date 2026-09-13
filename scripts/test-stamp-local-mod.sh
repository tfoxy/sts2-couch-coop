#!/usr/bin/env bash
# Self-test for scripts/stamp-local-mod.sh — the dev-deploy manifest stamp and build-info record.
#
# Hermetic: every case runs against a throwaway mod directory under mktemp -d. No game install is read
# or written, and the repo's own src/CouchCoop.Mod.Loader/couchcoop.json is only ever READ (one case
# asserts that explicitly, because stamping the source manifest instead of the deployed copy would ship
# a 9999.0.0 release).
#
# The MSBuild lane probe inside the stamper is allowed to fail here — it needs a restored project and a
# game install — so the lane assertions accept "unknown". That is the stamper's own documented
# fallback, not a hole in this test: the fields that must be right on every machine are the version,
# the preserved manifest fields and the build-info identity.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"
STAMP="$REPO/scripts/stamp-local-mod.sh"

pass=0; fail=0
eq() { # eq <desc> <want> <got>
  if [ "$2" = "$3" ]; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n        want: %s\n        got:  %s\n' "$1" "$2" "$3" >&2; fi
}
ok() { # ok <desc> <cmd…>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass=$((pass+1))
  else fail=$((fail+1)); printf 'FAIL  %s\n' "$desc" >&2; fi
}
no() { # no <desc> <cmd…>  -- the command must FAIL
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then fail=$((fail+1)); printf 'FAIL  %s (expected failure, got success)\n' "$desc" >&2
  else pass=$((pass+1)); fi
}

command -v jq >/dev/null 2>&1 || { echo "test-stamp-local-mod: jq is required" >&2; exit 1; }

TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT

# A deployed mod dir as `dotnet publish` leaves it: the manifest, plus a file the stamper must not touch.
make_deploy() { # make_deploy <dir> <manifest version>
  local d="$1" version="$2"
  mkdir -p "$d" || return 1
  jq -n --arg v "$version" '{
    id: "couchcoop",
    name: "CouchCoop",
    author: "Tomás Fox",
    description: "Turn phones into browser clients",
    version: $v,
    has_pck: false,
    has_dll: true,
    affects_gameplay: false
  }' > "$d/couchcoop.json" || return 1
  : > "$d/couchcoop.dll"
}

# ---------------------------------------------------------------------------------------------
# 1. The stale manifest is replaced with a version no published Workshop item can beat.
# ---------------------------------------------------------------------------------------------
D1="$TMP/deploy-stale"
make_deploy "$D1" "0.0.0-snapshot.d71b0a1ea465" || exit 1
out1="$("$STAMP" --output "$D1" 2>&1)"
eq "the stamper succeeds on a stale snapshot manifest" 0 "$?"

v1="$(jq -r '.version' "$D1/couchcoop.json")"
case "$v1" in
  9999.0.0+dev.*) pass=$((pass+1)) ;;
  *) fail=$((fail+1)); printf 'FAIL  stamped version is 9999.0.0+dev.<sha>\n        got:  %s\n' "$v1" >&2 ;;
esac

# The failure in the field was a 0.0.0-snapshot losing to a published 0.1.1. Assert the shape that
# makes that impossible rather than just "it changed": MAJOR wins before anything else is compared.
eq "the stamped MAJOR is 9999" "9999" "$(printf '%s' "$v1" | cut -d. -f1)"
ok "the stamped version is no longer the stale one" test "$v1" != "0.0.0-snapshot.d71b0a1ea465"

# SemVer build metadata is ignored in the game's comparison, so the commit rides there and costs
# nothing — and a PRERELEASE (`-snapshot`) would sort BELOW a release, which is how QA got contaminated.
case "$v1" in
  *-*) fail=$((fail+1)); printf 'FAIL  the dev version must not carry a prerelease (it would sort BELOW a release): %s\n' "$v1" >&2 ;;
  *) pass=$((pass+1)) ;;
esac

# ---------------------------------------------------------------------------------------------
# 2. Every other manifest field survives — affects_gameplay above all.
# ---------------------------------------------------------------------------------------------
eq "affects_gameplay stays false (a vanilla Steam friend can still join)" \
  "false" "$(jq -r '.affects_gameplay' "$D1/couchcoop.json")"
eq "the mod id is preserved" "couchcoop" "$(jq -r '.id' "$D1/couchcoop.json")"
eq "the mod name is preserved" "CouchCoop" "$(jq -r '.name' "$D1/couchcoop.json")"
eq "has_dll is preserved" "true" "$(jq -r '.has_dll' "$D1/couchcoop.json")"
eq "no field other than .version changed" \
  "$(jq -S 'del(.version)' <<<'{"id":"couchcoop","name":"CouchCoop","author":"Tomás Fox","description":"Turn phones into browser clients","version":"x","has_pck":false,"has_dll":true,"affects_gameplay":false}')" \
  "$(jq -S 'del(.version)' "$D1/couchcoop.json")"

# ---------------------------------------------------------------------------------------------
# 3. The operator sees the version that was actually written.
# ---------------------------------------------------------------------------------------------
case "$out1" in
  *"deployed mod manifest version: $v1"*) pass=$((pass+1)) ;;
  *) fail=$((fail+1)); printf 'FAIL  the stamper prints the version it wrote\n        got:  %s\n' "$out1" >&2 ;;
esac
case "$out1" in
  *"was 0.0.0-snapshot.d71b0a1ea465"*) pass=$((pass+1)) ;;
  *) fail=$((fail+1)); printf 'FAIL  the stamper names the version it replaced\n        got:  %s\n' "$out1" >&2 ;;
esac

# ---------------------------------------------------------------------------------------------
# 4. build-info.txt: written, JSON, its own schema, and carrying the identity the seat guard compares.
# ---------------------------------------------------------------------------------------------
BI="$D1/build-info.txt"
ok "build-info.txt is written" test -f "$BI"
ok "build-info.txt is JSON" jq -e . "$BI"
eq "build-info.txt declares the LOCAL schema, not the release one" \
  "couchcoop-local-build-info/v1" "$(jq -r '.schemaVersion' "$BI")"
eq "build-info.txt version matches the stamped manifest" "$v1" "$(jq -r '.version' "$BI")"
eq "build-info.txt records the manifest version it replaced" \
  "0.0.0-snapshot.d71b0a1ea465" "$(jq -r '.manifestVersion' "$BI")"
eq "build-info.txt records this checkout's commit" \
  "$(git -C "$REPO" rev-parse HEAD)" "$(jq -r '.sourceCommit' "$BI")"
ok "build-info.txt records the spirectl pin" \
  jq -e '.dependencies.spirectl | type == "string" and length > 0' "$BI"
ok "build-info.txt records the godot-scene-web pin" \
  jq -e '.dependencies.godotSceneWeb | type == "string" and length > 0' "$BI"
ok "build-info.txt records the STS2 API lane slot" \
  jq -e '.dependencies.sts2References.lane | type == "string" and length > 0' "$BI"
ok "build-info.txt records whether the tree was dirty" jq -e '.dirty | type == "boolean"' "$BI"
eq "a dev deploy is never a tagged release" "null" "$(jq -r '.tag' "$BI")"

# It must NOT pass as a release payload: verify-release-archive.sh pins the release schema string, and
# a dev deploy reaching a release gate is the mistake this separate schema prevents.
no "the release archive gate rejects a dev build-info" \
  jq -e '.schemaVersion == "couchcoop-release-build-info/v1"' "$BI"

# ---------------------------------------------------------------------------------------------
# 5. The SOURCE manifest is never stamped — a 9999.0.0 in the repo would ship.
# ---------------------------------------------------------------------------------------------
eq "src/CouchCoop.Mod.Loader/couchcoop.json keeps its real version" \
  "$(git -C "$REPO" show HEAD:src/CouchCoop.Mod.Loader/couchcoop.json | jq -r '.version')" \
  "$(jq -r '.version' "$REPO/src/CouchCoop.Mod.Loader/couchcoop.json")"

# ---------------------------------------------------------------------------------------------
# 6. Re-stamping is idempotent in shape: a second run over an already-stamped deploy still wins.
# ---------------------------------------------------------------------------------------------
"$STAMP" --output "$D1" >/dev/null 2>&1
eq "a second stamp writes the same dev version" "$v1" "$(jq -r '.version' "$D1/couchcoop.json")"
eq "a second stamp's build-info reports the version it found" "$v1" "$(jq -r '.manifestVersion' "$BI")"
eq "affects_gameplay survives a re-stamp" "false" "$(jq -r '.affects_gameplay' "$D1/couchcoop.json")"

# ---------------------------------------------------------------------------------------------
# 7. Refusals: no directory, no manifest.
# ---------------------------------------------------------------------------------------------
no "a missing output directory is refused" "$STAMP" --output "$TMP/does-not-exist"
D2="$TMP/deploy-no-manifest"; mkdir -p "$D2"
no "an output directory with no couchcoop.json is refused" "$STAMP" --output "$D2"
no "no --output is refused" "$STAMP"

printf '\nstamp-local-mod: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
