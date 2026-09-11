using System.Text.Json;
using CouchCoop.Mod;
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
/// The <c>--prerender-spine-deltas</c> sweep (<see cref="CouchCoopGeoclipPrerenderJob"/>) and the seam it bakes
/// through (<see cref="CouchCoopRuntimeGeoclipBaker"/> → <see cref="CouchCoopRuntimeHost.BakeSpineGeoClip"/>).
/// </summary>
/// <remarks>
/// Two assertions here matter more than the rest. (1) REFUSED IS NOT FAILED: a bake that ran and was kept out of
/// the store because it did not cover the whole rig is a guard working, and a sweep that folds it into "failed"
/// cannot tell a rig that does not bake cleanly from a host that fell over. (2) THE SIZE REPORT COUNTS PAGES
/// ONCE: atlas pages are shared across a rig's poses, so a per-pose sum would claim a cost the store does not pay
/// and quietly overstate the round's transfer payoff in the wrong direction.
/// </remarks>
internal static class GeoclipPrerenderTests
{
    public static async Task RunAsync()
    {
        TheTriggerIsAUnionOfEveryArgSourcePlusTheEnvVar();
        TheTwoPrerenderFlagsAreIndependent();
        TheSeamAsksForASinglePoseExplicitly();
        TheSeamIsGuardedOnACapabilityThisRuntimeActuallyPublishes();
        TheSeamMapsTheResultWithoutJudgingIt();
        TheSeamCarriesClaimProvenanceIntoTheAdmissionRule();
        TheSeamNamesAMainThreadRefusalSeparately();
        // THE SUITE RUNS ARMED. Rig batching is OFF in the shipped default (it refuses itself on every rig
        // measured live — see CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses), but the mechanism is kept and
        // supported, and most cases below express their property in BAKES, which is a batch-shaped unit. So the
        // batch is armed here and RigBatchingIsOffUnlessItIsArmedAsync un-arms to pin the default — that way the
        // default is asserted once, deliberately, instead of being smuggled in as the ambient state of a suite
        // that is really testing the batch.
        using var suiteArmed = new RigBatchArmed(CouchCoopGeoclipPrerenderJob.RigBatchPosesWhenArmed);

        await TheBakeNeverRunsOnTheCallersThreadAsync();
        await TheSweepCountsRefusedApartFromFailedAsync();
        await TheSweepResumesFromTheStoreAfterADeathAsync();
        await TheSweepReportsPagesSharedNotSummedAsync();
        await TheSweepAnswersDeltaVersusRasterPerRigAsync();
        await TheSweepRunsOnAnUntouchedEnvironmentAsync();
        await TheSummaryJsonHasTheShapeAReaderParsesAsync();
        await ProgressIsOnDiskBeforeTheBakeThatCouldKillTheProcessAsync();
        await ARigTooBigForOneBakeStillFlushesBetweenItsChunksAsync();
        await RigBatchingIsOffUnlessItIsArmedAsync();
        await APartialSnapshotIsDistinguishableFromTheFinalOneAsync();
        RigChunksGroupConsecutiveSiblingsUpToTheCap();
        await ARigsPosesGoDownAsOneBakeAsync();
        await OnePoseMayBeRefusedWhileItsSiblingsAreStoredAsync();
        await AResumedSweepOnlyAsksForWhatItStillOwesAsync();
        await TheBakeIsToldWhichPagesThisHostAlreadyHasAsync();

        Console.WriteLine("geoclip prerender: ok");
    }

    // ── The trigger ────────────────────────────────────────────────────────────────────────────────────────

