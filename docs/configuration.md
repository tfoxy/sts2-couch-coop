# Configuration

CouchCoop is a local STS2 mod plus a hosted browser SPA. Machine-specific paths and generated artifacts stay outside version control.

## Local STS2 Setup

Local contributors must create `sts2.local.yaml` at the repo root. Local builds must read STS2/Godot assemblies from this file:

```yaml
game:
  path: /absolute/path/to/SlayTheSpire2
  assembliesDir: /absolute/path/to/SlayTheSpire2/data_sts2_linux
```

`game.path` identifies the local game install for developer tooling. `game.assembliesDir` is required and is the only source for compile-time STS2/Godot assembly resolution. Build bootstrap may pass it to MSBuild as `Sts2AssembliesDir` or generate ignored props under `.sts2/`, but it must not infer assemblies from `game.path`.

Local developer builds default to `game.modsDir/couchcoop` when `game.modsDir` is set, otherwise `game.path/mods/couchcoop`. This deploy output includes the C# loader/mod assemblies and the hosted SPA at `frontend` inside the mod directory. Use `scripts/build-local-mod.sh --output <dir>`, `COUCHCOOP_FRONTEND_OUT_DIR=<dir>`, or `-p:CouchCoopBuildToLocalMods=false -o <dir>` when staging somewhere else.

`sts2 game deploy src/CouchCoop.Mod.Loader --build --restart --verify` uses the repo build script to stage artifacts and then lets `sts2` copy, restart, and verify through the configured local game.

C# browser server iteration is a local-development feature. Local builds set `CouchCoopEnableHotReload=true` and expose the spirectl v0 hot-reload shell from `couchcoop.dll`, while retaining CouchCoop's implementation contract at `1`. After one normal deploy/restart, edit `src/CouchCoop.Mod.HotReload/CouchCoopHotLogic.cs` or the linked browser server/protocol sources and run `sts2 --mode dev --json dev mod-reload --project . --build --wait`. The hot-reload profile builds `CouchCoop.Mod.HotReload.dll` into `.sts2/hot-reload`, the shell shadow-loads it, swaps the active browser server generation, closes active browser sockets with `server-reload`, and refreshes existing lobby overlays in place. Shell, runtime host, listener, Harmony, Godot lifecycle, and headless process changes still require normal deploy/restart.

Published release archives set `CouchCoopEnableHotReload=false`. They contain the normal dynamic implementation loader but no hot-reload protocol, discovery methods, or `hot-reload/` payload; use a normal deploy/restart when changing a published installation.

Frontend dev-loop commands are:

```bash
npm --prefix frontend run dev
npm --prefix frontend run build:watch
sts2 --mode dev --json dev mod-reload --project . --build --wait
```

The reloadable boundary is narrow: `sts2 dev mod-reload` swaps `CouchCoop.Mod.HotReload` only. Anything outside
that project — the browser listener, runtime/session state, the Godot lifecycle, the loader's protocol contract —
still needs the normal deploy/restart loop, and the loader reports a `reload_contract_version_mismatch` rather
than reloading across a contract change.

## Two game installs on one machine (game branches)

Testing against a beta or older game build needs a second install, and the whole difficulty is that
CouchCoop finds the game **twice**, through two resolvers that never compare notes:

- the `sts2` CLI's config stack — `sts2.config.yaml` + `sts2.local.yaml` read from one directory,
  chosen by `SPIRECTL_CONFIG_DIR`, by `--config <file>`, or by walking up from the working directory;
- this repo's own reader — `Directory.Build.props` regex-reads `sts2.local.yaml` for
  `game.assembliesDir` / `game.modsDir` / `game.path` and honours `$(CouchCoopLocalConfigPath)`,
  `STS2_ASSEMBLIES_DIR`, `COUCHCOOP_GAME_MODS_DIR` and `COUCHCOOP_LOCAL_MOD_DIR`; plus
  `scripts/build-local-mod.sh`, which asks the CLI and falls back to its own sed reader.

