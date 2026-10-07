# Handoff: per-viewer game audio in the mirror (shape B)

**Status:** implemented. The shipped architecture and live QA procedure are in
[`architecture-map.md`](architecture-map.md#seat-audio) and [`qa-recipes.md`](qa-recipes.md#seat-audio-live-matrix).

This plan builds on the Oct 5–6 experiment programme (E0–E8). The measurements and the reasoning behind each
decision live in the uncommittable research notes under `.sts2/research/audio/`: `e0-census.md`,
`e1-latency-floor.md`, `e1b-device-latency.md`, `e5-client-cache.md`, `e2-live-capture.md`,
`e4-e3-offline-render.md`, `e6-shape-b-e2e.md`, `e8-music-ambience.md` and
`fmod-licensing-determination.md`. The project-memory entry point is `seat-audio-experiment-programme`. The
prototype code is on the experiment branches `exp/audio-census`, `exp/audio-capture`, `exp/audio-render` and
`exp/audio-music`. It is spike code: read it for the native declarations and the op vocabulary, and do not
copy it wholesale.

## 1. Context

### What was measured
- **Moto G31, plain-HTTP LAN, with a silent `<audio>` prelude and the keep-alive.** From the seat's play call
  to the phone's speaker:
  - a cached take plays at 37 / 40 ms (predicted p50 / p95), with an acoustic upper bound of ~47 ms;
  - a sound heard for the first time (rendered on the host and streamed) plays at 48 / 63 ms.
- **Without the keep-alive**, Chrome drops the fast output track after silence, which adds ~70 ms.
- **Renderer speed.** A private FMOD Studio non-real-time system inside the host process takes 0.64 / 2.2 ms
  (p50 / p95) from a request to its first mixed block. It runs faster than real time.
- **Renderer fidelity.** 17 of 17 keys fall within the live game's own variation.
- **Music replay (E8).** Replaying the host's music calls reproduces the music sample for sample. Ambience
  matches only statistically.
- **Music over the WebSocket (E8).** PCM16 reaches the phone's output 95–112 ms after its due time.
- **Stall recovery (E8).** After a Wi-Fi stall, a naive re-anchor left 203 ms of extra delay for the rest of
  the session.
- **Godot TmpSfx mp3s** are 35–39% of all sound starts. The product's `/res` route refuses `AudioStreamMP3`.

### Maintainer decisions (binding)
- **One take per sound key.** Each sound is rendered once and cached on the host and the client. There is no
  pool of variants and no fresh render per play.
- **One mirror toggle, "Audio", default off.** When it is off, nothing is sent and the game's audio settings
  are not read.
- **When the toggle is on, the viewer's own seat settings decide.** The seat's in-game Master, BGM, SFX and
  Ambience volumes apply:
  - a value of 0 means that lane is not sent at all (Master 0 sends nothing);
  - non-zero values are applied as gains.
- **The host renders everything at unity gain, and each client applies its own seat's gains.** That way one
  cached take serves every seat.
- **Keep-alive** (a 1e-5 constant) runs only while nothing else is playing.
- **Music join is approximate:** start the current state without replaying history.
- **Codec:** raw PCM16 now; Opus later.

### Licensing constraints
Source: `fmod-licensing-determination.md`. This is research, not legal advice.
- Use only FMOD's public C API, with hand-written declarations. No FMOD headers or SDK files, no `getGlobals`,
  no handle probing, and nothing found by disassembly.
- Load banks from the game's pck through callbacks or memory. Never extract them to disk, and never serve
  `.bank` data.
- Cache short SFX takes only. Music and ambience are streamed, and never cached or stored.

### Repo rules that shape the design
- No polling: find the hook.
- Zero-client dormancy, enforced by the zero-client guard.
- Reuse is earned: the TmpSfx route is CouchCoop-local.
- No game code is committed.
- Raw `TcpListener`, `System.Text.Json`, and a single-screen SPA.
- `npm run build` deploys, and `dotnet test` is a no-op.
- `Server/*.cs` is link-compiled into the hot-reload assembly. Process-owned statics, native handles and
  threads therefore live outside `Server/`, in `Audio/` and `Runtime/`.

## 2. Architecture

### Seat process (headless; FMOD stays released as today)
- **Reporters, not players.**
  - The existing `HeadlessAudioMutePatch` skip prefixes become reporters.
  - A new seat-only postfix reports `NDebugAudioManager.Play`: the TmpSfx path, the drawn pitch and the volume.
- **Volumes.**
  - Volume-setter calls update a process-owned `SeatAudioFeed`.
  - The Godot debug-bus setters are read back through `AudioServer.GetBusVolumeDb`.
- **Event flow.**
  - With no subscriber, the reporter returns after one volatile read and allocates nothing.
  - With a subscriber, it publishes small text events `{kind, keyId, key | resPath, pitch, volume, t}`.
  - Events for gated lanes are dropped at the seat.
- **Seat lane.** This is a separate WebSocket relayed to the seat: `/ws?seat=R&lane=audio`. The host's relay
  predicate is unchanged, and the seat dispatches on `lane=audio` before the canonical selector check.
  - **Why not reuse `/ws`:** events would queue behind 64 KiB scene fragments on `_sendGate`.
  - **Messages:** inbound is text only (hello / ack, ≤ 1 KiB). Outbound is text, starting with a volume
    snapshot and then pushes on change.

### Host process (`src/CouchCoop.Mod/Audio/`, process-owned `AudioService`)
- **TakeRenderer.** One or two private FMOD Studio `NOSOUND_NRT` systems, each on a dedicated thread. They
  render one-shots only, faster than real time.
- **StreamRenderer.** One private NRT system paced to real time. It is driven by the host's own proxy calls
  and has three lanes, each captured at its own bus ChannelGroup:
  - music (the BGM bus);
  - ambience (the Ambience bus);
  - loops (the SFX bus).
- **TakeCache.** A memory LRU plus a disk store under the cache root's `audio/` directory. It holds SFX takes
  only.
- **HostMusicState.** An O(1) memo of the current music, ambience, loops, globals and act bank. The approximate
  join starts from it.
- **Render lane.** A host-terminated `GET /audio` WebSocket.
  - Inbound text: `play {keyId, key}` and `lanes {music, ambience, loops}`.
  - Outbound binary PCM16 frames, sent by a per-client deadline-ordered sender. It releases a block no more
    than 100 ms before its due time; E6 showed arrival-order sending made new sounds wait behind tails.
  - Text control messages: hello, `take-ready`, `unavailable`, and clock samples.
- **HTTP routes.**
  - `/audio/take/{schema}/{bankset}/{keyId}.wav?b={token}`, immutable;
  - `/audio/takes?b=`, an index of ready keys, used to warm the client;
  - `/audio/tmpsfx/{resPath}?b={token}`, which serves the `AudioStreamMP3` bytes.
- **Dormancy.**
  - The take renderer exists only while at least one render-lane subscriber exists.
  - The stream renderer exists only while at least one subscriber has a music, ambience or loops lane on.
  - Both are created on demand and released immediately, with no linger timer. Both are registered in
    `ZeroClientEntries`.
  - The host hooks and the memo are always installed, but their work is limited to a pointer compare and an
    O(1) store.
  - The stream renderer paces itself with a real-time media clock that exists only while a lane has
    subscribers. That is a playback clock, not a poll, and work-package reports must name it as such.

### Browser (`frontend/src/audio/`)
- **One `AudioContext`.** It is created inside the toggle's gesture, after a silent `<audio>` prelude. The mic
  is never used.
- **Keep-alive.** A `ConstantSource` at 1e-5, gated on the count of active voices.
- **Take storage.** A map of decoded `AudioBuffer`s keyed by `keyId`. Takes use immutable URLs in the HTTP
  cache, because Cache Storage is unavailable on plain HTTP.
- **First-sight keys** play as a stream, then are assembled into the map.
- **Lane buffers.** The music, ambience and loops lanes each have a jitter buffer with a 60 ms target. After a
  stall it drops the backlog instead of playing it late.
- **Gains.**
  - FMOD lanes use master² × bus², the volume curve measured in E8.
  - TmpSfx uses the dB values the seat reports.
  - Each lane is gated by its raw seat value being > 0, and everything is gated by the mirror toggle.
- **Seat switches.** Lanes reconnect when the viewer switches seat.

## 3. Work packages

### WP0 — wire contract and key canonicalisation (do first, small)
- **Files to add**
  - `src/CouchCoop.MirrorProtocol/Envelopes/AudioMessages.cs`: seat-lane events (`sfx`, `tmpsfx`, `loop`, and
    the `volumes` snapshot and delta), plus render-lane control messages. Register them in
    `ProtocolJsonContext.cs`.
  - `src/CouchCoop.MirrorProtocol/Audio/SoundKey.cs`: the canonical key and its `keyId`.
    - Canonical key: `path|k=v,...`, with params sorted ordinally and floats in invariant `R` format.
    - `keyId`: hex of the first 16 bytes of SHA-256 over the canonical key and a schema byte.
    - The seat computes the `keyId`. The client never hashes, because `crypto.subtle` does not exist on
      insecure origins.
  - `src/CouchCoop.MirrorProtocol/Audio/AudioFrame.cs`: the binary header, v1.
    - Header fields: magic and version, kind (take block or lane block), stream or lane id, block index,
      frames, flags (first, last, silent), due time in host-monotonic µs, and a send stamp.
    - Body: interleaved stereo PCM16 at 48 kHz, 512 frames per lane block.
  - `tests/fixtures/audio/`: golden keys, keyIds and frames, shared by C# and TypeScript.
  - `frontend/src/audio/audioWire.ts`.
- **Tests**
  - `tests/CouchCoop.MirrorProtocol.Tests/AudioWireTests.cs`.
  - `frontend/src/audio/__tests__/audioWire.spec.ts`. It uses the same golden fixtures.
- **Acceptance.** Both suites pass. The `keyId` values match across languages for the top 30 census keys.

### WP1 — host native layer and take renderer (`Audio/Native`, `Audio/Banks`, `Audio/Render`)
- **`FmodApi.cs`**
  - Hand-written `DllImport`s for the public C API only.
  - Struct layouts are size-checked: `cbSize`, the bank-info size, and the DSP description's SDK version.
- **`FmodLibrary.cs`**
  - A `NativeLibrary.SetDllImportResolver` that binds to the game's already-loaded libraries (`libfmod.so.14`
    and `libfmodstudio.so.14` on Linux).
  - Windows and macOS names are compiled in, but they have not been verified live.
