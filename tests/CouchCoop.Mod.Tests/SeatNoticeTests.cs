using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The seat readiness verdict on its way to the PHONE: what gets said, when, and to whom.
/// </summary>
/// <remarks>
/// <para>
/// THE GAP THIS CLOSES. The host names four causes precisely and, for the one that matters most to a player, told
/// only itself. With the path from a device to its seat port blocked, the host's own loopback probe of that seat
/// SUCCEEDS — so the join is answered as a success, the browser is redirected to a port it cannot open, and the
/// viewer sits on "Loading…" for ever. Meanwhile the monitor computes <c>SeatReadinessCause.NetworkPath</c> about
/// that exact seat, on real evidence, four times a second, and puts it on the host's panel.
/// </para>
/// <para>
/// Four properties are pinned here because the delivery is only safe if all four hold. It says nothing while
/// nothing is wrong (every healthy join is "still starting" for its whole 20-60 seconds). It speaks on a CHANGE,
/// not on a tick, because the verdict is recomputed four times a second. It WITHDRAWS, so an accusation cannot
/// outlive the condition it described. And it waits before blaming a player's network, because the moment that
/// cause first holds is before the browser has even been told which port to open.
/// </para>
/// </remarks>
internal static class SeatNoticeTests
{
    public static void Run()
    {
        SilentWhileNothingIsWrong();
        SpeaksOnChangeNotOnTick();
        WithdrawsWhenTheCauseClears();
        WaitsBeforeBlamingThePlayersNetwork();
        HostSideCausesAreSpokenAtOnce();
        ReachesOnlyTheViewersBoundToThatSeat();
        CarriesTheHostsOwnEnglishOntoTheWire();
        ADeliveryThatThrowsCannotFaultThePublisher();
        AReconnectingViewerIsToldAgain();
        Console.WriteLine("SeatNoticeTests: ok");
    }

    // ---- the speaker: what a seat should be saying, and when --------------------------------------------------

    private static void SilentWhileNothingIsWrong()
    {
        var speaker = new SeatNoticeSpeaker(new FakeTime());

        // The state of every healthy join for its whole 20-60 second cold spawn. There is nothing behind it for a
        // player to do, so announcing it would put a diagnosis on the screen of every successful join.
        for (var tick = 0; tick < 40; tick++)
        {
            Assert(speaker.Observe(Verdict(StillStarting())) is null,
                "a seat that is merely still starting says nothing to its viewers");
        }

        // …and the cause has no wire spelling at all, so it cannot be announced by any other route either.
        Assert(SeatNoticeSpeaker.CauseToken(SeatReadinessCause.StillStarting) is null,
            "still-starting maps to no wire token");
    }

    private static void SpeaksOnChangeNotOnTick()
    {
        var hub = new SeatNoticeHub();
        var speaker = new SeatNoticeSpeaker(new FakeTime());
        var session = Guid.NewGuid();
        var sent = new List<SeatNotice?>();
        hub.Subscribe(session, sent.Add);

        // The monitor's real cadence: four verdicts a second, all saying the same thing.
        for (var tick = 0; tick < 20; tick++)
        {
            hub.Publish(session, speaker.Observe(Verdict(PortConflict())));
        }

        Assert(sent.Count == 1, $"20 identical ticks cost ONE frame, not 20 (was: {sent.Count})");
        Assert(sent[0]?.Cause == BrowserSeatNoticeCauses.PortConflict, "…carrying the cause the host named");

        // A genuinely different cause IS sent: the debounce is about repetition, not about going quiet.
        hub.Publish(session, speaker.Observe(Verdict(HostLocalBlock())));
        Assert(sent.Count == 2 && sent[1]?.Cause == BrowserSeatNoticeCauses.HostLocalBlock,
            "a changed cause is announced");

        // So is the same cause with a different detail — the evidence tail is what a support report is read from,
        // and a stale one under a live cause would describe a machine state that has moved on.
        var elsewhere = PortConflict() with { ReportedPort = 13_367 };
        hub.Publish(session, speaker.Observe(Verdict(elsewhere)));
        Assert(sent.Count == 3 && sent[2]?.Cause == BrowserSeatNoticeCauses.PortConflict, "…and a changed detail");
        Assert(sent[2]?.Detail != sent[0]?.Detail, "…which really is different text");
    }

