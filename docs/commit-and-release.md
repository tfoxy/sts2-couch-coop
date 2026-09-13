# Commits and releases

How a change gets from a working tree into a release people can read. One document for all three
repos — `sts2-couch-coop`, [`spirectl`](../../spirectl/docs/commit-and-release.md) and
[`godot-scene-web`](../../godot-scene-web/docs/commit-and-release.md) share this convention and the
same hook; only the changelog voice differs.

## The short version

```
type(scope)!: imperative subject, <=72 chars, no trailing period

Body prose: what changed and why, wrapped at <=100 columns. Optional.

Changelog: one sentence a player would read — feat/fix/perf only, or `none`
```

- Enforced by `scripts/githooks/commit-msg` **on `main` only**. Feature branches are free.
- Installed by `scripts/install-agent-config.sh` (`core.hooksPath`), so it holds in every worktree.
- Emergency bypass: `git commit --no-verify`.

## Types

Nine, closed. If none fits, the commit is probably two commits.

| Type | For | Trailer |
| --- | --- | --- |
| `feat` | a capability someone can notice | required |
| `fix` | a defect someone could hit | required |
| `perf` | a measured speed or memory win | required |
| `refactor` | no behaviour change — including retiring a shipped flag or experiment | — |
| `docs` | documentation only | — |
| `test` | tests, benches, harnesses, fixtures | — |
| `build` | build, dependencies, packaging | — |
| `ci` | workflows and the release pipeline | — |
| `chore` | everything else | — |

Earlier history used a wider, drifting set. Those fold in:

| Was | Now |
| --- | --- |
| `cleanup` | `refactor` (or `chore` when nothing was code) |
| `bench` | `test`, or `perf` when a number moved |
| `godot`, `html`, `particles`, `presentation`, `bridge`, `catalog`, `fixtures` | scopes, e.g. `fix(bridge): …` |

Scope is optional, lowercase, free-form — a directory, a subsystem, a file. `!` before the colon
marks a breaking change, with a `BREAKING CHANGE:` footer saying what breaks. That matters most in
the siblings, which publish npm and NuGet packages on tag.

## The `Changelog:` trailer

Release notes are not assembled from subjects. A release spans hundreds of commits with subjects
like `fix(mirror): bound raised visual provenance to hitbox`, which is the right subject and the
wrong release note. So the note is written *once, at commit time*, by whoever still has the context:

```
fix(mirror): bound raised visual provenance to hitbox

Restrict the raised-card visual claim to the hitbox so a neighbouring card cannot
steal the paint when two overlap.

Changelog: Fixed a raised card sometimes highlighting the wrong neighbour when you hold it.
```

Rules that keep it cheap:

- Only `feat`, `fix` and `perf` need one. The other six types — where most agent commits land —
  need nothing at all.
- `Changelog: none` is a complete answer, and the hook accepts it. Writing the word is the point:
  it makes "is this user-visible?" a decision rather than an omission.
- Write it for the reader of the release, not for the reviewer of the diff. Couch: what a player
  notices at the table. spirectl and godot-scene-web: what an integrator notices in their build.
- `Refs: spirectl@<sha>` is an optional second trailer for work that spans the sibling repos, which
  `release-dependencies.json` pins by commit.

## Branches and merging

`main` gets **one commit per coherent change**. Get there whichever way suits the work:

- A self-contained change commits straight to `main`.
- Longer work goes on a branch, where nothing is enforced and commits can be as small and as
  scruffy as they need to be, and comes back as a single squash commit:

```bash
git switch main
git merge --squash cc-my-round
git commit            # the .gitmessage template opens; this message is the one that is checked
```

The branch keeps its fine-grained history locally for as long as it is useful. The reason for
squashing is legibility: `git log --oneline` on `main` should read as a list of changes, and
`git blame` should land on a commit whose body explains the whole change — not on
`Poll H15 grab without animation frames`.

Agents working a round commit to their own branch only and never merge (`agents/round-implementer.md`).
The coordinator writes the squash message, with the whole branch diff in hand.

## Cutting a release

1. Draft the notes from the trailers:

   ```bash
   scripts/collect-changelog.sh            # since the last tag
   ```

   It prints the trailers grouped under Keep a Changelog headings, then lists every `feat`/`fix`/
   `perf` commit with **no** trailer. Decide about each of those before moving on — that list is the
   only thing standing between a user-visible fix and its silent omission.

2. Rewrite the draft in the reader's voice under a new `## [x.y.z] - YYYY-MM-DD` heading in
   `CHANGELOG.md`, and move `[Unreleased]` above it. The `release-notes` skill does this step.

3. Bump the version (`src/CouchCoop.Mod.Loader/couchcoop.json` here) and commit both together:

   ```bash
   git commit -m 'chore(release): v0.1.2'
   ```

4. Tag and push the tag. Tags are annotated and signed (`tag.gpgsign`, set by the installer when a
   signing key exists) because the release workflow triggers on them:

   ```bash
   git tag v0.1.2 -m 'CouchCoop v0.1.2'
   git push origin main
   git push origin v0.1.2
   ```

