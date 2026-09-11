using System.Text;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Live;

// The GEOCLIP half of the /perf/spine.json instrument, and the diagnostic that says what a geoclip 404 meant.
//
// The bake itself needs a live game, so what is checkable offline is everything around it: that the producer's
// own `bake.profile` block is lifted out of the manifest it writes (the only copy that crosses the seam — the
// geoclip baker mints its own profiler key and closes it before returning, so TryTake has nothing to take), that
// an absent profile stays absent rather than becoming a table of zeros, that a geoclip lands in its OWN metric
// block instead of averaging into the raster rows the repo compares across rounds, and that the refusal header is
// safe to put on a wire.
//
// Pure; assert-or-throw harness style.
internal static class GeoclipBakeMetricsTests
{
    public static void Run()
    {
        ProfileIsLiftedOutOfTheManifest();
        BulkArraysAreWalkedPastNotMaterialized();
        AnAbsentProfileIsUnmeasuredNeverZero();
        AGeoclipBakeIsItsOwnMetricBlock();
        TheGateWaitIsPartOfWhatTheClientWaitedFor();
        RefusalHeaderNamesTheCauseTheBodyFlattens();
        ClaimProvenanceIsReadableWithoutLogArchaeology();
        RefusalHeaderIsSafeToPutOnAWire();
        DiagnosticsAreOptIn();
        SpineBakeMetrics.Reset();
    }

    // ── Reading the producer's profile ────────────────────────────────────────────────────────────────

    private static void ProfileIsLiftedOutOfTheManifest()
    {
        var reading = GeoclipBakeProfileReader.TryParse(Utf8(Manifest(Profile)));
        Assert(reading is not null, "a manifest carrying bake.profile reads");

        var phases = reading!.Phases;
        Assert(phases.Count == 4, "every phase in the block is carried");
        Assert(phases[0].Phase == Sts2RenderPhaseProfile.Phase.BakeSweepProbe && phases[0].Ms == 812.5 && phases[0].Calls == 3,
            "a phase keeps its name, its summed ms and its call count");

        // THE fact the round is graded on: which of those milliseconds held the Godot main thread.
        Assert(phases.Single(p => p.Phase == Sts2RenderPhaseProfile.Phase.BakeColorRead).Blocking,
            "a readback is carried as blocking — it is the freeze a player sees");
        Assert(!phases.Single(p => p.Phase == Sts2RenderPhaseProfile.Phase.BakeProbeFrameWait).Blocking,
            "an awaited engine frame is carried as parked — the game keeps running");

        Assert(reading.TotalMs == 1904.25 && reading.BlockingMs == 1262.5 && reading.ParkedMs == 421.75,
            "the producer's own totals ride along for the host's log line");
        Assert(reading.UnattributedMs == 220,
            "…including the residue no phase claimed, which is what keeps the instrument from being self-confirming");

        // The bake counters fold onto the names the shared profiler already publishes, so a geoclip's awaited
        // frames land in the same column as a raster bake's rather than in a second one that means the same thing.
        Assert(reading.Counters[Sts2RenderPhaseProfile.Counter.FramesWaited] == 61, "framesWaited maps to the shared counter");
        Assert(reading.Counters[Sts2RenderPhaseProfile.Counter.BakeForceDraws] == 61, "forceDraws maps to the bake counter");

        // EVERY counter the producer emits, asserted one by one. `drawsElided` shipped emitting correctly into
        // the manifest and never arriving here, because the reader's `default: Skip()` is silent and this test
        // graded a fixture that predated the field. A counter with no assertion beside it is a counter that can
        // be dropped without failing anything.
        Assert(reading.Counters[Sts2RenderPhaseProfile.Counter.BakeDrawsElided] == 6, "drawsElided maps to the bake counter");
        Assert(reading.Counters[Sts2RenderPhaseProfile.Counter.BakeColorReads] == 44, "colorReads maps to the bake counter");
        Assert(reading.Counters[Sts2RenderPhaseProfile.Counter.BakeSweepProbes] == 180440, "sweepProbes maps to the bake counter");
    }