    private static void WithdrawsWhenTheCauseClears()
    {
        var hub = new SeatNoticeHub();
        var speaker = new SeatNoticeSpeaker(new FakeTime());
        var session = Guid.NewGuid();
        var sent = new List<SeatNotice?>();
        hub.Subscribe(session, sent.Add);

        hub.Publish(session, speaker.Observe(Verdict(HostLocalBlock())));
        Assert(sent.Count == 1, "the block is announced");

        // The condition went away — the phone finally got through, the firewall rule was removed, a browser
        // attached. A message that stays on screen once it has stopped being true is worse than none.
        hub.Publish(session, speaker.Observe(Verdict(StillStarting())));
        Assert(sent.Count == 2 && sent[1] is null, "the notice is withdrawn when the cause clears");

        // Withdrawn ONCE. Every tick after it is already nothing-to-say against nothing-on-screen.
        for (var tick = 0; tick < 10; tick++) hub.Publish(session, speaker.Observe(Verdict(StillStarting())));
        Assert(sent.Count == 2, "a withdrawal is not repeated");

        // And a viewer who was never told anything is never sent a withdrawal: with nothing outstanding there is
        // nothing to take back, which is what keeps a healthy join silent on the wire from first tick to last.
        var quiet = Guid.NewGuid();
        var quietSent = new List<SeatNotice?>();
        hub.Subscribe(quiet, quietSent.Add);
        for (var tick = 0; tick < 10; tick++) hub.Publish(quiet, null);
        Assert(quietSent.Count == 0, "nothing-to-say with nothing outstanding sends nothing at all");
    }

    private static void WaitsBeforeBlamingThePlayersNetwork()
    {
        var time = new FakeTime();
        var speaker = new SeatNoticeSpeaker(time);
        var delay = SeatNoticeSpeaker.NetworkPathSettlingDelay;

        // The cause can first hold the instant the host's own probe of the seat succeeds — which is BEFORE the
        // browser has been told which port to open. Speaking here would tell a player whose phone is mid-redirect
        // that their router is broken.
        Assert(speaker.Observe(Verdict(NetworkPath())) is null, "the network is not blamed the moment the cause holds");

        time.Advance((long)delay.TotalMilliseconds - 1);
        Assert(speaker.Observe(Verdict(NetworkPath())) is null, "…nor one millisecond before the delay is up");

        time.Advance(1);
        Assert(speaker.Observe(Verdict(NetworkPath()))?.Cause == BrowserSeatNoticeCauses.NetworkPath,
            "…and is blamed once the cause has held for the settling delay");

        // A FRESH episode gets a fresh window. A seat that flickered out of this state and back has not been in
        // it for the delay, whatever the previous episode's clock said.
        Assert(speaker.Observe(Verdict(StillStarting())) is null, "the cause clears");
        Assert(speaker.Observe(Verdict(NetworkPath())) is null, "a second episode starts its own settling window");
        time.Advance((long)delay.TotalMilliseconds);
        Assert(speaker.Observe(Verdict(NetworkPath()))?.Cause == BrowserSeatNoticeCauses.NetworkPath,
            "…and is spoken when that window is up");

        // The number itself. Long enough to cover a redirect handoff an order of magnitude over; short enough to
        // land inside the "this can take up to a minute" the join screen already promised, and well under the
        // host's own 75 s seat deadline.
        Assert(delay >= TimeSpan.FromSeconds(10) && delay <= TimeSpan.FromSeconds(30),
            $"the settling delay covers the redirect handoff without outlasting the player (was: {delay})");
    }

    private static void HostSideCausesAreSpokenAtOnce()
    {
        // Both are about the HOST computer, and both are already well guarded by the classifier — a port conflict
        // is a disagreement the seat itself reported, a host-local block needs a raw TCP connect that was dropped
        // rather than refused. Delaying them would only postpone a message about a machine the viewer is not at.
        Assert(new SeatNoticeSpeaker(new FakeTime()).Observe(Verdict(PortConflict()))?.Cause
            == BrowserSeatNoticeCauses.PortConflict, "a port conflict is spoken on the tick it is found");
        Assert(new SeatNoticeSpeaker(new FakeTime()).Observe(Verdict(HostLocalBlock()))?.Cause
            == BrowserSeatNoticeCauses.HostLocalBlock, "a host-local block is spoken on the tick it is found");
    }

    // ---- the hub: who hears it -------------------------------------------------------------------------------

