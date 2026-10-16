using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server;

internal static class DirectIpHttpsHostServiceTests
{
    public static async Task RunAsync()
    {
        var now = DateTimeOffset.UtcNow;
        var first = IPAddress.Parse("192.168.0.123");
        var second = IPAddress.Parse("192.168.0.124");
        IReadOnlyCollection<IPAddress> addresses = [first];
        var factories = 0;
        var reads = 0;
        var installs = 0;
        var active = false;
        using var authority = new FakeAuthority(() => now);
        await using var service = new DirectIpHttpsHostService(
            () => { factories++; return authority; },
            () => { reads++; return addresses; },
            _ => { installs++; active = true; return true; },
            () => active = false, () => active ? 13337 : 0, _ => { }, () => now, observeNetwork: false);
        Expect(factories == 0 && reads == 0 && service.State.Port == 0, "construction does no certificate or network work");
        using (var dormant = await service.RefreshForConnectionAsync(first, CancellationToken.None))
            Expect(dormant is null && factories == 0, "a remote connection cannot create identity");
        await service.PrepareAsync();
        Expect(factories == 1 && authority.Issues == 1 && service.State.Covers(first), "native setup activates the actual bound port");
        var fingerprint = service.State.CaFingerprint;
        var before = reads;
        using (var unknown = await service.RefreshForConnectionAsync(second, CancellationToken.None))
            Expect(unknown is null && authority.Issues == 1 && reads == before, "unknown addresses cannot mint certificates or enumerate adapters");
        using (var unchanged = await service.RefreshForConnectionAsync(first, CancellationToken.None))
            Expect(unchanged is not null && authority.Issues == 1 && reads == before, "ordinary TLS demand reuses material without network reads");
        now = now.AddDays(61);
        authority.ContinueIssue = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        authority.IssueStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstRenewal = service.RefreshForConnectionAsync(first, CancellationToken.None);
        await authority.IssueStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Expect(active && installs == 1, "a valid listener remains available while replacement issuance is blocked");
        var concurrentRenewals = Enumerable.Range(0, 3).Select(_ => service.RefreshForConnectionAsync(first, CancellationToken.None)).ToArray();
        authority.ContinueIssue.SetResult();
        var renewed = await Task.WhenAll(concurrentRenewals.Prepend(firstRenewal));
        authority.ContinueIssue = null;
        foreach (var value in renewed) value?.Dispose();
        Expect(authority.Issues == 2 && service.State.CaFingerprint == fingerprint, "concurrent demand renews once under the same authority");
        addresses = [second];
        await service.NotifyNetworkChanged();
        Expect(!service.State.Covers(first) && service.State.Covers(second) && authority.Issues == 3,
            "network event replaces the address SAN set before publishing readiness");
        Expect(service.ExportPublicRoot() == "public-root.cer", "export goes through the public-only authority operation");
        await service.ReplaceAuthorityAsync();
        Expect(authority.Replacements == 1 && service.State.CaFingerprint != fingerprint, "explicit replacement changes trust identity");
        authority.Fail = true;
        addresses = [first];
        await service.NotifyNetworkChanged();
        Expect(!active && service.State.Port == 0 && !service.State.CanExport && service.State.ErrorCode is not null,
            "failure clears readiness and disables stale TLS");
        authority.Fail = false;
        await service.PrepareAsync();
        Expect(service.State.Covers(first), "native retry recovers");
        await service.DisposeAsync();
        await service.NotifyNetworkChanged();
        Expect(!active && service.State.Port == 0, "shutdown disables TLS and ignores late network events");
        Console.WriteLine("DirectIpHttpsHostServiceTests: ok");
    }

    private sealed class FakeAuthority(Func<DateTimeOffset> now) : IDirectIpCertificateAuthority
    {
        private X509Certificate2? _root;
        public int Issues;
        public int Replacements;
        public bool Fail;
        public TaskCompletionSource? ContinueIssue;
        public TaskCompletionSource? IssueStarted;
        public async Task<DirectIpCertificateMaterial> PrepareAsync(IReadOnlyCollection<IPAddress> addresses,
            bool replaceAuthority = false, CancellationToken cancellationToken = default)
        {
            if (Fail) throw new IOException("test failure");
            Issues++;
            if (ContinueIssue is { } blocked)
            {
                IssueStarted!.TrySetResult();
                await blocked.Task.WaitAsync(cancellationToken);
            }
            if (replaceAuthority) { Replacements++; _root?.Dispose(); _root = null; }
            if (_root is null)
            {
                using var rootKey = RSA.Create(2048);
                var rootRequest = new CertificateRequest("CN=Host service test root", rootKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
                _root = rootRequest.CreateSelfSigned(now().AddMinutes(-5), now().AddYears(5));
            }
            using var key = RSA.Create(2048);
            var request = new CertificateRequest("CN=Host service test leaf", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            foreach (var address in addresses) names.AddIpAddress(address);
            request.CertificateExtensions.Add(names.Build());
            using var leaf = request.Create(_root, now().AddMinutes(-1), now().AddDays(90), RandomNumberGenerator.GetBytes(16));
            return new DirectIpCertificateMaterial(leaf.CopyWithPrivateKey(key),
                X509CertificateLoader.LoadCertificate(_root.RawData), addresses.ToArray());
        }
        public string ExportPublicRoot() => "public-root.cer";
        public void Dispose() { _root?.Dispose(); _root = null; }
    }

    private static void Expect(bool value, string reason)
    {
        if (!value) throw new InvalidOperationException("DirectIpHttpsHostServiceTests: " + reason);
    }
}
