#!/usr/bin/env python3
"""Check the game-free validation recipe without a game install or a dotnet build."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("check-game-free-hosted-server.sh")


class GameFreeHostedServerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        script_dir = self.repo / "scripts/lib"
        script_dir.mkdir(parents=True)
        self.script = script_dir / SCRIPT.name
        shutil.copy2(SCRIPT, self.script)
        self.log = self.root / "calls.jsonl"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "dotnet"
        stub.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with open(os.environ["CHECK_LOG"], "a") as log:
    log.write(json.dumps([str(Path.cwd()), sys.argv[1:],
                          os.environ.get("DOTNET_ROLL_FORWARD")]) + "\\n")
if sys.argv[1] == "build":
    Path(sys.argv[sys.argv.index("-o") + 1]).mkdir(parents=True)
if os.environ.get("CHECK_FAIL") == sys.argv[1]:
    sys.exit(17)
''')
        stub.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "CHECK_LOG": str(self.log), "TMPDIR": str(self.root)}
        self.env.pop("DOTNET_ROLL_FORWARD", None)

    def run_check(self, **env):
        result = subprocess.run(["bash", str(self.script)], cwd=self.root,
                                env={**self.env, **env}, capture_output=True, text=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def assert_scratch_removed(self, build_args):
        output = Path(build_args[build_args.index("-o") + 1])
        self.assertEqual(output.name, "public-beta")
        self.assertEqual(output.parent.parent, self.root)
        self.assertFalse(output.parent.exists())
        return output

    def test_reference_lane_and_game_free_run(self):
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[0] == str(self.repo) for call in calls))
        build, run = [call[1] for call in calls]
        output = self.assert_scratch_removed(build)
        self.assertEqual(build, [
            "build", "eng/Sts2.ReferenceSdk/public-beta/Sts2.ReferenceSdk.public-beta.csproj",
            "-c", "Release", "-o", str(output), "-p:RestoreLockedMode=true",
            "-p:Sts2GameApi=v111", "-p:CouchCoopBuildToLocalMods=false",
        ])
        self.assertEqual(run, [
            "run", "--project", "tests/CouchCoop.HostedServerHarness", "-c", "Release",
            f"-p:Sts2AssembliesDir={output}", "-p:Sts2GameApi=v111",
            "-p:CouchCoopBuildToLocalMods=false", "--", "--mode", "iphone-burst-self-test",
        ])
        self.assertEqual(calls[1][2], "Major")

    def test_failure_propagates_and_removes_sdk(self):
        for stage, count in [("build", 1), ("run", 2)]:
            with self.subTest(stage=stage):
                self.log.write_text("")
                result, calls = self.run_check(CHECK_FAIL=stage)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(len(calls), count)
                self.assert_scratch_removed(calls[0][1])

    def test_preserves_runtime_policy(self):
        result, calls = self.run_check(DOTNET_ROLL_FORWARD="LatestMajor")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1][2], "LatestMajor")

    def test_registered_in_local_validation(self):
        validate = SCRIPT.parent.parent.joinpath("validate.sh").read_text()
        self.assertIn('"game-free-hosted-server|bash scripts/lib/check-game-free-hosted-server.sh"', validate)


if __name__ == "__main__":
    unittest.main()
