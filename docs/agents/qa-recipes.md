# QA recipes (copy-pasteable)

Companion to `docs/agents/architecture-map.md`. Every path/command below was checked against the repo on
2026-07-30; re-verify anything load-bearing if it's been a while (`ls`/`grep` the exact path before trusting a
one-liner blind).

## 0. Live-game safety (read first)

Scripted input against the LIVE game is irreversible run mutation (a blind click once consumed a real card
reward — [[live-game-input-safety]]). Before ANY input leg against a live/attached game:
1. Capture and look at the current screen first (a `shot`/QA `state` call, or a fresh recording keyframe) —
   don't assume what screen is showing.
2. Prefer recordings/fixtures over a live session wherever the defect is reproducible offline.
3. Respect the scoped live leases below — never drive a resource held by another agent.

## 1. Live-session lease protocol

Use `scripts/live-qa-lock.mjs`; its JSON leases under `/tmp/couchcoop-liveqa.leases/` are shared by all worktrees.
Acquire the whole set atomically: `shared:install` for a live session, `exclusive:install` for deployment,
`shared|exclusive:game:<instance>` for inspection or driving, and exclusive `android:<serial>`, `browser:<port>`,
or `port:<port>` endpoints as applicable. Disjoint sessions coexist; same-resource exclusive leases conflict.

Use `list` before a live leg, `assert` in delegated scripts, `with` for an exit-safe one-command lease, and
`release` on every exit path. Dead leases are reported but never silently stolen; confirm the PID and named resources have been idle
for roughly ten minutes before a documented takeover.

## 2. Isolated game instance launch

Run `sts2` from the **couch-coop repo root** (not `frontend/`) — `sts2.local.yaml` (gamescope
`launchWrapper`, `launchArgs: ["--display-driver","wayland"]`) is cwd-discovered; launching elsewhere starts
the game bare and disrupts the desktop.

Per-instance isolation (already wired into `HeadlessClientManager.LaunchReal` for co-op headless seats; apply
the same idea for a standalone probe instance):
- **Own `XDG_DATA_HOME`** per instance (`user://` = `$XDG_DATA_HOME/SlayTheSpire2`) — mods still load from the
  install's `mods/` dir, isolation doesn't affect that.
- **MUST seed the `steam/<steamid>/` profile** into the fresh data dir first (minus `*.spirectl-backup-*` and
  `*.VAL.corrupt` cruft). An empty `steam/` makes the game think it needs a cloud-sync and pops a blocking
  modal — the CouchCoop browser server then never starts (host readiness probe times out). The seed is an
  OVERWRITE copy on every spawn, so a new instance inherits the host's current language / fps
  (`steam/<id>/settings.save`) and fast mode (`steam/<id>/[modded/]profile<N>/saves/prefs.save`); `logs/` and
  run history (`saves/history/`, copy-if-missing) are preserved.
- **Slot dirs live at `user://couch-coop/headless-slots/slot-<N>/SlayTheSpire2`** — everything the mod creates
  in the user profile is under `couch-coop/`. Symlink the big content-addressed caches from a known-good
  profile: `shader_cache` + `vulkan` whole-dir, and `couch-coop/cache` PER LEAF (one leaf — every cache is
  version scoped underneath it).
  Never link the whole `couch-coop` dir into a slot — the slot is inside it, so that link points at its own
  ancestor and any recursive walk (which follows symlinks with no cycle detection) never terminates.
- **Own bridge socket**: `SPIRECTL_BRIDGE_SOCKET_PATH=/tmp/spirectl-bridge-<slot>.sock` — without this a second
  instance steals the host's `.sts2/ipc/spirectl-bridge.sock` and breaks `sts2` against the host.
- `sts2` also has a built-in `--instance <NAME>` flag that does the per-instance socket + Godot user-dir
  isolation described here automatically (found Aug-7; the manual recipe above still documents what it must
  amount to — the steam-profile seeding is still on you either way).
- **Never launch a second `-fastmp host_standard` while a live host runs**: the live host holds the ENet UDP
  port (33771), and a second host either fails to bind or (with `SO_REUSEADDR`) steals the live session's
  multiplayer packets. For an isolated probe, prefer `--headless` + a fixture with `players: 2`
  (`SetUpNewSingleplayer`, no ENet) — that is also the only environment where the headless visual suspender
  (particle/spine freezes + exemptions) is even installed.
- Deploy the mod to BOTH copies before live-testing a spirectl change: `sts2 game install-bridge` (the
  bridge/CLI-facing copy) **and** `scripts/build-local-mod.sh` (the embedded copy the running game/browser
  path at `:13337` actually serves — the two are separate assemblies, `CouchCoop.Spirectl.dll` vs
  `Spirectl.Sts2.dll`; `install-bridge` alone does NOT update what the browser mirror sees).
- Recreate a 2-player browser-seat run after a restart: `sts2 game launch -- --display-driver wayland -fastmp
  host_standard` (NOT the main-menu solo option — that lobby has no multiplayer seats). **This is still the QA
  recipe** and still behaves byte-identically to before the Aug-8 transport round: `-fastmp host_standard`
  forces Platform None, so the session is plain ENet with no Steam lobby, which is what you want for a
  deterministic local test. What CHANGED is that normal menu hosting now ALSO really hosts (Steam lobby +
  parallel ENet couch side, see architecture-map "Host transport"), so "the mod only works under fastmp" is no
  longer true — it is simply the most controllable path.
- **Couch seats now launch with `--headless` and NOTHING else.** The old `-fastmp join --clientId <netId>`
  argv is gone; the contract moved into the environment (`COUCHCOOP_HEADLESS_CLIENT`, `COUCHCOOP_CLIENT_ID`,
  `COUCHCOOP_HOST_NETID`, `COUCHCOOP_JOIN_HOST`, `COUCHCOOP_HEADLESS_SLOT`, `COUCHCOOP_PREFERRED_PORT` — full
  table in architecture-map). So `ps`/`pgrep` for a seat by `-fastmp` finds NOTHING now; match
  `SlayTheSpire2 --headless` and read `/proc/<pid>/environ` for the identity. Verifying a seat:
  ```
  PID=$(pgrep -f "SlayTheSpire2 --headless" | head -1)
  tr '\0' ' ' < /proc/$PID/cmdline; echo          # expect: SlayTheSpire2 --headless
  tr '\0' '\n' < /proc/$PID/environ | grep ^COUCHCOOP_
  ```
  Seat log (real ENet join evidence — `Sending handshake with net ID <n>`, `ClientLobbyJoinResponseMessage
  Players: 2`, and recurring `NetQualityTracker` stats with no `Cannot send messages to non-host players`):
  `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-<N>/SlayTheSpire2/logs/godot.log`.
- Joining a browser seat WITHOUT a dev server (useful for a headless regression leg): open a WebSocket to
  `ws://127.0.0.1:13337/ws` and send
  `{"type":"join","requestId":"<id>","name":"Ann","playerId":"p:1002"}`. `requestId` is REQUIRED and the
  `playerId` is the seat you are claiming; a join with neither is answered `status:"unassigned"` and spawns
  nothing. `EnsureHeadlessAsync` then takes 20-60s (it waits for the instance to ENet-join and preload), and
  the socket must stay OPEN or the seat is torn down again.
- **`sts2 game launch` KEEPS the mod's stdio** (2026-09-04; it used to send fd 1/2 to `/dev/null`, which is why
  this repo built an in-game log panel). The couch-coop diagnostics (`[couch-coop] qr host panel ...`,
  `[couch-coop] headless ...`, seat spawn refusals) and spirectl's `[spirectl]` lines are **on STDOUT**, not
  stderr; `godot.log` still only captures `GD.Print`. Both streams are teed to
  `.sts2/artifacts/game-launch/game-launch-<unixms>-<pid>.{stdout,stderr}.log`, with `game.stdout.log` /
  `game.stderr.log` symlinks refreshed to the latest run. The paths ride in the launch payload
  (`launch.stdio.{dir,stdoutPath,stderrPath,latestStdoutPath,latestStderrPath}`) and in `game info.launchStdio`.
  ```
  sts2 --mode dev --json dev logs --source game-stdio     # or: --source bridge | both
  ```
  That tail is capped at **80 lines and ignores `--limit`** — for anything longer, read the file path it
  reports. Launching the binary by hand still works and is still the way to watch stdio live:
  ```
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  GAME_PATH="$(sts2 --json config resolve gamePath | jq -er '.gamePath')"
  SPIRECTL_BRIDGE_SOCKET_PATH="$REPO_ROOT/.sts2/ipc/spirectl-bridge.sock" \
    nohup "$GAME_PATH/SlayTheSpire2" \
    --display-driver wayland -fastmp host_standard > /tmp/host.log 2>&1 &
  ```
  Without that explicit socket path the bridge binds under the game's own cwd and `sts2` cannot reach it.

### 2.x Launching an instance under xvfb (the desktop stays the operator's)