- **`FmodVersionGate.cs`.** This follows the "try unknown versions, don't refuse" rule:
  - First try `Studio_System_Create` with the compiled header version. 2.03.06 is the measured version.
  - On `ERR_HEADER_MISMATCH`, retry with the version the loaded core library reports.
  - On the first error code, switch audio off for the session and log one line.
  - Classify every call. Any struct-offset read must be listed in the work-package report as a hard-stop
    class. The expectation is that there are none.
- **`PckBankSource.cs`** loads the banks without ever extracting them.
  - It parses Godot's pck directory to find each bank's offset, size and MD5.
  - It loads banks with `FMOD_Studio_System_LoadBankCustom`. The read and seek callbacks are `UnmanagedCallersOnly` positional
    reads from one `SafeFileHandle`, with no allocation.
  - It uses `LOAD_FROM_UPDATE` and `STREAM_FROM_UPDATE`, so every callback runs on the render thread.
  - If the pck is encrypted or compressed, it fails closed and never extracts.
- **`BankSet.cs`.** The bank-set id is a hash of the per-bank MD5s.
- **`FmodRenderSystem.cs`.** One system per dedicated thread:
  - `NOSOUND_NRT` output, 48 kHz stereo;
  - synchronous update with `MIX_FROM_UPDATE`;
  - a per-worker seed;
  - a capture DSP whose `UnmanagedCallersOnly` callback copies into a `NativeMemory` ring.