    private static void BulkArraysAreWalkedPastNotMaterialized()
    {
        // A real manifest is mostly `parts` and `frames`; the reader has to skip them (including their nested
        // objects and arrays) and still find a `bake` block that comes AFTER them.
        var manifest =
            "{\"meta\":{\"schema\":\"geoclip/1\",\"frameCount\":1},"
            + "\"pages\":[{\"id\":0,\"file\":\"page-0.png\",\"width\":2048,\"height\":2048}],"
            + "\"parts\":[{\"id\":0,\"indices\":[0,1,2,0,2,3],\"uvs\":[0.1,0.2,0.3,0.4],\"refVerts\":[1,2,3,4]},"
            + "{\"id\":1,\"indices\":[0,1,2],\"uvs\":[0.5,0.6],\"refVerts\":[5,6]}],"
            + "\"frames\":[{\"t\":0.5,\"drawOrder\":[1,0],\"slots\":{\"a\":{\"part\":0,\"color\":[1,1,1,1]}}}],"
            + "\"diagnostics\":[\"note\"],"
            + "\"bake\":{\"slots\":44,\"associated\":44,\"foreignMeshes\":0,\"profile\":" + Profile + "}}";

        var reading = GeoclipBakeProfileReader.TryParse(Utf8(manifest));
        Assert(reading is not null && reading.Phases.Count == 4,
            "the profile is found past the parts/frames bulk that makes up a real manifest");
    }

    private static void AnAbsentProfileIsUnmeasuredNeverZero()
    {
        // The producer omits the whole block when SPIRECTL_RENDER_PHASE_PROFILE=0. Every one of these has to
        // answer null, because a zeroed table would read downstream as "this bake cost nothing".
        Assert(GeoclipBakeProfileReader.TryParse(Utf8(Manifest(null))) is null, "no bake block: unmeasured");
        Assert(GeoclipBakeProfileReader.TryParse(Utf8("{\"bake\":{\"slots\":44}}")) is null, "a bake block with no profile: unmeasured");
        Assert(GeoclipBakeProfileReader.TryParse(Utf8("{\"bake\":{\"profile\":{\"totalMs\":900,\"phases\":[]}}}")) is null,
            "a profile with an EMPTY phase table is unmeasured, not a bake that did nothing");
        Assert(GeoclipBakeProfileReader.TryParse(Utf8("{\"bake\":")) is null, "a truncated manifest answers null rather than throwing");
        Assert(GeoclipBakeProfileReader.TryParse(Utf8("[]")) is null, "…and so does one that is not an object");
        Assert(GeoclipBakeProfileReader.TryReadFile(null) is null && GeoclipBakeProfileReader.TryReadFile("/no/such/manifest.json") is null,
            "a missing file is unmeasured, and never an exception out of an instrument");
    }

    // ── The report row ────────────────────────────────────────────────────────────────────────────────

