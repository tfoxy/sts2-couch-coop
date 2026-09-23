using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

// THE HOST'S PUBLISH IS THE SOURCE OF TRUTH: a browser watching from a headless seat shows the HOST's static
// background descriptor, received over its gated host socket. These pin the host-side halves that make that
// publish live and correctly framed when no host socket streams — everything that can run without an engine:
//
//   - the probe SCHEDULER (the fold every trigger shares, and the one bounded follow-up an event-driven request
//     earns; the live game event and the SceneTreeTimer are injected delegates here);
//   - the tracker's engine-free surface (RequestProbe is inert Godot-less, the screen baseline resets);
//   - FRAME NORMALIZATION: a probed backdrop transform expressed in the 1920-wide reference the renderer's
//     re-centre assumes, byte-identical at 16:9 so seat URLs and 16:9-host URLs never move.
//
// The live screen-event behaviour (does the game raise it where expected, does the follow-up catch a late mount)
// needs a real host and is covered by the isolated live-QA leg, not here.
internal static class StaticBackgroundHostProbeTests
{
    public static void Run()
    {
        RequestsFoldIntoOneQueuedProbe();
        AnEventDrivenProbeArmsExactlyOneFollowUp();
        ARequestDuringAPendingFollowUpRearmsOnceNotTwice();
        TheFollowUpIsBoundedAndIdleArmsNothing();
        CancelledFollowUpsExpireWithoutProbing();
        SchedulingFailuresReleaseTheFold();
        TrackerEventProbeIsInertWithoutAnEngine();
        TrackerScreenBaselineResets();
        FrameAt169IsByteIdentical();
        FrameAtWideAspectsLandsInTheReference();
        FrameCentreMapsToReferenceCentreAtEveryAspect();
        FrameWithAnUnreadableViewportIsNotShifted();
        Console.WriteLine("StaticBackgroundHostProbeTests passed");
    }

    // A scheduler over hand-cranked "engine" delegates: `Hops` is the queue of deferred main-thread hops, `Timers`
    // the pending one-shot timers. Tests pump them explicitly, which is exactly the ordering the engine provides.
    private sealed class Harness
    {
        public readonly List<Action> Timers = [];
        public readonly List<string> Logs = [];
        public int Hops;
        public int Probes;
        public bool FailSchedule;
        public bool FailArm;
        public readonly CouchCoopStaticBackgroundProbeScheduler Scheduler;

        public Harness()
        {
            Scheduler = new CouchCoopStaticBackgroundProbeScheduler(
                () =>
                {
                    if (FailSchedule)
                    {
                        throw new InvalidOperationException("no engine");
                    }

                    Hops++;
                },
                onElapsed =>
                {
                    if (FailArm)
                    {
                        return false;
                    }

                    Timers.Add(onElapsed);
                    return true;
                },
                Logs.Add);
        }

        // Run the queued deferred hop (the engine runs exactly one per TrySchedule that was not folded).
        public void RunHop()
        {
            Assert(Hops > 0, "a hop was queued");
            Hops--;
            Scheduler.RunProbe(() => Probes++);
        }

        public void FireTimer()
        {
            Assert(Timers.Count > 0, "a timer was armed");
            var timer = Timers[0];
            Timers.RemoveAt(0);
            timer();
        }
    }

    // THE FOLD: any mix of triggers before the hop runs costs one hop and one probe.
    private static void RequestsFoldIntoOneQueuedProbe()
    {
        var h = new Harness();
        h.Scheduler.Request();
        h.Scheduler.Request();
        h.Scheduler.TrySchedule("probe");
        h.Scheduler.TrySchedule("skip");
        Assert(h.Hops == 1, $"four triggers before the hop queue ONE hop (got {h.Hops})");
        Assert(h.Scheduler.ProbeScheduledForTest, "the fold is held until the probe runs");

        h.RunHop();
        Assert(h.Probes == 1, "…and run one probe");
        Assert(!h.Scheduler.ProbeScheduledForTest, "the fold is released once the probe has run");

        h.Scheduler.TrySchedule("probe");
        Assert(h.Hops == 1, "a trigger after the probe ran queues a fresh hop");
    }

