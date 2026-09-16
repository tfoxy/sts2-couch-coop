using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Refuses to run a seat whose CouchCoop build is not the host's, and says so through the host's own
/// connection-control channel before the process goes away.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THIS REPLACES. A seat running a different build than its host produced no error at all: either a
/// silent divergence (two sides of the browser wire contract that no longer agree) or, at best, the
/// host's ten-second readiness deadline expiring with "The game did not join the host before the
/// connection deadline" and an action line that says to check that game and mod versions match — which
/// is true, unhelpful, and identical to every other startup timeout. In the case that motivated this,
/// every seat had loaded the Steam Workshop copy of the mod while the host ran the local one, and two of
/// them died outright in a patch that no longer bound.
/// </para>
/// <para>
/// So the check runs at mod init, BEFORE any patch is applied or any join is attempted, and its report
/// carries the one detail that names the cause to a player: the file the seat's CouchCoop was loaded
/// from. "…/workshop/content/2868840/&lt;item&gt;/couchcoop.dll" is a diagnosis; "versions differ" is not.
/// </para>
/// <para>
/// ABSENT IS NOT A MISMATCH. A seat with no <c>COUCHCOOP_HOST_MOD_BUILD</c> was spawned by a host that
/// predates this check, or was not spawned as a seat at all, and must run exactly as before. Only a
/// value that is present and different fails.
/// </para>
/// <para>
/// WHAT IT DOES NOT CATCH, stated plainly. The build string identifies a COMMIT — an ordinary local build
/// stamps <c>1.0.0+&lt;HEAD sha&gt;</c> and says nothing about uncommitted edits — so two deploys from the
/// same commit with different working trees compare equal. That is not the failure this exists for (two
/// separately INSTALLED copies of the mod are always different builds, because a published one carries its
/// release version and a local one does not), and it is why a dev deploy's <c>build-info.txt</c> records
/// whether the tree was dirty: the guard answers "same commit", the deploy record answers "same tree".
/// </para>
/// </remarks>
internal static class HeadlessSeatBuildGuard
{
    /// <summary>
    /// The native-status error code a mismatched seat reports. The host maps it to its own connection
    /// issue code rather than letting it land in the generic native-rejection bucket.
    /// </summary>
    internal const string MismatchErrorCode = "couchcoop-build-mismatch";

    /// <summary>How long the seat waits for its one-shot report to reach the host before exiting.</summary>
    private static readonly TimeSpan ReportDeadline = TimeSpan.FromSeconds(3);

    /// <summary>
    /// The report detail for a seat/host build mismatch, or <see langword="null"/> when there is nothing
    /// wrong. Pure, so the comparison is testable without a process to kill.
    /// </summary>
    internal static string? Mismatch(string? hostBuild, string? seatBuild, string? seatAssemblyPath)
    {
        if (string.IsNullOrWhiteSpace(hostBuild)) return null;
        if (string.Equals(hostBuild, seatBuild, StringComparison.Ordinal)) return null;
        return $"Host CouchCoop build: {hostBuild}. This player's game loaded CouchCoop build: "
            + $"{(string.IsNullOrWhiteSpace(seatBuild) ? "unknown" : seatBuild)}, from: "
            + $"{(string.IsNullOrWhiteSpace(seatAssemblyPath) ? "unknown" : seatAssemblyPath)}.";
    }

    /// <summary>
    /// Report and terminate this process when it is a seat running a different build than its host.
    /// Returns normally in every other case.
    /// </summary>
    public static void EnforceOrExit()
    {
        string? detail;
        try
        {
            detail = Mismatch(
                Environment.GetEnvironmentVariable(CouchCoopModBuildIdentity.HostBuildEnvironmentVariable),
                CouchCoopModBuildIdentity.Current,
                CouchCoopModBuildIdentity.AssemblyPath);
        }
        catch (Exception exception)
        {
            // A guard that cannot read its own inputs must not be the thing that stops a seat starting.
            CouchCoopLog.Stderr($"seat build check skipped: {exception.GetType().Name}: {exception.Message}");
            return;
        }

        if (detail is null) return;

        CouchCoopLog.Error($"seat refused: mod build does not match the host. {detail}");
        CouchCoopLog.Stderr($"seat refused: mod build does not match the host. {detail}");

        try
        {
            using var deadline = new CancellationTokenSource(ReportDeadline);
            HeadlessConnectionReporter
                .ReportTerminalFailureAsync(MismatchErrorCode, detail, deadline.Token)
                .GetAwaiter()
                .GetResult();
        }
        catch (Exception exception)
        {
            // The host still learns something: the process is about to exit, which it reports as a closed
            // client game. Losing the precise cause is better than joining with the wrong build.
            CouchCoopLog.Stderr($"seat build mismatch report failed: {exception.GetType().Name}: {exception.Message}");
        }

        // Not a polite quit: nothing has started yet, there is no scene tree to drain, and the one outcome
        // that must be impossible is this process going on to join the host.
        HeadlessForceExit.Now();
    }
}
