using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The OPT-IN second listener: the same browser server, over TLS, on its own port.
/// </summary>
/// <remarks>
/// <para>
/// A raw <see cref="TcpListener"/> wrapped in <see cref="SslStream"/>, deliberately — the project rule is
/// that the hosted browser server uses raw sockets, and the only difference here is one
/// <c>AuthenticateAsServer</c> call before the accepted stream is handed to the very same request
/// handler. Nothing about routing, WebSocket upgrade or the wire format changes: everything downstream
/// already takes a <see cref="Stream"/>.
/// </para>
/// <para>
/// WHY A SECOND PORT RATHER THAN UPGRADING THE FIRST. The plain-HTTP LAN URL must keep working with no
/// internet at all — LAN-only play is a hard requirement, and it is the DEFAULT QR. So the HTTP listener
/// is untouched and always on, and this one is pure addition: if it never starts, nothing else notices.
/// </para>
/// <para>
/// PORT DISCIPLINE. It port-walks upward exactly like the HTTP listener, and callers must advertise
/// <see cref="Port"/> — the port it actually GOT — never the one it preferred. A QR carrying the port we
/// wanted rather than the one we bound is a code that scans and then fails to connect, which is the same
/// trap <c>QrHostOptions.Build</c> documents for the HTTP port.
/// </para>
/// <para>
/// SAFETY. Best-effort throughout, in the style of <see cref="CouchCoop.Mod.HostUi.MdnsResponder"/>: no
/// certificate means <see cref="TryStart"/> returns <see langword="false"/> and the host is exactly as it
/// was; a handshake that fails (a phone that refuses a revoked certificate, a port scanner, a plain-HTTP
/// request sent to the TLS port) closes that one socket and logs nothing louder than a diagnostic. The
/// accept loop never lets a single bad client take the loop down.
/// </para>
/// <para>
/// The certificate's private key is PUBLISHED — see <see cref="ISecureOriginCertificateProvider"/> for
/// the security posture this inherits. This transport is a secure CONTEXT, not a secure CHANNEL.
/// </para>
/// </remarks>
public sealed class SecureBrowserListener : IAsyncDisposable
{
    public static readonly TimeSpan HandshakeTimeout = TimeSpan.FromSeconds(15);
    /// <summary>
    /// How far above the plain-HTTP port the secure listener prefers to sit.
    /// </summary>
    /// <remarks>
    /// <c>+1</c> keeps the pair readable (13337 / 13338) and, critically, does not collide with the
    /// headless seat ports, which are the HTTP base plus a multiple of ten
    /// (<c>HeadlessClientManager.SlotToPort</c>: 13347, 13357, …). Each headless instance runs this same
    /// host code, so each gets its own secure port at its own base + 1.
    /// </remarks>
    public const int PreferredPortOffset = 1;

    /// <summary>Logged when the secure listener cannot bind; the HTTP listener is unaffected.</summary>
    public const string UnavailableCode = "secure-listener-unavailable";

    private readonly IPAddress _bindAddress;
    private readonly Func<TcpClient, Stream, CancellationToken, Task> _handle;
    private readonly Action<string> _log;
    private readonly NetworkAdmissionLimiter? _admission;
    private readonly TimeSpan _handshakeTimeout;
    private TcpListener? _listener;
    private SslStreamCertificateContext? _certificateContext;
    private CancellationTokenSource? _stop;
    private Task? _acceptLoop;

    public SecureBrowserListener(
        IPAddress bindAddress,
        Func<TcpClient, Stream, CancellationToken, Task> handle,
        Action<string>? log = null,
        NetworkAdmissionLimiter? admission = null,
        TimeSpan? handshakeTimeout = null)
    {
        _bindAddress = bindAddress ?? throw new ArgumentNullException(nameof(bindAddress));
        _handle = handle ?? throw new ArgumentNullException(nameof(handle));
        _log = log ?? (message => Console.Error.WriteLine(message));
        _admission = admission;
        _handshakeTimeout = handshakeTimeout ?? HandshakeTimeout;
    }

    /// <summary>The port actually bound, or <c>0</c> when the listener is not running.</summary>
    public int Port { get; private set; }

    public bool IsRunning => _listener is not null && Port > 0;

