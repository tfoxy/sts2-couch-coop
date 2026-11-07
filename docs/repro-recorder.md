# The repro recorder — capture a mirror bug as a replayable file

**For the player:** turn one switch on, play until the bug happens, tap MARKER, tap SAVE, send the file.

**For whoever gets the file:** `scripts/analyze-repro.mjs` says what the client sent and whether the game answered;
`scripts/replay-repro.mjs` puts the bug back on screen, on a developer's machine, with no game and no phone.

The mirror is a function of two inputs: the scene stream arriving over the websocket, and the viewer's own pointer
events. Both are timestamped on the same `performance.now()` origin, so a file carrying both halves in one ordered
stream can be replayed deterministically — which is more useful than a video, because a video shows the symptom
while this carries the cause.

## Recording

1. **Settings gear → "Repro recorder" → on.** A red **REC** pill appears at the top left. The setting is saved, so
   it survives reloads and reconnects — a rare bug is found by playing, not by arranging to be recording at the
   right second.
2. **Play until the bug happens.** The recorder keeps a rolling window of roughly the **last 1–6 minutes** of combat
   in memory (32 MB). Nothing is uploaded and nothing is written to disk until you ask.
3. **Tap MARKER the moment you see it.** The pill flashes `marker 1 ✓`. Tap it again for a second occurrence —
   markers are numbered and the tools report each one separately. Marking *late* is fine (the tools look several
   seconds either side); marking is what makes the file usable at all.
4. **Tap SAVE.** The file downloads as `repro-<timestamp>.ndjson`. **Recording continues** — you can keep playing
   and save again.
5. Attach the file to your report (see [reporting a problem](workshop/reporting-a-problem.md)).

The pill shows two numbers: elapsed time, and how full the buffer is. Once it reads `100% ↺` the recorder is dropping
its oldest frames — normal for a flight recorder, but the file will start mid-session. The file's header records how
much was dropped.

**A recording contains what the game sent to your browser during that window** (the scene, including player names)
and your own taps and key presses on the game page. Treat it like a screenshot of your game.

### Getting the file off an Android phone

The download lands in the phone's Downloads folder. With the phone plugged in and USB debugging on:

```bash
adb shell 'ls -t /sdcard/Download/repro-*.ndjson | head -1' | tr -d '\r' \
  | xargs -I{} adb pull {} .sts2/repro/
```

`.sts2/` is gitignored. **Do not commit recordings** — they are captured game payloads (see the Artifact Policy in
`AGENTS.md`).

### Desktop / devtools

Everything the pill does is also a function on `window`:

```js
__mirrorRepro.start();               // arm (the settings toggle does this)
__mirrorRepro.marker("card jumped"); // an optional note rides into the file
__mirrorRepro.save();                // → { name, bytes, lines }
__mirrorRepro.serialize();           // → the same ndjson as a string, no download (for automation)
__mirrorRepro.stats();               // { recording, lines, bytes, fill, droppedLines, markers, … }
__mirrorRepro.stop();
```

A headless harness (Playwright, CDP) takes the file with
`await page.evaluate(() => window.__mirrorRepro.serialize())`. Recording continues after either call.

### URL switches

| Param | Effect |
| --- | --- |
| `?repro=on` | arm for this session, whatever the saved setting says (and even in a build that removed the switch — see below) |
| `?repro=off` | disarm for this session; the saved setting is untouched |
| `?reproBufMb=64` | resize the ring for this session only (default 32; never persisted) |

## What is in the file

NDJSON, `format: "repro/1"`, written by `frontend/src/mirror/reproRecorder.ts`:

```
{"meta":{"format":"repro/1","recordedAt":…,"url":…,"ua":…,"moduleBundle":…,"viewport":{…},"dpr":…,
         "settings":{…},"settingsAtArm":{…},"designWidth":1920,"stageRect":{…},
         "bufCapBytes":…,"droppedLines":…,"droppedBytes":…,"markers":[…],"lines":…,"durationMs":…}}
{"t":0,"dir":"in","data":"<raw frame from the host, verbatim>"}
{"t":12.5,"dir":"out","data":"<raw frame this client sent>"}
{"t":16.3,"kind":"pointer","type":"down","x":1204,"y":900.5,"id":1,"pt":"touch","button":0,"buttons":1,"primary":true}
{"t":…,"kind":"wheel","x":…,"y":…,"dx":…,"dy":…,"mode":0}
{"t":…,"kind":"key","code":"KeyE","alt":false,"ctrl":false,"meta":false,"shift":false}
{"t":…,"kind":"marker","n":1,"note":"card jumped"}
{"t":…,"kind":"ws","ev":"open"}
{"t":…,"kind":"resize","w":…,"h":…,"dpr":…}
```

- `t` is milliseconds since **the first line in the file** (3 decimals), not since the recorder was armed, because
  after a drop the armed instant is no longer in the file. Pointer `t` comes from the event's own `timeStamp`.
- Wire and lifecycle lines carry `sock: "host"|"seat"`, naming the connection they came from.
- `settingsAtArm` is the settings snapshot taken when the recorder armed; `settings` is the save-time one.
- `moduleBundle` is the `MirrorApp` module this browser actually executed. Include it when reporting a replay
  mismatch: it tells a stale bundle or another dev server apart from a behaviour change.

**A repro file is also a valid passive recording.** Its `dir:"in"` lines are exactly what
`scripts/record-mirror-stream.mjs` writes, and every reader drops the rest (`dir:"out"` lines and input events), so a
repro file can be fed straight to `scripts/replay-ws-server.mjs`. `frontend/src/mirror/__tests__/reproReaderGuards.spec.ts`
keeps that rule for every reader.

## Analysing a file (no browser)

```bash
node scripts/analyze-repro.mjs .sts2/repro/repro-<timestamp>.ndjson
node scripts/analyze-repro.mjs <file> --window 8        # ±8 s around each marker (default 5)
node scripts/analyze-repro.mjs <file> --marker 2        # one marker
node scripts/analyze-repro.mjs <file> --json out.json   # the same content, structurally
node scripts/analyze-repro.mjs --self-test              # synthetic recording + assertions
```

Per marker it prints the raw gesture (move runs coalesced), every envelope the client sent correlated with its reply
— **a send the wire produced nothing after is flagged `⚠ UNANSWERED`** — and the hand's per-card pose and focus over
time. The scene tree is the mirror's own (`frontend/src/mirror/sceneTree.ts`, loaded through
`scripts/lib/mirror-probe.mjs`), so it cannot drift from what the browser built.

## Replaying a file (a real browser, no game)

```bash
# one terminal: a dev server serving THE CHECKOUT YOU ARE DEBUGGING
cd frontend && npx vite --port 5211 --strictPort

# another
node scripts/replay-repro.mjs .sts2/repro/foo.ndjson --url http://127.0.0.1:5211/ \
     --around-markers 1000,1000,100 --speed 0.5
```

**Never `npm run build`** to serve a replay — its `outDir` is the installed mod's `frontend/` directory, so building
overwrites the live install. `npx vite` (dev mode) is enough.

The replay replaces `window.WebSocket` before any page script, feeds the recorded inbound frames at their recorded
offsets, and dispatches the recorded gestures over CDP on the same clock. It never builds and never launches a game,
and it appends `repro=off` so a replay cannot record itself. It applies the recording's own settings before
navigating (printed as `applied recording settings: …`); an explicit `--url` query wins. A recording armed
mid-session has no session envelope, so one is synthesized (`scripts/lib/replay-session.mjs`).

For real card art and spines, serve `/res` from a recovered project with `scripts/serve-res-root.mjs` and point the
dev server's proxy at it with `COUCHCOOP_DEV_PROXY_TARGET` (see `node scripts/serve-res-root.mjs --help`).