**Never put a game window on the operator's desktop, and never wait for the operator's own game to exit**
(deploying while it runs is safe — its DLLs are in memory; your measurements go to an isolated instance;
port 13337 and the default profile's `couch-coop/browser-port` are the operator's — read your instance's
walked port from its own port+pid file). For a HEADED instance, wrap the launch the way
`scripts/run-gpu.sh` does:

```
env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 xvfb-run -a -s "-screen 0 2560x1440x24" <launch command>
```

Two traps, both load-bearing:
- **The wayland trap**: `xvfb-run` sets `DISPLAY` (X11) but the app follows `WAYLAND_DISPLAY` straight past
  the virtual display onto the real compositor — the `env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11` prefix is
  what actually keeps the window off the desktop.
- **`sts2.local.yaml` fights you**: it is cwd-discovered and injects the gamescope `launchWrapper` and
  `launchArgs: ["--display-driver","wayland"]`. For xvfb launches run `sts2` from a scratch cwd carrying a
  modified copy (same `game.assembliesDir`, NO gamescope wrapper, x11 or no display-driver arg), or launch
  the binary yourself under the wrapper above.

Use headed-under-xvfb rather than `--headless` whenever measurement comparability matters: windowless mode
arms the visual suspender and idle frame caps, which change per-frame costs and can flatter a benchmark into
a false pass. Scope any "a game is already running" refusal to YOUR instances (attribute by user-dir/env) —
the operator's game is expected and exempt.

**Xvfb is measurement-valid only WITHIN itself — never for cross-lane wall-clock verdicts.** Measured
(phase-7 gate, P7G vs P7Q vs the desktop leg): an Xvfb-hosted instance prices an awaited engine frame
~20× higher than the desktop (ForceDraw 27→595 ms per 8 draws; CPU phases ~1×), and the machine being
loaded vs quiet changes nothing (two 16-arm legs within 0.5%). Any comparison between lanes with
DIFFERENT frame-await profiles (e.g. a multi-frame bake vs a single-render still) is distorted ~2.5×
against the frame-awaiting lane and will manufacture a false verdict. A/B comparisons where both arms
await the same frames remain valid under xvfb; functional/correctness legs are always fine. A wall-clock
gate that grades one lane against another needs a real-display run — ask the operator for a desktop slot
rather than shipping an xvfb number.

### 2.y Five-player instance bring-up (`scripts/bring-up-five-player-instance.sh`)

One isolated host instance inside a private gamescope compositor, with the mod list pinned for a >4-player
session, plus a JSON record (`couchcoop-five-player-bringup/1`) a browser-join probe reads. Same shape as
`bring-up-gamescope-instance.sh` — `--i-hold-the-live-lock` gate, scratch config, pid-file teardown.

```
scripts/bring-up-five-player-instance.sh --instance mp5 --cache-root /tmp/mp5-cache \
  --record /tmp/mp5-bringup.json --i-hold-the-live-lock
scripts/bring-up-five-player-instance.sh --instance mp5 --teardown
```

