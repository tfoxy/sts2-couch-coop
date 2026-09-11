#!/usr/bin/env bash
# Wire the COMMITTED agent config into this checkout's gitignored harness directories, for BOTH
# Claude Code and OpenAI Codex CLI.
#
# The source of truth is committed at agents/, skills/, AGENTS.md and scripts/claude-guard-bash.sh;
# the harness directories that read it — .claude/, .agents/ and .codex/ — are gitignored, so this
# script links or generates them from those committed files. A sibling repo's skills, listed in
# EXTRA_SKILLS below, are linked in the same shape when that sibling is checked out next door.
#
#   Claude Code reads   .claude/agents/*.md, .claude/skills/*, .claude/settings*.json, /.mcp.json
#   Codex CLI reads     .codex/agents/*.toml, .codex/config.toml, .codex/hooks.json, .agents/skills/*
#   both read           AGENTS.md (CLAUDE.md is a symlink to it) and scripts/claude-guard-bash.sh
#   git reads           scripts/githooks/commit-msg and .gitmessage, wired through git config
#
# /.mcp.json carries local filesystem paths, so it is gitignored here too and a fresh worktree has
# none; this script symlinks it to the main checkout's copy, and .codex/config.toml's
# [mcp_servers.*] is generated from whichever file ends up there.
#
# Run this after cloning and in every new worktree (a linked worktree gets its own empty .claude/).
# Idempotent: safe to re-run, second run changes nothing. Symlinks whose target no longer exists —
# a deleted agent or skill — are pruned.
#
#   scripts/install-agent-config.sh            repo-local only; never writes outside the checkout
#   scripts/install-agent-config.sh --user     also mirrors ~/.claude config into ~/.codex
#
# Self-test: scripts/test-install-agent-config.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"

# Skills owned by sibling repos, linked in when that sibling is checked out next to this one.
# Paths are relative to $REPO.
EXTRA_SKILLS=(../spirectl/skills/spirectl ../godot-qa/skills/godot-qa)

DO_USER=0
for arg in "$@"; do
  case "$arg" in
    --user) DO_USER=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $arg (expected --user)" >&2; exit 2 ;;
  esac
done

link() { # link <target> <linkpath>
  mkdir -p "$(dirname "$2")"
  ln -sfn "$1" "$2"
}

echo "==> agents"
if compgen -G "$REPO/agents/*.md" > /dev/null; then
  mkdir -p "$REPO/.claude/agents"
  for f in "$REPO"/agents/*.md; do
    link "../../agents/$(basename "$f")" "$REPO/.claude/agents/$(basename "$f")"
    echo "    .claude/agents/$(basename "$f")"
  done
fi

echo "==> skills"
if compgen -G "$REPO/skills/*" > /dev/null; then
  mkdir -p "$REPO/.claude/skills" "$REPO/.agents/skills"
  for d in "$REPO"/skills/*/; do
    name="$(basename "$d")"
    link "../../skills/$name" "$REPO/.claude/skills/$name"
    link "../../skills/$name" "$REPO/.agents/skills/$name"
    echo "    .claude/skills/$name + .agents/skills/$name"
  done
fi

# Sibling-repo skills. These used to be hand-made symlinks that no script recreated, so a fresh
# clone or worktree silently lost them. A real directory here (a locally installed skill such as
# playwright-cli) is never replaced.
echo "==> sibling skills"
mkdir -p "$REPO/.claude/skills" "$REPO/.agents/skills"
for rel in "${EXTRA_SKILLS[@]}"; do
  name="$(basename "$rel")"
  if [ ! -d "$REPO/$rel" ]; then
    echo "    (skipped $name: $rel is not checked out)"
    continue
  fi
  for dir in .claude/skills .agents/skills; do
    dest="$REPO/$dir/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      echo "    (skipped $dir/$name: a real directory is installed there)"
      continue
    fi
    link "../../$rel" "$dest"
  done
  echo "    .claude/skills/$name + .agents/skills/$name -> $rel"
done

# A deleted agent or skill leaves its symlink behind, and both CLIs then list a broken entry, so
# sweep the three link directories for symlinks whose target no longer exists. Top level only, and
# symlinks only: a real file or directory here (a locally installed skill) is never touched, and a
# linked skill is never descended into.
echo "==> prune dangling links"
pruned=0
for dir in .claude/agents .claude/skills .agents/skills; do
  [ -d "$REPO/$dir" ] || continue
  while IFS= read -r dangling; do
    if [ -e "$dangling" ]; then continue; fi
    echo "    removed $dir/$(basename "$dangling") (target gone: $(readlink "$dangling"))"
    rm -f "$dangling"
    pruned=$((pruned + 1))
  done < <(find "$REPO/$dir" -maxdepth 1 -type l)
done
if [ "$pruned" -eq 0 ]; then echo "    (none)"; fi

