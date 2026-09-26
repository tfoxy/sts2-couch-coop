# Should CouchCoop keep its runtime in spirectl?

Prepared 2026-09-25. A decision handoff: **analyze and recommend. Do not move code.** The maintainer decides.

## The question

`CLAUDE.md` makes spirectl the owner of reusable STS2 runtime code. It says to reuse the embeddable spirectl
libraries for state, actions and assets ([CLAUDE.md:68](../../CLAUDE.md#L68)), that spirectl owns generic
runtime inspection (:76), and that missing reusable support belongs in `../spirectl` rather than in
CouchCoop-local reflection (:77). CouchCoop compiles `../spirectl/bridge-mod/src/Spirectl.Sts2` from source
into its private `CouchCoop.Spirectl.dll`.

The maintainer's concerns, in their words:

- We keep the code DRY for reuse that may never happen: no second consumer is known for much of it.
- The DLL keeps growing, including code CouchCoop stops using.
- A change validates much more slowly in spirectl than in CouchCoop.

The original reason for the split has gone away:

- **Then:** state and semantic actions were shared by the spirectl CLI and by the mod's structured view. That
  view had synthetic seats and no mirror, so it needed the same state reads and action triggers as the CLI.
- **Now:**
  - The browser is a mirror of the game's own scene, fed by a scene-delta stream.
  - Gameplay goes through real input; semantic actions need explicit approval (`CLAUDE.md` "Real input,
    not semantic actions").
  - Seats are real headless ENet clients, not synthetic seats.

**Decide what the boundary should be now.**

## Evidence already on hand

- **Validation cost.** Planning a narrow roster read (the state-read replacement) was estimated at 5+ hours
  through spirectl, versus 2–3 hours CouchCoop-side. The spirectl leg dominates:
  - a builder refactor that must keep the full snapshot byte-identical for the CLI/MCP/bridge;
  - Harmony hook pins for both game lanes;
  - `bridge-tests` must run alone (MSB3030 race), and the live host needs a separate compile;
  - pair-root worktrees and a `release-dependencies.json` pin bump;
  - landing in two repos.

  The round was paused. The plan is local at
  `~/.claude/plans/handoff-replace-couchcoop-s-full-iridescent-waterfall.md`; the spirectl contract sits on
  branch `roster-port` (`77d5f2dc`).
- **The first exception has already landed.** The seat monitor now reads the host's peer list CouchCoop-side
  (`7d089e03`), and [handoff-hosting-tracker-state.md](handoff-hosting-tracker-state.md) is the next one.
- **Churn.** 22 of spirectl's 31 commits between Aug-25 and Sep-25 touched `bridge-mod/src/Spirectl.Sts2`.
  Check how many were driven by CouchCoop needs.
- **Size.** In a Debug build of `7d089e03`, `CouchCoop.Spirectl.dll` is 3.9 MB, against 2.3 MB for
  `CouchCoop.Mod.dll`. `scripts/validate-spirectl-embedded-boundary.sh` fails if the embedded DLL drifts more
  than 4 KB from the upstream `Spirectl.Sts2.dll`: the embedded copy is contractually the whole shared project.
- **Two copies.** The embedded runtime and the QA bridge are separate copies of the same code, so
  profiling or fixing one does not measure the other (`handoff-host-cpu.md`).

What CouchCoop imports today (`using` counts across `src/`; verify and complete):

| Namespace | Uses |
| --- | --- |
| `Embedding` (18) | runtime ports: capabilities, assets, state, scene delta, game model, Spine catalog, geoclip baker, semantic actions, scene-watch controls, multiplayer connection |
| `Live` (15) | main-thread dispatcher, `Sts2ScreenContext`, scene watcher, render phase/encode budget, offscreen extraction, Spine hooks/stills/geoclip, browser pad map, MonoMod native dependencies, build identity |
| `Core.SceneInspection` (12) | the scene-delta DTOs the mirror is built on |
| `Core.State` (8) | the full `StateSnapshot`, being retired |
| `Core.Artifacts`, `Core.Actions`, `Core.Models`, `Core.Logging` | geoclip baker; actions still used: `MouseClick`, `JoinLobbyPlayer`, `LeaveLobbyPlayer`, `DisconnectClient`, name overrides |

Build-level coupling:

- `Directory.Build.props` imports spirectl's game-API lane table (`Sts2GameApi.props`).
- The frontend aliases `@spirectl/presentation` to spirectl TypeScript source.
- `release-dependencies.json` pins spirectl by commit.

## What to analyze

1. **Inventory.** Map each spirectl component CouchCoop compiles in to a row. For each, record:
   - whether CouchCoop uses it;
   - whether the CLI, bridge, QA tooling, MCP or `presentation/web` use it;
   - its size contribution (Release IL; an ILLink or reference-reachability pass from CouchCoop's call sites
     is fine);
   - its commits in the last 60 days and which repo's need drove each;
   - its game coupling (by-name reflection, lane-split members, Harmony targets).

   Mark each row **shared** (a real second consumer exists), **CouchCoop-only**, or **dead in the embedded
   copy**.
2. **Cost of the current boundary.** Time a small CouchCoop-only change against the same change routed
   through spirectl, from existing receipts or one timed no-op round trip. Name where the time goes.
3. **What the boundary buys.** Weigh:
   - the per-lane game-API manifest and `scripts/verify-reflected-game-members.sh`, which protect against game
     updates;
   - QA reading the same extraction code as the product;
   - one place to fix when the game changes;
   - the heavy asset and Spine machinery.

   Check the licensing and NOTICE implications of moving code between the two repos.
4. **Options.** Cost each, including migration effort, the risk of drift across game updates, and QA impact:
   - **A. Status quo, trimmed:** keep the boundary, shrink the embedded copy (a smaller shared project or a
     trimming step), and speed up validation.
   - **B. Split by ownership:** CouchCoop-only runtime code moves into CouchCoop, and spirectl keeps what the
     CLI/bridge/QA actually share. CouchCoop compiles only that shared subset.
   - **C. CouchCoop owns its runtime:** the embedded runtime moves into CouchCoop, and spirectl continues
     independently as the CLI/QA tool, accepting some duplication with the bridge.
   - **D. Relaxed rule:** keep the code where it is, but new code starts CouchCoop-side and moves to spirectl
     only once a second consumer exists ("reuse is earned").
5. **Adjacent, note only.** The same "keep it reusable" rule governs `@spirectl/presentation` and
   `../godot-scene-web` (`CLAUDE.md`: fix presentation bugs there, not with CouchCoop CSS). Say whether the
   same reasoning applies, but do not decide it here.

## Deliverable

`docs/agents/spirectl-boundary-review.md`, containing:

- the inventory table;
- the measured costs;
- the options with their costs;
- **one recommendation**;
- a phased migration sketch whose first step is small and independently useful;
- proposed replacement wording for `CLAUDE.md` lines 68 and 76–77.

Do **not** edit `CLAUDE.md` or `AGENTS.md`; the maintainer approves the wording.

Also state what happens to the in-flight work under the recommendation:

- the paused roster-port round;
- [handoff-hosting-tracker-state.md](handoff-hosting-tracker-state.md);
- [handoff-zero-client-guard.md](handoff-zero-client-guard.md), whose choke point depends on where state reads
  live.

## Constraints

- **Analysis only.** No code moves, no sibling branches left checked out, and both siblings stay on clean `main`.
- **Scratch builds only**, for any size measurement. Use `flock --close /tmp/sts2-dotnet-build.lock` and a scratch
  `COUCHCOOP_GAME_MODS_DIR`. `npm run build` and solution builds deploy to the live install.
- **The memo is committed**, so it names components, sizes and counts, not game internals. Put game-derived
  detail in `.sts2/research/`.
- **Timebox: about 2–3 hours.** Prefer a clear recommendation with stated uncertainty over an exhaustive audit.
