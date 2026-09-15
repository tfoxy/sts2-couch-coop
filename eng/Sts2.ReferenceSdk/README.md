# STS2 reference SDK

Release builds compile against an exact, locked `FuYnAloft.Sts2.References` NuGet package instead
of a derived STS2 declaration catalog stored in this repository, so CI can build a release without
owning the game. Local development continues to compile against the player's legitimate game
installation.

The package and every assembly staged by these projects are **compile-time inputs only**. They are
not part of CouchCoop, are not covered by its Apache-2.0 license, and must never appear in a
release archive. `ExcludeAssets="all"` prevents NuGet package content from being imported
automatically; a lane copies only its reviewed DLL allowlist into the temporary SDK directory used
by the release build.

## Lanes

The game ships on more than one Steam branch, and one reference package cannot serve both, so there
is one **lane** per branch. A lane is a pinned package version, a `packages.lock.json`, a reviewed
content hash and a reviewed assembly allowlist.

| lane | game Steam branch | game build | `FuYnAloft.Sts2.References` | project |
| --- | --- | --- | --- | --- |
| `stable` | `public` (the default branch) | v0.107.1 | `0.107.0-beta` | `stable/Sts2.ReferenceSdk.stable.csproj` |
| `public-beta` | `public-beta` | v0.111.0 | `0.111.0-beta` | `public-beta/Sts2.ReferenceSdk.public-beta.csproj` |

Lane names are **game Steam branches**, the same vocabulary as `scripts/with-game-branch.sh`.

> **The `-beta` suffix is NuGet prerelease, not the Steam branch.** Every published version of this
> package carries it — `0.108.0-beta`, `0.109.0-beta`, `0.110.1-beta`, `0.111.0-beta` — including
> `0.107.0-beta`, which is the **stable** lane's pin. A version's *number* is what pairs it with a
> game build; its suffix says nothing about which branch it targets. Never infer a lane from a
> package suffix, and never name one after it.

The stable lane pairs package `0.107.0` with game build `0.107.1` because no `0.107.1` package is
published. The comparison gate below is what makes that pairing a fact rather than a hope.

Measured Sep 12 2026: `0.107.0-beta` and `0.111.0-beta` ship exactly the same eight assemblies, so
both allowlists are identical today. That is a finding about two package versions, not a shared
default — each lane lists its own, and `scripts/verify-sts2-reference-sdk.sh` keeps an expected
file set per lane. Note the one asymmetry already visible: the beta *game install* ships
`Sentry.Godot.dll` and the beta `sts2.dll` references it, but the *package* does not ship it, so no
lane can stage it. Nothing CouchCoop compiles needs a type from it today; if that changes, the
reference half of the comparison gate fails with `CS0012` while the game half passes, and the fix
belongs in the package.

## Layout

```
Sts2.ReferenceSdk.targets       shared: staging target, missing-input error, common properties
stable/                         one lane
  Sts2.ReferenceSdk.stable.csproj     pins + reviewed allowlist + assembly name, nothing else
  packages.lock.json
public-beta/
  Sts2.ReferenceSdk.public-beta.csproj
  packages.lock.json
```

Each lane needs its own directory because `RestorePackagesWithLockFile` writes `packages.lock.json`
beside the project file; two lanes in one directory would need `NuGetLockFilePath` gymnastics to
keep two locks apart. Each lane imports the shared `.targets` explicitly at the end of its project
body, which still lands before the implicit `Microsoft.NET.Sdk.targets` import.

Every lane emits the same assembly name, `CouchCoop.Sts2.ReferenceSdk`, on purpose:
`scripts/verify-release-archive.sh` forbids exactly that file name in a release payload, and a
lane-specific name would walk past that guard.

## Updating a lane

1. Pin an exact package version in that lane's `.csproj`.
2. Regenerate the lane's `packages.lock.json` (`dotnet restore <lane project>`) and review the
   resolved version and NuGet content hash.
3. Review the package archive and update that lane's `Sts2ReferenceSdkPackageAssembly` allowlist
   only when a new compiler dependency is genuinely required.
4. Update the lane's expected version, game build and expected DLL set in
   `scripts/verify-sts2-reference-sdk.sh`, then run it: `scripts/verify-sts2-reference-sdk.sh
   <lane>` (no argument audits every lane). This needs no game.
5. Run `scripts/compare-sts2-reference-builds.sh <lane> GAME_ASSEMBLIES_DIR` against the legitimate
   game build **that lane is paired with**. It proves this repository's consumer assemblies emit
   identical STS2 references *and* identical normalized IL against both inputs; the IL half exists
   because enum values and optional-parameter defaults change emitted constants without changing a
   single reference row. That result must be repeated before changing either side.

Comparing several lanes in one invocation runs them **sequentially** — each pass rebuilds the same
consumer projects into the same `bin/Release/net9.0` directories, so lanes cannot share a checkout
concurrently.

## Adding a lane

Create `<lane>/Sts2.ReferenceSdk.<lane>.csproj` (copy an existing lane; it is pins, an allowlist and
an assembly name over the shared `.targets`), restore it to generate `<lane>/packages.lock.json`,
and add the lane to `reviewed_lanes` plus its three reviewed-input functions in
`scripts/verify-sts2-reference-sdk.sh`. That script fails on a lane directory it has not reviewed,
and on two lanes pinning the same package version — the copy-paste that would quietly make one
lane's release build the other's. The lane also needs its reviewed rows in
`scripts/lib/release-lanes.sh` — including a **game floor**, which names the payload directory the
lane ships in and is what the loader matches a running game against; a lane with no floor cannot be
ordered against the others and so cannot be selected. `scripts/test-verify-release-archive.sh`
asserts the two lists agree, so a half-added lane fails loudly rather than being left out of a
release.

`scripts/package-release.sh` builds every lane it discovers here into **one** payload, each lane's
game-version-sensitive assemblies under `couchcoop/lanes/<that lane's floor>/`.
`COUCHCOOP_RELEASE_STS2_LANE` still narrows the run to the lanes it names, but the result is a
**local build, not a publishable release**: the script says so as it starts, and it tells the payload
gate which lanes to expect, so an archive missing a lane cannot pass the `--complete` check the
release path uses. Publishing one would strand every player on the branch whose lane is absent.

Each lane's package id, resolved version and content hash — with the game build it was pinned from,
its `min_game_version` floor, its bridge API lane, its payload directory and its NuGet lockfile hash
— are recorded **inside that one payload** as `couchcoop/build-info.txt`, under
`dependencies.sts2References` keyed by lane. `scripts/verify-release-archive.sh` holds that record
and the shipped `lanes/` directories to each other, and holds the manifest's single
`min_game_version` to the **lowest** floor among the lanes that ship.

---

The previous source-based contract is retained locally under
`.sts2/contracts/Sts2.CompileContracts/` for recovery, but `.sts2/` is ignored and is never included
in a clean checkout or release.
