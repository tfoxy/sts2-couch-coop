---
name: couch-worktree
description: Create a CouchCoop round worktree that is safe to build and test in. Use when fanning a round out to parallel agents, or any time you need an isolated branch checkout of this repo.
---

# Round worktree setup

Six things have gone wrong here before. The order below is the order that prevents them.

```bash
NAME=r21-example
PRIMARY="$(git rev-parse --show-toplevel)"
WT="$(dirname "$PRIMARY")/cc-$NAME"
```

## 1. Cut from current LOCAL main

```bash
git -C "$PRIMARY" worktree add -b "$NAME" "$WT" main
git -C "$WT" log --oneline -1
```

**Not `origin/main`.** Worktrees have been created stale against the remote more than once. If the new worktree is
behind, `git -C "$WT" merge --ff-only main` before you edit anything.

## 2. Make the shared exclude tolerate a symlinked node_modules

A linked worktree has **no exclude file of its own** — the main repo's `.git/info/exclude` is shared by all
worktrees. And a `node_modules/` pattern with a trailing slash matches directories only, **not a symlink**:

```bash
grep -qxF 'node_modules' "$PRIMARY/.git/info/exclude" || echo 'node_modules' >> "$PRIMARY/.git/info/exclude"
grep -qxF 'frontend/node_modules' "$PRIMARY/.git/info/exclude" || echo 'frontend/node_modules' >> "$PRIMARY/.git/info/exclude"
```

Bare names, no trailing slash. Skip this and a blanket `git add -A` commits the symlink — one landed in a merge.

## 3. Link node_modules, copy local config and the Godot cache

```bash
ln -s "$PRIMARY/frontend/node_modules" "$WT/frontend/node_modules"
cp "$PRIMARY/sts2.local.yaml" "$WT/sts2.local.yaml"
cp -r "$PRIMARY/godot-client/.godot" "$WT/godot-client/.godot"
```

The `.godot` cache (`imported/`, `uid_cache.bin`, `mono/`) is what saves the slow full reimport on first Godot run
— not the tracked `*.cs.uid` sidecars, which are only the inputs the local cache is built from.

## 4. Point builds at scratch — this is the one that poisons the live install

```bash
export COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-$NAME
```

`Directory.Build.props` resolves `modsDir` from **this worktree's** `sts2.local.yaml` and deploys on every build,
so a `dotnet build` or a `Mod.Tests` run here would silently replace the live game install with the worktree's
code. Either export the scratch dir (per shell, in every Bash call that builds) or strip `modsDir`/`game.path`
from the copied `sts2.local.yaml`. The PreToolUse guard blocks an unset build from a worktree, but do not rely on
it. Recovery, if it already happened: `scripts/build-local-mod.sh` from `main` plus a game restart.

## 5. Wire the agent config

```bash
cd "$WT" && bash scripts/install-agent-config.sh
```

A linked worktree gets its own empty `.claude/`, so the subagents, skills and the guard hook do not exist there
until this runs. The same script also points `.agents/memory` at the **main checkout's** memory store (a symlink;
never a second real directory) and generates `.codex/`, so Codex CLI sees the same agents, skills, MCP servers and
guard here. Codex will prompt to trust this new path — accept it — and it trusts hooks by content hash, so run
`/hooks` once in its TUI in the worktree.

## 6. Know what your `.sts2/` is

A worktree gets its **own empty `.sts2/`** — a plain directory, not a symlink. Recordings, research notes and
artifacts written there are invisible to everyone else. Read and write those at the real checkout path, and pass
**absolute** paths to anything under `.sts2/` (a bare `--recording` name resolves against the empty local one). A
`--trace` run creates a partial local `.sts2/bench/` that makes the draw-list oracle silently skip — delete it
afterwards.

## Verify before you start work

```bash
cd "$WT"
git log --oneline -1                       # on your branch, at current main
ls -l frontend/node_modules                # symlink into the primary checkout
git status --short                         # clean, and no node_modules entry
echo "$COUCHCOOP_GAME_MODS_DIR"            # a scratch path, not empty
ls .claude/agents .claude/skills           # symlinks resolve
ls -ld .agents/memory .codex               # memory symlink -> main checkout; .codex generated
```

## Teardown

```bash
git -C "$PRIMARY" worktree remove "$WT"     # or: worktree prune, once the dir is gone
```

## Related

The `round-implementer` agent (which assumes this setup), `couch-deploy`, and
[docs/agents/qa-recipes.md](../../docs/agents/qa-recipes.md) §7.