    // The union exists because inside Godot's embedded CoreCLR host the game's native argv is NOT surfaced
    // through Environment.GetCommandLineArgs() — that is how `--prerender-spines` was silently dropped once
    // already. Each source is driven INDEPENDENTLY here: a union that quietly lost one arm would still pass any
    // test that only set the env var.
    private static void TheTriggerIsAUnionOfEveryArgSourcePlusTheEnvVar()
    {
        string[] flag = ["--prerender-spine-deltas"];
        string[] none = ["--headless", "--verbose"];

        Expect(CouchCoopMod.GeoclipPrerenderFlag == "--prerender-spine-deltas", "the flag is spelled --prerender-spine-deltas");
        Expect(CouchCoopMod.GeoclipPrerenderEnvVar == "COUCHCOOP_PRERENDER_SPINE_DELTAS", "the env var is COUCHCOOP_PRERENDER_SPINE_DELTAS");

        Expect(CouchCoopMod.IsGeoclipPrerenderTriggered(flag, none, none, null),
            "Godot.OS.GetCmdlineArgs() alone triggers the sweep");
        Expect(CouchCoopMod.IsGeoclipPrerenderTriggered(none, flag, none, null),
            "Godot.OS.GetCmdlineUserArgs() alone triggers the sweep");
        Expect(CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, flag, null),
            "Environment.GetCommandLineArgs() alone triggers the sweep");
        Expect(CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, none, "1"),
            "the env var alone triggers the sweep — the guaranteed lane when argv is eaten");

        Expect(!CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, none, null),
            "NOTHING triggers it by default: no flag anywhere, no env var, no sweep");
        Expect(!CouchCoopMod.IsGeoclipPrerenderTriggered([], [], [], null), "…and empty arg sources are not a trigger either");
        Expect(!CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, none, "0"), "the env var must be exactly 1");
        Expect(!CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, none, "true"), "…not any truthy-looking string");
        Expect(!CouchCoopMod.IsGeoclipPrerenderTriggered(none, none, none, string.Empty), "…and not empty");

        Expect(!CouchCoopMod.IsGeoclipPrerenderRequested(["--prerender-spine-delta"]), "a near-miss flag does not trigger it");
        Expect(!CouchCoopMod.IsGeoclipPrerenderRequested(["--prerender-spine-deltas=1"]), "the flag takes no value");
    }

    // The two sweeps are separate BECAUSE deltas are meant to eventually replace rasterised stills: a host has to
    // be able to run one without the other, and that is only true if neither flag triggers the other.
    private static void TheTwoPrerenderFlagsAreIndependent()
    {
        string[] deltas = ["--prerender-spine-deltas"];
        string[] stills = ["--prerender-spines"];

        Expect(CouchCoopMod.IsGeoclipPrerenderRequested(deltas), "the delta flag triggers the delta sweep");
        Expect(!CouchCoopMod.IsSpinePrerenderRequested(deltas), "…and NOT the raster still sweep");
        Expect(CouchCoopMod.IsSpinePrerenderRequested(stills), "the still flag triggers the still sweep");
        Expect(!CouchCoopMod.IsGeoclipPrerenderRequested(stills), "…and NOT the delta sweep");
        Expect(!CouchCoopMod.IsStaticBackgroundPrerenderRequested(deltas), "…nor the background sweep");
    }

    // ── Baking a RIG rather than an item ───────────────────────────────────────────────────────────────────

    // The split is CONSECUTIVE and capped, and both halves matter: the catalog's order is what the sweep
    // announces and resumes in, and the cap is what a silent mid-bake death can lose.
    private static void RigChunksGroupConsecutiveSiblingsUpToTheCap()
    {
        SpineCatalogEntrySnapshot Entry(string scene, string node, string anim) => new($"res://{scene}", node, anim);

        var chunks = CouchCoopGeoclipPrerenderJob.RigChunks(
            [
                Entry("a.tscn", "Visuals", "idle_loop"),
                Entry("a.tscn", "Visuals", "attack"),
                Entry("a.tscn", "Shadow", "idle_loop"),
                Entry("b.tscn", "Visuals", "idle_loop"),
                Entry("a.tscn", "Visuals", "die"),
            ],
            maxPoses: 12);

        Expect(chunks.Count == 4, $"one (scene, node) is one bake; a different NODE is a different rig (got {chunks.Count})");
        Expect(chunks[0].Count == 2, "…the two poses of a.tscn/Visuals batch together");
        Expect(chunks[3].Count == 1,
            "…and a rig the catalog comes back to later is NOT re-fused: re-sorting would move which bake runs "
            + "when, which is the one thing a resumed sweep and a forensic log both depend on");

        var capped = CouchCoopGeoclipPrerenderJob.RigChunks(
            [.. Enumerable.Range(0, 7).Select(i => Entry("big.tscn", "Visuals", $"anim_{i}"))],
            maxPoses: 3);
        Expect(capped.Count == 3 && capped[0].Count == 3 && capped[2].Count == 1,
            "a rig with more poses than the cap is split into runs of at most the cap");

        Expect(CouchCoopGeoclipPrerenderJob.RigChunks([], 12).Count == 0, "an empty catalog is no bakes");
    }

    // THE AMORTISATION. Three poses of one rig used to be three bakes — three scene loads, three bracket RID
    // sweeps and three slot↔mesh associations, which is 90-96 % of a pose-only bake paid three times.
    private static async Task ARigsPosesGoDownAsOneBakeAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker().Good("rig.tscn");
        var summary = await new CouchCoopGeoclipPrerenderJob(
            Host(Poses("rig.tscn")),
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            _ => { }).RunAsync();

        Expect(baker.Calls == 1, $"three poses of one rig are ONE bake (got {baker.Calls})");
        Expect(baker.LastAnimationsAsked is { Count: 3 },
            $"…and the bake was asked for all three (got {baker.LastAnimationsAsked?.Count ?? 0})");
        Expect(summary.Baked == 3 && summary.Failed == 0 && summary.Refused == 0,
            $"…and all three are stored (baked={summary.Baked} failed={summary.Failed} refused={summary.Refused})");
        Expect(summary.StoredPoses == 3 && summary.SharedPages == 1,
            "…as three separate pose directories sharing ONE atlas page, which is the point of baking them together");
    }

    // A batch is not a unit of judgement. The completeness guard is per pose, so one pose of a rig that does not
    // bake cleanly must be refused ON ITS OWN while its siblings go into the store — the measured merchant rig
    // has exactly this shape (`idle_loop` clean, `die` incomplete).
    private static async Task OnePoseMayBeRefusedWhileItsSiblingsAreStoredAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker().Good("mixed.tscn").Incomplete("mixed.tscn#die", complete: false);
        var summary = await new CouchCoopGeoclipPrerenderJob(
            Host(Poses("mixed.tscn")),
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            _ => { }).RunAsync();

        Expect(baker.Calls == 1, "still one bake for the rig");
        Expect(summary.Baked == 2 && summary.Refused == 1,
            $"two poses stored, one refused (baked={summary.Baked} refused={summary.Refused})");
        Expect(summary.RefusalReasons.TryGetValue("incomplete", out var count) && count == 1,
            "…bucketed under the arm that fired, exactly as the single lane buckets it");

        Expect(scope.Store.TryResolveDirectory(KeyFor("mixed.tscn", "idle_loop")) is not null,
            "the clean sibling really is resolvable");
        Expect(scope.Store.TryResolveDirectory(KeyFor("mixed.tscn", "die")) is null,
            "…and the refused pose is not");
        Expect(scope.Store.HasRefusal(KeyFor("mixed.tscn", "die")),
            "…and it left a receipt, so the next sweep does not pay for it again");
    }

    // A RESUMED sweep must not re-ask for what it already has. The filtering happens BEFORE the bake, so a rig
    // with one pose left costs one pose, not the whole rig.
    private static async Task AResumedSweepOnlyAsksForWhatItStillOwesAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var first = new ScriptedBaker().Good("resume.tscn");
        await new CouchCoopGeoclipPrerenderJob(
            Host(Poses("resume.tscn")),
            new CouchCoopGeoclipProvider(first, scope.Store, _ => { }),
            _ => { }).RunAsync();
        Expect(first.Calls == 1, "the cold sweep baked the rig once");

        // Same catalog plus one new pose. Everything else is on disk.
        SpineCatalogEntrySnapshot[] grown =
        [
            .. Poses("resume.tscn"),
            new SpineCatalogEntrySnapshot("res://resume.tscn", "Visuals/Spine", "hurt"),
        ];
        var second = new ScriptedBaker().Good("resume.tscn");
        var summary = await new CouchCoopGeoclipPrerenderJob(
            Host(grown),
            new CouchCoopGeoclipProvider(second, scope.Store, _ => { }),
            _ => { }).RunAsync();

        Expect(summary.Hits == 3 && summary.Baked == 1,
            $"three hits and one bake (hits={summary.Hits} baked={summary.Baked})");
        Expect(second.LastAnimationsAsked is null or { Count: 1 },
            "…and the producer was asked for the ONE pose that was missing, not for the rig");
    }

    // The other half of the page saving: a bake is told which atlas pages this host already holds, so it can
    // describe them instead of decoding and re-encoding them.
    private static async Task TheBakeIsToldWhichPagesThisHostAlreadyHasAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker().Good("pages_a.tscn", Pixels(5, 60)).Good("pages_b.tscn", Pixels(5, 60));

        await new CouchCoopGeoclipPrerenderJob(
            Host([.. Poses("pages_a.tscn"), .. Poses("pages_b.tscn")]),
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            _ => { }).RunAsync();

        var stored = CouchCoopGeoclipStore.PageFileNameFor(Pixels(5, 60), ".png");
        var stem = stored["sheet-".Length..^".png".Length];
        Expect(baker.LastKnownPageIds is not null && baker.LastKnownPageIds.Contains(stem),
            "the SECOND rig's bake was told the page the first rig published, by its content id");

        // Cold, the first bake could not have been told anything — otherwise the ids are just whatever this host
        // happened to have and the assertion above proves nothing about the wiring.
        using var coldScope = new Scope(armOnDemand: true);
        var coldBaker = new ScriptedBaker().Good("cold.tscn", Pixels(6, 70));
        await new CouchCoopGeoclipPrerenderJob(
            Host(Poses("cold.tscn")),
            new CouchCoopGeoclipProvider(coldBaker, coldScope.Store, _ => { }),
            _ => { }).RunAsync();
        Expect(coldBaker.LastKnownPageIds is null || coldBaker.LastKnownPageIds.Count == 0,
            "a cold store tells the first bake nothing");
    }

    private static string KeyFor(string scene, string anim)
        => CouchCoopSpineClipProvider.BuildSpineKey($"res://{scene}", "Visuals/Spine", anim);

    // ── The seam ───────────────────────────────────────────────────────────────────────────────────────────

    // POSE-ONLY IS STATED, NOT INHERITED. It defaults to true upstream today; saying it here means a default flip
    // in spirectl cannot silently start filling this store with whole-clip artifacts.
    private static void TheSeamAsksForASinglePoseExplicitly()
    {
        var command = new CouchCoopGeoclipBakeCommand(
            "res://scenes/creature_visuals/byrdonis.tscn",
            "Visuals",
            "idle_loop",
            SampleTimeSeconds: null,
            OutputDirectory: "/tmp/staging",
            Fps: CouchCoopGeoclipProvider.BakeFps,
            MaxFrames: CouchCoopGeoclipProvider.SinglePoseFrames);

        var request = CouchCoopRuntimeGeoclipBaker.ToRequest(command);
        Expect(request.PoseOnly, "a one-frame command asks for a POSE-ONLY bake");
        Expect(request.SceneResPath == command.SceneResPath && request.NodePath == "Visuals" && request.AnimationName == "idle_loop",
            "the identity reaches spirectl intact");
        Expect(request.OutputDirectory == "/tmp/staging" && request.Fps == CouchCoopGeoclipProvider.BakeFps,
            "so do the staging directory and the frame rate");
        Expect(request.MaxFrames == 1, "…and the frame cap");
        Expect(request.MaxOutputBytes == ManagedCacheQuota.DefaultEntryLimitBytes,
            "browser geoclip bakes always carry the managed-cache entry ceiling into the producer");
        Expect(request.SampleTimeSeconds is null,
            "no sample time is pinned, so the producer's own ChooseSampleTime rule picks the pose (one policy, not two)");

        var pinned = CouchCoopRuntimeGeoclipBaker.ToRequest(command with { SampleTimeSeconds = 2.5d });
        Expect(pinned.SampleTimeSeconds == 2.5d, "an explicitly requested pose time is forwarded");

        // PoseOnly is DERIVED from the frame cap, which is where the couch-side command already says what it
        // wants — so a whole-clip command stays a whole-clip bake instead of being silently truncated to a pose.
        Expect(!CouchCoopRuntimeGeoclipBaker.ToRequest(command with { MaxFrames = null }).PoseOnly,
            "a whole-clip command (MaxFrames null) is NOT pose-only");
        Expect(!CouchCoopRuntimeGeoclipBaker.ToRequest(command with { MaxFrames = 60 }).PoseOnly,
            "…nor is a multi-frame one");
    }

    // The forward is CouchCoopRuntimeHost.BakeSpineGeoClip, shaped like GetSpineCatalog: capability guard first.
    // The subtlety this pins is WHICH id. It used to be `asset-extraction`, because `spine-geoclip-bake` was
    // believed to be unpublished and requiring it would have refused every bake on every real host — it was
    // published all along, and the fallback only ever hid which gate had refused. So: the dedicated id, alone,
    // with a missing entry treated as refusal rather than as permission.
    private static void TheSeamIsGuardedOnACapabilityThisRuntimeActuallyPublishes()
    {
        // (0) The premise, checked rather than assumed: the id this guard requires is one spirectl publishes.
        // EmbeddableCapabilityIds.All is pinned to the facade's own list by a spirectl test, so a capability that
        // vanished upstream fails here instead of silently refusing every bake at runtime.
        Expect(EmbeddableCapabilityIds.All.Contains(CouchCoopRuntimeHost.SpineGeoClipBakeCapability),
            "spirectl publishes the capability this seam is guarded on");

        // (a) The real runtime: the dedicated id, supported.
        var live = new BakingRuntime();
        var baked = Seam(live, Capability(CouchCoopRuntimeHost.SpineGeoClipBakeCapability, supported: true)).Bake(Command("a.tscn"));
        Expect(live.Calls == 1, "with spine-geoclip-bake supported the bake reaches the runtime");
        Expect(baked.Success, "…and its result comes back");

        // (b) Unsupported ⇒ refuse, by name, WITHOUT calling the runtime. This is what "guarded" has to mean.
        var placeholder = new BakingRuntime();
        var refused = Seam(placeholder, Capability(CouchCoopRuntimeHost.SpineGeoClipBakeCapability, supported: false)).Bake(Command("b.tscn"));
        Expect(placeholder.Calls == 0, "an unsupported capability stops the call before the runtime is touched");
        Expect(!refused.Success && refused.ErrorCode == CouchCoopRuntimeGeoclipBaker.GeoclipBakeCapability,
            $"…and the refusal names the capability (got {refused.ErrorCode})");

        // (c) A runtime reporting NO capabilities at all also refuses — a missing entry is not permission.
        var silent = new BakingRuntime();
        var unknown = Seam(silent).Bake(Command("c.tscn"));
        Expect(silent.Calls == 0 && !unknown.Success, "a runtime that reports nothing is refused, not assumed capable");

        // (d) NO FALLBACK, both ways. asset-extraction being up says nothing about the bake…
        var extractionOnly = new BakingRuntime();
        var viaFallback = Seam(extractionOnly, Capability("asset-extraction", supported: true)).Bake(Command("d.tscn"));
        Expect(extractionOnly.Calls == 0 && !viaFallback.Success,
            "asset-extraction alone no longer stands in for the dedicated geoclip capability");

        // …and asset-extraction being down says nothing either: the dedicated id decides, alone.
        var dedicated = new BakingRuntime();
        var viaDedicated = Seam(dedicated,
            Capability("asset-extraction", supported: false),
            Capability(CouchCoopRuntimeHost.SpineGeoClipBakeCapability, supported: true)).Bake(Command("e.tscn"));
        Expect(dedicated.Calls == 1 && viaDedicated.Success,
            "the published spine-geoclip-bake capability is the only gate the bake is judged on");
    }

    // Translation only. The completeness counters are carried through UNJUDGED so that
    // CouchCoopGeoclipProvider.IncompletenessReason stays the single place that decides what they mean.
    private static void TheSeamMapsTheResultWithoutJudgingIt()
    {
        var mapped = CouchCoopRuntimeGeoclipBaker.Map(new SpineGeoClipBakeResultSnapshot(
            Success: true,
            ManifestPath: "/store/staging/manifest.json",
            PageFileNames: ["page-0.png", "page-1.png"],
            PartCount: 28,
            FrameCount: 1,
            SampleTimeSeconds: 6.6665d,
            SampleTimeSource: "mid",
            ElapsedMs: 5518.7d,
            Slots: 34,
            SlotsVisible: 28,
            Associated: 28,
            Unassociated: 0,
            ForeignMeshes: 0,
            Complete: true,
            Error: null));

        Expect(mapped.Success && mapped.ManifestPath == "/store/staging/manifest.json", "success and manifest path map across");
        Expect(mapped.PageFileNames.SequenceEqual(["page-0.png", "page-1.png"]), "the page list maps across");
        Expect(mapped.PartCount == 28 && mapped.FrameCount == 1, "the part and frame counts map across");
        Expect(mapped.SampleTimeSeconds == 6.6665d && mapped.SampleTimeSource == "mid",
            "the chosen pose and WHICH RULE chose it map across (G1 asserts on the latter)");
        Expect(mapped.ElapsedMs == 5519L, "elapsed ms rounds to the nearest millisecond");
        Expect(mapped.Complete && mapped.SlotsEverVisible == 28 && mapped.Associated == 28 && mapped.ForeignMeshes == 0,
            "the completeness counters map across");
        Expect(mapped.ErrorCode is null && mapped.ErrorMessage is null, "a successful bake carries no error");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(mapped) is null, "…and is admitted to the store");

        // The measured headless shape: the bake SUCCEEDS, writes a full directory, and reports itself incomplete
        // with slots that fell through to an atlas fallback. The mapper must not launder any of that.
        var headless = CouchCoopRuntimeGeoclipBaker.Map(new SpineGeoClipBakeResultSnapshot(
            true, "/store/staging/manifest.json", ["page-0.png"], 26, 1, 6.6665d, "mid", 14890d,
            Slots: 34, SlotsVisible: 28, Associated: 26, Unassociated: 2, ForeignMeshes: 4,
            Complete: false, Error: null));
        Expect(headless.Success, "a bake that ran to completion reports Success even when the rig was not covered");
        Expect(!headless.Complete && headless.Associated == 26 && headless.SlotsEverVisible == 28 && headless.ForeignMeshes == 4,
            "…and the counters that say so survive the mapping");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(headless) is not null,
            "…so the provider — not the mapper — is what refuses it");

        // Structured failures keep their code, kebab-cased under one prefix so a sweep can bucket them.
        var notImplemented = CouchCoopRuntimeGeoclipBaker.Map(SpineGeoClipBakeResultSnapshot.NotSupported("no live bridge"));
        Expect(!notImplemented.Success && notImplemented.ErrorCode == "geoclip-bake-not-implemented",
            $"a NotImplemented failure keeps its code (got {notImplemented.ErrorCode})");
        Expect(notImplemented.ErrorMessage is { Length: > 0 } && notImplemented.ErrorMessage.Contains("capability=spine-geoclip-bake", StringComparison.Ordinal),
            "…and folds the structured details into the message, which is all the provider surfaces");

        var runtimeFailure = CouchCoopRuntimeGeoclipBaker.Map(SpineGeoClipBakeResultSnapshot.Failure(
            AssetExtractFailureCode.RuntimeFailure, "the scene would not load.", []));
        Expect(runtimeFailure.ErrorCode == "geoclip-bake-runtime-failure", $"…as does a runtime failure (got {runtimeFailure.ErrorCode})");
        Expect(runtimeFailure.ErrorMessage == "the scene would not load.", "a detail-free failure keeps its bare message");
    }

    // THE PLUMBING THAT IS EASIEST TO SKIP AND HARDEST TO NOTICE MISSING.
    //
    // Couch keeps its own copy of spirectl's admission rule, and that rule's third arm grades the per-claim
    // ownership counters spirectl 71c92bc7 added. Those counters reach couch through ONE mapper. Drop them there
    // and the local rule sees 0/0 for every bake, reads that (correctly) as "no provenance", and answers with the
    // legacy bare-leftover arm — which refuses exactly what it refused before. Nothing throws, nothing regresses,
    // every suite stays green, and the entire upstream change does nothing on this route.
    //
    // So this asserts on the VERDICT, not on the field: the same snapshot with and without claim counts must
    // reach DIFFERENT admission answers, which is only true if the mapper carried them.
    private static void TheSeamCarriesClaimProvenanceIntoTheAdmissionRule()
    {
        // Complete, every drawable slot associated, leftovers in the bracket — the exact shape whose verdict the
        // ownership arm changed, and the one spirectl measured live on an Ironclad at anim=attack.
        static SpineGeoClipBakeResultSnapshot Snapshot(int claimsProven, int claimsUnproven)
            => new(
                Success: true,
                ManifestPath: "/store/staging/manifest.json",
                PageFileNames: ["page-0.png"],
                PartCount: 44,
                FrameCount: 1,
                SampleTimeSeconds: 0.5d,
                SampleTimeSource: "mid",
                ElapsedMs: 180d,
                Slots: 52,
                SlotsVisible: 44,
                Associated: 44,
                Unassociated: 0,
                ForeignMeshes: 8,
                Complete: true,
                Error: null,
                ClaimsProven: claimsProven,
                ClaimsUnproven: claimsUnproven);

        var proven = CouchCoopRuntimeGeoclipBaker.Map(Snapshot(claimsProven: 44, claimsUnproven: 0));
        Expect(proven is { ClaimsProven: 44, ClaimsUnproven: 0 }, "the mapper carries the claim counters across");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(proven) is null,
            "…and the rule ADMITS a fully proven bake that carries leftovers — the verdict the round turns on");

        var unproven = CouchCoopRuntimeGeoclipBaker.Map(Snapshot(claimsProven: 40, claimsUnproven: 4));
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(unproven) == "ownership=4 of claimed=44",
            $"…while an unproven claim beside those same leftovers refuses on the ownership arm "
            + $"(got '{CouchCoopGeoclipProvider.IncompletenessReason(unproven)}')");

        // THE NEGATIVE CONTROL, which is what makes the two above mean anything: identical counters, no
        // provenance. This is what couch would see for EVERY bake if the mapper dropped the fields, and it is a
        // different answer — so a passing pair above cannot be produced by a mapper that carries nothing.
        var blind = CouchCoopRuntimeGeoclipBaker.Map(Snapshot(claimsProven: 0, claimsUnproven: 0));
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(blind) == "claim-provenance-missing",
            $"a bake carrying no provenance is rejected — missing evidence is not clean evidence "
            + $"(got '{CouchCoopGeoclipProvider.IncompletenessReason(blind)}')");

        // Same again for the POSE mapper, which is the one the rig lane's per-pose verdict reads. It is a second
        // function on the same seam and drifted independently once already.
        var pose = CouchCoopRuntimeGeoclipBaker.MapPose(new SpineGeoClipBakePoseSnapshot(
            AnimationName: "attack",
            Success: true,
            ManifestPath: "/store/staging/attack/manifest.json",
            PageFileNames: ["page-0.png"],
            PartCount: 44,
            FrameCount: 1,
            SampleTimeSeconds: 0.5d,
            SampleTimeSource: "mid",
            Slots: 52,
            SlotsVisible: 44,
            Associated: 44,
            Unassociated: 0,
            ForeignMeshes: 8,
            StaleMeshFrames: 0,
            AttachmentDriftSlots: 0,
            Complete: true,
            Batched: true,
            FailureReason: null,
            ClaimsProven: 40,
            ClaimsUnproven: 4,
            ClaimProofNote: "atlas:uv-region-exact=40 atlas:containment=4"));
        Expect(pose is { ClaimsProven: 40, ClaimsUnproven: 4 }, "the pose mapper carries them too");
        Expect(pose.ClaimProofNote == "atlas:uv-region-exact=40 atlas:containment=4",
            "…including the producer's roll-up of WHICH evidence, which is what the host logs beside the verdict");
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(pose) == "ownership=4 of claimed=44",
            $"…and a pose is graded on its OWN claims (got '{CouchCoopGeoclipProvider.IncompletenessReason(pose)}')");

        // A pose carrying none is rejected exactly as the whole-result form is.
        var blindPose = pose with { ClaimsProven = 0, ClaimsUnproven = 0, ClaimProofNote = "" };
        Expect(CouchCoopGeoclipProvider.IncompletenessReason(blindPose) == "claim-provenance-missing",
            "a pose with no provenance is rejected");
    }

    // spirectl refuses a bake requested from the Godot MAIN THREAD rather than deadlocking on frames the blocked
    // thread cannot produce. That refusal arrives as a GENERIC runtime failure with the fact in a detail, so it
    // has to be lifted out: every other failure says something about the rig, this one says the host called the
    // seam wrongly, and a sweep that cannot tell them apart blames the creature.
    private static void TheSeamNamesAMainThreadRefusalSeparately()
    {
        var onMainThread = CouchCoopRuntimeGeoclipBaker.Map(SpineGeoClipBakeResultSnapshot.Failure(
            AssetExtractFailureCode.RuntimeFailure,
            "a geoclip bake cannot be requested from the STS2 main thread; it would deadlock.",
            [
                new AssetExtractDetail(
                    Field: "thread",
                    Value: "main",
                    Note: "Call BakeSpineGeoClip from a worker thread; the bake marshals itself onto the main thread."),
            ]));

        Expect(!onMainThread.Success, "a main-thread bake request fails");
        Expect(onMainThread.ErrorCode == CouchCoopRuntimeGeoclipBaker.MainThreadRefusalCode,
            $"…with its OWN code, not the generic runtime-failure bucket (got {onMainThread.ErrorCode})");
        Expect(onMainThread.ErrorMessage is { } text && text.Contains("thread=main", StringComparison.Ordinal),
            "…and the message says which thread, so a log reader does not have to know the code");

        // A different detail on the same failure code must NOT be mistaken for it.
        var otherDetail = CouchCoopRuntimeGeoclipBaker.Map(SpineGeoClipBakeResultSnapshot.Failure(
            AssetExtractFailureCode.RuntimeFailure,
            "the geoclip bake request is missing a required field: sceneResPath.",
            [new AssetExtractDetail("sceneResPath", "<missing>", "This field is required.")]));
        Expect(otherDetail.ErrorCode == "geoclip-bake-runtime-failure",
            $"another runtime failure keeps the generic code (got {otherDetail.ErrorCode})");
    }

    // The offload is load-bearing, not tidiness: the bake BLOCKS, and spirectl refuses it outright if it arrives
    // on the game's main thread. Driven from a dedicated non-pool thread so "not the caller's thread" is a fact
    // rather than a race — a pool caller could legitimately be handed the same pool thread back.
    private static async Task TheBakeNeverRunsOnTheCallersThreadAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker();
        var provider = new CouchCoopGeoclipProvider(baker, scope.Store, _ => { });

        var callerId = 0;
        var thread = new Thread(() =>
        {
            callerId = Environment.CurrentManagedThreadId;
            provider.GetAsync(Request("offload.tscn", "idle_loop")).GetAwaiter().GetResult();
        });
        thread.Start();
        await Task.Run(thread.Join);

        Expect(baker.Calls == 1, "the bake ran");
        Expect(baker.LastThreadId != callerId,
            "the bake does NOT run on the thread that asked for it — it is offloaded, so a blocking bake never "
            + "parks the request thread and can never arrive on the game's main thread");
        Expect(baker.LastWasThreadPoolThread, "…it runs on the thread pool");
        Expect(!thread.IsAlive, "the caller completed");
    }

    // ── The sweep ──────────────────────────────────────────────────────────────────────────────────────────

    private static async Task TheSweepCountsRefusedApartFromFailedAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker()
            .Good("good_a.tscn")
            .Good("good_b.tscn")
            .Incomplete("bad_flag.tscn", complete: false)
            .Incomplete("bad_assoc.tscn", slots: 44, associated: 40)
            .Incomplete("bad_foreign.tscn", foreignMeshes: 4)
            .Broken("dead.tscn", AssetExtractFailureCode.RuntimeFailure, "the scene would not load.");
        var runtime = Host(Entries("good_a.tscn", "good_b.tscn", "bad_flag.tscn", "bad_assoc.tscn", "bad_foreign.tscn", "dead.tscn"));
        var job = new CouchCoopGeoclipPrerenderJob(runtime, new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }), _ => { });

        var summary = await job.RunAsync();

        Expect(summary.Status == "complete", $"the sweep ran to the end (got {summary.Status})");
        Expect(summary.TotalClips == 6 && summary.Attempted == 6, "every catalog entry is attempted and accounted for");
        Expect(summary.Baked == 2 && summary.Hits == 0, "the two clean rigs baked");
        Expect(summary.Refused == 3,
            $"the three INCOMPLETE bakes are refused, not failed (refused {summary.Refused}, failed {summary.Failed})");
        Expect(summary.Failed == 1, $"only the bake that could not run at all failed (got {summary.Failed})");
        Expect(summary.Hits + summary.Baked + summary.Refused + summary.Failed == summary.Attempted,
            "the four buckets partition the attempts — nothing is counted twice or lost");

        // The refusal reasons are bucketed by WHICH arm of the completeness guard fired. Without that a reader
        // gets one distinct string per rig ("associated=40 of slotsEverVisible=44") and can conclude nothing.
        // This runs through the REAL provider, so a change to its message wording fails here rather than
        // silently collapsing every refusal into "other".
        Expect(summary.RefusalReasons.Count == 3, $"all three refusal arms are distinguished (got {summary.RefusalReasons.Count})");
        Expect(summary.RefusalReasons.TryGetValue("incomplete", out var flagged) && flagged == 1,
            "the baker's own complete=false verdict buckets as `incomplete`");
        Expect(summary.RefusalReasons.TryGetValue("unassociated", out var under) && under == 1,
            "a rig with slots it could not tie to a mesh buckets as `unassociated`");
        Expect(summary.RefusalReasons.TryGetValue("provenance", out var provenance) && provenance == 1,
            "missing claim provenance has its own refusal bucket");
        Expect(!summary.RefusalReasons.ContainsKey("other"), "…and none of them fell through to the catch-all");
        Expect(summary.RefusalReasons.Values.Sum() == summary.Refused, "the reason buckets sum to the refused count");

        Expect(summary.FailureCodes.TryGetValue("geoclip-bake-runtime-failure", out var dead) && dead == 1,
            "a hard failure is bucketed by its structured CODE, which is stable, not by its message");
        Expect(summary.FailureCodes.Values.Sum() == summary.Failed, "the failure buckets sum to the failed count");

        Expect(summary.StoredPoses == 2, "only the two admitted bakes are on disk");
        Expect(summary.ElapsedMs >= 0, "the sweep reports its wall time");
        Expect(summary.MeasureFailures == 0, "every stored pose could be sized, so the byte figures are exact");
        Expect(summary.RefusedCached == 0, $"a COLD sweep decided every refusal itself (got {summary.RefusedCached})");

        // A second sweep over the same catalog must bake NOTHING it has already decided. Both verdicts are
        // durable: a stored pose is a hit, and a refusal is remembered — which is the difference between a sweep
        // that converges and one that re-pays for ~half the catalog on every launch of a host that dies every
        // few hundred bakes.
        var resumedLines = new List<string>();
        var second = await new CouchCoopGeoclipPrerenderJob(
            runtime,
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            resumedLines.Add).RunAsync();
        Expect(second.Hits == 2 && second.Baked == 0, $"a re-run serves the two stored poses (hits {second.Hits}, baked {second.Baked})");
        Expect(second.Refused == 3, $"…and still reports the three refusals (got {second.Refused})");
        Expect(second.RefusedCached == 3,
            $"…every one of them REMEMBERED rather than re-baked, and said so (got {second.RefusedCached})");
        Expect(second.Refused == summary.Refused && second.Attempted == summary.Attempted,
            "the resumed sweep's headline numbers are COMPARABLE to the cold one's — refusedCached is a subset of "
            + "refused, not a fifth bucket that moves the total");
        Expect(
            second.RefusalReasons.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                .SequenceEqual(summary.RefusalReasons.OrderBy(pair => pair.Key, StringComparer.Ordinal)),
            "…including WHY each was refused: the receipt carries the bucketed arm, so a resumed sweep's table is "
            + "the same table");

        // The hard FAILURE is retried, and that asymmetry is deliberate: `complete=false` is a verdict about the
        // rig under this baker, while "the scene would not load" may be a verdict about the host five minutes ago.
        Expect(second.Failed == 1, "a bake that could not run at all is attempted again");
        Expect(baker.Calls == 7, $"…and is the ONLY thing re-baked (baker calls {baker.Calls}, expected 6 + 1)");

        // The `start` line exists to name the item that might take the process down, so it is emitted only for
        // items that can actually bake. A remembered refusal cannot, and announcing several hundred of them would
        // bury the one line a truncated log is read for.
        var starts = resumedLines.Where(line => line.Contains(" start key=", StringComparison.Ordinal)).ToArray();
        Expect(starts.Length == 1, $"a resumed sweep announces only the item that will really bake (got {starts.Length})");
        Expect(starts[0].Contains(Key("dead.tscn", "idle_loop"), StringComparison.Ordinal),
            "…which is the hard failure, not any of the remembered refusals: " + starts[0]);
    }

    // The host DIES SILENTLY mid-bake in a measured ~quarter of sessions, at or inside the per-scene RID sweep,
    // with no dump and a truncated log. So the sweep must resume from DISK, not from memory — and the only
    // forensic trail a silent death leaves is the identity logged BEFORE the bake that killed it.
    private static async Task TheSweepResumesFromTheStoreAfterADeathAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var catalog = Entries("resume_1.tscn", "resume_2.tscn", "resume_3.tscn", "resume_4.tscn");

        // Run 1 dies after the second bake — a hard kill, so nothing gets to write progress state anywhere.
        var firstBaker = new ScriptedBaker().ThrowAfter(2, new InvalidOperationException("the process died here"));
        var firstLines = new List<string>();
        var first = await new CouchCoopGeoclipPrerenderJob(
            Host(catalog),
            new CouchCoopGeoclipProvider(firstBaker, scope.Store, _ => { }),
            firstLines.Add).RunAsync();
        Expect(first.Baked == 2, $"the first run got two poses in before dying (got {first.Baked})");

        // The item that killed it is identifiable from the log ALONE, because its identity was announced first.
        var thirdKey = Key("resume_3.tscn", "idle_loop");
        Expect(firstLines.Any(line => line.Contains(" start key=" + thirdKey, StringComparison.Ordinal)),
            "the identity of the item being baked is logged BEFORE the bake — otherwise a silent death is anonymous");
        Expect(
            firstLines.FindIndex(line => line.Contains(" start key=" + thirdKey, StringComparison.Ordinal))
                < firstLines.FindIndex(line => line.Contains("status=failed key=" + thirdKey, StringComparison.Ordinal)),
            "…strictly before its outcome line, which a truncated log would not contain");

        // Run 2, a fresh job and a fresh provider, as a relaunched process would be.
        var secondBaker = new ScriptedBaker();
        var second = await new CouchCoopGeoclipPrerenderJob(
            Host(catalog),
            new CouchCoopGeoclipProvider(secondBaker, scope.Store, _ => { }),
            _ => { }).RunAsync();

        Expect(second.Hits == 2, $"the relaunched sweep SKIPS what the dead run already stored (got {second.Hits})");
        Expect(second.Baked == 2, $"…and bakes only the remainder (got {second.Baked})");
        Expect(secondBaker.Calls == 2, $"the two stored identities are never re-baked (baker calls {secondBaker.Calls})");
        Expect(second.StoredPoses == 4 && second.Status == "complete", "…and the store ends up complete across the two runs");
    }

    // The round's transfer claim is "a rig pays for its atlas once", so the sweep's byte report has to count a
    // shared page ONCE. Both figures are published — shared and naive — so the saving is visible, not asserted.
    private static async Task TheSweepReportsPagesSharedNotSummedAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var atlas = Pixels(seed: 7, length: 512);
        var baker = new ScriptedBaker()
            .Good("rig.tscn", atlas)          // idle_loop
            .Good("rig.tscn#attack", atlas)   // a second pose of the SAME rig, same atlas bytes
            .Good("other.tscn", Pixels(seed: 9, length: 64));
        var runtime = Host([
            new SpineCatalogEntrySnapshot("res://rig.tscn", "Visuals/Spine", "idle_loop"),
            new SpineCatalogEntrySnapshot("res://rig.tscn", "Visuals/Spine", "attack"),
            new SpineCatalogEntrySnapshot("res://other.tscn", "Visuals/Spine", "idle_loop"),
        ]);

        var lines = new List<string>();
        var summary = await new CouchCoopGeoclipPrerenderJob(runtime, new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }), lines.Add)
            .RunAsync();

        Expect(summary.Baked == 3 && summary.StoredPoses == 3, "three poses stored");
        Expect(summary.PageReferences == 3, "…referencing a page three times between them");
        Expect(summary.SharedPages == 2,
            $"…but only TWO distinct pages exist on disk: the rig's two poses share one atlas (got {summary.SharedPages})");
        Expect(summary.SharedPageBytes == 512 + 64,
            $"the page cost is each DISTINCT page counted once (got {summary.SharedPageBytes}, expected {512 + 64})");
        Expect(summary.PageBytesUnshared == 512 + 512 + 64,
            $"…and the naive per-pose sum is reported beside it so the sharing is measurable (got {summary.PageBytesUnshared})");
        Expect(summary.PageBytesUnshared - summary.SharedPageBytes == 512,
            "the gap between the two IS the page sharing — one atlas not paid for twice");

        // The geometry half must be pose-local only: no page bytes folded in, and no .complete receipt (which no
        // client ever fetches). Sizing it from disk keeps the assertion honest about what the store holds.
        var poseBytes = Directory.EnumerateDirectories(scope.Store.RootPath!)
            .Where(directory => Path.GetFileName(directory) is not CouchCoopGeoclipStore.PagesFolderName
                and not CouchCoopGeoclipStore.StagingFolderName
                and not CouchCoopGeoclipStore.RefusalsFolderName)
            .SelectMany(Directory.EnumerateFiles)
            .Where(file => Path.GetFileName(file) != CouchCoopGeoclipStore.CompleteMarkerName)
            .Sum(file => new FileInfo(file).Length);
        Expect(summary.GeometryBytes == poseBytes,
            $"the geometry figure is exactly the pose-local bytes on disk (got {summary.GeometryBytes}, disk {poseBytes})");
        Expect(summary.TotalStoredBytes == summary.GeometryBytes + summary.SharedPageBytes,
            "the total is geometry plus pages-counted-once");
        Expect(summary.TotalStoredBytes < summary.GeometryBytes + summary.PageBytesUnshared,
            "…which is strictly less than the double-counting sum, and that difference is the round's claim");

        // The per-item line makes a MARGINAL claim ("this pose added N new pages costing B bytes"), and that is
        // the number an operator watching a sweep reads to see sharing happen. Unasserted it is decoration: the
        // summary's totals stay correct even if every item claims to have added a fresh atlas.
        var items = lines
            .Where(line => line.Contains("status=baked key=", StringComparison.Ordinal))
            .ToArray();
        Expect(items.Length == 3, $"one baked line per item (got {items.Length})");
        Expect(items[0].Contains("newPages=1 newPageBytes=512", StringComparison.Ordinal),
            "the rig's FIRST pose pays for the atlas: " + items[0]);
        Expect(items[1].Contains("pages=1 newPages=0 newPageBytes=0", StringComparison.Ordinal),
            "its SECOND pose references the same page and adds NOTHING — geometry only, which is the payoff: " + items[1]);
        Expect(items[2].Contains("newPages=1 newPageBytes=64", StringComparison.Ordinal),
            "a different rig pays for its own atlas: " + items[2]);
    }

    // "Are deltas cheaper than the stills they replace?" has NO global answer — it depends on a rig's atlas size
    // against its own stills. A big-atlas rig with few poses never breaks even; a small-atlas rig with many poses
    // wins several fold. The sweep's job is to turn that into a table instead of an argument.
    private static async Task TheSweepAnswersDeltaVersusRasterPerRigAsync()
    {
        using var scope = new Scope(armOnDemand: true);

        // cheap.tscn: a small atlas, two poses. big.tscn: an atlas that dwarfs its own stills.
        // silent.tscn: no raster baseline cached at all — a third, distinct verdict.
        var catalog = new[]
        {
            new SpineCatalogEntrySnapshot("res://cheap.tscn", "Visuals/Spine", "idle_loop"),
            new SpineCatalogEntrySnapshot("res://cheap.tscn", "Visuals/Spine", "attack"),
            new SpineCatalogEntrySnapshot("res://big.tscn", "Visuals/Spine", "idle_loop"),
            new SpineCatalogEntrySnapshot("res://silent.tscn", "Visuals/Spine", "idle_loop"),
        };
        var baker = new ScriptedBaker()
            .Good("cheap.tscn", Pixels(1, 400))
            .Good("cheap.tscn#attack", Pixels(1, 400))
            .Good("big.tscn", Pixels(2, 40_000))
            .Good("silent.tscn", Pixels(3, 100));

        // The raster baseline is the still cache the /spines/ lane already writes, probed by the SAME key that
        // lane uses — so this measures against the real thing rather than a number typed into a test.
        var raster = new SpirectlAssetBinaryCache(Path.Combine(Path.GetTempPath(), "couchcoop-raster-" + Guid.NewGuid().ToString("N")));
        try
        {
            foreach (var entry in catalog.Where(candidate => !candidate.SceneResPath.Contains("silent", StringComparison.Ordinal)))
            {
                await raster.WriteAsync(
                    CouchCoopSpineClipProvider.BuildSpineKey(entry.SceneResPath, entry.NodePath, entry.AnimationName, still: true),
                    Pixels(5, entry.SceneResPath.Contains("cheap", StringComparison.Ordinal) ? 4_000 : 3_000),
                    "image/webp");
            }

            var summary = await new CouchCoopGeoclipPrerenderJob(
                Host(catalog),
                new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
                _ => { },
                raster).RunAsync();

            Expect(summary.RigCount == 3 && summary.Rigs.Count == 3,
                $"one row per RIG — poses of one rig collapse into one row (got {summary.RigCount})");

            var cheap = summary.Rigs.Single(row => row.Scene == "res://cheap.tscn");
            Expect(cheap.Node == "Visuals/Spine", "a rig is (scene, node), and the row says which");
            Expect(cheap.Poses == 2, "…and how many of its poses are stored");
            Expect(cheap.Pages == 1 && cheap.PageBytes == 400,
                $"its shared atlas is counted ONCE for the rig (pages {cheap.Pages}, bytes {cheap.PageBytes})");
            Expect(cheap.TotalBytes == cheap.GeometryBytes + cheap.PageBytes, "the rig total is geometry plus its atlas");
            Expect(cheap.RasterSamples == 2 && cheap.RasterBytes == 8_000,
                $"the raster baseline is the stills already cached for those same poses (got {cheap.RasterBytes})");
            Expect(cheap.BreakEvenPoses is { } n && n >= 1, $"a small-atlas rig breaks even at some pose count (got {cheap.BreakEvenPoses})");
            Expect(cheap.Verdict == $"breaks-even-at-{cheap.BreakEvenPoses}", "…and the verdict states it in words");

            var big = summary.Rigs.Single(row => row.Scene == "res://big.tscn");
            Expect(big.PageBytes == 40_000 && big.RasterSamples == 1, "the big rig's atlas dwarfs the one still it replaces");
            Expect(big.Verdict == "never" || big.BreakEvenPoses > 4,
                $"…so it does not pay off inside its own animation list (verdict {big.Verdict}, n {big.BreakEvenPoses})");

            var silent = summary.Rigs.Single(row => row.Scene == "res://silent.tscn");
            Expect(silent.RasterSamples == 0 && silent.RasterBytes == 0, "a rig with no cached still has no baseline");
            Expect(silent.Verdict == "no-raster-baseline" && silent.BreakEvenPoses is null,
                $"…and says so rather than reporting a comparison against zero (got {silent.Verdict})");

            // The per-rig page bytes are the rig's own marginal cost, so they can exceed the sweep-wide figure
            // when two rigs share an atlas — here they do not, and the two views must agree.
            Expect(summary.Rigs.Sum(row => row.GeometryBytes) == summary.GeometryBytes,
                "the per-rig geometry sums to the sweep's geometry");
            Expect(summary.Rigs.Sum(row => row.PageBytes) == summary.SharedPageBytes,
                "…and with no cross-rig sharing, so do the page bytes");
        }
        finally
        {
            try { Directory.Delete(raster.RootPath!, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // Production is unconditional, so a host with no geoclip environment configuration still sweeps.
    private static async Task TheSweepRunsOnAnUntouchedEnvironmentAsync()
    {
        var cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-default-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new CouchCoopGeoclipStore(cacheRoot);
            var baker = new ScriptedBaker().Good("default.tscn");
            var lines = new List<string>();

            var summary = await new CouchCoopGeoclipPrerenderJob(
                Host(Entries("default.tscn")),
                new CouchCoopGeoclipProvider(baker, store, _ => { }),
                lines.Add).RunAsync();

            Expect(summary.Status != "disabled", $"an untouched host sweeps (got status {summary.Status})");
            Expect(summary.Attempted > 0, $"…and actually attempts its catalog (attempted={summary.Attempted})");
            Expect(baker.Calls > 0, $"…through the baker (calls={baker.Calls})");
            Expect(
                !lines.Any(line => line.Contains("REFUSED to start", StringComparison.Ordinal)),
                "…and prints no obsolete production-arm refusal");
        }
        finally
        {
            try { Directory.Delete(cacheRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // The summary line is what a coordinator parses out of a 1000-entry sweep, so its SHAPE is a contract.
    private static async Task TheSummaryJsonHasTheShapeAReaderParsesAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var baker = new ScriptedBaker().Good("shape.tscn").Incomplete("shape_bad.tscn", complete: false);
        var runtime = Host(Entries("shape.tscn", "shape_bad.tscn"));
        var lines = new List<string>();

        await new CouchCoopGeoclipPrerenderJob(runtime, new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }), lines.Add)
            .RunAsync();

        // The LAST summary line is the authoritative one; the sweep also emits running snapshots ahead of it.
        var line = lines.Last(candidate => candidate.StartsWith(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix, StringComparison.Ordinal));
        Expect(line.StartsWith("COUCHCOOP_GEOCLIP_PRERENDER {", StringComparison.Ordinal),
            "the summary is one grep-able prefix followed by JSON");
        using var document = JsonDocument.Parse(line[(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix.Length + 1)..]);
        var root = document.RootElement;

        string[] expected =
        [
            "status", "discoveredScenes", "spineNodes", "totalClips", "attempted", "hits", "baked", "refused",
            "refusedCached", "failed", "refusalReasons", "failureCodes", "storedPoses", "geometryBytes",
            "sharedPages", "pageReferences", "sharedPageBytes", "pageBytesUnshared", "totalStoredBytes",
            "measureFailures", "rigCount", "rigs", "elapsedMs",
        ];
        var actual = root.EnumerateObject().Select(property => property.Name).ToArray();
        Expect(actual.SequenceEqual(expected),
            "the summary carries exactly the documented camelCase keys, in order: " + string.Join(",", actual));

        Expect(root.GetProperty("status").GetString() == "complete", "status is a string");
        Expect(root.GetProperty("baked").GetInt32() == 1 && root.GetProperty("refused").GetInt32() == 1,
            "the counts a reader acts on are plain integers");
        Expect(root.GetProperty("refusalReasons").GetProperty("incomplete").GetInt32() == 1,
            "refusalReasons is an object keyed by the guard arm that fired");
        Expect(root.GetProperty("totalStoredBytes").GetInt64() > 0, "the byte totals are numbers, not strings");

        string[] expectedRig =
        [
            "scene", "node", "poses", "refused", "failed", "geometryBytes", "pages", "pageBytes", "totalBytes",
            "rasterBytes", "rasterSamples", "breakEvenPoses", "verdict",
        ];
        var rigs = root.GetProperty("rigs");
        Expect(rigs.GetArrayLength() == 2, $"one row per rig rides in the summary (got {rigs.GetArrayLength()})");
        var rigKeys = rigs[0].EnumerateObject().Select(property => property.Name).ToArray();
        Expect(rigKeys.SequenceEqual(expectedRig),
            "a rig row carries exactly the documented keys, in order: " + string.Join(",", rigKeys));
        Expect(rigs.EnumerateArray().Any(row => row.GetProperty("refused").GetInt32() == 1),
            "a rig that does not bake cleanly is visible IN ITS OWN ROW, not only in the global tally");

        // The same rows also go out one per line, because a per-rig grep is what a reader does with a table of a
        // few hundred, and one surviving row beats none if the process dies before the summary.
        var rigLines = lines.Where(candidate => candidate.StartsWith(CouchCoopGeoclipPrerenderJob.RigLogPrefix, StringComparison.Ordinal)).ToArray();
        Expect(rigLines.Length >= 2, $"each rig gets its own grep-able line (got {rigLines.Length})");
        using var rigDocument = JsonDocument.Parse(rigLines[^1][(CouchCoopGeoclipPrerenderJob.RigLogPrefix.Length + 1)..]);
        Expect(rigDocument.RootElement.GetProperty("scene").GetString() is { Length: > 0 },
            "…carrying the same row shape as the array");
        Expect(
            rigLines.Select(RigRowScene).Distinct(StringComparer.Ordinal).OrderBy(scene => scene, StringComparer.Ordinal)
                .SequenceEqual(
                    rigs.EnumerateArray().Select(row => row.GetProperty("scene").GetString()!)
                        .OrderBy(scene => scene, StringComparer.Ordinal),
                    StringComparer.Ordinal),
            "the lines and the array describe the same set of rigs — a reader who greps the lines because the "
            + "summary never arrived is not looking at a different table");

        // A rig row may legitimately appear MORE than once (a running flush, then the final emission), so the
        // reading rule is "last line per rig wins". Pin it: every rig's last line must equal the final array row.
        foreach (var row in rigs.EnumerateArray())
        {
            var scene = row.GetProperty("scene").GetString()!;
            var last = rigLines.Last(candidate => string.Equals(RigRowScene(candidate), scene, StringComparison.Ordinal));
            Expect(
                last[(CouchCoopGeoclipPrerenderJob.RigLogPrefix.Length + 1)..] == row.GetRawText(),
                $"the LAST line for {scene} is byte-identical to its row in the final summary");
        }
    }

    private static string RigRowScene(string rigLine)
    {
        using var document = JsonDocument.Parse(rigLine[(CouchCoopGeoclipPrerenderJob.RigLogPrefix.Length + 1)..]);
        return document.RootElement.GetProperty("scene").GetString()!;
    }

    // ── Progress that survives a kill ──────────────────────────────────────────────────────────────────────

    // THE DEFECT THIS EXISTS FOR. Two full sweeps of the real catalog died silently mid-bake, at items 406 and
    // 857 of 1175, and reported NOTHING — every rig row and the summary were emitted only after the last item, so
    // 318 poses sat on disk with no table describing any of them, twice. The property is therefore not "the job
    // logs progress" but "the log is already useful at the instant of the death", which is what is asserted here:
    // the lines emitted BEFORE a chosen bake begins are snapshotted, and that snapshot is all a `kill -9` at that
    // instant would ever have left behind.
    private static async Task ProgressIsOnDiskBeforeTheBakeThatCouldKillTheProcessAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        SpineCatalogEntrySnapshot[] catalog =
        [
            .. Poses("rig_a.tscn"), .. Poses("rig_b.tscn"), .. Poses("rig_c.tscn"), .. Poses("rig_d.tscn"),
        ];

        var lines = new List<string>();
        string[] atDeath = [];
        var baker = new ScriptedBaker()
            .Good("rig_a.tscn", Pixels(1, 100))
            .Good("rig_b.tscn", Pixels(2, 200))
            .Good("rig_c.tscn", Pixels(3, 300))
            .Good("rig_d.tscn", Pixels(4, 400))
            // A rig is ONE bake now, so the death lands at the start of rig_c's bake rather than partway
            // through its poses — which is the same forensic question, asked of a bigger unit of work.
            .Watch(command =>
            {
                if (command.SceneResPath == "res://rig_c.tscn")
                {
                    atDeath = [.. lines];
                }
            });

        var summary = await new CouchCoopGeoclipPrerenderJob(
            Host(catalog),
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            lines.Add).RunAsync();

        Expect(atDeath.Length > 0, "the snapshot was taken (rig_c's bake ran)");
        Expect(!atDeath.Any(IsSummaryWithStatus("complete")),
            "a process killed here emits NO final summary — that is the whole problem, restated as a control");

        // …and yet the rigs it had finished are already reported, in full.
        var rigA = SoleRigRow(atDeath, "res://rig_a.tscn");
        var rigB = SoleRigRow(atDeath, "res://rig_b.tscn");
        Expect(rigA.GetProperty("poses").GetInt32() == 3 && rigB.GetProperty("poses").GetInt32() == 3,
            "each finished rig's row is on disk with all three of its poses counted");
        Expect(rigA.GetProperty("pages").GetInt32() == 1 && rigA.GetProperty("pageBytes").GetInt64() == 100,
            "…and its atlas accounting, counted once for the rig");
        Expect(rigB.GetProperty("pageBytes").GetInt64() == 200, "…per rig, not shared across the table");
        Expect(rigA.GetProperty("geometryBytes").GetInt64() > 0 && rigA.GetProperty("verdict").GetString() is { Length: > 0 },
            "…and the delta-vs-raster columns the round asked for, which is what nobody could obtain");

        Expect(!atDeath.Any(line => line.StartsWith(CouchCoopGeoclipPrerenderJob.RigLogPrefix, StringComparison.Ordinal)
                && RigRowScene(line) == "res://rig_c.tscn"),
            "the rig currently being swept has NOT been reported: a row is emitted when the sweep moves OFF a rig, "
            + "so a row on disk describes a rig that is done rather than one caught mid-flight");

        // The running snapshot, and its counters.
        var partial = LastSummaryWithStatus(atDeath, CouchCoopGeoclipPrerenderJob.StatusPartial);
        Expect(partial.GetProperty("baked").GetInt32() == 6,
            $"the running snapshot counts the six poses already stored (got {partial.GetProperty("baked").GetInt32()})");
        Expect(partial.GetProperty("rigCount").GetInt32() == 2, "…across the two rigs it has finished");
        Expect(partial.GetProperty("totalClips").GetInt32() == 12, "…out of the whole discovered catalog");
        Expect(partial.GetProperty("storedPoses").GetInt32() == 6 && partial.GetProperty("totalStoredBytes").GetInt64() > 0,
            "…and carries the same byte accounting as the final one, so progress is measurable while it happens");

        // The end-of-sweep emission is UNCHANGED: a completed sweep still produces the whole table.
        Expect(summary.Status == "complete" && summary.RigCount == 4 && summary.Rigs.Count == 4,
            "a sweep that finishes reports all four rigs exactly as before");
        var finalRigLines = lines
            .Where(line => line.StartsWith(CouchCoopGeoclipPrerenderJob.RigLogPrefix, StringComparison.Ordinal))
            .Select(RigRowScene)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        Expect(finalRigLines.Length == 4, $"…one line per rig by the end (got {finalRigLines.Length})");
    }

    // The other trigger, on its own. A rig with many poses (or a catalog that interleaves rigs) would otherwise
    // run for as long as it likes without saying anything, so the item backstop has to fire without a rig change
    // — and a chunk is what a death can lose, so the cadence is one flush per BAKE. A rig with more poses than
    // MaxRigBatchPoses is split, which is the only case where a chunk boundary is not also a rig boundary.
    private static async Task ARigTooBigForOneBakeStillFlushesBetweenItsChunksAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var many = Enumerable.Range(0, 30)
            .Select(index => new SpineCatalogEntrySnapshot("res://one_rig.tscn", "Visuals/Spine", $"anim_{index}"))
            .ToArray();
        var lines = new List<string>();
        await new CouchCoopGeoclipPrerenderJob(
            Host(many),
            new CouchCoopGeoclipProvider(new ScriptedBaker().Good("one_rig.tscn"), scope.Store, _ => { }),
            lines.Add).RunAsync();

        // 30 poses at a cap of 12 is three bakes, so two flushes sit between them.
        var partials = lines.Where(IsSummaryWithStatus(CouchCoopGeoclipPrerenderJob.StatusPartial)).ToArray();
        Expect(partials.Length == 2,
            $"one rig, thirty poses, a cap of {CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses} ⇒ three bakes and "
            + $"two flushes between them (got {partials.Length})");
        using var firstSnapshot = JsonDocument.Parse(partials[0][(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix.Length + 1)..]);
        Expect(
            firstSnapshot.RootElement.GetProperty("attempted").GetInt32() == CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses,
            "…the first covering exactly the chunk behind it (got "
            + $"{firstSnapshot.RootElement.GetProperty("attempted").GetInt32()})");
        Expect(firstSnapshot.RootElement.GetProperty("rigCount").GetInt32() == 1, "…of the one rig in flight");

        // The bound, from the other side: a rig that FITS in one bake is one bake, and a sweep of it says nothing
        // while it runs. A cadence that spams 1 175 items is not a fix.
        using var quietScope = new Scope(armOnDemand: true);
        var few = Enumerable.Range(0, CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses)
            .Select(index => new SpineCatalogEntrySnapshot("res://quiet_rig.tscn", "Visuals/Spine", $"anim_{index}"))
            .ToArray();
        var quiet = new List<string>();
        var quietBaker = new ScriptedBaker().Good("quiet_rig.tscn");
        await new CouchCoopGeoclipPrerenderJob(
            Host(few),
            new CouchCoopGeoclipProvider(quietBaker, quietScope.Store, _ => { }),
            quiet.Add).RunAsync();
        Expect(!quiet.Any(IsSummaryWithStatus(CouchCoopGeoclipPrerenderJob.StatusPartial)),
            "a single-rig sweep that fits in one bake emits no running snapshot at all");
        Expect(
            quiet.Count(line => line.StartsWith(CouchCoopGeoclipPrerenderJob.RigLogPrefix, StringComparison.Ordinal)) == 1,
            "…and exactly one rig line, the final one");

        // AND IT WAS ONE BAKE. This is the amortisation itself: twelve poses of one rig used to cost twelve scene
        // loads, twelve bracket sweeps and twelve associations.
        Expect(quietBaker.Calls == 1,
            $"twelve poses of one rig are ONE bake, not twelve (got {quietBaker.Calls})");
    }

    // A progress line that reads like a verdict is worse than no progress line: a reader who greps the last
    // COUCHCOOP_GEOCLIP_PRERENDER out of a truncated log must be able to tell in one field whether the sweep
    // finished. Same keys in the same order (one parser), one field different.
    private static async Task APartialSnapshotIsDistinguishableFromTheFinalOneAsync()
    {
        using var scope = new Scope(armOnDemand: true);
        var lines = new List<string>();
        await new CouchCoopGeoclipPrerenderJob(
            Host([.. Poses("split_a.tscn"), .. Poses("split_b.tscn")]),
            new CouchCoopGeoclipProvider(new ScriptedBaker(), scope.Store, _ => { }),
            lines.Add).RunAsync();

        var summaries = lines
            .Where(line => line.StartsWith(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix, StringComparison.Ordinal))
            .ToArray();
        Expect(summaries.Length == 2, $"one running snapshot plus the final summary (got {summaries.Length})");
        using var partial = JsonDocument.Parse(summaries[0][(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix.Length + 1)..]);
        using var final = JsonDocument.Parse(summaries[^1][(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix.Length + 1)..]);

        Expect(partial.RootElement.GetProperty("status").GetString() == "partial",
            "the running snapshot says `partial`");
        Expect(final.RootElement.GetProperty("status").GetString() == "complete",
            "…and the final one says `complete`, in the same field");
        Expect(
            partial.RootElement.EnumerateObject().Select(property => property.Name)
                .SequenceEqual(final.RootElement.EnumerateObject().Select(property => property.Name)),
            "both carry the same keys in the same order, so ONE parser reads both");

        // The rows do not ride inside a snapshot — they are on their own lines, which is what makes them survive
        // independently — but the COUNT does, so an empty array never reads as "no rigs found".
        Expect(partial.RootElement.GetProperty("rigs").GetArrayLength() == 0,
            "a snapshot does not repeat the whole table (a few hundred rows, a few hundred times)");
        Expect(partial.RootElement.GetProperty("rigCount").GetInt32() == 1,
            "…while still saying how many rigs it has seen");
        Expect(final.RootElement.GetProperty("rigs").GetArrayLength() == 2
            && final.RootElement.GetProperty("rigCount").GetInt32() == 2,
            "the final summary carries the table itself, exactly as it always did");
    }

    // ── Harness ────────────────────────────────────────────────────────────────────────────────────────────

    private static Func<string, bool> IsSummaryWithStatus(string status)
        => line => line.StartsWith(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix, StringComparison.Ordinal)
            && line.Contains($"\"status\":\"{status}\"", StringComparison.Ordinal);

    private static JsonElement LastSummaryWithStatus(IEnumerable<string> lines, string status)
    {
        var matches = lines.Where(IsSummaryWithStatus(status)).ToArray();
        Expect(matches.Length > 0, $"a `{status}` summary had been emitted by this point (got none)");
        return JsonDocument.Parse(matches[^1][(CouchCoopGeoclipPrerenderJob.SummaryLogPrefix.Length + 1)..]).RootElement;
    }

    private static JsonElement SoleRigRow(IEnumerable<string> lines, string scene)
    {
        var matches = lines
            .Where(candidate => candidate.StartsWith(CouchCoopGeoclipPrerenderJob.RigLogPrefix, StringComparison.Ordinal)
                && RigRowScene(candidate) == scene)
            .ToArray();
        Expect(matches.Length == 1,
            $"exactly one row for {scene} had been emitted by this point — one is the progress this rig made, "
            + $"none means a killed process reports nothing, more means every flush repeats the table (got {matches.Length})");
        return JsonDocument.Parse(matches[0][(CouchCoopGeoclipPrerenderJob.RigLogPrefix.Length + 1)..]).RootElement;
    }

    /// <summary>Three poses of one rig — enough that a rig row says something a per-item line does not.</summary>
    private static SpineCatalogEntrySnapshot[] Poses(string scene)
        => [.. new[] { "idle_loop", "attack", "die" }
            .Select(anim => new SpineCatalogEntrySnapshot($"res://{scene}", "Visuals/Spine", anim))];

    private static string Key(string scene, string anim)
        => CouchCoopSpineClipProvider.BuildSpineKey($"res://{scene}", "Visuals/Spine", anim);

    private static CouchCoopGeoclipRequest Request(string scene, string anim)
        => new(Key(scene, anim), $"res://{scene}", "Visuals/Spine", anim);

    private static SpineCatalogEntrySnapshot[] Entries(params string[] scenes)
        => [.. scenes.Select(scene => new SpineCatalogEntrySnapshot($"res://{scene}", "Visuals/Spine", "idle_loop"))];

    private static CouchCoopGeoclipBakeCommand Command(string scene)
        => new($"res://{scene}", "Visuals/Spine", "idle_loop", null, "/tmp/unused", 15, 1);

    private static EmbeddableRuntimeCapability Capability(string id, bool supported)
        => new(id, id, supported, Provisional: false, supported ? null : "stubbed unsupported");

    private static CouchCoopRuntimeHost Host(IReadOnlyList<SpineCatalogEntrySnapshot> entries)
        => new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries), new CatalogRuntime(entries)), _ => { });

    private static byte[] Pixels(int seed, int length)
        => [.. Enumerable.Range(0, length).Select(index => (byte)((index * 31 + seed * 7) & 0xFF))];

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException("geoclip prerender expectation failed: " + because);
        }
    }

    /// <summary>A store on a throwaway cache root.</summary>
    private sealed class Scope : IDisposable
    {
        private readonly string _cacheRoot = Path.Combine(Path.GetTempPath(), "couchcoop-geoclip-sweep-" + Guid.NewGuid().ToString("N"));
        public Scope(bool armOnDemand)
        {
            // This suite's scripted bakes are deliberately tiny. Use a tiny deterministic quota so batching
            // assertions do not depend on the host filesystem having the production 3 GiB staging headroom
            // (12 poses × two 128 MiB reservations plus the production free-space reserve).
            Store = new CouchCoopGeoclipStore(
                _cacheRoot,
                new ManagedCacheQuota(
                    _cacheRoot,
                    ceilingBytes: 8 * 1024 * 1024,
                    freeSpaceReserveBytes: 0,
                    entryLimitBytes: 64 * 1024,
                    allocationUnitBytes: 1));
        }

        public CouchCoopGeoclipStore Store { get; }

        public void Dispose()
        {
            try { Directory.Delete(_cacheRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>
    /// A baker scripted per scene: clean, incomplete (each arm), or hard-failing. An incomplete bake still WRITES
    /// a well-formed directory — that is the whole hazard the provider's refusal exists for, so the fake has to
    /// reproduce it rather than conveniently writing nothing.
    /// </summary>
    private sealed class ScriptedBaker : ICouchCoopGeoclipBaker
    {
        private readonly Dictionary<string, Script> _scripts = new(StringComparer.Ordinal);
        private int _calls;
        private int _throwAfter = -1;
        private Exception? _death;
        private Action<CouchCoopGeoclipBakeCommand>? _watch;

        public int Calls => Volatile.Read(ref _calls);

        public int LastThreadId { get; private set; }

        /// <summary>What the last command asked for, so a test can prove a rig went down as ONE bake.</summary>
        public IReadOnlyList<string>? LastAnimationsAsked { get; private set; }

        public IReadOnlySet<string>? LastKnownPageIds { get; private set; }

        public bool LastWasThreadPoolThread { get; private set; }

        public ScriptedBaker Good(string scene, byte[]? page = null)
        {
            _scripts[scene] = new Script(page ?? [1, 2, 3, 4], true, 28, 28, 0, null, null);
            return this;
        }

        public ScriptedBaker Incomplete(string scene, bool complete = true, int slots = 28, int? associated = null, int foreignMeshes = 0)
        {
            _scripts[scene] = new Script([1, 2, 3, 4], complete, slots, associated ?? slots, foreignMeshes, null, null);
            return this;
        }

        public ScriptedBaker Broken(string scene, AssetExtractFailureCode code, string message)
        {
            _scripts[scene] = new Script([1, 2, 3, 4], true, 28, 28, 0, code, message);
            return this;
        }

        /// <summary>
        /// Stop producing after <paramref name="bakes"/> successful bakes. Stands in for the measured silent
        /// mid-sweep death: the point is that the NEXT run has to recover from what reached disk, and nothing
        /// else.
        /// </summary>
        public ScriptedBaker ThrowAfter(int bakes, Exception death)
        {
            _throwAfter = bakes;
            _death = death;
            return this;
        }

        /// <summary>
        /// Run <paramref name="onBake"/> at the START of a bake. The seam for "what had the process emitted at
        /// the instant it died?" — a bake is where the measured silent deaths happen, and everything logged
        /// before this point is everything a killed run would ever have left behind.
        /// </summary>
        public ScriptedBaker Watch(Action<CouchCoopGeoclipBakeCommand> onBake)
        {
            _watch = onBake;
            return this;
        }

        public CouchCoopGeoclipBakeOutcome Bake(CouchCoopGeoclipBakeCommand command)
        {
            var call = Interlocked.Increment(ref _calls);
            LastThreadId = Environment.CurrentManagedThreadId;
            LastWasThreadPoolThread = Thread.CurrentThread.IsThreadPoolThread;
            _watch?.Invoke(command);
            if (_throwAfter >= 0 && call > _throwAfter)
            {
                throw _death!;
            }

            var scene = command.SceneResPath.Replace("res://", string.Empty, StringComparison.Ordinal);
            // A second pose of one rig is scripted under "<scene>#<anim>" so two poses can be given the same
            // atlas bytes without giving them the same identity.
            var script = _scripts.TryGetValue($"{scene}#{command.AnimationName}", out var perAnim)
                ? perAnim
                : _scripts.TryGetValue(scene, out var perScene) ? perScene : new Script([1, 2, 3, 4], true, 28, 28, 0, null, null);

            if (script.FailureCode is { } failureCode)
            {
                return CouchCoopRuntimeGeoclipBaker.Map(
                    SpineGeoClipBakeResultSnapshot.Failure(failureCode, script.FailureMessage!, []));
            }

            // NESTED, and ONE DIRECTORY PER ANIMATION, because that is what the real producer does: spirectl
            // writes `<out>/<rig>--<node>--<anim>/manifest.json`, not `<out>/manifest.json`, and a rig bake
            // writes one of those per animation it was asked for. A double that wrote flat passed this whole
            // file while the live route 404'd every request for weeks — the provider adopted the staging root,
            // found no manifest there, and threw away every bake. Reproduce the SHAPE.
            var animations = command.AnimationNames is { Count: > 0 } named
                ? named
                : (IReadOnlyList<string>)[command.AnimationName];
            LastAnimationsAsked = animations;
            LastKnownPageIds = command.KnownPageContentIds;

            // A page the caller says it already holds is DESCRIBED and not written — the whole point of handing
            // the producer the store's page ids. `sha256` is what lets the adopt resolve it anyway.
            var pageId = Sha256Hex(script.Page);
            var pageKnown = command.KnownPageContentIds is { } known
                && known.Any(id => id.Length >= 8 && pageId.StartsWith(id, StringComparison.Ordinal));

            var poses = new List<SpineGeoClipBakePoseSnapshot>();
            foreach (var animation in animations)
            {
                var written = Path.Combine(command.OutputDirectory, TargetDirectoryName(command, animation));
                Directory.CreateDirectory(written);
                File.WriteAllText(
                    Path.Combine(written, "manifest.json"),
                    JsonSerializer.Serialize(new
                    {
                        meta = new { schema = "geoclip/1", frameCount = 1, anim = animation },
                        pages = new[] { new { id = 0, file = "page-0.png", width = 4, height = 4, sha256 = pageId } },
                        parts = Array.Empty<object>(),
                        frames = Array.Empty<object>(),
                    }));
                if (!pageKnown)
                {
                    File.WriteAllBytes(Path.Combine(written, "page-0.png"), script.Page);
                }
                File.WriteAllBytes(Path.Combine(written, "verts.bin"), [0, 0]);

                var poseScript = _scripts.TryGetValue($"{scene}#{animation}", out var animScript) ? animScript : script;
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
                    SlotsVisible: poseScript.Slots,
                    Associated: poseScript.Associated,
                    Unassociated: poseScript.Slots - poseScript.Associated,
                    ForeignMeshes: poseScript.ForeignMeshes,
                    StaleMeshFrames: 0,
                    AttachmentDriftSlots: 0,
                    Complete: poseScript.Complete,
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
                SlotsVisible: script.Slots,
                Associated: script.Associated,
                Unassociated: script.Slots - script.Associated,
                ForeignMeshes: script.ForeignMeshes,
                Complete: script.Complete,
                Error: null,
                Poses: poses,
                ScenesLoaded: 1,
                BatchNote: animations.Count > 1 ? "batched" : "single"));
        }

        private static string Sha256Hex(byte[] bytes)
            => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant();

        // The shape spirectl's Sts2SpineGeoClipSpec.DirectoryName mints: "<rig>--<node>--<anim>". Only the SHAPE
        // matters (a subdirectory whose name the caller does not choose), not the exact spelling.
        private static string TargetDirectoryName(CouchCoopGeoclipBakeCommand command, string animation)
        {
            var scene = Path.GetFileNameWithoutExtension(command.SceneResPath);
            return $"{scene}--{(command.NodePath ?? "root").Replace('/', '_')}--{animation}";
        }

        private sealed record Script(
            byte[] Page,
            bool Complete,
            int Slots,
            int Associated,
            int ForeignMeshes,
            AssetExtractFailureCode? FailureCode,
            string? FailureMessage);
    }

    /// <summary>A runtime that publishes a catalog and reports the capabilities the sweep needs.</summary>
    private sealed class CatalogRuntime(IReadOnlyList<SpineCatalogEntrySnapshot> entries) : StubRuntimeBase
    {
        public override EmbeddableRuntimeCapabilities GetCapabilities()
            => Capabilities(Capability("spine-catalog", true), Capability("asset-extraction", true));

        public override SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
            => SpineCatalogOperationResult.Success(
                DataSourceKind.Stub,
                provisional: false,
                scannedSceneCount: entries.Select(entry => entry.SceneResPath).Distinct(StringComparer.Ordinal).Count(),
                spineNodeCount: entries.Count,
                entries,
                [],
                []);
    }

    /// <summary>A runtime that counts geoclip bake calls and answers a trivial success.</summary>
    private static CouchCoopRuntimeGeoclipBaker Seam(
        ISpineGeoClipBaker baker,
        params EmbeddableRuntimeCapability[] capabilities)
        => new(baker, new TestCapabilityPolicy(capabilities));

    /// <summary>This seam fake owns only the one upstream operation the adapter invokes.</summary>
    private sealed class BakingRuntime : ISpineGeoClipBaker
    {
        private int _calls;

        public int Calls => Volatile.Read(ref _calls);

        public SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
        {
            Interlocked.Increment(ref _calls);
            return new SpineGeoClipBakeResultSnapshot(
                true, "/tmp/unused/manifest.json", [], 1, 1, 0.5d, "mid", 1d, 1, 1, 1, 0, 0, true, null);
        }
    }

    /// <summary>Capability policy for the seam test; it deliberately exposes no runtime operations.</summary>
    private sealed class TestCapabilityPolicy(params EmbeddableRuntimeCapability[] capabilities) : ICouchCoopCapabilityPolicy
    {
        private readonly IReadOnlyDictionary<string, EmbeddableRuntimeCapability> _capabilities = capabilities
            .ToDictionary(capability => capability.Id, StringComparer.Ordinal);

        public IReadOnlyList<CouchCoopRuntimeNotice> Notices => [];

        public bool HasCapability(string capabilityId)
            => _capabilities.TryGetValue(capabilityId, out var capability) && capability.Supported;

        public CouchCoopRuntimeNotice RequireCapability(string capabilityId)
        {
            if (!_capabilities.TryGetValue(capabilityId, out var capability) || !capability.Supported)
            {
                throw new NotSupportedException($"Capability '{capabilityId}' is unavailable.");
            }

            return CouchCoopRuntimeNotice.FromCapability(capability);
        }
    }

    /// <summary>The uninteresting surface of <see cref="ISpirectlRuntime"/>, so each stub above stays readable.</summary>
    private abstract class StubRuntimeBase : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, IAnimationHintSource, IRuntimeSceneDeltaSource, IGameModelSource, ISpineCatalogSource, ISpineGeoClipBaker, ISemanticActionSource, IRuntimeSceneWatchControlSource
    {
        public IRuntimeSceneWatchControls SceneWatchControls => Spirectl.Sts2.Live.Sts2RuntimeSceneWatchControls.Instance;
        public ISpirectlAssetProvider Assets { get; } = new AssetCacheTokenEnvelopeTests.StubAssetProvider();

        public abstract EmbeddableRuntimeCapabilities GetCapabilities();

        public virtual SpineCatalogOperationResult GetSpineCatalog(SpineCatalogRequestSnapshot request)
            => throw new NotSupportedException();

        public virtual SpineGeoClipBakeResultSnapshot BakeSpineGeoClip(SpineGeoClipBakeRequestSnapshot request)
            => throw new NotSupportedException();

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

        public IDisposable SubscribeRuntimeSceneDelta(
            RuntimeSceneSubscriptionRequest request,
            Action<RuntimeSceneDelta> onDelta,
            Action<EmbeddableRuntimeError>? onError = null) => throw new NotSupportedException();

        public ModelCatalogOperationResult GetModels(ModelCatalogRequestSnapshot request) => throw new NotSupportedException();

        public ReferenceOperationResult GetReference(ReferenceRequestSnapshot request) => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request) => throw new NotSupportedException();

        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request) => throw new NotSupportedException();
    }

    /// <summary>Arms rig batching for one case and restores the previous value, whatever it was.</summary>
    private sealed class RigBatchArmed : IDisposable
    {
        private const string Key = "COUCHCOOP_GEOCLIP_RIG_BATCH";
        private readonly string? _previous = Environment.GetEnvironmentVariable(Key);

        /// <param name="poses">Null UNSETS the variable, i.e. restores the shipped (unbatched) default.</param>
        public RigBatchArmed(int? poses) => Environment.SetEnvironmentVariable(Key, poses?.ToString());

        public void Dispose() => Environment.SetEnvironmentVariable(Key, _previous);
    }

    // THE DEFAULT, pinned. Rig batching refuses itself on every rig measured live (byrdonis
    // staleMeshFrames=100 with 100 engine "Parameter mesh is null" errors, merchant attachmentDrift=34), so
    // every rig paid a doomed batch attempt before falling back -- +22%/+18% over never batching. Unset, the
    // sweep must bake ONE pose per bake.
    private static async Task RigBatchingIsOffUnlessItIsArmedAsync()
    {
        // Un-arm, against the suite-wide arm above: this case is the one that speaks for the SHIPPED default.
        using var unarmed = new RigBatchArmed(null);

        Expect(
            CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses == 1,
            "unset, the rig batch cap is 1 -- i.e. per-target bakes, the behaviour that measured fastest "
            + $"(got {CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses})");

        using (var armed = new RigBatchArmed(CouchCoopGeoclipPrerenderJob.RigBatchPosesWhenArmed))
        {
            Expect(
                CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses == CouchCoopGeoclipPrerenderJob.RigBatchPosesWhenArmed,
                "...and COUCHCOOP_GEOCLIP_RIG_BATCH re-arms it, so the batch is kept rather than deleted");
        }

        Expect(CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses == 1, "...and the arm is scoped to its own block");

        // And it is not merely a number: a five-pose rig must be five bakes, not one.
        using var scope = new Scope(armOnDemand: true);
        var rig = Enumerable.Range(0, 5)
            .Select(index => new SpineCatalogEntrySnapshot("res://unbatched.tscn", "Visuals/Spine", $"anim_{index}"))
            .ToArray();
        var baker = new ScriptedBaker().Good("unbatched.tscn");
        await new CouchCoopGeoclipPrerenderJob(
            Host(rig),
            new CouchCoopGeoclipProvider(baker, scope.Store, _ => { }),
            _ => { }).RunAsync();
        Expect(baker.Calls == 5, $"a five-pose rig is five separate bakes when unarmed (got {baker.Calls})");
    }

}
