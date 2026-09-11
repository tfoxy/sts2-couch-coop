namespace CouchCoop.Mod.Server;

/// <summary>
/// This process's own secure-origin port, published once the TLS listener binds so anything in-process can
/// report it without holding a reference to the listener.
/// </summary>
/// <remarks>
/// <para>
/// WHY A PROCESS-WIDE VALUE. The TLS listener is owned by whoever started it
/// (<see cref="HotReloadableBrowserServerHost"/> on a real host, <see cref="CouchCoopBrowserServer"/> in the
/// standalone/test path), but the thing that has to REPORT it is a request handler inside
/// <see cref="CouchCoopBrowserServer"/>, which is rebuilt on every hot-reload generation and has no
/// reference to either. There is exactly one browser server and at most one secure listener per process, so
/// a single published value is the honest model — and it keeps the reporting route working across a
/// generation swap, which a constructor-injected reference would not.
/// </para>
/// <para>
/// WHY IT IS REPORTED OVER HTTP AT ALL. A joined seat is redirected to its OWN headless instance, which is a
/// SEPARATE PROCESS with its own port-walked listeners. The host therefore cannot derive that instance's
/// secure port — <see cref="SecureBrowserListener.PreferredPortOffset"/> is only a preference, and a walk
/// past a taken port would make a derived guess point at nothing. Asking the instance is the only answer
/// that cannot silently be wrong.
/// </para>
/// </remarks>
public static class SecureOriginEndpoint
{
    /// <summary>The route a peer reads to learn this process's real secure port.</summary>
    public const string Route = "/secure-port";

    private static int _port;

    /// <summary>The bound TLS port, or <c>0</c> when this process has no secure origin.</summary>
    public static int LocalSecurePort => Volatile.Read(ref _port);

    /// <summary>Called by whichever component bound the TLS listener. <c>0</c> clears it on teardown.</summary>
    public static void Publish(int port) => Volatile.Write(ref _port, port < 0 ? 0 : port);
}
