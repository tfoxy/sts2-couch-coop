#!/usr/bin/env python3
"""Shared parsing for the committed agent config.

`agents/*.md` is the source of truth for Claude Code subagents. Codex and DeepSeek
Harness need the same markdown as harness-specific configuration, so both generators
read it through this module instead of keeping private parsers that drift.

Stdlib only: the generators run from a fresh checkout before any package install.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Callable

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*\r?\n", re.DOTALL)
# A markdown link written for `agents/foo.md` points one level up (`](../docs/…`). The
# same text lives at the repo root once it is inlined into another harness's prompt.
LINK_RE = re.compile(r"\]\(\.\./")

Warn = Callable[[str], None]


class AgentError(Exception):
    """One `agents/*.md` cannot be turned into a harness definition."""


@dataclass
class AgentSpec:
    name: str
    description: str
    body: str
    # Every frontmatter scalar, so a harness can report fields it deliberately ignores
    # (`tools:`, `model:`, …) instead of silently dropping them.
    fields: dict[str, str] = field(default_factory=dict)


def parse_frontmatter(front: str) -> dict[str, str]:
    """Parse the flat `key: scalar` YAML subset the agent files use.

    The files are hand-written and deliberately simple: one scalar per key, with
    continuation lines folded onto the previous key. Quoted values are unquoted.
    """
    fields: dict[str, str] = {}
    key = None
    for line in front.split("\n"):
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$", line)
        if km:
            key = km.group(1)
            fields[key] = km.group(2).strip()
        elif key is not None and line.strip():
            fields[key] = (fields[key] + " " + line.strip()).strip()
    for k, v in fields.items():
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            fields[k] = v[1:-1]
    return fields


def parse_agent(path: str, warn: Warn, *, rewrite_links: bool = True) -> AgentSpec:
    """Read one agent markdown file.

    `rewrite_links` drops the one leading `../` from relative links, which is correct
    for `agents/*.md` because the body is inlined at the repo root. User and local
    agent files keep their links untouched.
    """
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    m = FRONTMATTER_RE.match(text)
    if not m:
        raise AgentError(f"{path}: no `---` frontmatter block")
    fields = parse_frontmatter(m.group(1))
    body = text[m.end() :]

    name = fields.get("name", "")
    description = fields.get("description", "")
    if not NAME_RE.match(name):
        raise AgentError(f"{path}: frontmatter name {name!r} is not ^[a-z0-9][a-z0-9-]*$")
    if not description:
        raise AgentError(f"{path}: frontmatter has no description")
    if name != os.path.splitext(os.path.basename(path))[0]:
        warn(f"{path}: frontmatter name {name!r} does not match the filename")

    if rewrite_links:
        body = LINK_RE.sub("](", body)
    body = body.lstrip("\n").rstrip() + "\n"
    if not body.strip():
        raise AgentError(f"{path}: no body after the frontmatter")
    return AgentSpec(name=name, description=description, body=body, fields=fields)


def is_inside(root: str, path: str) -> bool:
    """True when `path` is `root` itself or lives under it, with symlinks resolved."""
    root, path = os.path.realpath(root), os.path.realpath(path)
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:  # unrelated roots (different drives, or one is relative)
        return False
