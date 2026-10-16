using System.Net;
using System.Security.Cryptography.X509Certificates;

namespace CouchCoop.Mod.Server;

/// <summary>Host readiness only: a browser must independently trust the exported public authority.</summary>
public sealed record DirectIpHttpsState(
    int Port = 0,
    IReadOnlyList<string>? Addresses = null,
    string? CaFingerprint = null,
    DateTimeOffset? CaExpiresAt = null,
    DateTimeOffset? LeafExpiresAt = null,
    bool CanExport = false,
    string? ErrorCode = null,
    bool Preparing = false)
{
    public bool Covers(IPAddress address) => Port > 0 && Addresses?.Contains(address.ToString()) == true;
}

/// <summary>Owned leaf credentials and a PUBLIC root. Never contains an authority signing key.</summary>
public sealed class DirectIpCertificateMaterial(
    X509Certificate2 certificate, X509Certificate2 publicRoot, IReadOnlyList<IPAddress> addresses) : IDisposable
{
    public X509Certificate2 Certificate { get; } = certificate;
    public X509Certificate2 PublicRoot { get; } = publicRoot;
    public IReadOnlyList<IPAddress> Addresses { get; } = addresses;
    public string CaFingerprint => PublicRoot.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256);
    public DateTimeOffset CaExpiresAt => new(PublicRoot.NotAfter.ToUniversalTime());
    public DateTimeOffset LeafExpiresAt => new(Certificate.NotAfter.ToUniversalTime());
    public void Dispose() { Certificate.Dispose(); PublicRoot.Dispose(); }
}

public interface IDirectIpCertificateAuthority : IDisposable
{
    /// <summary>Returns caller-owned material. Replacement is permitted only after native confirmation.</summary>
    Task<DirectIpCertificateMaterial> PrepareAsync(IReadOnlyCollection<IPAddress> addresses,
        bool replaceAuthority = false, CancellationToken cancellationToken = default);
    /// <summary>Writes only the public DER certificate into a dedicated export directory.</summary>
    string ExportPublicRoot();
}

public interface IDirectIpHttpsSetupActions
{
    Task PrepareAsync();
    Task ReplaceAuthorityAsync();
    string ExportPublicRoot();
}

/// <summary>Native-only setup actions, bound by the host service; no browser route exposes these.</summary>
public static class DirectIpHttpsSetup
{
    public static IDirectIpHttpsSetupActions? Current { get; internal set; }
}
