#!/usr/bin/env python3
"""Generate this repo's Codex CLI config from the committed agent config.

    gen-codex-config.py <repo-root> <main-root>

Source of truth (committed):  agents/*.md, skills/*/SKILL.md, /.mcp.json
Generated (gitignored):       .codex/agents/<name>.toml, .codex/config.toml

Claude Code reads `agents/*.md` through symlinks in `.claude/agents/`; Codex wants TOML with a
`developer_instructions` string, so the markdown is transcribed here rather than duplicated by hand.
Skills need no generation — Codex scans `.agents/skills/` and follows symlinks — and the PreToolUse
hook is written by scripts/install-agent-config.sh, which is also what calls this script.

`<main-root>` is the main checkout (`dirname $(git rev-parse --git-common-dir)`) and is where the
shared project memory lives. In a linked worktree that store is outside the workspace, so it is
declared in `[sandbox_workspace_write] writable_roots`. In the main checkout it is *inside* the
workspace already, and declaring it there makes codex-cli 0.132.0 bind-mount it read-only over the
workspace — every sandboxed command then dies with `bwrap: Can't mkdir <repo>/.agents/memory/.git:
Read-only file system` — so the block is emitted only when the store is outside `<repo-root>`.

Output is deterministic: keys are sorted, so re-running with no input change rewrites byte-identical
files. Anything this script cannot faithfully translate is reported on stderr as a `warning:` line
rather than silently dropped.
"""

from __future__ import annotations

import json
import os
import re
import sys

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")
FRONTMATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---[ \t]*\r?\n", re.DOTALL)
# A markdown link written for `agents/foo.md` points one level up (`](../docs/…`). The same text
# lives at the repo root once it is inlined into a TOML string, so drop the one leading `../`.
LINK_RE = re.compile(r"\]\(\.\./")

warnings: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"warning: {msg}", file=sys.stderr)


def die(msg: str) -> "NoReturn":  # noqa: F821
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# --------------------------------------------------------------------------------------------
# TOML emission
# --------------------------------------------------------------------------------------------


def toml_key(key: str) -> str:
    """A bare key where TOML allows one, a quoted key otherwise."""
    return key if BARE_KEY_RE.match(key) else json.dumps(key)


def toml_string(value: str) -> str:
    """Prefer a literal multiline string for bodies; fall back to a JSON-escaped basic string.

    TOML's `'''…'''` takes the text verbatim, which keeps backslashes and quotes in the markdown
    readable. It is only legal when the text has no `'''` run, does not end in `'` (that would make
    four apostrophes at the delimiter) and carries no control characters besides tab and newline.
    JSON's escaping happens to be a subset of TOML basic-string escaping (`\\n`, `\\"`, `\\\\`,
    `\\uXXXX`), so json.dumps is a safe fallback for everything else.
    """
    multiline = "\n" in value
    illegal = any(ch < " " and ch not in "\t\n" for ch in value) or "\r" in value
    if multiline and not illegal and "'''" not in value and not value.endswith("'"):
        body = value if value.endswith("\n") else value + "\n"
        # A newline immediately after the opening delimiter is trimmed by TOML, so this round-trips.
        return "'''\n" + body + "'''"
    return json.dumps(value)


def toml_array(values: list[str]) -> str:
    return "[" + ", ".join(json.dumps(v) for v in values) + "]"


def is_inside(root: str, path: str) -> bool:
    """True when `path` is `root` itself or lives under it, with symlinks resolved."""
    root, path = os.path.realpath(root), os.path.realpath(path)
    try:
        return os.path.commonpath([root, path]) == root
    except ValueError:  # unrelated roots (different drives, or one is relative)
        return False


# --------------------------------------------------------------------------------------------
# agents/*.md  ->  .codex/agents/<name>.toml
# --------------------------------------------------------------------------------------------


