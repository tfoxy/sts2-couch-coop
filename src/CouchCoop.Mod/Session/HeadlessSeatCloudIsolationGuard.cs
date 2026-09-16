using CouchCoop.Mod.Patches;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Refuses to run a seat that cannot guarantee it is staying out of the player's Steam Cloud save storage, and
/// says so through the host's own connection-control channel before the process goes away.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THIS REPLACES. <see cref="SeatCloudSaveIsolationPatch"/> threw when one of its targets did not resolve,
/// and the throw refused nothing: mod init runs inside the loader's blanket <c>catch</c>
/// (<c>CouchCoopModEntry.Init</c>), which logs the exception and returns, leaving the seat running with Steam
/// initialised, a profile seeded and every cloud write path open — the exact state the throw existed to prevent.
/// A refusal has to be a decision about the process, so it is made here, in the shape
/// <see cref="HeadlessSeatBuildGuard"/> already uses: log it, report it to the host over the authenticated
/// channel under a short deadline so the player is told WHY, then force-exit.
/// </para>
/// <para>
/// AND IT RUNS FIRST. This guard is the first <c>Apply()</c>-shaped thing in <c>CouchCoopMod.Init</c>, above the
/// command-line override that is what lets a seat join at all. It used to sit ninth, behind two cache warms and
/// eight other patches, so a throw from ANY of them left a seat that joined, played, and wrote into the account's
/// cloud storage. It needs nothing but Harmony, so there is no reason for it to be anywhere else.
/// </para>
/// <para>
/// A GUARD THAT CANNOT RUN IS A FAILURE, which is where this differs from
/// <see cref="HeadlessSeatBuildGuard"/>: that one skips its check when it cannot read its own inputs, because the
/// worst case of skipping is a seat that runs a mismatched build. Here the worst case of skipping is a seat
/// overwriting saves, so anything unexpected — including an exception from the installer itself — is a refusal.
/// </para>
/// <para>
/// THE POSITIVE HALF. A refusal only helps when our code is running. When it is not (the mod never loaded, the
/// lane was refused, another copy won the assembly load) nothing here executes, so <see cref="Installed"/> is
/// also published on every heartbeat the seat sends, and the host fails a seat whose heartbeat does not carry it
/// — see <c>HeadlessClientManager.SeatCloudIsolationCode</c>.
/// </para>
/// </remarks>
internal static class HeadlessSeatCloudIsolationGuard
{
    /// <summary>
    /// The native-status error code a seat that could not install its cloud-save isolation reports. The host maps
    /// it to its own connection issue code rather than letting it land in the generic native-rejection bucket.
    /// </summary>
    internal const string FailureErrorCode = "couchcoop-seat-cloud-isolation-failed";

    /// <summary>How long the seat waits for its one-shot report to reach the host before exiting.</summary>
    private static readonly TimeSpan ReportDeadline = TimeSpan.FromSeconds(3);

    /// <summary>
    /// How long mod init may be delayed by the hello. Shorter than the refusal's deadline on purpose: that one is
    /// the seat's last word before it dies, this one is a courtesy on the happy path that the live reporter
    /// repeats a second later.
    /// </summary>
    private static readonly TimeSpan HelloDeadline = TimeSpan.FromSeconds(2);

    private static int _installed;

    /// <summary>
    /// Whether THIS process has closed every seat→Steam-Cloud write path. Reported on every heartbeat
    /// (<see cref="HeadlessConnectionReporter"/>) so the host never has to infer it from silence.
    /// </summary>
    internal static bool Installed => Volatile.Read(ref _installed) == 1;

    /// <summary>
    /// The report detail for a seat whose isolation is incomplete, or <see langword="null"/> when every write
    /// path was closed. Pure, so the verdict is testable without a process to kill.
    /// </summary>
    internal static string? Failure(IReadOnlyList<string> refused, int targetCount)
    {
        ArgumentNullException.ThrowIfNull(refused);
        if (refused.Count == 0) return null;
        return $"CouchCoop could not close {refused.Count} of {targetCount} paths by which this player's game "
            + "could write into the Steam Cloud save storage of the Steam account running the host. That storage "
            + "is shared with the host's own game, so a player's game writing into it overwrites the saves of the "
            + "person hosting. Left open: " + string.Join("; ", refused) + ".";
    }

