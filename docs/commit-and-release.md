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
- **It may wrap.** Continuation lines are indented, and the collector rejoins them into one
  sentence. A trailer is not limited to what fits in the first line — v0.3.0 published
  "…so a player whose phone dropped out can", stopping mid-clause, because the collector used to
  keep only that first line. `scripts/test-collect-changelog.sh` now holds that case.
- `Refs: spirectl@<sha>` is an optional second trailer for work that spans the sibling repos, which
  `release-dependencies.json` pins by commit.
- **A sibling-repo fix earns no line here.** The collector walks this repo's commits only, so a fix
  landed in spirectl or godot-scene-web reaches couch's notes only if a couch commit carries its own
  trailer. When a sibling fix is what closes a user-facing issue here, write that line on the couch
  commit that picks it up — otherwise the release ships the fix and never tells anyone.

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

   Self-test, over a throwaway fixture repo — no network, no tags:
   `bash scripts/test-collect-changelog.sh`. Run it after any change to the collector. What it
   guards is that a published note cannot be silently mangled: a Workshop revision's change note
   cannot be edited after the fact, so a trailer the collector mishandles ships permanently.

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

`.github/workflows/release.yml` then packages the archive and publishes the GitHub Release with
`--notes-file` fed by `scripts/release-body.sh`: the version's `CHANGELOG.md` section, then a short
note saying what the download is for. It still fails the release if that version has no section —
it propagates `scripts/changelog-section.sh`'s exit status, which is what that gate always was.

Two things in that note are load-bearing, and `scripts/test-release-body.sh` asserts both:

- The payload **requires** the game version in its `min_game_version` and refuses to load below it,
  while the newer build it also carries a lane for is one it merely **carries a build for**, not one
  it is limited to. Saying "requires" of the newer one would tell players the download stops working
  at the next game update.
- The note must never say Steam hands a subscriber the build matching their game branch. It does
  not — see "One payload, one revision" below — and that exact sentence shipped as release prose
  until this shape replaced it.

Pushing is always explicit — no agent pushes a branch or a tag on its own.

### What a release publishes

**One archive**, carrying every STS2 reference lane:

| asset | what it is |
|---|---|
| `couchcoop-<tag>.zip` | the whole release. **This name is a contract** — the README's `gh attestation verify <zip>` block and every existing download link point at it, so it is never suffixed. |
| `couchcoop-<tag>.SHA256SUMS` | that archive's checksum, `sha256sum -c`-able offline |

Inside the payload, the game-version-sensitive assemblies sit one lane deep — `couchcoop/lanes/<game
version>/` — beside the shared frontend, licences and the `couchcoop/couchcoop.dll` the game loads by
the `<modDir>/<id>.dll` convention. That loader picks a lane at run time from the build it finds
itself in; nothing about the choice is baked into the download. A lane is named after a game Steam
branch on the way in (`eng/Sts2.ReferenceSdk/<lane>/`, reviewed by
`scripts/verify-sts2-reference-sdk.sh`) and after the game version it was pinned from on the way out,
because a directory the loader matches against a running game should be named for what it matches.

`scripts/package-release.sh` builds every lane in one invocation — it clones the two pinned sibling
repositories once and then stages the lanes into one payload — because the workflow calls it once and
publishes `dist/*` and attests `dist/*.zip` wholesale. That same wholesale publish is why it refuses
to start while `dist/` still holds a lane-suffixed `.zip` or `.SHA256SUMS` from the retired
two-archive shape: a leftover `couchcoop-<tag>-public-beta.zip` would go out as part of this release.

`COUCHCOOP_RELEASE_STS2_LANE` narrows a build to the lanes it names. That is a **local build, not a
publishable release** — the script says so as it starts, and the lanes are stated to the payload gate
rather than inferred from the zip: one `--lane <lane>` per lane built, plus `--complete` only when
every reviewed lane is present, which is the check a release run makes. A payload missing a lane
strands every player on that game branch, so it must fail the gate rather than ship. Lane facts a
release depends on live in `scripts/lib/release-lanes.sh`, which also owns the per-lane **game
floor** — the lowest game version a lane's assemblies are good for, and the name of the payload
directory they ship in. Every lane has one now; a lane without one could not be ordered against the
others and so could not be selected at run time.

