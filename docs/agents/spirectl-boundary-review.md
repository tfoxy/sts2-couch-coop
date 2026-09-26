# Should CouchCoop keep its runtime in spirectl? — review

Prepared 2026-09-26 in answer to [handoff-spirectl-boundary-review.md](handoff-spirectl-boundary-review.md).
**Analysis only: no code moved, `CLAUDE.md` and `AGENTS.md` untouched.** The maintainer decides. Numbers are from a
Release build of `CouchCoop.Mod` against the V111 game-API lane at commit `d2958cf9` (spirectl `386c7ed6`); each
figure names its source, and estimates are labelled as estimates.

## Recommendation

**Option B, staged, governed by Option D's rule, with geoclip as the one named exception.**

1. **Adopt "reuse is earned" now** (wording in §9). New runtime code starts CouchCoop-side and moves to spirectl
   only when a second consumer exists. This makes the two exceptions already granted (`7d089e03`, the hosting
   tracker) policy instead of case-by-case permission.
2. **Take CouchCoop off the full state snapshot (P1), then stop compiling what CouchCoop cannot reach into its
   copy (P2).** Together these remove about **28K LOC and a third of the IL** (§2) from `CouchCoop.Spirectl.dll`
   and about **88% of its by-name game reflection** (about 1,000 of about 1,150 call sites), without moving a
   line into CouchCoop.
3. **Move CouchCoop-only machinery (scene watcher, animation hooks, embedding ports; up to about 18K LOC) only when
   CouchCoop next has to change it (P3, "on touch")**, not as a migration project.
4. **Geoclip stays in spirectl.** The maintainer intends it as a spirectl tool for cheap animated Spines without
   the Spine library. It is 17.3% of the IL, the largest single component, and has no spirectl consumer *yet*:
   record that as a named exception with a trigger (the first spirectl consumer), so "reuse is earned" does not
   silently evict it.

Rejected: **C** (CouchCoop owns its runtime) duplicates the shared asset extractor, the hook substrate and a lane
table whose own header warns that two copies disagree, and it ends QA reading the product's extraction code.
**A** (trim in place) is kept as a *tool*, because P2 is exactly a compile profile, but not as the end state: it
leaves the CouchCoop-only code, and the paired-landing procedure that goes with it, where they are.

A finding to hold alongside this: **the timed legs are not the slow part** (§3: 78 s CouchCoop-only against 163 s
through spirectl). The cost is procedural (worktrees, hook pins, two landings, two deploys), and the case for
moving code rests on DLL growth, unearned reuse, the reflection surface and startup fragility more than on speed.

## 1. What was checked, and corrections to the handoff

Method: three read-only surveys (CouchCoop's use of the project, spirectl's other consumers, churn/licensing/
boundary scripts), a scratch Release build with per-source-file IL attribution from the portable PDB, a path-based
churn recount, and a timed round trip. Load-bearing claims were re-checked by hand: the composition factory, the
action dispatcher, the legacy-extractor consumers, the csproj compile lists.

Corrections to what the handoff states or implies:

- **The action list is incomplete.** CouchCoop's source names 11 semantic action kinds, not five: `HoverElement`,
  `MouseClick`, `KeyInput`, `ControllerInput` (browser input), `SelectMapNode`, `SetScrollOffset`, `ClaimReward`
  (explicit browser allow-list), `DisconnectClient`, `SetClientName`, and `JoinLobbyPlayer` / `LeaveLobbyPlayer`.
  Of those, `JoinLobbyPlayer` has no live caller and `LeaveLobbyPlayer` is always refused, because CouchCoop's
  seats are real ENet clients. `ClaimReward` is still allow-listed although the frontend no longer sends it
  ([architecture-map.md](architecture-map.md) says it was removed). `SelectMapNode` and `SetScrollOffset` are the
  two "awaiting the maintainer's call" rows in that same table. The dispatcher compiles 64 kinds; 8 are exercised.
- **`verify-reflected-game-members.sh` is a spirectl script**, and nothing runs it: not `validate.sh`, not
  `release.yml`, not a CouchCoop script. It hard-codes spirectl's own source tree.
- **"The last 60 days" crosses a squash.** Both repos' `main` are squash re-publications (spirectl root
  `9a430576`, 2026-09-10; couch root `f6058ff1`, 2026-09-11) over an unrelated frozen `priv` history. The handoff's
  "22 of 31" is right for `main` but includes the root commit; the real figure is **21 of 30**. Churn below
  reports the `priv` window (2026-08-25 to 09-10) and `main` after the root separately.