    /// <summary>
    /// Install the isolation and, if any of it could not be installed, report and terminate this process.
    /// Returns normally only when the guarantee holds.
    /// </summary>
    public static void EnforceOrExit()
    {
        string? detail;
        try
        {
            detail = Failure(SeatCloudSaveIsolationPatch.Install(), SeatCloudSaveIsolationPatch.Targets.Count);
        }
        catch (Exception exception)
        {
            // Not a skip. See the remarks: an installer that threw is a seat whose write paths are in an unknown
            // state, and the only safe reading of "unknown" here is "open".
            detail = "CouchCoop could not install the protection that keeps this player's game out of the Steam "
                + "Cloud save storage of the account running the host: "
                + $"{exception.GetType().Name}: {exception.Message}";
        }

        if (detail is null)
        {
            Volatile.Write(ref _installed, 1);
            SayHello();
            return;
        }

        CouchCoopLog.Error($"seat refused: Steam Cloud save isolation is incomplete. {detail}");
        CouchCoopLog.Stderr($"seat refused: Steam Cloud save isolation is incomplete. {detail}");

        try
        {
            using var deadline = new CancellationTokenSource(ReportDeadline);
            HeadlessConnectionReporter
                .ReportTerminalFailureAsync(FailureErrorCode, detail, deadline.Token)
                .GetAwaiter()
                .GetResult();
        }
        catch (Exception exception)
        {
            // The host still learns something: the process is about to exit, which it reports as a closed client
            // game — and the heartbeat that never arrives is itself a refusal (the contact deadline). Losing the
            // precise cause is better than letting this process reach the player's saves.
            CouchCoopLog.Stderr(
                $"seat cloud isolation report failed: {exception.GetType().Name}: {exception.Message}");
        }

        // Not a polite quit: nothing has started yet, there is no scene tree to drain, and the one outcome that
        // must be impossible is this process going on to touch the account's cloud storage.
        HeadlessForceExit.Now();
    }

    /// <summary>
    /// Tell the host, right now, that a CouchCoop seat is alive here and the isolation is installed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This is the other half of the no-contact deadline, and the half that makes it fair. The host kills a seat
    /// it has heard nothing from within <c>HeadlessClientManager.DefaultSeatContactTimeoutSeconds</c>; without a
    /// hello the seat's first word came from <see cref="HeadlessConnectionReporter.Initialize"/>, a hundred lines
    /// further down <c>CouchCoopMod.Init</c> and behind everything expensive in it, so the deadline was really a
    /// deadline on how fast this computer starts a game. Now it is a deadline on whether our code is in the
    /// process at all — which is the only thing it was ever meant to ask.
    /// </para>
    /// <para>
    /// SYNCHRONOUS, AND BOUNDED. It is a loopback POST to a listener the host is already running, so the healthy
    /// case costs mod init a millisecond; the deadline is what covers the unhealthy one. Doing it in order (and
    /// not on a background task) is also what keeps the hello's sequence number ahead of nothing and behind every
    /// heartbeat, which is the rule the host accepts statuses on.
    /// </para>
    /// <para>
    /// BEST EFFORT, unlike the refusal above. A hello that does not land leaves a healthy seat running and the
    /// live reporter says the same thing a second later; failing the seat over it would invent an outage.
    /// </para>
    /// </remarks>
    private static void SayHello()
    {
        try
        {
            using var deadline = new CancellationTokenSource(HelloDeadline);
            // `true` is this method's precondition: it is called on the line after the latch, and nowhere else.
            if (!HeadlessConnectionReporter
                    .ReportSeatHelloAsync(cloudSaveIsolated: true, deadline.Token)
                    .GetAwaiter()
                    .GetResult())
            {
                // Not an error: a seat launched by hand has no control channel at all, and that is a normal way
                // to run one. Stderr only, and once.
                CouchCoopLog.Stderr("seat hello not accepted (no control channel, or the host did not answer)");
            }
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"seat hello failed: {exception.GetType().Name}: {exception.Message}");
        }
    }
}