    // An event-driven request's probe arms ONE follow-up; the scene-delta and skip triggers arm none.
    private static void AnEventDrivenProbeArmsExactlyOneFollowUp()
    {
        var plain = new Harness();
        plain.Scheduler.TrySchedule("probe");
        plain.RunHop();
        Assert(plain.Timers.Count == 0, "a scene-delta/skip probe arms no follow-up");

        var h = new Harness();
        h.Scheduler.Request();
        h.RunHop();
        Assert(h.Timers.Count == 1 && h.Scheduler.FollowUpArmedForTest, "the event-driven probe arms one follow-up");

        h.FireTimer();
        Assert(h.Hops == 1, "the follow-up expiry queues one probe");
        h.RunHop();
        Assert(h.Probes == 2, "…which runs (the late-mount re-probe)");
        Assert(h.Timers.Count == 0 && !h.Scheduler.FollowUpArmedForTest, "…and arms nothing further");
    }

    // A second event while the follow-up is pending must not arm a second concurrent timer; it re-arms the pending
    // one ONCE, so the second event's room also gets a late-mount probe.
    private static void ARequestDuringAPendingFollowUpRearmsOnceNotTwice()
    {
        var h = new Harness();
        h.Scheduler.Request();
        h.RunHop();
        Assert(h.Timers.Count == 1, "first event: one timer");

        h.Scheduler.Request();
        h.RunHop();
        h.Scheduler.Request();
        h.RunHop();
        Assert(h.Timers.Count == 1, $"two more events while it is pending add NO timer (got {h.Timers.Count})");

        h.FireTimer();
        h.RunHop();
        Assert(h.Timers.Count == 1, "the pending timer re-arms exactly once for the events that landed under it");

        h.FireTimer();
        h.RunHop();
        Assert(h.Timers.Count == 0, "…and the re-armed one, with no event under it, ends the chain");
        Assert(h.Probes == 5, $"3 event probes + 2 follow-ups (got {h.Probes})");
    }

    // At idle there are no events, so nothing is armed and nothing probes — no repeating timer exists anywhere.
    private static void TheFollowUpIsBoundedAndIdleArmsNothing()
    {
        var h = new Harness();
        Assert(h.Hops == 0 && h.Timers.Count == 0, "a fresh scheduler has nothing queued or armed");

        h.Scheduler.Request();
        h.RunHop();
        h.FireTimer();
        h.RunHop();
        var probesAfterOneEvent = h.Probes;
        Assert(probesAfterOneEvent == 2, "one event costs exactly two probes (the probe + its follow-up)");
        Assert(h.Hops == 0 && h.Timers.Count == 0, "…after which the scheduler is idle");
    }

    // A generation that stops (its subscription disposed) must not probe from a timer it armed earlier.
    private static void CancelledFollowUpsExpireWithoutProbing()
    {
        var h = new Harness();
        h.Scheduler.Request();
        h.RunHop();
        Assert(h.Timers.Count == 1, "armed");

        h.Scheduler.CancelFollowUps();
        h.FireTimer();
        Assert(h.Hops == 0, "a cancelled follow-up expires without queueing a probe");
        Assert(!h.Scheduler.FollowUpArmedForTest, "…and is no longer marked pending");

        // A request queued BEFORE the cancel but whose probe runs after it arms nothing either.
        h.Scheduler.Request();
        h.Scheduler.CancelFollowUps();
        h.RunHop();
        Assert(h.Timers.Count == 0, "a cancel between the request and its probe drops the follow-up");

        // …and the scheduler keeps working for the next generation's requests.
        h.Scheduler.Request();
        h.RunHop();
        Assert(h.Timers.Count == 1, "requests after a cancel arm follow-ups again");
    }

