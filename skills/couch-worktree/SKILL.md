---
name: couch-worktree
description: Create a CouchCoop round worktree that is safe to build and test in. Use when fanning a round out to parallel agents, or any time you need an isolated branch checkout of this repo.
---

# Round worktree setup

Use the creator from the CouchCoop main checkout. It starts CouchCoop from local `main`, provisions the
machine-local files the checkout needs, installs agent configuration, and places everything under `.worktrees/`.

```bash
scripts/create-worktree.sh r21-example
```

That creates `.worktrees/r21-example` on branch `worktree/r21-example`. If a task needs different revisions of
the shared repositories, pass one or both refs:

```bash
scripts/create-worktree.sh r21-render \
  --spirectl-ref topic/spirectl-change \
  --godot-scene-web-ref topic/gsw-change
```

An override creates a named bundle at `.worktrees/r21-render/` with the CouchCoop checkout and actual worktrees
for the overridden repositories. Each dependency without an override is a relative link to the shared checkout.
The shared `.worktrees/spirectl` and `.worktrees/godot-scene-web` links point at the sibling main checkouts.
Existing destinations and branch names are refused; the creator never refreshes an existing worktree.

## What the creator prepares

- Copies `sts2.local.yaml` and `godot-client/.godot` from the main checkout.
- Links `frontend/node_modules` and the shared `.ai` directory.
- Runs `scripts/install-agent-config.sh`, which creates the local agent links/config and points
  `.agents/memory` to the main checkout's memory store.
- Creates an empty, worktree-local `.sts2/` directory. Do not copy or link the main checkout's `.sts2`.
- Adds bare `node_modules` and `frontend/node_modules` patterns to the shared Git exclude file so a symlink is
  not staged accidentally.

## Build safety

`Directory.Build.props` resolves `modsDir` from this worktree's copied `sts2.local.yaml` and deploys on every
build. Before any C# build or test, set a scratch output path, using the name passed to the creator:

```bash
export COUCHCOOP_GAME_MODS_DIR=/tmp/cc-mods-r21-example
```

The PreToolUse guard blocks builds when this is unset. Do not build into the installed game directory.

## Verify before starting

```bash
cd .worktrees/r21-example
git log --oneline -1
git status --short
readlink frontend/node_modules
test -f sts2.local.yaml && test -d godot-client/.godot && test -d .sts2
ls .claude/agents .claude/skills
test -L .agents/memory && test -d .codex
```

For a dependency bundle, also inspect the entries under `.worktrees/<name>/` and confirm overridden repos are
worktrees while other dependencies link to the shared `.worktrees` entries.

## Teardown

Run the dry-run report first:

```bash
.ai/worktree_prune.sh
```

It lists every registered CouchCoop worktree, including detached checkouts. A workspace is eligible only when
every actual checkout is clean and its exact commit is contained in that repository's local `main`. `--apply`
removes eligible checkouts, branches, and their ignored files; dirty or unmerged work is retained.

## Related

The `round-implementer` agent (which assumes this setup), `couch-deploy`, and
[docs/agents/qa-recipes.md](../../docs/agents/qa-recipes.md) §7.
