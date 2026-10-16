using System.Formats.Asn1;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace CouchCoop.Mod.Server;

/// <summary>A private, persistent per-host authority. Creation and replacement require explicit host setup.</summary>
public sealed class DirectIpCertificates : IDirectIpCertificateAuthority
{
    public const string SeatMaterialRootEnvironmentVariable = "COUCHCOOP_DIRECT_IP_SEAT_MATERIAL_ROOT";

    public static string DefaultSeatMaterialRoot()
    {
        var configured = Environment.GetEnvironmentVariable(SeatMaterialRootEnvironmentVariable);
        return string.IsNullOrWhiteSpace(configured) ? Path.Combine(DefaultStorageRoot(), "seat-leaves") : configured.Trim();
    }

    public static string DefaultStorageRoot()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local)) throw new IOException("Persistent local application storage is unavailable.");
        return Path.Combine(local, "SlayTheSpire2", "couch-coop", "direct-ip-identity");
    }

    private const string IdentityFile = "identity.json";
    private const string ServerAuthenticationOid = "1.3.6.1.5.5.7.3.1";
    private readonly DirectIpCertificateStorage _storage;
    private readonly Func<DateTimeOffset> _clock;
    private volatile bool _disposed;

    // One atomic document keeps the signing identity and its current leaf consistent across crashes.
    private sealed record IdentityDocument(int Version, byte[] Authority, byte[] Leaf);
    private sealed record SeatDocument(int Version, byte[] PublicRoot, byte[] Leaf);

    public DirectIpCertificates(string? storageRoot = null, Func<DateTimeOffset>? clock = null)
    {
        _storage = new DirectIpCertificateStorage(storageRoot ?? DefaultStorageRoot());
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public Task<DirectIpCertificateMaterial> PrepareAsync(IReadOnlyCollection<IPAddress> addresses,
        bool replaceAuthority = false, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var requested = NormalizeAddresses(addresses);
        return Task.Run(() => _storage.Locked(() => Prepare(requested, replaceAuthority), cancellationToken), cancellationToken);
    }

    private DirectIpCertificateMaterial Prepare(IPAddress[] addresses, bool replaceAuthority)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var now = _clock();
        X509Certificate2? authority = null;
        X509Certificate2? leaf = null;
        try
        {
            if (!replaceAuthority && _storage.Exists(IdentityFile))
            {
                var document = ReadIdentity();
                authority = Import(document.Authority, authority: true);
                ValidateAuthority(authority, now, requirePrivateKey: true);
                leaf = Import(document.Leaf);
                // Corrupted or foreign material is never silently repaired. A correctly issued expired
                // leaf is renewable; an expired authority requires explicit trust replacement.
                ValidateLeaf(leaf, authority, now, allowExpired: true);
                // Once validity is capped by the CA, reissuing on every handshake cannot extend it.
                if ((leaf.NotAfter.ToUniversalTime() > now.AddDays(30).UtcDateTime ||
                     leaf.NotAfter.ToUniversalTime() == authority.NotAfter.ToUniversalTime()) &&
                    ReadAddresses(leaf).SequenceEqual(addresses))
                    return Material(leaf, authority);
                leaf.Dispose();
                leaf = null;
            }
            if (authority is null && !replaceAuthority && !_storage.IsEmpty())
                throw new CryptographicException("Stored identity is missing; explicit authority replacement is required.");
            authority ??= CreateAuthority(now);
            leaf = CreateLeaf(authority, addresses, now);
            ValidateLeaf(leaf, authority, now);
            var documentToSave = new IdentityDocument(1, authority.Export(X509ContentType.Pkcs12), leaf.Export(X509ContentType.Pkcs12));
            if (replaceAuthority) _storage.DeleteFiles("seat-leaves");
            WriteSecret(IdentityFile, documentToSave);
            return Material(leaf, authority);
        }
        finally { leaf?.Dispose(); authority?.Dispose(); }
    }

    public string ExportPublicRoot()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        return _storage.Locked(() =>
        {
            using var authority = Import(ReadIdentity().Authority, authority: true);
            ValidateAuthority(authority, _clock(), requirePrivateKey: true);
            var fingerprint = authority.GetCertHashString(HashAlgorithmName.SHA256);
            return _storage.Write(Path.Combine("exports", $"CouchCoop-{fingerprint}.cer"), authority.RawData);
        });
    }

    /// <summary>Persists only a leaf key and PUBLIC authority. Returns an opaque, bounded bundle identity.</summary>
    public string SaveSeatMaterial(DirectIpCertificateMaterial material)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (material.PublicRoot.HasPrivateKey) throw new CryptographicException("A public root must not contain its private key.");
        ValidateAuthority(material.PublicRoot, _clock(), requirePrivateKey: false);
        ValidateLeaf(material.Certificate, material.PublicRoot, _clock());
        var bundleId = material.CaFingerprint;
        _storage.Locked(() =>
        {
            // A caller may have captured this material before another process renewed the leaf or
            // replaced trust. Bind publication to the current generation under the identity lock.
            var current = ReadIdentity();
            using var currentAuthority = Import(current.Authority, authority: true);
            using var currentLeaf = Import(current.Leaf);
            ValidateAuthority(currentAuthority, _clock(), requirePrivateKey: true);
            ValidateLeaf(currentLeaf, currentAuthority, _clock());
            if (!string.Equals(currentAuthority.GetCertHashString(HashAlgorithmName.SHA256), bundleId, StringComparison.Ordinal) ||
                !currentLeaf.RawData.AsSpan().SequenceEqual(material.Certificate.RawData))
                throw new CryptographicException("Seat credentials no longer match the current host identity.");
            WriteSecret(Path.Combine("seat-leaves", bundleId + ".json"),
                new SeatDocument(1, material.PublicRoot.RawData, material.Certificate.Export(X509ContentType.Pkcs12)));
            return true;
        });
        return bundleId;
    }

    /// <summary>Reads only a seat bundle, never the host authority file and never creates an authority.</summary>
    public static DirectIpCertificateMaterial LoadSeatMaterial(string bundleId, IPAddress address, string caFingerprint,
        string? seatMaterialRoot = null, Func<DateTimeOffset>? clock = null)
    {
        var storage = new DirectIpCertificateStorage(seatMaterialRoot ?? DefaultSeatMaterialRoot());
        var now = (clock ?? (() => DateTimeOffset.UtcNow))();
        if (!IsFingerprint(bundleId) || !IsFingerprint(caFingerprint)) throw new ArgumentException("Invalid certificate identity.");
        return storage.Locked(() =>
        {
            var bytes = storage.Read(bundleId.ToUpperInvariant() + ".json");
            try
            {
                var document = JsonSerializer.Deserialize<SeatDocument>(bytes) ?? throw new CryptographicException("Invalid seat certificate state.");
                if (document.Version != 1) throw new CryptographicException("Unsupported seat certificate state.");
                using var root = X509CertificateLoader.LoadCertificate(document.PublicRoot);
                using var leaf = Import(document.Leaf);
                ValidateAuthority(root, now, requirePrivateKey: false);
                ValidateLeaf(leaf, root, now);
                if (!string.Equals(root.GetCertHashString(HashAlgorithmName.SHA256), caFingerprint, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(root.GetCertHashString(HashAlgorithmName.SHA256), bundleId, StringComparison.OrdinalIgnoreCase) ||
                    !leaf.MatchesHostname(address.ToString(), allowWildcards: false, allowCommonName: false))
                    throw new CryptographicException("Seat certificate identity does not match the request.");
                return Material(leaf, root);
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        });
    }

    private IdentityDocument ReadIdentity()
    {
        var bytes = _storage.Read(IdentityFile);
        try
        {
            var document = JsonSerializer.Deserialize<IdentityDocument>(bytes) ?? throw new CryptographicException("Invalid certificate identity.");
            if (document.Version != 1) throw new CryptographicException("Unsupported certificate identity.");
            return document;
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private void WriteSecret<T>(string relative, T document)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(document);
        try { _storage.Write(relative, bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static X509Certificate2 Import(byte[] pkcs12, bool authority = false)
    {
        if (pkcs12 is null || pkcs12.Length == 0) throw new CryptographicException("Certificate material is missing.");
        // Windows Schannel needs a non-ephemeral leaf key. Its temporary imported key is released on Dispose.
        var flags = X509KeyStorageFlags.Exportable | (authority ? X509KeyStorageFlags.EphemeralKeySet : X509KeyStorageFlags.DefaultKeySet);
        return X509CertificateLoader.LoadPkcs12(pkcs12, null, flags);
    }

    private static X509Certificate2 CreateAuthority(DateTimeOffset now)
    {
        using var key = RSA.Create(3072);
        var request = new CertificateRequest("CN=CouchCoop Local Authority " + Guid.NewGuid().ToString("N"), key,
            HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return request.CreateSelfSigned(now.AddMinutes(-5), now.AddYears(5));
    }

    private static X509Certificate2 CreateLeaf(X509Certificate2 authority, IPAddress[] addresses, DateTimeOffset now)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest("CN=CouchCoop Direct IP", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new(ServerAuthenticationOid) }, false));
        var san = new SubjectAlternativeNameBuilder();
        foreach (var address in addresses) san.AddIpAddress(address);
        request.CertificateExtensions.Add(san.Build());
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var expiry = now.AddDays(90);
        var rootExpiry = new DateTimeOffset(authority.NotAfter.ToUniversalTime());
        if (expiry > rootExpiry) expiry = rootExpiry;
        using var signed = request.Create(authority, now.AddMinutes(-5), expiry, RandomNumberGenerator.GetBytes(16));
        using var paired = signed.CopyWithPrivateKey(key);
        return Import(paired.Export(X509ContentType.Pkcs12));
    }

    private static void ValidateAuthority(X509Certificate2 root, DateTimeOffset now, bool requirePrivateKey)
    {
        var constraints = root.Extensions.OfType<X509BasicConstraintsExtension>().SingleOrDefault();
        var usage = root.Extensions.OfType<X509KeyUsageExtension>().SingleOrDefault();
        using var publicKey = root.GetRSAPublicKey();
        if (constraints is not { CertificateAuthority: true, HasPathLengthConstraint: true, PathLengthConstraint: 0 } ||
            usage?.KeyUsages != (X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign) ||
            publicKey is null || publicKey.KeySize < 3072 ||
            !root.SubjectName.RawData.AsSpan().SequenceEqual(root.IssuerName.RawData) ||
            root.SignatureAlgorithm.Value != "1.2.840.113549.1.1.11" ||
            now.UtcDateTime < root.NotBefore.ToUniversalTime() || now.UtcDateTime >= root.NotAfter.ToUniversalTime())
            throw new CryptographicException("The certificate authority is invalid or expired; explicit replacement is required.");
        ValidateRootSignature(root, publicKey);
        if (requirePrivateKey) ValidateKey(root);
        else if (root.HasPrivateKey) throw new CryptographicException("Expected a public authority certificate.");
    }

    private static void ValidateRootSignature(X509Certificate2 root, RSA key)
    {
        var reader = new AsnReader(root.RawData, AsnEncodingRules.DER);
        var sequence = reader.ReadSequence();
        var signed = sequence.ReadEncodedValue();
        var algorithm = sequence.ReadSequence();
        if (algorithm.ReadObjectIdentifier() != "1.2.840.113549.1.1.11")
            throw new CryptographicException("Invalid authority signature algorithm.");
        if (algorithm.HasData) algorithm.ReadNull();
        algorithm.ThrowIfNotEmpty();
        var signature = sequence.ReadBitString(out var unusedBits);
        sequence.ThrowIfNotEmpty();
        reader.ThrowIfNotEmpty();
        if (unusedBits != 0 || !key.VerifyData(signed.Span, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new CryptographicException("Invalid authority self-signature.");
    }

    private static void ValidateLeaf(X509Certificate2 leaf, X509Certificate2 root, DateTimeOffset now, bool allowExpired = false)
    {
        ValidateKey(leaf);
        using var publicKey = leaf.GetRSAPublicKey();
        var constraints = leaf.Extensions.OfType<X509BasicConstraintsExtension>().SingleOrDefault();
        var usage = leaf.Extensions.OfType<X509KeyUsageExtension>().SingleOrDefault();
        var eku = leaf.Extensions.OfType<X509EnhancedKeyUsageExtension>().SingleOrDefault();
        var addresses = ReadAddresses(leaf);
        if (publicKey is null || publicKey.KeySize < 2048 || constraints is not { CertificateAuthority: false } ||
            usage?.KeyUsages != (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment) ||
            eku?.EnhancedKeyUsages.Count != 1 || eku.EnhancedKeyUsages[0].Value != ServerAuthenticationOid ||
            leaf.SignatureAlgorithm.Value != "1.2.840.113549.1.1.11" || addresses.Length == 0 ||
            leaf.NotAfter.ToUniversalTime() > root.NotAfter.ToUniversalTime() ||
            now.UtcDateTime < leaf.NotBefore.ToUniversalTime() ||
            (!allowExpired && now.UtcDateTime >= leaf.NotAfter.ToUniversalTime()))
            throw new CryptographicException("Invalid direct-IP server certificate.");
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(root);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true;
        // An expired leaf may be renewed only after proving its original chain and validity period.
        chain.ChainPolicy.VerificationTime = allowExpired && now.UtcDateTime >= leaf.NotAfter.ToUniversalTime()
            ? leaf.NotAfter.ToUniversalTime().AddSeconds(-1) : now.UtcDateTime;
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid(ServerAuthenticationOid));
        if (!chain.Build(leaf) || chain.ChainElements.Count != 2 ||
            !chain.ChainElements[1].Certificate.RawData.AsSpan().SequenceEqual(root.RawData))
            throw new CryptographicException("Server certificate is not issued by this authority.");
    }

    private static void ValidateKey(X509Certificate2 certificate)
    {
        using var privateKey = certificate.GetRSAPrivateKey();
        using var publicKey = certificate.GetRSAPublicKey();
        var challenge = RandomNumberGenerator.GetBytes(32);
        if (privateKey is null || publicKey is null || !publicKey.VerifyData(challenge,
            privateKey.SignData(challenge, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1),
            HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new CryptographicException("Certificate private key is missing or mismatched.");
    }

    private static DirectIpCertificateMaterial Material(X509Certificate2 leaf, X509Certificate2 root)
        => new(Import(leaf.Export(X509ContentType.Pkcs12)), X509CertificateLoader.LoadCertificate(root.RawData), ReadAddresses(leaf));

    private static IPAddress[] ReadAddresses(X509Certificate2 certificate)
    {
        var san = certificate.Extensions.OfType<X509SubjectAlternativeNameExtension>().SingleOrDefault()
            ?? throw new CryptographicException("Server certificate has no IP subject alternative names.");
        if (san.EnumerateDnsNames().Any()) throw new CryptographicException("An IP certificate must not contain DNS names.");
        return NormalizeAddresses(san.EnumerateIPAddresses().ToArray());
    }

    private static IPAddress[] NormalizeAddresses(IReadOnlyCollection<IPAddress> addresses)
    {
        if (addresses.Count is < 1 or > 64 || addresses.Any(address => address is null ||
            address.AddressFamily != AddressFamily.InterNetwork || address.Equals(IPAddress.Any) ||
            address.Equals(IPAddress.Broadcast) || address.GetAddressBytes()[0] >= 224))
            throw new ArgumentException("At least one usable IPv4 address is required.", nameof(addresses));
        return addresses.Distinct().OrderBy(address => address.ToString(), StringComparer.Ordinal).ToArray();
    }

    private static bool IsFingerprint(string value) => value is { Length: 64 } && value.All(Uri.IsHexDigit);
    public void Dispose() => _disposed = true;
}