- **`TakeRenderer.cs`.**
  - An arrival-ordered job queue.
  - In-flight attach: concurrent requests for the same cold key produce one render.
  - It emits blocks to `IAudioBlockSink`. The renderer sits behind `IFmodRenderBackend`, so it can be faked
    in tests.
- **Design rules**
  - **The render thread is allocation-free:** pre-encoded paths, no LINQ or closures, and `ArrayPool` slabs.
    E6 saw managed GC pauses overlap 13% of renders, so report the overlap fraction.
  - **Licensing guards inside the renderer:**
    - refuse any key that is not one-shot;
    - refuse to cache or serve a take whose metered energy sits on the music or ambience bus;
    - cap takes at 10 s with a fade (the census maximum was 3.7 s);
    - keep bus volumes at unity.
- **Tests**
  - **New `tests/CouchCoop.Audio.NativeTests`.** It is a custom `Exe` runner in its own process, so a native
    fault cannot take down the main runner.
    - It loads the install's FMOD libraries and the pck outside the game, using `game.assembliesDir` from
      `sts2.local.yaml`. If that is missing, it fails with a clear setup message.
    - It renders the top 30 census keys and asserts:
      - each take is non-silent and within the length cap;
      - each is tagged with the sfx bus;
      - the first block arrives in ≤ 1 / 3 ms (p50 / p95);
      - the render thread allocates nothing;
      - the system releases with return code 0.
    - It runs a lane-split equivalence check: on a replayed E8 timeline, the sum of the bus captures must
      match the master with a residual of ≤ −60 dB.
  - **`tests/CouchCoop.Mod.Tests -- audio`:** pck parsing against a synthetic fixture (no game data
    committed), key validation, and the version gate against a fake backend.
