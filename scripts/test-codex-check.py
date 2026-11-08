#!/usr/bin/env python3
"""Exercise the worker check command with isolated git history and stub runners."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().with_name("codex-check.sh")


class CodexCheckTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "scripts").mkdir()
        (self.repo / "frontend").mkdir()
        shutil.copy2(SCRIPT, self.repo / "scripts/codex-check.sh")
        self.git("init", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.git("config", "commit.gpgsign", "false")
        self.write("frontend/tracked.ts")
        self.write("frontend/deleted.ts")
        self.commit()
        self.git("switch", "-c", "worker")
        self.log = self.root / "calls.jsonl"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name in ("npx", "dotnet"):
            stub = bin_dir / name
            stub.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
with open(os.environ['CHECK_LOG'], 'a') as log:
    log.write(json.dumps([Path.cwd().name, Path(sys.argv[0]).name, sys.argv[1:],
                          os.environ.get('CouchCoopBuildToLocalMods')]) + '\\n')
if os.environ.get('CHECK_FAIL') in sys.argv[1:]:
    sys.exit(17)
""")
            stub.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "CHECK_LOG": str(self.log), "CODEX_CHECK_BASE": "main"}

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, path):
        (self.repo / path).write_text("fixture\n")

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-m", "test: fixture")

    def run_check(self, **env):
        result = subprocess.run([str(self.repo / "scripts/codex-check.sh")],
                                cwd=self.root, env={**self.env, **env},
                                capture_output=True, text=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_no_frontend_changes(self):
        self.env.pop("CODEX_CHECK_BASE")  # Exercise the default base as well.
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("skipping related tests", result.stdout)
        self.assertEqual([call[:3] for call in calls], [
            ["frontend", "npx", ["vue-tsc", "--noEmit"]],
            ["repo", "dotnet", ["run", "--project", "tests/CouchCoop.MirrorProtocol.Tests"]],
            ["repo", "dotnet", ["run", "--project", "tests/CouchCoop.Mod.Tests"]],
        ])
        self.assertTrue(all(call[3] == "false" for call in calls))

    def test_changed_committed_staged_untracked_and_deleted_paths(self):
        self.write("frontend/committed.ts")
        self.commit()
        self.write("frontend/staged.ts")
        self.git("add", "frontend/staged.ts")
        self.write("frontend/untracked file.ts")
        (self.repo / "frontend/tracked.ts").write_text("changed\n")
        (self.repo / "frontend/deleted.ts").unlink()
        self.write("outside.ts")
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[1][:2], ["frontend", "npx"])
        self.assertEqual(calls[1][2][:4], ["vitest", "related", "--run", "--maxWorkers=2"])
        self.assertEqual(set(calls[1][2][4:]), {
            "committed.ts", "staged.ts", "tracked.ts", "untracked file.ts",
        })

    def test_base_override(self):
        self.write("frontend/committed.ts")
        self.commit()
        result, calls = self.run_check(CODEX_CHECK_BASE="HEAD")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 3)

    def test_each_runner_failure_stops_later_stages(self):
        self.write("frontend/new.ts")
        for failure, count, stage in [
            ("vue-tsc", 1, "frontend typecheck"),
            ("vitest", 2, "related frontend tests"),
            ("tests/CouchCoop.MirrorProtocol.Tests", 3, "MirrorProtocol tests"),
            ("tests/CouchCoop.Mod.Tests", 4, "Mod tests"),
        ]:
            with self.subTest(stage=stage):
                self.log.write_text("")
                result, calls = self.run_check(CHECK_FAIL=failure)
                self.assertEqual(result.returncode, 17)
                self.assertEqual(len(calls), count)
                self.assertIn(f"{stage} failed (exit 17)", result.stderr)

    def test_invalid_base_stops_before_dotnet(self):
        result, calls = self.run_check(CODEX_CHECK_BASE="missing-base")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("related frontend tests failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
