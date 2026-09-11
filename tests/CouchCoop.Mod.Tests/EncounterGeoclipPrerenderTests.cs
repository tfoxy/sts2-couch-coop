using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Core.Perspective;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Core.Reference;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

/// <summary>
/// The ENCOUNTER-SCOPED geoclip prerender (<see cref="CouchCoopEncounterGeoclipPrerender"/>) and the scoped entry
/// point it drives (<see cref="CouchCoopGeoclipPrerenderJob.RunAsync(IReadOnlyList{SpineCatalogEntrySnapshot}, int, CancellationToken)"/>).
/// </summary>
/// <remarks>
/// Three properties here are load-bearing and the rest are detail.
/// <list type="number">
/// <item>
/// IT IS OFF UNLESS SOMEBODY ARMED IT. This lane spends Godot MAIN-THREAD time on a schedule the player did not
/// ask for, at the moment a room is loading. The round's own measurement says a geoclip bake costs the main
/// thread ~44 ms MORE per pose than the still it replaces (162.5 vs 114.4 ms p50, 0/40 pairs won), so an
/// unattended sweep is not a free win that merely arrives early — it is real stall, relocated. `off` therefore
/// has to be provable rather than assumed, and it is asserted here through the whole controller, not just on the
/// env-var reader: no bake, no job constructed, nothing on disk.
/// </item>
/// <item>
/// IT BAKES THE ROSTER AND NOTHING ELSE. The catalog sweep's failure mode is baking 1 175 identities; this
/// lane's would be quietly becoming that. So the identities are counted and named, and a rig that is NOT on
/// screen is asserted never to reach the baker.
/// </item>
/// <item>
/// A CLIENT NEVER PAYS FOR THIS SWEEP TWICE. The sweep runs at exactly the moment the browser is asking about
/// exactly these creatures, so a concurrent request for a key mid-bake must COALESCE onto that bake rather than
/// start a second main-thread render. That is what pins the lane to
/// <see cref="CouchCoopEncounterGeoclipPrerender.RigBatchPoses"/> = 1 — the rig lane has no single-flight and
/// says so.
/// </item>
/// </list>
/// </remarks>
internal static class EncounterGeoclipPrerenderTests
{
    public static async Task RunAsync()
    {
        TheArmIsOffByDefaultAndExactlyOneValueTurnsItOn();
        TheRosterIsTheClientsOwnQuestion();

        await AnArmedEncounterBakesExactlyItsRosterAsync();
        await AConcurrentClientRequestDoesNotBakeTheSameKeyTwiceAsync();
        await TheEncounterLaneIgnoresTheOperatorsRigBatchAsync();
        await ARefusalIsRememberedRatherThanRetriedAsync();
        await TheSameCreaturesAreNotSweptTwiceAsync();
        await TheFirstScreenIsABaselineNotAnEncounterAsync();

        Console.WriteLine("encounter geoclip prerender: ok");
    }

    // ── The arm ────────────────────────────────────────────────────────────────────────────────────────────

    // OPT-IN, and spelled like the other three prerender arms rather than like the ~15 COUCHCOOP kill-switches.
    // The distinction is not cosmetic: a kill-switch reads `!= "0"`, so an arm that copied that vocabulary would
    // be ARMED by every typo — including an operator's `=0` meant to turn it off.
    private static void TheArmIsOffByDefaultAndExactlyOneValueTurnsItOn()
    {
        Expect(CouchCoopEncounterGeoclipPrerender.EnvVar == "COUCHCOOP_PRERENDER_ENCOUNTER_GEOCLIPS",
            "the env var is COUCHCOOP_PRERENDER_ENCOUNTER_GEOCLIPS");
        Expect(CouchCoopEncounterGeoclipPrerender.ArmedValue == "1", "…armed by exactly `1`");

        using (var scope = new ArmScope(null))
        {
            Expect(!CouchCoopEncounterGeoclipPrerender.ArmedByEnvironment,
                "UNSET IS OFF — the default a player's host runs on");
        }

        foreach (var value in new[] { "0", "true", "yes", "on", string.Empty, " 1", "1 ", "01" })
        {
            using var scope = new ArmScope(value);
            Expect(!CouchCoopEncounterGeoclipPrerender.ArmedByEnvironment,
                $"`{value}` does NOT arm the encounter prerender — the arm is exact, so a near-miss stays off");
        }

        using (var armed = new ArmScope("1"))
        {
            Expect(CouchCoopEncounterGeoclipPrerender.ArmedByEnvironment, "…and exactly `1` arms it");
        }

        // The pin that stops this lane from inheriting the operator's catalog-sweep batching. See the constant.
        Expect(CouchCoopEncounterGeoclipPrerender.RigBatchPoses == 1,
            "the encounter lane is pinned to ONE pose per bake — the single-key lane, which single-flights");
    }

