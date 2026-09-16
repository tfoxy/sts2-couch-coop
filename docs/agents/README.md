# Agent docs — start here

These documents are large on purpose: they are the accumulated cost of rounds that went wrong. Load **the section
that answers your question**, not the whole file.

## Route by what you are about to do

| You are… | Read | Then use |
| --- | --- | --- |
| finding out what a subsystem does, where it lives, what its kill-switches and tests are | [architecture-map.md](architecture-map.md) | — |
| about to launch, deploy, or drive the real game | [qa-recipes.md](qa-recipes.md) §0–§4, §7 | `live-game-qa` agent, `couch-live-lock` + `couch-deploy` skills |
| changing mirror pointer input (`inputCapture`, `pointerMap`, `raiseInverse`, `viewScaleInverse`, `confirmTap`, hand raise) | [touch-live-harness.md](touch-live-harness.md) | `touch-input-qa` agent — **the H1–H16 harness is mandatory before landing** |
| about to make a viewer's tap *do* something in the game — especially if a spirectl semantic action looks like the shortcut | [architecture-map.md](architecture-map.md) "Real input, not semantic actions" | **ask the maintainer before using a semantic action** |
| measuring a change, or comparing two rendering backends | [../mirror-combat-bench.md](../mirror-combat-bench.md) + [qa-recipes.md](qa-recipes.md) §5 | `mirror-bench` agent |
| checking a geoclip's first usable browser frame or atlas-page reuse | [geoclip-browser-probe.md](geoclip-browser-probe.md) | `mirror-bench` agent |
| benchmarking geoclip against the `/spines/` still on host blocking time and browser first-frame latency | [geoclip-knights-bench.md](geoclip-knights-bench.md) | `mirror-bench` agent, `couch-live-lock` skill |
| analysing canvas-stage draw lists, atlas bounds, text coverers, or animation concurrency offline | [canvas-stage-probes-aug26.md](canvas-stage-probes-aug26.md) | `mirror-bench` agent |
| chasing a bug a **player** hit that you cannot reproduce | [repro-recorder.md](repro-recorder.md) | `scripts/analyze-repro.mjs`, `scripts/replay-repro.mjs` |
| designing or implementing in-game issue reporting, diagnostic bundles, or a support backend | [in-game-issue-reporting-investigation.md](in-game-issue-reporting-investigation.md) | start with the evidence limits and phased recommendation; no production backend exists |
| implementing one item of a multi-agent round | this file, then [architecture-map.md](architecture-map.md) | `round-implementer` agent, `couch-worktree` skill |
| touching `clip_contents` or anything with a wide blast radius | [clip-contents-blast-radius.md](clip-contents-blast-radius.md) | — |
| working on host-side render/encode cost | [host-render-cost-aug22.md](host-render-cost-aug22.md), [host-render-cost-aug22-round2.md](host-render-cost-aug22-round2.md) | — |
| working on phone access, HTTPS, PWA, the public origin | [local-network-access.md](local-network-access.md) | — |
| changing browser UI copy, locale selection, manifests, or offline-page text | [../browser-localization.md](../browser-localization.md) | — |
| changing native in-game CouchCoop strings | [../native-localization.md](../native-localization.md) | — |
| changing a browser-server boundary, resource route, cache, or network limit | [../security.md](../security.md) | — |
| building, deploying or driving a **second game install** (a beta or older game branch) | [../configuration.md](../configuration.md) "Two game installs on one machine" | `scripts/with-game-branch.sh` — never `sts2 --config` alone |
| writing a commit message, merging a branch to `main`, cutting a release, or uploading to the Steam Workshop | [../commit-and-release.md](../commit-and-release.md) | `release-notes` skill |

## Subagents and skills

Committed at [`agents/`](../../agents/) and [`skills/`](../../skills/). `scripts/install-agent-config.sh` links
them into the gitignored `.claude/` (Claude Code reads `.claude/agents/` and `.claude/skills/`) and
`.agents/skills/` (Codex CLI), and **generates** `.codex/` — `agents/*.toml`, `config.toml`, `hooks.json` — from
those same committed sources. **Run that script in every fresh clone and every new worktree** — a linked worktree
gets its own empty `.claude/`. Nothing under `.codex/` is hand-edited; change `agents/`, `skills/` or `.mcp.json`
and re-run the installer, whose self-test is `scripts/test-install-agent-config.sh`. In a worktree it also points
the gitignored `/.mcp.json` at the main checkout's copy, so both CLIs get the same MCP servers there.

