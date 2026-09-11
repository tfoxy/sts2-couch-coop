# The repro recorder — capture a mirror bug as a replayable file

**For the player:** turn one switch on, play until the bug happens, tap MARKER, tap SAVE, send us the file.

**For whoever gets the file:** `analyze-repro.mjs` says what the client sent and whether the game answered;
`replay-repro.mjs` puts the bug back on screen, on your machine, with no game and no phone.

## Why it exists

The mirror is a pure function of two inputs: the scene stream arriving over the websocket, and the viewer's own
pointer events. Both are timestamped on the same `performance.now()` origin. So a file carrying **both halves in
one ordered stream is deterministically replayable** — which is strictly better than a video, because a video
shows the symptom while this carries the cause.

---

## Recording (the player's half)

1. **Settings gear → "Repro recorder" → on.** A red **REC** pill appears at the top left. The setting is saved,
   so it survives reloads and reconnects — which matters, because a rare bug is found by playing, not by
   arranging to be recording at the right second.
2. **Play until the bug happens.** The recorder keeps a rolling window of roughly the **last 1–6 minutes** of
   combat in memory (32 MB). Nothing is uploaded, nothing is written to disk until you ask.
3. **Tap MARKER the moment you see it.** The pill flashes `marker 1 ✓`. Tap it again for a second occurrence —
   markers are numbered and the offline tools report each one separately. Marking *late* is fine (the tools look
   several seconds either side); marking is what makes the file usable at all.
4. **Tap SAVE.** The file downloads as `repro-<timestamp>.ndjson`. **Recording continues** — you can keep
   playing and save again.
5. Send us the file (or, on a phone, see the `adb` line below).

Two numbers on the pill: elapsed time, and how full the buffer is. Once it reads `100% ↺` the recorder is
dropping its oldest frames — normal, and exactly what a flight recorder does, but it means the file will start
mid-session. The header records how much was dropped, so nobody mistakes that for "the client did nothing".

### Getting the file off a phone

The download lands in the phone's Downloads folder. With the phone plugged in:

```bash
adb shell 'ls -t /sdcard/Download/repro-*.ndjson | head -1' | tr -d '\r' \
  | xargs -I{} adb pull {} .sts2/repro/
```

`.sts2/` is gitignored, so a recording dropped there can never be committed by accident. **Do not commit
recordings** — they are captured game payloads (see the Artifact Policy in `CLAUDE.md`).

### Desktop / console

Everything the pill does is also a function on `window`, so a devtools session needs no UI:

```js
__mirrorRepro.start();            // arm (the settings toggle does this)
__mirrorRepro.marker("card jumped");  // an optional note rides into the file
__mirrorRepro.save();             // → { name, bytes, lines }
__mirrorRepro.stats();            // { recording, lines, bytes, fill, droppedLines, markers, … }
__mirrorRepro.stop();
```

### URL levers

| Param | Effect |
| --- | --- |
| `?repro=on` | arm for this session, whatever the saved setting says (and **even in a build that removed the switch** — see below) |
| `?repro=off` | disarm for this session; the saved setting is untouched |
| `?reproBufMb=64` | resize the ring for this session only (default 32; never persisted) |

---

## What is in the file

NDJSON, `format: "repro/1"`, written by `frontend/src/mirror/reproRecorder.ts`.

