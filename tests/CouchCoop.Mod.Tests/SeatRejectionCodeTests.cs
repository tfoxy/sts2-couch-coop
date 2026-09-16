using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// Which <c>joinRejection</c> code a REFUSED join is answered with — the envelope half of "a rejected join gets
/// the copy that already exists".
/// </summary>
/// <remarks>
/// <para>
/// THE GAP THIS CLOSES. The readiness verdict names four unrelated conditions, each with its own fix and each
/// with translated copy on the phone (<c>MIRROR_SEAT_NOTICE_KEYS</c>) — but only down the REDIRECT path, where
/// the join succeeded and the seat turned out to be unreachable afterwards. A join that was refused outright
/// collapsed every one of them into <c>spawn-failed</c>, whose copy is "Couldn't start your game view — please
/// try again": an invitation to retry the one thing a retry cannot fix. Measured Sep-15 2026: a pinned rejoin
/// onto a port another program owned failed in 606 ms and said exactly that, while
/// "Nothing to change on this device — ask whoever is hosting to restart Slay the Spire 2" already existed in
/// all 14 catalogs.
/// </para>
/// <para>
/// The other arms are pinned alongside it because this is a PRECEDENCE, not an addition: a named seat cause must
/// outrank the spawn-window arms, and every code outside the named set must keep behaving exactly as it did.
/// </para>
/// </remarks>
internal static class SeatRejectionCodeTests
{
    public static void Run()
    {
        NamedSeatCausesRideTheirOwnCode();
        TheEvidenceTailRidesAlong();
        UnnamedFailuresStillReadAsSpawnFailed();
        TheOtherArmsAreUnchanged();
        Console.WriteLine("SeatRejectionCodeTests: ok");
    }

    // The three causes the phone has copy for. Forwarded verbatim so the client can key its seat-notice cause
    // off the same literal the host panel's IssueKey arm does — one vocabulary, two surfaces.
    private static void NamedSeatCausesRideTheirOwnCode()
    {
        foreach (var code in new[]
                 {
                     SeatReadinessVerdict.PortTakenCode,
                     SeatReadinessVerdict.PortBlockedCode,
                     SeatReadinessVerdict.NetworkPathCode
                 })
        {
            var refused = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
                Issue(code), spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
            Assert(refused.Rejection == code, $"{code} reaches the viewer under its own name");

            // …and it outranks the spawn-window arms, which is the whole point: a seat rejoin is the shape that
            // produced the measured 606 ms "please try again", and it would otherwise force "spawn-failed".
            var pinnedRejoin = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
                Issue(code), spawnAllowed: false, isSeatRejoin: true, hasNameClaim: true);
            Assert(pinnedRejoin.Rejection == code, $"{code} survives a pinned seat rejoin");
        }
    }

    // The grey technical line under the friendly copy. Same text the panel shows and the copyable report quotes,
    // which is what stops a player and whoever is hosting for them from reading two different diagnoses.
    private static void TheEvidenceTailRidesAlong()
    {
        var withDetail = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            Issue(SeatReadinessVerdict.PortTakenCode, detail: "Observed: assigned port 13357; owner: some-daemon."),
            spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
        Assert(withDetail.Detail == "Observed: assigned port 13357; owner: some-daemon.",
            "the verdict's evidence tail is the rejection detail");

        // An issue with no detail falls back to its summary rather than sending nothing — the viewer's grey line
        // is the only place the host's own words reach them.
        var summaryOnly = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            Issue(SeatReadinessVerdict.NetworkPathCode, detail: null),
            spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
        Assert(summaryOnly.Detail == "summary", "a detail-free issue still carries its summary");
    }

    // The regression guard for everything this must NOT change: a code outside the named set keeps the copy it
    // had, including a future verdict cause this build has never heard of.
    private static void UnnamedFailuresStillReadAsSpawnFailed()
    {
        var stillStarting = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            Issue(SeatReadinessVerdict.StillStartingCode), spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
        Assert(stillStarting.Rejection == "spawn-failed", "a timeout is still an ordinary spawn failure");

        var unknown = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            Issue("seat-something-nobody-has-shipped-yet"), spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
        Assert(unknown.Rejection == "spawn-failed", "an unrecognised cause is not forwarded as a rejection code");
    }

    private static void TheOtherArmsAreUnchanged()
    {
        var running = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            Issue(HeadlessDisconnectReason.RunInProgressCode), spawnAllowed: true, isSeatRejoin: true, hasNameClaim: true);
        Assert(running.Rejection == MirrorSeatStatuses.UnavailableRejection,
            "a refusal to launch into a running run still reads as an unavailable seat");

        var poolFull = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            null, spawnAllowed: true, isSeatRejoin: false, hasNameClaim: false);
        Assert(poolFull.Rejection == "no-free-instance", "no failure and no claim is still the full pool");

        var claimed = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            null, spawnAllowed: true, isSeatRejoin: false, hasNameClaim: true);
        Assert(claimed.Rejection == "spawn-failed", "a name that already holds a slot is a failed respawn");

        var stranger = CouchCoopWebSocketConnection.ClassifyFailedSpawn(
            null, spawnAllowed: false, isSeatRejoin: false, hasNameClaim: false);
        Assert(stranger.Rejection == "not-a-session-player", "no window, no seat, no claim is unchanged");
        Assert(stranger.Detail is null, "a self-describing rejection sends no evidence tail");
    }

    private static ConnectionIssue Issue(string code, string? detail = "detail")
        => new(code, "summary", "action", detail);

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception($"[SeatRejectionCodeTests] FAILED: {message}");
    }
}
