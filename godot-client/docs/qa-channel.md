# QA control channel

A debug-only, **localhost-only** line-oriented TCP control channel for the native Godot client. It lets device /
desktop QA drive the client with structured verbs — input, settings, connect, state — instead of blind `adb` taps +
screencap loops. Commands run through the **same** `DemoInputPlayer` interpreter as the `--demo-input <script>` file
player, so the grammar is identical from either source.

## Security posture

- **Default OFF.** With no `--qa-port` and no `[qa]` key, the `QaServer` node is never mounted: zero listeners, zero
  threads, zero cost.
- **Localhost only.** The listener binds `127.0.0.1` (`IPAddress.Loopback`) exclusively — never `0.0.0.0`. Nothing off
  the device can reach it. On Android a QA host reaches it over USB with `adb forward`.
- **Debug tool, not a product feature.** Only mounted for interactive `--connect` / no-arg Connect-screen sessions
  (never for `--replay` single-shots).

## Enabling it

**Desktop** — pass the port on the command line:

```
Godot_v4.5.1-stable_mono_linux.x86_64 --path godot-client -- --qa-port 5599
```

**Android** — apps can't set process env, so enable it by pushing a `[qa]` section into the app's
`user://settings.cfg` **before** launching a session, then forward the port over USB:

```
# user://settings.cfg lives at /data/data/<pkg>/files/settings.cfg (also holds the [mirror] client settings)
adb shell "run-as <pkg> sh -c 'printf \"\n[qa]\nport=5599\n\" >> files/settings.cfg'"
adb forward tcp:5599 tcp:5599        # localhost:5599 on your workstation → 127.0.0.1:5599 on the device
```

The CLI `--qa-port` wins if both are present. Port must be `1..65535`; anything else is treated as OFF.

## Protocol

- One command per line; **one response line per command**: `ok [payload]` or `err <reason>`.
- Blank lines and `#` comments are ignored (no reply).
- `dump` / `dumpcards` / `state` return their payload as a single JSON line (`ok {json}`).
- `wait` and `shot` reply only after they complete (the wait elapses / the PNG is written).
- Exactly **one** client is served at a time; a second concurrent connection is rejected with `err busy`. Sequential
  connections are fine.

### Verbs

| Verb | Response |
| --- | --- |
| `touch down\|move\|up <id> <x> <y>` / `touch cancel <id>` | `ok touch …` |
| `mouse down\|up <left\|right\|middle> <x> <y>` / `mouse move <x> <y>` / `mouse wheel <up\|down> <x> <y>` | `ok mouse …` |
| `key <GodotKeyName> [ctrl,shift,alt,meta]` | `ok key <name>` |
| `wait <ms>` | `ok` (after the wait elapses) |
| `dump <x> <y>` | `ok {"x":…,"y":…,"targets":[{"id","kind","isCard"}…]}` (or `err not-connected`) |
| `dumptap <x> <y>` | `ok {"raw":{x,y},"remapped":{x,y},"moved":bool,"targets":[…],"hittable":[…]}` — the read-only twin of a real tap: applies `ViewScaler.InverseRemap` first, then reports the hit walk at the remapped point |
| `dumpcards` | `ok {"count":…,"cards":[{"id","visible","cx","cy","w","h"}…]}` (or `err not-connected`) |
| `dumptypes [filter]` | `ok {json}` — sorted distinct visible node-type leaves (optional substring filter) |
| `dumpcrisp` | `ok {json}` — per-card-root and per-text-candidate crisp reject, occlusion culprit, unsettled/failed texture URLs |
| `dumptips` | `ok {json}` — per visible NHoverTipSet: owner/visual-owner boxes, spread Dx chain, applied stamp |
| `dumpspread [name-substring]` | `ok {json}` — per matching node: scene/anchors/rect/origin and wide-screen spread record |
| `dumpalign [filter]` | `ok {json}` — per visible text node: box vs laid-out glyph advance box (design space), `dyCentre` (glyphCentreY − boxCentreY), and valign/text; `stats` = count/maxAbsDy/stdDy. `dyCentre` is a numeric placement proxy, not the pixel-true ink centre — see below |
| `shot <abs-path>` | `ok <path>` (after the PNG is written; `err savepng-<code>` on failure) |
| `renderscale <Full\|Half\|Quarter>` | `ok renderScale=…` |
| `setting <key> <value>` | see below |
| `connect <host[:port]>` | `ok connect <host>` (default port 13337; `err already-connected` / `err no-connect-screen`) |
| `disconnect` | `ok` (or `err not-connected`) |
| `reload` | `ok` (coordinator.Resync; `err not-connected`) |
| `state` | `ok {json}` (see below) |
| `hide <selector>` | `ok {"selector":"…","matches":N}` (see below) |
| `show <selector>` / `show all` | `ok` (`err not-hidden <sel>` when the selector is not active) |
| `hidelist` | `ok {"count":N,"selectors":[{"selector","matches"}…]}` |
| `backtomenu` | `ok` |
| `quit` | `ok`, then the app exits |

