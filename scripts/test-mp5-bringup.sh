#!/usr/bin/env bash
# Unit-test the two helpers scripts/bring-up-five-player-instance.sh leans on:
#   scripts/lib/mp5-mod-loadout.py     — pins one instance's settings.save to the >4-player QA loadout
#   scripts/lib/mp5-instance-port.py   — resolves that instance's published browser port, and ONLY that
#                                        instance's (the identity check that keeps a probe off the
#                                        operator's own running game)
# Nothing here touches the operator's profile, the game, or an instance: every fixture is synthesized in a
# temp dir, and the only live process is a `sleep` this script spawns itself.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
editor="$repo_root/scripts/lib/mp5-mod-loadout.py"
port_reader="$repo_root/scripts/lib/mp5-instance-port.py"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "test-mp5-bringup: FAIL $*" >&2; exit 1; }

# The shape this machine's profile actually has: couchcoop TWICE (both sources), the workshop cap mods, and
# godotexplorer on. Reproduced literally so a change to the real file cannot quietly change the test.
write_real_shape() {
  python3 - "$1" <<'PY'
import json, sys
settings = {
    "aspect_ratio": "sixteen_by_nine",
    "controller_mapping": {"ui_cancel": "controller_face_button_east", "ui_select": "controller_face_button_south"},
    "mod_settings": {
        "mod_list": [
            {"id": "godotexplorer", "is_enabled": True, "source": "mods_directory"},
            {"id": "spirectlbridge", "is_enabled": True, "source": "mods_directory"},
            {"id": "couchcoop", "is_enabled": True, "source": "mods_directory"},
            {"id": "sts2unlimited", "is_enabled": True, "source": "steam_workshop"},
            {"id": "couchcoop", "is_enabled": True, "source": "steam_workshop"},
            {"id": "STS2-RitsuLib", "is_enabled": False, "source": "steam_workshop"},
            {"id": "STS2-MultiplayerLimitBreak", "is_enabled": False, "source": "steam_workshop"},
        ],
        "mods_enabled": True,
    },
    "window_size": {"X": 1920, "Y": 1016},
}
with open(sys.argv[1], "w", encoding="utf-8") as stream:
    stream.write(json.dumps(settings, indent=2, ensure_ascii=False))
PY
}

# ---------------------------------------------------------------------------------------------------------
# 1. The real shape: exactly the four rows below flip, every `source` survives, nothing is invented.
# ---------------------------------------------------------------------------------------------------------
save="$tmp/settings.save"
write_real_shape "$save"
before="$(cat "$save")"
python3 "$editor" --settings "$save" --json > "$tmp/report.json" 2> "$tmp/report.err" \
  || fail "editor exited non-zero on the real shape: $(cat "$tmp/report.err")"

python3 - "$save" "$tmp/report.json" <<'PY' || exit 1
import json, sys

settings = json.load(open(sys.argv[1], encoding="utf-8"))
report = json.load(open(sys.argv[2], encoding="utf-8"))
rows = settings["mod_settings"]["mod_list"]
got = {(row["id"], row["source"]): row["is_enabled"] for row in rows}
want = {
    ("godotexplorer", "mods_directory"): False,
    ("spirectlbridge", "mods_directory"): True,
    ("couchcoop", "mods_directory"): True,
    ("sts2unlimited", "steam_workshop"): True,
    ("couchcoop", "steam_workshop"): False,
    ("STS2-RitsuLib", "steam_workshop"): False,
    ("STS2-MultiplayerLimitBreak", "steam_workshop"): False,
}
problems = []
if got != want:
    problems.append(f"mod_list mismatch\n  got  {sorted(got.items())}\n  want {sorted(want.items())}")
if len(rows) != 7:
    problems.append(f"row count changed: {len(rows)} (the editor must never add or drop a row)")
if not settings["mod_settings"]["mods_enabled"]:
    problems.append("mods_enabled was not set true")
