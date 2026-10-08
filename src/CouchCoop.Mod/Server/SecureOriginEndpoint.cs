namespace CouchCoop.Mod.Server;

/// <summary>
/// This process's own secure-origin port, published once TLS is enabled on the browser listener.
/// </summary>
/// <remarks>
/// <para>
/// WHY A PROCESS-WIDE VALUE. The optional TLS transport is owned by whoever started it
/// (<see cref="HotReloadableBrowserServerHost"/> on a real host, <see cref="CouchCoopBrowserServer"/> in the
/// standalone/test path), but the thing that has to REPORT it is a request handler inside
/// <see cref="CouchCoopBrowserServer"/>, which is rebuilt on every hot-reload generation and has no
/// reference to either. There is exactly one browser server and one TCP listener per process, so
/// a single published value is the honest model — and it keeps the reporting route working across a
/// generation swap, which a constructor-injected reference would not.
/// </para>
/// <para>
/// A direct-port seat runs in a separate process. Its browser listener may have a different port from the
/// host's, and its certificate may arrive later, so the host asks that instance before redirecting a TLS viewer.
/// </para>
/// </remarks>
public static class SecureOriginEndpoint
{
    /// <summary>The route a peer reads to learn this process's real secure port.</summary>
    public const string Route = "/secure-port";

    /// <summary>Loopback-only POST that asks a headless seat to prepare its TLS listener.</summary>
    public const string EnableRoute = "/internal/secure-origin/enable";

    private static int _port;

    /// <summary>The shared browser port when TLS is ready, or <c>0</c> otherwise.</summary>
    public static int LocalSecurePort => Volatile.Read(ref _port);

    /// <summary>Called when TLS becomes ready. <c>0</c> clears it on teardown.</summary>
    public static void Publish(int port) => Volatile.Write(ref _port, port < 0 ? 0 : port);
}
