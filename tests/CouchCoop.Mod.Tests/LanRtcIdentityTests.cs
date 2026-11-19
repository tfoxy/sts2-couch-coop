using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Server.LanRtc;

internal static class LanRtcIdentityTests
{
    public static void Run()
    {
        KnownAnswers();
        GenerateAndReload();
        foreach (var file in new[] { "cert.der", "key.pkcs8.der" })
        {
            Regenerate(file, missing: false);
            Regenerate(file, missing: true);
            Regenerate(file, missing: false, empty: true);
        }
        ConcurrentLoads();
        MismatchedKeyRegenerates();
        Console.WriteLine("LanRtcIdentityTests: 10 cases passed");
    }

    private static void KnownAnswers()
    {
        var fingerprint = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
        Expect(LanRtcIdentity.EncodeFingerprint(fingerprint) == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "fingerprint vector");
        Expect(LanRtcIdentity.EncodeFingerprint(Enumerable.Repeat((byte)255, 32).ToArray()) == new string('_', 42) + "8", "URL-safe alphabet and no padding");
        var ice = LanRtcIdentity.DeriveIceCredentials(fingerprint);
        Expect(ice.Ufrag == "LifiPYYP", "ICE ufrag vector");
        Expect(ice.Password == "+LPHUKvgAC73FqV/esyr2EUG", "ICE password vector uses standard base64");
    }

    private static void GenerateAndReload()
    {
        using var fixture = new Fixture();
        var logs = new List<string>();
        using var first = LanRtcIdentity.LoadOrCreate(fixture.Root, logs.Add);
        var certificateBytes = File.ReadAllBytes(Path.Combine(fixture.Root, "cert.der"));
        var keyBytes = File.ReadAllBytes(Path.Combine(fixture.Root, "key.pkcs8.der"));
        Expect(first.Certificate.HasPrivateKey, "identity has private key");
        using var key = first.Certificate.GetECDsaPrivateKey();
        Expect(key?.KeySize == 256 && key.ExportParameters(false).Curve.Oid.Value == ECCurve.NamedCurves.nistP256.Oid.Value, "P-256 key");
        var start = new DateTimeOffset(first.Certificate.NotBefore.ToUniversalTime());
        Expect(first.Certificate.NotAfter.ToUniversalTime() == start.AddYears(10).UtcDateTime, "ten-year validity");
        Expect(first.Fingerprint == LanRtcIdentity.EncodeFingerprint(SHA256.HashData(certificateBytes)), "fingerprint hashes certificate DER");
        using var second = LanRtcIdentity.LoadOrCreate(fixture.Root, logs.Add);
        Expect(first.Fingerprint == second.Fingerprint && first.IceCredentials == second.IceCredentials, "reload preserves identity and ICE");
        Expect(certificateBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(fixture.Root, "cert.der"))) &&
            keyBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(fixture.Root, "key.pkcs8.der"))), "reload does not rewrite files");
        Expect(logs.Count == 1 && logs[0].Contains("missing", StringComparison.Ordinal), "only creation logs a reason");
        Expect(Path.GetDirectoryName(LanRtcIdentity.DefaultStorageRoot()) == Path.GetDirectoryName(DirectIpCertificates.DefaultStorageRoot()) &&
            Path.GetFileName(LanRtcIdentity.DefaultStorageRoot()) == "lan-rtc-identity", "storage is a sibling of Direct-IP identity");
        if (!OperatingSystem.IsWindows())
        {
            Expect(File.GetUnixFileMode(fixture.Root) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute), "directory mode 0700");
            foreach (var file in Directory.GetFiles(fixture.Root))
                Expect(File.GetUnixFileMode(file) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "file mode 0600");
        }
        Expect(Directory.GetFiles(fixture.Root).Length == 2, "no temporary files remain");
    }

    private static void Regenerate(string file, bool missing, bool empty = false)
    {
        using var fixture = new Fixture();
        using var first = LanRtcIdentity.LoadOrCreate(fixture.Root, _ => { });
        var path = Path.Combine(fixture.Root, file);
        if (missing) File.Delete(path);
        else File.WriteAllBytes(path, empty ? [] : [1, 2, 3]);
        var logs = new List<string>();
        using var second = LanRtcIdentity.LoadOrCreate(fixture.Root, logs.Add);
        Expect(first.Fingerprint != second.Fingerprint, "invalid or missing file regenerates identity");
        Expect(logs.Count == 1 && logs[0].Contains(missing ? "missing" : "invalid", StringComparison.Ordinal), "regeneration logs why");
        using var third = LanRtcIdentity.LoadOrCreate(fixture.Root, logs.Add);
        Expect(second.Fingerprint == third.Fingerprint && logs.Count == 1, "replacement persists");
    }

    private static void ConcurrentLoads()
    {
        using var fixture = new Fixture();
        var fingerprints = new string[4];
        Parallel.For(0, fingerprints.Length, index =>
        {
            using var identity = LanRtcIdentity.LoadOrCreate(fixture.Root, _ => { });
            fingerprints[index] = identity.Fingerprint;
        });
        Expect(fingerprints.Distinct().Count() == 1, "concurrent callers share one persistent identity");
    }

    private static void MismatchedKeyRegenerates()
    {
        using var fixture = new Fixture();
        using var other = new Fixture();
        using var first = LanRtcIdentity.LoadOrCreate(fixture.Root, _ => { });
        using var foreign = LanRtcIdentity.LoadOrCreate(other.Root, _ => { });
        File.WriteAllBytes(Path.Combine(fixture.Root, "key.pkcs8.der"), File.ReadAllBytes(Path.Combine(other.Root, "key.pkcs8.der")));
        using var replacement = LanRtcIdentity.LoadOrCreate(fixture.Root, _ => { });
        Expect(replacement.Fingerprint != first.Fingerprint && replacement.Fingerprint != foreign.Fingerprint,
            "an interrupted file pair regenerates instead of loading a mismatched key");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"LanRtcIdentityTests: {because}");
    }

    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "couchcoop-lan-rtc-" + Guid.NewGuid().ToString("N"));
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true); }
    }
}
