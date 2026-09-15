using System.Globalization;
using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Refuses to run a seat that could not bind the browser port its host assigned it, and says so through the
/// host's own connection-control channel before the process goes away.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THIS REPLACES. <c>COUCHCOOP_PREFERRED_PORT</c> was a PREFERENCE for every process: a browser server
/// whose port was taken walked upward until it found a free one. For a HOST that is correct and load-bearing —
/// several game instances run on one machine, and <c>scripts/lib/instance-port.mjs</c> reads the walked port out
/// of <see cref="Server.BrowserPortFile"/> for exactly that reason. For a SEAT it is a silent lie: the host hands
/// the browser <c>HeadlessClientManager.SlotToPort(slot)</c> and probes that same port, so a seat that walked
/// serves a port nothing will ever ask for. Measured Sep-15 2026: the join burned the full 75-second deadline and
/// died with "child HTTP listener: not responding" while the seat was alive and healthy one port up.
/// </para>
/// <para>
/// So the walk is now a HOST-only behaviour, and the gate is the seat identity
/// (<c>CouchCoopMod.IsHeadlessClient</c>, set from the seat launch environment), never a global switch.
/// </para>
/// <para>
/// THIS IS WHAT MAKES <see cref="Server.BrowserPortFile"/>'S CLAIM TRUE. That type's remarks say a seat's port
/// "is not discovered from a file at all — it is <c>SlotToPort(slot)</c>, known to the host before the process
/// exists", and until this guard existed that was an intention rather than a fact: the seat was free to walk off
/// the assigned port, and only its own <c>browser-port-slot-N</c> record knew where it had gone. The cure is not
/// to make the host read that file — a file is an unauthenticated, per-user-dir channel that says nothing about
/// liveness — but to remove the divergence. Where the host does need the seat's own word (the backstop for a
/// port taken between the survey and the bind), it comes over the authenticated heartbeat as
/// <c>HeadlessConnectionStatus.BrowserPort</c>. The port file keeps its existing job: telling external tooling
/// which port a HOST walked to.
/// </para>
/// <para>
/// The shape is <see cref="HeadlessSeatBuildGuard"/>'s: report a terminal status through the authenticated
/// control channel so the host can name the cause to the player, then exit hard rather than run on in a state
/// the host cannot address. The two guards differ only in when they can fire — a build mismatch is knowable at
/// mod init, an unavailable port only once the listener is actually brought up.
/// </para>
/// </remarks>
internal static class HeadlessSeatPortGuard
{
    /// <summary>
    /// The native-status error code a seat that could not bind its assigned port reports. The host maps it to
    /// its own connection issue code (<c>HeadlessClientManager.SeatPortTakenCode</c>'s panel copy) rather than
    /// letting it land in the generic native-rejection bucket.
    /// </summary>
    internal const string UnavailableErrorCode = "couchcoop-seat-port-unavailable";

    /// <summary>How long the seat waits for its one-shot report to reach the host before exiting.</summary>
    private static readonly TimeSpan ReportDeadline = TimeSpan.FromSeconds(3);

    /// <summary>
    /// Whether this process must bind <paramref name="preferredPort"/> exactly. True only for a seat: a host
    /// keeps its walk (see the remarks). Pure, so the polarity is testable without a game process.
    /// </summary>
    internal static bool MustBindExactly(bool isSeat, int preferredPort) => isSeat && preferredPort > 0;

    /// <summary>
    /// Bring up the browser listener: a host walks upward from <paramref name="preferredPort"/>, a seat binds
    /// exactly that port or throws <see cref="SeatPortUnavailableException"/>.
    /// </summary>
    internal static TcpListener Bind(
        IPAddress bindAddress,
        int preferredPort,
        bool isSeat,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(bindAddress);
        var exact = MustBindExactly(isSeat, preferredPort);
        for (var port = preferredPort; port <= ushort.MaxValue; port++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var listener = new TcpListener(bindAddress, port);
            try
            {
                listener.Start();
                return listener;
            }
            catch (SocketException exception)
            {
                listener.Stop();
                if (exact) throw new SeatPortUnavailableException(preferredPort, bindAddress, exception);
            }
        }

        throw new InvalidOperationException($"No local port was available at or above {preferredPort}.");
    }

    /// <summary>
    /// The report detail for a seat that could not bind its assigned port. Pure, so the wording is testable
    /// without a socket. English on purpose: it is quoted verbatim into the copyable report and onto the phone.
    /// </summary>
    internal static string Detail(int preferredPort, IPAddress bindAddress, string socketError)
        => $"This player's game was assigned browser port {preferredPort.ToString(CultureInfo.InvariantCulture)} "
            + $"and could not bind it on {bindAddress} ({socketError}). Another program on this computer owns that "
            + "port. The seat did not move to a different port, because the host and the browser both address it "
            + "by the assigned one.";

    /// <summary>
    /// Report <paramref name="failure"/> to the host and terminate this process. Never returns normally.
    /// </summary>
    public static void ReportAndExit(SeatPortUnavailableException failure)
    {
        ArgumentNullException.ThrowIfNull(failure);
        var detail = Detail(failure.PreferredPort, failure.BindAddress, failure.SocketError);
        CouchCoopLog.Error($"[couchcoop] seat refused: assigned browser port unavailable. {detail}");
        Console.Error.WriteLine($"[couchcoop] seat refused: assigned browser port unavailable. {detail}");

        try
        {
            using var deadline = new CancellationTokenSource(ReportDeadline);
            HeadlessConnectionReporter
                .ReportTerminalFailureAsync(UnavailableErrorCode, detail, deadline.Token)
                .GetAwaiter()
                .GetResult();
        }
        catch (Exception exception)
        {
            // The host still learns something: the process is about to exit, which it reports as a closed
            // client game. Losing the precise cause is better than serving a port nobody will ask for.
            Console.Error.WriteLine(
                $"[couchcoop] seat port report failed: {exception.GetType().Name}: {exception.Message}");
        }

        // Not a polite quit: there is no browser attached to drain, and the one outcome that must be impossible
        // is this process going on to serve a port the host never hands out.
        HeadlessForceExit.Now();
    }
}

/// <summary>A seat could not bind the browser port its host assigned it, and may not move to another.</summary>
internal sealed class SeatPortUnavailableException(int preferredPort, IPAddress bindAddress, SocketException cause)
    : Exception(
        $"The assigned browser port {preferredPort.ToString(CultureInfo.InvariantCulture)} could not be bound on "
            + $"{bindAddress} ({cause.SocketErrorCode}).",
        cause)
{
    public int PreferredPort { get; } = preferredPort;
    public IPAddress BindAddress { get; } = bindAddress;
    public string SocketError { get; } = cause.SocketErrorCode.ToString();
}
