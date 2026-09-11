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

`.github/workflows/release.yml` then packages the archive and publishes the GitHub Release with
`--notes-file` fed by `scripts/changelog-section.sh`, which fails the release if that version has no
section. Pushing is always explicit — no agent pushes a branch or a tag on its own.

## Reading the history

`git log` on `main` is the history. **`priv` is not.** It is a frozen local archive of the
development history from before these repos were published — 2122 commits on couch, unrelated to
`main`'s history, in a mix of styles that predates this document. It is kept for archaeology
("when did this stop working?") and is never published, never committed to, and never a model for
how to write a commit here.