# --------------------------------------------------------------------------------------------
# Preflight for the Codex half.
# --------------------------------------------------------------------------------------------
# Project memory is keyed by repository, so every worktree shares the MAIN checkout's store.
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)")"
MEMORY="$MAIN/.agents/memory"

if { [ -e "$REPO/.codex" ] || [ -L "$REPO/.codex" ]; } && [ ! -d "$REPO/.codex" ]; then
  echo "error: remove the stray file \`.codex\` first — this script needs .codex/ to be a directory" >&2
  exit 1
fi

echo "==> memory"
mkdir -p "$MEMORY"
if [ "$REPO" != "$MAIN" ]; then
  if [ -d "$REPO/.agents/memory" ] && [ ! -L "$REPO/.agents/memory" ]; then
    echo "    (skipped: .agents/memory is a real directory here, not a link to the main checkout)" >&2
  else
    mkdir -p "$REPO/.agents"
    ln -sfn "$MEMORY" "$REPO/.agents/memory"
  fi
fi
echo "    $MEMORY"

# Claude Code's auto-memory. autoMemoryDirectory is ignored in project settings.json for security,
# so it has to live in the gitignored settings.local.json. Other keys are preserved.
LOCAL_SETTINGS="$REPO/.claude/settings.local.json"
mkdir -p "$REPO/.claude"
# `-s`, not `-f`: jq run on a ZERO-BYTE file executes the filter zero times, prints nothing and
# exits 0, so the tmp+mv below would truncate the file and silently drop the key.
[ -s "$LOCAL_SETTINGS" ] || echo '{}' > "$LOCAL_SETTINGS"
tmp="$(mktemp)"
jq --arg d "$MEMORY" '.autoMemoryDirectory = $d' "$LOCAL_SETTINGS" > "$tmp" && mv "$tmp" "$LOCAL_SETTINGS"
echo "    .claude/settings.local.json  autoMemoryDirectory"

echo "==> hook (Claude Code)"
SETTINGS="$REPO/.claude/settings.json"
GUARD='"$CLAUDE_PROJECT_DIR"/scripts/claude-guard-bash.sh'
mkdir -p "$REPO/.claude"
[ -s "$SETTINGS" ] || echo '{}' > "$SETTINGS"   # -s: see the settings.local.json note above

# Drop any previous registration of our guard, then add exactly one. Other hooks are preserved.
tmp="$(mktemp)"
jq --arg guard "$GUARD" '
  .hooks //= {} |
  .hooks.PreToolUse //= [] |
  .hooks.PreToolUse |= (map(.hooks |= map(select(.command != $guard))) | map(select((.hooks | length) > 0))) |
  .hooks.PreToolUse += [{matcher: "Bash", hooks: [{type: "command", command: $guard, timeout: 10}]}]
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
echo "    .claude/settings.json  PreToolUse(Bash) -> scripts/claude-guard-bash.sh"

# /.mcp.json is gitignored (it carries local filesystem paths), so a linked worktree has none and
# both CLIs would come up with no MCP servers there. Point it at the main checkout's copy.
echo "==> mcp servers"
if [ "$REPO" = "$MAIN" ]; then
  echo "    /.mcp.json is used as-is"
elif [ ! -f "$MAIN/.mcp.json" ]; then
  echo "    (nothing to link: the main checkout has no /.mcp.json)"
elif [ -e "$REPO/.mcp.json" ] && [ ! -L "$REPO/.mcp.json" ]; then
  echo "    (kept this worktree's own /.mcp.json — a real file is never replaced)"
else
  ln -sfn "$MAIN/.mcp.json" "$REPO/.mcp.json"
  echo "    /.mcp.json -> $MAIN/.mcp.json"
fi

echo "==> codex config"
python3 "$REPO/scripts/gen-codex-config.py" "$REPO" "$MAIN"

echo "==> hook (Codex)"
HOOKS="$REPO/.codex/hooks.json"
# Codex hook commands run in the session cwd and there is no $CLAUDE_PROJECT_DIR equivalent, so the
# repo root is resolved by git at hook time.
CODEX_GUARD='"$(git rev-parse --show-toplevel)"/scripts/claude-guard-bash.sh'
mkdir -p "$REPO/.codex"
[ -s "$HOOKS" ] || echo '{}' > "$HOOKS"   # -s: see the settings.local.json note above
tmp="$(mktemp)"
jq --arg guard "$CODEX_GUARD" '
  .hooks //= {} |
  .hooks.PreToolUse //= [] |
  .hooks.PreToolUse |= (map(.hooks |= map(select(.command != $guard))) | map(select((.hooks | length) > 0))) |
  .hooks.PreToolUse += [{matcher: "^Bash$", hooks: [{type: "command", command: $guard, timeout: 10, statusMessage: "repo guard"}]}]
' "$HOOKS" > "$tmp" && mv "$tmp" "$HOOKS"
echo "    .codex/hooks.json  PreToolUse(^Bash$) -> scripts/claude-guard-bash.sh"