**`sts2 --config beta.yaml game deploy --build` silently builds the wrong binary.** The deploy exports
`SPIRECTL_DEPLOY_OUTPUT_DIR`, `SPIRECTL_DEPLOY_PROJECT_ROOT` and `SPIRECTL_DEPLOY_MOD_NAME` to the
build command and nothing else — never the assemblies dir. So the compile resolves STS2 references
through the MSBuild reader, which still reads the repo-root `sts2.local.yaml` and hands it the
**stable** assemblies, and the deploy then installs that binary into the **beta** install's mods dir.
Build succeeds, deploy succeeds, verify succeeds, and you are measuring a mod compiled against the
other game version.

`scripts/with-game-branch.sh` is the one switch that feeds both resolvers, and the assertion that the
install you got is the install you asked for:

```bash
scripts/with-game-branch.sh list
scripts/with-game-branch.sh setup beta --game-path /path/to/the/second/install
scripts/with-game-branch.sh beta -- sts2 game deploy src/CouchCoop.Mod.Loader --build --restart --verify
```

A branch is a **config directory**, not a config file, because `SPIRECTL_CONFIG_DIR` moves the whole
stack there and every `sts2` call inside the wrapped command picks it up with no `--config` flag to
forget. `stable` (or `default`) is the repo root itself — today's behaviour, unchanged. Any other name
is `.sts2/branches/<name>/`, holding a real `sts2.local.yaml` with that install's paths plus symlinks
back to the repo root's `sts2.config.yaml`, `sts2.profiles.yaml`, `sts2.hooks.yaml` and
`sts2.hot-reload.yaml`. `.sts2` is gitignored, so a branch registry is local state only. An
unregistered name is an error naming the `setup` command to run — it never falls through to stable.

The wrapper exports `SPIRECTL_CONFIG_DIR`, `STS2_ASSEMBLIES_DIR`, `CouchCoopLocalConfigPath` (MSBuild
surfaces an environment variable as a property, so no `-p:` flag is needed), `COUCHCOOP_LOCAL_MOD_DIR`
and — for every branch except stable — `SPIRECTL_INSTANCE`. An already-set `SPIRECTL_INSTANCE` wins,
and so does a scratch `COUCHCOOP_GAME_MODS_DIR`: `COUCHCOOP_LOCAL_MOD_DIR` outranks it in
`Directory.Build.props`, so deriving the mod output from the install would otherwise defeat the
scratch-directory valve every worktree build depends on.

### Why the second install cannot live in Steam's directory

Steam keeps exactly one install per appid per library folder, and switching a game's branch rewrites
that install **in place**. There is no arrangement where Steam holds both branches at once, so the
second install is a directory Steam does not manage — and it must be a **real copy, never a symlink
farm**. Godot resolves its own executable through `/proc/self/exe`, which follows symlinks, so a
symlinked `SlayTheSpire2` makes the game treat the *other* install's directory as its own and load
that install's `mods/`. The branch then runs a build you did not deploy to it, and nothing in the log
says so. `SlayTheSpire2.pck` may stay a symlink; the binary may not. The wrapper fails rather than run
when it finds a symlinked binary.

**`mods/` must never be shared between installs either.** `scripts/build-local-mod.sh` deletes the
stale top-level DLLs in the output directory and regenerates `hot-reload/` and `frontend/` in place,
so one shared `mods/` means each deploy silently re-points the other branch at the build it just
made. The wrapper fails on a symlinked `mods/` too.

An install root also has to satisfy the CLI's own test: a `data_sts2_*` subdirectory holding **both
`sts2.dll` and `GodotSharp.dll`**. When it does not — a download still in progress looks exactly like
this — the CLI does not fail. It falls back to **Steam autodiscovery** and quietly resolves the stable
install instead, which is the same wrong-binary outcome arriving by a different route. The wrapper
compares the install the CLI resolved against the one the branch configures, refuses a `gamePath` the
CLI reports as `discovered`, and prints the build identity from `release_info.json` on stderr before
running, so the operator always sees which build they just drove. `setup` records that identity, and
the run form warns when it has drifted — that means the branch updated since registration.

