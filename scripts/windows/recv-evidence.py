#!/usr/bin/env python3
"""One-shot HTTP PUT receiver, for getting an evidence bundle off a Windows QA box.

Why this exists even though SSH usually works: inbound connections to a Windows machine are blocked by
default, and a stock box with no allow rule for port 22 refuses every attempt while its OUTBOUND path
is wide open. So when you cannot reach in, have Windows push instead -- one line, no install:

    Invoke-WebRequest -Uri http://<this-host>:<port>/<name>.zip -Method Put -InFile <zip> -UseBasicParsing

Run this first, on the Linux side:

    recv-evidence.py --bind 192.0.2.10 --port 8099 --out-dir ./evidence

Both --bind and --port are required on purpose. A receiver that defaults to 0.0.0.0 is one typo away
from listening on every interface a workstation has, and the bind address is local state that has no
business being a default in a committed script.

It accepts exactly one upload, writes it, prints the path and size, and exits. No auth, no TLS: it is
meant to be up for the seconds an upload takes, on a LAN you control.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB: a full crash dump is large, a typo should still not fill the disk.

_state: dict[str, object] = {"done": False, "out_dir": ".", "max_bytes": MAX_BYTES}


def safe_name(raw: str) -> str:
    """Reduce the request path to a bare filename. Never trust a remote-supplied path."""
    base = os.path.basename(raw.lstrip("/")) or "evidence.bin"
    base = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    # Defuse leading dots so the result cannot be "..", ".", or a hidden file.
    base = base.lstrip(".") or "evidence.bin"
    return base[:200]


class Receiver(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:  # quieter default logging
        sys.stderr.write("  %s - %s\n" % (self.client_address[0], fmt % args))

    def _refuse(self, code: int, message: str) -> None:
        body = (message + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's naming
        if _state["done"]:
            self._refuse(409, "already received one upload")
            return

        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            # Refuse rather than guess: without a length there is no way to know the upload completed,
            # and a truncated dump that looks complete is worse than no dump.
            self._refuse(411, "Content-Length required")
            return

        try:
            length = int(raw_length)
        except ValueError:
            self._refuse(400, "bad Content-Length")
            return

        if length < 0 or length > int(_state["max_bytes"]):
            self._refuse(413, f"refusing {length} bytes (limit {_state['max_bytes']})")
            return

        name = safe_name(self.path)
        dest = os.path.join(str(_state["out_dir"]), name)

        remaining = length
        written = 0
        try:
            with open(dest, "wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 256, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
                    written += len(chunk)
        except OSError as exc:
            self._refuse(500, f"write failed: {exc}")
            return

        if written != length:
            # Report the truncation instead of accepting it silently.
            self._refuse(400, f"truncated: got {written} of {length} bytes (kept at {dest})")
            print(f"\n  TRUNCATED: {dest} ({written} of {length} bytes)", file=sys.stderr)
            _state["done"] = True
            return

        self._refuse(201, "ok")
        mb = written / (1024 * 1024)
        print(f"\n  received: {dest} ({mb:.2f} MB)")
        _state["done"] = True

    def do_POST(self) -> None:  # noqa: N802 - accept POST as well, same handling
        self.do_PUT()

    def do_GET(self) -> None:  # noqa: N802 - a liveness probe, so you can confirm reachability first
        self._refuse(200, "recv-evidence.py is listening; PUT your file here")


def main() -> int:
    parser = argparse.ArgumentParser(description="One-shot HTTP PUT receiver for QA evidence bundles.")
    parser.add_argument("--bind", required=True, help="address to listen on (required; no default)")
    parser.add_argument("--port", required=True, type=int, help="port to listen on (required; no default)")
    parser.add_argument("--out-dir", default=".", help="directory to write the upload into")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES, help="refuse uploads larger than this")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    _state["out_dir"] = out_dir
    _state["max_bytes"] = args.max_bytes

    server = HTTPServer((args.bind, args.port), Receiver)
    print(f"  listening on http://{args.bind}:{args.port}/  -> {out_dir}")
    print("  on Windows:")
    print(
        f"    Invoke-WebRequest -Uri http://{args.bind}:{args.port}/evidence.zip "
        "-Method Put -InFile <zip> -UseBasicParsing"
    )
    print("  waiting for one upload (Ctrl-C to give up)...")

    try:
        while not _state["done"]:
            server.handle_request()
    except KeyboardInterrupt:
        print("\n  cancelled", file=sys.stderr)
        return 130
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