    private static void ReachesOnlyTheViewersBoundToThatSeat()
    {
        var hub = new SeatNoticeHub();
        var seatViewer = Guid.NewGuid();
        var otherViewer = Guid.NewGuid();
        var seatSent = new List<SeatNotice?>();
        var otherSent = new List<SeatNotice?>();
        hub.Subscribe(seatViewer, seatSent.Add);
        hub.Subscribe(otherViewer, otherSent.Add);

        // The monitor publishes to the sessions bound to ITS slot. Another player's browser, on the same host, is
        // not one of them — and a diagnosis about somebody else's seat on your screen is a false alarm.
        hub.Publish(seatViewer, SpokenNetworkPath().Notice);
        Assert(seatSent.Count == 1, "the seat's own viewer is told");
        Assert(otherSent.Count == 0, "an unrelated viewer on the same host hears nothing about another seat");

        // A session with no socket is not an error and leaves no trace: a subscriber that registers a moment
        // later must receive the CURRENT verdict on the next tick, not be debounced against a delivery that
        // never happened.
        var unknown = Guid.NewGuid();
        Assert(!hub.Publish(unknown, new SeatNotice(BrowserSeatNoticeCauses.NetworkPath, "detail")),
            "publishing to a session with no socket sends nothing");
        var lateSent = new List<SeatNotice?>();
        hub.Subscribe(unknown, lateSent.Add);
        hub.Publish(unknown, new SeatNotice(BrowserSeatNoticeCauses.NetworkPath, "detail"));
        Assert(lateSent.Count == 1, "…and the socket that arrives next is still told");

        hub.Unsubscribe(seatViewer);
        hub.Publish(seatViewer, new SeatNotice(BrowserSeatNoticeCauses.PortConflict, "detail"));
        Assert(seatSent.Count == 1, "a socket that has gone away is not written to");
    }

    private static void AReconnectingViewerIsToldAgain()
    {
        // The real shape of the failure this exists for: the phone cannot reach its seat, its seat socket dies,
        // and the app falls back to a FRESH host connection — a new session id — which re-runs the join dance and
        // is redirected to the same unreachable port. The hub's "already told" record belongs to the socket that
        // is gone, so the new one hears the verdict rather than inheriting a conversation it was not part of.
        var hub = new SeatNoticeHub();
        var notice = new SeatNotice(BrowserSeatNoticeCauses.NetworkPath, "detail");

        var first = Guid.NewGuid();
        var firstSent = new List<SeatNotice?>();
        hub.Subscribe(first, firstSent.Add);
        hub.Publish(first, notice);
        Assert(firstSent.Count == 1, "the first socket is told");
        hub.Unsubscribe(first);

        var second = Guid.NewGuid();
        var secondSent = new List<SeatNotice?>();
        hub.Subscribe(second, secondSent.Add);
        hub.Publish(second, notice);
        Assert(secondSent.Count == 1, "the reconnected viewer is told the same verdict again");
    }

    private static void ADeliveryThatThrowsCannotFaultThePublisher()
    {
        // The publisher is the seat monitor's 250 ms loop, and ITS exception handler tears the seat down with
        // `process-monitor-failed`. A diagnostic that can kill the thing it is describing is worse than none.
        var hub = new SeatNoticeHub();
        var angry = Guid.NewGuid();
        var calm = Guid.NewGuid();
        var calmSent = new List<SeatNotice?>();
        hub.Subscribe(angry, _ => throw new InvalidOperationException("socket closed"));
        hub.Subscribe(calm, calmSent.Add);

        hub.Publish(angry, new SeatNotice(BrowserSeatNoticeCauses.NetworkPath, "detail"));
        // …and the next subscriber in the same pass is unaffected: one broken socket does not silence the rest.
        hub.Publish(calm, new SeatNotice(BrowserSeatNoticeCauses.NetworkPath, "detail"));
        Assert(calmSent.Count == 1, "a throwing delivery neither propagates nor poisons the hub");
    }

    // ---- the wire ---------------------------------------------------------------------------------------------

