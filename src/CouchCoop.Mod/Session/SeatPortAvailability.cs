using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace CouchCoop.Mod.Session;

/// <summary>What a raw TCP connect to a seat's port on this machine found. Three answers, three meanings.</summary>
internal enum SeatPortReachability
{
    /// <summary>No connect was attempted — nothing may be concluded from this.</summary>
    NotProbed,

    /// <summary>The handshake completed: something IS listening and accepting on that port.</summary>
    Accepted,

    /// <summary>The kernel refused it: definitively nothing is listening there yet.</summary>
    ConnectionRefused,

    /// <summary>
    /// Neither completed nor refused. On loopback that leaves one explanation: this machine dropped its own
    /// packet — a local firewall rule or security product filtering the port.
    /// </summary>
    Unreachable,
}

/// <summary>One reachability answer plus the English sentence a report quotes for it.</summary>
internal readonly record struct SeatPortProbe(SeatPortReachability Reachability, string Detail);

/// <summary>
/// Asks, before a seat is spawned, whether <see cref="HeadlessClientManager.SlotToPort"/> for that slot is
/// genuinely free on this computer.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT EXISTS. The host hands the browser <c>SlotToPort(slot)</c> and probes that same port for readiness, but
/// the seat's own listener used to walk upward when the port was taken — so a seat whose port had a foreign owner
/// served happily on a port nothing would ever ask for, and the join died at the 75-second deadline with a message
/// that named the wrong component. The likeliest field trigger is an orphaned seat from a crashed session still
/// holding its port, which is also why "it stopped working until I restarted the game" is a real report.
/// <see cref="HeadlessSeatPortGuard"/> is the other half: it stops the walk. This half is what lets a brand-new
/// player simply take a different slot instead of failing at all.
/// </para>
/// <para>
/// TWO SIGNALS, AND THE BIND TEST ALONE IS NOT ONE. A <c>connect</c> to 127.0.0.1 is the definitive test: anything
/// that completes a TCP handshake owns the loopback traffic the host's readiness probe and a seat-bound browser
/// will send. A test BIND is the second signal, and it is second on purpose — under <c>SO_REUSEADDR</c> (which
/// .NET sets on a listening socket by default on Unix) a bind to <c>0.0.0.0:P</c> can succeed while a squatter
/// listening on <c>127.0.0.1:P</c> still receives every loopback connection. Either signal means occupied.
/// </para>
/// <para>
/// A PROBE THAT TIMES OUT REPORTS FREE, deliberately. A connect that neither completes nor is refused means the
/// packet was dropped rather than answered — a local firewall rule, not an owner — and refusing a player their
/// seat over that would turn one diagnosable condition (which
/// <see cref="SeatReadinessVerdict"/> names as the host-local block) into a join that never happens.
/// </para>
/// </remarks>
internal static class SeatPortAvailability
{
    /// <summary>
    /// How long one loopback connect may take. A port nothing listens on is refused by the kernel in
    /// microseconds, so this only bounds the dropped-packet case above.
    /// </summary>
    internal static readonly TimeSpan ProbeTimeout = TimeSpan.FromMilliseconds(250);

    /// <summary>
    /// The address a seat's browser server binds (<c>CouchCoopHostUiServices</c>'s default), and therefore the
    /// address the test bind below has to use to mean anything.
    /// </summary>
    internal static readonly IPAddress SeatBindAddress = IPAddress.Any;

    /// <summary>
    /// An English description of whatever owns <paramref name="port"/> on this computer, or
    /// <see langword="null"/> when it looks free. The string is a diagnostic, quoted verbatim into reports.
    /// </summary>
    public static Task<string?> DescribeOwnerAsync(int port, CancellationToken cancellationToken)
        => DescribeOwnerAsync(port, SeatBindAddress, ProbeTimeout, cancellationToken);

    internal static async Task<string?> DescribeOwnerAsync(
        int port,
        IPAddress bindAddress,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (port is < 1 or > ushort.MaxValue) return null;

        var probe = await ProbeLoopbackAsync(port, timeout, cancellationToken).ConfigureAwait(false);
        if (probe.Reachability == SeatPortReachability.Accepted)
        {
            return $"another program answered a TCP connection on 127.0.0.1:{port.ToString(CultureInfo.InvariantCulture)}";
        }

        return TestBindRefusal(port, bindAddress) is { } refusal
            ? $"binding {bindAddress}:{port.ToString(CultureInfo.InvariantCulture)} was refused ({refusal})"
            : null;
    }

    /// <summary>
    /// A raw TCP connect to <c>127.0.0.1:port</c>, separating the three answers that matter.
    /// </summary>
    /// <remarks>
    /// <para>
    /// REFUSED AND DROPPED ARE NOT THE SAME ANSWER, and collapsing them is what this exists to prevent. A refusal
    /// is the kernel saying, definitively, that nothing is listening — that is a seat which has not finished
    /// starting. A connect that neither completes nor is refused means the packet was eaten on the way, which on
    /// loopback can only be this machine's own filtering. An HTTP probe cannot tell them apart: both surface as
    /// the same client-side timeout.
    /// </para>
    /// <para>
    /// Only <see cref="SeatPortReachability.ConnectionRefused"/> is treated as "definitively nothing there";
    /// every other socket error is reported as unreachable, because a refusal is the only one that carries that
    /// meaning and guessing about the rest is how a message ends up naming the wrong component. The exact error
    /// travels in <see cref="SeatPortProbe.Detail"/>, so a report can be re-read whatever we concluded.
    /// </para>
    /// </remarks>
    internal static async Task<SeatPortProbe> ProbeLoopbackAsync(
        int port,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            await socket.ConnectAsync(new IPEndPoint(IPAddress.Loopback, port), deadline.Token).ConfigureAwait(false);
            return new SeatPortProbe(SeatPortReachability.Accepted, "TCP connect succeeded");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return new SeatPortProbe(
                SeatPortReachability.Unreachable,
                $"TCP connect did not complete within {((long)timeout.TotalMilliseconds).ToString(CultureInfo.InvariantCulture)} ms");
        }
        catch (SocketException exception)
        {
            return exception.SocketErrorCode == SocketError.ConnectionRefused
                ? new SeatPortProbe(SeatPortReachability.ConnectionRefused, "TCP connect refused")
                : new SeatPortProbe(
                    SeatPortReachability.Unreachable, $"TCP connect failed ({exception.SocketErrorCode})");
        }
    }

    /// <summary>
    /// The socket error a test bind on <paramref name="bindAddress"/> hit, or <see langword="null"/> when the
    /// bind succeeded (and was immediately released again).
    /// </summary>
    private static string? TestBindRefusal(int port, IPAddress bindAddress)
    {
        TcpListener? listener = null;
        try
        {
            listener = new TcpListener(bindAddress, port);
            listener.Start();
            return null;
        }
        catch (SocketException exception)
        {
            return exception.SocketErrorCode.ToString();
        }
        catch (Exception exception)
        {
            // A platform that refuses the test itself must not be read as an owner.
            CouchCoopLog.Stderr(
                $"seat port bind test skipped port={port}: {exception.GetType().Name}: {exception.Message}");
            return null;
        }
        finally
        {
            try { listener?.Stop(); } catch { /* releasing a probe listener cannot fail a join */ }
        }
    }
}