def parse_agent(path: str) -> tuple[str, str, str]:
    """Return (name, description, body) for one `agents/*.md`."""
    text = open(path, encoding="utf-8").read()
    m = FRONTMATTER_RE.match(text)
    if not m:
        die(f"{path}: no `---` frontmatter block")
    front, body = m.group(1), text[m.end() :]

    fields: dict[str, str] = {}
    key = None
    for line in front.split("\n"):
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$", line)
        if km:
            key = km.group(1)
            fields[key] = km.group(2).strip()
        elif key is not None and line.strip():
            # A wrapped scalar continues the previous key.
            fields[key] = (fields[key] + " " + line.strip()).strip()
    for k, v in fields.items():
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            fields[k] = v[1:-1]

    name = fields.get("name", "")
    description = fields.get("description", "")
    if not NAME_RE.match(name):
        die(f"{path}: frontmatter name {name!r} is not ^[a-z0-9][a-z0-9-]*$")
    if not description:
        die(f"{path}: frontmatter has no description")
    if name != os.path.splitext(os.path.basename(path))[0]:
        warn(f"{path}: frontmatter name {name!r} does not match the filename")

    body = LINK_RE.sub("](", body).lstrip("\n").rstrip() + "\n"
    if not body.strip():
        die(f"{path}: no body after the frontmatter")
    return name, description, body


def write_agent_toml(out_dir: str, name: str, description: str, body: str) -> str:
    # model / model_reasoning_effort / sandbox_mode / mcp_servers / skills.config are deliberately
    # left unset so the user's ~/.codex/config.toml governs, the way a Claude subagent with no
    # `model:` inherits the session model.
    lines = [
        "# generated by scripts/install-agent-config.sh — do not edit by hand.",
        f"# source of truth: agents/{name}.md",
        "",
        f"name = {json.dumps(name)}",
        f"description = {json.dumps(description)}",
        f"developer_instructions = {toml_string(body)}",
        "",
    ]
    path = os.path.join(out_dir, f"{name}.toml")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return path


# --------------------------------------------------------------------------------------------
# /.mcp.json  ->  [mcp_servers.*]
# --------------------------------------------------------------------------------------------