# Only the two rows that were on and must go off should be reported as changed.
changed = sorted((row["id"], row["source"], row["from"], row["to"]) for row in report["changed"])
want_changed = sorted(
    [
        ("godotexplorer", "mods_directory", True, False),
        ("couchcoop", "steam_workshop", True, False),
    ]
)
if changed != want_changed:
    problems.append(f"changed mismatch\n  got  {changed}\n  want {want_changed}")
if report["unmanaged"]:
    problems.append(f"unexpected unmanaged rows: {report['unmanaged']}")
if not report["wrote"]:
    problems.append("report says nothing was written, but two rows had to flip")
if problems:
    print("test-mp5-bringup: FAIL\n" + "\n".join(problems), file=sys.stderr)
    sys.exit(1)
PY

[ "$before" != "$(cat "$save")" ] || fail "the file did not change at all"

# ---------------------------------------------------------------------------------------------------------
# 2. Idempotent AND byte-stable. A second run must report no change and leave the bytes identical — this is
#    what makes it safe to re-run a bring-up against an instance that is already configured.
# ---------------------------------------------------------------------------------------------------------
after_first="$(cat "$save")"
python3 "$editor" --settings "$save" --json > "$tmp/report2.json" || fail "second run exited non-zero"
[ "$after_first" = "$(cat "$save")" ] || fail "second run rewrote the file (not byte-stable)"
python3 - "$tmp/report2.json" <<'PY' || exit 1
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
if report["changed"] or report["wrote"]:
    print(f"test-mp5-bringup: FAIL second run was not a no-op: {report['changed']}", file=sys.stderr)
    sys.exit(1)
PY

# ---------------------------------------------------------------------------------------------------------
# 3. A required mod with no row is FATAL (exit 3), not a silent four-seat lobby.
# ---------------------------------------------------------------------------------------------------------
python3 - "$tmp/nocap.save" <<'PY'
import json, sys
settings = {"mod_settings": {"mod_list": [
    {"id": "spirectlbridge", "is_enabled": True, "source": "mods_directory"},
    {"id": "couchcoop", "is_enabled": True, "source": "mods_directory"},
], "mods_enabled": True}}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(settings, indent=2))
PY
set +e
python3 "$editor" --settings "$tmp/nocap.save" > /dev/null 2> "$tmp/nocap.err"
rc=$?
set -e
[ "$rc" = "3" ] || fail "a missing sts2unlimited row must exit 3, got $rc"
grep -q "sts2unlimited" "$tmp/nocap.err" || fail "the missing-mod error must name sts2unlimited"

# ---------------------------------------------------------------------------------------------------------
# 4. No `mod_settings` at all is FATAL (exit 2) — an unseeded instance must not launch as if it were fine.
# ---------------------------------------------------------------------------------------------------------
echo '{"aspect_ratio":"sixteen_by_nine"}' > "$tmp/bare.save"
set +e
python3 "$editor" --settings "$tmp/bare.save" > /dev/null 2> "$tmp/bare.err"
rc=$?
set -e
[ "$rc" = "2" ] || fail "settings.save with no mod_settings must exit 2, got $rc"
grep -q "mod_settings" "$tmp/bare.err" || fail "the error must name mod_settings"

# ---------------------------------------------------------------------------------------------------------
# 5. A `couchcoop` row from an unknown source is FATAL, not a coin flip over which build runs.
# ---------------------------------------------------------------------------------------------------------
python3 - "$tmp/oddsource.save" <<'PY'
import json, sys
settings = {"mod_settings": {"mod_list": [
    {"id": "spirectlbridge", "is_enabled": True, "source": "mods_directory"},
    {"id": "couchcoop", "is_enabled": True, "source": "mods_directory"},
    {"id": "couchcoop", "is_enabled": True, "source": "somewhere_else"},
    {"id": "sts2unlimited", "is_enabled": True, "source": "steam_workshop"},
], "mods_enabled": True}}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(settings, indent=2))
PY
set +e
python3 "$editor" --settings "$tmp/oddsource.save" > /dev/null 2> "$tmp/odd.err"
rc=$?
set -e
[ "$rc" = "3" ] || fail "an unknown couchcoop source must exit 3, got $rc"

