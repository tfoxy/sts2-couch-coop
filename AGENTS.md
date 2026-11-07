# Agent Rules And Project Guidelines

This is the clean v2 rewrite of the Slay the Spire 2 Couch Co-op mod. These rules apply to every contributor, human
or agent.

## Start Here

- Run **`scripts/install-agent-config.sh`** in a fresh clone and in **every new worktree**. It installs the git hooks
  (`core.hooksPath`), wires agent harness config into the gitignored `.claude/`, `.agents/`, `.codex/` and `.dsh/`
  directories, and registers the PreToolUse guard (`scripts/claude-guard-bash.sh`, self-tested by
  `scripts/test-claude-guard.sh`).
- Build, configuration and local-setup details are in [docs/configuration.md](docs/configuration.md); the architecture
  overview is [docs/architecture.md](docs/architecture.md); commits and releases are
  [docs/commit-and-release.md](docs/commit-and-release.md).
- **Automated runs of the game** use Godot `--headless` or a private `gamescope --backend headless` compositor —
  never Xvfb, and never a window on the user's desktop without asking first.

## Commits

Full rules, and the release runbook, in [docs/commit-and-release.md](docs/commit-and-release.md).

- **Commit your finished work** — don't leave it uncommitted or ask whether to. Never `git push`, and
  never create a tag: both are the maintainer's call.
- On `main`, `scripts/githooks/commit-msg` enforces the format. **Feature branches are unchecked**,
  so commit as freely as you like on a branch; `main` gets one squash commit per change.

  ```
  type(scope)!: imperative subject, <=72 chars, no trailing period

  Body: what changed and why, wrapped at <=100. Optional.

  Changelog: one sentence a player would read — feat/fix/perf only, or `none`
  ```

- Types: `feat fix perf refactor docs test build ci chore`. Only the first three need a `Changelog:`
  trailer, and internal work is almost always one of the other six. Retiring a flag or an experiment
  is `refactor`, not `cleanup`.

## Verify What You Touched

Run the suite(s) covering the files you changed; full suites run once before a change lands. Three facts about them
are counter-intuitive enough to state here:

- **`npm run build` DEPLOYS.** Its Vite `outDir` is the installed mod's `frontend/` dir, so building in a branch
  overwrites the live install with unmerged code. The frontend gate is `npx vue-tsc --noEmit && npx vitest run`.
- **`dotnet test` is a silent no-op** on the C# suites — they are custom `Exe` runners. `CouchCoop.MirrorProtocol.Tests` dispatches in
  `Program.cs`; `CouchCoop.Mod.Tests` has no `Program.cs` — its top-level statements live in `BrowserServerRouteTests.cs`
  as `if (args is ["<group>", ..])` branches. Run a group with
  `dotnet run --project tests/CouchCoop.Mod.Tests -- <group>` (and `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests`).
- **`../spirectl/scripts/validate.sh bridge-tests` must run ALONE** — alongside other validate legs it hits an
  MSB3030 parallel-MSBuild race.

## Project Intent

- Build local multiplayer for Slay the Spire 2 by turning phones and browsers into native web clients.
- Keep this repo product-focused: co-op rules, browser client protocol, hosted frontend, per-viewer state, and UI.
- Reuse spirectl where another tool already shares the code: asset extraction, the game-API lane table and the runtime hook substrate. Runtime behavior only CouchCoop needs (scene observation, roster and per-viewer facts, browser input, seat and lobby handling) lives in this repo.
- The shipped mod must not require users to install the `sts2` CLI.

## Architecture Rules

