---
name: live-game-qa
description: Drive a real Slay the Spire 2 instance — lock protocol, isolated headless instances, mod deploy and install verification, fixtures, lobby scenarios, screenshots. Use for any task that needs the actual game running rather than a recording or a fixture replay.
---

# Live-game QA

Two things make this role different from ordinary work: the game is **shared state on this machine**, and a mistake
here is **irreversible run mutation** — a blind click has consumed a real card reward.

Reference: [docs/agents/qa-recipes.md](../docs/agents/qa-recipes.md) §0–§4 (safety, lock protocol, isolated instance
launch, fixtures) and §7 (gotchas).

## Before anything touches the live game

1. **Never script blind input into a live session.** Capture the screen first. Prefer a fixture or a recording. Any
   scripted drive must `dev scene hover` first and click **at the returned `hoverPosition`** — clicks are focus-gated.
2. **Take scoped leases with `scripts/live-qa-lock.mjs`.** Every session takes `shared:install`; take the named
   game/device/CDP/port resources it actually touches, exclusive for driving and shared for passive inspection.
   Deploy takes `exclusive:install`. The helper acquires the set atomically; a conflict means wait or choose a
   genuinely independent instance, never delete another owner's lease.
3. Prefer an **isolated instance** over the developer's game whenever the task allows it: per-instance
   `XDG_DATA_HOME`, its own socket, and the `steam/<steamid>/` profile seeded into the fresh data dir first (without
   it a cloud-sync modal blocks and the browser server never starts). Never link the whole `couch-coop` dir into a
   slot — the slot is inside it and the walk never terminates. Never launch a second `-fastmp host_standard` while a
   live host runs.
4. **The operator's own game session is NOT a blocker — never wait it out, never kill it.** A game on the DEFAULT
   profile (`~/.local/share/SlayTheSpire2`) whose godot.log shows human activity (window drags, fullscreen toggles,
   Steam profile writes) is the operator playing; it can run for hours. Deploying while it runs is SAFE — its DLLs
   are already in memory and the deploy affects the next launch only. Take your measurements in an isolated instance
   immediately instead of polling for the operator to stop (one round lost 80+ minutes to exactly that). Port 13337
   and the default port file belong to the operator's game — read YOUR instance's walked port from its own
   port+pid file. Scope any "a game is already running" refusal guard to YOUR instances (attribute by user-dir/env);
   the operator's game is expected and exempt. Paired within-run statistics absorb the operator's steady load;
   contamination drop rules catch spikes; flag absolute numbers as not quiet-machine-comparable.
5. **No visible game window on the operator's desktop, ever.** A headed instance goes under xvfb with the wayland
   trap defused — `scripts/run-gpu.sh` is the recipe (`env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a …`;
   xvfb-run sets DISPLAY but the app follows WAYLAND_DISPLAY onto the real compositor). `sts2.local.yaml` injects a
   gamescope launchWrapper and `--display-driver wayland` — run `sts2` from a scratch cwd with a modified copy
   (no wrapper, x11/no driver arg) for xvfb launches; see qa-recipes §2. Use headed-under-xvfb, not `--headless`,
   whenever measurement comparability matters: windowless mode arms the visual suspender and idle frame caps, which
   change per-frame costs and can flatter a benchmark into a false pass.

## Deploy, and proving what is installed

Use the `couch-deploy` skill. The short version:

- `sts2 game deploy … --build` **works again** (2026-09-04; the CWD-resolution mismatch is fixed and sts2 now
  fails rather than copying a directory the build did not refresh). `scripts/build-local-mod.sh` still works;
  `sts2 --json game deploy src/CouchCoop.Mod.Loader --build --restart --verify` does the whole loop.
  `--wait-quiescent-ms` reports a settle verdict but does NOT yet replace the live scenarios' 20 s `dev.delay`
  (it returned quiescent after 1.2 s on 2026-09-04 — see `.ai/tool-improvements.md`).
- A change in `../spirectl` needs **both** `sts2 game install-bridge` **and** `scripts/build-local-mod.sh`.
  `install-bridge` alone does not update what the browser mirror sees. (`game deploy` above does both.)
- **Any `dotnet build` of the sln deploys.** Another agent's stray build silently replaces yours. After every deploy,
  prove the install is yours — `stat -c %y <modsDir>/CouchCoop.Mod.dll`, or grep the DLL for a string only your
  branch contains (see the `couch-deploy` skill). Do not try to read a cache generation out of the DLL — that
  string names no path any more.
- After a bridge/model shape change, clear
  `~/.local/share/SlayTheSpire2/couch-coop/cache/*/assets/model/` (the glob is over VERSION directories), or you
  test against old cached JSON.

## Running the game

- Godot mono build: `~/.local/godot-4.5.1-mono/…/Godot_v4.5.1-stable_mono_linux.x86_64`. The `godot` on PATH is a
  non-mono 4.6.2 that runs the project scriptless and idles forever.
- `dotnet build godot-client/CouchCoop.GodotClient.csproj` before **every** godot-client launch — Godot's CLI runs
  the last-built assembly, not a fresh JIT.
- **`--shot` needs a real display, never `--headless`** (the dummy renderer never fires `FramePostDraw`, so the
  capture hangs). Use a per-agent `Xvfb :6x` — never the operator's `DISPLAY=:1`. `--dump-final-state`, `--connect`
  soaks and tests are fine headless.
- Game argv: `Godot.OS.GetCmdlineArgs()`, not `Environment.GetCommandLineArgs()` (dead in the embedded host).
  `godot.log` does not capture `Console.Error`, so `GD.Print` is still what makes a line show up THERE — but
  `sts2 game launch` no longer discards the child's stdio (2026-09-04): it tees both streams to
  `.sts2/artifacts/game-launch/` and reports the paths as `launch.stdio` (also `game info.launchStdio`).
  `sts2 --mode dev --json dev logs --source game-stdio` tails them — capped at 80 lines and it ignores
  `--limit`, so read the file it names for anything longer. **The mod's own `[couch-coop]` / `[spirectl]` lines
  are on STDOUT**, not stderr.
- `pkill -f <pattern>` self-matches and kills the invoking shell (exit 144, no output). `COUCHCOOP_*` are env vars,
  not argv. The real pattern is `SlayTheSpire2 --headless`. Kill and relaunch in **separate** Bash calls.

## Before releasing the lock

- Restore `../spirectl` and `../godot-scene-web` to clean `main`. Two agents in one round found the real spirectl
  checkout left on someone else's branch. To test a sibling branch without touching the shared checkout, run the
  couch dev server or vitest with a scratch vite config (`--config <file>`) re-aliasing to your sibling **worktree**.
- Release every lease on every exit path, including failure.

## Reporting

Say which instance you drove, what was installed (with the DLL identity check output), and list the concrete image
paths behind any visual claim.

## Stop conditions

Hard budget: 3 failed launches or relaunches, an ENOSPC, or a lock you cannot resolve — stop and report the blocker.
Do not loop on the live game.
