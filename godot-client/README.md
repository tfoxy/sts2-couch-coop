# CouchCoop native Godot client — `godot-client/`

Native Godot client for the Slay the Spire 2 Couch Co-op mod.

## Purpose

An Android-first (also desktop) native Godot app that consumes the mod's **mirror** stream directly —
the same wire the browser mirror already speaks, but rendered by a real Godot runtime instead of the DOM:

- **WebSocket:** `ws://<host>:13337/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0` — JSON `scene-delta` messages. The client **must** send
  `{"type":"scene-ack"}` after each applied delta (mandatory flow-control credit) and answers/initiates
  `{"type":"ping","t0":<ms>}` ⇄ `{"type":"pong","t0":...}` for RTT.
- **HTTP assets:** `GET /res/{res-path}` → PNG/webp/fonts/gdshader text (a Godot `res://images/x.png` maps to
  `/res/images/x.png`); `GET /spines/{scene}?node=..&anim=..` → SPCL binary spine clips.

The game runs **Godot 4.5.1**, so the client pins 4.5.1 (see [Toolchain pinning](#toolchain-pinning)).

This directory contains **zero** game / spirectl references and is shielded from the repo-root
`Sts2AssembliesDir` MSBuild machinery (empty `Directory.Build.props`/`.targets`), so it builds standalone
with **no** `sts2.local.yaml` and **no** game assets.

## Layout

```
godot-client/
├── project.godot                 # Godot 4.5 project (1920x1080, canvas_items/keep), main scene AppShell.tscn
├── CouchCoop.GodotClient.csproj  # Sdk="Godot.NET.Sdk/4.5.1", net8.0, nullable, RootNamespace CouchCoop.GodotClient
├── Directory.Build.props/.targets# EMPTY shields — stop MSBuild walking up to the repo-root sts2 machinery
├── export_presets.cfg            # best-effort Android (arm64) + Linux presets (editor normalizes on open)
├── .gitignore                    # .godot/, bin/, obj/, dist/, *.apk, android/build/, ...
├── scenes/AppShell.tscn          # Node2D root + AppShell.cs
├── src/App/                      # app layer
│   ├── AppShell.cs              # main-scene router: --connect / --replay / --dump-final-state
│   └── ConnectionCoordinator.cs # join dance (directView / headlessMirrorPort redirect / joinRejection) + reconnect
├── src/Net/                      # transport
│   ├── MirrorSocket.cs          # WebSocketPeer wrapper + dispatch + dual-bucket RTT (mirrorClient.ts)
│   └── SceneDeltaParsePipeline.cs# off-main-thread FIFO parse worker (Channel<byte[]> -> Channel<MirrorDelta>)
└── src/Scene/                    # retained tree
│   └── MirrorStore.cs           # MirrorState + GlobalTransformIndex; drain -> apply -> ack (credit contract)

Consumes the shared, game-free `../src/CouchCoop.MirrorProtocol/` (ProjectReference + in the .sln): scene-delta
reader/applier, GlobalTransformIndex, session/pong/server-reload envelopes, and the join/input/scene-ack/ping/
settings send records.
```

Repo-root companions (in `scripts/`):
- `scripts/replay-ws-server.mjs` — real-WebSocket replay server for recorded mirror streams (drives the client
  with no live game). `node scripts/replay-ws-server.mjs --self-test` asserts pacing/ack/pong/reload behaviour.
- `scripts/compare-replay-final-state.mjs` — cross-language state-parity check: replays one NDJSON through the
  web model (`frontend/src/mirror/sceneTree.ts`) AND the Godot client (`--replay --dump-final-state`), diffing the
  final-state summary (node/orderedIds counts, orderedIds FNV-1a, per-type counts, revision).
- `scripts/bench-godot-android.sh` — adb measurement wrapper (gfxinfo/cpu/top/meminfo/battery + `BENCH_RESULT`).

## Run modes (`--path godot-client -- <args>`)

- `--connect <host[:port]>` (default port 13337) — real stack: join dance + retained tree; logs `M1B_SESSION:`
  directives, per-second `M1B: revision=…` counts, and 5-second `M1B_RTT:` dual-bucket summaries. `--name <n>`
  auto-joins once; `--duration <s>` quits with an `M1B_SUMMARY:` line. Name memory: `user://settings.cfg`.
- `--replay <ndjson>` — no socket; feeds a `repro/1` recording through the same parse worker + store. `--dump-final-state`
  prints one `M1B_FINAL_STATE: {json}` line (the parity summary) and quits.
- `--qa-port <n>` (Track Q) — mount the localhost-only debug **QA control channel** on `127.0.0.1:<n>` so QA can
  drive the client with structured verbs (input / settings / connect / state) instead of blind adb taps. Also
  enabled by a `[qa] port=<n>` key in `user://settings.cfg` (the Android path). **Default OFF.** See
  [docs/qa-channel.md](docs/qa-channel.md).

## Toolchain pinning

The engine is pinned to **Godot 4.5.1 .NET**. Two independent things must match 4.5.1:

1. **The C# SDK** (`Godot.NET.Sdk/4.5.1`) — restored from NuGet automatically by `dotnet build`. **Verified:**
   `4.5.1` restores from the NuGet cache in this environment (`~/.nuget/packages/godot.net.sdk/4.5.1`,
   `godotsharp/4.5.1`). If a future environment cannot restore `4.5.1`, the nearest `4.5.x` is the accepted
   fallback — note it in the csproj.
2. **The editor + export templates** — must be the **.NET / Mono** build of 4.5.1 (a standard build cannot run
   or export C#). Canonical download asset names (Godot release naming; verify on the releases page):
   - Editor (Linux): `Godot_v4.5.1-stable_mono_linux_x86_64.zip`
   - Export templates: `Godot_v4.5.1-stable_mono_export_templates.tpz`
     (installs to `~/.local/share/godot/export_templates/4.5.1.stable.mono/`)
   - Base URL: `https://github.com/godotengine/godot/releases/download/4.5.1-stable/<asset>`

   **Plan:** mirror the exact editor zip + `.tpz` as assets on a `toolchain-godot-4.5.1` repo release so every
   machine/CI pins identical bytes rather than re-downloading from upstream.

> The Godot editor/templates installed in **this** environment are the **standard (non-.NET) 4.6.2 build** and
> therefore **cannot** open/run/export this project — see [Environment findings](#environment-findings). Only
> the `dotnet build` path works here.

## Build (no game assets / config needed)

```bash
dotnet build godot-client/CouchCoop.GodotClient.csproj
```

This is the CI-friendly path: it needs only the .NET SDK + NuGet (`Godot.NET.Sdk` + `GodotSharp`), **no** Godot
editor, **no** export templates, **no** `sts2.local.yaml`, **no** game assets.

## Run recipes

Cmdline **user** args go after `--` (they land in `OS.GetCmdlineUserArgs()`).

```bash
# Connect mode against the replay server (no live game):
#   terminal 1:
node scripts/replay-ws-server.mjs --recording .sts2/bench/combat-baseline.ndjson --port 13400 --pace max
#   terminal 2 (desktop, windowed):
godot --path godot-client -- --connect 127.0.0.1:13400 --duration 20
#   -> streams deltas, acks each, pings while requested, and prints a summary.

# Against a LIVE game host on the LAN:
godot --path godot-client -- --connect 192.168.1.5:13337 --name Player1 --duration 30
```

## Android export recipe

**Supported path (2026-07-17): `scripts/build-android-apk.sh` at the repo root** — wraps everything below
(preflights the toolchain, refuses baked `command_line/extra_args`, exports `dist/couchcoop-client.apk`,
enforces the arm64 payload gate) and with `--deploy` copies the APK to `<modsDir>/couchcoop/apk/` where the
host serves it at `/couchcoop-client.apk` and the join page shows an "install the native app" link on Android
(lean M1f). The manual recipe below remains valid and documents what the script does.

**PROVEN HEADLESS (no editor UI) — July 15 2026, produced a valid signed 80MB debug APK** (arm64
`libgodot_android.so`, `usesCleartextTraffic=true`, minSdk 24). Scripted path:

```bash
# One-time host setup (paths as installed on this machine):
#   Godot 4.5.1 mono editor : ~/.local/godot-4.5.1-mono/.../Godot_v4.5.1-stable_mono_linux.x86_64
#   Export templates        : ~/.local/share/godot/export_templates/4.5.1.stable.mono/
#   JDK 17 (portable)       : ~/.local/jdk-17          (system Java 8 is too old for AGP/sdkmanager)
#   Android SDK             : ~/.local/android-sdk     (platform-tools, build-tools;34.0.0, platforms;android-34)
#   Debug keystore          : ~/.local/android-keystore/debug.keystore (androiddebugkey / android / android)
# Editor settings (~/.config/godot/editor_settings-4.5.tres) must carry:
#   export/android/java_sdk_path, android_sdk_path, debug_keystore{,_user,_pass}
./setup-android-template.sh          # installs + cleartext-patches res://android/build (generated, NOT committed)
export JAVA_HOME=~/.local/jdk-17
<godot-4.5.1-mono> --headless --path . --export-debug "Android" dist/couchcoop-client.apk
```

Gotchas discovered the hard way (fixed in this repo, listed so nobody re-trips):
- **Silent export failure** (`configuration errors:` followed only by the C#-experimental notice) = the
  ETC2/ASTC gate: `has_valid_project_configuration` sets `valid=false` **without any message** unless
  `project.godot` has `[rendering] textures/vram_compression/import_etc2_astc=true` (now set).
- **`… is a C# file but no solution file exists`** during export: the .NET editor expects a `.sln`
  beside `project.godot` (normally generated on first editor open); `CouchCoop.GodotClient.sln` is
  now committed.
- The gradle build needs **~1.5GB free** on the partition holding the repo + `~/.gradle` (template
  ~700MB + build outputs). After a clean checkout, rerun `./setup-android-template.sh`.
- **Disk full ⇒ APK silently exports WITHOUT the .NET payload.** With no free space, the export's
  `dotnet publish` step leaves `.godot/mono/temp/bin/ExportDebug/android-arm64/` EMPTY, the export
  still reports DONE, apksigner still verifies — and the app dies on device with
  `ERROR: .NET: Assemblies not found (gd_mono.cpp)`. After every export, verify the payload:
  `unzip -l dist/couchcoop-client.apk | grep -c 'assets/.godot/mono/publish/arm64'` must be > 0.
- **`android/build/` needs a `.gdignore`** (created by `setup-android-template.sh`). Without it the
  scanner walks the gradle tree and each export re-packs its own previous asset copies as
  recursively-nested zero-byte phantoms (`Can't open file from path 'res://android/build/assets/…'`).
- **`command_line/extra_args` must start with `-- `** so Godot passes app arguments to
  `OS.GetCmdlineUserArgs()`.
- The phone doesn't need Wi-Fi for replay-server runs: `adb reverse tcp:13400 tcp:13400` tunnels the
  device's `127.0.0.1:13400` to this machine. RTT over the tunnel is not representative of Wi-Fi.

Manual editor-UI equivalent:

1. **Open** the project in the **Godot 4.5.1 .NET editor** and install the export templates
   (`Godot_v4.5.1-stable_mono_export_templates.tpz`).
2. **Install the Android build template:** *Project ▸ Install Android Build Template* — this generates
   `res://android/build/` (a gradle project). Requires the Android SDK + a debug keystore configured in
   *Editor Settings ▸ Export ▸ Android*. (Or just run `./setup-android-template.sh`, which does 2+3.)
3. **Enable cleartext traffic (load-bearing):** the client talks **plain** `ws://` + `http://` on the LAN.
   Android 9+ blocks cleartext by default, and Godot 4.5's Android export preset has **no**
   `usesCleartextTraffic` option, so set it in the generated manifest:
   ```xml
   <!-- res://android/build/AndroidManifest.xml -->
   <application android:usesCleartextTraffic="true" ...>
   ```
   (or ship a `network_security_config.xml` permitting cleartext to the host). The `Android` preset already
   grants `permissions/internet=true`, but that is separate from the cleartext flag.
4. **Pass app args** via the preset's *Command Line ▸ Extra Args* (`command_line/extra_args`), e.g.
   `-- --connect 192.168.1.5:13400 --duration 30`.
   The leading `--` is REQUIRED — see gotchas.
5. **Export** (arm64, debug) → `dist/couchcoop-client.apk`, then:
   ```bash
   adb install -r dist/couchcoop-client.apk
   adb shell am start -n com.couchcoop.client/com.godot.game.GodotApp   # launch (verify the activity name)
   scripts/bench-godot-android.sh com.couchcoop.client 30               # sample + scrape BENCH_RESULT
   ```

## Environment findings

`scripts/build-android-apk.sh` preflights the editor, export templates, JDK, Android SDK, and debug keystore.
Do not rely on whichever `godot` happens to be on `PATH`: verify that it is the pinned **.NET/mono 4.5.1** editor
(not the standard build) before opening, running, or exporting this C# project. The standard build has no
`hostfxr`/`coreclr`/`GodotSharp` support and cannot run or export C#. Download
`Godot_v4.5.1-stable_mono_linux_x86_64.zip` when that check fails.
- **Export templates:** install `Godot_v4.5.1-stable_mono_export_templates.tpz`; standard/non-.NET templates are
  incompatible with this C# project.
- **Android device checks:** `bench-godot-android.sh` requires `adb` on `PATH` and an attached device, and exits 3
  when either prerequisite is absent.
- **.NET SDK:** restore the net8 targeting pack plus `Godot.NET.Sdk/4.5.1` and `GodotSharp/4.5.1` from NuGet before
  building the client.
- **Node:** use a current Node release with a global `WebSocket`; `replay-ws-server.mjs` supplies its own RFC6455
  server and does not require the `ws` npm package.