    // A failed schedule or arm must not wedge the fold or the pending flag, or the host would never probe again.
    private static void SchedulingFailuresReleaseTheFold()
    {
        var h = new Harness { FailSchedule = true };
        h.Scheduler.TrySchedule("probe");
        Assert(!h.Scheduler.ProbeScheduledForTest, "a throwing schedule releases the fold");
        Assert(
            h.Logs.Count == 1 && h.Logs[0].StartsWith("static-bg probe scheduling failed: ", StringComparison.Ordinal),
            $"…and says so once, in the pre-existing words (got [{string.Join(" | ", h.Logs)}])");
        h.FailSchedule = false;
        h.Scheduler.TrySchedule("skip");
        Assert(h.Hops == 1, "the next trigger schedules normally");

        var arm = new Harness { FailArm = true };
        arm.Scheduler.Request();
        arm.RunHop();
        Assert(!arm.Scheduler.FollowUpArmedForTest, "a refused arm (no scene tree) is not left marked pending");
        arm.FailArm = false;
        arm.Scheduler.Request();
        arm.RunHop();
        Assert(arm.Timers.Count == 1, "…so the next event-driven probe can still arm one");

        var throwing = new Harness();
        throwing.Scheduler.Request();
        throwing.Hops--;
        throwing.Scheduler.RunProbe(() => throw new InvalidOperationException("tree gone"));
        Assert(!throwing.Scheduler.ProbeScheduledForTest, "a throwing probe still releases the fold");
        Assert(throwing.Logs.Any(line => line.StartsWith("static-bg probe failed: ", StringComparison.Ordinal)), "…and logs it");
        Assert(throwing.Timers.Count == 1, "…and the follow-up it was asked for is still armed (the late mount may yet land)");
    }

    // RequestProbe is the handler the game's screen event invokes; in a process with no engine (this one) it must
    // be a no-op that neither throws nor touches Godot.
    private static void TrackerEventProbeIsInertWithoutAnEngine()
    {
        Assert(!CouchCoop.Mod.CouchCoopMod.EngineAvailable, "test host is Godot-less (the precondition)");
        var logs = new List<string>();
        var tracker = new CouchCoopStaticBackgroundTracker(log: logs.Add);
        tracker.RequestProbe();
        tracker.RequestProbe();
        tracker.CancelFollowUps();
        Assert(logs.Count == 0, $"RequestProbe/CancelFollowUps are silent no-ops Godot-less (got [{string.Join(" | ", logs)}])");
    }

    // The baseline OnSceneDelta keys on: recorded even Godot-less, and cleared by ResetScreenBaseline so a restarted
    // scene observer on the same screen re-probes on its first delta.
    private static void TrackerScreenBaselineResets()
    {
        var tracker = new CouchCoopStaticBackgroundTracker(log: _ => { });
        Assert(tracker.LastScreenSignatureForTest is null, "a fresh tracker has no baseline");
        tracker.OnSceneDelta(new RuntimeSceneDelta(
            Full: true,
            ScreenType: "run",
            ScreenInstanceId: "instance-1",
            Upserts: [],
            RemovedIds: [],
            OrderedIds: null));
        Assert(tracker.LastScreenSignatureForTest == "run|instance-1", $"the delta's screen is the baseline (got {tracker.LastScreenSignatureForTest})");
        tracker.ResetScreenBaseline();
        Assert(tracker.LastScreenSignatureForTest is null, "ResetScreenBaseline forgets it");
    }

    // The pre-change formula, verbatim (single precision, the same operation order), for byte-identity checks.
    private static string LegacySpec(float x, float y, float scale, float viewportHeight)
    {
        var normalize = viewportHeight > 0 ? 1080f / viewportHeight : 1f;
        return CouchCoopStaticBackgroundProvider.FormatEventFrameSpec(x * normalize, y * normalize, scale * normalize);
    }