```
{"meta":{"format":"repro/1","recordedAt":…,"url":…,"ua":…,"moduleBundle":…,"viewport":{…},"dpr":…,
         "settings":{…},"designWidth":1920,"stageRect":{…},
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

`t` is milliseconds since **the first line in the file** (3 decimals) — not since the recorder was armed, because
after a drop the armed instant is no longer in the file. Pointer `t` comes from the event's own `timeStamp`, so
it is immune to dispatch jitter.

`moduleBundle` is the URL/path of the `MirrorApp` module this browser actually executed. Include it when reporting
a replay mismatch: it distinguishes a stale emitted bundle or another worktree's dev server from a behaviour change
in the checkout used to replay the file.

**A repro file is also a valid passive recording.** Its `dir:"in"` lines are exactly what
`scripts/record-mirror-stream.mjs` writes, and every existing reader drops the rest, so you can feed one straight
to `scripts/replay-ws-server.mjs`, `scripts/bench-mirror-replay.mjs` or `frontend/bench/mirrorReplay.bench.ts`
with no conversion.

---

## Analysing it (no browser)

```bash
node scripts/analyze-repro.mjs .sts2/repro/repro-2026-08-27T09-12-00-000Z.ndjson
node scripts/analyze-repro.mjs <file> --window 8        # ±8s around each marker (default 5)
node scripts/analyze-repro.mjs <file> --marker 2        # one marker
node scripts/analyze-repro.mjs <file> --json out.json   # the same content, structurally
node scripts/analyze-repro.mjs --self-test              # synthetic recording + assertions
```

Per marker it prints three things, meant to be read against each other:

* **pointer** — the raw gesture, with move runs coalesced (`move x14 (1210,880) → (1290,905) over 233ms`), timed
  relative to the marker so "what was I doing just before I tapped" is the first thing you see.
* **sent** — every envelope this client sent, correlated with its reply by `requestId`, or — for an `input`,
  which is never answered by an id — with the frame that followed it. **A send the wire produced nothing after is
  flagged `⚠ UNANSWERED`.**
* **hand** — per `NHandCardHolder`: translation-Y and z-index over time, the fan's order and membership, which
  holder is on top (the mirror expresses card focus as a z-lift, so that *is* the focus timeline), and the
  declarative tween endpoints that armed each motion.

The scene tree is the mirror's own (`frontend/src/mirror/sceneTree.ts`, loaded through
`scripts/lib/mirror-probe.mjs`), so it cannot drift from what the browser built. It also reads the existing
`.sts2/bench/*.ndjson` passive recordings — minus the input half, which they never had.

---

## Replaying it (a real browser, no game)

```bash
# in one terminal: a dev server serving THE CHECKOUT YOU ARE DEBUGGING
cd frontend && npx vite --port 5211 --strictPort

# in another
node scripts/replay-repro.mjs .sts2/repro/foo.ndjson --url http://127.0.0.1:5211/ \
     --around-markers 1000,1000,100 --speed 0.5
```

It replaces `window.WebSocket` before any page script, feeds the recorded inbound frames at their recorded
offsets, and dispatches the recorded gestures over CDP **on the same clock**. It never builds and never launches
a game. The page is loaded with `repro=off` appended so a replay cannot recursively record itself.

| Flag | Effect |
| --- | --- |
| `--around-markers [pre,post,step]` | screenshots + per-holder computed transform/z-index into `.sts2/artifacts/repro/<stem>/marker-<n>/` (`samples.ndjson` alongside). Default `1000,1000,100`. |
| `--freeze <ms>` | pump the timeline to `<ms>` and stop; pair with `--keep` and `--headed` to poke around in devtools |
| `--speed <f>` | scale the one shared timeline. **Use `--speed 0.5` or lower with `--around-markers`** — see the lag note below |
| `--marker <n>`, `--out <dir>`, `--headed`, `--keep` | as they read |

At the end it prints a **divergence report**: what the recorded client sent versus what the replayed client sent,
matched per envelope shape (`input/hover`, `input/click left`, …) nearest-in-time. `NOT RE-SENT` means this
checkout did not produce a send the recording has — which is the first residual bug's exact question.

### What is and is not deterministic

Read this before believing a *negative* result.

* **Same checkout.** The file carries the wire and the gestures, not the client. Replaying yesterday's recording
  against today's build is a comparison, not a reproduction.
* **Canned responses.** Client sends are swallowed; nothing answers them. A flow that waits on an answer is
  satisfied only because the *recorded* answer arrives at its own recorded offset. So a replay whose client sends
  something the recording did not drifts from that point on — which is what the divergence report is for.
* **±1 frame.** rAF phase, layout and process scheduling all wobble by about a frame. The bugs being chased are
  tens of frames wide.
* **Scheduler lag.** Screenshots are serial with input dispatch, so capture can push gestures late against the
  stream. Captures YIELD — a still that is already past the next capture point is skipped rather than delaying
  the gestures behind it — so the artifact set degrades before the reproduction does. The run reports
  `input lag max` (the number that can invalidate a result; warns above 100ms), `capture lag max`, and how many
  stills were skipped. The fix for either is a smaller `--speed`, which stretches wall-clock time without
  changing the recorded timeline.
* **Pointer ids are the browser's.** CDP assigns its own; what is preserved is the identity mapping (one recorded
  finger = one CDP touch point), not the recorded number.
* **`?stage=canvas` draws no per-node DOM**, so the pose samples are empty there. Screenshots still work. The
  shipping default is the DOM stage, which is what a player's recording will have used.

---

## Removing it from a published build

A developer tool in an end user's settings panel is a support question waiting to happen, and an end user who
turns it on pays memory for a file they will never send anyone. So the UI is behind a **build-time** flag:

```bash
VITE_REPRO_UI=off npm run build     # (NB: `npm run build` DEPLOYS — see the frontend README)
```

With that set:

* the settings row and the REC pill are compiled out (the flag is a module constant in
  `frontend/src/mirror/buildFlags.ts`, so the branches fold away);
* a **stale saved `reproRecorder: true` is ignored** at layering time — a viewer with no switch to find must not
  be left recording by a value they set on a previous build;
* `?repro=on` **still arms it**, and the badge renders on that path so there is a SAVE button to press. That is
  deliberate: it is the support escape hatch (walk a player through appending one query param, get a recording,
  no rebuild) and it cannot happen by accident.

Anything other than the literal string `off` (case-insensitive) leaves the tool in — a build script that writes
`VITE_REPRO_UI=0` has made a mistake, and the safe direction for a mistake is "the diagnostic is present".

---

## Where the pieces live

| Path | What |
| --- | --- |
| `frontend/src/mirror/reproRecorder.ts` | the recorder: ring buffer, taps, serialization, save |
| `frontend/src/mirror/buildFlags.ts` | `VITE_REPRO_UI` |
| `frontend/src/mirror/ReproBadge.vue` | the REC pill (browser-space, outside the stage, so its own taps are never recorded) |
| `frontend/src/mirror/mirrorClient.ts` | the wire taps (the socket instance's `send` is wrapped; incoming is tapped above the JSON.parse and above the watch gate) |
| `frontend/src/mirror/MirrorView.vue` | the stage tap (capture-phase, passive, ahead of `inputCapture`) |
| `frontend/src/mirror/MirrorApp.vue` | arming, the meta snapshot, `window.__mirrorRepro` |
| `scripts/analyze-repro.mjs` | the offline report (`--self-test`) |
| `scripts/replay-repro.mjs` | the browser replay |
