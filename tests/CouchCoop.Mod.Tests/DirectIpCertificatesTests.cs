using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Server;

internal static class DirectIpCertificatesTests
{
    private static readonly IPAddress First = IPAddress.Parse("192.168.40.12");
    private static readonly IPAddress Second = IPAddress.Parse("10.40.0.7");
    private static readonly DateTimeOffset Start = DateTimeOffset.UtcNow;

    public static async Task RunAsync()
    {
        CanonicalProductionStorage();
        await PersistentAuthorityAndPublicExport();
        await RenewalAndAddressChanges();
        await CorruptionAndReplacement();
        await ConcurrentWriters();
        await ConcurrentProcesses();
        await SeatBundlesAreLeafOnly();
        await RejectUntrustedAndWrongIdentity();
        await RejectUnsafeStorage();
        Console.WriteLine("DirectIpCertificatesTests: ok");
    }

    private static void CanonicalProductionStorage()
    {
        const string unsupportedOverride = "COUCHCOOP_DIRECT_IP_IDENTITY_ROOT";
        var prior = Environment.GetEnvironmentVariable(unsupportedOverride);
        try
        {
            Environment.SetEnvironmentVariable(unsupportedOverride, Path.Combine(Path.GetTempPath(), "frontend"));
            var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SlayTheSpire2", "couch-coop", "direct-ip-identity");
            Expect(DirectIpCertificates.DefaultStorageRoot() == expected,
                "production identity stays in persistent application data, never an arbitrary serving root");
        }
        finally { Environment.SetEnvironmentVariable(unsupportedOverride, prior); }
    }