- **`Core.State` has five consumer sites, not a `using` count.** `ConnectionHostingTracker` reads it through
  `var` and has no `using` for it (§2, "State snapshot").
- **The `Live/**` compile glob has a stale hand-maintained `Exclude` mirror**: 5 of its entries name files that no
  longer exist (`Live/Debugging/*`, `Sts2ScenarioProvider`, `Sts2RecordedFixtureProvider`,
  `Sts2BackgroundThrottleOptions`), and `Live/Sts2SceneSubtreeStillKey.cs` is listed twice (warning CS2002).
- **`@spirectl/presentation`'s only consumer is CouchCoop** (§10).

## 2. Inventory

Everything in `Spirectl.Sts2` is compiled into the embedded DLL: `CouchCoop.Mod.csproj` forces
`EnableSts2LiveHost=true`, so the whole `Live/**` glob comes along. **279 files, 95,657 LOC, 1,320,084 IL bytes
(20,452 methods).** Release `CouchCoop.Spirectl.dll` is 3,685,376 B (IL is 36% of it; metadata is 64%), against
2,212,352 B for `CouchCoop.Mod.dll`. A linker cannot help: from the type names CouchCoop mentions, 273 of the 279
files stay reachable, because the composition factory and the action dispatcher's switch pin almost everything.
Only the cuts named below reduce the DLL.

How to read the table:

- **IL** is method-body bytes per source file, from the PDB (exact; 0.27% unattributable). Record members without
  sequence points are attributed to their type's dominant file, which is why DTO files are IL-heavy per LOC.
- **CouchCoop use** is *direct* (named in `src/`), *transitive* (reached through something CouchCoop calls) or
  *dead* (constructed or installed but never reached).
- **Commits** are `priv` 2026-08-25..09-10 / `main` after `9a430576`, counting non-merge commits that touch a `.cs`
  file that still exists at the tip. `priv` also had 30 commits touching files since moved out to the bridge.
- **R** = by-name reflection call sites; **H** = Harmony classes / patch sites. Both are approximate counts.
- **Verdict:** **shared** (a real second consumer exists, named), **CouchCoop-only** (none today), **retained**
  (CouchCoop-only today, kept by maintainer intent), **dead in copy** (CouchCoop cannot reach it; the bridge/CLI can).

