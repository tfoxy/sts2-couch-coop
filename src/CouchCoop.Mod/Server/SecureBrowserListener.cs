using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Optional TLS on an existing raw TCP listener. One bounded, non-consuming socket peek distinguishes a
/// TLS ClientHello from an HTTP request; the accepted socket then follows the appropriate stream path.
/// Certificate preparation happens after HTTP starts and does not reserve another TCP port.
/// </summary>
public sealed class SecureBrowserListener
{
    public static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(15);
    public const string UnavailableCode = "secure-listener-unavailable";

    private readonly Action<string> _log;
    private readonly TimeSpan _handshakeTimeout;
    private SslStreamCertificateContext? _certificateContext;

    public SecureBrowserListener(Action<string>? log = null, TimeSpan? handshakeTimeout = null)
    {
        _log = log ?? CouchCoopLog.Stderr;
        _handshakeTimeout = handshakeTimeout ?? HandshakeTimeout;
    }

    public bool IsRunning => Volatile.Read(ref _certificateContext) is not null;

    public void Disable() => Interlocked.Exchange(ref _certificateContext, null);

    public bool TryEnable(X509Certificate2? certificate, X509Certificate2Collection? intermediates = null)
    {
        if (IsRunning) return true;
        if (certificate is null) return false;
        try
        {
            // Build the certificate chain once, before the first accepted TLS connection.
            var context = SslStreamCertificateContext.Create(certificate, intermediates);
            Interlocked.CompareExchange(ref _certificateContext, context, null);
            return true;
        }
        catch (Exception exception)
        {
            _log($"host-ui diagnostic code={UnavailableCode} detail={exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    /// <summary>Serve an accepted socket from the shared listener, preserving HTTP bytes for its parser.</summary>
    public async Task ClassifyAndServeAsync(
        TcpClient client,
        NetworkAdmissionLimiter admission,
        Func<TcpClient, CancellationToken, Task> serveHttp,
        Func<TcpClient, Stream, CancellationToken, Task> serveTls,
        CancellationToken cancellationToken)
    {
        using var disposeClient = client;
        try { client.NoDelay = true; } catch (SocketException) { } catch (ObjectDisposedException) { }
        try
        {
            // The peer may connect and send nothing. Bound the peek just as the TLS handshake is bounded;
            // SocketFlags.Peek does not consume the byte, so HTTP and SslStream both see their full preface.
            var firstByte = new byte[1];
            using var firstByteDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            firstByteDeadline.CancelAfter(_handshakeTimeout);
            var count = await client.Client.ReceiveAsync(
                firstByte.AsMemory(), SocketFlags.Peek, firstByteDeadline.Token).ConfigureAwait(false);
            if (count == 0) return;
            if (firstByte[0] != 0x16)
            {
                await serveHttp(client, cancellationToken).ConfigureAwait(false);
                return;
            }

            var context = Volatile.Read(ref _certificateContext);
            if (context is null) return;
            await using var tls = new SslStream(client.GetStream(), leaveInnerStreamOpen: false);
            using var handshakeDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            handshakeDeadline.CancelAfter(_handshakeTimeout);
            await tls.AuthenticateAsServerAsync(
                new SslServerAuthenticationOptions
                {
                    ServerCertificateContext = context,
                    ClientCertificateRequired = false,
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                    CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                },
                handshakeDeadline.Token).ConfigureAwait(false);

            // The stream handler acquires a fresh HTTP lease and later a WebSocket lease. Keep the accepted
            // connection's lease through the handshake, then release it before that fresh acquisition.
            admission.TakeAttachedHttp(client)?.Dispose();
            await serveTls(client, tls, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is AuthenticationException or IOException or SocketException
                or ObjectDisposedException or OperationCanceledException or InvalidOperationException
                or NotSupportedException)
        {
            // A stalled client, malformed ClientHello or disconnected peer consumes only its own socket.
        }
        finally
        {
            admission.TakeAttachedHttp(client)?.Dispose();
        }
    }
}