There used to be a second archive, `couchcoop-<tag>-public-beta.zip`, and it is gone. Two archives
needed the Workshop to hand each subscriber the right one, and it cannot — see "One payload, one
revision" below, which is the whole reason this shape changed.

Two things used to be published beside the archive and are not any more:

- **The per-file contents manifest.** `scripts/verify-release-archive.sh --archive` recomputes it
  from the zip, so shipping it added an asset without adding a check. `--emit-contents <file>` writes
  one locally for anyone who wants it.
- **`build-info.json`.** The build metadata is the only thing about a release the archive cannot
  otherwise tell you — the record of which commit, which sibling pins and which game APIs a zip was
  built from — so it moved **inside** the payload, as `couchcoop/build-info.txt`.

  It is `couchcoop-release-build-info/v2`, and the part that changed with the merge is
  `dependencies.sts2References`: a set **keyed by lane**, not one object, because one payload is
  compiled against one pinned reference package per lane. Each lane's record carries that package's
  id, resolved version and content hash, the `gameBuild` it was pinned from, the `minGameVersion`
  floor that lane declares, its `bridgeGameApi` lane, the `laneDirectory` it ships in, and its own
  `nugetLockSha256` — the lane lockfile hash lives in the lane's record, so the release-wide
  `lockfileSha256` holds only the lane-independent locks. The gate holds the declared lane set and
  the shipped `lanes/` directories to each other in both directions: a record claiming a lane the
  archive does not carry is how a player on that branch is told they have a build they do not have.

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

A payload has one manifest, so it declares **one** `min_game_version`, and it is the **lowest** game
version any of its lanes was built for — `v0.107.1`. A floor cannot express a set, so that is all it
can say: anything older than the oldest lane is refused by the game itself, and everything above it
is the loader's decision inside the payload — which lane to load for the build it finds itself in,
and what to do when a running build matches none of them. Stamping the newest lane's version instead
would be the one genuinely destructive mistake available here: it would refuse the mod on the game
most players are running.

The game compares the value as a semantic version, a leading `v` is accepted and is its own rendering
in `release_info.json`, and there are two failure modes: `GAME_VERSION_UNSUPPORTED` for a game older
than the floor, which is the point, and `GAME_VERSION_INVALID` for a value that does not parse —
**which fails the mod on every build, the right one included**, and is therefore worse than no floor
at all. So the literal lives in one place, that place refuses to emit anything but
`vMAJOR.MINOR.PATCH`, and the payload gate re-checks the stamped value independently.

Being a *minimum*, it refuses an older game loudly and says nothing at all about a newer one: there
is **no `max_game_version`**, and nothing else scopes downward either. That is not a gap waiting for
a Workshop feature to fill it — the Workshop's `minBranch`/`maxBranch` look like the missing upper
bound and are not, for the reason in the next section. `min_game_version` is the only field that
actually refuses a mod on the wrong build.

## Publishing to the Steam Workshop

The GitHub Release is the source of truth; a Workshop item is a copy of an archive already published
there. One release is one archive, so it is **one revision**, linked to no game branch:

```bash
scripts/upload-workshop-release.sh                    # latest GitHub Release -> public item
scripts/upload-workshop-release.sh --dist dist        # a locally built release instead
```

It asks for confirmation before touching the public listing, and refuses non-interactively unless
`--yes` is passed. The change note is the version's `CHANGELOG.md` section — the same bytes the
GitHub Release body uses — under a heading naming the payload's version.

### Localized public metadata