| Component | LOC | IL KB (%) | CouchCoop use | Other consumer | Commits | Coupling | Verdict |
| --- | ---: | ---: | --- | --- | ---: | --- | --- |
| Geoclip baker + core | 15,392 | 228.0 (17.3) | transitive | none in use: the bridge installs an env-armed startup bake that no script or doc calls | 58 / 1 | 2 of 9 files Godot-typed | **retained** |
| Asset extraction + render helpers | 13,203 | 139.5 (10.6) | direct + transitive | CLI `assets extract/explain`, IPC, MCP, `validate.sh` legs | 22 / 3 | R25 | shared (Explain lane and composed-encounter keys dead in copy) |
| Core/State: legacy lane + rest | 2,721 | 113.0 (8.6) | dead | bridge scenario, fixture and debug providers | 1 / 0 | – | dead in copy |
| Core/State: `StateSnapshot` | 733 | 84.2 (6.4) | direct (5 sites, small subset) | CLI/MCP `state`, scenarios | 0 / 0 | – | shared; **dead for CouchCoop after P1** |
| Live: `Sts2ActionHandler*` (15 partials) | 8,558 | 79.3 (6.0) | 8 of 64 kinds live | CLI `act`, IPC (57 kinds), scenarios | 4 / 4 | R169 | shared; **about 73% of method LOC dead in copy** |
| Live: scene watcher, producer, folds, caps | 9,033 | 73.6 (5.6) | transitive | none (not in proto; presentation not fed by it) | 9 / 2 | R4 | **CouchCoop-only** |
| Core/SceneInspection | 1,211 | 69.9 (5.3) | direct | delta DTOs: none; tree/node models: `sts2 dev scene` | 6 / 0 | – | CouchCoop-only (delta), shared (tree) |
| Embedding ports, hubs, capabilities | 3,175 | 64.2 (4.9) | direct + transitive | state hub and combat-event hub: bridge (`state watch`, `events watch`); other ports: tests only | 21 / 4 | – | mostly CouchCoop-only |
| Live: screen/overlay inspectors + locator | 5,800 | 56.1 (4.3) | transitive (feeds state builders) | CLI `state` | 0 / 0 | R340 | shared; **dead for CouchCoop after P1** (scene watcher keeps only the locator) |
| Live: observation provider + geometry + presentation resolvers | 5,200 | 54.6 (4.1) | dead (constructed, never invoked) | bridge scenario/fixture path | 2 / 1 | R68 | dead in copy |
| Core/Models | 588 | 53.3 (4.0) | direct | CLI `models` | 0 / 0 | – | shared |
| Core/Artifacts (DTOs) | 822 | 43.6 (3.3) | direct | CLI assets | 4 / 1 | – | shared |
| Live: state builders + projection | 5,217 | 40.7 (3.1) | runs on every state read; output mostly dropped | CLI/MCP `state` | 3 / 2 | R426 | shared; **dead for CouchCoop after P1** |
| Live: model catalog + reference provider | 3,112 | 29.8 (2.3) | catalog: asks for 3 of at least 11 families; reference: dead | CLI `models`, `reference` | 4 / 2 | R13 | shared (reference dead in copy) |
| Live: card-flight, tween, hand, particle hooks + math | 4,082 | 28.7 (2.2) | transitive | none (bridge only tallies hints) | 4 / 1 | H 5 / 7, R~10 | **CouchCoop-only** |
| Common (ids, action catalog, scene text diagnostics) | 5,465 | 47.2 (3.6) | transitive | mixed | 7 / 4 | R28 | mixed; action catalog is serialized into every `session` envelope with no reader found |
| Live: Spine (non-geoclip) hooks, inspector, materials | 2,890 | 17.8 (1.3) | transitive | CLI still lanes | 6 / 1 | H 1 / 3 | shared (weak) |
| Live: infrastructure (dispatcher, composition, introspection, screen context, build identity, MonoMod) | 2,803 | 17.7 (1.3) | direct | dispatcher, build identity, MonoMod: bridge; screen context: none | 16 / 10 | R1 | shared (screen context CouchCoop-only) |
| Live: semantic-state hooks + host-local seat watchers | 1,913 | 17.0 (1.3) | installed; output feeds only dead lanes | bridge (`ClaimReward`, synthetic seats) | 2 / 4 | R55, H 4 / 4 | dead in copy |
| Core small (Actions, Logging, Reference, Perspective, Protocol, Combat, Map) | 1,081 | 33.9 (2.6) | Actions, Logging direct; Reference dead | CLI | 5 / 3 | – | shared |
| Live: EncounterVisuals | 742 | 13.5 (1.0) | 2 of 4 files via asset keys | CLI composed encounters, preflight | 2 / 0 | H 1 / 1 (bridge-only) | shared (2 files dead in copy) |
| GameApi (probe + V111 lane) | 703 | 4.7 (0.4) | transitive | both hosts, `cli/build.rs`, scripts | 0 / 4 | 20 requirements | shared |
| Live: combat-event hooks | 689 | 2.5 (0.2) | dead (no subscriber) | CLI `events watch` | 2 / 0 | H 3 / 3 | dead in copy |
| Live: browser key/pad maps + input helpers | 368 | 2.2 (0.2) | transitive | none | 0 / 1 | – | **CouchCoop-only** |
| Root files, unattributed | 156 | 5.0 (0.4) | 1 of 4 | – | 5 / 2 | – | – |

Totals reconcile: the rows sum to the 95,657 LOC and the 1,320,084 IL bytes. Per-file data and the roll-up script
are local (scratch), not committed.

### What the rows add up to

| Bucket | Rows | LOC | IL |
| --- | --- | ---: | ---: |
| **Dead in copy today** | legacy state lane, observation provider group, semantic-state hooks, combat-event hooks, `Core/Reference`, and the unreached 73% of the action handler | about 16.2K (17%) | about 252 KB (19%) |
| **Dead once P1 lands** | `StateSnapshot`, state builders, screen inspectors | 11.8K (12%) | 181 KB (14%) |
| **CouchCoop-only, movable** | scene watcher, scene-delta DTOs, card-flight hooks, embedding ports, key/pad maps | about 17.9K (19%) | about 239 KB (18%) |
| **Retained by intent** | geoclip | 15.4K (16%) | 228 KB (17%) |
| **Shared and used** | asset extraction, Spine, models, encounter visuals, infrastructure, GameApi, the rest | remainder | remainder |