The mod configuration is the part that is not obvious:
- **Never set `game.modLoadout` for this.** The CLI's rewrite keys a map by mod ID, and this box's `mod_list`
  has `couchcoop` TWICE (`mods_directory` = local dev deploy, `steam_workshop` = published). The rows
  collapse and both come back `steam_workshop`, so asking the CLI to enable couchcoop can silently run the
  **Workshop** build. The script leaves `modLoadout` unset — which also means `game launch` does no
  settings.save rewrite or restore at all — and edits `<userDir>/SlayTheSpire2/steam/<steamid>/settings.save`
  itself via `scripts/lib/mp5-mod-loadout.py`, keyed on `(id, source)`. It only flips `is_enabled`, never
  invents a row (the game's ModManager owns discovery), and a missing `sts2unlimited` row is fatal rather
  than a silent four-seat lobby. This pins the **host instance**; the seats it spawns pin themselves, from
  the copy the host actually loaded (see the seat launch contract in `architecture-map.md`).
- **`sts2 game mods settings` seeds the instance user dir without launching or deploying** — it is the only
  lifecycle command that does. That is what lets the loadout be pinned before the first launch instead of
  launch → edit → restart. First seed of a fresh instance copies ~780 MB from `~/.local/share/SlayTheSpire2`;
  re-runs hit the `.spirectl-seeded` sentinel and are instant.
- **That seed drags in two pieces of the operator's LIVE session**, and both are deleted before launch:
  `couch-coop/browser-port` (their running game's port *and pid*, so a liveness check passes and you drive
  their game) and `couch-coop/headless-slots/` (their seat dirs, which would match this record's
  `seatLogGlob`). The port file is then accepted only once `/proc/<pid>/environ` shows the writer's
  `XDG_DATA_HOME` is this instance's — identity, not liveness (`scripts/lib/mp5-instance-port.py`).
- `instances.symlinkUserDataDirs: []`, or the named instance inherits `sts2.local.yaml`'s shared `couch-coop`
  symlink and clobbers the operator's `browser-port` record.
- `browserPort` is whatever the mod published, **not** 13337 — the preferred port is a walk.
- Seat logs land under the INSTANCE user dir, because `HeadlessUserDirSeeder` derives the slot base from the
  host's `XDG_DATA_HOME`, which `sts2 --instance` has already pointed at `<userDir>`:
  `<userDir>/SlayTheSpire2/couch-coop/headless-slots/slot-*/SlayTheSpire2/logs/godot.log`.

`--plan` does everything except launch the game (config, compositor, seed, loadout), so the mod
configuration is provable without the live lock. Helpers are unit-tested by `scripts/test-mp5-bringup.sh`.

## 3. QA TCP channel (native godot-client)

Full protocol + current verb table: **`godot-client/docs/qa-channel.md`** (read that file — verbs/settings
change between rounds, this is a pointer, not a copy). Summary:
- Debug-only, localhost-only `TcpListener`, default OFF. Enable: `--qa-port <N>` on the command line (desktop),
  or push a `[qa]\nport=<N>` block into `user://settings.cfg` before launch + `adb forward tcp:<N> tcp:<N>`
  (Android — the app can't set env, so this is the only on-device path).
- One command per line, one `ok [payload]` / `err <reason>` reply. Same interpreter as the `--demo-input
  <script>` file player (`godot-client/src/Input/DemoInputPlayer.cs`).
- Verbs as of this round (see the doc for the authoritative/current list): `touch`, `mouse`, `key`, `wait`,
  `dump <x> <y>`, `dumptypes`, `dumpcards`, `dumpcrisp` (crisp-reject capture), `dumptips` (HoverTip anchoring
  capture), `dumpspread` (wide-screen spread-record capture), `shot <path>`, `renderscale`,
  `setting <key> <value>`, `connect`/`disconnect`/`reload`, `state` (incl. crisp reject histograms),
  `hide`/`show`/`hidelist`, `backtomenu`, `quit`. `state` returns fps/drawCalls/primitives/frameMs percentiles — read that before guessing whether a
  perf issue is CPU or GPU bound (toggle `renderscale Half`→`Quarter`: fps recovers ⇒ GPU-bound, flat ⇒
  CPU-bound).
- Scripted one-liner: `exec 3<>/dev/tcp/127.0.0.1/<port>; printf 'state\n' >&3; head -n1 <&3`.

## 4. Fixtures + `sts2 dev console` jump commands

Fixtures live in `tests/fixtures/*.sts2.fixture.yaml` (e.g. `act2-ancient-tezcatara.sts2.fixture.yaml`,
`ancient-event-neow.sts2.fixture.yaml`, `act1-last-boss.sts2.fixture.yaml`) — load one to start a run in a
known state instead of playing to it.

**Host-lobby fixtures** (added Aug-8, for the QR host-panel probes): `pc-lobby-host.sts2.fixture.yaml`
(start-run, `NCharacterSelectScreen`) and `pc-lobby-load-run-host.sts2.fixture.yaml` (load-run,
`NMultiplayerLoadGameScreen`). Both go through the loader's REAL `NetHostGameService` + `StartENetHost` path,
so the lobby reports `netGameType: host`. Authoring rules the live loader enforces (the Rust-side unit tests
are laxer, so a fixture can pass `prepare_fixture` and still be rejected live):
- the local seat must be **`p:1`** — the CharacterSelect path realizes the local player through net id 1 only;
- `characterId` must be **UPPERCASE** (`IRONCLAD`, `SILENT`, ...) — it is resolved exactly against installed
  content;
- do NOT mark every seat `isReady: true` on a start-run lobby, or `IsAboutToBeginGame()` starts the run
  instead of holding the lobby;
- `characterSelect` and `run` are mutually exclusive, and only a `characterSelect` recipe opens an ENet host —
  a `run:` fixture (including `players: 2`) is always the no-ENet `SetUpNewSingleplayer` path.

Loading one:
```
sts2 dev fixture load fixtures/<name>.sts2.fixture.yaml     # or --mode dev if the CLI insists
```

To jump screens inside a running game, the CLI passes a command straight to STS2's own in-game developer
console (`sts2 --mode dev dev console <command> [args...]`, needs `--mode dev`). Verified real invocations:
```
sts2 --mode dev dev console room <Shop|Event|RestSite|Treasure|Monster|Elite|Boss|Map>
sts2 dev console event <EVENT_ID>          # e.g. FIELD_OF_MAN_SIZED_HOLES
sts2 dev console fight <encounter-id>
sts2 dev console remove_card <ID>          # remediation if a blind input consumed the wrong card
sts2 dev console card <ID> <pile>
```
Gotcha: `dev console room Treasure` has been observed to terminate the STS2 process with no managed-exception
trace in `godot.log` (see `../spirectl/.ai/tool-improvements.md`) — treat any `room`/`event` jump as a
potential crash risk, not a guaranteed-safe no-op.

## 5. Stream record / replay (combat + perf bench)

Full methodology (tiers, flags, interpretation notes, baselines): **`docs/mirror-combat-bench.md`** (already
in this repo — read it before designing a new bench). Quick pointers:
- In a linked worktree, derive the primary checkout before using its machine-local recordings:
  `PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`.
- Record (needs the live game, passive/never sends input): `node scripts/record-mirror-stream.mjs --duration
  25 --out .sts2/bench/<name>.ndjson`.
- Replay against a page: `node scripts/replay-ws-server.mjs` / `node scripts/bench-mirror-replay.mjs --url
  <dev-server> --recording <path>`.
- Recordings live under `.sts2/bench/*.ndjson` (git-ignored, per-checkout — NOT shared across worktrees
  automatically). Existing recordings on this machine's primary checkout (names only, check freshness before
  reuse — content drifts as the game changes): `combat-2026-07-15T*.ndjson` (canonical combat baseline
  family), `audit-{cardreward-open,event,mprun,restsite,rewards,shop}.ndjson` (one per screen — reach for these
  first if your defect is renderable from a recording), `probe-current.ndjson`, `probe-map-visible.ndjson`,
  `r4fix-trash-tip.ndjson`, `wscrisp-{deckdialog,hovertip}.ndjson`. A worktree needing one of these can copy it
  from `$PRIMARY/.sts2/bench/` (the primary checkout) rather than re-recording live.
- Never re-record between a before/after comparison — the pair is only valid on the byte-identical stream.

#### Phone DOM-versus-canvas ABBA

Use the maintained named-query runner for a backend comparison. Its defaults fix the order to **DOM → canvas →
canvas → DOM**, open and prove a foreground Android tab for each cell, and use the canonical `stage=dom` and
`stage=canvas` selectors. Do not substitute removed per-effect URL arms or hand-run a different order.

```bash
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
scripts/bench-phone-query-ab.sh \
  --recordings "$PRIMARY/.sts2/bench/combat-modern-2026-08-06.ndjson" \
  --out-dir .sts2/artifacts/phone-dom-canvas
```

Use a byte-identical recording for all four cells; pass `--window <startMs>:<endMs>` when comparing a bounded
recording segment. The runner requires a connected, unlocked configured Android device and a dev server whose
`/res/project.godot` returns `200`. Preserve the output directory: it holds each cell's log, result, process/RSS
ledger, LMK/GPU logs, screenshot, and before/after foreground proof.

Compare raw `frameGaps.p50` and `frameGaps.p95`; do not headline `droppedPct`, because the device may change refresh
rate. A failed foreground proof, context loss, failed replay, or divergent A/A pair voids that workload rather than
establishing a zero-cost result. Use `bench-phone-canvas-ab.sh` only for its separate bounded workload and
visual-quality gate.

### Particle-VFX replay probe (`scripts/probe-particle-vfx-replay.mjs`)

Replays a recording into the real mirror page, stops at a chosen moment, and screenshots a particle system
(full frame + a `--focus`ed crop) — plus a per-system `paint` measurement (mean alpha / covered fraction /
opaque fraction off the system's own canvas), which is what turns "looks better" into a number. Example:

```
cd frontend && npx vite --port 5199 --strictPort      # (or --config <scratch> for a gsw worktree)
node scripts/probe-particle-vfx-replay.mjs --url http://127.0.0.1:5199 \
  --recording .sts2/bench/b3-pool-recycle.ndjson --at 3000 --inject \
  --focus EnergyVfxFront --pad 40 --out .sts2/artifacts/particle-vfx/orb-after.png
```

Four traps it exists to kill — every one of them produces a confident FALSE PASS:
1. **`/res/**` proxies to the game.** With no game running the sheets 404 and every particle falls back to
   gsw's procedural soft dot, which looks fine. The probe serves `/res/**` from the local extracted-resource
   root (`--res-root`, whose default the probe prints) via a Playwright route.
2. **Recordings predate the shader-ramp wire fields.** `--inject` reads the material `.tres` from that same
   resource root and patches the resolved `gradientStops` / `curvePoints` back onto the recorded shader
   params, so the replay reproduces the SHIPPED appearance (including LUT-era regressions) rather than a
   different, older bug.
3. **gsw refuses its shared WebGL context on a software renderer**, and headless Chromium only has
   SwiftShader — no context, no particle runtime, no canvas, empty screenshot. The probe sets
   `globalThis.__gswForceWebglShaders = true` before page scripts.
4. **A live sim moves between the measurement and the screenshot.** The probe freezes page timers before both
   (`--freeze=false` to opt out). For `particles=dynamic` also note that a one-shot burst's visible window is
   a few hundred ms and the replay lags: stop just after the delta that TRIGGERS the burst and give it a long
   settle (`--at 13040 --settle 4000`), then confirm via `systems[].paint` that the frame had pixels. Static
   mode needs none of this — it warms every system to a representative frame and parks.

### Shared perf-report envelope (cross-repo A/B instrument)

Three couch-coop measurements emit the SAME JSON envelope godot-scene-web's `packages/perf-harness` emits
(`schema: "perf-report/1"`), so a unit-level win measured there can be checked against integration numbers
here field-for-field. Coupling is the JSON shape only — no build dependency, no cross-repo import. The
metric block is per `profile`; a wire-bytes report is never validated against browser-render fields.

```
# S11 browser-render — replay a recorded combat stream into headless Chromium (needs a dev server + res-root)
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd frontend && npx vite --port 5199 --strictPort
node scripts/bench-mirror-replay.mjs --url http://127.0.0.1:5199 \
  --recording "$PRIMARY/.sts2/bench/combat-modern-2026-08-06.ndjson" \
  --repeats 5 --limit-ms 12000 --res-root --report .sts2/bench/report.json

# S9 wire-payload — per-frame scene-delta wire bytes, replayed from a recording through the LIVE aggregator
dotnet run --project tests/CouchCoop.Mod.Tests -- wire-report <recording.ndjson> --out report.json
# …or from a running host, after arming the send-path recorder:
curl 'http://127.0.0.1:13337/perf/scene-delta.json?arm=1&reset=1'   # …play… then:
curl 'http://127.0.0.1:13337/perf/scene-delta.json?windows=5&scenario=scene-delta-wire'

# S10 asset-render — /bg/ render wall time. Served renders are always recorded; the SIZE/ENCODER comparison is
# opt-in (it renders at a size + codec the shipped policy never asks for, with both caches bypassed).
curl 'http://127.0.0.1:13337/perf/bg.json'
COUCHCOOP_BG_BENCH=1 <host>   then
curl 'http://127.0.0.1:13337/perf/bg-render.json?sizes=1920x1080,2520x1080&formats=png,webp&repeats=3&warmups=1'
# …the whole encoder field in one table, with the encoded bytes dumped for a fidelity diff:
curl 'http://127.0.0.1:13337/perf/bg-render.json?id=underdocks&sizes=2520x1080&repeats=5&warmups=1&dump=1&formats=png,png:opaque,webp,webp@0.95,webp@0.85,jpg@0.9'

# Prerender every combat background before any client asks (15 of them, ~8s, all jpg@0.9). Afterwards a /bg/
# fetch is a ~3ms memory hit instead of a 350-1000ms render.
COUCHCOOP_PRERENDER_BACKGROUNDS=1 <host>     # or launch with --prerender-backgrounds

# asset-render — /spines/ BAKE time (the mirror's default spineMode bakes a still per visible spine) AND
# /geoclips/ bake time: both lanes file into the same report, in separate metric blocks (see below).
curl 'http://127.0.0.1:13337/perf/spine.json'
COUCHCOOP_SPINE_BENCH=1 <host>   then                    # re-bakes ONE key with its cache bypassed
curl -G 'http://127.0.0.1:13337/perf/spine-render.json' --data-urlencode 'key=<a key from /perf/spine.json>' \
  --data 'repeats=3&warmups=1'
# Whole-catalog cold sweep: move `~/.local/share/SlayTheSpire2/couch-coop/cache/<version>` aside and launch with
# `--prerender-spines`; every `[couch-coop] spine-prerender …` line then carries that bake's phase breakdown.
```

#### The `/bg/` URL grammar and codec

`/bg/<id>?layers=<digest>&v=1` — **no file extension**. The encoder is host policy, so `Content-Type` identifies
the representation and the URL identifies only the scene variant. Filename aliases such as `.png`, `.jpg`, and
`.webp` are unsupported and rejected. `v=` must match
`CouchCoopStaticBackgroundProvider.KeyVersion` and the frontend fallback in `StaticBackground.vue`.

The current host policy is `jpg@0.9`; encode offload is on by default through spirectl. JPEG has no alpha, so its
outer transparent edge becomes near-black; the mirror clips it off-screen at ordinary aspect ratios and the artwork
is near-black at the remaining wide edge.

Verify prerendering with the game-stdio artifact reported by `sts2 game launch`, cache entries under
`COUCHCOOP_CACHE_ROOT`, and `/perf/bg.json`. If a perf route is unavailable after launch, first verify which port
the instance actually bound—the preferred port can walk when `13337` is occupied.

#### Render phase breakdown (`phases` / `split`)

Both host renders (a `/bg/` background, a `/spines/` bake) are marshalled onto the Godot MAIN thread, so every
render report splits its time two ways — and the split, not the total, is what an optimization should be chosen
against:

- **`blocking`** — held the main thread (resource load, GPU readback, the full-image alpha scan, the encode).
  This is the stall the person playing on the TV sees.
- **parked** (`blocking: false`) — waited on `SceneTree.ProcessFrame`, the extraction gate queue, or disk. The
  game keeps running; only the requesting client waits.

`metrics.<block>.phases` gives a per-phase distribution *over the renders that actually ran that phase*, and
`metrics.<block>.split` gives `blockingMs` / `parkedMs` / `blockingShare`. A render whose lane was not recording
reports `phases: null` (see `params.phasedRenders`) — **absent means unmeasured, never zero**. Recording is on by
default; `SPIRECTL_RENDER_PHASE_PROFILE=0` turns it off.

##### Geoclip bakes are in the same report, in their own block

`/perf/spine.json` carries a third metric block, `geoclip`, beside `still` and `clip`. A geoclip key is the
*animated clip* identity plus `&geo=1&gv=1`, so `KindOf()` would call it a `clip` and average a geometry bake into
the raster row this repo compares across rounds; the kind is therefore passed explicitly by the provider. `runs[]`
rows carry `route: "geoclip"` (the single-key on-demand lane) or `"geoclip-rig"` (one gate admission, N poses — the
`--prerender-spine-deltas` sweep), and `key` is the geoclip identity with its selector, so raster and geometry rows
for one creature are trivially paired.

Two things about that block that a reader has to know:

- **The phases come from the ARTIFACT, not from the profiler.** The geoclip seam carries no request id — the baker
  mints its own recorder key and closes it before returning — so nothing is left for `TryTake` to drain. What the
  baker does do is write the same breakdown into `manifest.json` as `bake.profile`, and the host lifts it out of
  there (`GeoclipBakeProfileReader`). Same consequence as everywhere else: `SPIRECTL_RENDER_PHASE_PROFILE=0` means
  `phases: null`, never a table of zeros. On top of the producer's phases the host appends its own `gateWait` (the
  queue for the one shared main-thread admission slot, which this lane measured **nowhere** before — the bake's own
  `total=` log field starts *after* the gate) and `cacheWrite` (the adopt into the store), both non-blocking.
- **A REFUSED bake is `success: false`, so it is priced in `runs[]` and not in `metrics.geoclip`.** That is the
  existing rule for a bake that produced nothing, applied consistently — but on a lane where roughly half of a real
  catalog refuses, and where a refusal costs what a success costs, the aggregate block understates the host's real
  geoclip cost. Sum the `runs[]` rows when you want the whole lane. `metrics.failedBakes` counts them.

##### Why a geoclip 404 says nothing, and how to make it talk

`/geoclips/` answers one `geoclip-not-found` body to every cause: a bake refused as incomplete, a refusal
*remembered* from an earlier one, production disarmed, a producer that wrote no manifest, an operator-form address
that is a lookup rather than a recipe, a host with no runtime to bake through. Launch with
`COUCHCOOP_GEOCLIP_DIAGNOSTICS=1` and the same 404 gains an `X-Geoclip-Refusal: <arm>; <detail>` header naming
which one it was — `geoclip-bake-refused-cached; arm=foreign cached=1 refusedUtc=… foreignMeshes=74`. The body is
byte-identical either way (clients read the code, and a generic code is the right thing to hand an untrusted
caller), and the header is off by default because its detail is producer-authored text on a route that answers a
wildcard CORS grant.

```
curl -sD- -o/dev/null 'http://127.0.0.1:13337/geoclips/scenes/x.tscn?node=Visuals&anim=idle_loop&file=manifest.json'
```

Both lanes now encode on a WORKER thread under the shared `Sts2RenderEncodeBudget` (`max(1, cores - live game
instances)`, one process-wide gate), so an encode shows up as parked `encodeWait` (the main thread waiting) plus
non-blocking `encodeNormalize`/`encodeSave` or `encodeFrame` (the worker doing it) — never in `blockingMs`. A
background render's `blockingShare` collapsing to ~0.2 is that offload; if you ever see `encodeSave` marked
blocking on a `/bg/` render again, the single-image lane has fallen back onto `EncodeImageResult` (the sync path,
which the cheap icon/texture lanes still use because a 10 ms thread hop would cost more than their encode does).

#### The `formats=` candidate grammar

`formats=codec[@quality][:opaque]`, comma-separated. `codec` is `png` | `webp` | `jpg` — exactly the buffer
encoders Godot ships and a browser can decode in an `<img>`; there is no AVIF, QOI or JPEG-XL encoder to reach
for, so the only codec-independent lever is fewer pixels. `webp` **without** a quality is LOSSLESS (that is the
shipped clip call); `webp@0.85` is lossy; `jpg` is always lossy and always opaque (JPEG carries no alpha). Each
candidate gets its own metric block — the bare size key for the shipped `png`, `<size>:<label>` for the rest — so
two settings of one codec never average together. Anything malformed (`avif`, `webp@85`, `png@0.8`, `png:foo`)
is a **400**, not a silently substituted render: a mislabelled row is worse than an error.

`dump=1` writes the last repeat of each candidate to `<cache-root>/../bench-dumps/<id>-<size>-<label>.<ext>`
and lists the paths in `params.dumps`. It is the only way to get real bytes at real encoder settings out of the
host (the render-size fields are embeddable-only, so the CLI cannot ask for 2520x1080), and therefore the only
way to pixel-diff a lossy candidate against the PNG reference.

#### The shared `cpu` block

All four profiles spell CPU the same way, so "CPU per unit of work" reads across repos without translation:

```jsonc
"cpu": {
  "windowMs": 4301.08,          // wall clock the window covered
  "totalCpuMs": 3768.45,        // CPU burned inside it
  "totalCoreRatio": 0.8762,     // totalCpuMs / windowMs — fraction of ONE core; >1 means several
  "cpuCoverage": 1,             // share of the measured wall time whose CPU is attributed
  "byProcess": { "SlayTheSpire2": { "cpuMs": 3768.45, "wallMs": 4301.08, "coreRatio": 0.8762, "processes": 1 } },
  "byThread": [ { "process": "SlayTheSpire2", "thread": "process-total",
                  "cpuMs": 3768.45, "wallMs": 4301.08, "coreRatio": 0.8762 } ]
}
```

On this repo's two profiles it comes from `Process.TotalProcessorTime` deltas taken around the measured work
(`ProcessCpuMetrics`). Four things a reader has to know, all of them recorded in `params.cpuCaveat` too:

1. **It is process-wide.** `TotalProcessorTime` is user+system CPU across ALL threads of the host, so it
   prices what the host burned during the window, not the measured path in isolation — an **upper bound**.
   That is also why `byThread` carries one honest `process-total` entry: .NET exposes no per-managed-thread
   CPU counter, and inventing thread names for a process-wide number would be a readable lie.
2. **The counter is coarse.** procfs advances it in ~10 ms ticks, so a short window quantizes and can read an
   exact `0` that means "below resolution", not "free". Windows under 50 ms are therefore reported as
   **unmeasured**, with `params.cpuOmittedReason` saying so — never as a plausible zero.
3. **`wire-payload` from a RECORDING has no `cpu` block, by design.** The bytes in a recording were produced
   by a game process that is gone; the replaying process's CPU is a different number. The report says
   `cpuSource: "unmeasured"` and names the replay. Only a live send-path capture is entitled to a block, and
   even then it is withheld if the ring dropped frames (the window would cover more frames than the report).
   Its window runs from the first live frame to **the moment you request the report** — `params.cpuIdleTailMs`
   is how much of it carried no wire work, so ask for the report right after the workload.
4. **`asset-render` measures per render**, at the same two points as the render Stopwatch: each `runs` entry
   gets its own block (or a `cpuOmittedReason`), each size block gets `cpuMs`/`coreRatio` distributions plus
   `cpuMeasuredRenders`, and `metrics.cpu` folds the measured (disjoint) windows.
5. **`cpuCoverage` is where you check point 2.** It is the share of the measured wall time whose CPU is
   actually attributed: `1` for a single contiguous window (a process counter has no unattributed
   sub-interval), but on an `asset-render` fold it is the fraction of ALL render wall time that carried a
   usable reading. Half the renders too short to price reads `0.5`, not a silently narrower window.
   `byProcess` carries one real entry rather than the `{}` the validator would also accept, because `{}` reads
   as "no process burned CPU"; `threads` is left out of it, since this is a process counter and not a sum over
   threads we enumerated.

There is **no `gpu` block** on `wire-payload`, `asset-render` or `producer-walk`, and no browser-only
`byProcess`: these profiles have no GPU instrumentation, and a zero would read like a measurement of an idle
GPU.

`env.kind` is the shared enum `ci | host | device`, and these reports are **`host`** — a real process on this
box, which is what they are; `ci` is a controlled harness run and `device` is a phone. `?envKind=` accepts only
those three and answers **400** otherwise, and `PerfReport.Build` throws on anything else: a word outside the
enum makes the whole report fail validation on that one field, whatever the metrics say.

Three traps, all of which produce numbers that look fine and mean nothing:
1. **`--res-root` is mandatory for any paint/decode number.** Without it every atlas 404s, the page paints
   almost nothing, and the trace records a handful of `PaintImage` events instead of thousands.
2. **The trace buffer silently truncates.** A `cc.debug` capture holds roughly 15s; past that Chrome stops
   recording and says nothing, and the first thing you lose is the tail — which reads as "the page went
   idle". `--report` fails the repeat when its closing window marker is missing; use `--limit-ms` to replay
   a prefix that fits.
3. **Never report the swap rate as fps.** `contentUpdateHz` is the `ActivateLayerTree` rate (new content);
   `DrawFrame`/swap rate is reported separately as `swapRateHz` because a swap can re-present the same
   picture. Likewise the decode event families NEST — sum one canonical family (the report names which in
   `runs[].decode.source`), not everything matching /decode/i.

### Raster-scale / tile census (`scripts/probe-stage-raster-scale.mjs`)

"How many pixels does this page actually rasterise, and at what scale?" — answered by the compositor, not by
the DevTools layer panel. Replays a recording into the real page, then reads cc's own `cc::LayerTreeHostImpl`
object snapshots out of a `disabled-by-default-cc.debug` trace: per layer, its `bounds`,
`raster_scales.contents_scale` vs `ideal_contents_scale`, each `tilings[]` (`tiling_rect` / `visible_rect` /
`num_tiles`), `gpu_memory_usage`, and its REAL `compositing_reasons`. `--css '<candidate>'` injects a
stylesheet before page scripts, so a CSS A/B needs no edit and no rebuild.

```
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd frontend && npx vite --port 5199 --strictPort
node scripts/probe-stage-raster-scale.mjs --url http://127.0.0.1:5199 \
  --recording "$PRIMARY/.sts2/bench/combat-modern-2026-08-06.ndjson" \
  --viewport 780x351 --dpr 3.4876 --bg <2520x1080.png> --shot before.png
```

Four traps it exists to kill — each yields a confident WRONG answer:

1. **`Layer.width/height` is BOUNDS, not rastered area.** A device reports bounds in PHYSICAL px (Chrome uses
   zoom-for-dsf there), so a 2401-design-px stage on a dpr-3.4876 phone reads 8374x3767 against a 2712x1220
   screen. That is not a 9.5x raster; the raster scale is a separate number. Read `tilings[].tiling_rect`.
2. **Playwright's `deviceScaleFactor` never reaches cc** (it goes through `Emulation.setDeviceMetricsOverride`),
   so without `--force-device-scale-factor` — which this probe passes — `raster_scales.device_scale` stays 1
   and you are measuring a different machine from the phone.
3. **CDP `LayerTree.compositingReasons` misattributes.** Measured here: it named `RootScroller +
   OverflowScrolling` for a layer cc shows is an `Overlap`-promoted `.mirror-node`. Trust the trace only.
4. **A forced re-raster leaves a stale second tiling** on each layer, which doubles naive tile/GPU totals and
   makes runs bimodal (844 vs 486 tiles for identical code). Totals count only the tiling at the layer's
   current raster scale; `staleTilingsDropped` says how many were ignored.

Plus one configuration trap: on a dev server `/bg/<id>.png` 404s, `StaticBackground.vue` fails open and the
LIVE combat-background subtree stays — ~3x the shipped tile budget (487 tiles / 28.8 Mpx vs 179 / 9.9 Mpx).
Pass `--bg <png>`. A stand-in with distinctive outer 300px bands doubles as the visual proof that
`.mirror-stage` still clips them on a 16:9 stage.

**Recorded result (Aug-18-2026, Chromium 147, design 2399x1080 @dpr 3.4876, static bg on):** 179 tiles /
9.93 Mpx against a 3.33 Mpx screen. The `.mirror-stage` layer rasters at `contents_scale` 0.3260 ==
`ideal_contents_scale`, tiling 2729x1229 == the presented screen — **the stage scale IS folded into raster**.
The only layers rastering above their ideal scale are the two `.mirror-anim-self` orb-rotate layers (0.574 vs
0.326, Chrome's animation raster-scale bump). The raster surplus is `Overlap`-promoted near-full-screen node
layers, not the stage.

### 5.x Eager-scroll / scroll-authority probe (game-free, closed-loop)

`scripts/probe-eager-scroll.mjs` is not a replay — it SIMULATES the host: it serves a recorded map/grid keyframe,
models the game's own scroll (wheel target, drag target, the per-frame lerp, the clamp), delays both directions by
half the configured RTT, and — with `--authority on` — accepts `set-scroll-offset` and answers with the clamped
offset. That is the only harness that can measure "does the game end up where the client did", because it is the
only one that both clamps like the game and answers back.

It drives the **real page**, so it needs a dev server proxying `/ws` to the probe's own port:

```bash
# 1. dev server, pointed at the probe (NOT at a game). Pick free ports — 5199/13412 are often taken.
PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd frontend && COUCHCOOP_DEV_PROXY_TARGET=http://127.0.0.1:13413 npx vite --port 5211 --strictPort

# 2. the A/B pair. `--recording` targets the primary checkout because a WORKTREE has its own empty .sts2/.
node scripts/probe-eager-scroll.mjs --authority on  --port 13413 --dev-port 5211 \
  --recording "$PRIMARY/.sts2/bench/probe-map-visible.ndjson" --out .sts2/artifacts/auth-on
node scripts/probe-eager-scroll.mjs --authority off --port 13413 --dev-port 5211 \
  --recording "$PRIMARY/.sts2/bench/probe-map-visible.ndjson" --out .sts2/artifacts/auth-off
```

Read `result.json`, and read the RIGHT number:

| number | question | note |
| --- | --- | --- |
| `steps.composed.overshootPx` | is the map SHAKING? | the R11 ship gate: ≤ ~8px single-writer, ~138px two-writer |
| `steps.absolute.endpointGapPx` | do client and host agree at rest? | **0 on both arms** — not a tie, the relative arm agrees because the client's settle GAVE IN |
| `steps.absolute.gestureShortfallPx` | did the player's gesture happen? | the one that separates them: 37.5px lost to notch quantisation vs 0 |
| `steps.absolute.wheelTicksSent` / `absoluteSends` | which wire carried it? | exactly one is non-empty; the absolute channel REPLACES the tick replay |

Traps: the map's resting offset in `probe-map-visible.ndjson` is `+204.79`, so a **downward** gesture has room but
an upward one clamps at `MAP_LIMIT_HI` almost at once — pick the direction deliberately. And a gesture whose travel
IS a whole multiple of 80px proves nothing about quantisation; the equality arm uses `deltaY: 37` for that reason.

## 6. Test-suite commands

| Suite | Command | Notes |
| --- | --- | --- |
| C# protocol/scene-model | `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests` | custom `Exe` runner, **not** `dotnet test` — suites self-register in `Program.cs` |
| C# mod/browser-server | `dotnet run --project tests/CouchCoop.Mod.Tests` | same custom-runner pattern |
| godot-client build | `dotnet build godot-client/CouchCoop.GodotClient.csproj` | run before EVERY godot-client launch — Godot's CLI runs the last-built assembly, not a fresh JIT |
| frontend typecheck+unit | `cd frontend && npx vue-tsc --noEmit && npx vitest run` | **never** `npm run build` in a branch/worktree — its `vite build` outDir deploys straight into the installed mod dir |
| frontend e2e | `cd frontend && npx playwright test` | needs a dev server; the config builds one itself (the only sanctioned `vite build`) |
| spirectl bridge | `../spirectl/scripts/validate.sh bridge-build` then, ALONE, `../spirectl/scripts/validate.sh bridge-tests` | running `bridge-tests` alongside other validate legs hits an MSB3030 parallel-MSBuild race |
| spirectl presentation/web | `cd ../spirectl/presentation/web && npx vitest run` | historically ~44-62 PRE-EXISTING failures in `test/computed.parity.test.ts`/`test/instances.parity.test.ts` (stale Rust-oracle fixtures, not a regression — re-check the current count, it drifts) — diff **failing test names** against a saved baseline, not raw counts, to see if you broke something |

Run only the touched suite(s) per implementer; a coordinator/reviewer runs full suites once at merge time.

**On macOS, by request.** `.github/workflows/macos-check.yml` runs rows 1 and 4 of that table on `macos-14`,
triggered by `workflow_dispatch` or a push to the throwaway `ci/macos` branch — never on a PR (PRs are
disabled here) and never on `main`. It is scoped to exactly the two legs that need no game install: everything
under `src/CouchCoop.Mod*` resolves STS2/Godot references from `game.assembliesDir`, which no runner has, and
the `eng/Sts2.ReferenceSdk` route that lets the release build compile without a game has GNU-only drivers
(`find -printf`, `sha256sum`, bash 4 `mapfile`). The frontend leg clones `spirectl` and `godot-scene-web` at
the `release-dependencies.json` commits first, because the frontend is aliased to their TypeScript source.

### A new game build (a beta branch, or an update landing on the current one)

Two gates, and **the second one is not optional**.

```bash
# 1. METADATA — every member the mod binds to still resolves on that build.
scripts/with-game-branch.sh public-beta -- dotnet run --project tests/CouchCoop.Mod.Tests -- beta-targets
scripts/with-game-branch.sh public-beta -- sts2 --json code verify-references \
  "<install>/mods/couchcoop/CouchCoop.Mod.dll,<install>/mods/couchcoop/couchcoop.dll,<install>/mods/couchcoop/CouchCoop.Spirectl.dll" \
  --assemblies-dir "<beta install>/data_sts2_linuxbsd_x86_64" \
  --control-assemblies-dir "<stable install>/data_sts2_linuxbsd_x86_64"

# 2. BEHAVIOURAL — a seat actually joins, over the transport the release uses.
scripts/with-game-branch.sh public-beta -- sts2 --json test run tests/scenarios/steam-host-join.sts2.yaml
node scripts/test-probe-steam-host-join.mjs                       # game-free self-test of the probe
node scripts/probe-steam-host-join.mjs --dry-run                  # what it would drive, touching nothing
```

**A metadata gate cannot see a protocol step that was ADDED.** `beta-targets`, `code verify-references`
and spirectl's `Sts2GameApiProbe` all answer one question — "does every member we bind to still
resolve?" — and a brand-new step the mod does not participate in resolves nothing and reshapes nothing.
That is not hypothetical: the game's v0.111.0 beta added a transport-level version handshake, **all 43
CouchCoop patch targets still resolved**, and headless seats could not join a Steam-hosted session at
all. Every metadata gate was green for the entire life of that break.

The other half of the blind spot was the coverage itself. `-fastmp host_standard` and
`tests/fixtures/pc-lobby-host.sts2.fixture.yaml` both take the **ENet** host branch, where
`HostNetIdPatch` is inert because `hostNetId == 1` — so the branch the release actually ships on had
never had an automated join test. `steam-host-join` is that test. Run it on every new game build, and
on any change to hosting, seat allocation or the join path.

| piece | path |
| --- | --- |
| probe | `scripts/probe-steam-host-join.mjs` (`--help`, `--dry-run`; artifacts under `.sts2/artifacts/steam-host-join/`) |
| self-test (no game) | `scripts/test-probe-steam-host-join.mjs` |
| scenario / hook | `tests/scenarios/steam-host-join.sts2.yaml` / `couchcoop.steam-host-join-probe` |

Six legs: preflight (build identity, and a `-fastmp` refusal), menu-host, **steam-branch**, seat-join,
roster, handshake. What to know before reading its output:

- **Leg 2 is the whole point, and it is fatal.** A gate that silently degrades to ENet is *worse* than
  no gate, because ENet is the branch that already worked. So the probe grades the host's own
  `[couch-coop] host-transport` lines rather than its own intent, and only `steam` passes:
  `source=host-start` says our `StartSteamHost` prefix ran, `source=stock-enet` says the other branch
  did, and `steam host started lobby=… hostNetId=… couchSeats=ENet:33771` is the proof a real Steam
  lobby exists. `source=host-start` **alone is not enough** — the Steam-offline fallback runs through
  the same prefix and then hosts on ENet anyway — and a `hostNetId` of `1` fails too, because
  `HostNetIdPatch` does nothing at that value. A line-count baseline is taken before the Standard click
  so an earlier host start in the same process cannot answer for this one.
- **Reaching the Steam branch is the hard part.** `NMultiplayerHostSubmenu` picks the Steam host only
  when Steam is initialized AND `-fastmp` is absent, so no fixture can get there. The probe drives
  Main Menu → Multiplayer → Host → Standard with `dev scene hover` plus a click at `hoverPosition`;
  hover-before-click is **required**, because `NClickableControl` gates clicks on `IsFocused`. It needs
  a Steam client that is running and **online**, and a host launched without `-fastmp` — leg 0 refuses
  that flag up front rather than spending three minutes to report "not the Steam branch" about a host
  that was never going to be one.
- **Leg 5 is build-conditional, and defaults to asserting.** A build in `BUILDS_WITHOUT_HANDSHAKE`
  (`v0.107.1` today) skips it; every other build, **including one the probe has never seen**, must show
  `[HandshakeManager] Got handshake from sender …` in the seat's own `godot.log` and must not show
  `not currently in the middle of a handshake`, which is the defect signature. That default is
  deliberate: a false red is a question, a false green is the bug this probe exists for. `--handshake
  skip` is the escape hatch; adding a row to `BUILDS_WITHOUT_HANDSHAKE` is the fix. The refused line
  fails the leg in *every* mode.
- **`lobby.players[].isConnected` is not a join signal.** A live five-seat Steam-hosted lobby that went
  on to start a run reported `isConnected: false` for every couch seat. Leg 4 asserts membership plus
  `connectingPlayerCount == 0`; `isConnected` is recorded as evidence and believed about nothing.
- **A failed leg does not end the run.** Legs 4 and 5 run whether or not the seat joined, and leg 2 runs
  whether or not the menu route reached a lobby — a seat that never appeared is the *symptom*, and the
  reason is in the two logs those legs read. The one early stop is a host that is not on the Steam
  branch, where continuing would produce a green ENet result.
- The seat join itself is `joinSeats()` imported from `scripts/probe-five-player-run.mjs` — the same
  live-proven path, including its per-seat ENet handshake evidence. A second implementation of the seat
  join would be a second thing to be wrong.

### Focused connection status checks

Run `dotnet run --project tests/CouchCoop.Connection.Tests` for registry identity/timers, device parsing,
report bounds, log attribution, authenticated child control routes, and headless failure/retry cleanup.
This independent executable avoids loading the known failing full Mod.Tests runner. `--routes` selects
only the loopback HTTP tests; `--host-ui` runs native focus and localization checks; `--seats` covers allocation/teardown;
`--seat-build` covers "a seat runs the same copy of CouchCoop as its host" — which mod-list row a seat is seeded
to disable, the `settings.save` rewrite that does it, and the build comparison the seat refuses on;
`--ws-lifecycle` covers startup cancellation over a real WebSocket; `--labels` isolates
the device parser; `--patch-health` covers the host's OWN diagnostics — whether this process could install its
Harmony hooks, how host-service rows deduplicate, and that a degraded host condition is painted as a warning
rather than a failure. Use the normal scratch deployment environment when running in a worktree.

Frontend coverage includes `firstScenePresentation.spec.ts`, receipt messages, MirrorApp redirects, and
DOM/canvas mounting. Run the frontend typecheck and Vitest without `npm run build` (which deploys).
For live QA, verify the installed DLL and parser dependency closure, then use an isolated lobby and
private browser sockets. Capture the QR at desktop and 1280×800 with anonymous, joined, failed, and many
clients; exercise long localized strings and controller-only navigation including details, Copy, and
Dismiss. Verify Steam Deck Game Mode clipboard on actual hardware, or explicitly record its absence.

### Live lobby scenarios (QR host panel)

```
sts2 --json test run tests/scenarios/pc-lobby-qr-overlay.sts2.yaml
sts2 --json test run tests/scenarios/lobby-actions-remain-available.sts2.yaml
```

Both are self-contained: `game.deploy` (build + restart + verify) → `dev.delay` → the probe hook. They drive
a REAL game, so they take the live lock themselves.

| piece | path |
| --- | --- |
| shared probe helpers | `scripts/probe-lib-lobby-qr.mjs` |
| button/dialog/mirror probe | `scripts/probe-pc-lobby-qr-overlay.mjs` (screenshots `01..08` + `result.json` under `.sts2/artifacts/pc-lobby-qr-overlay/`) |
| semantic-actions probe | `scripts/probe-lobby-actions-remain-available.mjs` (available → blocked → available) |

There was a third, `pc-lobby-activity-log`, and it is **retired**: the lobby activity panel it drove was replaced
by the connections panel, and nothing mounted it any more, so the probe could only ever time out. Its one
irreplaceable leg moved into the overlay probe's mirror scan — no `CouchCoopQr*` **or** `CouchCoopConnection*`
node, and no viewer NAME, may reach a passive client. Player names ride the connections panel now, and the
stream-skip stamp is the only thing keeping them off the wire, so that assertion is load-bearing wherever it
lives. Run `lobby-actions-remain-available.sts2.yaml` last, and it must still pass: a second injected panel over
the lobby is exactly the shape of change that silently eats a click.

Gotchas these two encode, all found the hard way:
- **The `dev.delay` is load-bearing.** A freshly restarted game keeps finishing its boot flow for several
  seconds and pushes the main menu, POPPING a lobby a fixture just created (observed: fixture lobby at
  11:23:02, main menu at 11:23:04). Everything downstream then fails as "node path not found". The probes also
  re-load the fixture if the lobby does not hold for a settle window.
- **`dev scene node --properties` does NOT expose `mouseFilter`** (it exists only in spirectl's mirror scene
  watcher). Input-blocking must be asserted on the INPUT path — click a lobby control and observe
  `characterSelect.view.selectedCharacterButtonId` — not by reading a filter. The pre-Aug-8 probes "asserted"
  it as `mouseFilter === undefined || ...`, which passed vacuously forever.
- **`computedTransform.globalRect.size` is a Vector2**: its components are `x`/`y`, NOT `width`/`height`.
- **Screenshots clamp to the real window** (1344×756 here) whatever `--width/--height` say, so a design-space
  rect must be scaled by `appliedViewport / 1920×1080` before it can be used as a `--regions` ROI.
- **Re-selecting the already-selected character is refused** (`reasonCode: not_visible`) — a semantic
  `select-character` leg must target a DIFFERENT character.
- The scenario runner's artifact entries accept only `path` and `kind`; any extra key fails the whole hook
  with "did not return valid JSON".

### Five-player run repro (`tests/scenarios/five-player-run.sts2.yaml`)

```
sts2 --json test run tests/scenarios/five-player-run.sts2.yaml     # the repro, 5 players
node scripts/probe-five-player-run.mjs --players 4                 # the CONTROL, must pass on stock
node scripts/test-probe-five-player-run.mjs                        # game-free self-test of the probe
```

Reproduces: with the Workshop mod **Unlimited: No Player Limit** (`sts2unlimited`) raising the lobby cap, a
session of host + 4 browser seats fills the lobby, everybody readies, and the run begins with **only the host
alive and the in-run player list empty**. Seven legs — setup gate, host lobby (`lobby.maxPlayers >= N` is the
proof the cap really is raised), seats join, roster, characters+ready, **the gate (leg 5, expected to fail at
5 today)**, playable turn. Artifacts land in `.sts2/artifacts/five-player-run/`.

| piece | path |
| --- | --- |
| probe | `scripts/probe-five-player-run.mjs` |
| self-test (no game) | `scripts/test-probe-five-player-run.mjs` |
| hook | `couchcoop.five-player-run-probe` |

Point it at an isolated instance with `--record <bringup.json>` (schema `couchcoop-five-player-bringup/1`) or
`COUCHCOOP_FIVE_PLAYER_RECORD`; every field in that record is optional-with-fallback, so `--base` alone also
works. Things worth knowing before reading its output:

- **The evidence is the point.** Around embark it archives the host stdout/stderr and every seat `godot.log`
  and writes `signals.json`, which grep-scans them for `Embarking on a multiplayer run. Players:`,
  `[PacketSizePatch] Patched`, `Packet writer is growing from`, `Exception encountered while processing message
  LobbyBeginRunMessage`, `disconnected, reason:`, `ConnectionFailureReason`, `NetError`, and (seat logs only)
  `NullReferenceException`. `godot.log` has **no per-line timestamps**, so ordering is answered by line order
  within a file plus a `phase` stamp relative to a line-count baseline taken before the ready step.
- **A zero in `bySignature` is two different claims** — "that never happened" and "the scan never saw the
  file" — so the probe cross-checks the one pairing that can tell them apart: a run that embarked logs
  `Embarking on a multiplayer run. Players:` by definition, and zero hits for it after `state.run` appeared
  means the archive is reading logs this run did not write (a stale `hostStdoutPath`/`userDir`) or the wording
  moved. That lands as a loud `warnings[]` entry in `result.json` and on stderr — never as a failed leg. An
  empty `warnings` is what makes the other zeros worth reading.
- **There is no `start-run` verb.** Readying every seat is what embarks.
- **`run.players[]` has no alive/isDead field** — aliveness is derived from `creature.currentHp > 0`, and a
  null creature is reported `unknown`, never assumed alive.
- **Every couch seat has its own bridge** at `/tmp/spirectl-bridge-slot-<N>.sock`. The probe retries a
  host-refused seat action there and captures each seat's own view of the run, which is what answers "the host
  says one player — did seat 3 even enter a run?".
- **Cheap inner loop, not the gate:** `sts2 act join-lobby-player --display-name <name>` builds a 5-player
  LOBBY inside one process with no browsers and no ENet. Good for bisecting game-side logic fast; it does not
  exercise the real join path this defect lives on.

## 7. Gotchas

- **`npm run build` deploys.** Its Vite `outDir` is the installed mod's `frontend/` dir — running it in a
  branch overwrites the live install with unmerged code. Use `vue-tsc --noEmit` for the typecheck gate instead.
- **Two copies of this mod can be installed, and the game picks per process.** With both a `mods/couchcoop`
  deploy and a Workshop subscription, stable `v0.107.1` keeps the local copy and beta `v0.111.0` keeps the
  HIGHER version — with one `[WARN]` to say which. A beta session ran the published build in every headless
  seat while the host ran the working tree. `scripts/build-local-mod.sh` now stamps `9999.0.0+dev.<sha>` into
  the deployed manifest so a dev deploy cannot lose that comparison, seats are seeded with the other copy's
  mod-list row disabled, and a seat whose build differs from its host's reports `seat-build-mismatch` and
  exits instead of joining. **Still prove what loaded**, and from the log rather than from having deployed:
  `grep 'Loading assembly DLL' <userDir>/logs/godot.log` must name `mods/couchcoop/couchcoop.dll`, in the
  seat logs as well as the host's.
- **`pkill -f <pattern>` self-matches.** A pattern that also appears in the invoking shell's own argv (e.g. a
  literal string from the command you're about to relaunch) kills the invoking shell too (exit 144, no output).
  Also: `COUCHCOOP_HEADLESS_CLIENT` is an environment variable, not argv — `pkill -f` against it matches
  nothing; the real headless process pattern is `SlayTheSpire2 --headless`. Run kill and relaunch as separate
  Bash calls.
- **`--shot` needs a real display, never `--headless`.** Under `--headless` the dummy renderer never fires
  `FramePostDraw`, so the capture path hangs until a hard timeout. Use a per-agent `Xvfb :6x -screen 0
  <WxH>x24` (own display number per concurrent agent) — never the user's live `DISPLAY=:1`. Non-shot runs
  (`--dump-final-state`, `--connect` soaks, tests) are fine under `--headless`.
- **Godot CLI binary**: the mono build is at
  `~/.local/godot-4.5.1-mono/Godot_v4.5.1-stable_mono_linux_x86_64/Godot_v4.5.1-stable_mono_linux.x86_64`. The
  `godot` on `PATH` is a non-mono 4.6.2 — it runs the project scriptless (`No loader found for resource:
  res://src/App/AppShell.cs`) and silently idles forever.
- **`Environment.GetCommandLineArgs()` is dead** inside the embedded Godot CoreCLR host — use
  `Godot.OS.GetCmdlineArgs()`/`GetCmdlineUserArgs()` for game argv. `godot.log` does NOT capture
  `Console.Error`, so `GD.Print` is what puts a line THERE — but `sts2 game launch` no longer detaches the
  child's stdio: both streams are captured under `.sts2/artifacts/game-launch/` and tailed by
  `dev logs --source game-stdio` (§2; the mod's own lines are on stdout).
- **`sts2 game deploy ... --build` works again** (2026-09-04). The CWD-resolution mismatch between the publish
  output path and the deploy-subdir path is fixed — sts2 passes the directory it will copy from to the build
  (`{deployOutputDir}` / `$SPIRECTL_DEPLOY_OUTPUT_DIR`, one spelling in `sts2.config.yaml`) and fails with
  `deploy_build_output_missing` / `deploy_build_output_stale` instead of copying a directory the build did not
  refresh. `scripts/build-local-mod.sh` alone still works; the full loop is
  `sts2 --json game deploy src/CouchCoop.Mod.Loader --build --restart --verify`. `--wait-quiescent-ms` adds a
  settle verdict (`quiescence{quiescent,elapsedMs,timedOut,status}`) but is NOT a replacement for the fixed
  `dev.delay` in the live lobby scenarios — it reported quiescent 1.2 s after attach on 2026-09-04, inside the
  boot-flow window that pops fixture-created lobbies. See `.ai/tool-improvements.md`.
- **Ask sts2 where the game is** instead of re-parsing `sts2.local.yaml`: `sts2 --json config resolve`
  returns absolute `gamePath` / `assembliesDir` / `resourcesDir` / `modsDir` / `instancesDir` /
  `artifactsDir` plus `sources` and `configFiles`, and finds the config by walking UP from the working
  directory (stopping at the `.git` boundary), so it works from any subdirectory of the checkout. Name keys to
  narrow it: `sts2 --json config resolve modsDir gamePath`. `scripts/build-local-mod.sh` uses it, with its old
  sed read of `sts2.local.yaml` kept as the no-CLI fallback. `Directory.Build.props` and
  `frontend/vite.config.ts` deliberately do NOT — MSBuild needs the value during property evaluation, before a
  target could run anything, and vite.config.ts sits inside the tree
  `scripts/validate-no-sts2-cli-runtime.sh` scans.
- **Worktree setup**: cut from **current local main** (not `origin/main` — worktrees have been created stale
  against the remote more than once; `git log --oneline -1` the new worktree immediately and
  `git merge --ff-only main` if it's behind before editing). Symlink `frontend/node_modules` to the primary
  checkout's (derive `PRIMARY="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`, then
  `ln -s "$PRIMARY/frontend/node_modules" frontend/node_modules`) — this needs
  a **bare** `node_modules` / `frontend/node_modules` entry in the SHARED `.git/info/exclude` (a linked
  worktree has no exclude file of its own; the main repo's `.git/info/exclude` is shared by all worktrees, and
  a directory-slash pattern like `node_modules/` does not match a symlink, only the bare name does). Copy
  `sts2.local.yaml` (gitignored) and a real `godot-client/.godot` cache directory (`imported/`, `uid_cache.bin`,
  `mono/`) from a working checkout into a fresh worktree to skip a slow full reimport on first Godot run.
  Tracked `*.cs.uid` sidecar files (Godot 4.4+ per-script resource-identity files) ship in git alongside their
  `.cs` file — `.godot/uid_cache.bin` is the LOCAL (gitignored) index built from them, so copying `.godot` is
  what actually saves the reimport, not the tracked `.uid` files themselves.
- **A worktree's `dotnet build`/`Mod.Tests` run can POISON the live game install**: `Directory.Build.props`
  resolves `modsDir` from the worktree's own `sts2.local.yaml` and deploys on every build. Set
  `COUCHCOOP_GAME_MODS_DIR` to a scratch directory in worktree agents, or strip `modsDir`/`game.path` from
  their copied `sts2.local.yaml`. Recover a poisoned install with `scripts/build-local-mod.sh` from main + a
  game restart.
- **Stale on-disk model cache** after a bridge/model shape change: clear
  `~/.local/share/SlayTheSpire2/couch-coop/cache/*/assets/model/` after `install-bridge` + relaunch, or you'll
  test against old cached JSON. The glob is over VERSION directories (the cache is scoped per game version), and
  a bridge change invalidates all of them without the stamp noticing — nothing about the GAME
  moved. Everything the mod writes into the user profile lives under `couch-coop/`.
- **Any `dotnet build` of the sln DEPLOYS — verify the installed DLL after every deploy.** The main checkout's
  build also copies into the live mods dir, so a stray build (yours or another agent's) silently replaces
  whatever was deployed. Build/deploy only while holding the live lock, and afterwards prove the install is
  yours: `stat -c %y <modsDir>/CouchCoop.Mod.dll`, or grep the DLL for a type name only your branch adds (see
  the `couch-deploy` skill; an Aug-10 agent measured a whole QA leg against someone else's build before
  checking). Do not try to read a cache generation out of the DLL to identify a build: the string is
  interpolated from two constants, and since the cache became version scoped it names no path at all — the
  live answer is the `[couch-coop] cache game=… hash=… cache=v… root=…` line the mod logs at startup.
- **Live-lease hygiene (multi-agent rounds).** Acquire only the named resources you touch with
  `scripts/live-qa-lock.mjs`; all live sessions share `install`, while deployment holds it exclusively. Before
  RELEASING, restore the real `../spirectl` / `../godot-scene-web` checkouts to clean `main`.
- **Testing a godot-scene-web branch without touching the shared checkout**: run the couch dev server/vitest
  with a scratch vite config (`--config <file>`) that re-aliases `@godot-scene-web/*` to your gsw WORKTREE.
  The shared checkout never leaves `main`, which removes the whole "agent left gsw on a branch and poisoned
  everyone's vitest" failure class.
- **`.gitignore`'s `node_modules/` does NOT match a node_modules SYMLINK** (trailing slash = directories
  only). Worktrees use symlinked node_modules, so a blanket `git add -A` there can commit the symlink — one
  landed in a gsw merge in the Aug-10 round. Add paths explicitly, or check `git status` for `node_modules`
  before committing.
- **Phone Chrome over CDP drives only the ACTIVE tab** (Aug-11): `adb forward tcp:9222
  localabstract:chrome_devtools_remote` + `chromium.connectOverCDP` sees exactly one page, and per-page CDP
  endpoints for BACKGROUND tabs are unresponsive. Get the tab you need foregrounded first; don't burn attempts
  on a backgrounded mirror tab. Also check the phone's lock state EARLY (`adb shell dumpsys window | grep
  mDreamingLockscreen`) — a fingerprint-locked phone ends all device QA and the fallback should start sooner.
- **directView live-confirm fallback** (Aug-11): when an isolated headless instance is unavailable (e.g. disk
  full — `sts2 --instance … game launch` fails on ENOSPC), a SINGLEPLAYER run answers every mirror join with
  directView, so a desktop browser tab against the real host exercises the full wire (input, actions, eager
  scroll) without spawning seats or adding players. Synthetic pointer/touch events there are real host QA;
  only the physical-finger feel remains unproven. Watch the side effect one agent hit: ANY direct-view tab
  pushes its default `settings` payload to the host on connect (freezes/refresh-rate may change under you).

## 8. Agent brief template

When briefing a new implementer/explorer agent for a similar round, point it at:
1. **`docs/agents/architecture-map.md`** — subsystem → files/mechanism/kill-switches/tests, so it does not
   re-derive stable architecture.
2. **`docs/agents/qa-recipes.md`** (this file) — launch/QA/test recipes, so it does not re-discover the launch
   sequence or test-runner quirks by trial and error.
3. The relevant spec appendix for the round (e.g. `.ai/plans/round2-jul30.md` or a newer round file) — the
   issue list, ranked hypotheses, and file:line pointers already established by that round's explorers.
4. For any round that touches mirror POINTER INPUT (`inputCapture`, `pointerMap`, `raiseInverse`,
   `viewScaleInverse`, `confirmTap`, the readable-hand raise pass): **`docs/agents/touch-live-harness.md`**
   and `scripts/validate-touch-live.mjs`. That harness is mandatory before landing — the bugs in that area
   are feedback loops (send a coordinate → the game re-poses the boxes → the next resolve sees different
   geometry), which unit tests and replayed recordings structurally cannot exercise, and which have been
   fixed and re-broken across three rounds as a result.
5. For any round working from a bug a PLAYER hit rather than one you can reproduce yourself:
   **`docs/agents/repro-recorder.md`**. The player turns on one settings toggle, marks the moment and sends a
   file; `scripts/analyze-repro.mjs` then says whether the client sent anything and whether the game answered,
   and `scripts/replay-repro.mjs` puts the session back on screen in a local browser with no game running. A
   recorded session is also a valid passive recording, so it feeds the replay server and the bench unchanged.

Standing rules to restate in every brief:
- Run only the suite(s) covering the files you touched; a coordinator runs full suites once at merge.
- Hard attempt budgets on any live-game/device objective ("N failed launches/relaunches → stop and report the
  blocker", not an open-ended retry loop).
- Cap the final report size (a short summary + concrete file:line pointers, not a transcript).
- Evidence handoff is file-based (screenshots/recordings/logs at stated paths) — agent transcripts are not
  retained for the coordinator to re-read.
- Commit to your assigned worktree branch only, with trailer `Co-Authored-By: Claude Fable 5
  <noreply@anthropic.com>`; do not merge to main and do not push unless explicitly told to.