`.github/workflows/release.yml` then packages the archives and publishes the GitHub Release with
`--notes-file` fed by `scripts/changelog-section.sh`, which fails the release if that version has no
section. Pushing is always explicit — no agent pushes a branch or a tag on its own.

### What a release publishes

One **archive per STS2 reference lane**, each lane named after a game Steam branch
(`eng/Sts2.ReferenceSdk/<lane>/`, reviewed by `scripts/verify-sts2-reference-sdk.sh`):

| asset | what it is |
|---|---|
| `couchcoop-<tag>.zip` | the `stable` lane. **This name is a contract** — the README's `gh attestation verify <zip>` block and every existing download link point at it, so it is never suffixed. |
| `couchcoop-<tag>.SHA256SUMS` | that archive's checksum, `sha256sum -c`-able offline |
| `couchcoop-<tag>-<lane>.zip` | every other lane, e.g. `-public-beta` |
| `couchcoop-<tag>-<lane>.SHA256SUMS` | that archive's checksum |

`scripts/package-release.sh` emits **all lanes in one invocation** — it clones the two pinned sibling
repositories once and then stages a payload per lane — because the workflow calls it once and
publishes `dist/*` and attests `dist/*.zip` wholesale. `COUCHCOOP_RELEASE_STS2_LANE` narrows a local
run to one lane. Lane facts a release depends on live in `scripts/lib/release-lanes.sh`.

Two things used to be published beside each archive and are not any more:

- **The per-file contents manifest.** `scripts/verify-release-archive.sh --archive` recomputes it
  from the zip, so shipping it added an asset without adding a check. `--emit-contents <file>` writes
  one locally for anyone who wants it.
- **`build-info.json`.** The build metadata is the only thing about a release the archive cannot
  otherwise tell you — with one archive per game branch it is the record of which game API a zip
  targets — so it moved **inside** the payload, as `couchcoop/build-info.txt`.

  The extension is load-bearing. STS2 lists a mod directory and reads every filename ending in
  `.json` as a mod manifest, and Godot's hidden-file test is a dot prefix on Unix but
  `FILE_ATTRIBUTE_HIDDEN` on Windows, which a zip-extracted file never carries. A
  `.build-info.json` would be skipped on Linux and scanned as a broken manifest on every Windows
  player's machine. The verifier rejects any second root-level `.json` for that reason; do not
  "fix" the extension back.

**`SHA256SUMS` stays, deliberately.** A manifest that travels with the payload is a *consistency*
check, not an *authenticity* one: anyone who rewrites a payload rewrites its manifest in the same
pass. Authenticity comes from GitHub's per-asset digests and the workflow's `actions/attest`
signature, and one small checksum file next to them costs nothing while working offline and without
`gh`. It is not redundant with the in-payload metadata, and it is not a candidate for simplification.

### `min_game_version`, and what it cannot do

A lane built against a newer game's references stamps that game as the payload manifest's
`min_game_version` (`v0.111.0` for `public-beta`; the `stable` payload declares no floor). The game
compares it as a semantic version, a leading `v` is accepted and is its own rendering in
`release_info.json`, and there are two failure modes: `GAME_VERSION_UNSUPPORTED` for a game older
than the floor, which is the point, and `GAME_VERSION_INVALID` for a value that does not parse —
**which fails the mod on every build, the right one included**, and is therefore worse than no floor
at all. So the literal lives in one place, that place refuses to emit anything but
`vMAJOR.MINOR.PATCH`, and the payload gate re-checks the stamped value independently.

Being a *minimum*, it makes the beta archive refuse an older game loudly, but nothing stops the
stable archive from loading on a newer game: there is no `max_game_version`, and only the Workshop's
`maxBranch` scopes downward.

## Publishing to the Steam Workshop

The GitHub Release is the source of truth; a Workshop item is a copy of an archive that has already
been published there. `scripts/upload-workshop-release.sh` downloads the latest release (or reads
`--dist <dir>` for a local one), verifies it against its checksums and its own in-payload
`build-info.txt`, replaces the workspace's `content/`, writes the `changeNote`, and runs the official
uploader:

```bash
scripts/upload-workshop-release.sh                       # latest GitHub Release → public item
scripts/upload-workshop-release.sh --dist dist           # a local archive instead
scripts/upload-workshop-release.sh --lane public-beta \
  --workspace .sts2/uploader/Workspace.dev               # the beta lane's archive
```

`--lane` defaults to `stable` and is the *only* thing that selects a lane. With both lanes' archives
sitting in one `dist/`, "newest by version" would silently publish one game branch's payload to the
other branch's item, so the flag is explicit and the gate then re-checks the chosen archive's
`build-info.txt` against it. A `--snapshot` build is refused by name: a Workshop item copies an
archive that exists as a GitHub Release, and a snapshot has no tag.