The first two rows are what P1 + P2 remove: about **28K LOC, 433 KB of IL, a third of the embedded code**. The
by-name reflection follows the same split: state builders (426), inspectors (340), observation provider (68), the
dead action-handler share (about 123) and semantic-state hooks (55) hold about **1,010 of about 1,150 call sites
(88%)**, and every one of them is in a row CouchCoop will not use after P1. The reflection CouchCoop's own used code
does is small: asset extraction 25, model catalog 13, scene watcher 4, Spine 4.

Other findings behind the table:

- **Dead code still costs startup.** The game-API manifest has 20 requirements, about 8 of which exist for synthetic
  seats, damage preview and potion gating. A miss throws and aborts runtime creation
  (`Sts2GameApiProbe`), so a game update can stop CouchCoop from starting over members only dead lanes read.
  The composition also runs 17 hook or watcher installs at startup regardless of demand, several of them for dead
  lanes.
- **Two compile modes already exist.** The csproj compiles an always-on Godot-free list plus the `Live/**` glob
  behind `ENABLE_STS2_LIVE_HOST`, and bridge-only code was moved out of the project in the last weeks
  (78 renames into `BridgeMod` / `Sts2Host/Live/BridgeOnly` in the `priv` window; `Sts2AssemblyBoundaryTests` keeps six
  bridge-only types on purpose). An ownership split has precedent; P2 extends a mechanism, it does not invent one.
- **Two copies.** The bridge and CouchCoop both call `Sts2ReusableLiveCompositionFactory.Create`, so the hook set and
  lane probe are identical, but they are separate binaries and separate deploys. Profiling one does not measure the
  other ([handoff-host-cpu.md](handoff-host-cpu.md)).
- **CouchCoop duplicates a little already**: the offscreen-extraction name is respelled as a string, the
  static/volatile scene-field split is hand-copied, and the build-identity ladder is re-implemented in
  `CouchCoopLaneSelection`.
- **State snapshot.** The five consumer sites, all reading a handful of fields (root scene, net game type, run and
  lobby player rows, lobby capacity and saved-run ids):
  `CouchCoopMod.cs` `TryGetLobbyState` (QR panel and pause-menu gates);
  `BrowserStateEnvelopeFactory` (session envelope, `BrowserAssignmentState`);
  `CouchCoopStateObserver` (50 ms subscription: run-end reap, roster signature, roster names);
  `CouchCoopLobbyParticipation.CurrentState`;
  `ConnectionHostingTracker` (500 ms subscription).
- **Churn on `main` since publication** is spread thin: infrastructure 10 commits, `GameApi` 4, embedding 4,
  semantic-state hooks 4, action handler 4, asset extraction 3. Of the 21 real commits, **15 (71%)
  were driven by CouchCoop**, 4 by game updates, 1 by the CLI/QA, 1 mixed. Geoclip was 58 of the 105 path-touching
  `priv` commits in the build-out window (19,891 lines changed, about 129% of its own size in 16 days) and 1 commit
  since publication: hot then, quiet now.
- **Pairing.** 10 CouchCoop commits changed the spirectl pin in `release-dependencies.json`; counting `Refs:`
  trailers and commits that consumed a spirectl change without one, about 19 to 21 of 252 (about 8%) needed a paired
  spirectl change. Six of the ten pin bumps landed within 47 minutes of the spirectl commit.

## 3. What the boundary costs

**The finding that cuts against the handoff's premise: machine time is not where the boundary costs.** One timed
no-op round trip (2026-09-26, scratch build, `flock --close`, 12 cores, load average 0.8 to 7 with two unrelated game
processes present; each leg once, `bridge-tests` three times) touched one CouchCoop-only file, then one shared file:

| Leg | Route | Seconds | What it is |
| --- | --- | ---: | --- |
| A1 | CouchCoop-only | 7.2 | incremental Release build of the mod |
| C4 | CouchCoop-only | 19.2 | build the `Mod.Tests` project (Debug) |
| **A2** | **CouchCoop-only** | **78.0** | **build + run the `connections` suite (the suite itself is about 59 s)** |
| C5 | via spirectl | 18.0 | same build after touching a shared file: no measurable extra compile |
| B1 | via spirectl | 78.4 | rebuild of the shared project + mod + the same suite |
| B2 | via spirectl | 11.9 | `validate-spirectl-embedded-boundary.sh` |
| B3, C1, C2 | via spirectl | 24.9, 24.5, 24.9 | `validate.sh bridge-tests`, alone: 2,072 tests pass (the test run itself is 5 s) |
| B4 | via spirectl | 17.6 | `validate.sh bridge-build` (Sts2Host); 17.3 s with an explicit `-p:EnableSts2LiveHost=true` |
| C3 | via spirectl | 30.4 | live-host tests with the documented `Sts2HostTests` exclusion: 2,270 pass, **9 fail on clean `main`** |

