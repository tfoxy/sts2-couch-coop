#!/usr/bin/env python3
"""Trusted smoke test: no checkout, credentials, downloads, or game needed."""
import os
from pathlib import Path
import subprocess
import socket
import tempfile

runner = Path(__file__).with_name("review-sandbox.sh")
with tempfile.TemporaryDirectory(prefix="review-sandbox-test-") as scratch, socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    root = Path(scratch)
    export = root / "export"
    export.mkdir()
    (export / ".disposable-review-export").touch()
    empty = root / "empty"
    empty.mkdir()
    canary = root / "host-only"
    canary.write_text("private")
    probe = '''import os, pathlib, pwd, socket, subprocess, sys
assert 'REVIEW_SECRET_CANARY' not in os.environ
assert not pathlib.Path(sys.argv[1]).exists()
assert os.environ['HOME'] == '/home/reviewer'
assert pwd.getpwuid(os.getuid()).pw_name == 'reviewer'
assert sorted(p.name for p in pathlib.Path('/home').iterdir()) == ['reviewer']
assert not pathlib.Path('/run/user').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines())
for field in ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']:
    assert int(status[field].strip(), 16) == 0, (field, status[field])
assert status['NoNewPrivs'].strip() == '1'
assert subprocess.run(['/usr/sbin/ip', 'address', 'add', '192.0.2.2/32', 'dev', 'lo'],
                      capture_output=True).returncode != 0
assert subprocess.run(['/usr/bin/unshare', '--user', '--map-root-user', 'true'],
                      capture_output=True).returncode != 0
for target in ['/opt/node/forbidden', '/packages/forbidden', '/game-refs/forbidden']:
    try:
        pathlib.Path(target).touch()
    except OSError:
        pass
    else:
        raise AssertionError('read-only mount is writable')
with socket.socket() as sock:
    sock.settimeout(1)
    assert sock.connect_ex(('127.0.0.1', int(sys.argv[2]))) != 0
with socket.socket() as sock:
    sock.settimeout(1)
    assert sock.connect_ex(('1.1.1.1', 443)) != 0
with socket.socket() as server, socket.socket() as client:
    server.settimeout(1)
    client.settimeout(1)
    server.bind(('192.0.2.1', 0))
    server.listen()
    client.connect(server.getsockname())
    connection, _ = server.accept()
    with connection:
        connection.settimeout(1)
        client.sendall(b'private-network')
        assert connection.recv(64) == b'private-network'
pathlib.Path('/workspace/passed').write_text('ok')
'''
    (export / "probe.py").write_text(probe)
    command = [str(runner), str(export), str(empty), str(empty), str(empty), "--"]
    env = dict(os.environ, REVIEW_SECRET_CANARY="must-not-inherit")
    subprocess.run(command + ["python3", "/workspace/probe.py", str(canary),
                             str(listener.getsockname()[1])], env=env, check=True)
    assert (export / "passed").read_text() == "ok"
    assert canary.read_text() == "private"
    assert not list(empty.iterdir())
    assert subprocess.run(command + ["sh", "-c", "exit 23"]).returncode == 23
    (export / ".git").mkdir()
    assert subprocess.run(command + ["true"], capture_output=True).returncode == 2
print("PASS: isolation canaries, private IPv4, zero capabilities, read-only inputs, exit status, checkout refusal")