### Per-branch runtime state

`SPIRECTL_INSTANCE` is the narrow knob: `sts2 --instance <name>` gives the game its own bridge socket
and passes its own `--user-dir`, so two branches never share save state. Do **not** reach for
`XDG_DATA_HOME` instead — it redirects far more than the game's user dir.

`instances.symlinkUserDataDirs: [couch-coop]` in the repo-root `sts2.local.yaml` symlinks the shared
`user://couch-coop` directory into each instance, and CouchCoop's caches live inside it. Sharing it
across branches is **safe**: the caches are branch scoped at `couch-coop/cache/<branch>/`, so a beta
instance and a stable one write to different directories even when the parent is shared. (It was not
always: the namespace used to carry only a schema number, and two branches sharing the directory served
each other bytes rendered by the other game build — a rendering bug with no visible cause. See
[Cache layout](#cache-layout) for what replaced it.)

The **decompile corpus** is the other piece of per-branch state, and the one it costs most to get
wrong. `.sts2/toolchain` in this checkout is a symlink to `../../spirectl/.sts2/toolchain/` — a
corpus shared with the spirectl repo and built from the stable game — and `sts2 project recover
--kind decompile` rewrites `<toolchain.dir>/decompile/` wholesale. `toolchain.dir` defaults to a
*relative* `.sts2/toolchain` anchored on whichever directory the CLI chose, which under
`sts2 --config <file>` is the **working** directory. So a branch config that simply omits the key
sends a beta recovery straight into spirectl's stable corpus: 154 MB, twenty minutes to rebuild, and
nothing in the output names the game build that produced it, so the damage is invisible until
somebody reads beta sources believing they are stable. `setup` therefore writes an absolute
`toolchain.dir: <repo>/.sts2/toolchain-<branch>`, matching the `toolchain-public` /
`toolchain-public-beta` corpora already on disk, and the run form warns on every command when a
hand-written branch config omits the key or points it at the shared corpus. `stable` keeps
`.sts2/toolchain` — that corpus *is* the stable game's — and the banner labels it as such.

A branch's `sts2.local.yaml` also pins `project.profilesFile` and `project.hooksFile` at absolute
repo-root paths, which looks redundant next to the symlinks and is not. `sts2` resolves a profile's or
hook's relative command, its `cwd` and `${profileDir}` against the directory holding the
profiles/hooks *file* — the branch directory, if that file is reached through the symlink. The hooks
would load and then resolve `scripts/probe-…` to `.sts2/branches/<name>/scripts/probe-…`, which does
not exist. Naming the repo-root files outright puts that base directory back where the scripts are.

Nothing else from the repo-root `sts2.local.yaml` layers into a branch: the stack is exactly that
directory's `sts2.config.yaml` plus its `sts2.local.yaml`. Machine setup the root file carries —
`game.launchArgs`, `game.disableBackgroundThrottle`, `tools.gdrePath` — has to be copied into the
branch file by hand if the branch needs it. `setup` will not overwrite a hand-edited branch file
without `--force`, and `--force` rewrites it from scratch — every hand-added key is lost, so the
previous file is kept beside it as `sts2.local.yaml.replaced` and a replaced `toolchain.dir` is
called out by name.

**As of the game's v0.111.0 beta the mod does not build against it at all.** The build stops
upstream, in `../spirectl/bridge-mod`, on a handful of `CS0246`s where the beta split one game type
apart. Do not read that error count as the size of the port: a declaration-site failure masks every
downstream project through `MSB4181`, and Roslyn never binds a method body once a declaration has
failed, so the compiler's list is a lower bound — the measured per-member delta is an order of
magnitude larger. The `verify-references` entry in
[`.ai/tool-improvements.md`](../.ai/tool-improvements.md) records how that was actually measured and
where the numbers live. One CouchCoop Harmony target also changed arity — the per-act audio bank
load patched in
[`src/CouchCoop.Mod/Patches/HeadlessAudioMutePatch.cs`](../src/CouchCoop.Mod/Patches/HeadlessAudioMutePatch.cs)
— and that one fails soft, so it will never stop a build; it will just quietly stop muting. So
`with-game-branch.sh public-beta -- <any build>` fails at the bridge today, while corpus generation
and static inspection against the beta work fine — which is what the branch tooling is for until
that port happens.

Self-test: `scripts/test-with-game-branch.sh`, which builds synthetic installs in a temp
directory and needs no real game install.

## Browser asset and clip contracts

`/res/{path}` is the resource route. It accepts a path relative to `res://`, never a scheme-prefixed key.
The only supported resource representations are `raw` (the default) and explicit `?format=png`; an
unknown format is a client error. A `::{sub-resource-id}` request is extracted from its parent's raw
document and does not accept `format`. Consumers must not infer a representation from a filename or add
their own resource aliases.

`/spines/` serves an `application/vnd.couchcoop.spine-clip` body with the `SPCL` v1 wire format. It carries
encoded image-frame payloads and node-local placement, so clients apply placement below the streamed node transform. The one
supported escalation selector is `retry=1`; do not use a clip `v` parameter as a retry mechanism.

To populate the host's Spine clip cache before accepting browser play, pass `--prerender-spines` through the
normal game launch command, or set `COUCHCOOP_PRERENDER_SPINES=1` in the game's environment:

```bash
sts2 game launch -- --prerender-spines
```

CouchCoop starts the browser server first and discovers clips in the background. Progress and the final
`COUCHCOOP_SPINE_PRERENDER` JSON summary are written to `godot.log`; failures are per clip and do not stop
lazy rendering or the remaining warmup work. What it warms is the branch-scoped asset cache below.

### Cache layout

Everything CouchCoop caches on disk — rendered asset bytes, baked geoclips, ASTC containers — is derived
from the game's own content, so the same `res://` path renders different pixels on different game builds.
The cache is therefore keyed by the install, not just by the resource:

```
user://couch-coop/cache/
  <branch>/                     one per Steam branch ("public", "public-beta")
    .cache-identity.json        the stamp: game version, content hash, Steam build id, cache versions
    assets/  geoclips/  astc/  pending/
  .trash/                       purged trees, deleted in the background
```

On startup the mod compares that stamp against the install it is running in. If the game build has moved,
or either cache version has, the whole branch directory is moved aside **before** anything reads or writes
it and deleted in the background — a rename, so a multi-gigabyte cache costs no startup time. At most two
branch directories are kept; a third is evicted least-recently-used first. One line in `godot.log` reports
which branch was resolved, where the answer came from (`steamworks`, `appmanifest`, or a fallback), and
any purge.

The branch comes from Steam itself (`SteamApps.GetCurrentBetaName()`) with the install manifest as a
fallback; `release_info.json` has no branch field — its `branch` is the release tag. Two version numbers
ride the stamp: CouchCoop's own `CacheVersion`, and spirectl's `AssetPayloadVersion`, which is owned by
spirectl and not manually versioned in this repository. `COUCHCOOP_CACHE_ROOT` moves the whole thing.

The same identity composes the `assetCacheToken` on the `session` envelope, so the browser's service
worker drops its durable `/res/` store on exactly the changes that empty the host's — including the two
the frontend bundle hash cannot see, a game update with no frontend rebuild and a phone hopping between a
stable host and a beta one.

Static backgrounds use `/bg/{id}?layers={digest}&v=1` for combat, `/bg/events/{id}?v=1` for event
backdrops, and `/bg/rooms/{id}?frame={frame}&v=1` for room backdrops. The codec is host policy and is
identified by `Content-Type`, not a path extension. A current URL is immutable; stale variants resolve only
from cache or fail, never render a different background under the same URL.

## Local network name (mDNS responder)

The in-game QR dialog offers `http://<machine>.local:<port>/` as an explicit, manually selectable option after
the literal-address and other link options. The mod publishes that name itself: a minimal RFC 6762 responder
joins `224.0.0.251:5353` on every usable IPv4 interface and answers A (and ANY)
queries for exactly one name — `Environment.MachineName` normalised by `QrHostOptions.ToMdnsHostName`, i.e.
byte-identical to the string the dialog renders. It answers with the address of the interface the query
arrived on, sends two announcements at startup and a goodbye (TTL 0) on shutdown, and publishes nothing else
(no service/PTR/SRV records, IPv4 only).

**A records only, deliberately.** An AAAA question is left unanswered even though clients ask for one: the
browser server binds `IPAddress.Any`, which is AF_INET, so an AAAA answer would name an address nothing is
listening on — and browsers prefer IPv6 when both resolve. Answering AAAA needs a dual-stack listener first.
Measured on an Android client, the phone asks A and AAAA as separate datagrams over the IPv4 group and
resolves fine from the A alone.

This used to be left to the operating system, which is fine on Linux (avahi) and macOS (Bonjour) but not on
Windows: a stock Windows install has no `.local` responder at all (it advertises over LLMNR/NetBIOS, which
phones do not speak, and Bonjour only arrives bundled with other software), and `Environment.MachineName` is
the NetBIOS name — uppercased and truncated to 15 characters — so even a machine that *does* run Bonjour can
publish a different name than the QR shows.

Where an OS responder is already running, both answer with the same address for the same name. RFC 6762 treats
identical rdata as legal coexistence, not a conflict, so avahi does not conflict-rename the host.

- Kill switch: `COUCHCOOP_MDNS_RESPONDER=0` (also `false`/`off`/`no`) disables the responder entirely.
- Related: `COUCHCOOP_ADVERTISED_HOST` pins the advertised address outright and wins the QR dialog's default row.
- Startup logs one of `mdns-responder publishing name=… interfaces=…`, `mdns-responder-disabled`, or
  `mdns-responder-unavailable detail=…`. Any socket failure (port 5353 denied, no multicast route, hostile
  firewall) disables the responder only — the browser server and host UI are never affected.

### Is the name actually reaching the network? (self-check)

Binding the socket, joining the group and writing datagrams all succeed whether or not a firewall is silently
dropping inbound 5353, so the responder cannot tell "working" from "mute" by return codes. Two observations
can, and both are logged:

- **the startup self-check** — a few seconds after start the responder asks the multicast group for its own
  name from an ephemeral socket, over the real network, and reports whether its own address came back. An
  answer from a *different* machine for our name is counted as a failure, not a success: that is a name
  conflict, and defaulting the QR to it would send players to somebody else's box.
- **per-interface answered counts** — how many address queries this responder has actually served, by arrival
  interface. **Zero on every interface, on a host phones can otherwise reach, is the fingerprint of inbound
  UDP 5353 being dropped before it arrives.**

Both appear on one line:

```
[couch-coop] mdns-responder self-check selfCheck=Answered answered=3 byInterface=if2=3 name=living-room-pc.local
```

`selfCheck=Unanswered` **demotes the `.local` row below the literal IP rows in the QR dialog**, so the code a
player scans is one that certainly works. The row is demoted, not removed — it may still resolve for a phone
on a different segment, and a player who wants to use mDNS can still select it explicitly. The browser never
switches to the `.local` origin automatically; if the selected mDNS code does not work, choose a literal IP row
instead. `selfCheck=NotRun` never demotes anything — an unrun probe is not evidence.

- Kill switch: `COUCHCOOP_MDNS_ROW_SELFCHECK=0` suppresses the self-check warning; it does not make the
  `.local` row the default.

### Windows

Publishing the name does not open the firewall, and the mod cannot open it (that needs admin). The host
firewall must allow **inbound UDP 5353** for the game executable; Windows blocks it by default on the Public
profile, and a firewall prompt answered for the game's TCP listener does not necessarily cover UDP. From an
elevated prompt:

```
netsh advfirewall firewall add rule name="STS2 Couch Co-op mDNS" dir=in action=allow protocol=UDP localport=5353 program="C:\Path\To\SlayTheSpire2.exe"
```

Also check the network profile itself: a LAN marked **Public** blocks far more than a **Private** one, and
couch co-op is by definition a private-network activity.

Two more Windows-specific traps worth knowing:

- **A Windows client connecting to a Windows host proves nothing about mDNS.** Windows resolves another
  Windows machine's name over LLMNR/NetBIOS, which phones do not speak — so host-and-client-both-Windows can
  work perfectly while every phone gets `ERR_NAME_NOT_RESOLVED`.
- **Another process may already own 5353 exclusively.** Bonjour (bundled with iTunes, Adobe products and
  others) and some Windows components bind it; if that binder did not allow port sharing our bind fails and
  logs `mdns-responder-unavailable detail=bind:…`, which is the line to look for.

If the `.local` row still fails on a phone, pick the literal IP row in the QR dialog's host selector — that
path only needs the app's TCP port, which is already working if the game is reachable at all.

To verify by hand on a machine with a working responder, run the responder standalone and query it with a raw
mDNS probe:

```bash
dotnet run --project tests/CouchCoop.Mod.Tests -- mdns-harness 30            # publish <machine>.local
dotnet run --project tests/CouchCoop.Mod.Tests -- mdns-harness 30 probe-name # publish probe-name.local
```

`dig @224.0.0.251 -p 5353 <name>.local A` is *not* a reliable check: dig discards a reply whose source address
differs from the address it queried, which is true of every mDNS legacy-unicast reply (they come from the
host's real IP). Use a raw UDP probe, `avahi-resolve -n <name>.local`, `getent ahostsv4 <name>.local`, or a
phone on the same LAN instead. Publishing a name no OS responder owns (the second form above) is the way to
prove the answer came from the mod rather than from avahi/Bonjour.

## Artifact Policy

Do not commit `.sts2/`, `sts2.local.yaml`, official STS2 assets, copied game DLLs, generated `__sts2_assets__`, screenshots, visual baselines, build output, frontend `dist/`, or `node_modules/`.

Use ignored local paths such as:

- `.sts2/` for generated MSBuild props, validation artifacts, screenshots, baselines, and asset extracts.
- `.sts2/branches/<name>/` for a registered second game install (see "Two game installs on one machine").
- `sts2.local.yaml` for machine-specific game paths.
- `.ai/tool-improvements.md` for later-spec notes about concrete missing or brittle tools.

## Upstream Boundary

CouchCoop owns co-op product behavior: browser DTO envelopes, URL layout, session identity, per-viewer state and state shaping, hosted SPA/server behavior, QR overlay, screen UX, frontend visual policy, and validation policy for the CouchCoop browser product.

spirectl owns reusable STS2 tooling: runtime state, semantic actions, fixtures/scenarios, render snapshots, asset extraction, asset keys/bytes, fonts, screenshots, screenshot diff, diagnostics, and reusable validation helpers.

More specifically, CouchCoop-specific browser envelopes, hosted URL layout, QR overlay behavior, and product visual policy stay in this repository. Generic STS2 assets, extracted bytes, key fonts, render snapshots, game screenshots, and screenshot diff tooling belong upstream in `../spirectl` and should be consumed through embedded `spirectl` libraries where runtime code needs them.

The shipped mod must use embedded `spirectl` libraries and must not require players to install the `sts2` CLI.

Missing reusable STS2 support belongs in ../spirectl; do not hide gaps with CouchCoop-local reflection, asset extraction, fixture, screenshot, or diff shims. Record missing or brittle tools in `.ai/tool-improvements.md` only when a later spec's implementation or validation work discovers a concrete gap.

Subsystem-level documentation for agents lives under [docs/agents/](./agents/) — start at its
[README](./agents/README.md).
