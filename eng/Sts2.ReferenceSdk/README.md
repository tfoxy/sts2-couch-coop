# STS2 reference SDK

Release builds use the exact, locked `FuYnAloft.Sts2.References` NuGet package
instead of storing a derived STS2 declaration catalog in this repository. Local
development continues to compile against the player's legitimate game
installation.

The package and every assembly staged by this project are **compile-time inputs
only**. They are not part of CouchCoop, are not covered by its Apache-2.0
license, and must never appear in a release archive. `ExcludeAssets="all"`
prevents NuGet package content from being imported automatically; the project
copies only its reviewed DLL allowlist into the temporary SDK directory used by
the release build.

When updating the STS2 reference version:

1. Pin an exact package version in `Sts2.ReferenceSdk.csproj`.
2. Regenerate `packages.lock.json` and review its NuGet content hash.
3. Review the package archive and update the explicit DLL list only when a new
   compiler dependency is genuinely required.
4. Run `scripts/verify-sts2-reference-sdk.sh`.
5. Run `scripts/compare-sts2-reference-builds.sh GAME_ASSEMBLIES_DIR` against
the matching legitimate game version.

The current `0.107.0-beta` reference package is paired with the public
`0.107.1` game build because no `0.107.1` package is published. The comparison
gate confirms that this repository's consumer assemblies emit identical STS2
references and instructions against both inputs; that result must be repeated
before changing either side.

The previous source-based contract is retained locally under
`.sts2/contracts/Sts2.CompileContracts/` for recovery, but `.sts2/` is ignored
and is never included in a clean checkout or release.