The public item's title and description are generated from the tracked `workshop/` source bundle.
English is the primary Steam language; the other 13 current STS2 languages are submitted as Steam
metadata-only updates. Edit the relevant Markdown description or `workshop/titles.json`, then run
`bash scripts/test-render-workshop-localizations.sh` before publishing. The renderer also checks
that every Quick Start label remains identical to the native `couchcoop_qr_button` localization, and
that each description links the two discussion posts: the English one links the Steam threads in
`workshop/discussions/discussions.json`, and every other language links its own translations under
`workshop/discussions/<language>/` on GitHub. Those translations are only reachable once `main` is
pushed. The posts themselves are covered in [workshop/README.md](workshop/README.md).

Mega Crit's uploader support is still PR #12 rather than an upstream release. Once per local tooling
install, run `scripts/install-localized-workshop-uploader.sh`; it builds pinned commit
`84e755cea6bcfa014df3165c882f1824259245c6` into ignored `.sts2/uploader/` without copying its
source into this repository or disturbing workspaces, item IDs, previews, Steam settings, or logs.
Public uploads refuse an older or unverified uploader. The unlisted DEV workspace intentionally
remains English-only.

The release script sends the complete localization set with the release's one revision, and leaves
the public workspace holding that complete generated configuration. It does not publish anything
until the maintainer runs the existing upload command and confirms it.

The revision's heading names the payload's version, e.g. `Release v0.1.2`. The version comes from the
payload's own `build-info.txt` rather than the archive name, because a snapshot's filename carries
only a commit sha while its payload carries `<base version>+snapshot.<sha>` — and a Steam page shows
nothing else about what a revision even is. It deliberately does **not** name a game build any more:
one payload serves every branch, so naming one would be a false claim.

Five properties are load-bearing, and each exists because of an incident:

- **It writes the change note, and nothing else.** The workspace's `workshop.json` *is* the live
  item's configuration. `--visibility` applies only on a first publish — no `<workspace>/mod_id.txt`
  yet — or when passed explicitly. Before that rule a bare run flipped the public listing to
  `private`.
- **It never writes `minBranch` or `maxBranch` — it deletes them.** Both real workspaces still carry
  `minBranch = maxBranch = public-beta` on disk from the retired branch-linked shape. That residue is
  harmless: the upload config is generated per run and the keys are stripped out of it, so the next
  upload also rewrites the file without them. The reason they must never come back is "One payload,
  one revision" below. Removing them also retired a pathology that was only ever theirs: an upload carrying
  either key sat in `k_EItemUpdateStatusCommittingChanges` for minutes and then failed with
  `k_EResultTimeout` while committing anyway. Without them, an upload commits promptly and a
  non-zero exit is an ordinary failure — the script stops, and says to check the item page before
  retrying, because an uploader's exit code is a claim about the client and not about server state.
- **There is no `previews/` directory in the workspace, deliberately.** The uploader reads a present
  `previews/` as the *complete desired gallery* and deletes anything missing from it; that destroyed
  the item's only additional preview in v0.1.1. The gallery is curated in the Steam web UI now, and
  upstream's documented switch is that an absent `previews/` leaves previews unchanged. Do not
  recreate it. (Diagnosis: `.agents/memory/workshop-uploader-workspace-sync.md`. The real log is
  `.sts2/uploader/mod-uploader.log`; the repo-root one is empty and misleads.)
- **The uploader binary stays put; the workspace moves.** `ModUploader` needs `libsteam_api.so` and
  `steam_appid.txt` beside it, so it runs from `.sts2/uploader` and the workspace is chosen with
  `--workspace` or `COUCHCOOP_WORKSHOP_WORKSPACE_DIR`. A workspace may declare which lanes it is
  allowed to carry, one per line in `lane.txt`, checked before anything uploads. Since one payload
  carries every lane, a workspace has to allow them all — one pinned to a single lane can no longer
  publish a release, which is right, because no single-lane payload exists to give it.