- **Acceptance**
  - The NativeTests pass.
  - With banks loaded through callbacks, the process stays at ≤ 60 MB RSS.
  - No bank bytes are written to disk.

### WP2 — host take service, render lane, dormancy (needs WP0, and WP1's interface)
- **`Audio/AudioService.cs`**
  - Keeps subscriber accounting and starts and stops the renderers.
  - Calls `ZeroClientGuard.Enter` on each start.
- **`Audio/Takes/TakeCache.cs`**
  - A memory LRU, 64 MiB by default.
  - A disk store under `user://couch-coop/cache/<version>/audio/<schema>/<bankset>/`, with writes going
    through `ManagedCacheQuota`.
  - It holds SFX takes only.
- **`Audio/Delivery/DeadlineSender.cs`**
  - A per-client queue ordered by due time.
  - It sends a block no earlier than 100 ms before it is due, and holds at most 2 s of queued data per
    client, dropping the oldest lane blocks first.
  - Its wait is armed only while something is queued.
- **`Server/AudioRenderLaneConnection.cs`** (hot-reloadable)
  - Handles the `/audio` upgrade, with the same Origin check as `/ws`.
  - Accepts inbound text ≤ 1 KiB, at 64 messages/s with a burst of 128.
  - Clock samples ride on the requests, plus a burst of 8 at connect. There is no ping timer.
- **`Server/AudioHttpRoutes.cs`**: the take route and the `/audio/takes` index.
- **Files to modify**
  - **`CouchCoopBrowserServer.cs`:** route the new `/audio` paths. On a seat process, also send
    `/ws?…&lane=audio` to WP3's connection.
  - **`HttpResponseWriter.cs`:** add `WriteAudioAsync`, serving `audio/wav` with
    `public, max-age=2592000, immutable`.
  - **`Runtime/ZeroClientGuard.cs`:** add three entries: `audio.take-renderer.start`,
    `audio.stream-renderer.start` and `audio.lane.subscribe`.
- **Tests (`-- audio`, `-- zero-client`)**
  - Route headers and refusals: bad keyId, wrong bank set, music-bus take, oversize input, binary inbound,
    rate limit.
  - `DeadlineSenderTests`, covering E6's burst scenario.
  - `TakeCacheTests`: the LRU bound, quota fallback, and stamp purge.
  - Rogue-driver tests for the new guard entries. Going 0 → 1 → 0 clients must end with no render threads, no
    FMOD systems, and `Timer.ActiveCount` back at its baseline.
- **Acceptance**
  - Going from 1 client to 0 releases every system with return code 0, and RSS returns to within ±20 MB.
  - No `[idle-work]` lines appear.
  - Two clients requesting the same cold key produce one render.

### WP3 — seat reporters and seat lane (parallel with WP1/WP2)
- **`Audio/Seat/SeatAudioFeed.cs`**
  - The subscriber registry.
  - The last known volumes: FMOD master, sfx, bgm and ambience as raw 0–1 values, plus the Godot Master and
    SFX dB.
  - A bounded queue of 256 events that drops anything older than 250 ms.
- **`Patches/SeatAudioReportPatch.cs`** (seat only)
  - A postfix on `NDebugAudioManager.Play` that reads back the pitch the game drew.
  - Postfixes on the debug-bus setters.
  - A prefix/finalizer bracket on the background-mute path. An unfocused headless seat's mute tween must not
    be mistaken for a settings change.
