using System.Net;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

/// <summary>Explicit native setup, network-change invalidation, and request-driven certificate renewal.</summary>
public sealed class DirectIpHttpsHostService : IDirectIpHttpsSetupActions, IAsyncDisposable
{
    private readonly Func<IDirectIpCertificateAuthority> _createAuthority;
    private readonly Func<IReadOnlyCollection<IPAddress>> _addresses;
    private readonly Func<DirectIpCertificateMaterial, bool> _install;
    private readonly Action _disable;
    private readonly Func<int> _port;
    private readonly Func<DateTimeOffset> _now;
    private readonly Action<string> _log;
    private readonly bool _observeNetwork;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _stop = new();
    private readonly object _networkGate = new();
    private Task _networkTask = Task.CompletedTask;
    private bool _networkDirty;
    private bool _networkRunning;
    private bool _subscribed;
    private volatile bool _enabled;
    private volatile bool _disposed;
    private IDirectIpCertificateAuthority? _authority;
    private DirectIpCertificateMaterial? _material;
    private IPAddress[] _knownAddresses = [];
    private DirectIpHttpsState _state = new();

    public DirectIpHttpsHostService(Func<IDirectIpCertificateAuthority> createAuthority,
        Func<IReadOnlyCollection<IPAddress>> addresses,
        Func<DirectIpCertificateMaterial, bool> install, Action disable, Func<int> port,
        Action<string>? log = null, Func<DateTimeOffset>? clock = null, bool observeNetwork = true)
    {
        _createAuthority = createAuthority;
        _addresses = addresses;
        _install = install;
        _disable = disable;
        _port = port;
        _log = log ?? CouchCoopLog.Stderr;
        _now = clock ?? (() => DateTimeOffset.UtcNow);
        _observeNetwork = observeNetwork;
    }

    public DirectIpHttpsState State
    {
        get
        {
            var state = Volatile.Read(ref _state);
            return state.Port > 0 && (state.LeafExpiresAt <= _now() || state.CaExpiresAt <= _now())
                ? state with { Port = 0, ErrorCode = "authority-expired" } : state;
        }
    }
    public Task PrepareAsync() => PrepareNativeAsync(replace: false);
    public Task ReplaceAuthorityAsync() => PrepareNativeAsync(replace: true);

