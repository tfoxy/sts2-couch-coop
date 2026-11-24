"""Dependency-free loopback WebSocket host for the pack's control contract."""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import unittest
from urllib.parse import parse_qs, urlsplit

EDITOR, PROJECT, OUTPUT = sys.argv[1:]
TOKEN = "abcdef0123456789" * 4
# The real host emits Convert.ToHexString (upper case); the pack must accept it.
SEAT = "0123456789ABCDEF" * 2
SELECTORS = dict(staticBg=["0"], cardFlight=["1"], handTween=["1"], trailDrive=["0"])


async def send(writer, message):
    data = json.dumps(message).encode()
    header = bytes([0x81, len(data)]) if len(data) < 126 else b"\x81\x7e" + struct.pack("!H", len(data))
    writer.write(header + data)
    await writer.drain()


async def receive(reader):
    first, second = await reader.readexactly(2)
    if first & 15 == 8:
        raise EOFError("WebSocket closed")
    assert first == 0x81 and second & 128, "expected masked JSON text frame"
    size = second & 127
    if size == 126:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4)
    data = await reader.readexactly(size)
    text = bytes(byte ^ mask[i % 4] for i, byte in enumerate(data)).decode()
    return json.loads(text), text


def session(epoch, ready=True, access=True, descriptor=False):
    message = dict(type="session", hostAccess=dict(allowed=access, reason="allowed" if access else "menu-open"),
                   rendererState=dict(state="armed", presentationEpoch=epoch, presentationReady=ready,
                                      presentationWidth=1920, presentationHeight=1080))
    if descriptor:
        message["renderStream"] = dict(url="/render-stream", resourceBase="/resources", token=TOKEN,
                                       protocol=19, presentation=[1920, 1080])
    return message