# ---------------------------------------------------------------------------------------------------------
# 6. An unmanaged mod is left ALONE and warned about — the editor never invents policy for a mod it does not
#    know, but an operator must not miss that it is a variable in the run.
# ---------------------------------------------------------------------------------------------------------
write_real_shape "$tmp/extra.save"
python3 - "$tmp/extra.save" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1], encoding="utf-8"))
settings["mod_settings"]["mod_list"].append({"id": "SomeOtherMod", "is_enabled": True, "source": "steam_workshop"})
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(settings, indent=2, ensure_ascii=False))
PY
python3 "$editor" --settings "$tmp/extra.save" --json > "$tmp/extra.json" 2> "$tmp/extra.err" \
  || fail "an unmanaged mod must not be fatal"
grep -q "WARNING mod 'SomeOtherMod'" "$tmp/extra.err" || fail "an enabled unmanaged mod must warn"
python3 - "$tmp/extra.save" <<'PY' || exit 1
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))["mod_settings"]["mod_list"]
row = next(r for r in rows if r["id"] == "SomeOtherMod")
if row["is_enabled"] is not True or row["source"] != "steam_workshop":
    print(f"test-mp5-bringup: FAIL unmanaged row was modified: {row}", file=sys.stderr)
    sys.exit(1)
PY

# ---------------------------------------------------------------------------------------------------------
# 7. --dry-run reports the change and writes nothing.
# ---------------------------------------------------------------------------------------------------------
write_real_shape "$tmp/dry.save"
dry_before="$(cat "$tmp/dry.save")"
python3 "$editor" --settings "$tmp/dry.save" --dry-run --json > "$tmp/dry.json" || fail "--dry-run exited non-zero"
[ "$dry_before" = "$(cat "$tmp/dry.save")" ] || fail "--dry-run wrote to the file"
python3 - "$tmp/dry.json" <<'PY' || exit 1
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
if not report["changed"] or report["wrote"]:
    print("test-mp5-bringup: FAIL --dry-run report is wrong", file=sys.stderr)
    sys.exit(1)
PY

