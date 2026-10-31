#!/usr/bin/env python3
"""Generate this repo's DeepSeek Harness profile overlay from the committed agent config.

    gen-dsh-config.py <repo-root>

Source of truth (committed):  agents/*.md, skills/*/SKILL.md, /.mcp.json
Generated (gitignored):       .dsh/profile.patch.yml

Claude Code reads `agents/*.md` through symlinks in `.claude/agents/`; DSH mounts an
agent composition as an Agent Preset, so this script copies the shipped `standard`
preset's plugin list and replaces its persona with the agent body. It also turns the
same MCP definitions Claude Code and Codex read into `dsh-mcp-client` rows.

`scripts/dsh` is the only launcher: it passes this file with `--patch`, which keeps the
overlay repo-scoped (a worktree gets its own) instead of rewriting the global
`~/.dsh/profiles/web/cordis.patch.yml`.

Environment overrides:

    DSH_BIN           dsh executable used to locate the shipped preset (default: dsh)
    DSH_PRESET_FILE   read this standard preset instead of discovering it
    DSH_HOME          harness home used as a discovery fallback (default: ~/.dsh)

Output is deterministic: servers and roles are sorted, keys are stable, so re-running
with no input change rewrites a byte-identical file. Anything that cannot be translated
faithfully is reported on stderr as a `warning:` line rather than silently dropped.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent_config import AgentError, parse_agent  # noqa: E402

MCP_ROW_PREFIX = "agentcfg-mcp-"
PRESET_ROW_PREFIX = "agentcfg-preset-"
ROLE_TOOL_ROW_ID = "agentcfg-tool-subagent-role"
ROLE_TOOL_NAME = "subagent_role"

# Presets shipped by @deepseek-ai/dsh-web-app. A role with one of these ids would make
# the registry reject the declaration, so it is skipped with a warning instead.
SHIPPED_PRESET_IDS = {"standard", "ptc", "minimal", "cordis"}

BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")
SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
STDERR = sys.stderr
warnings: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"warning: {msg}", file=STDERR)


def die(msg: str) -> "NoReturn":  # noqa: F821
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# --------------------------------------------------------------------------------------------
# YAML emission
# --------------------------------------------------------------------------------------------


def yaml_scalar(value: str) -> str:
    """A JSON string is a valid YAML scalar and handles every control character."""
    return json.dumps(value, ensure_ascii=False)


def yaml_key(key: str) -> str:
    return key if BARE_KEY_RE.match(key) else yaml_scalar(key)


def js_expr(value: str) -> str | None:
    """A JS expression for a `${VAR}` placeholder, or None when there is none.

    DSH evaluates `!!js` values at boot, so a placeholder stays a reference rather than
    being frozen into the generated file. A whole-value placeholder is left as the raw
    `process.env.X` reference (the form the MCP client documents); embedded ones are
    concatenated with an empty-string fallback so the result is always a string.
    """
    whole = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value)
    if whole:
        return f"process.env.{whole.group(1)}"

    parts: list[str] = []
    last = 0
    for m in VAR_RE.finditer(value):
        if m.start() > last:
            parts.append(yaml_scalar(value[last : m.start()]))
        parts.append(f'(process.env.{m.group(1)} ?? "")')
        last = m.end()
    if not parts:
        return None
    if last < len(value):
        parts.append(yaml_scalar(value[last:]))
    return " + ".join(parts)


def yaml_value(value: object) -> str:
    text = str(value)
    expr = js_expr(text)
    if expr is None:
        return yaml_scalar(text)
    # The common whole-value form is a bare member expression. Anything with spaces is
    # single-quoted so YAML keeps it one scalar; only `'` needs doubling then.
    if re.fullmatch(r"[A-Za-z_$][A-Za-z0-9_$.]*", expr):
        return f"!!js {expr}"
    return "!!js '" + expr.replace("'", "''") + "'"


def yaml_flow_list(values: list[str]) -> str:
    return "[" + ", ".join(yaml_value(v) for v in values) + "]"


# --------------------------------------------------------------------------------------------
# MCP: ~/.claude.json + /.mcp.json  ->  dsh-mcp-client rows
# --------------------------------------------------------------------------------------------


def read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        warn(f"{path}: not valid JSON ({exc}); ignored")
        return {}
    return data if isinstance(data, dict) else {}


def mcp_servers(repo: str, home: str) -> dict[str, tuple[str, dict]]:
    """Merge Claude's user/project MCP definitions and the repo's /.mcp.json.

    Later sources win, matching Claude Code's precedence: user servers, then the
    per-project `~/.claude.json` entry, then the project file.
    """
    merged: dict[str, tuple[str, dict]] = {}
    claude_path = os.path.join(home, ".claude.json")
    claude = read_json(claude_path)
    for name, entry in (claude.get("mcpServers") or {}).items():
        merged[name] = (f"{claude_path}: mcpServers.{name}", entry or {})

    projects = claude.get("projects") or {}
    project = projects.get(os.path.realpath(repo)) or {}
    for name, entry in (project.get("mcpServers") or {}).items():
        merged[name] = (f"{claude_path}: projects[{repo}].mcpServers.{name}", entry or {})

    repo_mcp = os.path.join(repo, ".mcp.json")
    for name, entry in (read_json(repo_mcp).get("mcpServers") or {}).items():
        merged[name] = (f"{repo_mcp}: mcpServers.{name}", entry or {})

    return merged


def mcp_row(name: str, entry: dict, where: str) -> list[str] | None:
    if not SERVER_NAME_RE.match(name):
        warn(f"{where}: server name {name!r} is not ^[A-Za-z0-9_-]{{1,32}}$; skipped")
        return None

    kind = (entry.get("type") or ("http" if entry.get("url") else "stdio")).lower()
    config: list[str] = []

    if kind == "stdio":
        command = entry.get("command")
        if not command:
            warn(f"{where}: stdio server has no `command`; skipped")
            return None
        config.append("        transport: stdio")
        config.append(f"        command: {yaml_value(command)}")
        args = [str(a) for a in entry.get("args") or []]
        if args:
            config.append(f"        args: {yaml_flow_list(args)}")
        cwd = entry.get("cwd")
        if cwd:
            config.append(f"        cwd: {yaml_value(cwd)}")
        env = entry.get("env") or {}
        if env:
            config.append("        env:")
            config.extend(f"          {yaml_key(k)}: {yaml_value(env[k])}" for k in sorted(env))

    elif kind in ("http", "streamable-http", "sse"):
        url = entry.get("url")
        if not url:
            warn(f"{where}: {kind} server has no `url`; skipped")
            return None
        if kind == "sse":
            warn(f"{where}: `sse` has no DSH transport; emitted as `streamable-http`")
        config.append("        transport: streamable-http")
        config.append(f"        url: {yaml_value(url)}")
        headers = entry.get("headers") or {}
        if headers:
            config.append("        headers:")
            config.extend(
                f"          {yaml_key(k)}: {yaml_value(v)}" for k, v in sorted(headers.items())
            )

    else:
        warn(f"{where}: unknown transport type {kind!r}; skipped")
        return None

    return [
        f"    - id: {MCP_ROW_PREFIX}{name}",
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        f"        serverName: {yaml_scalar(name)}",
        *config,
    ]


# --------------------------------------------------------------------------------------------
# agents/*.md  ->  Agent Presets
# --------------------------------------------------------------------------------------------


def agent_sources(repo: str, home: str) -> list[tuple[str, bool, bool]]:
    """(path, strict, rewrite_links) in precedence order.

    The repo's committed agents are strict. `.claude/agents` can hold locally installed
    real files (the repo's own entries there are symlinks and are skipped), and
    `~/.claude/agents` holds user-level agents. Both are best-effort.
    """
    sources: list[tuple[str, bool, bool]] = []
    repo_dir = os.path.join(repo, "agents")
    if os.path.isdir(repo_dir):
        sources += [
            (os.path.join(repo_dir, f), True, True)
            for f in sorted(os.listdir(repo_dir))
            if f.endswith(".md")
        ]
    local_dir = os.path.join(repo, ".claude", "agents")
    if os.path.isdir(local_dir):
        sources += [
            (os.path.join(local_dir, f), False, False)
            for f in sorted(os.listdir(local_dir))
            if f.endswith(".md") and not os.path.islink(os.path.join(local_dir, f))
        ]
    user_dir = os.path.join(home, ".claude", "agents")
    if os.path.isdir(user_dir):
        sources += [
            (os.path.join(user_dir, f), False, False)
            for f in sorted(os.listdir(user_dir))
            if f.endswith(".md")
        ]
    return sources


def collect_agents(repo: str, home: str) -> list:
    agents = []
    seen: dict[str, str] = {}
    for path, strict, rewrite in agent_sources(repo, home):
        try:
            spec = parse_agent(path, warn, rewrite_links=rewrite)
        except AgentError as exc:
            if strict:
                die(str(exc))
            warn(f"{exc}; skipped")
            continue
        if spec.name in seen:
            warn(f"{path}: agent {spec.name!r} duplicates {seen[spec.name]}; skipped")
            continue
        seen[spec.name] = path
        for key in ("tools", "model", "permissionMode"):
            if key in spec.fields:
                warn(
                    f"{path}: `{key}:` is not enforced by a DSH role preset; "
                    "the standard tool set and the parent model are inherited"
                )
        if "{{" in spec.body:
            warn(
                f"{path}: body contains `{{`, which DSH would resolve as a persona "
                "template variable; role preset skipped"
            )
            continue
        if spec.name in SHIPPED_PRESET_IDS:
            warn(
                f"{path}: agent id {spec.name!r} collides with a shipped DSH preset; skipped"
            )
            continue
        agents.append(spec)
    return sorted(agents, key=lambda a: a.name)


def find_preset_file() -> str | None:
    env = os.environ.get("DSH_PRESET_FILE")
    if env:
        if os.path.isfile(env):
            return env
        warn(f"DSH_PRESET_FILE={env!r} does not exist; role presets skipped")
        return None

    candidates: list[str] = []
    dsh = os.environ.get("DSH_BIN") or shutil.which("dsh")
    if dsh:
        real = os.path.realpath(dsh)
        package = os.path.dirname(os.path.dirname(real))  # .../@deepseek-ai/dsh
        candidates += [
            os.path.join(package, "..", "dsh-web-app", "presets", "standard.patch.yml"),
            os.path.join(os.path.dirname(dsh), "..", "@deepseek-ai", "dsh-web-app",
                         "presets", "standard.patch.yml"),
        ]
    dsh_home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    for base in (dsh_home, os.path.join(dsh_home, "profiles", "web")):
        candidates.append(
            os.path.join(base, "node_modules", "@deepseek-ai", "dsh-web-app",
                         "presets", "standard.patch.yml")
        )
    for candidate in candidates:
        path = os.path.realpath(candidate)
        if os.path.isfile(path):
            return path
    warn(
        "could not locate @deepseek-ai/dsh-web-app/presets/standard.patch.yml; "
        "role presets skipped (set DSH_PRESET_FILE to override)"
    )
    return None


def extract_plugins(text: str, path: str) -> tuple[list[list[str]], int]:
    """Return the `preset-standard` plugin chunks and their source indent."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    start = None
    for i, line in enumerate(lines):
        if re.match(r"^\s*-\s+id:\s*preset-standard\s*$", line):
            start = i
            break
    if start is None:
        raise ValueError(f"{path}: no `preset-standard` declaration")

    base_indent = len(lines[start]) - len(lines[start].lstrip())
    plugins_i = None
    plugins_indent = 0
    for i in range(start + 1, len(lines)):
        line = lines[i]
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent and line.lstrip().startswith("- "):
            break
        if line.strip() == "plugins:":
            plugins_i, plugins_indent = i, indent
            break
    if plugins_i is None:
        raise ValueError(f"{path}: `preset-standard` has no `plugins:` list")

    item_indent = plugins_indent + 2
    chunks: list[list[str]] = []
    current: list[str] | None = None
    for line in lines[plugins_i + 1 :]:
        if not line.strip():
            if current is not None:
                current.append("")
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent and line.lstrip().startswith("- "):
            break
        if indent < item_indent:
            break
        if indent == item_indent and line.lstrip().startswith("- "):
            if current is not None:
                chunks.append(current)
            current = [line]
        elif current is not None:
            current.append(line)
    if current is not None:
        chunks.append(current)

    for chunk in chunks:
        while chunk and not chunk[-1].strip():
            chunk.pop()
    if not chunks:
        raise ValueError(f"{path}: `preset-standard` has an empty `plugins:` list")
    return chunks, item_indent


def reindent(lines: list[str], delta: int) -> list[str]:
    if delta == 0:
        return list(lines)
    out: list[str] = []
    for line in lines:
        if not line.strip():
            out.append("")
        elif delta > 0:
            out.append(" " * delta + line)
        else:
            out.append(line[-delta:])
    return out


def role_preset_lines(spec, chunks: list[list[str]], source_indent: int, order: int) -> list[str]:
    """One `@deepseek-ai/dsh-agent-preset` row with the agent body as its persona."""
    item_indent = 10  # config.plugins children inside a 4-space `- insert:` list
    delta = item_indent - source_indent
    pad = " " * item_indent
    body_pad = " " * (item_indent + 6)

    lines = [
        f"    - id: {PRESET_ROW_PREFIX}{spec.name}",
        "      name: '@deepseek-ai/dsh-agent-preset'",
        "      config:",
        f"        id: {spec.name}",
        f"        name: {spec.name}",
        f"        description: {yaml_scalar(spec.description)}",
        f"        order: {order}",
        "        plugins:",
        f"{pad}- id: persona",
        f"{pad}  name: '@deepseek-ai/dsh-persona'",
        f"{pad}  config:",
        f"{pad}    prefix: |",
    ]
    for line in spec.body.rstrip("\n").split("\n"):
        lines.append(body_pad + line if line.strip() else "")
    for chunk in chunks:
        # The shipped prefix is the deployment persona; the role body replaces it.
        if re.match(r"^\s*-\s+id:\s*persona\s*$", chunk[0]):
            continue
        lines.extend(reindent(chunk, delta))
    return lines


def role_tool_lines(agents: list) -> list[str]:
    names = [a.name for a in agents]
    return [
        f"    - id: {ROLE_TOOL_ROW_ID}",
        "      name: '@deepseek-ai/dsh-tool-subagent'",
        "      config:",
        "        provider: spawn",
        f"        toolName: {ROLE_TOOL_NAME}",
        f"        agentPreset: {names[0]}",
        f"        allowedAgentPresets: [{', '.join(names)}]",
    ]


# --------------------------------------------------------------------------------------------


def render_patch(rows: list[list[str]]) -> str:
    header = [
        "# generated by scripts/install-agent-config.sh — do not edit by hand.",
        "# source of truth: agents/*.md and ~/.claude.json + /.mcp.json.",
        "# Launched by scripts/dsh as a repo-scoped --patch overlay.",
    ]
    if not rows:
        return "\n".join(header + ["[]", ""])
    lines = header + ["- insert:"]
    for row in rows:
        lines.extend(row)
    return "\n".join(lines) + "\n"


def atomic_write(path: str, text: str) -> None:
    directory = os.path.dirname(path)
    fd, temp = tempfile.mkstemp(prefix=".profile.patch.", dir=directory, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(temp, 0o644)
        os.replace(temp, path)
    except BaseException:
        try:
            os.remove(temp)
        except OSError:
            pass
        raise


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 0
    if len(argv) != 2:
        die("usage: gen-dsh-config.py <repo-root>")
    repo = os.path.abspath(argv[1])
    if not os.path.isdir(repo):
        die(f"{repo}: not a directory")

    dsh_dir = os.path.join(repo, ".dsh")
    if os.path.exists(dsh_dir) and not os.path.isdir(dsh_dir):
        die(f"{dsh_dir} exists and is not a directory; remove it first")
    os.makedirs(dsh_dir, exist_ok=True)

    home = os.path.expanduser("~")
    rows: list[list[str]] = []

    servers = mcp_servers(repo, home)
    for name in sorted(servers):
        where, entry = servers[name]
        row = mcp_row(name, entry, where)
        if row is not None:
            rows.append(row)

    agents = collect_agents(repo, home)
    if agents:
        preset = find_preset_file()
        if preset:
            try:
                with open(preset, encoding="utf-8") as fh:
                    chunks, source_indent = extract_plugins(fh.read(), preset)
            except (OSError, ValueError) as exc:
                warn(f"{exc}; role presets skipped")
            else:
                for i, spec in enumerate(agents):
                    rows.append(role_preset_lines(spec, chunks, source_indent, 100 + i))
                rows.append(role_tool_lines(agents))

    path = os.path.join(dsh_dir, "profile.patch.yml")
    atomic_write(path, render_patch(rows))
    server_count = sum(1 for r in rows if MCP_ROW_PREFIX in r[0])
    print(
        f"    {os.path.relpath(path, repo)}"
        f" ({server_count} MCP server(s), {len(agents)} role preset(s))"
    )
    if warnings:
        print(f"    ({len(warnings)} warning(s) above)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