- **A `--dist` directory holding two different release archives is refused**, not resolved by "newest
  wins". A stale archive from an earlier build is how the wrong payload reaches an item; this has
  already caught a leftover `couchcoop-v0.1.0.zip`, and it now also catches a leftover
  `couchcoop-<tag>-public-beta.zip` from the two-archive shape, which is the likelier stale file for
  a while yet.

Self-test, with a mock uploader and fixture workspaces — no Steam, no network:
`bash scripts/test-upload-workshop-release.sh`. Run it after any change to the upload script.

### One payload, one revision — and why not branch linking

**The rule: a release is one revision of one item, carrying every lane, linked to no game branch.
Never publish one revision per game branch.** This section is long because the alternative looks
correct, is documented as correct by Steam's own UI, and still reached real players broken.

Steam does offer branch-linked revisions. The *Update Linked Game Version* dialog says so:

> You can link this version of your Workshop Item with a specific version of the game. Choose the
> earliest and latest version of the game your item works for (they can be the same). Any users who
> are playing on a version of the game that is between the two game versions you've specified will
> download and use this version of your Workshop item.

`workshop.json`'s `minBranch` / `maxBranch` set the same thing at upload time. Read that paragraph
and the shape for two lanes is obvious: one item, two uploads, each linked to the branch its payload
was built for. That is what CouchCoop did, and **players on the normal game branch were served the
beta payload**, which the game then refused: *Mod CouchCoop declares min game version v0.111.0 higher
than current game version v0.107.1*. Resubscribing fixed it for a while — measured here at 34 minutes
once and 2 h 56 m another time — and then it came back.

**The cause is that the client has two update paths and only one of them honours the link.** Both are
visible by name in `~/.steam/steam/logs/workshop_log.txt`:

| log line | when it fires | which revision it takes |
|---|---|---|
| `Detected workshop change (author snapshot)` | subscribe, and first acquire only | the **branch-matched** revision — correct |
| `Detected workshop change (latest from server)` | every periodic refresh, roughly every 45 minutes, plus a full reconcile | the item's **newest** revision, branch-blind |

On this machine that was 8 occurrences of the first and 44 of the second. And the client has nothing
to reconcile against: `steamapps/workshop/appworkshop_<appid>.acf` stores exactly one `manifest` and
one `latest_manifest` per item, with **no per-branch field**. So a branch-linked scheme holds only
while the branch-matched revision for a given user is *also* the item's newest — true for at most one
branch at a time. Everyone else drifts onto the newest revision at the next refresh.

Which branch lost was decided by upload order: lanes were published default-first, so `public-beta`
was always last and therefore always newest, and every stable subscriber converged on it.

**No pair of `minBranch`/`maxBranch` values fixes this**, because the path that clobbers the payload
reads no range at all. Four things were ruled out before reaching that conclusion, and each is worth
knowing so nobody re-opens them: `Latest Version` is not a dynamic newest-build sentinel (the
changelog page's own script maps the default branch to that literal string); the stable revision did
exist, with its own `Works with game version` chip, beside the beta one; the app's branch-versioning
feature flag was on; and the `k_EResultTimeout` uploads had all committed, as the
`minBranch`/`maxBranch` note above describes.

**Nothing on the player's side catches the mistake either.** The game does ask Steam which branches
an item supports, but that check is **advisory**: it records a message and logs an error, and the mod
loads anyway. The only thing that actually refuses a mod on the wrong build is `min_game_version` —
which is why a beta-floored payload on a stable game failed loudly, and why a stable payload on a
beta game would have failed silently instead. Verified against both game builds' decompiled corpora;
the derivation is in `.sts2/research/workshop-branch-check-advisory-sep15.md`.

**The ecosystem agrees, for whatever that is worth as corroboration.** No STS2 Workshop mod uses
branch linking: RitsuLib (3747602295), MultiplayerLimitBreak (3747606832) and Unlimited (3747509118)
have zero `Works with game version` chips between them. RitsuLib ships one payload with per-version
variant folders and a single minimum version — the shape this document now describes — and is MIT and
public at <https://github.com/BAKAOLC/STS2-RitsuLib>.

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