- **`Server/SeatAudioLaneConnection.cs`**: sends a snapshot on open, then pushes changes.
- **`HeadlessAudioMutePatch.cs`**: the skip prefixes call `SeatAudioFeed.Report(__originalMethod, __args)`.
  The call returns at once when there is no subscriber.
- **`CouchCoopMod.cs`**: apply the patch on seats unless `COUCHCOOP_AUDIO=off`.
- **Unknown volumes**
  - If no setter has been seen yet, read the settings save once when the lane opens.
  - That is a typed, on-demand read, not a poll.
- **Tests**
  - `SeatAudioFeedTests`: no allocation without a subscriber, the gating matrix, stale-event drop, and
    snapshot-first ordering.
  - Extend `HeadlessAudioMuteTargetsTests`.
  - Run `-- beta-targets` and `code verify-references` for the new targets.
- **Acceptance**
  - Publishing an event costs ≤ 0.02 / 0.05 ms (p50 / p95).
  - Live, from play call to the event arriving at the phone: ≤ 4 / 8 ms.

### WP4 — TmpSfx mp3 route (parallel)
- **What it serves.** `/audio/tmpsfx/{path}`, validated through `BrowserResourcePath`.
  - Only `res://debug_audio/*.mp3` is accepted, and only when it loads as an `AudioStreamMP3`.
  - The response is that resource's `.Data`, served as `audio/mpeg`, ≤ 2 MiB and immutable, with a bounded
    memo.
- **spirectl's `/res` is left untouched**, because there is no second consumer.
- **Tests:** refusals for traversal, non-mp3 paths, the wrong resource type and the size cap; response headers.
- **Acceptance:** every census TmpSfx key returns 200.

### WP5 — host music, ambience and loops lanes (hook half can start with Round 2; the renderer half needs WP1)
- **Hook route.**
  - Hook the GodotSharp marshalling helper that `GodotObject.Call(StringName, Variant[])` calls.
    `GodotObject.Call` itself is inlined (E8). Resolve the helper by scanning `GodotObject.Call`'s IL with
    `PatchProcessor.GetOriginalInstructions`. Never hard-code the index-suffixed name.
  - Filter calls by the two proxy instance pointers. Those are captured by postfixes on
    `NAudioManager._EnterTree` and `NRunMusicController._Ready`, using the `Proxy` child name
    `FmodSingletonStub` already uses.
  - **Why not hook the controllers in C#:** that would mean reconstructing the controller logic in committed
    code, and the no-game-code rule forbids it.
- **Self-check.**
  - A one-time call on a mod-owned Godot node verifies that the resolved native-call hook fires. Silence
    during one music refresh is inconclusive, so it does not disable the lanes.
  - If the probe fails, the music, ambience and loops lanes switch off for the session with one log line.
    SFX keeps working.
- **Files to add**
  - **`Audio/Host/HostAudioHooks.cs`.** The hook allocates nothing for calls that don't match; matching calls
    are rare (about 20 per session).
  - **`Audio/Host/HostMusicState.cs`.** The O(1) join memo.
  - **`Audio/Render/StreamRenderer.cs`.** One NRT system with a capture DSP per bus ChannelGroup.
    - Its pacing is the real-time media clock from §2: one 512-frame block per 10.667 ms, with an 11 ms lead.
    - All-zero blocks are flagged silent and not sent.
  - **`Audio/Render/ProxyOpTable.cs`.** A minimal op vocabulary in FMOD terms: start, stop, param, global,
    label and load-bank. Committed comments say only what each op does on the renderer. Behavioural notes
    stay in the research note.
- **Approximate join.** When the stream renderer starts, it loads the memo's act banks, starts the current
  music and ambience, applies globals and parameters, and starts the active loops. Later subscribers join at
  the next block.
- **Tests**
  - `HostMusicStateTests`.
  - `IcallResolverTests`, run against `GodotSharp.dll` from `assembliesDir`.
  - `StreamLaneSubscriptionTests`.
  - NativeTests: replaying an E8 timeline must give a music-lane normalised cross-correlation of ≥ 0.99 in
    ≥ 95% of windows.
- **Acceptance**
  - From a host call to the op being applied: ≤ 5 ms p50.
  - From the tap to the first music block being audible: ≤ 0.5 s, regardless of session length.
  - With one lane subscriber, the host uses no more than 4 points of one core extra.

