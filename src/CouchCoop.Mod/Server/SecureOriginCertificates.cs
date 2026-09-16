using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>Why the secure origin is or is not on offer, as semantic text the QR dialog resolves at display time.</summary>
public enum SecureOriginState
{
    /// <summary>The kill-switch turned the whole feature off.</summary>
    Disabled,

    /// <summary>Acquisition has not finished yet. The dialog shows the checkbox disabled and says so.</summary>
    Pending,

    /// <summary>A usable certificate is loaded and the secure listener is (or can be) up.</summary>
    Ready,

    /// <summary>No certificate: offline, provider down, revoked, expired, or malformed.</summary>
    Unavailable,
}

/// <summary>A snapshot of the secure origin's readiness. Immutable, so it can be read from any thread.</summary>
/// <param name="Text">The semantic player-facing explanation; the UI resolves it after choosing its locale.</param>
public sealed record SecureOriginStatus(SecureOriginState State, CouchCoopText Text, string? Domain)
{
    public bool IsReady => State == SecureOriginState.Ready;
    /// <summary>Resolved compatibility view for diagnostics; UI state must retain <see cref="Text"/>.</summary>
    public string Reason => Text.Resolve();

    public static SecureOriginStatus Disabled(CouchCoopText reason) => new(SecureOriginState.Disabled, reason, null);
}

/// <summary>
/// Best-effort acquisition, caching and materialisation of the opt-in secure origin's certificate.
/// </summary>
/// <remarks>
/// <para>
/// SAFETY. Modelled on <see cref="CouchCoop.Mod.HostUi.MdnsResponder"/>'s discipline, and for the same
/// reason: this is a convenience feature sitting next to the thing that actually serves the game. It
/// NEVER blocks startup (acquisition runs detached; <see cref="Status"/> reports
/// <see cref="SecureOriginState.Pending"/> until it lands), it never throws out of
/// <see cref="StartAsync"/>, and every failure — no internet, DNS poisoned, provider 404, key/leaf
/// mismatch, revoked, expired, unreadable cache — resolves to "no certificate", which makes the secure
/// listener simply not start and the dialog's checkbox disabled with <see cref="SecureOriginStatus.Text"/>.
/// The plain-HTTP LAN listener is untouched by all of it and remains the default QR, so a host with no
/// WAN at all behaves exactly as it did before this feature existed.
/// </para>
/// <para>
/// CACHING. The bundle is written to a local cache directory so a later session starts secure without a
/// round-trip, and — more importantly — so a host that is offline TODAY can still serve the origin it
/// fetched yesterday. The cache is re-validated on load (dates + key match), so an expired or corrupt
/// entry degrades to Unavailable rather than to a listener that every phone refuses.
/// </para>
/// <para>
/// WHERE THE CACHE LIVES. Under the same per-user application-data root the other two runtime caches in
/// this directory use (see <c>SpirectlAssetBinaryCache</c> / <c>AstcTranscodeCache</c>), NOT under the
/// repo's ignored <c>.sts2/</c>: a shipped mod runs out of the game's mods directory where no repo, and
/// therefore no <c>.sts2/</c>, exists. <c>COUCHCOOP_SECURE_CERT_CACHE</c> overrides it. Nothing is ever
/// written inside the repository, so no fetched key material can be committed by accident.
/// </para>
/// <para>
/// The private key this caches is PUBLISHED BY THE PROVIDER — it is not a secret and protecting it is
/// not a goal. See <see cref="ISecureOriginCertificateProvider"/> for the full security posture.
/// </para>
/// </remarks>
public sealed class SecureOriginCertificates : IDisposable
{
    /// <summary>Kill-switch. Set to <c>0</c>/<c>false</c>/<c>off</c>/<c>no</c> to never fetch and never listen.</summary>
    public const string EnabledEnvironmentVariable = "COUCHCOOP_SECURE_ORIGIN";

    /// <summary>Overrides the on-disk cache directory.</summary>
    public const string CacheRootEnvironmentVariable = "COUCHCOOP_SECURE_CERT_CACHE";

    /// <summary>Logged once when the secure origin cannot run; the host is unaffected.</summary>
    public const string UnavailableCode = "secure-origin-unavailable";

    /// <summary>Logged once when the kill-switch turned the secure origin off.</summary>
    public const string DisabledCode = "secure-origin-disabled";

    private const string CertificateFileName = "server.pem";
    private const string PrivateKeyFileName = "server.key";
    private const string IntermediatesFileName = "intermediates.pem";