    // ── The roster ─────────────────────────────────────────────────────────────────────────────────────────

    // The roster rule must be the CLIENT's rule, character for character: frontend/src/mirror/spineAttributes.ts
    // builds a /geoclips/ URL from (spineSceneResPath, spineNodePath, spineCurrentAnim) and returns null unless
    // the scene is a res:// path and the current anim is non-empty. Bake by any other rule and the store fills
    // with identities nothing can request, while the ones the browser asks for are still cold.
    private static void TheRosterIsTheClientsOwnQuestion()
    {
        var roster = CouchCoopEncounterGeoclipPrerender.ResolveRoster(
            Keyframe(
                Creature("1", "res://scenes/creature_visuals/flail_knight.tscn", "Visuals", "idle_loop"),
                Creature("2", "res://scenes/creature_visuals/magi_knight.tscn", "Visuals", "idle_loop"),
                // A second instance of a rig already listed — one identity, not two: a geoclip is a property of
                // (scene, node, anim), not of the node drawing it.
                Creature("3", "res://scenes/creature_visuals/flail_knight.tscn", "Visuals", "idle_loop"),
                // …but the SAME rig at a different pose IS a different identity, and a different node is too.
                Creature("4", "res://scenes/creature_visuals/magi_knight.tscn", "Visuals", "attack"),
                Creature("5", "res://scenes/creature_visuals/magi_knight.tscn", "Shadow", "idle_loop"),
                // Everything the client's own guards drop.
                Plain("6"),
                Creature("7", "res://scenes/creature_visuals/no_anim.tscn", "Visuals", null),
                Creature("8", "res://scenes/creature_visuals/empty_anim.tscn", "Visuals", string.Empty),
                Creature("9", "user://runtime_only.tscn", "Visuals", "idle_loop"),
                Creature("10", "res://scenes/creature_visuals/hidden.tscn", "Visuals", "idle_loop", visible: false)),
            maxIdentities: 24);

        Expect(roster.Count == 4, $"four distinct requestable identities (got {roster.Count})");
        Expect(roster[0].SceneResPath.EndsWith("flail_knight.tscn", StringComparison.Ordinal)
            && roster[0].NodePath == "Visuals" && roster[0].AnimationName == "idle_loop",
            "…carrying the exact triple the browser would put in its URL");
        Expect(roster.Count(entry => entry.SceneResPath.EndsWith("flail_knight.tscn", StringComparison.Ordinal)) == 1,
            "a rig instanced twice is ONE identity");
        Expect(roster.Any(entry => entry.AnimationName == "attack"),
            "…while a second POSE of a listed rig is its own identity");
        Expect(roster.Any(entry => entry.NodePath == "Shadow"),
            "…and so is a second NODE of the same scene");

        Expect(!roster.Any(entry => entry.SceneResPath.Contains("no_anim", StringComparison.Ordinal)),
            "a spine node with no CURRENT animation has no geoclip URL, so it is not baked");
        Expect(!roster.Any(entry => entry.SceneResPath.Contains("empty_anim", StringComparison.Ordinal)),
            "…nor does one whose current animation is empty");
        Expect(!roster.Any(entry => entry.SceneResPath.StartsWith("user://", StringComparison.Ordinal)),
            "…nor a scene the client's res:// guard rejects");
        Expect(!roster.Any(entry => entry.SceneResPath.Contains("hidden", StringComparison.Ordinal)),
            "an INVISIBLE rig is skipped: baking one costs seconds of main thread for a creature that may never "
            + "be drawn, while skipping one that later appears costs only a fallback to the on-demand bake");

        // The BOUND, which is what makes "bounded" a property of the code rather than a hope about the game.
        var many = CouchCoopEncounterGeoclipPrerender.ResolveRoster(
            Keyframe([.. Enumerable.Range(0, 100).Select(index =>
                Creature($"n{index}", $"res://scenes/creature_visuals/rig_{index}.tscn", "Visuals", "idle_loop"))]),
            maxIdentities: 3);
        Expect(many.Count == 3, $"the roster is capped, so no screen can turn an encounter load into a catalog sweep (got {many.Count})");
        var shippedCap = CouchCoopEncounterGeoclipPrerender.MaxIdentitiesPerEncounter;
        Expect(shippedCap is > 0 and <= 64,
            "…and the shipped cap is an encounter-sized number");

        Expect(CouchCoopEncounterGeoclipPrerender.ResolveRoster(null, 24).Count == 0,
            "no keyframe is no roster — never an exception on the delta path");
        Expect(CouchCoopEncounterGeoclipPrerender.ResolveRoster(Keyframe(Creature("1", "res://a.tscn", "V", "idle")), 0).Count == 0,
            "…and a cap of zero bakes nothing");
    }