    /// <summary>
    /// Bind and start serving, port-walking upward from <paramref name="preferredPort"/>. Returns
    /// <see langword="false"/> — never throws — when there is no certificate or no port; the caller
    /// treats that as "the secure origin is simply not on offer".
    /// </summary>
    public bool TryStart(
        X509Certificate2? certificate,
        int preferredPort,
        X509Certificate2Collection? intermediates = null,
        CancellationToken cancellationToken = default)
    {
        if (IsRunning)
        {
            return true;
        }

        if (certificate is null)
        {
            return false;
        }

        try
        {
            // Built once, not per connection: SslStreamCertificateContext does the chain building (and, where
            // the platform supports it, OCSP stapling) up front, so the per-handshake cost is just the
            // handshake. Passing the intermediates here is what stops a phone with no cached intermediate
            // from rejecting an otherwise-valid leaf.
            _certificateContext = SslStreamCertificateContext.Create(certificate, intermediates);
        }
        catch (Exception exception)
        {
            _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail={exception.GetType().Name}: {exception.Message}");
            return false;
        }

        for (var port = Math.Max(preferredPort, 1); port <= ushort.MaxValue; port++)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return false;
            }

            var listener = new TcpListener(_bindAddress, port);
            try
            {
                listener.Start();
                _listener = listener;
                Port = port;
                _stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                _acceptLoop = AcceptLoopAsync(_stop.Token);
                return true;
            }
            catch (SocketException)
            {
                listener.Stop();
            }
            catch (Exception exception)
            {
                listener.Stop();
                _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail={exception.GetType().Name}: {exception.Message}");
                return false;
            }
        }

        _log($"[couch-coop] host-ui diagnostic code={UnavailableCode} detail=no-port-at-or-above-{preferredPort}");
        return false;
    }

    public async ValueTask DisposeAsync()
    {
        _stop?.Cancel();
        _listener?.Stop();

        if (_acceptLoop is not null)
        {
            try
            {
                await _acceptLoop.ConfigureAwait(false);
            }
            catch
            {
            }
        }

        _stop?.Dispose();
        _stop = null;
        _acceptLoop = null;
        _listener = null;
        Port = 0;
        _certificateContext = null;
    }

    private async Task AcceptLoopAsync(CancellationToken cancellationToken)
    {
        var listener = _listener ?? throw new InvalidOperationException("Secure listener has not started.");
        while (!cancellationToken.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await listener.AcceptTcpClientAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException)
            {
                // One refused accept must not end the loop.
                continue;
            }

            var lease = _admission?.TryAcquireHttp((client.Client.RemoteEndPoint as IPEndPoint)?.Address);
            if (_admission is not null && lease is null)
            {
                client.Dispose();
                continue;
            }
            try
            {
                _ = Task.Run(() => HandshakeAndServeAsync(client, lease, cancellationToken), CancellationToken.None);
            }
            catch
            {
                lease?.Dispose();
                client.Dispose();
                throw;
            }
        }
    }

    private async Task HandshakeAndServeAsync(
        TcpClient client,
        NetworkAdmissionLimiter.Lease? handshakeLease,
        CancellationToken cancellationToken)
    {
        using var disposeClient = client;
        using var disposeLease = handshakeLease;

        // Same reasoning as the HTTP path: mirror scene-delta frames are small single writes and Nagle
        // interacting with delayed-ACK stalls each one. Best-effort.
        try { client.NoDelay = true; } catch (SocketException) { } catch (ObjectDisposedException) { }

        SslStream? tls = null;
        try
        {
            tls = new SslStream(client.GetStream(), leaveInnerStreamOpen: false);
            using var handshakeDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            handshakeDeadline.CancelAfter(_handshakeTimeout);
            await tls.AuthenticateAsServerAsync(
                new SslServerAuthenticationOptions
                {
                    ServerCertificateContext = _certificateContext,
                    ClientCertificateRequired = false,
                    // TLS 1.2 is the floor rather than 1.3-only: the point of this origin is to be reachable
                    // from whatever handset walked into the room, and 1.2 costs nothing here given the
                    // channel is explicitly not confidential against a LAN attacker anyway.
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                    CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                },
                handshakeDeadline.Token).ConfigureAwait(false);

            // The request handler reacquires this same limiter with the actual peer address and transitions the
            // lease to the separate WebSocket ceiling after parsing the upgrade.
            handshakeLease?.Dispose();
            await _handle(client, tls, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is AuthenticationException or IOException or SocketException
                or ObjectDisposedException or OperationCanceledException or InvalidOperationException
                or NotSupportedException)
        {
            // Expected and uninteresting: a plain-HTTP request aimed at the TLS port, a phone that refused a
            // revoked certificate, a port scanner, a client that hung up mid-handshake. One socket dies.
        }
        finally
        {
            if (tls is not null)
            {
                await tls.DisposeAsync().ConfigureAwait(false);
            }
        }
    }
}
