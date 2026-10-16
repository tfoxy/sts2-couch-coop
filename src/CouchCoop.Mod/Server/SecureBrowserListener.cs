using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
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
    private readonly object _certificateGate = new();
    private CertificateLease? _hostname;
    private CertificateLease? _directIp;
    private long _directIpVersion;

    /// <summary>Called only for an already enabled, covered IP after parsing a TLS ClientHello.</summary>
    public Func<IPAddress, CancellationToken, Task<DirectIpCertificateMaterial?>>? DirectIpCertificateRefresh { get; set; }
    public bool DirectIpRefreshOnEveryHandshake { get; set; }

    public SecureBrowserListener(Action<string>? log = null, TimeSpan? handshakeTimeout = null)
    {
        _log = log ?? CouchCoopLog.Stderr;
        _handshakeTimeout = handshakeTimeout ?? HandshakeTimeout;
    }

    public bool IsRunning { get { lock (_certificateGate) return _hostname is not null || _directIp is not null; } }
    public bool IsHostnameRunning { get { lock (_certificateGate) return _hostname is not null; } }
    public bool IsDirectIpRunning { get { lock (_certificateGate) return _directIp is not null; } }

    public void Disable()
    {
        lock (_certificateGate)
        {
            _hostname?.Release(); _hostname = null;
            _directIp?.Release(); _directIp = null; _directIpVersion++;
        }
    }

    public void DisableDirectIp()
    {
        lock (_certificateGate) { _directIp?.Release(); _directIp = null; _directIpVersion++; }
    }

    public bool TryEnable(X509Certificate2? certificate, X509Certificate2Collection? intermediates = null)
    {
        if (certificate is null) return false;
        try
        {
            lock (_certificateGate)
            {
                if (_hostname is not null) return true;
                _hostname = new CertificateLease(certificate, intermediates);
            }
            return true;
        }
        catch (Exception exception)
        {
            _log($"host-ui diagnostic code={UnavailableCode} detail={exception.GetType().Name}");
            return false;
        }
    }

    /// <summary>Clones caller-owned credentials; replacing them does not retire in-flight connections.</summary>
    public bool TryEnableDirectIp(DirectIpCertificateMaterial material) => TryEnableDirectIp(material, null);

    private bool TryEnableDirectIp(DirectIpCertificateMaterial material, long? expectedVersion)
    {
        try
        {
            if (!material.Certificate.HasPrivateKey || material.PublicRoot.HasPrivateKey
                || material.Addresses.Count == 0
                || material.LeafExpiresAt <= DateTimeOffset.UtcNow || material.CaExpiresAt <= DateTimeOffset.UtcNow
                || material.Certificate.NotBefore.ToUniversalTime() > DateTime.UtcNow
                || material.Addresses.Any(address => !material.Certificate.MatchesHostname(address.ToString(), false, false)))
                return false;
            var replacement = new CertificateLease(material.Certificate, new X509Certificate2Collection(material.PublicRoot));
            lock (_certificateGate)
            {
                if (expectedVersion.HasValue && expectedVersion.Value != _directIpVersion)
                { replacement.Release(); return true; }
                var previous = _directIp;
                _directIp = replacement;
                _directIpVersion++;
                previous?.Release();
            }
            return true;
        }
        catch (Exception exception)
        {
            _log($"host-ui diagnostic code={UnavailableCode} detail={exception.GetType().Name}");
            return false;
        }
    }

    private async ValueTask<CertificateLease> SelectAsync(string? serverName, IPAddress localAddress, CancellationToken token)
    {
        var isIp = string.IsNullOrEmpty(serverName) || IPAddress.TryParse(serverName, out _);
        if (isIp)
        {
            long version;
            bool needsRenewal;
            if (!string.IsNullOrEmpty(serverName) && (!IPAddress.TryParse(serverName, out var requested) || !requested.Equals(localAddress)))
                throw new AuthenticationException("TLS address does not match this listener endpoint.");
            lock (_certificateGate)
            {
                version = _directIpVersion;
                needsRenewal = _directIp is not null && _directIp.Certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow.AddDays(30);
                if (_directIp is null || !_directIp.Certificate.MatchesHostname(localAddress.ToString(), false, false))
                    throw new AuthenticationException("Direct-IP TLS is not prepared for this address.");
            }
            if ((needsRenewal || DirectIpRefreshOnEveryHandshake) && DirectIpCertificateRefresh is { } refresh)
            {
                using var material = await WaitForRefreshAsync(refresh(localAddress, token), token).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                if (material is null || !TryEnableDirectIp(material, version))
                    throw new AuthenticationException("Direct-IP TLS renewal is unavailable.");
            }
        }
        lock (_certificateGate)
        {
            var selected = isIp ? _directIp : _hostname;
            if (selected is null || !selected.Certificate.MatchesHostname(isIp ? localAddress.ToString() : serverName!, !isIp, false)
                || selected.Certificate.NotAfter.ToUniversalTime() <= DateTime.UtcNow)
                throw new AuthenticationException("TLS identity is unavailable.");
            selected.AddReference();
            return selected;
        }
    }

    private static async Task<DirectIpCertificateMaterial?> WaitForRefreshAsync(
        Task<DirectIpCertificateMaterial?> pending, CancellationToken token)
    {
        try { return await pending.WaitAsync(token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            // A native key-store wait may ignore cancellation. Release the socket now, and retain only
            // ownership cleanup for its eventual result; never publish after the handshake deadline.
            _ = pending.ContinueWith(completed =>
            {
                if (completed.IsCompletedSuccessfully) completed.Result?.Dispose();
                else _ = completed.Exception; // Observe a late failure without retaining the connection.
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            throw;
        }
    }

    private sealed class CertificateLease
    {
        private int _references = 1;
        private readonly X509Certificate2Collection _chain = [];
        public X509Certificate2 Certificate { get; }
        public SslStreamCertificateContext Context { get; }

        public CertificateLease(X509Certificate2 certificate, X509Certificate2Collection? chain)
        {
            var pfx = certificate.Export(X509ContentType.Pkcs12);
            // Schannel needs a native key container on Windows; disposal removes the temporary import.
            var storage = OperatingSystem.IsWindows() ? X509KeyStorageFlags.DefaultKeySet : X509KeyStorageFlags.EphemeralKeySet;
            try { Certificate = X509CertificateLoader.LoadPkcs12(pfx, null, storage | X509KeyStorageFlags.Exportable); }
            finally { CryptographicOperations.ZeroMemory(pfx); }
            try
            {
                if (chain is not null)
                    foreach (var item in chain) _chain.Add(X509CertificateLoader.LoadCertificate(item.RawData));
                Context = SslStreamCertificateContext.Create(Certificate, _chain, offline: true);
            }
            catch { Certificate.Dispose(); foreach (var item in _chain) item.Dispose(); throw; }
        }
        public void AddReference() => Interlocked.Increment(ref _references);
        public void Release()
        {
            if (Interlocked.Decrement(ref _references) != 0) return;
            Certificate.Dispose();
            foreach (var item in _chain) item.Dispose();
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
        CertificateLease? selected = null;
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

            if (!IsRunning) return;
            var localAddress = (client.Client.LocalEndPoint as IPEndPoint)?.Address ?? IPAddress.None;
            await using var tls = new SslStream(client.GetStream(), leaveInnerStreamOpen: false);
            using var handshakeDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            handshakeDeadline.CancelAfter(_handshakeTimeout);
            await tls.AuthenticateAsServerAsync(
                async (_, hello, _, token) =>
                {
                    selected = await SelectAsync(hello.ServerName, localAddress, token).ConfigureAwait(false);
                    return new SslServerAuthenticationOptions
                    {
                        ServerCertificateContext = selected.Context,
                        ClientCertificateRequired = false,
                        EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                        CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                    };
                }, null, handshakeDeadline.Token).ConfigureAwait(false);

            // The stream handler acquires a fresh HTTP lease and later a WebSocket lease. Keep the accepted
            // connection's lease through the handshake, then release it before that fresh acquisition.
            admission.TakeAttachedHttp(client)?.Dispose();
            await serveTls(client, tls, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (
            exception is AuthenticationException or IOException or SocketException
                or ObjectDisposedException or OperationCanceledException or InvalidOperationException
                or NotSupportedException or CryptographicException or UnauthorizedAccessException)
        {
            // A stalled client, malformed ClientHello or disconnected peer consumes only its own socket.
        }
        finally
        {
            selected?.Release();
            admission.TakeAttachedHttp(client)?.Dispose();
        }
    }
}
