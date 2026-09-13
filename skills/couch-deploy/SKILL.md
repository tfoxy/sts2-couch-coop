---
name: couch-deploy
description: Deploy the CouchCoop mod into the game install correctly and prove what is actually installed. Use before any live QA leg, after any C# or frontend change you intend to test live, and whenever a measurement disagrees with the code you think is running.
---

# Deploying, and proving the install is yours

Two facts drive this whole procedure:

- **`sts2 game deploy … --build` works again** (2026-09-04). It was broken by a CWD-resolution mismatch: the
  publish output path and the deploy subdir were two spellings of the same directory and nothing held them in
  step. sts2 now passes the directory it will copy from to the build (`{deployOutputDir}` /
  `$SPIRECTL_DEPLOY_OUTPUT_DIR`) and FAILS with `deploy_build_output_missing` / `deploy_build_output_stale`
  rather than copying a directory the build did not refresh. Either path below is fine now.
- **Any `dotnet build` of the solution deploys** — `Directory.Build.props` resolves `modsDir` and copies on every
  build. So another agent's stray build, or your own from a worktree, silently replaces what is installed. An agent
  once measured an entire QA leg against someone else's build before checking.

## Deploy

Deployment replaces the installed files used by every live session. Hold `exclusive:install` for the entire
build/copy/proof window; it conflicts with the `shared:install` lease every live game/device session carries:

```bash
node scripts/live-qa-lock.mjs with --owner deploy-main --resource exclusive:install -- \
  scripts/build-local-mod.sh
```

```bash
scripts/build-local-mod.sh
```

Or, to build + deploy + restart in one step:

```bash
sts2 --json game deploy src/CouchCoop.Mod.Loader --build --restart --verify --wait-quiescent-ms 8000
```

Read `build.freshness.fresh` in the JSON — it says the copy came from a directory this build actually wrote
(rather than a stale one), which is the half of the old breakage that used to pass silently.

`--wait-quiescent-ms` polls for "no room transition, no intro animation" and reports
`quiescence{quiescent,elapsedMs,timedOut,status}`. **Do not treat it as a replacement for the fixed delays in
`tests/scenarios/*lobby*.sts2.yaml`.** Measured here on 2026-09-04 it returned `quiescent:true` after 1 232 ms
on the main menu — inside the several-second window in which the boot flow still pops a fixture-created lobby —
and a scenario run with the 20 s `dev.delay` swapped for `waitQuiescentMs` hung in the probe until it timed out.
The delays are still there on purpose; see `.ai/tool-improvements.md`.

If your change is in `../spirectl`, that is only **half** the deploy. There are two separate assemblies:

```bash
sts2 game install-bridge        # the bridge/CLI-facing copy   (Spirectl.Sts2.dll)
scripts/build-local-mod.sh      # the embedded copy the running game + browser mirror serve
```

`install-bridge` alone does **not** update what the browser mirror sees. Run both, in that order.

Frontend only: `npm run build` in `frontend/` is the deploy (its Vite outDir *is* the installed mod's frontend
dir) — which is exactly why it is blocked by the PreToolUse guard in every other context. Deploy the frontend
through `scripts/build-local-mod.sh` with the rest of the mod.

## Prove it

Every deploy ends here. Do not skip it because the build printed no errors:

```bash
stat -c %y <modsDir>/CouchCoop.Mod.dll
```

The mtime must be your deploy's. **Do not try to read a cache generation out of the DLL** — the old
`strings -el … | grep couchcoop-asset-cache` recipe stopped printing a version in 2026-09 (the generation is
interpolated from two constants) and the string it grepped for is gone entirely now that the cache is branch
scoped. It was the weaker check anyway — the token names a cache schema, which most branches never bump, so on
any branch that leaves it alone it was identical to main's and **could not tell the two builds apart**. It
caught a stale schema, not a stale build.
(Two QA agents in one round found it vacuous for their branch and had to invent the technique below; one of them
caught their own wrong-checkout deploy with it mid-round.)

Whenever the *branch* is the thing to prove — a branch build landed, or main was restored — grep for a string
only your branch contains, and check **both directions**:

```bash
strings -el <modsDir>/CouchCoop.Mod.dll | grep -c CouchCoopActivityPanel   # a type name from your own diff
```

Positive count after deploying the branch, **0 after restoring main** — the 0 is what makes the string a
discriminator rather than a coincidence. New type names and new literal log messages both work; pick one or two
from your diff before you deploy.

If the branch adds no new string at all (a pure behaviour tweak), you are down to freshness: note `stat -c %y`
on the installed DLL right after your deploy and re-check it before each measurement. Do **not** try to `cmp`
the installed DLL against `src/CouchCoop.Mod/bin/…` instead — the publish that deploys and the builds that fill
`bin/` run with different property sets and (with deterministic compilation embedding source paths) from
different checkout paths, so the same source differs byte-for-byte. That check was tried and false-negatives on
a known-good install.

If any of these prints the wrong answer, someone else's build landed after yours — rebuild and re-check before
you measure anything.

## After a bridge or model shape change

Clear the stale on-disk model cache or you will test against old cached JSON:

```bash
rm -rf ~/.local/share/SlayTheSpire2/couch-coop/cache/*/assets/model/
```

Then relaunch. The glob is over BRANCH directories — the cache is scoped per Steam branch
(`couch-coop/cache/<branch>/`, at most two) and a bridge change invalidates every one of them, which no stamp
can notice because nothing about the GAME moved. Everything the mod writes into the user profile lives under
`couch-coop/`; the old `SlayTheSpire2/CouchCoop/` directory is abandoned, not migrated.

## Restart

`dotnet build godot-client/CouchCoop.GodotClient.csproj` before **every** godot-client launch — Godot's CLI runs
the last-built assembly, not a fresh JIT.

The Godot mono build is at `~/.local/godot-4.5.1-mono/…/Godot_v4.5.1-stable_mono_linux.x86_64`. The `godot` on
PATH is a non-mono 4.6.2: it runs the project scriptless and then silently idles forever.

## From a worktree

Set `COUCHCOOP_GAME_MODS_DIR` to a scratch directory first, or strip `modsDir`/`game.path` from the worktree's
copied `sts2.local.yaml`. Otherwise the build deploys the worktree's code over the live install. The guard blocks
this, but the recovery — if it already happened — is `scripts/build-local-mod.sh` from `main` plus a game restart.

## Related

`couch-live-lock` (take the scoped `exclusive:install` lease before deploying), the `live-game-qa` agent, and
[docs/agents/qa-recipes.md](../../docs/agents/qa-recipes.md) §7.
