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
`--notes-file` fed by `scripts/release-body.sh`: the version's `CHANGELOG.md` section, then a table
saying which download is for which game. It still fails the release if that version has no section —
it propagates `scripts/changelog-section.sh`'s exit status, which is what that gate always was.

The table's wording draws a distinction worth keeping: a lane with a manifest floor **requires** that
game version and refuses to load below it, while a lane without one is only **built against** the
version its references were pinned from and keeps working on newer builds of the same branch. Saying
"requires" for both would tell players the normal download stops working at the next game update. Pushing is always explicit — no agent pushes a branch or a tag on its own.

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

The GitHub Release is the source of truth; a Workshop item is a copy of an archive already published
there. With no arguments the script takes the latest release and publishes **every lane** to the
public listing — one revision per lane, each linked to the game branch its payload was built for:

```bash
scripts/upload-workshop-release.sh                    # latest GitHub Release -> public item
scripts/upload-workshop-release.sh --dist dist        # a locally built release instead
scripts/upload-workshop-release.sh --lane stable      # just one lane
```

It asks for confirmation before touching the public listing, and refuses non-interactively unless
`--yes` is passed. Change notes come from `CHANGELOG.md` — the same bytes the GitHub Release body
uses — on the default lane's revision; the other lanes' revisions point at it, because Steam shows
one note per revision and the list should not be duplicated.

### Localized public metadata

The public item's title and description are generated from the tracked `workshop/` source bundle.
English is the primary Steam language; the other 13 current STS2 languages are submitted as Steam
metadata-only updates. Edit the relevant Markdown description or `workshop/titles.json`, then run
`bash scripts/test-render-workshop-localizations.sh` before publishing. The renderer also checks
that every Quick Start label remains identical to the native `couchcoop_qr_button` localization.

Mega Crit's uploader support is still PR #12 rather than an upstream release. Once per local tooling
install, run `scripts/install-localized-workshop-uploader.sh`; it builds pinned commit
`84e755cea6bcfa014df3165c882f1824259245c6` into ignored `.sts2/uploader/` without copying its
source into this repository or disturbing workspaces, item IDs, previews, Steam settings, or logs.
Public uploads refuse an older or unverified uploader. The unlisted DEV workspace intentionally
remains English-only.

The release script sends the complete localization set with its first selected lane. Later lanes in
the same release omit that already-item-wide metadata, then the public workspace is restored to the
complete generated configuration. This reduces redundant Steam metadata revisions; it does not
publish anything until the maintainer runs the existing upload command and confirms it.

Each revision's heading names the payload's version and the game build it was made for, e.g.
`Release v0.1.2 — Slay the Spire 2 v0.107.1`. The version comes from the payload's own
`build-info.txt` rather than the archive name, because a snapshot's filename carries only a commit
sha while its payload carries `<base version>+snapshot.<sha>` — and a Steam page otherwise shows
nothing but a branch chip.

Four properties are load-bearing, and each exists because of an incident:

- **It writes the change note and the branch link, and nothing else.** The workspace's
  `workshop.json` *is* the live item's configuration. `--visibility` applies only on a first publish
  — no `<workspace>/mod_id.txt` yet — or when passed explicitly. Before that rule a bare run flipped
  the public listing to `private`.
- **There is no `previews/` directory in the workspace, deliberately.** The uploader reads a present
  `previews/` as the *complete desired gallery* and deletes anything missing from it; that destroyed
  the item's only additional preview in v0.1.1. The gallery is curated in the Steam web UI now, and
  upstream's documented switch is that an absent `previews/` leaves previews unchanged. Do not
  recreate it. (Diagnosis: `.agents/memory/workshop-uploader-workspace-sync.md`. The real log is
  `.sts2/uploader/mod-uploader.log`; the repo-root one is empty and misleads.)
- **The uploader binary stays put; the workspace moves.** `ModUploader` needs `libsteam_api.so` and
  `steam_appid.txt` beside it, so it runs from `.sts2/uploader` and the workspace is chosen with
  `--workspace` or `COUCHCOOP_WORKSHOP_WORKSPACE_DIR`. A workspace may declare which lanes it is
  allowed to carry, one per line in `lane.txt`, checked for every lane before anything uploads.
- **A `--dist` directory holding two different releases is refused**, not resolved by "newest wins".
  A stale archive from an earlier build is how the wrong payload reaches an item; this has already
  caught a leftover `couchcoop-v0.1.0.zip`.

Self-test, with a mock uploader and fixture workspaces — no Steam, no network:
`bash scripts/test-upload-workshop-release.sh`. Run it after any change to the upload script.

### Branch scoping: one item, one revision per game branch

**Steam serves branch-scoped revisions, and its own UI states the rule.** The *Update Linked Game
Version* dialog on a revision says:

> You can link this version of your Workshop Item with a specific version of the game. Choose the
> earliest and latest version of the game your item works for (they can be the same). Any users who
> are playing on a version of the game that is between the two game versions you've specified will
> download and use this version of your Workshop item.

So the shape for two lanes is **one Workshop item, two uploads**, each linked to the game version its
payload was built for — not two items. Its version dropdown offers `Any`, `Latest Version`, and each
branch by name; for this app they line up with the game builds we target:

| dropdown entry | game build |
|---|---|
| `Latest Version (6/18/2026)` | stable `v0.107.1` |
| `public-beta (8/13/2026)` | beta `v0.111.0` |

`workshop.json`'s `minBranch` / `maxBranch` set the same thing at upload time, and the release script
passes them through untouched.

**The trap is the reporting, not the feature.** An upload carrying either key sits in
`k_EItemUpdateStatusCommittingChanges` for minutes and then the uploader gives up with
`k_EResultTimeout` — **while the change commits anyway**. That is the client running out of patience,
not Steam rejecting the update, so the non-zero exit is not the thing to trust. So when a
branch-scoped upload reports a timeout, **check the item page before retrying**: a blind retry just
republishes the same content and waits out the same timeout. The script prints a note when it sees
the keys, and the web dialog is where to confirm or correct a range by hand.

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
