using System.Net;
using System.Security.Cryptography;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

public sealed partial class CouchCoopHostUiServices
{
    private DirectIpHttpsHostService? _directIpService;
    private DirectIpCertificates? _directIpAuthority;
    private DirectIpSeatPreparation? _directIpSeatIdentity;

    private static IReadOnlyCollection<IPAddress> DirectIpAddresses() => LanAddressRanking.GatherFromOs()
        .Where(LanAddressRanking.IsEligible).Select(candidate => candidate.Address)
        .Where(SecureOriginHost.IsSecureOriginEligible).Distinct().ToArray();

    private void InitializeDirectIpHttps()
    {
        var server = _browserServer!;
        if (server.IsHeadlessClient)
        {
            server.DirectIpRefreshOnEveryHandshake = true;
            server.EnableDirectIpSeatAsync = async (request, token) =>
            {
                var address = IPAddress.Parse(request.Address);
                if (!DirectIpAddresses().Contains(address)) return null;
                using var material = await Task.Run(() => DirectIpCertificates.LoadSeatMaterial(
                    request.BundleId, address, request.CaFingerprint), token).ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                if (!server.TryStartDirectIpListener(material)) return null;
                Volatile.Write(ref _directIpSeatIdentity, request);
                return server.DirectIpSecurePort;
            };
            server.DirectIpCertificateRefresh = RefreshSeatCertificateAsync;
            return;
        }

        _directIpService = new DirectIpHttpsHostService(
            () => _directIpAuthority ??= new DirectIpCertificates(), DirectIpAddresses,
            material =>
            {
                // Publish a leaf-only generation on every issue/renewal, including OS address changes.
                _directIpAuthority!.SaveSeatMaterial(material);
                return server.TryStartDirectIpListener(material);
            }, server.DisableDirectIpListener, () => server.DirectIpSecurePort, _log);
        DirectIpHttpsSetup.Current = _directIpService;
        server.DirectIpCertificateRefresh = _directIpService.RefreshForConnectionAsync;
        server.PrepareDirectIpSeatAsync = async (seatPort, address, token) =>
        {
            using var material = await _directIpService.RefreshForConnectionAsync(address, token).ConfigureAwait(false);
            if (material is null || _directIpAuthority is null) return null;
            var bundle = _directIpAuthority.SaveSeatMaterial(material);
            var request = new DirectIpSeatPreparation(bundle, address.ToString(), material.CaFingerprint, server.BaseUri!.Port);
            return await HeadlessClientManager.RequestDirectIpOriginAsync(seatPort, request, token).ConfigureAwait(false);
        };
        server.RefreshDirectIpSeatMaterialAsync = async (request, token) =>
        {
            // A loopback request can renew only this already-enabled identity; it cannot initialize a CA.
            if (request.HostPort != server.BaseUri?.Port || request.CaFingerprint != _directIpService.State.CaFingerprint
                || request.BundleId != request.CaFingerprint || !IPAddress.TryParse(request.Address, out var address)) return false;
            using var material = await _directIpService.RefreshForConnectionAsync(address, token).ConfigureAwait(false);
            return material is not null && material.CaFingerprint == request.CaFingerprint
                && _directIpAuthority?.SaveSeatMaterial(material) == request.BundleId;
        };
    }

    private async Task<DirectIpCertificateMaterial?> RefreshSeatCertificateAsync(IPAddress address, CancellationToken token)
    {
        var request = Volatile.Read(ref _directIpSeatIdentity);
        if (request is null || request.Address != address.ToString() || !DirectIpAddresses().Contains(address)) return null;
        DirectIpCertificateMaterial? material = null;
        try
        {
            try
            {
                material = await Task.Run(() => DirectIpCertificates.LoadSeatMaterial(
                    request.BundleId, address, request.CaFingerprint), token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or CryptographicException or UnauthorizedAccessException)
            {
                // An expired leaf may be renewed by the host; a replaced root is rejected by that same host.
            }
            if (material is null || material.LeafExpiresAt <= DateTimeOffset.UtcNow.AddDays(30))
            {
                material?.Dispose();
                material = null;
                if (!await HeadlessClientManager.RequestDirectIpRefreshAsync(request.HostPort, request, token).ConfigureAwait(false))
                    return null;
                material = await Task.Run(() => DirectIpCertificates.LoadSeatMaterial(
                    request.BundleId, address, request.CaFingerprint), token).ConfigureAwait(false);
            }
            if (!ReferenceEquals(request, Volatile.Read(ref _directIpSeatIdentity)))
            {
                material.Dispose();
                return null;
            }
            return material;
        }
        catch { material?.Dispose(); throw; }
    }
}