class ControlContract(unittest.TestCase):
    def run_scenario(self, scenario, env_overrides=None, args=(), log_name=None):
        return asyncio.run(self.scenario(scenario, env_overrides or {}, args, log_name or scenario))

    async def scenario(self, scenario, env_overrides, args, log_name):
        messages, raw_inputs, writers, tasks = [], [], [], []
        errors = []
        control_writer = None
        presented = asyncio.Event()

        async def handle(reader, writer):
            nonlocal control_writer
            writers.append(writer)
            try:
                request = (await reader.readuntil(b"\r\n\r\n")).decode()
                lines = request.split("\r\n")
                route = urlsplit(lines[0].split()[1])
                self.assertEqual(route.path, "/ws")
                query = parse_qs(route.query)
                for key, value in SELECTORS.items():
                    self.assertEqual(query.pop(key), value)
                seat = query.pop("seat", None)
                # The real host requires every selector even on coordination-only sockets.
                self.assertEqual(query.pop("watch"), ["1"] if seat else ["0"])
                if seat:
                    self.assertEqual(seat, [SEAT])
                    self.assertRegex(query.pop("rendererPage")[0], r"^[0-9a-f]{32}$")
                self.assertEqual(query, {})
                headers = dict(line.split(": ", 1) for line in lines[1:] if ": " in line)
                self.assertFalse(any(key.lower() == "origin" for key in headers))
                key = next(value for key, value in headers.items() if key.lower() == "sec-websocket-key")
                accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                await writer.drain()
                # A non-watching control socket receives sessions, never scene-deltas.
                await send(writer, dict(type="session"))
                message, _ = await receive(reader)
                messages.append(message)
                if not seat:
                    control_writer = writer
                    self.assertEqual(message, dict(type="join", rendererProtocol=2, requestId="join:1", name="Offline player"))
                    if scenario == "rejection":
                        await send(writer, dict(type="session", requestId="join:1", joinRejection="no-free-instance", joinRejectionDetail=TOKEN))
                        return
                    route = "/ws?seat=" + SEAT if scenario != "invalid-route" else "ws://untrusted.test/ws?seat=" + SEAT
                    await send(writer, dict(type="session", requestId="join:1", connectionAttemptId="attempt-1", headlessMirrorPath=route))
                    if scenario == "invalid-route":
                        return
                    message, _ = await receive(reader)
                    messages.append(message)
                    self.assertEqual(message, dict(type="client-frame-presented", attemptId="attempt-1"))
                    presented.set()
                    # Keep reading: a duplicate receipt or input on the control socket is a failure.
                    try:
                        extra, _ = await receive(reader)
                        self.fail("Unexpected control message: " + str(extra.get("type")))
                    except (EOFError, asyncio.IncompleteReadError):
                        return
                else:
                    self.assertIsNotNone(control_writer)
                    self.assertFalse(control_writer.is_closing())
                    self.assertEqual(message, dict(type="renderer", rendererProtocol=2, renderer="stream", aspect=1.6))
                    self.assertFalse(presented.is_set(), "receipt before the simulated first frame")
                    await send(writer, session(41, ready=False, descriptor=True))
                    await presented.wait()
                    # The first synthetic tap was unready and must not have sent any input.
                    await send(writer, session(42))
                    for epoch in [42, 43]:
                        for pressed in [True, False]:
                            message, raw = await receive(reader)
                            sequence = len(raw_inputs) + 1
                            self.assertEqual(message, dict(type="input", requestId=f"input:{sequence}", kind="click",
                                                           button="left", pressed=pressed, coordX=812, coordY=640,
                                                           presentationEpoch=epoch))
                            messages.append(message)
                            raw_inputs.append(raw)
                        if epoch == 42:
                            # Stale and access-denied sessions must not create input.
                            await send(writer, session(41))
                            await send(writer, session(43, access=False))
                            await send(writer, session(43))
                    await send(writer, dict(type="input-result", requestId="input:4", success=False,
                                           code="access-denied", message=TOKEN))
                    try:
                        await receive(reader)
                        self.fail("Unexpected extra seat message")
                    except (EOFError, asyncio.IncompleteReadError):
                        pass
            except Exception as error:
                errors.append(error)

        async def connected(reader, writer):
            task = asyncio.create_task(handle(reader, writer))
            tasks.append(task)

        server = await asyncio.start_server(connected, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        env = {key: value for key, value in os.environ.items()
               if key not in ["DISPLAY", "WAYLAND_DISPLAY", "COUCH_PACK_DIAGNOSTICS"]}
        env.update(COUCH_HOST_ORIGIN=f"http://127.0.0.1:{port}", COUCH_PLAYER_NAME=" Offline player ")
        env.update(env_overrides)
        process = await asyncio.create_subprocess_exec(EDITOR, "--headless", "--path", PROJECT, "--script",
                                                       "res://tests/offline.gd", "--", *args, env=env,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            log, _ = await asyncio.wait_for(process.communicate(), 20)
            text = log.decode()
            self.assertNotIn(TOKEN, text, "credential leaked in Godot logs")
            (Path(OUTPUT) / f"offline-{log_name}.log").write_text(text)
            if errors:
                raise errors[0]
            self.assertEqual(process.returncode, 0, text)
            self.assertNotIn("SCRIPT ERROR", text, text)
            self.assertNotIn("ERROR:", text, text)
            if scenario == "flow":
                self.assertIn("[offline] input-result: access-denied", text)
                self.assertEqual([m["type"] for m in messages], ["join", "renderer", "client-frame-presented"] + ["input"] * 4)
                (Path(OUTPUT) / "inputs.json").write_text(json.dumps(raw_inputs, indent=2) + "\n")
            else:
                self.assertIn("Join rejected" if scenario == "rejection" else "Invalid seat route", text)
                self.assertEqual(len(messages), 1)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            server.close()
            for writer in writers:
                writer.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await server.wait_closed()
        if errors:
            raise errors[0]
        return text

    def test_control_sequence_and_epoch_gates(self):
        text = self.run_scenario("flow")
        self.assertNotIn(" recv type=", text)
        self.assertNotIn("[couch-pack] input-result:", text)

    def test_diagnostics_environment_opt_in(self):
        text = self.run_scenario("flow", {"COUCH_PACK_DIAGNOSTICS": "1"}, log_name="diagnostics-env")
        self.assertIn("[couch-pack] control recv type=session bytes=", text)
        self.assertIn("[couch-pack] seat recv type=input-result bytes=", text)
        self.assertIn("[couch-pack] input-result: access-denied", text)

    def test_diagnostics_argument_opt_in(self):
        text = self.run_scenario("flow", args=["--rs-env=COUCH_PACK_DIAGNOSTICS=1"], log_name="diagnostics-arg")
        self.assertIn("[couch-pack] control recv type=session bytes=", text)
        self.assertIn("[couch-pack] seat recv type=input-result bytes=", text)

    def test_join_rejection(self):
        self.run_scenario("rejection")

    def test_rejects_cross_origin_seat_route(self):
        self.run_scenario("invalid-route")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
