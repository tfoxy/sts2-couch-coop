namespace CouchCoop.Mod.Server;

/// <summary>
/// An OPTIONAL companion to <c>ICouchCoopHotGeneration</c>: serve a byte stream whose socket someone else
/// owns.
/// </summary>
/// <remarks>
/// <para>
/// <c>ICouchCoopHotGeneration.HandleClientAsync</c> takes a <c>TcpClient</c> and calls
/// <c>GetStream()</c> itself, which is exactly wrong for TLS — by the time
/// <see cref="SecureBrowserListener"/> dispatches, the handshake is done and the only usable stream is the
/// <c>SslStream</c> wrapping that socket. This interface is the seam for that case.
/// </para>
/// <para>
/// WHY IT IS SEPARATE, AND NOT A NEW METHOD ON THE HOT-RELOAD CONTRACT. That contract lives in the shared
/// <c>CouchCoop.Mod.Contracts</c> assembly and is bound BY REFLECTION at load time
/// (<c>CouchCoopModEntry</c> checks the factory's return type against it), so widening it changes the ABI
/// every previously built hot-reload logic assembly was compiled against. Declaring the extra capability
/// here, in the server assembly, and type-testing for it at dispatch keeps that contract frozen: a
/// generation that implements it serves the secure origin, and one that does not gets an honest 503 on the
/// TLS port while its plain-HTTP behaviour is completely unaffected.
/// </para>
/// </remarks>
public interface ICouchCoopStreamGeneration
{
    /// <param name="isSecure">
    /// Whether the stream arrived over TLS. Stated explicitly rather than sniffed from the stream's type:
    /// the accepting listener is the one place that knows for certain, and the join path needs the answer to
    /// decide which port a redirected seat is sent to.
    /// </param>
    Task ServeAsync(Stream stream, bool isSecure, CancellationToken cancellationToken);
}
