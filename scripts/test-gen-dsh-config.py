#!/usr/bin/env python3
"""Isolated checks for scripts/gen-dsh-config.py and the shared agent parser.

Run directly: python3 scripts/test-gen-dsh-config.py
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
FIXTURE = SCRIPTS / "test-support" / "dsh-standard.patch.yml"


def load_generator():
    spec = importlib.util.spec_from_file_location("gen_dsh_config", SCRIPTS / "gen-dsh-config.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


g = load_generator()


def write_agent(path: Path, name: str, body: str = "# Role\n\nDo the thing.\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: {name} description\n---\n\n{body}")


class GenDshConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.home = self.root / "home"
        self.repo.mkdir()
        self.home.mkdir()

    def test_extract_fixture(self) -> None:
        chunks, indent = g.extract_plugins(FIXTURE.read_text(), str(FIXTURE))
        self.assertEqual(indent, 10)
        self.assertTrue(any("id: persona" in chunk[0] for chunk in chunks))
        joined = "\n".join("\n".join(chunk) for chunk in chunks)
        self.assertIn("!!js process.platform", joined)
        self.assertIn("cordis:group", joined)

    def test_role_preset_replaces_persona(self) -> None:
        chunks, indent = g.extract_plugins(FIXTURE.read_text(), str(FIXTURE))
        agent = self.root / "agent.md"
        write_agent(agent, "test-role", "# Test role\n\nUse the standard tools.\n")
        spec = g.parse_agent(str(agent), lambda _msg: None)
        text = "\n".join(g.role_preset_lines(spec, chunks, indent, 100))
        self.assertIn("# Test role", text)
        self.assertNotIn("You are a coding agent", text)
        self.assertEqual(text.count("- id: persona"), 1)
        self.assertIn("prefix: |", text)
        self.assertIn("!!js process.platform", text)
        self.assertIn("cordis:group", text)

    def test_mcp_precedence_and_values(self) -> None:
        (self.home / ".claude.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "chrome-devtools": {"command": "old", "args": ["user"]},
                        "remote": {
                            "type": "http",
                            "url": "https://example.invalid/mcp",
                            "headers": {"Authorization": "Bearer ${DEMO_TOKEN}"},
                        },
                    },
                    "projects": {
                        str(self.repo): {
                            "mcpServers": {"project-only": {"command": "project"}},
                        }
                    },
                }
            )
        )
        (self.repo / ".mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "chrome-devtools": {"command": "npx", "args": ["--headless"]},
                        "weird": {"type": "carrier-pigeon", "url": "x"},
                    }
                }
            )
        )
        servers = g.mcp_servers(str(self.repo), str(self.home))
        self.assertEqual(servers["chrome-devtools"][1]["args"], ["--headless"])
        self.assertIn("project-only", servers)
        self.assertIn("remote", servers)

        row = g.mcp_row("remote", servers["remote"][1], servers["remote"][0])
        self.assertIsNotNone(row)
        self.assertIn(
            'Authorization: !!js \'"Bearer " + (process.env.DEMO_TOKEN ?? "")\'',
            "\n".join(row),
        )
        self.assertIsNone(g.mcp_row("weird", servers["weird"][1], servers["weird"][0]))

    def test_empty_patch_and_determinism(self) -> None:
        self.assertEqual(g.render_patch([]), g.render_patch([]))
        self.assertTrue(g.render_patch([]).rstrip().endswith("[]"))
        row = ["    - id: one", "      name: '@deepseek-ai/dsh-mcp-client'"]
        self.assertEqual(g.render_patch([row]), g.render_patch([row]))
        self.assertIn("- insert:", g.render_patch([row]))

    def test_agent_precedence(self) -> None:
        write_agent(self.repo / "agents" / "repo-role.md", "repo-role")
        write_agent(self.repo / ".claude" / "agents" / "local-role.md", "local-role")
        write_agent(self.repo / ".claude" / "agents" / "repo-role.md", "repo-role")
        write_agent(self.home / ".claude" / "agents" / "user-role.md", "user-role")
        write_agent(self.home / ".claude" / "agents" / "repo-role.md", "repo-role")
        agents = g.collect_agents(str(self.repo), str(self.home))
        names = [a.name for a in agents]
        self.assertEqual(names, ["local-role", "repo-role", "user-role"])
        repo_role = next(a for a in agents if a.name == "repo-role")
        self.assertIn("Do the thing.", repo_role.body)

    def test_real_preset_if_available(self) -> None:
        preset = g.find_preset_file()
        if preset is None:
            self.skipTest("no installed DSH standard preset")
        chunks, indent = g.extract_plugins(Path(preset).read_text(), preset)
        self.assertGreaterEqual(indent, 2)
        self.assertTrue(any("id: persona" in chunk[0] for chunk in chunks))
        self.assertTrue(any("id: tool-web" in chunk[0] for chunk in chunks))


if __name__ == "__main__":
    unittest.main()