Three properties of that script are load-bearing, and all three exist because of an incident:

- **It writes the change note and nothing else.** The workspace's `workshop.json` *is* the live
  item's configuration, so a release upload has no business rewriting the rest of it. `--visibility`
  is applied only on a first publish — no `<workspace>/mod_id.txt` yet — or when you pass the flag
  explicitly. Before that rule, a bare run flipped the public listing to `private`.
- **There is no `previews/` directory in the workspace, deliberately.** The uploader reads a present
  `previews/` as the *complete desired gallery* and deletes anything missing from it remotely; that
  destroyed the item's only additional preview in v0.1.1. The gallery is curated in the Steam web UI
  now, web-added previews may carry no filename the uploader can match, and upstream's documented
  switch is that an absent `previews/` leaves all previews unchanged. Do not recreate it, and do not
  make a script require it. (Local diagnosis: `.agents/memory/workshop-uploader-workspace-sync.md`.
  The real log is `.sts2/uploader/mod-uploader.log`; the repo-root one is empty and misleads.)
- **The uploader binary stays put; the workspace moves.** `ModUploader` needs `libsteam_api.so` and
  `steam_appid.txt` beside it, so it always runs from `.sts2/uploader`, and the workspace is picked
  with `--workspace <dir>` or `COUCHCOOP_WORKSHOP_WORKSPACE_DIR`, defaulting to
  `.sts2/uploader/Workspace` — the public item. One 14 MB binary serves every item.

Self-test, with a mock uploader and fixture workspaces — no Steam, no network:
`bash scripts/test-upload-workshop-release.sh`. Run it after any change to the upload script.

### Branch scoping, and a timeout that is not a failure

The Workshop can scope an item to a range of game branches, and `workshop.json` carries it as
`minBranch` / `maxBranch`. The release script passes them through untouched, like everything else
the workspace declares.

**The trap is the reporting, not the feature.** An upload carrying either key sits in
`k_EItemUpdateStatusCommittingChanges` for minutes and then the uploader gives up with
`k_EResultTimeout` — **while the change commits anyway**. That is the client running out of
patience, not Steam rejecting the update, so the non-zero exit is not the thing to trust. Measured
on the DEV item on 12 Sep 2026: the item ended up correctly linked to `public-beta` at both ends
despite every such run reporting failure.

So when a branch-scoped upload reports `k_EResultTimeout`, **check the item page before retrying** —
a blind retry just republishes the same content and waits out the same timeout. The script prints a
note to that effect when it sees the keys. The vendored `Workspace/README.md` says the same thing
more vaguely ("seem to have weird behavior ... Prefer updating them on the web instead"), and the
web UI's *Update Linked Game Version* dialog is where to confirm or adjust the range by hand.

The game enforces the player's side regardless: it asks Steam which branches an item supports and
raises `STEAM_BRANCH_UNSUPPORTED` rather than half-loading a mod built for another branch.

### The unlisted DEV item

To put a build in front of real players before the public listing moves, publish it as a **second,
unlisted** Workshop item from a second workspace. Unlisted, not `friends_only`: an unlisted item is
reachable by direct link by anyone it is handed to, without being a Steam friend, and stays out of
Workshop browse and search.

Created once, by the maintainer, with their own Steam session:

```bash
cd .sts2/uploader && ./ModUploader new -w "$PWD/Workspace.dev"
```

Then in `Workspace.dev/`: set `"visibility": "unlisted"` and a title that reads as a test build in
`workshop.json`, replace `image.png` with one under 1 MiB, and leave `previews/` **absent** (the
template creates none). The first upload creates the item and writes its ID to
`Workspace.dev/mod_id.txt`; later ones can omit `--visibility` entirely:

```bash
scripts/upload-workshop-release.sh --dist dist \
  --workspace .sts2/uploader/Workspace.dev --visibility unlisted
```

**The DEV item keeps the same mod id on purpose.** Both payloads declare `"id": "couchcoop"` and the
`couchcoop/` payload root, which is pinned by `scripts/verify-release-archive.sh` and by the
uploader's own extract check — and the mod is not safe against two instances of itself in one game
anyway. So the two items cannot be installed side by side, and testers need this, verbatim:

> **Unsubscribe** from the other CouchCoop item before subscribing to this one. Unchecking it in the
> in-game mod list is not enough. Both items install a mod with the same id, the in-game enable
> setting is keyed to that id, not to the Workshop item — so one checkbox covers both copies — and
> the loader refuses the second mod claiming an id already taken, leaving it failed. With both
> subscribed, which copy the game loads is not something you can choose. When you are done testing,
> unsubscribe here and resubscribe to the public item.

## Reading the history

`git log` on `main` is the history. **`priv` is not.** It is a frozen local archive of the
development history from before these repos were published — 2122 commits on couch, unrelated to
`main`'s history, in a mix of styles that predates this document. It is kept for archaeology
("when did this stop working?") and is never published, never committed to, and never a model for
how to write a commit here.