| Flag | Effect |
| --- | --- |
| `--around-markers [pre,post,step]` | screenshots + per-card computed transform/z-index into `.sts2/artifacts/repro/<stem>/marker-<n>/`. Default `1000,1000,100`. Use with `--speed 0.5` or lower |
| `--freeze <ms>` | pump the timeline to `<ms>` and stop; pair with `--keep` and `--headed` to inspect in devtools |
| `--speed <f>` | scale the one shared timeline |
| `--marker <n>`, `--out <dir>`, `--headed`, `--keep` | as they read |
| `--gpu <backend>` | real GPU via Chromium's `--use-angle=<backend>` (e.g. `vulkan`); without it headless Chromium renders in software |
| `--diag-out <file>`, `--window <a>:<b>` | dump renderer diagnostics plus CDP task/script time deltas (ms), optionally narrowed to a span of the recording clock |
| `--as-seat` | join as a seat (a second, redirected socket, the shape a real joined player has) instead of watching as a spectator. Only a seat's touches send real `input` envelopes |
| `--pre-tap <x>,<y>` | one synthetic tap before the recorded clock starts, for client-local UI state the recording cannot carry |

At the end it prints a **divergence report**: what the recorded client sent versus what the replayed client sent,
matched per envelope shape. `NOT RE-SENT` means this checkout did not produce a send the recording has.

Read a *negative* result carefully:

- **Same checkout.** The file carries the wire and the gestures, not the client: replaying an old recording against a
  new build is a comparison, not a reproduction.
- **Canned responses.** Client sends are swallowed; a flow that waits on an answer is satisfied only because the
  recorded answer arrives at its recorded offset.
- **About one frame of jitter.** rAF phase, layout and scheduling wobble by a frame.
- **Hover cadence is not 1:1.** Hovers are coalesced to one send per rendered frame, so a replay at a different frame
  rate sends a different number of them for the same touch stream; diff `input` envelopes, not hovers.
- **Client-local UI state is not on the wire.** Whether the settings panel was open is never recorded; if the first
  touch toggles it, a fresh replay can end up in the opposite state and later touches land on the panel. The replay
  warns when touches land outside `.mirror-stage`; `--pre-tap` fixes it for files without `settingsAtArm`.
- **`?stage=canvas` draws no per-node DOM**, so pose samples are empty there; screenshots still work.

## Removing it from a published build

A developer tool in an end user's settings panel invites support questions, so the UI is behind a **build-time**
flag:

```bash
VITE_REPRO_UI=off npm run build     # NB: `npm run build` DEPLOYS to the installed mod
```

With that set the settings row and the REC pill are compiled out (`frontend/src/mirror/buildFlags.ts`), a stale saved
`reproRecorder: true` is ignored, and `?repro=on` **still arms it** — the support escape hatch: walk a player through
appending one query parameter, get a recording, no rebuild. Anything other than the literal `off`
(case-insensitive) leaves the tool in.

## Where the pieces live

| Path | What |
| --- | --- |
| `frontend/src/mirror/reproRecorder.ts` | the recorder: ring buffer, taps, serialization, save |
| `frontend/src/mirror/buildFlags.ts` | `VITE_REPRO_UI` |
| `frontend/src/mirror/ReproBadge.vue` | the REC pill (outside the stage, so its own taps are never recorded) |
| `frontend/src/mirror/mirrorClient.ts` | the wire taps |
| `frontend/src/mirror/MirrorView.vue` | the stage tap (capture-phase, passive, ahead of `inputCapture`) |
| `frontend/src/mirror/MirrorApp.vue` | arming, the meta snapshot, `window.__mirrorRepro` |
| `scripts/analyze-repro.mjs` | the offline report (`--self-test`) |
| `scripts/replay-repro.mjs` | the browser replay |
| `scripts/lib/repro-replay.mjs` | the replay's browser-free logic, tested by `scripts/test-replay-repro-session.mjs` and `scripts/test-replay-repro-seat.mjs` |
| `scripts/lib/replay-session.mjs` | `replaySession`: a complete, valid session envelope for a recording that has none |