CouchCoop-only round trip: **78 s**. Spirectl-routed (B1 + B2 + B3 + B4 + C3): **163 s**, so about **+85 s (2.1×)**.
Where it goes: the CouchCoop suite dominates both routes; recompiling the 95K-LOC shared project costs nothing
measurable on top; the extra 85 s is the four spirectl-side legs, the biggest being the live-host test leg, which is
**red on a clean checkout** (9 failures: 5 in the embedded asset provider tests, 3 in main-menu start-run tests, 1 in
the encounter-visual catalog tests), so a change is judged against a known-failure list by name, not by a green run.
The spirectl legs use a cold compiler (`-nodeReuse:false -p:UseSharedCompilation=false`); CouchCoop's use the warm
one, so part of the gap is flags, not code.

So the maintainer's concern ("a change validates much more slowly in spirectl") holds for **procedure and risk**, not
for CPU time. The steps that were **not timed**, and that the "5+ hours vs 2–3 hours" estimate in the handoff
rests on, are:

1. pair-root worktrees, `install-agent-config.sh` in each, a copied `sts2.local.yaml`, a scratch mods directory
   (estimate 10–20 min);
2. for a state-builder change, proof that the full snapshot stays byte-identical for the CLI, MCP and bridge
   (estimate 30–60 min or more);
3. Harmony hook and member pins in both lane manifests, where the older lane's method bodies cannot be inspected
   locally (estimate 20–40 min);
4. `bridge-tests` must run alone (the MSB3030 parallel-MSBuild race), and `bridge-build` needs the game assemblies,
   so the legs serialize;
5. landing twice: a spirectl squash commit with a `Changelog:` trailer, then the CouchCoop pin bump with a `Refs:`
   trailer, both boundary and CouchCoop suites, and a redeploy of **both** copies (bridge and mod) so a measurement
   is not taken against the stale one (estimate 30–60 min);
6. a release cut needs the spirectl commit pushed, because `package-release.sh` clones the pin from GitHub (a
   maintainer step).

These add up to roughly 2–4 hours (**estimate**), consistent with the handoff's figure, and none of it shows in the
table. A timestamp comparison from the roster round agrees in direction, though it is not a controlled measurement:
the spirectl-side contract (`77d5f2dc`, no provider yet) landed on a branch about 85 minutes before the CouchCoop-only
stopgap (`7d089e03`) that actually removed the poll.

Other receipts: Debug build with tests and embedded spirectl 21 s; Release pair-root scratch build 41 s; a spirectl
live-host compile 49 s (all from earlier local logs); no committed wall-clock exists for a `bridge-tests` run.

**Who pays.** About 19 to 21 of CouchCoop's 252 commits (about 8%) needed a paired spirectl change; 10 changed the
pin; and 15 of spirectl's 21 real commits on the shared path since publication were CouchCoop-driven (§2). The route
is exercised almost only by CouchCoop's needs, on code CouchCoop alone uses or code CouchCoop no longer needs.

## 4. What the boundary buys

Weighed honestly, against what CouchCoop *uses* rather than what it compiles:

