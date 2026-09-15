using System.Net.Sockets;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// <c>SO_REUSEPORT</c> for the two UDP sockets this mod binds on a fixed wildcard port
/// (<see cref="MdnsResponder"/> on 5353, <see cref="HostDiscoveryResponder"/> on the browser server's port).
/// </summary>
/// <remarks>
/// <para>
/// WHY IT IS NOT <c>SO_REUSEADDR</c>. On Linux, <c>SO_REUSEADDR</c> alone already lets two UDP sockets bind
/// the identical <c>0.0.0.0:port</c>. On BSD — which is macOS — it does NOT: for a duplicate bind of the same
/// address and port, BSD requires <c>SO_REUSEPORT</c> on every socket in the group, and <c>SO_REUSEADDR</c>
/// buys you only a bind that differs in address (or a multicast group address). So a responder that sets only
/// <c>SO_REUSEADDR</c> is portable in appearance and Linux-only in fact.
/// </para>
/// <para>
/// This MUST go through <see cref="Socket.SetRawSocketOption"/>: the managed <c>SetSocketOption</c> translates
/// <see cref="SocketOptionName"/> values through a known-options table on Unix, so a <c>(SocketOptionName)15</c>
/// cast never reaches <c>setsockopt</c> — it fails with <c>OperationNotSupported</c> (observed, not theorised).
/// <c>SetRawSocketOption</c> passes the numbers down verbatim, which is why the level/option constants are
/// spelled out per OS here.
/// </para>
/// <para>
/// Best-effort like everything else on these two sockets: a refusal logs one line and the caller carries on to
/// <c>Bind</c>, which is free to fail on its own terms.
/// </para>
/// </remarks>
public static class SocketReusePort
{
    private const int LinuxSolSocket = 1;
    private const int LinuxSoReusePort = 15;
    private const int BsdSolSocket = 0xFFFF;
    private const int BsdSoReusePort = 0x0200;

    /// <summary>
    /// Enable <c>SO_REUSEPORT</c> on <paramref name="socket"/>. Call BEFORE <c>Bind</c>.
    /// </summary>
    /// <param name="label">Prefix for the diagnostic line, so two callers' failures stay distinguishable.</param>
    /// <returns>
    /// <see langword="true"/> when the option was set, <see langword="false"/> when the platform has no
    /// <c>SO_REUSEPORT</c> (Windows) or refused it. Callers treat both the same way — this is for tests.
    /// </returns>
    public static bool TryEnable(Socket socket, string label, Action<string>? log = null)
    {
        var (level, option) = OperatingSystem.IsLinux()
            ? (LinuxSolSocket, LinuxSoReusePort)
            : OperatingSystem.IsMacOS() || OperatingSystem.IsFreeBSD()
                ? (BsdSolSocket, BsdSoReusePort)
                : (0, 0);

        if (option == 0)
        {
            // Windows has no SO_REUSEPORT; SO_REUSEADDR already carries the sharing semantics there.
            return false;
        }

        try
        {
            socket.SetRawSocketOption(level, option, BitConverter.GetBytes(1));
            return true;
        }
        catch (Exception exception) when (exception is SocketException or ObjectDisposedException or NotSupportedException)
        {
            log?.Invoke($"[couchcoop] {label} option-unavailable option=so-reuseport detail="
                + (exception is SocketException socketException
                    ? socketException.SocketErrorCode.ToString()
                    : exception.GetType().Name));
            return false;
        }
    }

    /// <summary>True on the platforms where <c>SO_REUSEPORT</c> exists at all. Diagnostics and tests.</summary>
    public static bool IsSupportedOnThisPlatform
        => OperatingSystem.IsLinux() || OperatingSystem.IsMacOS() || OperatingSystem.IsFreeBSD();
}