    private async Task PrepareNativeAsync(bool replace)
    {
        if (_disposed) return;
        try
        {
            await _gate.WaitAsync(_stop.Token).ConfigureAwait(false);
            try
            {
                _enabled = true;
                if (_observeNetwork && !_subscribed)
                {
                    NetworkChange.NetworkAddressChanged += OnNetworkAddressChanged;
                    _subscribed = true;
                }
                Volatile.Write(ref _state, State with { Preparing = true, ErrorCode = null });
                await EnsureAsync(refreshAddresses: true, replace, _stop.Token).ConfigureAwait(false);
            }
            finally { _gate.Release(); }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }

    public string ExportPublicRoot()
    {
        _gate.Wait();
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!State.CanExport || _authority is null)
                throw new InvalidOperationException("Direct-IP certificate authority is not ready for export.");
            return _authority.ExportPublicRoot();
        }
        finally { _gate.Release(); }
    }

    /// <summary>Called only for an already enabled IP identity by the TLS selector.</summary>
    public async Task<DirectIpCertificateMaterial?> RefreshForConnectionAsync(IPAddress address, CancellationToken token)
    {
        if (!_enabled || _disposed) return null;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _stop.Token);
        await _gate.WaitAsync(linked.Token).ConfigureAwait(false);
        try
        {
            if (!_knownAddresses.Contains(address)) return null;
            await EnsureAsync(refreshAddresses: false, replace: false, linked.Token).ConfigureAwait(false);
            return _material is null || !State.Covers(address) ? null : Clone(_material);
        }
        finally { _gate.Release(); }
    }

    // An event schedules work; it never reads game state, and a burst has at most one queued refresh.
    private void OnNetworkAddressChanged(object? sender, EventArgs args) => NotifyNetworkChanged();
    internal Task NotifyNetworkChanged()
    {
        lock (_networkGate)
        {
            if (!_enabled || _disposed) return Task.CompletedTask;
            _networkDirty = true;
            if (!_networkRunning)
            {
                _networkRunning = true;
                _networkTask = Task.Run(RefreshNetworkAsync);
            }
            return _networkTask;
        }
    }

    private async Task RefreshNetworkAsync()
    {
        while (true)
        {
            lock (_networkGate)
            {
                if (!_networkDirty || _disposed) { _networkRunning = false; return; }
                _networkDirty = false;
            }
            try
            {
                await _gate.WaitAsync(_stop.Token).ConfigureAwait(false);
                try { await EnsureAsync(refreshAddresses: true, replace: false, _stop.Token).ConfigureAwait(false); }
                finally { _gate.Release(); }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                lock (_networkGate) _networkRunning = false;
                return;
            }
        }
    }

    private async Task EnsureAsync(bool refreshAddresses, bool replace, CancellationToken token)
    {
        try
        {
            if (_disposed) return;
            if (refreshAddresses)
                _knownAddresses = _addresses().Where(SecureOriginHost.IsSecureOriginEligible)
                    .Distinct().OrderBy(a => a.ToString(), StringComparer.Ordinal).ToArray();
            if (_knownAddresses.Length == 0)
            {
                Fail("address-ineligible");
                return;
            }

            if (!replace && _material is not null && _material.LeafExpiresAt > _now().AddDays(30)
                && _material.CaExpiresAt > _now()
                && _material.Addresses.OrderBy(a => a.ToString(), StringComparer.Ordinal).SequenceEqual(_knownAddresses))
            {
                Publish(_material);
                return;
            }

            // Keep a valid context available while renewing or adding addresses. Removed coverage or
            // explicit authority replacement must stop accepting the old identity immediately.
            if (replace || _material is null || _material.Addresses.Any(a => !_knownAddresses.Contains(a)))
                _disable();
            Volatile.Write(ref _state, State with { Port = 0, Preparing = true });
            _authority ??= _createAuthority();
            var material = await _authority.PrepareAsync(_knownAddresses, replace, token).ConfigureAwait(false);
            try
            {
                token.ThrowIfCancellationRequested();
                if (_disposed || !_install(material)) throw new InvalidOperationException("Direct-IP listener unavailable.");
                _material?.Dispose();
                _material = material;
                Publish(material);
            }
            catch { material.Dispose(); throw; }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            Fail("setup-failed");
            throw;
        }
        catch (Exception exception)
        {
            Fail(_material?.CaExpiresAt <= _now() ? "authority-expired" : "setup-failed");
            _log($"direct-ip-https setup failed: {exception.GetType().Name}");
        }
    }

    private void Publish(DirectIpCertificateMaterial material) => Volatile.Write(ref _state,
        new DirectIpHttpsState(_port(), material.Addresses.Select(a => a.ToString()).ToArray(),
            material.CaFingerprint, material.CaExpiresAt, material.LeafExpiresAt, CanExport: true));

    private void Fail(string code)
    {
        _disable();
        _material?.Dispose();
        _material = null;
        Volatile.Write(ref _state, State with { Port = 0, Addresses = [], Preparing = false, CanExport = false, ErrorCode = code });
    }

    internal static DirectIpCertificateMaterial Clone(DirectIpCertificateMaterial material)
    {
        var pfx = material.Certificate.Export(X509ContentType.Pkcs12);
        try
        {
            return new DirectIpCertificateMaterial(
                X509CertificateLoader.LoadPkcs12(pfx, null,
                    X509KeyStorageFlags.EphemeralKeySet | X509KeyStorageFlags.Exportable),
                X509CertificateLoader.LoadCertificate(material.PublicRoot.RawData), material.Addresses.ToArray());
        }
        finally { CryptographicOperations.ZeroMemory(pfx); }
    }

    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        _enabled = false;
        _stop.Cancel();
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_subscribed) NetworkChange.NetworkAddressChanged -= OnNetworkAddressChanged;
            _subscribed = false;
            Fail("unavailable");
            _authority?.Dispose();
            _authority = null;
        }
        finally { _gate.Release(); }
        Task pending;
        lock (_networkGate) pending = _networkTask;
        await pending.ConfigureAwait(false);
    }
}