- **A lane table, single-sourced.** `Sts2GameApi.props` maps game version to lane, refuses to guess, and has four
  readers (spirectl MSBuild, CouchCoop's `Directory.Build.props`, `cli/build.rs`, a script); its header warns that two
  copies would disagree. **Real, and independent of where runtime code lives**: it stays in spirectl under every
  option except C.
- **Protection from game updates.** `verify-reflected-game-members.sh` sweeps 414 distinct by-name reads (70 more in
  bridge-only code) between two game builds and exits 3 on a one-sided name. It is a good guard, but (a) it has no
  runner, (b) about 88% of the reflection call sites it protects are in code CouchCoop will not use after P1, and
  (c) CouchCoop's own gates are different and already local: no by-name readers in its own code, 43 Harmony targets
  pinned by `beta-targets`, `code verify-references` on the shipped DLLs. The manifest probe is a mixed blessing: it
  also makes dead-lane members fatal for CouchCoop (§2). The embedded-boundary script is a **drift** check (the copy
  must match upstream within 4 KB), not a game-update guard, and it works only in the sibling layout.
- **QA reading the product's code.** True for asset extraction and stills (effect stills are baked through
  `sts2 assets extract`). Not true for state (the product is leaving it) or the scene stream (the bridge does not
  serve it, so QA cannot observe the mirror's producer through the CLI at all).
- **One place to fix when the game changes.** True for shared code. For CouchCoop-only code the "one place" is the
  place CouchCoop has to land through the paired route, and the twin fixes `496d2753` / `93e89c08` show CouchCoop
  already patching around it.
- **The heavy machinery** (asset extraction, Spine, geoclip: 46% of the IL) benefits from staying where the CLI can
  also use it. Splitting it is what would make option C expensive.

## 5. Licensing and NOTICE

No blocker either way.

- Both repos are **Apache-2.0** with byte-identical `LICENSE` files; the shared project declares
  `PackageLicenseExpression` Apache-2.0 and has no NuGet package references.
- The `NOTICE` files differ in holder text ("Tomás Fox" vs "spirectl contributors") and third-party credits, but
  nothing in spirectl's `NOTICE` applies to `Spirectl.Sts2` beyond the non-affiliation wording CouchCoop already
  carries. There are no SPDX or copyright headers to rewrite in the shared project.
- Moving a file in either direction needs only the ordinary Apache steps: keep the license, mark it as modified, and
  keep the scrubbed provenance from the Sep-4 extraction round (no "decompiled" wording, no quoted game bodies).
- CouchCoop keeps `licenses/spirectl-LICENSE` and `licenses/spirectl-NOTICE` for as long as any spirectl code or
  `@spirectl/presentation` ships; `verify-release-archive.sh` requires both, and forbids a default-named
  `Spirectl.Sts2.dll` (the embedded copy must stay `CouchCoop.Spirectl.dll`).
- `package-release.sh` requires the sibling checkout to equal the pinned commit and clones it from GitHub, so a split
  does not change release mechanics beyond a smaller subset being compiled. Public visibility of `origin` is inferred
  (CI clones spirectl without credentials), not verified.

## 6. Options

Effort figures are **estimates**, in working days of one person, except where marked measured.

| | Migration effort | Drift across game updates | QA impact | Fixes the maintainer's concern |
| --- | --- | --- | --- | --- |
| **A. Status quo, trimmed** (compile profile in spirectl) | 1–2 days for the profile plus rewriting the 4 KB drift check | unchanged; fewer members in the manifest, so fewer fatal startups | none (the bridge keeps the full set) | DLL growth: yes (about a third). Reuse-that-may-never-happen: no. Paired-landing procedure: no |
| **B. Split by ownership** | A, plus P1 (3–5 days), plus P3 on touch (about 1–2 weeks in total, spread out) | moves about 15–20 by-name reads and 5 hook classes (7 patch sites); the lane table stays single-sourced | none for the CLI; the CouchCoop-only pieces were never in the bridge's served surface | all three, over time |
| **C. CouchCoop owns its runtime** | 3–4 weeks, then a permanent second copy of asset extraction, Spine, the hook substrate and the manifest | doubles: every game update lands twice, about 90 by-name reads and 8 hook classes (14 patch sites) duplicated | loses shared extraction code; `sts2 assets extract` and the product diverge | DLL growth and the paired-landing procedure: yes. DRY: no, it trades it for duplication |
| **D. Relaxed rule** | 0 (wording) | unchanged | none | stops the growth and the "unearned reuse" habit; does not shrink or speed anything already there |

B's cost is dominated by P3, which is why the recommendation makes P3 opportunistic. The cheap, certain wins are P0,
P1 and P2.

## 7. Recommendation, phased

The first step is small and independently useful; every later step can be stopped without regret.

- **P0. Wording (no code).** Adopt §9. Effect: agents stop asking permission for CouchCoop-side reads, and the
  geoclip exception is on record.
- **P1. Retire the remaining full-state reads CouchCoop-side.** The first, the hosting tracker, landed as `b6a1ec12`,
  and its state-subscription fallback was then removed by the maintainer's decision (`a9f382b6`); the tracker no
  longer takes the runtime host. What remains is best counted by **read path**, not by file (the "five consumer
  sites" above group them): the QR host panel and pause-menu lobby gates, `CouchCoopStateObserver`, the session
  envelope, the join path, admission and the player cap, the seat join wait, and the browser-disconnect run check.
  **One bounded recurring read remains**: the QR host panel's 0.25 s chain pulls the full lobby state on every tick
  while a lobby screen is current, and the observer runs a 50 ms subscription while a viewer is parked on the join
  picker. The tracker was the last *unbounded* poll. So the lobby gates are the most valuable path, and the rest
  matter mainly because P2 waits on them. [handoff-spirectl-boundary-implementation.md](handoff-spirectl-boundary-implementation.md)
  lists each path. Estimate 1–2 weeks for all of them, one commit per path; the first is a day or two.
- **P2. A compile profile in spirectl, once P1 has landed.** One spirectl change: an MSBuild-property profile that
  the embedded reference selects and the bridge does not; a composition-factory variant that does not construct or
  install the dead lanes; explicit item lists instead of the stale `Exclude` mirror; the 4 KB drift check replaced
  by "the embedded profile equals the upstream build of the same profile". Verify each hook individually before
  dropping it: a Harmony hook can change behavior, and the "dead" verdict for the semantic-state hooks is medium
  confidence. Estimate 1–2 days, plus one pass of spirectl's slow validation legs, once.
- **P2b (contingent). Make geoclip cheap to validate where it lives.** Its Godot-free core (7 of 9 files, 9.5K LOC,
  62% of its IL) needs only three outside files (`Sts2RenderPhaseProfile`, `Sts2SceneFitFrame`, and three types
  from `IAssetExtractProvider`). The baker (the two Godot-typed files) is the blocker: it calls four static members
  of the asset extractor. A small interface seam would let the core be its own project with an offline fixture leg.
  Only worth doing if geoclip work resumes; it is quiet now.
- **P3. Move CouchCoop-only machinery on touch**, in this order: scene watcher and scene-delta DTOs, animation hooks,
  then the embedding ports last (they are the seam, so they move only once their implementations have). The
  "up to about 18K LOC" figure counts all of it. Before moving anything, confirm with the maintainer that none of
  it is earmarked for a spirectl consumer (the scene stream is the likeliest question). Requires a small public
  "substrate" surface in spirectl (dispatcher, screen locator, introspection, build identity, the lane probe), and
  `verify-reflected-game-members.sh` given a runner that covers both trees.
- **P4. Steady state.** spirectl keeps state, actions, assets, combat events, models, reference, encounter visuals,
  geoclip and the Spine substrate, the dispatcher, build identity and the lane table. CouchCoop compiles only the
  substrate it uses.

## 8. In-flight work under this recommendation

- **The paused roster-port round stays stopped.** The spirectl contract (`roster-port`, `77d5f2dc`, 13 files,
  +1145/-0, no provider) is not merged; the roster read finishes CouchCoop-side, as `7d089e03` (5 files, +137/-4,
  85 minutes later) began. What the round wrote is useful as a list of the facts wanted, not as code. Deleting the
  branch is the maintainer's call.
- **[handoff-hosting-tracker-state.md](handoff-hosting-tracker-state.md) is done** (`b6a1ec12`) and is P1's template.
  Two loose ends: it was compiled against the v111 lane only, and the release workflow packages v107. The v107
  decompile corpus (`.sts2/toolchain-public`) declares the same public run-in-progress member, so the risk is small,
  but no v107 compile has run; the stable reference SDK package (`eng/Sts2.ReferenceSdk/stable`) is cached locally,
  so one can. The fallback clause (keep the state subscription if `SubscribeUpdated` cannot be resolved) has since
  been **removed by the maintainer's decision**: an unresolvable screen event now logs once and hosting ends only on
  the transport's own signal, and the tracker no longer takes the runtime host at all. The read paths that remain are
  listed under P1; two of them are recurring but bounded (the QR host panel's lobby tick and the join-picker
  observer).
- **[handoff-zero-client-guard.md](handoff-zero-client-guard.md): choose the choke point CouchCoop owns.** Every
  state and scene entry already flows through one CouchCoop type: `CouchCoopRuntimeDependencies.FromFactory`
  (`Runtime/CouchCoopRuntimePorts.cs`) adapts the embedded runtime once, and `CouchCoopRuntimeHost` implements the
  ports. Wrap there and the tripwire holds whichever repo implements a port. Not everything goes through it: the
  screen-context, dispatcher and build-identity statics are called directly, and the hosting tracker's new
  `Sts2ScreenContext.SubscribeUpdated` would be one. Put the tripwire at those call sites too, or behind a
  CouchCoop-owned facade over them, and it also catches the next subscriber P1 adds.

## 9. Proposed wording for `CLAUDE.md`

Not applied. Current text, then proposed replacement.

**Line 68** (Project Intent)

- Current: `Reuse embeddable spirectl libraries for generic STS2 runtime state, semantic actions, and asset extraction where possible.`
- Proposed: `Reuse spirectl where another tool already shares the code: asset extraction, the game-API lane table and the runtime hook substrate. Runtime behavior only CouchCoop needs (scene observation, roster and per-viewer facts, browser input, seat and lobby handling) lives in this repo.`

**Line 76** (Architecture Rules)

- Current: `spirectl owns reusable STS2 tooling: generic runtime inspection, semantic action execution, asset extraction, fixtures/scenarios, render snapshots, screenshots, screenshot diff, diagnostics, and reusable validation helpers.`
- Proposed: `spirectl owns the STS2 tooling it has a consumer for today: runtime inspection and semantic actions for the CLI and QA bridge, asset extraction, fixtures/scenarios, render snapshots, screenshots, screenshot diff, diagnostics, and validation helpers. Reuse is earned: code moves to spirectl when a second consumer exists, not before. Named exception: geoclip (cheap animated Spines without the Spine library) stays in spirectl as a tool in the making, until its first spirectl consumer lands.`

**Line 77** (Architecture Rules)

- Current: `Missing reusable STS2 support belongs in ../spirectl; do not add CouchCoop-local reflection, asset extraction, encounter fixture, render, screenshot, or diff shims for reusable STS2 behavior.`
- Proposed: `Support the CLI or QA bridge also needs belongs in ../spirectl; do not add CouchCoop-local asset extraction, encounter fixture, render, screenshot, or diff shims for it. Support only CouchCoop needs starts here, using typed access with the game-lane split like the rest of the mod, and its Harmony targets and any by-name reads go through the existing gates (beta-targets, code verify-references). Do not add unused lanes to the embedded copy.`

## 10. Adjacent, note only: `@spirectl/presentation` and `godot-scene-web`

The same "is the second consumer real?" question applies with different answers; this memo does not decide it.

- **`@spirectl/presentation`**: CouchCoop's frontend is its only consumer (two source aliases in
  `frontend/vite.config.ts`); spirectl's own archive records "exactly one product consumer", and no spirectl script
  or CI leg runs its tests. The DRY argument for it is as weak as for the runtime code above.
- **`godot-scene-web`**: real other consumers exist: `spirectl/presentation/web` type-imports it, it has its own
  playground and perf harness, and it has a public npm publish workflow. Its separation is earned.
- **The "no CouchCoop CSS over the renderer" rule has a different rationale from DRY.** It is about not masking a
  renderer bug in one consumer while the bug remains. That rationale survives even if `@spirectl/presentation` were
  folded into CouchCoop; it would then read "fix it in the renderer, not in the page", with the renderer being
  wherever the code lives.

## 11. Uncertainty, and what would change the recommendation

- **The "dead in copy" verdicts** come from a name-based call graph and a reading of each consumer, checked by hand
  for the composition, dispatcher and legacy extractor. Confidence is high for the legacy extractor, the observation
  provider, `Core/Reference`, and the fully unreached action partials; **medium** for the semantic-state hooks,
  `ClaimReward` reachability and the Explain / composed-encounter asset lanes. P2 must re-verify each one.
- **"Shared" verdicts lean on the CLI's `execution=live` paths**, which need a running game; nothing else was
  available to show them in use. If a "shared" row turns out to have no live use, it moves to CouchCoop-only.
- **Timings are single runs** (three for `bridge-tests`) on a 12-core machine with unrelated processes present
  (§3), and the round trip was a no-op edit: it exercises no hook pin, snapshot-identity proof, live game or second
  landing. Effort figures, including the 2–4 hours of untimed procedure, are estimates.
- **IL understates DLL cost.** Metadata is 64% of the DLL and was not attributed per component.
- **Would change the recommendation:** a planned second consumer for the scene stream or the animation hints
  (keep them; P3 shrinks); the paired-landing procedure becoming cheap, for example one pair-root worktree command
  and a green live-host leg (Option A gets more attractive, P3 less); or P1 failing to remove the recurring
  captures (then the premise that state reads are the dead weight is wrong).
