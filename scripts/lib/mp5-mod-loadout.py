#!/usr/bin/env python3
"""Pin ONE instance's STS2 `settings.save` to the >4-player couch-coop QA loadout.

WHY THIS EXISTS AND NOT `game.modLoadout`. The `sts2` CLI can rewrite the enabled-mod list for you, but its
rewrite keys a map by mod ID. This machine's `mod_list` carries `couchcoop` TWICE — once from
`mods_directory` (the local dev deploy) and once from `steam_workshop` (the published build) — so the two
rows collapse into one and both come back out tagged `steam_workshop`. An instance configured that way can
silently run the PUBLISHED mod while you believe you are testing the working tree. So the loadout is applied
here instead, keyed on `(id, source)`, and `game.modLoadout` is left unset in the scratch config.

WHAT IT WILL NOT DO. It never adds a row. STS2's own ModManager owns discovery (SteamUGC plus the install's
`mods/` dir); a row this script invented for a mod the game cannot see is a lie the game will not correct.
It only flips `is_enabled`, and it preserves each row's `source` verbatim. A mod that the loadout requires
ENABLED but that is absent from the file is fatal, because that is exactly the failure this whole bring-up
exists to avoid: with no `sts2unlimited` the lobby caps at four and a five-player run reads as a mod bug.

The file is JSON (Godot `JSON.stringify` with two-space indent and no trailing newline). `json.dumps(...,
indent=2, ensure_ascii=False)` reproduces it byte-for-byte, which `scripts/test-mp5-mod-loadout.sh` asserts,
so a no-op run leaves the file untouched to the byte. The write is atomic (temp file in the same directory,
then `os.replace`) because the game may be holding the path.

    python3 scripts/lib/mp5-mod-loadout.py --settings <path> [--dry-run] [--json]

Exit codes: 0 applied, 2 the file is not a settings.save with a mod list, 3 the loadout cannot be satisfied.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from typing import Any, NamedTuple


class Rule(NamedTuple):
    """One loadout row. `source=None` matches any source for that id."""

    id: str
    source: str | None
    enabled: bool
    why: str


# The QA loadout. Order is documentation only; matching is by id, then by source.
#
# `couchcoop` is the whole reason this table is keyed on source: both rows exist on a developer machine and
# exactly one of them may be enabled. `mods_directory` is the working tree's deploy; `steam_workshop` is
# whatever was last published, which is a different build with a different protocol.
LOADOUT: tuple[Rule, ...] = (
    Rule("spirectlbridge", None, True, "the runtime bridge every sts2 inspection command talks to"),
    Rule("couchcoop", "mods_directory", True, "the LOCAL dev deploy — the build under test"),
    Rule("sts2unlimited", None, True, "raises the lobby cap from lobby init, so >4 seats are offered"),
    Rule("couchcoop", "steam_workshop", False, "the published build; enabled alongside the local one it wins at random"),
    Rule("STS2-MultiplayerLimitBreak", None, False, "the OTHER cap mod — running both rewrites the same wire fields incompatibly"),
    Rule("STS2-RitsuLib", None, False, "not needed by this loadout; fewer mods, fewer variables"),
    Rule("godotexplorer", None, False, "an in-game inspector that costs frames and is not part of the run under test"),
)

REQUIRED_IDS = tuple(sorted({rule.id for rule in LOADOUT if rule.enabled}))


class LoadoutError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def _match(entry_id: str, entry_source: Any) -> Rule | None:
    """The rule governing one `mod_list` row, or None when the loadout does not manage it.

    An exact `(id, source)` rule wins over a wildcard one. An id the loadout names ONLY with sources, hit by
    a row whose source is none of them, is an error rather than an unmanaged row: the only such id is
    `couchcoop`, where guessing would pick the build under test at random.
    """
    candidates = [rule for rule in LOADOUT if rule.id == entry_id]
    if not candidates:
        return None
    for rule in candidates:
        if rule.source is not None and rule.source == entry_source:
            return rule
    for rule in candidates:
        if rule.source is None:
            return rule
    known = sorted(str(rule.source) for rule in candidates)
    raise LoadoutError(
        3,
        f"mod '{entry_id}' has source {entry_source!r}, which the loadout does not name "
        f"(it names {known}). Refusing to guess which build to enable.",
    )


def apply_loadout(settings: dict[str, Any]) -> dict[str, Any]:
    """Mutate `settings` in place to the QA loadout and return a report. Raises LoadoutError."""
    mod_settings = settings.get("mod_settings")
    if not isinstance(mod_settings, dict):
        raise LoadoutError(
            2,
            "settings.save has no `mod_settings` object — the game has never written a mod list here, so "
            "there is nothing to pin and a launch would use whatever the game discovers.",
        )
    mod_list = mod_settings.get("mod_list")
    if not isinstance(mod_list, list) or not mod_list:
        raise LoadoutError(
            2,
            "`mod_settings.mod_list` is missing or empty — the instance user dir was not seeded from a "
            "profile that has seen the mods, so there are no rows to flip.",
        )

    def snapshot() -> list[dict[str, Any]]:
        return [
            {
                "id": entry.get("id"),
                "enabled": bool(entry.get("is_enabled")),
                "source": entry.get("source"),
            }
            for entry in mod_list
            if isinstance(entry, dict)
        ]

    before = snapshot()
    changed: list[dict[str, Any]] = []
    unmanaged: list[dict[str, Any]] = []
    seen_required: set[str] = set()

    for entry in mod_list:
        if not isinstance(entry, dict):
            raise LoadoutError(2, f"`mod_settings.mod_list` holds a non-object row: {entry!r}")
        entry_id = entry.get("id")
        if not isinstance(entry_id, str):
            raise LoadoutError(2, f"`mod_settings.mod_list` row has no string `id`: {entry!r}")
        rule = _match(entry_id, entry.get("source"))
        if rule is None:
            unmanaged.append(
                {"id": entry_id, "source": entry.get("source"), "enabled": bool(entry.get("is_enabled"))}
            )
            continue
        if rule.enabled:
            seen_required.add(rule.id)
        was = bool(entry.get("is_enabled"))
        if was != rule.enabled:
            changed.append(
                {
                    "id": entry_id,
                    "source": entry.get("source"),
                    "from": was,
                    "to": rule.enabled,
                    "why": rule.why,
                }
            )
        # ONLY `is_enabled`. `source` identifies which copy of a mod the row is and is never rewritten.
        entry["is_enabled"] = rule.enabled

    missing = [mod_id for mod_id in REQUIRED_IDS if mod_id not in seen_required]
    if missing:
        raise LoadoutError(
            3,
            "the loadout requires these mods enabled but settings.save has no row for them: "
            + ", ".join(missing)
            + ". Rows are discovered by the game (SteamUGC + the install's mods/ dir), so this script will "
            "not invent them — subscribe/deploy the mod and re-seed the instance instead.",
        )

    mods_enabled_before = bool(mod_settings.get("mods_enabled"))
    if not mods_enabled_before:
        changed.append(
            {"id": "*", "source": None, "from": False, "to": True, "why": "mod_settings.mods_enabled"}
        )
    mod_settings["mods_enabled"] = True

    return {
        "modsEnabled": {"before": mods_enabled_before, "after": True},
        "modList": {"before": before, "after": snapshot()},
        "changed": changed,
        "unmanaged": unmanaged,
    }


def write_atomic(path: str, text: str) -> None:
    """Replace `path` in one rename, so a reader never sees a half-written settings.save."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".mp5-mod-loadout.", suffix=".tmp", delete=False
    )
    try:
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(handle.name, mode)
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Pin one instance's settings.save to the >4-player QA loadout.")
    parser.add_argument("--settings", required=True, help="path to the instance's steam/<id>/settings.save")
    parser.add_argument("--dry-run", action="store_true", help="report the change without writing it")
    parser.add_argument("--json", action="store_true", help="print the report as JSON on stdout")
    args = parser.parse_args(argv)

    try:
        with open(args.settings, encoding="utf-8") as stream:
            raw = stream.read()
    except OSError as error:
        print(f"mp5-mod-loadout: cannot read {args.settings}: {error}", file=sys.stderr)
        return 2
    try:
        settings = json.loads(raw)
    except ValueError as error:
        print(f"mp5-mod-loadout: {args.settings} is not JSON: {error}", file=sys.stderr)
        return 2
    if not isinstance(settings, dict):
        print(f"mp5-mod-loadout: {args.settings} is not a settings.save object", file=sys.stderr)
        return 2

    try:
        report = apply_loadout(settings)
    except LoadoutError as error:
        print(f"mp5-mod-loadout: {args.settings}: {error}", file=sys.stderr)
        return error.code

    report["settingsFile"] = os.path.abspath(args.settings)
    report["dryRun"] = bool(args.dry_run)
    updated = json.dumps(settings, indent=2, ensure_ascii=False)
    report["wrote"] = not args.dry_run and updated != raw

    for row in report["unmanaged"]:
        if row["enabled"]:
            print(
                f"mp5-mod-loadout: WARNING mod '{row['id']}' ({row['source']}) is enabled and the loadout "
                "does not manage it; it is left alone and is a variable in this run.",
                file=sys.stderr,
            )

    if not args.dry_run and updated != raw:
        write_atomic(args.settings, updated)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for row in report["changed"]:
            print(f"mp5-mod-loadout: {row['id']} ({row['source']}) {row['from']} -> {row['to']}")
        if not report["changed"]:
            print("mp5-mod-loadout: already on the QA loadout, nothing changed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