    private static void AGeoclipBakeIsItsOwnMetricBlock()
    {
        SpineBakeMetrics.Reset();

        // A raster clip bake and a geoclip bake of the SAME identity. Their keys differ only by the geoclip
        // selector, so KindOf() would call both of them "clip" — which is exactly the fold this must not do.
        var spineKey = CouchCoopSpineClipProvider.BuildSpineKey("res://scenes/creature_visuals/x.tscn", "Visuals", "idle_loop");
        SpineBakeMetrics.Record(new SpineBakeMetrics.Sample(
            0, spineKey, SpineBakeMetrics.ClipKind, 263, 180_000, 1, true, "still-image",
            Phases: [new(Sts2RenderPhaseProfile.Phase.LaneBuild, 200, 1, true)]));
        SpineBakeMetrics.Record(new SpineBakeMetrics.Sample(
            0, CouchCoopGeoclipStore.BuildGeoclipKey(spineKey), SpineBakeMetrics.GeoclipKind, 1904, 96_000, 1, true,
            CouchCoopGeoclipProvider.SingleBakeRoute,
            Phases:
            [
                .. GeoclipBakeProfileReader.TryParse(Utf8(Manifest(Profile)))!.Phases,
                HostRenderPhases.Phase(HostRenderPhases.GateWait, 640),
                HostRenderPhases.Phase(HostRenderPhases.CacheWrite, 18),
            ],
            Counters: GeoclipBakeProfileReader.TryParse(Utf8(Manifest(Profile)))!.Counters));

        var json = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
            "geoclip-bake", SpineBakeMetrics.Snapshot(), envKind: PerfReport.HostKind, envLabel: "unit")))!.AsObject();
        var metrics = json["metrics"]!.AsObject();

        Assert(metrics.ContainsKey(SpineBakeMetrics.GeoclipKind), "a geoclip bake gets its own metric block");
        Assert((int?)metrics["clip"]!["bakes"] == 1 && (double?)metrics["clip"]!["bakeMs"]!["p50"] == 263,
            "…and the raster row for the same identity is untouched, which is the whole point of comparing them");

        var geoclip = metrics[SpineBakeMetrics.GeoclipKind]!;
        Assert((double?)geoclip["split"]!["blockingMs"]!["p50"] == 1262.5,
            "the block reports the main-thread half the round is graded on");
        Assert((double?)geoclip["split"]!["parkedMs"]!["p50"] == 421.75 + 640 + 18,
            "…and the parked half, gate queue and disk included: that is what the client waited for");
        Assert((double?)geoclip["phases"]![HostRenderPhases.GateWait]!["totalMs"] == 640,
            "the extraction-gate wait is a phase of the bake, not something outside it");
        Assert((bool?)geoclip["phases"]![HostRenderPhases.GateWait]!["blocking"] == false,
            "queueing never counts as a game stall");

        var run = json["runs"]!.AsArray().Single(entry => (string?)entry!["kind"] == SpineBakeMetrics.GeoclipKind)!;
        Assert((string?)run["route"] == CouchCoopGeoclipProvider.SingleBakeRoute, "a reader can tell which lane asked");
        Assert(((string?)run["key"])!.EndsWith(CouchCoopGeoclipStore.GeoclipSelector, StringComparison.Ordinal),
            "…and the row names the GEOCLIP identity, selector and all");
        Assert((long?)run["counters"]![Sts2RenderPhaseProfile.Counter.FramesWaited] == 61,
            "the producer's awaited-frame count rides the run");

        Console.WriteLine("geoclip /perf/spine.json row: " + run.ToJsonString());
        Console.WriteLine("geoclip /perf/spine.json metrics." + SpineBakeMetrics.GeoclipKind + ": " + geoclip.ToJsonString());
    }

    private static void TheGateWaitIsPartOfWhatTheClientWaitedFor()
    {
        // Through the RECORDER this time, which is what the provider drives. The gate wait was measured nowhere
        // in this lane before: the bake's own `total=` starts after the gate, and every geoclip bake, raster bake
        // and /bg/ render queues on the same single admission slot.
        SpineBakeMetrics.Reset();
        var bake = SpineBakeRecorder.Start("spine://x?anim=idle&geo=1&gv=1", CouchCoopGeoclipProvider.SingleBakeRoute, SpineBakeMetrics.GeoclipKind);
        bake.GateAdmitted();
        bake.RenderReturned();
        bake.ProducerProfile(GeoclipBakeProfileReader.TryParse(Utf8(Manifest(Profile)))!.Phases);
        bake.Succeeded(96_000, 1);

        var sample = SpineBakeMetrics.Snapshot().Single();
        Assert(sample.Kind == SpineBakeMetrics.GeoclipKind, "the recorder files a geoclip under the kind it was given, not the one its key implies");
        Assert(sample.PhaseCosts.Any(phase => phase.Phase == HostRenderPhases.GateWait),
            "the gate wait is appended to the producer's table");
        Assert(sample.PhaseCosts.Any(phase => phase.Phase == Sts2RenderPhaseProfile.Phase.BakeSweepProbe),
            "…without displacing the producer's own phases");

        // And the negative: a bake whose producer published nothing must not gain a phase table made only of this
        // side's queue and disk, which would report as a bake that was 100 % parked.
        SpineBakeMetrics.Reset();
        var unmeasured = SpineBakeRecorder.Start("spine://x?anim=idle&geo=1&gv=1", CouchCoopGeoclipProvider.SingleBakeRoute, SpineBakeMetrics.GeoclipKind);
        unmeasured.GateAdmitted();
        unmeasured.ProducerProfile(null);
        unmeasured.Succeeded(96_000, 1);
        Assert(SpineBakeMetrics.Snapshot().Single().PhaseCosts.Count == 0,
            "an unprofiled bake reports no phases at all, never a gate-wait-only table");
        SpineBakeMetrics.Reset();
    }

    // ── The refusal header ────────────────────────────────────────────────────────────────────────────

    private static void RefusalHeaderNamesTheCauseTheBodyFlattens()
    {
        var refused = CouchCoopGeoclipResult.Refused(
            new CouchCoopAssetHttpError(CouchCoopGeoclipProvider.RefusedCode, "The geoclip bake did not acquire the whole rig (foreignMeshes=74); it was not cached.", "key", "spine://x"),
            new CouchCoopGeoclipRefusal("foreign", "foreignMeshes=74", DateTimeOffset.UnixEpoch, Cached: false));
        var fresh = CouchCoopGeoclipProvider.TryDescribeRefusal(refused)!;
        Assert(fresh.StartsWith(CouchCoopGeoclipProvider.RefusedCode + ";", StringComparison.Ordinal), "the arm is the structured code the body flattens away");
        Assert(fresh.Contains("arm=foreign", StringComparison.Ordinal) && fresh.Contains("foreignMeshes=74", StringComparison.Ordinal),
            "…and the detail is the completeness verdict, counts and all");
        Assert(fresh.Contains("cached=0", StringComparison.Ordinal), "a bake that just ran is marked as such");

        var remembered = CouchCoopGeoclipProvider.DescribeCachedRefusal(new CouchCoopGeoclipRefusalRecord(
            "spine://x&geo=1&gv=1", CouchCoopGeoclipStore.GeoclipSelector, CouchCoopGeoclipStore.RefusalPolicyRevision,
            "unassociated", "associated=40 of slotsEverVisible=44", DateTimeOffset.UnixEpoch));
        Assert(remembered.StartsWith(CouchCoopGeoclipProvider.RefusedCachedCode + ";", StringComparison.Ordinal),
            "a receipt read off disk is its OWN arm: 'still broken' and 'remembered as broken' are different facts");
        Assert(remembered.Contains(CouchCoopGeoclipStore.RefusalPolicyRevision, StringComparison.Ordinal),
            "…and it names the policy revision the verdict was reached under");

        var failed = CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
            "geoclip-manifest-missing", "The geoclip bake reported success but wrote no manifest inside its staging directory.", "key", "spine://x"));
        Assert(CouchCoopGeoclipProvider.TryDescribeRefusal(failed)!.StartsWith("geoclip-manifest-missing;", StringComparison.Ordinal),
            "a non-refusal failure is described by its own code too");

        Assert(CouchCoopGeoclipProvider.TryDescribeRefusal(CouchCoopGeoclipResult.Hit("/tmp/x")) is null, "a hit has nothing to explain");
        Assert(CouchCoopGeoclipProvider.TryDescribeRefusal(null) is null, "…and neither does a request that never reached the provider");
    }

    // WHAT THE NEXT LIVE LEG HAS TO BE ABLE TO READ.
    //
    // The ownership arm admits a bake when every claim carries a positive proof. For an Ironclad that means its
    // atlas claims matched at `uv-region-exact` rather than by bare containment — and nobody has measured which
    // it is. Those are the two live outcomes of the same bake (admitted, or correctly refused with the round's
    // goal unmet), and until now telling them apart meant shaping a separate env-lane bake and reading its log.
    // So both endings have to say it: a REFUSED bake on the diagnostics header, an ADMITTED one on the
    // /perf/spine.json row, because an admitted bake has no refusal to carry it.
    private static void ClaimProvenanceIsReadableWithoutLogArchaeology()
    {
        var refused = CouchCoopGeoclipResult.Refused(
            new CouchCoopAssetHttpError(
                CouchCoopGeoclipProvider.RefusedCode,
                "The geoclip bake did not acquire the whole rig (ownership=37 of claimed=44); it was not cached.",
                "key",
                "spine://ironclad"),
            new CouchCoopGeoclipRefusal(
                "ownership", "ownership=37 of claimed=44", DateTimeOffset.UnixEpoch, Cached: false,
                ClaimsProven: 7, ClaimsUnproven: 37));
        var header = CouchCoopGeoclipProvider.TryDescribeRefusal(refused)!;
        Assert(header.Contains("arm=ownership", StringComparison.Ordinal), "the ownership arm names itself on the wire");
        Assert(header.Contains("claimsProven=7", StringComparison.Ordinal)
            && header.Contains("claimsUnproven=37", StringComparison.Ordinal),
            $"…and carries the evidence the arm graded, not just its conclusion (got '{header}')");

        // A ZERO PAIR IS NAMED, never printed as two zeros: "nothing recorded how the claims were made" and
        // "nothing proved" lead an operator to opposite places (upgrade the bridge vs. investigate the rig).
        var blind = CouchCoopGeoclipProvider.TryDescribeRefusal(CouchCoopGeoclipResult.Refused(
            new CouchCoopAssetHttpError(CouchCoopGeoclipProvider.RefusedCode, "x", "key", "spine://x"),
            new CouchCoopGeoclipRefusal("foreign", "foreignMeshes=74", DateTimeOffset.UnixEpoch, Cached: false)))!;
        Assert(blind.Contains("claimProvenance=none", StringComparison.Ordinal),
            $"a bake that graded no claims says so in words (got '{blind}')");
        Assert(!blind.Contains("claimsProven=0", StringComparison.Ordinal),
            "…and never as a zero, which reads as the opposite finding");

        // The ADMITTED half, through the recorder the provider actually drives.
        SpineBakeMetrics.Reset();
        var bake = SpineBakeRecorder.Start(
            "spine://ironclad?anim=attack&geo=1&gv=1",
            CouchCoopGeoclipProvider.SingleBakeRoute,
            SpineBakeMetrics.GeoclipKind);
        bake.GateAdmitted();
        bake.RenderReturned();
        bake.ClaimProvenance(44, 0);
        bake.Succeeded(96_000, 1);

        var run = JsonNode.Parse(PerfReport.ToJson(SpineBakeMetrics.BuildReport(
                "geoclip-ownership", SpineBakeMetrics.Snapshot(), envKind: PerfReport.HostKind, envLabel: "unit")))!
            .AsObject()["runs"]!.AsArray().Single()!;
        // Read through the node rather than indexing it: a regression here is an ABSENT counters block, and an
        // assertion that dereferences its way to a NullReferenceException reports a crash where it should report
        // the finding.
        var counters = run["counters"]?.AsObject();
        Assert(counters is not null
            && (long?)counters[SpineBakeMetrics.ClaimsProvenCounter] == 44
            && (long?)counters[SpineBakeMetrics.ClaimsUnprovenCounter] == 0,
            $"an ADMITTED bake publishes what it rested on (got {counters?.ToJsonString() ?? "<no counters>"})");

        // NOT ROUTED THROUGH ProducerProfile, which drops its counters with an empty phase table. If it were,
        // this reading would vanish on any host running with the producer's phase profiler switched off — which
        // is most of them.
        Assert(SpineBakeMetrics.Snapshot().Single().PhaseCosts.Count == 0,
            "…with no phase table at all, so the counters do not depend on the producer's profiler being armed");

        // And absent when there is nothing to say, for the same reason the header spells the zero pair out.
        SpineBakeMetrics.Reset();
        var silent = SpineBakeRecorder.Start(
            "spine://x?anim=idle&geo=1&gv=1", CouchCoopGeoclipProvider.SingleBakeRoute, SpineBakeMetrics.GeoclipKind);
        silent.ClaimProvenance(0, 0);
        silent.Succeeded(1, 1);
        Assert(SpineBakeMetrics.Snapshot().Single().Counters is null,
            "a bake that graded no claims publishes no counters, rather than a pair of zeros");
        SpineBakeMetrics.Reset();
    }

    private static void RefusalHeaderIsSafeToPutOnAWire()
    {
        // The detail is producer-authored (a spirectl failure quotes an exception message), so a CR or an LF
        // reaching a response header would be response splitting.
        var injected = CouchCoopGeoclipProvider.FormatRefusalHeader(
            "geoclip-bake-failed", "boom\r\nX-Injected: 1\r\n\r\n<html>");
        Assert(!injected.Contains('\r') && !injected.Contains('\n'), "no CR or LF survives into a header value");
        Assert(injected.Contains("X-Injected:", StringComparison.Ordinal), "…the text is kept, only its framing is taken away");

        var wide = CouchCoopGeoclipProvider.FormatRefusalHeader("geoclip-bake-failed", "naïve — ünïcode\ttab");
        Assert(wide.All(character => character is >= ' ' and <= '~'), "the value is printable US-ASCII");

        var capped = CouchCoopGeoclipProvider.FormatRefusalHeader("geoclip-bake-failed", new string('x', 5_000));
        Assert(capped.Length <= CouchCoopGeoclipProvider.MaxRefusalDetailLength + 40, "an unbounded producer message is capped");
        Assert(capped.EndsWith("...", StringComparison.Ordinal), "…and truncation is marked, so a cut detail is not read as a short one");

        Assert(CouchCoopGeoclipProvider.FormatRefusalHeader("geoclip-bake-failed", null) == "geoclip-bake-failed",
            "an arm with no detail is just the arm");
        Assert(CouchCoopGeoclipProvider.FormatRefusalHeader("", null) == "unspecified", "and nothing at all still answers something greppable");
    }

    private static void DiagnosticsAreOptIn()
    {
        Assert(CouchCoopGeoclipProvider.DiagnosticsEnvVar == "COUCHCOOP_GEOCLIP_DIAGNOSTICS", "documented env var name");
        Assert(CouchCoopGeoclipProvider.RefusalHeader == "X-Geoclip-Refusal", "documented header name");
        Assert(
            (Environment.GetEnvironmentVariable(CouchCoopGeoclipProvider.DiagnosticsEnvVar) == "1")
                == CouchCoopGeoclipProvider.DiagnosticsEnabled,
            "the switch is exact-'1' opt-in, like the two bench switches beside it");
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

    // The `bake.profile` block spirectl writes (Sts2SpineGeoClipCore.GeoClipBakeProfile). Shape only — the
    // numbers are invented, and the phase NAMES come from the shared vocabulary rather than being spelled here.
    private static string Profile =>
        "{\"totalMs\":1904.25,\"blockingMs\":1262.5,\"parkedMs\":421.75,\"unattributedMs\":220,"
        + "\"framesWaited\":61,\"forceDraws\":61,\"blockingShare\":0.663,\"parkedShare\":0.221,\"phases\":["
        + $"{{\"phase\":\"{Sts2RenderPhaseProfile.Phase.BakeSweepProbe}\",\"ms\":812.5,\"calls\":3,\"blocking\":true}},"
        + $"{{\"phase\":\"{Sts2RenderPhaseProfile.Phase.BakeProbeFrameWait}\",\"ms\":421.75,\"calls\":58,\"blocking\":false}},"
        + $"{{\"phase\":\"{Sts2RenderPhaseProfile.Phase.BakeColorRead}\",\"ms\":390,\"calls\":44,\"blocking\":true}},"
        + $"{{\"phase\":\"{Sts2RenderPhaseProfile.Phase.BakeManifest}\",\"ms\":60,\"calls\":1,\"blocking\":true}}]"
        // AFTER `phases`, because that is where a real manifest carries them: all three are trailing defaulted
        // parameters of the producer's record, so they serialize last. A fixture that put them earlier would
        // pass without ever exercising the reader's position handling — and this fixture NOT carrying them at
        // all is why `drawsElided` shipped dropped on the floor.
        + ",\"drawsElided\":6,\"colorReads\":44,\"sweepProbes\":180440}";

    private static string Manifest(string? profile)
        => "{\"meta\":{\"schema\":\"geoclip/1\",\"frameCount\":1},\"pages\":[],\"parts\":[],\"frames\":[]"
            + (profile is null ? string.Empty : ",\"bake\":{\"slots\":44,\"profile\":" + profile + "}")
            + "}";

    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"GeoclipBakeMetricsTests failed: {label}.");
        }
    }
}