VAR_RE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}")
BEARER_RE = re.compile(r"^Bearer[ \t]+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def check_vars(where: str, value: str) -> None:
    if VAR_RE.search(value):
        warn(f"{where}: Codex does not expand ${{VAR}} placeholders; left verbatim ({value!r})")


def mcp_blocks(mcp_path: str) -> list[str]:
    try:
        with open(mcp_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as exc:
        warn(f"{mcp_path}: not valid JSON ({exc}); no MCP servers generated")
        return []

    servers = data.get("mcpServers") or {}
    blocks: list[str] = []
    for name in sorted(servers):
        entry = servers[name] or {}
        kind = (entry.get("type") or ("http" if entry.get("url") else "stdio")).lower()
        where = f"{mcp_path}: mcpServers.{name}"
        key = toml_key(name)

        if kind == "stdio":
            command = entry.get("command")
            if not command:
                warn(f"{where}: stdio server has no `command`; skipped")
                continue
            args = [str(a) for a in entry.get("args") or []]
            env = entry.get("env") or {}
            cwd = entry.get("cwd")
            for v in [command, *args, *[str(x) for x in env.values()], cwd or ""]:
                check_vars(where, v)
            out = [f"[mcp_servers.{key}]", f"command = {json.dumps(command)}"]
            if args:
                out.append(f"args = {toml_array(args)}")
            if cwd:
                out.append(f"cwd = {json.dumps(cwd)}")
            if env:
                out.append("")
                out.append(f"[mcp_servers.{key}.env]")
                out += [f"{toml_key(k)} = {json.dumps(str(env[k]))}" for k in sorted(env)]
            blocks.append("\n".join(out))

        elif kind == "http":
            url = entry.get("url")
            if not url:
                warn(f"{where}: http server has no `url`; skipped")
                continue
            check_vars(where, url)
            out = [f"[mcp_servers.{key}]", f"url = {json.dumps(url)}"]
            headers = dict(entry.get("headers") or {})
            bearer = None
            auth = headers.get("Authorization")
            if auth:
                bm = BEARER_RE.match(auth.strip())
                if bm:
                    bearer = bm.group(1)
                    headers.pop("Authorization")
            if bearer:
                out.append(f"bearer_token_env_var = {json.dumps(bearer)}")
            for v in headers.values():
                check_vars(where, str(v))
            if headers:
                out.append("")
                out.append(f"[mcp_servers.{key}.http_headers]")
                out += [f"{toml_key(k)} = {json.dumps(str(headers[k]))}" for k in sorted(headers)]
            blocks.append("\n".join(out))

        elif kind == "sse":
            url = entry.get("url")
            if not url:
                warn(f"{where}: sse server has no `url`; skipped")
                continue
            check_vars(where, url)
            warn(f"{where}: `sse` has no Codex equivalent; emitted as a streamable-http `url`")
            blocks.append("\n".join([f"[mcp_servers.{key}]", f"url = {json.dumps(url)}"]))

        else:
            warn(f"{where}: unknown transport type {kind!r}; skipped")

    return blocks


# --------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        die("usage: gen-codex-config.py <repo-root> <main-root>")
    repo = os.path.abspath(argv[1])
    main_root = os.path.abspath(argv[2])
    if not os.path.isdir(repo):
        die(f"{repo}: not a directory")

    codex = os.path.join(repo, ".codex")
    if os.path.exists(codex) and not os.path.isdir(codex):
        die(f"{codex} exists and is not a directory; remove it first")
    agents_out = os.path.join(codex, "agents")
    os.makedirs(agents_out, exist_ok=True)

    written: list[str] = []
    agent_names: list[str] = []
    src_dir = os.path.join(repo, "agents")
    for fname in sorted(os.listdir(src_dir)) if os.path.isdir(src_dir) else []:
        if not fname.endswith(".md"):
            continue
        name, description, body = parse_agent(os.path.join(src_dir, fname))
        if name in agent_names:
            die(f"duplicate agent name {name!r}")
        agent_names.append(name)
        written.append(write_agent_toml(agents_out, name, description, body))

    # Stale TOML from a renamed or deleted agent would still be scanned by newer Codex versions.
    keep = {f"{n}.toml" for n in agent_names}
    for fname in sorted(os.listdir(agents_out)):
        if fname.endswith(".toml") and fname not in keep:
            os.remove(os.path.join(agents_out, fname))
            print(f"    removed .codex/agents/{fname} (no matching agents/*.md)")

    memory = os.path.join(main_root, ".agents", "memory")
    parts = [
        "# generated by scripts/install-agent-config.sh — do not edit by hand.",
        "# source of truth: agents/*.md, /.mcp.json. Re-run the installer to regenerate.",
        "# The PreToolUse guard is registered separately, in .codex/hooks.json.",
        "",
    ]
    if is_inside(repo, memory):
        # Declaring a path that is already inside the workspace makes codex-cli 0.132.0 bind-mount
        # it read-only over the checkout, and every sandboxed command dies on it.
        parts += [
            "# No [sandbox_workspace_write] here: the project memory store is inside this checkout,",
            "# so it is writable already. Declaring it as a writable_root makes codex-cli 0.132.0",
            "# remount it read-only and every sandboxed command fails (bwrap: Read-only file system).",
        ]
    else:
        parts += [
            "# Project memory is shared with the main checkout, which is outside this worktree's",
            "# workspace-write sandbox.",
            "[sandbox_workspace_write]",
            f"writable_roots = {toml_array([memory])}",
        ]
    # Codex 0.132.0 does not scan .codex/agents/, so each generated file is also registered here;
    # newer versions scan the directory and this block is redundant but harmless.
    for name in agent_names:
        parts += [
            "",
            f"[agents.{toml_key(name)}]",
            f"config_file = {json.dumps(os.path.join(agents_out, name + '.toml'))}",
        ]
    for block in mcp_blocks(os.path.join(repo, ".mcp.json")):
        parts += ["", block]
    config_path = os.path.join(codex, "config.toml")
    with open(config_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(parts) + "\n")
    written.append(config_path)

    for path in written:
        print(f"    {os.path.relpath(path, repo)}")
    if warnings:
        print(f"    ({len(warnings)} warning(s) above)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