# ---------------------------------------------------------------------------------------------------------
# 8. Formatting fidelity against the REAL file, read-only: `--dry-run` must reproduce it byte-for-byte, so a
#    no-op run of the editor can never show up as a spurious settings diff. Skipped when it is not there.
# ---------------------------------------------------------------------------------------------------------
real="$HOME/.local/share/SlayTheSpire2/steam"
if [ -d "$real" ]; then
  found=0
  for candidate in "$real"/*/settings.save; do
    [ -f "$candidate" ] || continue
    found=1
    python3 - "$candidate" <<'PY' || exit 1
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
if json.dumps(json.loads(raw), indent=2, ensure_ascii=False) != raw:
    print(
        "test-mp5-bringup: FAIL the real settings.save does not round-trip byte-identically through "
        "json.dumps(indent=2); the editor would reformat the whole file. Check the game's writer.",
        file=sys.stderr,
    )
    sys.exit(1)
PY
  done
  if [ "$found" = "1" ]; then
    echo "test-mp5-bringup: real settings.save round-trips byte-identically"
  fi
fi

# ---------------------------------------------------------------------------------------------------------
# 9. The port reader accepts ONLY a record written by a process running under this instance's XDG_DATA_HOME.
#    A live pid is not enough: the operator's own game is live, and the instance seed copies their
#    browser-port record straight in. The stand-in writer is a `sleep` this script owns.
# ---------------------------------------------------------------------------------------------------------
mine="$tmp/instances/mine/user"
theirs="$tmp/instances/theirs/user"
mkdir -p "$mine" "$theirs"
port_file="$mine/SlayTheSpire2/couch-coop/browser-port"
mkdir -p "$(dirname "$port_file")"

env XDG_DATA_HOME="$mine" sleep 120 &
mine_pid=$!
env XDG_DATA_HOME="$theirs" sleep 120 &
theirs_pid=$!
trap 'kill "$mine_pid" "$theirs_pid" 2>/dev/null || true; rm -rf "$tmp"' EXIT

expect_port() { # <expected stdout, empty for "reject"> <why>
  local want="$1" why="$2" got rc
  set +e
  got="$(python3 "$port_reader" --port-file "$port_file" --user-dir "$mine")"
  rc=$?
  set -e
  if [ -n "$want" ]; then
    [ "$rc" = "0" ] || fail "$why: expected exit 0, got $rc"
    [ "$got" = "$want" ] || fail "$why: expected '$want', got '$got'"
  else
    [ "$rc" = "1" ] || fail "$why: expected exit 1 (reject), got $rc"
    [ -z "$got" ] || fail "$why: expected no output, got '$got'"
  fi
}

printf '{"port":13387,"pid":%s}\n' "$mine_pid" > "$port_file"
expect_port "13387 $mine_pid" "a record written under this instance's XDG_DATA_HOME"

# THE ONE THAT MATTERS: alive, well-formed, and someone else's. `instance-port.mjs`-style liveness would
# accept this and hand the caller a connection to the operator's game.
printf '{"port":13337,"pid":%s}\n' "$theirs_pid" > "$port_file"
expect_port "" "a LIVE record belonging to another user dir"

printf '{"port":13337,"pid":999999}\n' > "$port_file"
expect_port "" "a record whose writer is gone"

printf '{"port":0,"pid":%s}\n' "$mine_pid" > "$port_file"
expect_port "" "port 0"
printf '{"port":70000,"pid":%s}\n' "$mine_pid" > "$port_file"
expect_port "" "a port above 65535"
printf '{"port":"13387","pid":%s}\n' "$mine_pid" > "$port_file"
expect_port "" "a stringly-typed port"
printf '{"pid":%s}\n' "$mine_pid" > "$port_file"
expect_port "" "a record with no port"
printf '{"port":13387,' > "$port_file"
expect_port "" "a half-written record"
rm -f "$port_file"
expect_port "" "no record at all"

# A user dir that is a PREFIX of ours must not match — `<...>/user` vs `<...>/user2`.
printf '{"port":13387,"pid":%s}\n' "$mine_pid" > "$port_file"
set +e
python3 "$port_reader" --port-file "$port_file" --user-dir "${mine}2" > /dev/null
rc=$?
set -e
[ "$rc" = "1" ] || fail "a user dir that merely shares a prefix must be rejected, got $rc"

# ---------------------------------------------------------------------------------------------------------
# 10. `--alive` finds a process by its user dir alone. This is what the bring-up polls instead of `launch.pid`
#     — a detached or re-execed launch leaves that pid dead while the game runs on, and aborting on it would
#     kill a healthy bring-up.
# ---------------------------------------------------------------------------------------------------------
found_pid="$(python3 "$port_reader" --alive --user-dir "$mine")" || fail "--alive did not find the live process"
[ "$found_pid" = "$mine_pid" ] || fail "--alive found pid '$found_pid', expected $mine_pid"

kill "$mine_pid" 2>/dev/null || true
wait "$mine_pid" 2>/dev/null || true
set +e
python3 "$port_reader" --alive --user-dir "$mine" > /dev/null
rc=$?
set -e
[ "$rc" = "1" ] || fail "--alive must exit 1 once nothing runs under the user dir, got $rc"
# ...and the other instance's process must not rescue it.
python3 "$port_reader" --alive --user-dir "$theirs" > /dev/null || fail "--alive lost a process that IS alive"

kill "$theirs_pid" 2>/dev/null || true
trap 'rm -rf "$tmp"' EXIT

echo "test-mp5-bringup: ok"
