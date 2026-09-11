---
name: round-implementer
description: Implement one scoped work item of a multi-agent round in its own git worktree, then hand back a diff plus evidence. Use when fanning a round out across parallel agents; it carries the worktree setup, suite selection and handoff rules that a brief would otherwise have to restate.
---

# Round implementer

You own **one item**, in **one worktree**, and you hand back **files**, not a transcript. This definition replaces
the standing-rules preamble that [docs/agents/qa-recipes.md](../docs/agents/qa-recipes.md) §8 says to restate in
every brief.

## Orientation, in this order

1. [docs/agents/README.md](../docs/agents/README.md) — which document answers your question.
2. [docs/agents/architecture-map.md](../docs/agents/architecture-map.md) — subsystem → files, mechanism,
   kill-switches, tests. Do not re-derive stable architecture.
3. The round's plan file (under `.ai/plans/` or as given) — the issue list and file:line pointers your round already
   established.
4. If you touch mirror pointer input: the `touch-input-qa` agent and
   [docs/agents/touch-live-harness.md](../docs/agents/touch-live-harness.md). That harness is mandatory before
   landing.

## Worktree setup

Use the `couch-worktree` skill. What it exists to prevent:

- Cut from **current local `main`**, not `origin/main` — worktrees have been created stale more than once.
  `git log --oneline -1` immediately; `git merge --ff-only main` if behind.
- Symlink `frontend/node_modules` to the primary checkout's. This needs a **bare** `node_modules` entry in the
  **shared** `.git/info/exclude` — a linked worktree has no exclude file of its own, and a `node_modules/` pattern
  with a trailing slash does not match a symlink.
- Copy `sts2.local.yaml` and a real `godot-client/.godot` cache to skip a slow full reimport.
- **Set `COUCHCOOP_GAME_MODS_DIR` to a scratch dir** (or strip `modsDir`/`game.path` from the copied
  `sts2.local.yaml`). Otherwise a `dotnet build` or `Mod.Tests` run in your worktree **deploys and poisons the live
  install**. The PreToolUse guard blocks this, but do it anyway.
- Run `scripts/install-agent-config.sh` in the new worktree so the agents and skills resolve there.
- A worktree gets its own **empty** `.sts2/`. Research notes and recordings must be read and written at the real
  checkout path; pass absolute paths to anything under `.sts2/`.

## Verify what you touched — and only that

| Touched | Run |
| --- | --- |
| C# protocol/scene-model | `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests` |
| C# mod/browser-server | `dotnet run --project tests/CouchCoop.Mod.Tests` |
| frontend | `cd frontend && npx vue-tsc --noEmit && npx vitest run` |
| frontend e2e | `cd frontend && npx playwright test` |
| godot-client | `dotnet build godot-client/CouchCoop.GodotClient.csproj` |
| spirectl bridge | `../spirectl/scripts/validate.sh bridge-build`, then **alone**, `… bridge-tests` |

`dotnet test` is a silent no-op on the C# suites (custom `Exe` runners). **Never `npm run build`** — it deploys into
the live mod install. A coordinator runs full suites once at merge; you run only your own.

For `../spirectl/presentation/web` vitest, historically ~44–62 failures in the parity fixtures are **pre-existing**.
Diff **failing test names** against a saved baseline, never raw counts.

## Handoff

- Commit to your assigned branch only. Do not merge to `main`, do not push, unless explicitly told.
- Evidence is file-based — screenshots, recordings, logs at stated paths. Your transcript is not retained for the
  coordinator to re-read. Any visual claim lists its image path.
- Cap the report: a short summary plus concrete `file:line` pointers, not a walkthrough.
- Never commit STS2 assets, screenshots, recordings, build output, or game code — including a narrative
  reconstruction of the game's internals. Uncommittable findings go to `.sts2/research/` at the real checkout path.
- `git add -A` in a worktree can commit the `node_modules` symlink. Add paths explicitly.

## Stop conditions

A hard attempt budget on any live-game or device objective: N failed launches → stop and report the blocker, not an
open-ended retry loop. If your item turns out to depend on another agent's in-flight change, say so and stop rather
than reaching into their files.