- Do not copy v1 source wholesale. Use v1 as an oracle for behavior, edge cases, validation, and UI lessons.
- Prefer stable ids over index-first action contracts.
- Keep CouchCoop-specific browser DTOs, URL layout, frontend UX, and co-op behavior in this repo.
- spirectl owns the STS2 tooling it has a consumer for today: runtime inspection and semantic actions for the CLI and QA bridge, asset extraction, fixtures/scenarios, render snapshots, screenshots, screenshot diff, diagnostics, and validation helpers. Reuse is earned: code moves to spirectl when a second consumer exists, not before. Named exception: geoclip (cheap animated Spines without the Spine library) stays in spirectl as a tool in the making, until its first spirectl consumer lands.
- Support the CLI or QA bridge also needs belongs in ../spirectl; do not add CouchCoop-local asset extraction, encounter fixture, render, screenshot, or diff shims for it. Support only CouchCoop needs starts here, using typed access with the game-lane split like the rest of the mod, and its Harmony targets and any by-name reads go through the existing gates (beta-targets, code verify-references). Do not add unused lanes to the embedded copy.
- **The browser makes gameplay happen through REAL INPUT, not through spirectl semantic actions.** A viewer's tap becomes the same hover / press / release / key events a player at the keyboard produces, replayed at a resolved coordinate, and the game's own widget decides what that means. Do **not** reach for a spirectl semantic action (`claim-reward`, `select-card`, `buy-*`, …) to commit a player's choice: a semantic action re-implements the game's commit path, and a re-implementation drifts — the case that set this rule was a refused potion reward that was destroyed because the bridge retired a row the game had declined. **Any use of a semantic action needs the maintainer's explicit go-ahead for that specific case.** If you think you need one, ask — do not adopt it because it is the shorter path. Read-only spirectl surfaces (state, scene stream, screenshots, inspection) are unaffected; this rule is about causing state changes.
- **No polling: find the hook.** Do not add a timer, a loop, a repeated read or a "cheap fact" check to learn that something in the game changed. Find the game's own signal (an event, a screen change, a typed Harmony postfix on the method that changes the fact) and act on it, deferring any game read out of the signal callback by one frame. If no hook resolves, stop and report what you looked for; do not fall back to a poll. **Polling is allowed only where the maintainer has explicitly allowed it for that specific case.** A poll that already exists in code you touch stays as it is and is listed in your report; do not extend it or copy its pattern.
- Do not hardcode CSS (or otherwise patch) the appearance of presentational elements rendered by `@spirectl/presentation` / `godot-scene-web` in this repo — e.g. rules targeting their `data-godot-*` / `.godot-scene-*` DOM. Those renderers are reusable by other projects, so a CouchCoop-local override only hides the bug here while every other consumer stays broken. Rendering/appearance bugs for reusable STS2 presentation must be fixed in `../godot-scene-web` (or `../spirectl`). Repo-local CSS is only for CouchCoop's OWN chrome (the join/lobby SPA shell, letterboxing), not for the game scene.
- The two sibling repos are aliased to **TypeScript source**, not to built packages: `frontend/vite.config.ts` maps `@spirectl/presentation*` → `../../spirectl/presentation/web/src/**` and `@godot-scene-web/*` → `../../godot-scene-web/packages/*/src`. There is no npm link, no workspace and no build step, so a fix in either sibling is live in couch's dev server immediately — and a sibling left on a branch silently changes what every other agent's dev server and vitest run against. Leave both on clean `main`; to exercise a sibling branch, point couch at the sibling **worktree** instead (`COUCHCOOP_GSW_ROOT` for godot-scene-web, or a scratch Vite `--config` that re-aliases the paths).
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
- local, uncommittable research notes: `.sts2/research/` — start at its `INDEX.md`. Findings that cannot be committed (game code, scene structure, captured wire payloads, device measurements) are written up there, per checkout. Anything that would otherwise commit game source or a walkthrough of the game's own logic belongs there, never in `docs/`. Resource paths the mod needs to function may be committed — see Artifact Policy. `../spirectl` keeps its own `.sts2/research/` under the same rule.

## Public and private material

This repository is public. Internal R&D lives in the private companion `tfoxy/sts2-couch-coop-internal`, checked out
at `private/` (gitignored; `scripts/install-agent-config.sh` links every worktree's `private` to the main checkout's).
Maintainers with access: `git clone git@github.com:tfoxy/sts2-couch-coop-internal.git private`.

- **Public:** code, tests, fixtures, wire and file-format specs, user, integration and contributor docs, and
  benchmarks with instructions to run them.
- **Private** (at `private/<original path>`): research reports and results, experiment write-ups, performance
  investigations and ledgers, handoffs, plans and roadmaps, design explorations, agent definitions and skills that
  encode project expertise, device and rig specifics.
- Source comments state the contract and the reason, not the measurement log: no device numbers, round or gate tags,
  or citations of private documents.
- Public commits, PR bodies, release notes and CI logs never quote or cite `private/` content.
- `scripts/check-public-tree.py` enforces a markdown allowlist and a denylist (`scripts/validate.sh`, the pre-push
  hook, CI). A new public `.md` file must be added to `scripts/public-tree.conf`.

@private/AGENTS.md