    private static async Task PersistentAuthorityAndPublicExport()
    {
        using var fixture = new Fixture();
        using var authority = fixture.Create();
        Expect(!Directory.Exists(fixture.Root), "construction must not create an identity or storage");
        using var first = await authority.PrepareAsync([First, Second]);
        Expect(first.Certificate.HasPrivateKey && !first.PublicRoot.HasPrivateKey, "only the leaf exposes a private key");
        using var rsa = first.PublicRoot.GetRSAPublicKey();
        Expect(rsa!.KeySize == 3072, "root uses RSA3072");
        var constraints = first.PublicRoot.Extensions.OfType<X509BasicConstraintsExtension>().Single();
        Expect(constraints.CertificateAuthority && constraints.HasPathLengthConstraint && constraints.PathLengthConstraint == 0, "root path length is zero");
        Expect(first.Certificate.MatchesHostname(First.ToString(), false, false), "IP SAN matches literal address");
        Expect(!first.Certificate.MatchesHostname("couchcoop.local", false, false), "common name is not a DNS identity");
        Expect(first.LeafExpiresAt - Start <= TimeSpan.FromDays(90), "leaf lifetime is bounded");
        using var restarted = fixture.Create();
        using var second = await restarted.PrepareAsync([Second, First]);
        Expect(first.CaFingerprint == second.CaFingerprint && first.Certificate.Thumbprint == second.Certificate.Thumbprint, "restart and reordered addresses reuse identity");
        var exported = restarted.ExportPublicRoot();
        Expect(Path.GetDirectoryName(exported) == Path.Combine(fixture.Root, "exports"), "export has a separate public directory");
        using var publicRoot = X509CertificateLoader.LoadCertificateFromFile(exported);
        Expect(!publicRoot.HasPrivateKey && publicRoot.RawData.AsSpan().SequenceEqual(first.PublicRoot.RawData), "export is exactly public DER");
        if (!OperatingSystem.IsWindows())
        {
            Expect(File.GetUnixFileMode(fixture.Root) == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute), "private directory mode");
            foreach (var file in Directory.GetFiles(fixture.Root, "*", SearchOption.AllDirectories))
                Expect(File.GetUnixFileMode(file) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "private file mode");
        }
        using var missing = new DirectIpCertificates(Path.Combine(fixture.Root, "missing"));
        Throws(() => missing.ExportPublicRoot(), "export never generates an authority");
    }

    private static async Task RenewalAndAddressChanges()
    {
        using var fixture = new Fixture();
        using var service = fixture.Create();
        using var original = await service.PrepareAsync([First]);
        fixture.Now = Start.AddDays(61);
        var seatId = service.SaveSeatMaterial(original);
        using var renewed = await service.PrepareAsync([First]);
        Expect(service.SaveSeatMaterial(renewed) == seatId, "renewal updates a stable CA-pinned seat bundle");
        Throws(() => service.SaveSeatMaterial(original), "stale leaf must not overwrite the renewed seat bundle");
        using var seatRenewed = DirectIpCertificates.LoadSeatMaterial(seatId, First, original.CaFingerprint,
            Path.Combine(fixture.Root, "seat-leaves"), () => fixture.Now);
        Expect(seatRenewed.Certificate.Thumbprint == renewed.Certificate.Thumbprint, "seat demand loads the renewed leaf");
        Expect(renewed.CaFingerprint == original.CaFingerprint && renewed.Certificate.Thumbprint != original.Certificate.Thumbprint, "renewal preserves installed trust");
        using var changed = await service.PrepareAsync([Second]);
        Expect(changed.CaFingerprint == original.CaFingerprint && changed.Certificate.MatchesHostname(Second.ToString(), false, false), "new IP receives matching SAN");
        Expect(!changed.Certificate.MatchesHostname(First.ToString(), false, false), "removed address is removed from SANs");
        service.SaveSeatMaterial(changed);
        Throws(() => service.SaveSeatMaterial(renewed), "old address generation must not overwrite changed seat credentials");
        using var seatChanged = DirectIpCertificates.LoadSeatMaterial(seatId, Second, original.CaFingerprint,
            Path.Combine(fixture.Root, "seat-leaves"), () => fixture.Now);
        Expect(seatChanged.Certificate.Thumbprint == changed.Certificate.Thumbprint, "rejection preserves current address generation");
        fixture.Now = Start.AddDays(200);
        using var afterExpired = await service.PrepareAsync([Second]);
        Expect(afterExpired.CaFingerprint == original.CaFingerprint, "expired valid leaf is renewable under stable root");
        fixture.Now = Start.AddYears(5).AddDays(-10);
        using var last = await service.PrepareAsync([First]);
        Expect(last.LeafExpiresAt <= last.CaExpiresAt, "leaf never outlives root");
        using var boundedReuse = await service.PrepareAsync([First]);
        Expect(last.Certificate.Thumbprint == boundedReuse.Certificate.Thumbprint, "CA-bounded leaf is not regenerated on every demand");
        fixture.Now = Start.AddYears(5).AddDays(1);
        await ThrowsAsync(() => service.PrepareAsync([First]), "expired authority requires explicit replacement");
        using var replacement = await service.PrepareAsync([First], replaceAuthority: true);
        Expect(replacement.CaFingerprint != original.CaFingerprint, "explicit replacement creates a new trust identity");
    }

    private static async Task CorruptionAndReplacement()
    {
        using var fixture = new Fixture();
        using var service = fixture.Create();
        using var original = await service.PrepareAsync([First]);
        var statePath = Path.Combine(fixture.Root, "identity.json");
        var originalState = File.ReadAllBytes(statePath);
        File.WriteAllText(statePath, "broken");
        await ThrowsAsync(() => service.PrepareAsync([First]), "corruption must fail closed");
        Expect(File.ReadAllText(statePath) == "broken", "failed preparation does not replace corrupted trust");
        using (var replacement = await service.PrepareAsync([First], true))
            Expect(replacement.CaFingerprint != original.CaFingerprint, "only explicit replacement repairs identity corruption");
        File.WriteAllBytes(statePath, originalState);
        using var otherFixture = new Fixture();
        using var other = otherFixture.Create();
        using var foreign = await other.PrepareAsync([First]);
        var state = JsonNode.Parse(originalState)!;
        state["Leaf"] = Convert.ToBase64String(foreign.Certificate.Export(X509ContentType.Pkcs12));
        File.WriteAllText(statePath, state.ToJsonString());
        await ThrowsAsync(() => service.PrepareAsync([First]), "foreign leaf chain is rejected");
        state["Leaf"] = Convert.ToBase64String(original.Certificate.Export(X509ContentType.Cert));
        File.WriteAllText(statePath, state.ToJsonString());
        await ThrowsAsync(() => service.PrepareAsync([First]), "leaf without a key is rejected");
    }

    private static async Task ConcurrentWriters()
    {
        using var fixture = new Fixture();
        using var first = fixture.Create();
        using var second = fixture.Create();
        var results = await Task.WhenAll(first.PrepareAsync([First]), second.PrepareAsync([First]));
        try { Expect(results[0].CaFingerprint == results[1].CaFingerprint, "concurrent independent services create only one authority"); }
        finally { foreach (var material in results) material.Dispose(); }
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await ThrowsAsync(() => first.PrepareAsync([First], cancellationToken: cancelled.Token), "cancelled preparation does not proceed");
        first.Dispose();
        await ThrowsAsync(() => first.PrepareAsync([First]), "disposed service rejects setup");
    }

    public static async Task RunChildAsync(string root)
    {
        using var authority = new DirectIpCertificates(root);
        using var material = await authority.PrepareAsync([First]);
        Console.WriteLine(material.CaFingerprint);
    }

    private static async Task ConcurrentProcesses()
    {
        using var fixture = new Fixture();
        Process StartChild()
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Process path missing.");
            var start = new ProcessStartInfo(executable) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(typeof(DirectIpCertificatesTests).Assembly.Location);
            start.ArgumentList.Add("direct-ip-certificate-child");
            start.ArgumentList.Add(fixture.Root);
            return Process.Start(start) ?? throw new InvalidOperationException("Could not start certificate test child.");
        }
        using var first = StartChild();
        using var second = StartChild();
        var firstOutput = first.StandardOutput.ReadToEndAsync();
        var secondOutput = second.StandardOutput.ReadToEndAsync();
        var firstError = first.StandardError.ReadToEndAsync();
        var secondError = second.StandardError.ReadToEndAsync();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            await Task.WhenAll(first.WaitForExitAsync(timeout.Token), second.WaitForExitAsync(timeout.Token));
            Expect(first.ExitCode == 0 && second.ExitCode == 0, "certificate child failed: " + await firstError + await secondError);
            var firstFingerprint = (await firstOutput).Trim();
            Expect(firstFingerprint.Length == 64 && firstFingerprint == (await secondOutput).Trim(), "separate processes must publish one stable authority");
        }
        finally
        {
            if (!first.HasExited) first.Kill(entireProcessTree: true);
            if (!second.HasExited) second.Kill(entireProcessTree: true);
        }
    }

    private static async Task SeatBundlesAreLeafOnly()
    {
        using var fixture = new Fixture();
        using var authority = fixture.Create();
        using var original = await authority.PrepareAsync([First, Second]);
        var id = authority.SaveSeatMaterial(original);
        DirectIpCertificateMaterial LoadSeat(string bundleId, IPAddress address, string fingerprint)
            => DirectIpCertificates.LoadSeatMaterial(bundleId, address, fingerprint, Path.Combine(fixture.Root, "seat-leaves"), () => fixture.Now);
        var bundlePath = Path.Combine(fixture.Root, "seat-leaves", id + ".json");
        var document = JsonNode.Parse(File.ReadAllText(bundlePath))!;
        Expect(document["Authority"] is null, "seat document contains no authority-key field");
        using var root = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(document["PublicRoot"]!.GetValue<string>()));
        Expect(!root.HasPrivateKey, "seat root is public");
        // Deleting the host identity proves the seat loader never reads it or silently creates another one.
        File.Delete(Path.Combine(fixture.Root, "identity.json"));
        await ThrowsAsync(() => authority.PrepareAsync([First]), "missing identity with existing trust evidence must not recreate a CA");
        using var loaded = LoadSeat(id, Second, original.CaFingerprint);
        Expect(loaded.Certificate.Thumbprint == original.Certificate.Thumbprint && !loaded.PublicRoot.HasPrivateKey, "seat loads matching leaf only");
        Expect(!File.Exists(Path.Combine(fixture.Root, "identity.json")), "seat load must not create host identity");
        Throws(() => LoadSeat(id, IPAddress.Parse("10.40.0.8"), original.CaFingerprint), "seat rejects wrong IP");
        Throws(() => LoadSeat(id, First, new string('0', 64)), "seat rejects wrong authority fingerprint");
        Throws(() => LoadSeat("../identity", First, original.CaFingerprint), "seat rejects path traversal");
        fixture.Now = Start.AddDays(91);
        Throws(() => LoadSeat(id, First, original.CaFingerprint), "seat rejects expired leaf");
        // Keep the old material valid so this checks generation rejection, not expiration rejection.
        fixture.Now = Start.AddDays(1);
        using var replacement = await authority.PrepareAsync([First], replaceAuthority: true);
        var replacementId = authority.SaveSeatMaterial(replacement);
        Throws(() => authority.SaveSeatMaterial(original), "old authority material must not resurrect deleted credentials");
        Expect(!File.Exists(bundlePath), "rejected old material leaves its bundle absent");
        Throws(() => LoadSeat(id, First, original.CaFingerprint), "authority replacement removes old seat credentials");
        using var current = LoadSeat(replacementId, First, replacement.CaFingerprint);
        Expect(current.Certificate.Thumbprint == replacement.Certificate.Thumbprint, "rejection preserves current authority credentials");
    }

    private static async Task RejectUntrustedAndWrongIdentity()
    {
        using var fixture = new Fixture();
        using var service = fixture.Create();
        using var material = await service.PrepareAsync([First]);
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true;
        Expect(!chain.Build(material.Certificate), "a downloaded self-signed root is not trusted automatically");
        chain.ChainPolicy.CustomTrustStore.Add(material.PublicRoot);
        Expect(chain.Build(material.Certificate), "explicitly installed root validates leaf");
        Expect(!material.Certificate.MatchesHostname(Second.ToString(), false, false), "wrong IP is not valid even under trusted root");
        chain.ChainPolicy.VerificationTime = Start.AddDays(91).UtcDateTime;
        Expect(!chain.Build(material.Certificate), "expired certificate fails browser-equivalent chain validation");
        await ThrowsAsync(() => service.PrepareAsync([IPAddress.IPv6Loopback]), "IPv6 is outside this feature");
        await ThrowsAsync(() => service.PrepareAsync([IPAddress.Any]), "unspecified addresses cannot be issued");
        await ThrowsAsync(() => service.PrepareAsync([]), "empty address set cannot be issued");
    }

    private static async Task RejectUnsafeStorage()
    {
        using var fixture = new Fixture();
        using var service = fixture.Create();
        using var material = await service.PrepareAsync([First]);
        if (!OperatingSystem.IsWindows())
        {
            var identity = Path.Combine(fixture.Root, "identity.json");
            File.SetUnixFileMode(identity, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.OtherRead);
            await ThrowsAsync(() => service.PrepareAsync([First]), "publicly readable keys fail closed");
            File.SetUnixFileMode(identity, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            var realIdentity = identity + ".real";
            File.Move(identity, realIdentity);
            File.CreateSymbolicLink(identity, realIdentity);
            await ThrowsAsync(() => service.PrepareAsync([First]), "symlinked identity is rejected");
            File.Delete(identity);
            File.Move(realIdentity, identity);
            Directory.CreateSymbolicLink(Path.Combine(fixture.Root, "exports"), Path.GetTempPath());
            Throws(() => service.ExportPublicRoot(), "symlinked export directory is rejected");
            Directory.Delete(Path.Combine(fixture.Root, "exports"));
        }
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
    private static void Throws(Action action, string message)
    {
        try { action(); } catch (Exception error) when (error is CryptographicException or IOException or ArgumentException or System.Text.Json.JsonException or ObjectDisposedException) { return; }
        throw new InvalidOperationException(message);
    }
    private static async Task ThrowsAsync(Func<Task> action, string message)
    {
        try { await action(); } catch (Exception error) when (error is CryptographicException or IOException or ArgumentException or System.Text.Json.JsonException or OperationCanceledException or ObjectDisposedException) { return; }
        throw new InvalidOperationException(message);
    }
    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "cc-direct-ip-cert-test-" + Guid.NewGuid().ToString("N"));
        public DateTimeOffset Now { get; set; } = Start;
        public DirectIpCertificates Create() => new(Root, () => Now);
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true); }
    }
}
