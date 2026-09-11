#!/usr/bin/env python3
"""Read ONE instance's published browser port, and prove the process that published it is that instance's.

`COUCHCOOP_PREFERRED_PORT` is a preference: `CouchCoopBrowserServer.StartAsync` walks upward when the port is
taken, so the only trustworthy answer is the one the mod wrote into its own Godot user dir
(`BrowserPortFile`, `user://couch-coop/browser-port` = `{"port":N,"pid":P}`).

WHY THE PID CHECK IS AN IDENTITY CHECK AND NOT A LIVENESS CHECK. `scripts/lib/instance-port.mjs` treats the
pid as proof the record is not stale, which is right for its case. It is NOT enough here. `sts2 --instance`
seeds a new instance's user dir by copying the operator's profile, and that profile contains their RUNNING
game's `browser-port`. A liveness check on that copied record passes — their game is alive — and the caller
then drives the operator's session believing it is its own. So the test is that the writer's own
`XDG_DATA_HOME` is this instance's user dir, which no other process on the box can satisfy.

    python3 scripts/lib/mp5-instance-port.py --port-file <path> --user-dir <instance user dir>
    python3 scripts/lib/mp5-instance-port.py --alive --user-dir <instance user dir>

Prints `<port> <pid>` and exits 0 when the record is this instance's. Prints nothing and exits 1 for every
"not yet / not ours" case, so a caller can poll it in a loop without distinguishing them. Exits 2 only on
misuse.

`--alive` answers "is ANY process still running under this instance's user dir", by the same environ test.
A poller needs it because `launch.pid` is the pid the CLI SPAWNED, which is not necessarily the pid that is
still around minutes later — a launch that detaches, or re-execs, leaves that pid dead while the game runs
fine, and treating it as "the game died" would abort a perfectly good bring-up. The user-dir test has no such
ambiguity: it finds the game whatever its pid turned out to be, and finds nothing when it is really gone.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def _runs_under(pid: int, user_dir: str) -> bool:
    """Is `pid` a process whose own XDG_DATA_HOME is `user_dir`?"""
    try:
        with open("/proc/{0}/environ".format(pid), "rb") as stream:
            environ = stream.read().split(b"\0")
    except OSError:
        # The process is gone, or it is not ours to inspect — neither is this instance's game.
        return False
    return b"XDG_DATA_HOME=" + user_dir.encode() in environ


def any_alive(user_dir: str) -> int | None:
    """The pid of some process running under `user_dir`, or None. Used as "is the instance still up"."""
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if _runs_under(pid, user_dir):
            return pid
    return None


def resolve(port_file: str, user_dir: str) -> tuple[int, int] | None:
    """(port, pid) when `port_file` was written by a process running under `user_dir`, else None."""
    try:
        with open(port_file, encoding="utf-8") as stream:
            record = json.load(stream)
    except (OSError, ValueError):
        # Absent, or caught mid-write. BrowserPortFile writes the file whole, but a reader can still open it
        # between create and write, and "not yet" is not an error worth distinguishing from "not there".
        return None
    if not isinstance(record, dict):
        return None
    port, pid = record.get("port"), record.get("pid")
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port <= 65535:
        return None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    # A hard `game close` leaves the file behind, so a dead writer is the normal case, not the edge one.
    if not _runs_under(pid, user_dir):
        return None
    return port, pid


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Resolve an instance's published browser port.")
    parser.add_argument("--port-file")
    parser.add_argument("--user-dir", required=True, help="the instance's XDG_DATA_HOME, i.e. <instance>/user")
    parser.add_argument("--alive", action="store_true", help="instead, report any live process under --user-dir")
    args = parser.parse_args(argv)

    if args.alive:
        pid = any_alive(args.user_dir)
        if pid is None:
            return 1
        print(pid)
        return 0

    if not args.port_file:
        parser.error("--port-file is required unless --alive is given")
    resolved = resolve(args.port_file, args.user_dir)
    if resolved is None:
        return 1
    print("{0} {1}".format(*resolved))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