### WP6 — frontend audio engine (parallel from WP0, against fakes)
- **New files in `frontend/src/audio/`**
  - `audioUnlock.ts`: the prelude, then `AudioContext({latencyHint: "interactive"})`. It uses the
    injected-environment pattern from `pwa/wakeLock.ts`.
  - `keepAlive.ts`: the keep-alive runs only while the voice count is 0 and every lane is silent.
  - `fastTrackProbe.ts`:
    - If the `getOutputTimestamp` lead exceeds 60 ms, re-run the prelude and recreate the context at the next
      gesture.
    - Exposes `window.__couchCoopAudioDiag` under `?audioDiag=1`.
  - `seatAudioLane.ts` and `renderLane.ts`.
  - `takeStore.ts`:
    - warms from `/audio/takes`;
    - assembles first-sight streams into the map;
    - fills the HTTP cache with deferred, sequential fetches.
  - `streamVoice.ts`.
  - `laneJitterBuffer.ts`:
    - targets 60 ms;
    - discards the backlog with a 5 ms crossfade after a late block;
    - re-anchors when drift exceeds ±15 ms.
  - `audioGains.ts`: a pure gating matrix plus the gain functions.
  - `voiceCap.ts`: at most 4 concurrent voices per key, stealing the oldest with a 10 ms fade. This addresses
    E6's reshuffle thickening.
  - `audioEngine.ts`, which owns the lifecycle:
    - lanes are open only while the toggle is on, the context is running and the document is visible;
    - hiding the page closes the lanes and suspends the context;
    - lanes reconnect on a seat-route change;
    - SFX events older than 250 ms are dropped.
- **Files to modify**
  - `mirror/mirrorSettings.ts`: add `audio`, default false, persisted at layer 3, with no URL override.
  - `settingsStorage.ts`: its validator.
  - `SettingsPanel.vue`: the toggle row, help text, an "unavailable on this host" state, and the FMOD credit
    line.
  - `MirrorApp.vue`: engine lifecycle. When the toggle was restored as on, a non-consuming capture-phase
    `pointerdown` unlocks audio on the first tap.
  - `mirrorClient.ts`: URL builders for the new routes.
  - i18n strings.
- **iOS and Safari.** These are unverified, so degrade gracefully:
  - detect `AudioContext` or `webkitAudioContext`;
  - if the context stays suspended after the gesture, show "audio not supported in this browser";
  - use WAV and MP3 only.
- **Tests (vitest)**
  - the gating matrix;
  - the jitter buffer against E8's stall trace: it must recover to the target within 2 blocks;
  - the keep-alive state machine;
  - the unlock order;
  - reconnect on seat switch;
  - the voice cap;
  - settings persistence.