### Tap-verification convention (`dump` vs `dumptap`)

**A tap check MUST probe the VISUAL position of at least one OFF-PIVOT element — a centre point cannot discriminate.**
A view-scale stamp (card-reward group, shop / event items) scales its box about a pivot, so the pivot (and anything on
the pivot axis — a centred card, a centred Skip button's X) is a FIXED point of the scale: it renders where the game
draws it, and a tap there lands correctly even when the inverse remap is broken. A tap-placement defect slipped
past verification precisely because `dump`/`qa-click` probed true
positions, which are correct under identity. Use **`dumptap`** (which applies `ViewScaler.InverseRemap`, the real
router path) at the VISUAL centre of an off-pivot element — a left/right reward card, the Skip button's rendered Y —
and assert `moved:true` with the remapped point resolving to that element; then probe a TopBar deck/gold button and
assert `moved:false` (a legitimate overlay stays identity). `dump` bypasses the remap, so it is the wrong tool for a
tap check — use it only to inspect raw hit-eligibility at a known game coordinate.

`setting` whitelist (RAM-only — the QA channel deliberately does **not** persist to `settings.cfg`; it mutates the same
live values the Settings panel writes, so hosting / overlay react identically):

| key | values |
| --- | --- |
| `renderScale` | `Full` \| `Half` \| `Quarter` (alias of the `renderscale` verb) |
| `shader` (`shaderMode`) | `Dynamic` \| `Static` \| `Off` |
| `particle` (`particleMode`) | `Dynamic` \| `Static` \| `Off` |
| `spine` (`spineMode`) | `Auto` \| `Dynamic` \| `Static` \| `Off` (own enum — `Auto` = today's animated clip) |
| `crispText` | `on` \| `off` |

Anything else → `err unknown-setting <key>`; a bad value → `err bad-value <v> (…)`.

### `hide` / `show` / `hidelist` (GPU-experiment measurement tooling)

Force-hide parts of the mirror stage to attribute GPU cost. A hidden node **stays** hidden across drains — the
reconciler's `Visible` writes (Apply / ApplyLight / the cull pass) re-assert the hide against the live wire data, so
pooled/recycled views and nodes that appear on LATER drains comply too. Zero overhead when no selectors are active.
RAM-only session state (nothing persists); `show all` restores everything.

Selector grammar:

| selector | meaning |
| --- | --- |
| `type:<suffix>` | case-insensitive **suffix** match on the wire `NodeType` (`type:NCreature`, `type:Combat.NEnergyCounter`) — multi-match expected |
| `name:<host-name>` | case-insensitive **exact** match on the host scene node name (`name:NCombatSceneContainer`) — multi-match fine |
| `id:<wireId>` | exact wire id |
| `stage` | the SceneReconciler root — the whole-mirror kill |
| `bake` | the StaticBake root (the composite quads' parent): current **and** future quads blank; the bake pipeline + the baked originals' suppression stay untouched (the shipping bake-ON background genuinely disappears) |

`hide` replies with the count of wire nodes **currently** matching (0 is legal — matches may appear on later drains);
`hidelist` re-reports the live counts. Caveat: a node already frozen inside an ACTIVE bake quad keeps its baked pixels
until the next rebake — use `bake` (or `setting staticbake off`) to remove baked content.

### `dumpalign`

Per visible text node, reports the streamed `box` and the ACTUAL laid-out glyph advance box (`glyphRect`) in design
space plus `dyCentre = glyphCentreY − boxCentreY`. It is the numeric placement check for text centering
fix — runs on-device over `adb forward` with no screenshot. Optional case-insensitive `filter` (name/type/scene/relPath).

- `dyCentre ≈ 0` ⇒ the glyph advance box is centred on its box. An over-lift regression reads
  `dyCentre ≈ −8` (shipped) on the energy/pile counts; the fix reads `≈ +0.5..+1`.
- CAVEAT: `dyCentre` is the ADVANCE box, not the rendered INK, so it carries a small per-glyph natural offset even when
  perfect (≈+3.5px for the tight-box HP bar, whose advance box is bigger than its box). It catches Position/valign
  errors, NOT ink asymmetry. The pixel-true gate is `scripts/verify-text-align.sh`. A `--replay --shot` twin prints the
  same JSON as `M1C_TEXTALIGN: {json}` under `COUCHCOOP_MIRROR_TEXTALIGN_DUMP=1` (the QA socket does not mount in `--replay`).

`state` JSON fields (pulled from existing telemetry — nothing invasive is added):
`connected`, `status`, `revision`, `nodeCount`, `renderScale`, `hosting` (`direct`|`subviewport`), `stretchCollapse`,
`overlayPromoted`, `fps`, `drainMsMax`.

QA GPU-experiment fields: `drawCalls` / `primitives` / `renderObjects` (the engine's whole-frame
`RENDER_TOTAL_*_IN_FRAME` monitors), `frameMsP50` / `frameMsP95` (percentiles over an always-on 120-sample ring of
per-frame process delta ms; computed only when `state` is served), and `qaHidden` (the active forced-hide selector
count — 0 when the hide verbs are unused, so measurement scripts can sanity-check their config).

## Example session

```
$ nc 127.0.0.1 5599
state
ok {"connected":false,"status":"disconnected","revision":0,"nodeCount":0,"renderScale":"Full",...}
connect 127.0.0.1:13406
ok connect 127.0.0.1:13406
state
ok {"connected":true,"status":"connected","revision":42,"nodeCount":517,"renderScale":"Full","hosting":"direct",...}
setting renderScale Half
ok renderScale=Half
state
ok {...,"renderScale":"Half","hosting":"subviewport",...}
shot /tmp/qa-shot.png
ok /tmp/qa-shot.png
disconnect
ok
```

Or scripted (one command, read one reply):

```bash
exec 3<>/dev/tcp/127.0.0.1/5599
printf 'state\n' >&3; head -n1 <&3
printf 'connect 127.0.0.1:13406\n' >&3; head -n1 <&3
```

## Implementation

- `src/App/QaServer.cs` — the `TcpListener` + accept/serve threads; each line is handed to the main-thread player via
  `DemoInputPlayer.EnqueueRemote` and the serve thread blocks for that command's single response.
- `src/Input/DemoInputPlayer.cs` — the shared interpreter (file script **and** socket); all work runs on the main
  thread, frame-paced.
- `src/App/AppShell.cs` — the `--qa-port` arg + `[qa]` gate (`MaybeMountQaChannel`) and the public QA surface
  (`QaConnect` / `QaDisconnect` / `QaReload` / `QaStateJson` / `CurrentStore`).