| Subagent | For |
| --- | --- |
| `mirror-bench` | replay benches, canvas-vs-DOM parity gates, trace attribution, phone A/B legs |
| `touch-input-qa` | the H1–H16 live pointer matrix |
| `live-game-qa` | lock protocol, isolated instances, deploy + install verification |
| `round-implementer` | one scoped item of a round, in its own worktree |

| Skill | For |
| --- | --- |
| `couch-live-lock` | take / hand over / release the live-QA lock, including the sibling-restore checklist |
| `couch-deploy` | the only working deploy path, and proving the install is yours |
| `couch-worktree` | round worktree setup, with the six gotchas it exists to prevent |
| `project-memory` | reading and writing `.agents/memory`, the durable store both CLIs share |
| `release-notes` | turning `Changelog:` trailers into the player-facing `CHANGELOG.md` section |

The installer also links the **sibling-repo** skills, but only when that sibling is checked out next to this
repo: `spirectl` → [`../../../spirectl/skills/spirectl`](../../../spirectl/skills/spirectl) and `godot-qa` →
`../../../godot-qa/skills/godot-qa`, each tracking its own repo. `playwright-cli` is *not* linked — it is a real
directory installed locally, and the installer never replaces a real directory with a symlink.

Project memory lives at `.agents/memory/` in the **main checkout**; every worktree gets a symlink to it, and
Claude Code's `autoMemoryDirectory` is pointed there by the installer. Read `MEMORY.md` before non-trivial work.

A PreToolUse hook (`scripts/claude-guard-bash.sh`) blocks the documented footguns — the frontend build that
deploys, `dotnet test` on the custom runners, an instance-less `sts2 game close`, self-matching `pkill -f`, nested
xvfb, and an unset-scratch build from a worktree. It fires in every permission mode, and the **same script** is
registered for both CLIs (`.claude/settings.json` and `.codex/hooks.json`), so the verdict is identical under
either. Its two-sided self-test is `scripts/test-claude-guard.sh`, which asserts that on both envelopes.

Codex trusts a hook by **content hash**: run `/hooks` once in its TUI to trust the guard, and again after every
edit to `scripts/claude-guard-bash.sh`, or it silently will not fire.

The installer also points `core.hooksPath` at `scripts/githooks/`, whose `commit-msg` enforces the commit
convention ([../commit-and-release.md](../commit-and-release.md)) — on `main` only, so a round branch is never
blocked. That one is a *git* hook, not a CLI hook: it applies to every tool that commits here, and to every
worktree, because the configured path is relative. Self-test: `scripts/test-commit-msg-hook.sh`.

## Sibling repos

Work here routinely spans two others; each has its own `AGENTS.md` and its own committed `agents/`.

- **[`../../../spirectl`](../../../spirectl)** — reusable STS2 runtime, producers, semantic actions, assets, the
  `sts2` CLI. Anything useful to *any* STS2 tool belongs there. Start at its `docs/agent-quickstart.md`.
- **[`../../../godot-scene-web`](../../../godot-scene-web)** — the generic Godot-scene→web renderer. Rendering and
  appearance bugs in the game scene are fixed **there**, never patched with CouchCoop-local CSS.

Both are aliased to **source** by [`frontend/vite.config.ts`](../../frontend/vite.config.ts), so an edit in either
is live in couch's dev server with no build step. That is also why they must be left on clean `main` — see the
`couch-live-lock` skill.

## Local, uncommittable notes

`.sts2/research/` (git-ignored, per checkout — start at its `INDEX.md`) holds what cannot be committed: game
internals, scene structure, captured wire payloads, device measurements. A worktree gets its own empty `.sts2/`, so
always read and write those at the real checkout path.

## Known gaps in this folder

- The geoclip pipeline (bake → pack → replay → IoU fit → selftest) has **no document**; it lives in the headers of
  `scripts/make-geoclip-fixture.mjs`, `geoclip-pack.mjs`, `probe-geoclip-replay.mjs`, `fit-geoclip-iou.py` and
  `selftest-geoclip.mjs`.