    // ── Exactly the roster ─────────────────────────────────────────────────────────────────────────────────

    private static async Task AnArmedEncounterBakesExactlyItsRosterAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        using var arm = new ArmScope("1");

        var baker = new ScriptedBaker();
        var harness = new Harness(scope.Store, baker);
        await harness.SeedBaselineAsync();
        await harness.LoadEncounterAsync(
            "res://knights.tscn",
            // On screen…
            "flail_knight.tscn", "magi_knight.tscn", "spectral_knight.tscn");

        Expect(baker.Calls == 3, $"one bake per creature on screen (got {baker.Calls})");
        Expect(
            baker.Scenes.OrderBy(scene => scene, StringComparer.Ordinal).SequenceEqual(
                new[] { "res://flail_knight.tscn", "res://magi_knight.tscn", "res://spectral_knight.tscn" },
                StringComparer.Ordinal),
            "…and they are EXACTLY the creatures on screen: " + string.Join(",", baker.Scenes));

        foreach (var scene in baker.Scenes)
        {
            Expect(scope.Store.TryResolveDirectory(Key(scene, "idle_loop")) is not null,
                $"{scene} is in the store, so the client's first request is a HIT rather than a main-thread produce");
        }

        // THE "AND NO MORE" HALF. A creature that exists in the game but is not in this encounter must never be
        // touched — the scoped lane's whole point is that it is not the catalog sweep.
        Expect(scope.Store.TryResolveDirectory(Key("res://byrdonis.tscn", "idle_loop")) is null,
            "a rig that was NOT on screen is not in the store");
        Expect(!baker.Scenes.Any(scene => scene.Contains("byrdonis", StringComparison.Ordinal)),
            "…and was never handed to the baker at all");

