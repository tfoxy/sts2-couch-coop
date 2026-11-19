using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server.LanRtc;

/// <summary>Persistent host identity. Expiry alone never replaces a fingerprint already shared with browsers.</summary>
public sealed class LanRtcIdentity : IDisposable
{
    private const string CertificateFile = "cert.der";
    private const string KeyFile = "key.pkcs8.der";
    public X509Certificate2 Certificate { get; }
    public string Fingerprint { get; }
    public LanRtcIceCredentials IceCredentials { get; }

    private LanRtcIdentity(X509Certificate2 certificate)
    {
        Certificate = certificate;
        var fingerprint = SHA256.HashData(certificate.RawData);
        Fingerprint = EncodeFingerprint(fingerprint);
        IceCredentials = DeriveIceCredentials(fingerprint);
    }

    public static string DefaultStorageRoot()
        => Path.Combine(Path.GetDirectoryName(DirectIpCertificates.DefaultStorageRoot())!, "lan-rtc-identity");

    public static LanRtcIdentity LoadOrCreate(string? storageRoot = null, Action<string>? log = null)
    {
        var storage = new DirectIpCertificateStorage(storageRoot ?? DefaultStorageRoot());
        var report = log ?? CouchCoopLog.Warn;
        return storage.Locked(() =>
        {
            if (storage.Exists(CertificateFile) && storage.Exists(KeyFile))
            {
                byte[]? keyBytes = null;
                try
                {
                    var certificateBytes = storage.Read(CertificateFile);
                    keyBytes = storage.Read(KeyFile);
                    using var certificate = X509CertificateLoader.LoadCertificate(certificateBytes);
                    using var key = ECDsa.Create();
                    key.ImportPkcs8PrivateKey(keyBytes, out var consumed);
                    if (consumed != keyBytes.Length || key.KeySize != 256 ||
                        key.ExportParameters(false).Curve.Oid.Value != ECCurve.NamedCurves.nistP256.Oid.Value)
                        throw new CryptographicException("Expected an ECDSA P-256 private key.");
                    return new LanRtcIdentity(certificate.CopyWithPrivateKey(key));
                }
                catch (Exception exception) when (exception is CryptographicException or ArgumentException ||
                    // Storage rejects empty or oversized DER before the parser sees it.
                    exception is IOException { Message: "Invalid certificate state size." })
                {
                    report($"LAN RTC identity regenerated: stored certificate or key is invalid ({exception.Message}).");
                }
                finally { if (keyBytes is not null) CryptographicOperations.ZeroMemory(keyBytes); }
            }
            else report("LAN RTC identity generated: certificate or private key file is missing.");

            using var newKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var request = new CertificateRequest("CN=CouchCoop LAN RTC", newKey, HashAlgorithmName.SHA256);
            var now = DateTimeOffset.UtcNow;
            using var generated = request.CreateSelfSigned(now, now.AddYears(10));
            var privateKey = newKey.ExportPkcs8PrivateKey();
            try
            {
                // Readers hold the same lock; an interrupted pair is rejected on the next load.
                storage.Write(KeyFile, privateKey);
                storage.Write(CertificateFile, generated.RawData);
            }
            finally { CryptographicOperations.ZeroMemory(privateKey); }
            using var publicCertificate = X509CertificateLoader.LoadCertificate(generated.RawData);
            return new LanRtcIdentity(publicCertificate.CopyWithPrivateKey(newKey));
        });
    }

    public static string EncodeFingerprint(ReadOnlySpan<byte> fingerprint)
    {
        if (fingerprint.Length != 32) throw new ArgumentException("Expected a SHA-256 fingerprint.", nameof(fingerprint));
        return Convert.ToBase64String(fingerprint).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static LanRtcIceCredentials DeriveIceCredentials(ReadOnlySpan<byte> fingerprint)
    {
        if (fingerprint.Length != 32) throw new ArgumentException("Expected a SHA-256 fingerprint.", nameof(fingerprint));
        ReadOnlySpan<byte> label = "couch-tunnel/1 ice"u8;
        Span<byte> input = stackalloc byte[label.Length + 32];
        label.CopyTo(input);
        fingerprint.CopyTo(input[label.Length..]);
        var hash = SHA256.HashData(input);
        return new LanRtcIceCredentials(Convert.ToBase64String(hash.AsSpan(0, 6)), Convert.ToBase64String(hash.AsSpan(6, 18)));
    }

    public void Dispose() => Certificate.Dispose();
}

public sealed record LanRtcIceCredentials(string Ufrag, string Password);