    // 16:9 is a no-op — byte for byte, at every window size — so a seat (forced 1920x1080) and a 16:9 host keep
    // minting the URLs they always minted, and every still already cached under those URLs stays valid.
    private static void FrameAt169IsByteIdentical()
    {
        (float X, float Y, float Scale)[] frames =
        [
            (105.6f, 99.44f, 0.89f),   // Neow's measured container
            (-290f, 20f, 1f),          // the shop subtree's offsets
            (0f, 0f, 1f),
            (123.45f, -67.89f, 0.9375f),
            (-0.04f, 0.05f, 0.5f),     // rounding boundaries around zero
        ];
        (float W, float H)[] viewports = [(1920f, 1080f), (1280f, 720f), (3840f, 2160f), (960f, 540f)];
        foreach (var (x, y, scale) in frames)
        {
            foreach (var (w, h) in viewports)
            {
                var legacy = LegacySpec(x, y, scale, h);
                var normalized = CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(x, y, scale, w, h);
                Assert(
                    normalized == legacy,
                    $"16:9 {w}x{h} frame ({x},{y},{scale}): expected the unchanged spec {legacy}, got {normalized}");
                Assert(
                    CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, normalized)
                        == CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, legacy),
                    "…so the minted /bg/ URL is byte-identical too");
            }
        }

        Assert(
            CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(105.6f, 99.44f, 0.89f, 1920f, 1080f) == "105.6,99.4,0.890",
            "the Neow reference spec is the one the live seat publishes");
    }

    // Wider and narrower hosts: x lands in the 1920-wide reference, so the renderer's +½(2520−1920) re-centre puts
    // the still where THAT host shows the backdrop.
    private static void FrameAtWideAspectsLandsInTheReference()
    {
        // 21:9 at 2520x1080 design units: the reference sits 300 in from the host's left edge.
        Assert(
            CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(330f, 40f, 1f, 2520f, 1080f) == "30.0,40.0,1.000",
            $"21:9 (2520 wide): x shifts by −300 (got {CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(330f, 40f, 1f, 2520f, 1080f)})");
        // The renderer's re-centre, applied by hand, returns the host's own placement.
        const float CaptureWidth = 2520f;
        Assert(30f + ((CaptureWidth - 1920f) / 2f) == 330f, "…and the renderer's +300 puts it back at the host's x");

        // 16:10: a 1920x1200 design viewport normalizes to 1728x1080, so the reference sits 96 OUTSIDE its left edge.
        var sixteenTen = CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(0f, 100f, 1f, 1920f, 1200f);
        Assert(sixteenTen == "96.0,90.0,0.900", $"16:10 (1728 wide normalized): x shifts by +96, y and scale by 0.9 (got {sixteenTen})");

        // A real 21:9 window (2560x1080) that is not the capture's own width.
        var ultrawide = CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(320f, 0f, 1f, 2560f, 1080f);
        Assert(ultrawide == "0.0,0.0,1.000", $"2560x1080: x shifts by −320 (got {ultrawide})");
    }

    // The invariant behind the shift: a node at the host's horizontal centre is at the reference centre (960),
    // whatever the host's aspect.
    private static void FrameCentreMapsToReferenceCentreAtEveryAspect()
    {
        (float W, float H)[] viewports = [(1920f, 1080f), (2520f, 1080f), (2560f, 1080f), (1920f, 1200f), (1440f, 1080f), (3440f, 1440f)];
        foreach (var (w, h) in viewports)
        {
            var spec = CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(w / 2f, 0f, 1f, w, h);
            Assert(spec.StartsWith("960.0,", StringComparison.Ordinal), $"{w}x{h}: the host's centre maps to x=960 (got {spec})");
        }
    }

    // No readable viewport: keep the unshifted spec (the pre-change behaviour) rather than invent a margin.
    private static void FrameWithAnUnreadableViewportIsNotShifted()
    {
        Assert(
            CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(105.6f, 99.44f, 0.89f, 0f, 0f) == LegacySpec(105.6f, 99.44f, 0.89f, 0f),
            "a zero viewport keeps the legacy spec");
        Assert(
            CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec(105.6f, 99.44f, 0.89f, 0f, 1080f) == LegacySpec(105.6f, 99.44f, 0.89f, 1080f),
            "a zero width alone does not shift x");
    }

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }
}