### WP7 — integration, docs, live verification (last)
- **Merge order:** WP0 → (WP1, WP3, WP4, WP6) → WP2 → WP5 → WP7.
- **Live legs**
  - Use a private farm install only, with the `couch-deploy` and `couch-live-lock` skills.
  - Run the host plus 2 seats in a private network namespace, with headless gamescope on the RTX 2060
    (`--headless` for legs that don't render).
  - Keep the farm seed's host master volume at 0.
  - Check `pactl`: the renderer must open no sink input.

## 4. Rounds
- **Round 1:** WP0.
- **Round 2:** WP1, WP3, WP4 and WP6 in parallel `couch-worktree`s, with `scripts/install-agent-config.sh` run
  in each. WP5's hook half (resolver, memo, self-check) can start here too.
- **Round 3:** WP2, plus WP5's renderer half.
- **Round 4:** WP7. The coordinator runs the full suites once, at merge.

## 5. Risks
- **The icall route breaks on a Godot update.** IL resolution, the live self-check and beta-targets cover it.
  If it fails, only the music, ambience and loops lanes switch off.
- **The op table could read as reconstructed game logic.** Keep it minimal, in FMOD terms, with no narrative
  comments, and flag it for review.
- **FMOD version drift, or new FMOD terms after the Bose acquisition (2026-10-01).**
  - The version is negotiated, and the feature fails closed on the first error.
  - Before release, re-diff the FMOD licence against the copy archived in the research notes.
- **GC pauses.**
  - Keep the render thread allocation-free and report how often pauses overlap a render.
  - A native DSP shim comes later.
- **Memory.** Bank loading through callbacks and the bounded LRU keep it down. Acceptance is ≤ +150 MB RSS with
  audio on.
- **The fast output track varies by device.** Keep-alive gating and `fastTrackProbe` cover it. The G86 and
  iPhone are unmeasured.
- **The background-mute tween on unfocused seats.** WP3's bracket handles it, and the live leg checks that
  the reported volumes equal the seat's settings.
- **Third-party audio mods.** Their own sounds are not reported, which is documented as out of scope. There
  is no crash path, because the FMOD doorway stub is unchanged.
- **Bandwidth.** ~1.5 Mbit/s per active PCM lane. Silent blocks are not sent, and lanes are gated by the
  seat's volumes.
- **WebSocket admission.** Each audio viewer uses 3 host WebSockets; 4 players × 3 = 12, under the floor of
  32.

## 6. Out of scope / later
- Opus or AAC encoding.
- iPhone and Safari verification, and measurements on the G86.
- Pools of takes per key (rejected by the maintainer).
- Speculative first-sight rendering, where the seat asks the host directly. This would save ~4.6 ms and bring
  the first-sight p50 to about 39 ms.
- A native DSP shim.
- Exact music join, and sync with the TV.
- Audio for host-view (`directView`) viewers.
- Sounds from modded audio.
- Cross-event ducking, and per-event instance limits.
- A "clear cached audio" control.
- Measuring the keep-alive's battery cost.
- AudioWorklet on the TLS origin.

## 7. Docs to update
- **`docs/security.md`.** Add limits-table rows for:
  - audio-lane inbound messages;
  - the seat lane;
  - the outbound queue;
  - the take constraints;
  - the take caches;
  - the TmpSfx route.
  
  Also state that no `.bank` data is ever served, that music and ambience are never stored, and that the
  renderer opens no output device.
- **`architecture-map.md`.** A new "Seat audio" section covering the components, lane URLs, dormancy owners,
  the hook route and its self-check, the gating matrix and the tests. Also update the `/audio*` lines in
  "Browser contracts".
- **`docs/configuration.md`.** Document `COUCHCOOP_AUDIO=off`, `COUCHCOOP_AUDIO_RENDER_WORKERS` (1–2), the
  cache layout, and the URL grammar.
- **`qa-recipes.md`.** Add the live audio leg.
- **README.** Add the FMOD credit line.
- **The final `feat` commit** gets this changelog trailer: "Players can turn on game audio in the mirror
  settings; it follows their own in-game volume settings."

## 8. Verification

| WP | Suites |
| --- | --- |
| WP0 | `dotnet run --project tests/CouchCoop.MirrorProtocol.Tests`; vitest |
| WP1 | `dotnet run --project tests/CouchCoop.Audio.NativeTests`; `dotnet run --project tests/CouchCoop.Mod.Tests -- audio` |
| WP2 | `-- audio`, `-- zero-client`, `-- host-guards` |
| WP3 | `-- audio`; `-- beta-targets` (also on the public-beta lane via `scripts/with-game-branch.sh`); `sts2 --json code verify-references` |
| WP4 | `-- audio` |
| WP5 | `-- audio`, `-- beta-targets`, NativeTests |
| WP6 | `cd frontend && npx vue-tsc --noEmit && npx vitest run` (never `npm run build` in a branch) |
| Merge | all full suites, with no regressions |

Live targets: Moto G31 over Wi-Fi, with the prelude and keep-alive. Use headless gamescope or `--headless` only;
never Xvfb and never a desktop window.

| Leg | Target |
| --- | --- |
| Cached sfx, play call → speaker | predicted p50 ≤ 40 / p95 ≤ 45 ms; acoustic p50 ≤ 50 ms |
| First-sight sfx | predicted p50 ≤ 50 / p95 ≤ 63 ms |
| TmpSfx (decoded) | p50 ≤ 40 / p95 ≤ 70 ms |
| Music lane, due → output | p50 ≤ 120 ms; back to ≤ 120 ms within 2 s of a stall |
| Fast output track | held for 10 minutes with silences of ≥ 15 s |
| Reload | 0 take requests reach the host |
| Zero clients | host CPU within noise (ABBA); guard green; going 1 → 0 releases every system |
| Renderer output | no renderer sink input; host game output unchanged |
| Faults | only the known pre-existing teardown signatures in the kernel log |

Every visual claim must list its screenshot path. Release every lease at the end.