    private static void CarriesTheHostsOwnEnglishOntoTheWire()
    {
        var (verdict, notice) = SpokenNetworkPath();

        // VERBATIM. The detail is the host's own technical sentence — the grey line on the connection panel, and
        // the text the copyable report quotes — so the phone and the panel cannot describe the same seat two
        // different ways. It is the localized summary above it that differs per surface, not this.
        Assert(notice?.Detail == verdict.Detail, "the notice carries the host's English detail unchanged");
        Assert(verdict.Detail.Contains("never reached it", StringComparison.Ordinal),
            "…which is the network-path sentence");
        Assert(!verdict.Detail.Contains("not responding", StringComparison.Ordinal),
            "…and never accuses the seat's own listener");

        // The exact bytes the browser parses (browserEnvelope.ts): BrowserJson is web camelCase, nulls omitted.
        var frame = BrowserJson.Serialize(new BrowserSeatNoticeEnvelope(
            "seat-notice", notice!.Value.Cause, notice.Value.Detail));
        Assert(frame.StartsWith("{\"type\":\"seat-notice\",\"cause\":\"network-path\",\"detail\":\"", StringComparison.Ordinal),
            $"the wire shape is the one the browser parses (was: {frame})");

        // The WITHDRAWAL rides the same envelope with the `none` cause and no detail, rather than a second type:
        // one parse path for the client, and an older client drops both identically.
        Assert(BrowserJson.Serialize(new BrowserSeatNoticeEnvelope("seat-notice", BrowserSeatNoticeCauses.None, null))
            == "{\"type\":\"seat-notice\",\"cause\":\"none\"}", "a withdrawal is the same envelope with no detail");

        // Every cause the host can name has a token, and no token is an enum name or ordinal.
        foreach (var cause in Enum.GetValues<SeatReadinessCause>())
        {
            var token = SeatNoticeSpeaker.CauseToken(cause);
            Assert(token is null || token == token.ToLowerInvariant(),
                $"the wire spelling of {cause} is a token, not the enum name");
        }
    }

    // ---- facts ------------------------------------------------------------------------------------------------

    private static SeatReadinessVerdictResult Verdict(SeatReadinessFacts facts) => SeatReadinessVerdict.Describe(facts);

    /// <summary>A seat coming up normally: nothing has failed, and nothing has finished either.</summary>
    private static SeatReadinessFacts StillStarting()
        => new(
            ExpectedPort: 13357,
            ReportedPort: 0,
            PortOwner: null,
            HostMember: false,
            NativePhase: "starting",
            HeartbeatFresh: false,
            ListenerResponding: null,
            ProbeFailure: null,
            TcpReachability: SeatPortReachability.NotProbed,
            ConnectedBrowserCount: 0,
            SeatViewerArrivals: null,
            ElapsedMs: 4_000,
            DeadlineMs: 75_000);

    /// <summary>The seat bound a port that is not the one the browser was handed.</summary>
    private static SeatReadinessFacts PortConflict()
        => StillStarting() with { HeartbeatFresh = true, ReportedPort = 13_361, NativePhase = "Connecting" };

    /// <summary>The seat is listening where expected and this computer's own probe cannot reach it.</summary>
    private static SeatReadinessFacts HostLocalBlock()
        => StillStarting() with
        {
            HeartbeatFresh = true,
            ReportedPort = 13357,
            NativePhase = "Connecting",
            ListenerResponding = false,
            ProbeFailure = "TaskCanceledException after 812 ms; TCP connect could not complete",
            TcpReachability = SeatPortReachability.Unreachable,
        };

    /// <summary>Host side clear, and the seat itself has seen nothing arrive from off this machine.</summary>
    private static SeatReadinessFacts NetworkPath()
        => StillStarting() with
        {
            HeartbeatFresh = true,
            ReportedPort = 13357,
            NativePhase = "Connecting",
            HostMember = true,
            ListenerResponding = true,
            SeatViewerArrivals = 0,
        };

    /// <summary>
    /// A network-path verdict that has held past the settling delay, so the speaker will actually say it — the
    /// only way to obtain one, which is the point of the delay.
    /// </summary>
    private static (SeatReadinessVerdictResult Verdict, SeatNotice? Notice) SpokenNetworkPath()
    {
        var time = new FakeTime();
        var speaker = new SeatNoticeSpeaker(time);
        var verdict = Verdict(NetworkPath() with { ElapsedMs = 60_000 });
        speaker.Observe(verdict);
        time.Advance((long)SeatNoticeSpeaker.NetworkPathSettlingDelay.TotalMilliseconds);
        return (verdict, speaker.Observe(verdict));
    }

    private static void Assert(bool value, string message)
    {
        if (!value) throw new Exception("[SeatNoticeTests] " + message);
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Volatile.Read(ref _timestamp);
        public override DateTimeOffset GetUtcNow()
            => DateTimeOffset.UnixEpoch.AddMilliseconds(Volatile.Read(ref _timestamp));
        public void Advance(long milliseconds)
            => Volatile.Write(ref _timestamp, Volatile.Read(ref _timestamp) + milliseconds);
    }
}
