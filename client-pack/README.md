# Couch seat client pack

This GDScript pack joins a CouchCoop seat and displays its render-stream through GSW's native
receiver. It sends taps as left-button press/release pairs with the current presentation epoch.
The overlay shows connection status and the last input result. Reconnect, settings and hand
raising are outside this spike.

## Build and offline tests

Prerequisites: the non-mono Godot 4.5.1 editor installed through mise, Python 3, Node.js with
TypeScript module support, and the repository's installed frontend dependencies. Point
`COUCHCOOP_GSW_ROOT` at a GSW checkout; its `experiments/render-stream/` holds the Android shell
spike and the native receiver:

```sh
export COUCHCOOP_GSW_ROOT=/path/to/godot-scene-web
client-pack/build.sh
client-pack/test.sh
```

`COUCH_PACK_GODOT` can override the editor executable. The build copies receiver scripts from
`$COUCHCOOP_GSW_ROOT/experiments/render-stream/receiver/` into ignored staging; it never writes to
GSW. It exports `client-pack/build/manifest.json` and `client-pack/build/<sha256>.pck`, then checks
that the pack contains no native binaries or test scripts. Receiver source hashes and the pack
file listing are also saved under `build/`.

`test.sh` rebuilds, runs fake-host/headless-Godot tests, then runs the frontend parity test.
The fake host checks both WebSocket URLs, join and renderer messages, the first-frame receipt,
readiness/access/epoch gates, input results and credential-free logs. It captures four raw input
strings at epochs 42 and 43. The parity test drives the actual frontend `createStreamInput` and
`connectMirrorClient` implementations and compares both parsed fields and the exact JSON strings.
To rerun parity against the latest capture:

```sh
node frontend/node_modules/vitest/vitest.mjs run --config client-pack/tests/vitest.config.mts
```

Offline tests replace only the receiver view with a signal-driven fake; they do not prove live
rendering, device input mapping or host admission. Logs and captures stay in ignored `build/`.

## Run in the GSW shell

GSW's shell and native receiver artifacts are built in GSW
(`experiments/render-stream/scripts/build-android-shell.sh`). Serve this pack with GSW's static pack
server, leaving its checkout untouched:

```sh
mkdir -p client-pack/build/serve/client-pack
cp client-pack/build/manifest.json client-pack/build/*.pck client-pack/build/serve/client-pack/
python3 "$COUCHCOOP_GSW_ROOT/experiments/render-stream/scripts/serve-android-pack.py" \
  --directory "$PWD/client-pack/build/serve" --port 8765
```

The shell fetches `/client-pack/manifest.json`, verifies the named pack's SHA-256 and instantiates
`res://couch/entry.tscn`. In another terminal, a prepared desktop shell can be launched with:

```sh
GODOT_EDITOR="${COUCH_PACK_GODOT:-$(mise where godot@4.5.1-stable)/Godot_v4.5.1-stable_linux.x86_64}"
"$GODOT_EDITOR" --path "$COUCHCOOP_GSW_ROOT/experiments/render-stream/android-shell/build/shell" -- \
  --pack-base=http://127.0.0.1:8765 \
  --rs-env=COUCH_HOST_ORIGIN=http://127.0.0.1:13337 \
  '--rs-env=COUCH_PLAYER_NAME=Native client'
```

Automated rendered checks use a private headless compositor. Live game runs, shell/device launch
and `adb reverse` are run by hand, outside these scripts. For the Android shell, reverse both 8765
(pack server) and 13337 (host), and pass the same shell arguments through its launch configuration.

Pack configuration uses environment variables first, then `--rs-env=NAME=VALUE` arguments:
`COUCH_HOST_ORIGIN` defaults to `http://127.0.0.1:13337`, and `COUCH_PLAYER_NAME` to `Native client`.
`COUCH_PACK_DIAGNOSTICS=1` enables per-message type/size and input-result logs (default off).
The control socket uses `watch=0` for sessions and join coordination without a scene feed; the
seat socket retains `watch=1` for renderer admission and input. Both keep the host's required selectors.
GSW's `RS_RECEIVER_*` options remain available. The receiver runs at the descriptor's presentation
size inside a uniformly scaled, letterboxed viewport, preserving presentation-pixel tap mapping.
Tokens stay in the descriptor/receiver transport and are redacted from receiver log messages.