    // Short: a host whose WAN is down must reach "no certificate" fast enough that nobody notices, and the
    // whole exchange is three small static files from a CDN when it does work.
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);

    private readonly ISecureOriginCertificateProvider _provider;
    private readonly string? _cacheRoot;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private SecureOriginStatus _status;
    private X509Certificate2? _certificate;
    private X509Certificate2Collection _intermediates = [];
    private bool _disposed;

    public SecureOriginCertificates(
        ISecureOriginCertificateProvider? provider = null,
        string? cacheRoot = null,
        Action<string>? log = null)
    {
        _provider = provider ?? new LocalIpCoCertificateProvider();
        _cacheRoot = cacheRoot ?? DefaultCacheRoot();
        _log = log ?? CouchCoopLog.Stderr;
        _status = Enabled
            ? new SecureOriginStatus(SecureOriginState.Pending, CouchCoopSecureText.Checking, _provider.Domain)
            : SecureOriginStatus.Disabled(CouchCoopSecureText.Disabled(EnabledEnvironmentVariable));
    }

    /// <summary>Whether the kill-switch allows the feature at all.</summary>
    public static bool Enabled => ReadFlag(EnabledEnvironmentVariable);

    /// <summary>The DNS suffix the active provider covers, e.g. <c>my.local-ip.co</c>.</summary>
    public string Domain => _provider.Domain;

    /// <summary>Current readiness. Safe to read from any thread, including before <see cref="StartAsync"/>.</summary>
    public SecureOriginStatus Status
    {
        get
        {
            lock (_gate)
            {
                return _status;
            }
        }
    }

    /// <summary>
    /// The materialised server certificate, or <see langword="null"/> when none is loaded. The instance is
    /// owned by this object; callers must not dispose it.
    /// </summary>
    public X509Certificate2? Certificate
    {
        get
        {
            lock (_gate)
            {
                return _certificate;
            }
        }
    }

    /// <summary>
    /// Intermediates that issue <see cref="Certificate"/>, for the TLS handshake to send alongside it.
    /// Empty when none could be proven — a leaf-only handshake still works in most browsers.
    /// </summary>
    public X509Certificate2Collection Intermediates
    {
        get
        {
            lock (_gate)
            {
                return _intermediates;
            }
        }
    }

    /// <summary>
    /// Load from cache, and — when the cache misses or is stale — fetch. Returns once a decision has been
    /// reached, so a caller that WANTS to gate its listener on the answer can await it; nothing on the
    /// startup path does, which is why <see cref="StartAsync"/> is safe to fire and forget.
    /// </summary>
    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (!Enabled)
        {
            _log($"host-ui diagnostic code={DisabledCode} detail={EnabledEnvironmentVariable}");
            return;
        }

        try
        {
            if (TryLoadFromCache() is var (cachedCertificate, cachedIntermediates) && cachedCertificate is not null)
            {
                Publish(cachedCertificate, cachedIntermediates, "cache");
                return;
            }

            using var http = new HttpClient { Timeout = FetchTimeout };
            var bundle = await _provider.FetchAsync(http, cancellationToken).ConfigureAwait(false);
            if (bundle is null)
            {
                Fail(CouchCoopSecureText.ProviderUnavailable);
                return;
            }

            if (TryMaterialise(bundle, out var certificate, out var intermediates, out var failure))
            {
                SaveToCache(bundle);
                Publish(certificate!, intermediates, "fetch");
                return;
            }

            Fail(failure ?? CouchCoopSecureText.SetupFailed);
        }
        catch (OperationCanceledException)
        {
            Fail(CouchCoopSecureText.Cancelled);
        }
        catch (Exception exception)
        {
            // Deliberately catch-all: an unexpected crypto/IO/platform failure here must cost the player a
            // disabled checkbox, never the host UI or the browser server. Same rule as MdnsResponder.
            Fail(CouchCoopSecureText.SetupException(exception.GetType().Name));
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _certificate?.Dispose();
            _certificate = null;
        }
    }

    // ---- materialisation ------------------------------------------------------------------------------

    /// <summary>
    /// Turn PEM into a server-usable certificate, rejecting everything a phone would reject.
    /// </summary>
    /// <remarks>
    /// The PKCS#12 round-trip is not decoration. A certificate built by
    /// <see cref="X509Certificate2.CreateFromPem(ReadOnlySpan{char}, ReadOnlySpan{char})"/> carries an
    /// EPHEMERAL key, which <c>SslStream</c> on Windows refuses to use for server authentication
    /// ("ephemeral keys are not supported"). Exporting and re-loading gives the key a persistable form
    /// that works on every platform the mod ships to — this host is developed on Linux, where the naive
    /// version happens to work, so without this the feature would break only on players' machines.
    /// </remarks>
    internal static bool TryMaterialise(
        SecureCertificateBundle bundle,
        out X509Certificate2? certificate,
        out X509Certificate2Collection intermediates,
        out CouchCoopText? failureReason)
    {
        certificate = null;
        intermediates = [];
        failureReason = null;

        X509Certificate2? paired = null;
        try
        {
            paired = X509Certificate2.CreateFromPem(bundle.CertificatePem, bundle.PrivateKeyPem);
        }
        catch (Exception exception) when (exception is System.Security.Cryptography.CryptographicException or ArgumentException or FormatException)
        {
            failureReason = CouchCoopSecureText.CertificateKeyMismatch;
            return false;
        }

        try
        {
            var now = DateTimeOffset.UtcNow;
            if (now < paired.NotBefore.ToUniversalTime())
            {
                failureReason = CouchCoopSecureText.CertificateNotValidYet;
                return false;
            }

            if (now > paired.NotAfter.ToUniversalTime())
            {
                failureReason = CouchCoopSecureText.CertificateExpired;
                return false;
            }

            certificate = X509CertificateLoader.LoadPkcs12(
                paired.Export(X509ContentType.Pkcs12),
                password: null,
                keyStorageFlags: X509KeyStorageFlags.Exportable);

            if (!string.IsNullOrWhiteSpace(bundle.IntermediatesPem))
            {
                try
                {
                    intermediates.ImportFromPem(bundle.IntermediatesPem);
                }
                catch (System.Security.Cryptography.CryptographicException)
                {
                    // A leaf that works beats refusing to serve over an unreadable intermediate.
                    intermediates = [];
                }
            }

            return true;
        }
        catch (Exception exception) when (exception is System.Security.Cryptography.CryptographicException or PlatformNotSupportedException)
        {
            failureReason = CouchCoopSecureText.CertificateLoadFailed;
            return false;
        }
        finally
        {
            paired.Dispose();
        }
    }

    // ---- cache ----------------------------------------------------------------------------------------

    private (X509Certificate2? Certificate, X509Certificate2Collection Intermediates) TryLoadFromCache()
    {
        if (_cacheRoot is null)
        {
            return (null, []);
        }

        try
        {
            var certificatePath = Path.Combine(_cacheRoot, CertificateFileName);
            var keyPath = Path.Combine(_cacheRoot, PrivateKeyFileName);
            if (!File.Exists(certificatePath) || !File.Exists(keyPath))
            {
                return (null, []);
            }

            var intermediatesPath = Path.Combine(_cacheRoot, IntermediatesFileName);
            var bundle = new SecureCertificateBundle(
                File.ReadAllText(certificatePath),
                File.ReadAllText(keyPath),
                File.Exists(intermediatesPath) ? File.ReadAllText(intermediatesPath) : null);

            // Re-validated, not trusted: a cached bundle that has since expired must miss so the fetch path
            // can replace it, which is the whole reason this returns null instead of publishing.
            return TryMaterialise(bundle, out var certificate, out var intermediates, out _)
                ? (certificate, intermediates)
                : (null, []);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            return (null, []);
        }
    }

    private void SaveToCache(SecureCertificateBundle bundle)
    {
        if (_cacheRoot is null)
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(_cacheRoot);
            File.WriteAllText(Path.Combine(_cacheRoot, CertificateFileName), bundle.CertificatePem);
            File.WriteAllText(Path.Combine(_cacheRoot, PrivateKeyFileName), bundle.PrivateKeyPem);

            var intermediatesPath = Path.Combine(_cacheRoot, IntermediatesFileName);
            if (string.IsNullOrWhiteSpace(bundle.IntermediatesPem))
            {
                File.Delete(intermediatesPath);
            }
            else
            {
                File.WriteAllText(intermediatesPath, bundle.IntermediatesPem);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            // A cache we cannot write is a slower next start, nothing more.
        }
    }

    /// <summary>
    /// The default cache directory, or <see langword="null"/> when the platform gives us nowhere to write
    /// (in which case the feature still works, it just re-fetches every start).
    /// </summary>
    internal static string? DefaultCacheRoot()
    {
        var configured = Environment.GetEnvironmentVariable(CacheRootEnvironmentVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim();
        }

        try
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return string.IsNullOrWhiteSpace(local)
                ? Path.Combine(Path.GetTempPath(), "SlayTheSpire2", "couch-coop", "secure-cert")
                : Path.Combine(local, "SlayTheSpire2", "couch-coop", "secure-cert");
        }
        catch (Exception exception) when (exception is ArgumentException or PlatformNotSupportedException)
        {
            return null;
        }
    }

    // ---- state ----------------------------------------------------------------------------------------

    private void Publish(X509Certificate2 certificate, X509Certificate2Collection intermediates, string source)
    {
        lock (_gate)
        {
            if (_disposed)
            {
                certificate.Dispose();
                return;
            }

            _certificate?.Dispose();
            _certificate = certificate;
            _intermediates = intermediates;
            _status = new SecureOriginStatus(SecureOriginState.Ready, CouchCoopSecureText.Ready, _provider.Domain);
        }

        _log($"secure-origin ready provider={_provider.Id} domain={_provider.Domain} source={source} "
            + $"expires={certificate.NotAfter.ToUniversalTime():yyyy-MM-dd}");
    }

    private void Fail(CouchCoopText reason)
    {
        lock (_gate)
        {
            _status = new SecureOriginStatus(SecureOriginState.Unavailable, reason, _provider.Domain);
        }

        _log($"host-ui diagnostic code={UnavailableCode} provider={_provider.Id} detail={reason.ResolveForLanguage(CouchCoopLocalization.EnglishLanguage)}");
    }

    // Same polarity as the other valves in this codebase: absent means ON, and only an explicit
    // 0/false/off/no turns it off.
    private static bool ReadFlag(string name)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        return raw.Trim().ToLowerInvariant() switch
        {
            "0" or "false" or "off" or "no" => false,
            _ => true,
        };
    }
}