        var summary = harness.Lines.Last(line => line.Contains("encounter DONE", StringComparison.Ordinal));
        Expect(summary.Contains("status=complete", StringComparison.Ordinal)
            && summary.Contains("baked=3", StringComparison.Ordinal),
            "the lane reports itself in the existing prerender vocabulary: " + summary);
        Expect(harness.Lines.Any(line => line.StartsWith(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix, StringComparison.Ordinal)),
            "…including the job's own machine-readable COUCHCOOP_GEOCLIP_PRERENDER summary, unchanged");
    }

    // ── The one that decides the design ────────────────────────────────────────────────────────────────────

    // THE COLLISION THIS LANE IS BUILT AROUND. The sweep runs at exactly the moment the browser is asking for
    // exactly these creatures, so the two race by construction. A bake is SECONDS of the single-slot main-thread
    // extraction gate; baking one key twice does not merely waste it, it makes the client wait for a second
    // render behind the first.
    //
    // Driven from a baker that BLOCKS, so the concurrent request provably arrives while the sweep's bake is in
    // flight rather than after it — the ordering a sleep-based test only hopes for.
    private static async Task AConcurrentClientRequestDoesNotBakeTheSameKeyTwiceAsync()
    {
        using var scope = new Scope(armOnDemand: true);

        using var bakeStarted = new SemaphoreSlim(0);
        using var releaseBake = new SemaphoreSlim(0);
        var baker = new ScriptedBaker().Watch(_ =>
        {
            bakeStarted.Release();
            releaseBake.Wait(TimeSpan.FromSeconds(30));
        });

        // ONE provider, exactly as the browser server wires it: the /geoclips/ route and the sweep answer from
        // the same instance, so this asserts the real topology and not a test-only arrangement.
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });
        var entry = new SpineCatalogEntrySnapshot("res://contended.tscn", "Visuals", "idle_loop");

        var sweep = Task.Run(() => new CouchCoopGeoclipPrerenderJob(Host(), provider, _ => { })
            .RunAsync([entry], CouchCoopEncounterGeoclipPrerender.RigBatchPoses));

        Expect(await bakeStarted.WaitAsync(TimeSpan.FromSeconds(30)), "the sweep's bake actually started");

        // The browser asks for the very key the sweep is mid-bake on.
        var client = provider.GetAsync(new CouchCoopGeoclipRequest(
            Key("res://contended.tscn", "idle_loop"), "res://contended.tscn", "Visuals", "idle_loop"));

        releaseBake.Release(2);
        var served = await client;
        var summary = await sweep;

        Expect(baker.Calls == 1,
            $"ONE bake covered both the sweep and the concurrent client request (got {baker.Calls}) — the "
            + "provider's static per-key single-flight is what makes the encounter lane safe to run while the "
            + "browser is asking");
        Expect(served.Error is null && served.Directory is not null, "…and the client got a real artifact");
        Expect(summary.Baked == 1 && summary.Failed == 0, $"…as did the sweep (baked={summary.Baked} failed={summary.Failed})");
        Expect(scope.Store.TryResolveDirectory(Key("res://contended.tscn", "idle_loop")) == served.Directory,
            "…and both are looking at the same stored pose");
    }

    // The pin, from the other side. `COUCHCOOP_GEOCLIP_RIG_BATCH` re-arms rig batching for the CATALOG sweep, and
    // the rig lane it reaches has no single-flight of its own — so a host that re-armed it must not thereby turn
    // double-baking on in the lane that runs while clients are asking. The encounter lane does not read it.
    private static async Task TheEncounterLaneIgnoresTheOperatorsRigBatchAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        using var batch = new RigBatchArmed(12);

        Expect(CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses == 12,
            "the operator really has re-armed batching for the catalog sweep");

        var baker = new ScriptedBaker();
        var rig = new[]
        {
            new SpineCatalogEntrySnapshot("res://one_rig.tscn", "Visuals", "idle_loop"),
            new SpineCatalogEntrySnapshot("res://one_rig.tscn", "Visuals", "attack"),
            new SpineCatalogEntrySnapshot("res://one_rig.tscn", "Visuals", "die"),
        };

        var summary = await new CouchCoopGeoclipPrerenderJob(
                Host(), new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }), _ => { })
            .RunAsync(rig, CouchCoopEncounterGeoclipPrerender.RigBatchPoses);

        Expect(baker.Calls == 3,
            $"three poses of one rig are THREE single-key bakes on the encounter lane, not one rig bake "
            + $"(got {baker.Calls}) — the single-key lane is the one that coalesces with a client request");
        Expect(baker.MaxAnimationsAsked == 1,
            $"…and no bake was ever asked for more than one animation (got {baker.MaxAnimationsAsked})");
        Expect(summary.Baked == 3, $"all three are stored (got {summary.Baked})");

        // The control: the CATALOG lane, same store, same process, DOES honour the operator's batch. Without
        // this the assertion above would also pass if batching were simply broken everywhere.
        using var catalogScope = new Scope(armOnDemand: true);
        var catalogBaker = new ScriptedBaker();
        await new CouchCoopGeoclipPrerenderJob(
                Host(), new CouchCoopGeoclipProvider(catalogBaker, catalogScope.Store, _ => { }), _ => { })
            .RunAsync(rig, CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses);
        Expect(catalogBaker.Calls == 1,
            $"…while the catalog lane batches the same rig into ONE bake (got {catalogBaker.Calls}), which is "
            + "what makes the pin above a deliberate difference rather than a dead setting");
    }

    // ── Convergence ────────────────────────────────────────────────────────────────────────────────────────

    // A refusal must not be re-decided every time the player walks into a room. Roughly half a real catalog's
    // identities come back incomplete at seconds each; a lane that fires on every encounter load and re-paid for
    // them would be a per-room stall that never converges — the exact regression this feature exists to avoid.
    private static async Task ARefusalIsRememberedRatherThanRetriedAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        using var arm = new ArmScope("1");

        var baker = new ScriptedBaker().Incomplete("stubborn.tscn", complete: false);
        var harness = new Harness(scope.Store, baker);
        await harness.SeedBaselineAsync();

        await harness.LoadEncounterAsync("res://room_a.tscn", "stubborn.tscn");
        Expect(baker.Calls == 1, $"the first encounter tried it once (got {baker.Calls})");
        Expect(scope.Store.HasRefusal(Key("res://stubborn.tscn", "idle_loop")), "…and left a durable receipt");

        // The same stubborn creature in three MORE encounters, each with a different companion so every one of
        // them is a genuinely new roster and really does sweep — otherwise this would be testing the
        // same-roster short-circuit (which has its own case below) instead of the refusal receipt.
        await harness.LoadEncounterAsync("res://room_b.tscn", "stubborn.tscn", "friend_a.tscn");
        await harness.LoadEncounterAsync("res://room_c.tscn", "stubborn.tscn", "friend_b.tscn");
        await harness.LoadEncounterAsync("res://room_d.tscn", "stubborn.tscn", "friend_c.tscn");

        Expect(baker.Scenes.Count(scene => scene.Contains("stubborn", StringComparison.Ordinal)) == 1,
            "a refused identity is NEVER re-baked, however many encounters it appears in — the receipt is what "
            + "keeps a per-room trigger from turning half a catalog's refusals into a per-room stall");
        Expect(baker.Calls == 4,
            $"…while its three companions each baked exactly once (got {baker.Calls} bakes: "
            + string.Join(",", baker.Scenes) + ")");

        var last = harness.Lines.Last(line => line.Contains("encounter DONE", StringComparison.Ordinal));
        Expect(last.Contains("refused=1", StringComparison.Ordinal) && last.Contains("refusedCached=1", StringComparison.Ordinal),
            "…and the lane reports it as REMEMBERED rather than as work it did: " + last);
        Expect(last.Contains("baked=1", StringComparison.Ordinal),
            "…beside the one companion it really did bake: " + last);
    }

    // The same creatures are not a new encounter. This is not hypothetical on this game: a combat screen's
    // instance id is the CONSTANT `screen:combat:active`, flipping to `…:hand-select` and back mid-fight, so a
    // screen-change trigger alone fires twice per encounter.
    private static async Task TheSameCreaturesAreNotSweptTwiceAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        using var arm = new ArmScope("1");

        var baker = new ScriptedBaker();
        var jobs = 0;
        var harness = new Harness(scope.Store, baker, () => jobs++);
        await harness.SeedBaselineAsync();

        await harness.LoadAsync("screen:combat:active", "res://fight.tscn", "flail.tscn", "magi.tscn");
        Expect(jobs == 1 && baker.Calls == 2, $"the encounter swept its two creatures (jobs={jobs} bakes={baker.Calls})");

        // A mid-combat sub-screen flip: a screen change, the same roster.
        await harness.LoadAsync("screen:combat:hand-select", "res://fight.tscn", "flail.tscn", "magi.tscn");
        await harness.LoadAsync("screen:combat:active", "res://fight.tscn", "flail.tscn", "magi.tscn");

        Expect(jobs == 1,
            $"an unchanged roster does not start a second sweep (got {jobs}) — the screen id alone is not an "
            + "encounter identity on this game, so the roster is what decides");
        Expect(baker.Calls == 2, $"…and nothing was re-baked (got {baker.Calls})");

        // A ROSTER CHANGE ON THE SAME SCREEN IS NOT A LOAD, and this is the direction that matters most: within
        // one fight the screen id never moves, so a creature that dies or a boss that swaps rig mid-combat does
        // NOT start a sweep. That is the feature's whole purpose — a bake landing mid-combat is precisely what it
        // exists to prevent — so the miss is deliberate, and those creatures fall back to the on-demand bake.
        await harness.LoadAsync("screen:combat:active", "res://fight.tscn", "byrdonis.tscn");
        Expect(jobs == 1 && baker.Calls == 2,
            $"a mid-combat roster change starts NO sweep (jobs={jobs} bakes={baker.Calls}) — the screen-change "
            + "gate is what keeps a bake out of an ongoing fight");

        // …and a real load — a screen away and back, which is what separates two encounters — does sweep.
        await harness.LoadAsync("screen:map:live", "res://map.tscn");
        await harness.LoadAsync("screen:combat:active", "res://fight2.tscn", "byrdonis.tscn");
        Expect(jobs == 2 && baker.Calls == 3,
            $"a new encounter with new creatures IS swept (jobs={jobs} bakes={baker.Calls})");
    }

    // The screen a browser connects DURING is not an encounter that just loaded: its creatures are already on
    // screen, so anything that wants them has asked. Sweeping it would spend main-thread time to get ahead of
    // requests that have already been made.
    private static async Task TheFirstScreenIsABaselineNotAnEncounterAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        using var arm = new ArmScope("1");

        var baker = new ScriptedBaker();
        var jobs = 0;
        var harness = new Harness(scope.Store, baker, () => jobs++);

        await harness.LoadAsync("screen:combat:active", "res://already_here.tscn", "flail.tscn");
        Expect(jobs == 0 && baker.Calls == 0,
            $"the FIRST screen this observer sees is a baseline, not a load (jobs={jobs} bakes={baker.Calls})");

        await harness.LoadAsync("screen:map:active", "res://map.tscn");
        await harness.LoadAsync("screen:combat:active", "res://next_fight.tscn", "magi.tscn");
        Expect(jobs == 1 && baker.Calls == 1,
            $"…and the next real encounter load sweeps normally (jobs={jobs} bakes={baker.Calls})");
    }

    // ── Harness ────────────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// A live controller over a fake scene stream: the real <see cref="CouchCoopSceneObserver"/>, the real
    /// <see cref="CouchCoopEncounterGeoclipPrerender"/>, the real provider and the real job — with only the
    /// producer and the baker replaced. The delta callback is captured from the observer's own subscribe, so
    /// deltas arrive exactly as spirectl would deliver them.
    /// </summary>
    private sealed class Harness : IDisposable
    {
        private readonly SceneRuntime _runtime = new();
        private readonly CouchCoopSceneObserver _observer;
        private readonly CouchCoopEncounterGeoclipPrerender _prerender;
        private readonly object _gate = new();
        private int _screen;

        public Harness(CouchCoopGeoclipStore store, ScriptedBaker baker, Action? onJob = null)
        {
            _observer = new CouchCoopSceneObserver(new CouchCoopRuntimeHost(Dependencies(_runtime), _ => { }));
            var provider = new CouchCoopGeoclipProvider(baker, store, _ => { });
            _prerender = new CouchCoopEncounterGeoclipPrerender(
                _observer,
                () =>
                {
                    onJob?.Invoke();
                    return new CouchCoopGeoclipPrerenderJob(Host(), provider, Log);
                },
                Log,
                // NO SETTLE WAIT in the harness: the keyframe is already complete when the test pushes it, and a
                // real delay would only make the suite slow and flaky. The delay's own contract (a late creature
                // is a miss, never a wrong bake) is a live-leg question, not a unit-test one.
                settleDelay: TimeSpan.Zero);
            _prerender.Start();
            _observer.Start();
        }

        public List<string> Lines { get; } = [];

        private void Log(string line)
        {
            lock (_gate)
            {
                Lines.Add(line);
            }
        }

        /// <summary>
        /// Push the screen that was ALREADY on display when the browser connected, so the loads that follow are
        /// real encounter loads.
        /// </summary>
        /// <remarks>
        /// Explicit in every case that is not itself about the baseline rule, and load-bearing for the NEGATIVE
        /// ones above all: without it an unarmed host's zero bakes would be produced by the first-screen rule
        /// rather than by the switch, and the case would pass with the arm wired to nothing.
        /// </remarks>
        public Task SeedBaselineAsync() => LoadAsync("screen:main-menu:live", "res://menu.tscn");

        /// <summary>Push one encounter load and wait for the sweep it starts to finish.</summary>
        public Task LoadEncounterAsync(string scene, params string[] creatures)
            => LoadAsync($"screen:combat:{Interlocked.Increment(ref _screen)}", scene, creatures);

        /// <summary>
        /// Push one screen change and JOIN whatever it started, deterministically.
        /// </summary>
        /// <remarks>
        /// The delta is delivered synchronously on this thread (the fake producer calls the observer's callback
        /// directly, as spirectl's does), and the controller records its dispatch under its own lock before
        /// returning — so by the time <c>Push</c> returns, "was a sweep started?" is already settled and the task
        /// to await, if any, is published. No sleeping, no quiescence polling, no flake.
        /// </remarks>
        public async Task LoadAsync(string screenInstanceId, string scene, params string[] creatures)
        {
            var nodes = creatures
                .Select((creature, index) => Creature($"{scene}#{index}", $"res://{creature}", "Visuals", "idle_loop"))
                .ToArray();

            var before = _prerender.PendingSweep.Dispatched;
            _runtime.Push(new RuntimeSceneDelta(
                Full: true,
                ScreenType: "combat",
                ScreenInstanceId: screenInstanceId,
                Upserts: nodes,
                RemovedIds: [],
                OrderedIds: [.. nodes.Select(node => node.Id)],
                TransformSpace: "local"));

            var (dispatched, sweep) = _prerender.PendingSweep;
            if (dispatched != before && sweep is not null)
            {
                await sweep.WaitAsync(TimeSpan.FromSeconds(30));
            }
        }

        public void Dispose()
        {
            _prerender.Dispose();
            _observer.Dispose();
        }
    }

    /// <summary>A runtime whose scene-delta subscription is a hand the test can push deltas into.</summary>
    private sealed class SceneRuntime : StubRuntimeBase
    {
        private readonly List<Action<RuntimeSceneDelta>> _subscribers = [];

        public override EmbeddableRuntimeCapabilities GetCapabilities()
            => Capabilities(
                new EmbeddableRuntimeCapability(
                    CouchCoopRuntimeHost.SceneCapability, CouchCoopRuntimeHost.SceneCapability, true, false, null));

        public override IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request,
            Action<RuntimeSceneDelta> onDelta,
            Action<EmbeddableRuntimeError>? onError = null)
        {
            lock (_subscribers)
            {
                _subscribers.Add(onDelta);
            }

            return new Unsubscribe(() =>
            {
                lock (_subscribers)
                {
                    _subscribers.Remove(onDelta);
                }
            });
        }

        public void Push(RuntimeSceneDelta delta)
        {
            Action<RuntimeSceneDelta>[] targets;
            lock (_subscribers)
            {
                targets = [.. _subscribers];
            }

            foreach (var target in targets)
            {
                target(delta);
            }
        }

        private sealed class Unsubscribe(Action dispose) : IDisposable
        {
            public void Dispose() => dispose();
        }
    }

    private static CouchCoopRuntimeDependencies Dependencies(SceneRuntime runtime)
        => new(runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime, runtime);

    private static CouchCoopRuntimeHost Host()
    {
        var runtime = new SceneRuntime();
        return new CouchCoopRuntimeHost(Dependencies(runtime), _ => { });
    }

    private static RuntimeSceneDelta Keyframe(params RuntimeSceneNodeDelta[] nodes)
        => new(
            Full: true,
            ScreenType: "combat",
            ScreenInstanceId: "screen:combat:active",
            Upserts: nodes,
            RemovedIds: [],
            OrderedIds: [.. nodes.Select(node => node.Id)]);

    private static RuntimeSceneNodeDelta Creature(
        string id,
        string scene,
        string? node,
        string? animation,
        bool visible = true)
        => Plain(id, visible) with
        {
            Spine = new RuntimeSceneSpineSnapshot(scene, node, ["idle_loop", "attack", "die"]),
            SpineCurrentAnim = animation,
        };

    private static RuntimeSceneNodeDelta Plain(string id, bool visible = true)
        => new(
            id,
            ParentId: null,
            Name: "node-" + id,
            NodeType: "Node2D",
            Rect: null,
            Visible: visible,
            Opacity: 1,
            ZIndex: null,
            Rotation: 0,
            Texture: null,
            NinePatch: false,
            Text: null);

    private static string Key(string scene, string animation)
        => CouchCoopSpineClipProvider.BuildSpineKey(scene, "Visuals", animation);

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException("encounter geoclip prerender expectation failed: " + because);
        }
    }

    /// <summary>Sets <see cref="CouchCoopEncounterGeoclipPrerender.EnvVar"/> and restores it, whatever it was.</summary>
    private sealed class ArmScope : IDisposable
    {
        private readonly string? _previous =
            Environment.GetEnvironmentVariable(CouchCoopEncounterGeoclipPrerender.EnvVar);

        public ArmScope(string? value)
            => Environment.SetEnvironmentVariable(CouchCoopEncounterGeoclipPrerender.EnvVar, value);

        public void Dispose()
            => Environment.SetEnvironmentVariable(CouchCoopEncounterGeoclipPrerender.EnvVar, _previous);
    }

    private sealed class RigBatchArmed : IDisposable
    {
        private const string Key = "COUCHCOOP_GEOCLIP_RIG_BATCH";
        private readonly string? _previous = Environment.GetEnvironmentVariable(Key);

        public RigBatchArmed(int? poses) => Environment.SetEnvironmentVariable(Key, poses?.ToString());

        public void Dispose() => Environment.SetEnvironmentVariable(Key, _previous);
    }

    /// <summary>A store on a throwaway cache root.</summary>
    private sealed class Scope : IDisposable
    {
        private readonly string _cacheRoot = Path.Combine(
            Path.GetTempPath(), "couchcoop-encounter-geoclip-" + Guid.NewGuid().ToString("N"));

        public Scope(bool armOnDemand)
        {
            Store = new CouchCoopGeoclipStore(_cacheRoot);
        }

        public CouchCoopGeoclipStore Store { get; }

        public void Dispose()
        {
            try { Directory.Delete(_cacheRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>
    /// The same shape as the catalog sweep's fake producer: a NESTED per-animation directory holding a
    /// well-formed manifest, because an incomplete bake writing a valid directory is the hazard the store's
    /// completeness guard exists for.
    /// </summary>
    private sealed class ScriptedBaker : ICouchCoopGeoclipBaker
    {
        private readonly Dictionary<string, bool> _incomplete = new(StringComparer.Ordinal);
        private readonly List<string> _scenes = [];
        private readonly object _gate = new();
        private Action<CouchCoopGeoclipBakeCommand>? _watch;
        private int _calls;
        private int _maxAnimations;

        public int Calls => Volatile.Read(ref _calls);

        public int MaxAnimationsAsked => Volatile.Read(ref _maxAnimations);

        public IReadOnlyList<string> Scenes
        {
            get
            {
                lock (_gate)
                {
                    return [.. _scenes];
                }
            }
        }

        public ScriptedBaker Incomplete(string scene, bool complete)
        {
            _incomplete["res://" + scene] = complete;
            return this;
        }

        public ScriptedBaker Watch(Action<CouchCoopGeoclipBakeCommand> onBake)
        {
            _watch = onBake;
            return this;
        }

        public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
        {
            Interlocked.Increment(ref _calls);
            var animations = command.AnimationNames is { Count: > 0 } named
                ? named
                : (IReadOnlyList<string>)[command.AnimationName];

            lock (_gate)
            {
                _scenes.Add(command.SceneResPath);
                _maxAnimations = Math.Max(_maxAnimations, animations.Count);
            }

            _watch?.Invoke(command);

            var complete = !_incomplete.TryGetValue(command.SceneResPath, out var flag) || flag;
            var poses = new List<SpineGeoClipBakePoseSnapshot>();
            foreach (var animation in animations)
            {
                var scene = Path.GetFileNameWithoutExtension(command.SceneResPath);
                var written = Path.Combine(
                    command.OutputDirectory, $"{scene}--{(command.NodePath ?? "root").Replace('/', '_')}--{animation}");
                Directory.CreateDirectory(written);
                var page = new byte[] { 1, 2, 3, 4 };
                var pageId = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(page)).ToLowerInvariant();
                File.WriteAllText(
                    Path.Combine(written, "manifest.json"),
                    System.Text.Json.JsonSerializer.Serialize(new
                    {
                        meta = new { schema = "geoclip/1", frameCount = 1, anim = animation },
                        pages = new[] { new { id = 0, file = "page-0.png", width = 4, height = 4, sha256 = pageId } },
                        parts = Array.Empty<object>(),
                        frames = Array.Empty<object>(),
                    }));
                File.WriteAllBytes(Path.Combine(written, "page-0.png"), page);
                File.WriteAllBytes(Path.Combine(written, "verts.bin"), [0, 0]);

                poses.Add(new SpineGeoClipBakePoseSnapshot(
                    animation,
                    Success: true,
                    Path.Combine(written, "manifest.json"),
                    ["page-0.png"],
                    PartCount: 3,
                    FrameCount: 1,
                    SampleTimeSeconds: 0.5d,
                    SampleTimeSource: "mid",
                    Slots: 34,
                    SlotsVisible: 28,
                    Associated: 28,
                    Unassociated: 0,
                    ForeignMeshes: 0,
                    StaleMeshFrames: 0,
                    AttachmentDriftSlots: 0,
                    Complete: complete,
                    Batched: animations.Count > 1,
                    FailureReason: null));
            }

            return CouchCoopRuntimeGeoclipBaker.Map(new SpineGeoClipBakeResultSnapshot(
                Success: true,
                poses[0].ManifestPath,
                ["page-0.png"],
                PartCount: 3,
                FrameCount: 1,
                SampleTimeSeconds: 0.5d,
                SampleTimeSource: "mid",
                ElapsedMs: 1d,
                Slots: 34,
                SlotsVisible: 28,
                Associated: 28,
                Unassociated: 0,
                ForeignMeshes: 0,
                Complete: complete,
                Error: null,
                Poses: poses,
                ScenesLoaded: 1,
                BatchNote: animations.Count > 1 ? "batched" : "single"));
        }
    }

    /// <summary>The uninteresting surface of the runtime ports, so the one stub above stays readable.</summary>
    private abstract class StubRuntimeBase
        : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource,
          IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker,
          ISemanticActionSource, IRuntimeSceneWatchControlSource
    {
        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;

        public ISpirectlAssetProvider Assets { get; } = new AssetCacheTokenEnvelopeTests.StubAssetProvider();

        public abstract EmbeddableRuntimeCapabilities GetCapabilities();

        protected static EmbeddableRuntimeCapabilities Capabilities(params EmbeddableRuntimeCapability[] capabilities)
            => new(
                "spirectl/v1",
                "test-game",
                "test-bridge",
                "embedded",
                RuntimeAttachmentState.Attached,
                DataSourceKind.Stub,
                Provisional: false,
                capabilities,
                []);

        public virtual IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request,
            Action<RuntimeSceneDelta> onDelta,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
            => throw new NotSupportedException();

        public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
            => throw new NotSupportedException();

        public CurrentStateResult GetCurrentState(CurrentStateRequest request) => throw new NotSupportedException();

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request,
            Action<CurrentStateWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
            CurrentStateSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public IDisposable SubscribeCombatEvents(
            CombatEventSubscriptionRequest request,
            Action<CombatWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public IAsyncEnumerable<CombatWatchEvent> WatchCombatEventsAsync(
            CombatEventSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public IDisposable SubscribeAnimationHints(
            AnimationHintSubscriptionRequest request,
            Action<TweenAnimationHint> onHint,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public IAsyncEnumerable<TweenAnimationHint> WatchAnimationHintsAsync(
            AnimationHintSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request)
            => throw new NotSupportedException();

        public ReferenceOperationResult GetReference(ReferenceRequestSnapshot request)
            => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request)
            => throw new NotSupportedException();

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
            => throw new NotSupportedException();
    }
}