# The commit convention (docs/commit-and-release.md) is enforced by git itself rather than by a CLI
# hook, so it holds for every tool that commits here — both agent CLIs, your terminal, and an agent
# working in a worktree.
echo "==> git hooks"
# RELATIVE on purpose. git config writes to the SHARED .git/config that every linked worktree also
# reads, and git resolves a relative hooksPath against each working tree's own top level — so this
# one setting points every worktree at its own copy of the hook. An absolute path would send them
# all to the main checkout's copy instead.
git -C "$REPO" config core.hooksPath scripts/githooks
git -C "$REPO" config commit.template .gitmessage
echo "    core.hooksPath   scripts/githooks   (commit-msg; enforced on main only)"
echo "    commit.template  .gitmessage"
# Tags are what the release workflows trigger on, so they should be annotated and signed. Only
# claimed when there is a key to sign with: setting it without one makes `git tag` fail outright.
if [ -n "$(git -C "$REPO" config --get user.signingkey || true)" ]; then
  git -C "$REPO" config tag.gpgsign true
  echo "    tag.gpgsign      true               (annotated + signed release tags)"
else
  echo "    (skipped tag.gpgsign: no user.signingkey is configured)"
fi

# --------------------------------------------------------------------------------------------
# Home-directory mirroring. Read-only unless --user was passed.
# --------------------------------------------------------------------------------------------
echo "==> user config (~/.codex)"
USER_RULES="$HOME/.claude/CLAUDE.md"
USER_AGENTS="$HOME/.codex/AGENTS.md"

if [ "$DO_USER" = 1 ]; then
  if [ ! -f "$USER_RULES" ]; then
    echo "    (skipped ~/.codex/AGENTS.md: $USER_RULES does not exist)"
  else
    mkdir -p "$HOME/.codex"
    if [ -L "$USER_AGENTS" ] && [ "$(readlink "$USER_AGENTS")" = "$USER_RULES" ]; then
      echo "    ~/.codex/AGENTS.md -> ~/.claude/CLAUDE.md (already)"
    elif [ -L "$USER_AGENTS" ] || { [ -e "$USER_AGENTS" ] && [ -s "$USER_AGENTS" ]; }; then
      echo "    (skipped ~/.codex/AGENTS.md: it already has content of its own)" >&2
    else
      ln -sfn "$USER_RULES" "$USER_AGENTS"
      echo "    ~/.codex/AGENTS.md -> ~/.claude/CLAUDE.md"
    fi
  fi
else
  echo "    ln -sfn \"$USER_RULES\" \"$USER_AGENTS\"   (run with --user)"
fi

# MCP servers registered globally for Claude Code but missing from ~/.codex/config.toml. That file
# is never edited here: `codex mcp add` owns it.
mcp_add_commands() {
  python3 - "$HOME/.claude.json" "$HOME/.codex/config.toml" <<'PY'
import json, shlex, sys, tomllib
claude_json, codex_toml = sys.argv[1], sys.argv[2]
try:
    with open(claude_json, encoding="utf-8") as fh:
        servers = json.load(fh).get("mcpServers") or {}
except (OSError, json.JSONDecodeError):
    servers = {}
try:
    with open(codex_toml, "rb") as fh:
        have = set(tomllib.load(fh).get("mcp_servers") or {})
except (OSError, tomllib.TOMLDecodeError):
    have = set()
for name in sorted(servers):
    if name in have:
        continue
    e = servers[name] or {}
    kind = (e.get("type") or ("http" if e.get("url") else "stdio")).lower()
    argv = ["codex", "mcp", "add", name]
    if kind == "stdio":
        if not e.get("command"):
            continue
        for k in sorted(e.get("env") or {}):
            argv += ["--env", f"{k}={e['env'][k]}"]
        argv += ["--", e["command"], *[str(a) for a in e.get("args") or []]]
    else:
        if not e.get("url"):
            continue
        argv += ["--url", e["url"]]
    print(shlex.join(argv))
PY
}

MCP_CMDS="$(mcp_add_commands || true)"
if [ -z "$MCP_CMDS" ]; then
  echo "    no user-level MCP servers to mirror"
elif [ "$DO_USER" = 1 ]; then
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    echo "    $cmd"
    eval "$cmd"
  done <<< "$MCP_CMDS"
else
  echo "    user-level MCP servers missing from ~/.codex/config.toml (run with --user):"
  while IFS= read -r cmd; do
    [ -n "$cmd" ] || continue
    echo "      $cmd"
  done <<< "$MCP_CMDS"
fi

cat <<EOF

done.
next steps for Codex:
  - run \`/hooks\` once in the Codex TUI and trust the guard — and again after every edit to
    scripts/claude-guard-bash.sh, because trust is per-hash.
  - if Codex prompts for trust in this directory, accept it, or add
      [projects."$REPO"]
      trust_level = "trusted"
    to ~/.codex/config.toml.
verify with: bash scripts/test-claude-guard.sh && bash scripts/test-install-agent-config.sh \\
             && bash scripts/test-commit-msg-hook.sh
EOF
