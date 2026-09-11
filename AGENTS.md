# Agent Rules And Project Guidelines

This is the clean v2 rewrite of the Slay the Spire 2 Couch Co-op mod.

## Start Here

- **[docs/agents/README.md](docs/agents/README.md)** routes your question to the one document that answers it, and
  lists the subagents and skills. Read it before opening `architecture-map.md` or `qa-recipes.md` — they are large.
- Subagents and skills are committed at [`agents/`](agents/) and [`skills/`](skills/). `.claude/`, `.agents/` and
  `.codex/` are gitignored, so run **`scripts/install-agent-config.sh`** in a fresh clone and in **every new
  worktree**: it links them in for Claude Code, generates the Codex config under `.codex/`, and registers the
  PreToolUse guard for both (`scripts/claude-guard-bash.sh`, self-tested by `scripts/test-claude-guard.sh`).
  Add `--user` to mirror home-level config into `~/.codex/`.
- Project memory is `.agents/memory/MEMORY.md` (in a worktree, a symlink to the main checkout's store). Read that
  index before non-trivial work; record what you learn with the `project-memory` skill.

## Commits

Full rules, and the release runbook, in [docs/commit-and-release.md](docs/commit-and-release.md).

- **Commit your finished work** — don't leave it uncommitted or ask whether to. Never `git push`, and
  never create a tag: both are the maintainer's call.
- On `main`, `scripts/githooks/commit-msg` enforces the format. **Feature branches are unchecked**,
  so commit as freely as you like on a round branch; `main` gets one squash commit per change.

  ```
  type(scope)!: imperative subject, <=72 chars, no trailing period

  Body: what changed and why, wrapped at <=100. Optional.

  Changelog: one sentence a player would read — feat/fix/perf only, or `none`
  ```

- Types: `feat fix perf refactor docs test build ci chore`. Only the first three need a `Changelog:`
  trailer, and internal work is almost always one of the other six. Retiring a flag or an experiment
  is `refactor`, not `cleanup`.
- `git log priv` is a **frozen pre-publication archive** with an unrelated history and an older mixed
  style. Never copy its conventions, and never commit to it.

## Verify What You Touched

Run only the suite(s) covering the files you changed; a coordinator runs full suites once at merge. The full table
is [docs/agents/qa-recipes.md](docs/agents/qa-recipes.md) §6. Three of them are counter-intuitive enough to repeat:

- **`npm run build` DEPLOYS.** Its Vite `outDir` is the installed mod's `frontend/` dir, so building in a branch
  overwrites the live install with unmerged code. The frontend gate is `npx vue-tsc --noEmit && npx vitest run`.
- **`dotnet test` is a silent no-op** on the C# suites — they are custom `Exe` runners that self-register in
  `Program.cs`. Use `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests` (and `…/CouchCoop.Mod.Tests`).
- **`../spirectl/scripts/validate.sh bridge-tests` must run ALONE** — alongside other validate legs it hits an
  MSB3030 parallel-MSBuild race.

## Project Intent

- Build local multiplayer for Slay the Spire 2 by turning phones and browsers into native web clients.
- Keep this repo product-focused: co-op rules, browser client protocol, hosted frontend, per-viewer state, and UI.
- Reuse embeddable `spirectl` libraries for generic STS2 runtime state, semantic actions, and asset extraction where possible.
- The shipped mod must not require users to install the `sts2` CLI.

## Architecture Rules

- Do not copy v1 source wholesale. Use v1 as an oracle for behavior, edge cases, validation, and UI lessons.
- Prefer stable ids over index-first action contracts.
- Keep CouchCoop-specific browser DTOs, URL layout, frontend UX, and co-op behavior in this repo.
- spirectl owns reusable STS2 tooling: generic runtime inspection, semantic action execution, asset extraction, fixtures/scenarios, render snapshots, screenshots, screenshot diff, diagnostics, and reusable validation helpers.
- Missing reusable STS2 support belongs in ../spirectl; do not add CouchCoop-local reflection, asset extraction, encounter fixture, render, screenshot, or diff shims for reusable STS2 behavior.
- Do not hardcode CSS (or otherwise patch) the appearance of presentational elements rendered by `@spirectl/presentation` / `godot-scene-web` in this repo — e.g. rules targeting their `data-godot-*` / `.godot-scene-*` DOM. Those renderers are reusable by other projects, so a CouchCoop-local override only hides the bug here while every other consumer stays broken. Rendering/appearance bugs for reusable STS2 presentation must be fixed in `../godot-scene-web` (or `../spirectl`). Repo-local CSS is only for CouchCoop's OWN chrome (the join/lobby SPA shell, letterboxing), not for the game scene.
- The two sibling repos are aliased to **TypeScript source**, not to built packages: `frontend/vite.config.ts` maps `@spirectl/presentation*` → `../../spirectl/presentation/web/src/**` and `@godot-scene-web/*` → `../../godot-scene-web/packages/*/src`. There is no npm link, no workspace and no build step, so a fix in either sibling is live in couch's dev server immediately — and a sibling left on a branch silently changes what every other agent's dev server and vitest run against. Leave both on clean `main`; to exercise a sibling branch, run couch with a scratch `--config` that re-aliases to the sibling **worktree** (see the `couch-live-lock` skill).
- `.ai/tool-improvements.md` is only for concrete missing or brittle tools discovered by later implementation agents while running a later spec; do not seed it with speculative prerequisite gaps.
- Use `System.Text.Json` for C# JSON.
- Use raw `TcpListener` for the hosted browser server unless a spec explicitly changes that constraint.
- Keep the frontend as a single-screen SPA. Do not introduce Vue Router.

## STS2 Assembly Resolution

- `sts2.local.yaml` must provide `game.assembliesDir`.
- C# projects should resolve STS2/Godot references from `game.assembliesDir`, typically by generating or passing an MSBuild `Sts2AssembliesDir` property.
- Do not infer assembly paths from `game.path`; fail with a clear setup error if `game.assembliesDir` is missing.
- Keep machine-specific generated MSBuild props under ignored local paths such as `.sts2/`.

## Reporting Visual Evidence

- Whenever you claim something was proved visually (a screenshot, a crop, a pixel comparison, a before/after render), you MUST list the concrete image file path(s) that back the claim in the final summary. No visual claim without its image path.

## Artifact Policy

Do not commit official STS2 assets, generated `__sts2_assets__`, screenshots, copied game DLLs, build output, or `dist/` output.

Do not add hard-coded user-specific absolute filesystem paths to committed code, scripts, configuration, or documentation — including as environment-variable defaults. Treat personal assets as local state: copy or modify them only when explicitly asked, and never automate replenishing them from a personal path.

### Game internals in committed files

Do not commit **game code**: transcribed game source, quoted method bodies, private field/method names, or
captured payloads that carry them. Do not commit a *narrative* reconstruction of how the game works internally
either — a comment that walks through a game class's logic is the same disclosure as pasting it. That material
belongs in `.sts2/research/` (see Current Source Of Truth); a committed pointer may say where to look and what
is there, nothing more.

**Resource paths and node names ARE allowed where the mod genuinely needs them to work.** A mod that may not name
a single `res://` path or scene node cannot be written at all: addressing the game's content is the whole job. The
committed precedent is `../spirectl/bridge-mod/src/Spirectl.Sts2/Data/base-game-encounter-visual-packages.json`,
which maps encounters to their backgrounds, spines and slots — game resource paths, no game code. So a producer
fold keyed by scene path, an asset key, or a node name a hook must find is fine. Names discovered through runtime
inspection are the ones to write down; the internals you had to read to find them are not.

Keep it to what the code actually needs, prefer one table over paths scattered through prose, and keep the
*explanation* on the engineering side of the line: say what the node does on screen and why the code treats it
that way, not what the game's source does inside it.

## Current Source Of Truth

- v1 reference repo: `../sts2-couch-coop-v1`
- shared runtime/tooling repo: `../spirectl`
- agent onboarding docs — start at the router, [docs/agents/README.md](docs/agents/README.md), which indexes the architecture map, QA recipes, per-round plans, and the committed subagents/skills
- local, uncommittable research notes: `.sts2/research/` — start at its `INDEX.md`. Findings that cannot be committed (game code, scene structure, captured wire payloads, device measurements) are written up there, per checkout. Anything that would otherwise commit game source or a walkthrough of the game's own logic belongs there, never in `docs/`. Resource paths the mod needs to function may be committed — see Artifact Policy. `../spirectl` keeps its own `.sts2/research/` under the same rule.
