using System.Diagnostics;
using CouchCoop.Mod.Server;

internal static class ManagedCacheProcessTests
{
    public const string ChildVerb = "cache-quota-child";

    public static async Task<int> RunChildAsync(string[] args)
    {
        if (args.Length != 4 || !long.TryParse(args[2], out var bytes)) return 2;
        var quota = TinyQuota(args[1]);
        using var reservation = quota.TryReserve(bytes);
        if (reservation is not null && args[3] == "write-hold")
        {
            // A writer can die after creating a staging file but before publishing or disposing its reservation.
            // Write half the grant so recovery must census actual disk use rather than reclaiming the whole grant.
            await File.WriteAllBytesAsync(Path.Combine(args[1], "crashed-writer.tmp"), new byte[checked((int)(bytes / 2))]);
        }
        await Console.Out.WriteLineAsync(reservation is null ? "denied" : "reserved");
        await Console.Out.FlushAsync();
        if (reservation is null) return 3;
        if (args[3] == "hold") await Console.In.ReadLineAsync();
        return 0;
    }

    public static async Task RunAsync()
    {
        using var scope = new TempScope();
        await ExactlyOneProcessCanReserveWithoutOvercommitAsync(scope.Root);
        await ADeadProcessCannotLeaveCapacityReservedAsync(scope.Root);
        await ADeadWriterLeavesItsActualStagingBytesChargedAsync(scope.Root);
        await HeadlessAndAncestorAliasesCoordinateAsync(scope.Root);
        ExistingBytesAndPartialGrantsAreAccounted(scope.Root);
        await DeniedFreshAssetPreservesExistingHitsAsync(scope.Root);
        GeoclipDenialCreatesNoStaging(scope.Root);
        await OversizedGeoclipIsCleanedBeforePublishAsync(scope.Root);
    }

    private static async Task ExactlyOneProcessCanReserveWithoutOvercommitAsync(string root)
    {
        var a = StartChild(root, 6, "hold");
        var b = StartChild(root, 6, "hold");
        try
        {
            var results = await Task.WhenAll(ReadResultAsync(a), ReadResultAsync(b));
            Expect(results.Count(result => result == "reserved") == 1, "exactly one of simultaneous 6-byte reservations fits a 10-byte ceiling");
            Expect(results.Count(result => result == "denied") == 1, "the competing process is denied instead of overcommitting");
        }
        finally
        {
            await ReleaseOrKillAsync(a);
            await ReleaseOrKillAsync(b);
        }
    }

    private static async Task ADeadProcessCannotLeaveCapacityReservedAsync(string root)
    {
        var child = StartChild(root, 8, "hold");
        Expect(await ReadResultAsync(child) == "reserved", "child obtains a held reservation");
        child.Kill(entireProcessTree: true);
        await child.WaitForExitAsync();

        using var recovered = TinyQuota(root).TryReserve(8);
        Expect(recovered is not null, "a killed owner is reclaimed on the next zero-interval reconcile");
    }

    private static async Task ADeadWriterLeavesItsActualStagingBytesChargedAsync(string root)
    {
        var crashRoot = Path.Combine(root, "crash-with-bytes");
        Directory.CreateDirectory(crashRoot);
        var child = StartChild(crashRoot, 8, "write-hold");
        Expect(await ReadResultAsync(child) == "reserved", "writer reserves before staging bytes");
        child.Kill(entireProcessTree: true);
        await child.WaitForExitAsync();

        var quota = TinyQuota(crashRoot);
        using var tooLarge = quota.TryReserve(7);
        Expect(tooLarge is null, "crash reclaim retains the four staged bytes found by census");
        using var remaining = quota.TryReserve(6);
        Expect(remaining is not null, "crash reclaim releases reservation slack beyond the staged bytes");
        Expect(new FileInfo(Path.Combine(crashRoot, "crashed-writer.tmp")).Length == 4,
            "the recovery test leaves the staged fixture intact for accounting");
    }

    private static async Task HeadlessAndAncestorAliasesCoordinateAsync(string root)
    {
        var host = Path.Combine(root, "host", "couch-coop");
        var assets = Path.Combine(host, "assets");
        Directory.CreateDirectory(assets);
        var headless = Path.Combine(host, "headless-slots", "slot-2", "SlayTheSpire2", "couch-coop");
        Directory.CreateDirectory(headless);
        Directory.CreateSymbolicLink(Path.Combine(headless, "assets"), assets);

        var ancestorAlias = Path.Combine(root, "host-alias");
        Directory.CreateSymbolicLink(ancestorAlias, Path.Combine(root, "host"));
        var aliasedAssets = Path.Combine(ancestorAlias, "couch-coop", "assets");

        var holder = StartChild(assets, 6, "hold");
        try
        {
            Expect(await ReadResultAsync(holder) == "reserved", "host asset-root child reserves capacity");
            using var headlessDenied = TinyQuota(Path.Combine(headless, "assets")).TryReserve(5);
            using var ancestorDenied = TinyQuota(aliasedAssets).TryReserve(5);
            Expect(headlessDenied is null, "headless leaf symlink shares the host reservation ledger");
            Expect(ancestorDenied is null, "an ancestor symlink alias shares the host reservation ledger");
        }
        finally { await ReleaseOrKillAsync(holder); }
    }

    private static void ExistingBytesAndPartialGrantsAreAccounted(string root)
    {
        var fixtureRoot = Path.Combine(root, "existing");
        Directory.CreateDirectory(fixtureRoot);
        File.WriteAllBytes(Path.Combine(fixtureRoot, "generation.bin"), new byte[7]);
        var quota = TinyQuota(fixtureRoot);
        using var denied = quota.TryReserve(4);
        Expect(denied is null, "existing generated bytes count against the ceiling");
        using var partial = quota.TryReserveUpTo(4, minimumBytes: 2);
        using var remainder = quota.TryReserve(1);
        Expect(partial is not null && remainder is null,
            "partial reservation consumes exactly the remaining capacity");
        Expect(File.Exists(Path.Combine(fixtureRoot, "generation.bin")), "accounting never overwrites fixture content");
    }

    private static void GeoclipDenialCreatesNoStaging(string root)
    {
        var geoRoot = Path.Combine(root, "geoclip-denied");
        Directory.CreateDirectory(geoRoot);
        File.WriteAllBytes(Path.Combine(geoRoot, "full.bin"), new byte[10]);
        var quota = TinyQuota(geoRoot);
        var store = new CouchCoopGeoclipStore(geoRoot, quota);
        Expect(store.TryCreateStagingDirectory() is null, "geoclip storage denial happens before staging creation");
        Expect(!Directory.Exists(Path.Combine(store.RootPath!, CouchCoopGeoclipStore.StagingFolderName)),
            "denied geoclip production leaves no staging tree to clean up");
    }

    private static async Task DeniedFreshAssetPreservesExistingHitsAsync(string root)
    {
        var cacheRoot = Path.Combine(root, "asset-fallback");
        var allowQuota = new ManagedCacheQuota(cacheRoot, [cacheRoot], 100, 0, 50, _ => 1_000_000,
            allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        var allowed = new SpirectlAssetBinaryCache(cacheRoot, allowQuota);
        Expect(await allowed.TryWriteAsync("res://hit.png", [1, 2, 3], "image/png"), "fixture cache hit is admitted");

        var denyQuota = new ManagedCacheQuota(cacheRoot, [cacheRoot], 1, 0, 50, _ => 1_000_000,
            allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        var denied = new SpirectlAssetBinaryCache(cacheRoot, denyQuota);
        Expect(!await denied.TryWriteAsync("res://fresh.png", [4, 5], "image/png"), "fresh asset persistence is denied at capacity");
        Expect((await denied.TryReadAsync("res://hit.png"))?.Bytes.SequenceEqual(new byte[] { 1, 2, 3 }) == true,
            "an existing asset hit remains readable under storage denial");
        Expect(await denied.TryReadAsync("res://fresh.png") is null, "denied fresh bytes did not create a cache entry");
    }

    private static async Task OversizedGeoclipIsCleanedBeforePublishAsync(string root)
    {
        var geoRoot = Path.Combine(root, "geoclip-overflow");
        var quota = new ManagedCacheQuota(geoRoot, [geoRoot], 100, 0, 4, _ => 1_000_000,
            allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        var store = new CouchCoopGeoclipStore(geoRoot, quota);
        var staging = store.TryCreateStagingDirectory();
        Expect(staging is not null, "an initially admissible geoclip gets staging");
        await File.WriteAllBytesAsync(Path.Combine(staging!, CouchCoopGeoclipStore.ManifestFileName), new byte[5]);
        var result = await store.AdoptAsync("spine://oversized", staging!);
        Expect(!result.Success && result.ErrorCode == "geoclip-entry-too-large", "post-bake overflow is refused explicitly");
        store.ReleaseStagingDirectory(staging);
        Expect(!Directory.Exists(staging), "overflow staging is removed");
        Expect(store.TryResolveDirectory("spine://oversized") is null, "overflow never publishes a complete artifact");
    }

    private static ManagedCacheQuota TinyQuota(string root) => new(
        root, [root], ceilingBytes: 10, freeSpaceReserveBytes: 0, entryLimitBytes: 8,
        freeSpace: _ => 1_000_000, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);

    private static Process StartChild(string root, long bytes, string operation)
    {
        var assembly = typeof(ManagedCacheProcessTests).Assembly.Location;
        var start = new ProcessStartInfo("dotnet", $"{Quote(assembly)} {ChildVerb} {Quote(root)} {bytes} {operation}")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        return Process.Start(start) ?? throw new InvalidOperationException("Could not start cache quota child.");
    }

    private static async Task<string> ReadResultAsync(Process process)
    {
        var read = process.StandardOutput.ReadLineAsync();
        var completed = await Task.WhenAny(read, Task.Delay(TimeSpan.FromSeconds(10)));
        if (completed != read) throw new TimeoutException("Cache quota child produced no result.");
        return await read ?? "<eof>";
    }

    private static async Task ReleaseOrKillAsync(Process process)
    {
        if (process.HasExited) return;
        await process.StandardInput.WriteLineAsync("release");
        await process.StandardInput.FlushAsync();
        var exit = process.WaitForExitAsync();
        if (await Task.WhenAny(exit, Task.Delay(TimeSpan.FromSeconds(5))) != exit) process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
    }

    private static string Quote(string value) => '"' + value.Replace("\"", "\\\"") + '"';
    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"ManagedCacheProcessTests: {label}");
    }

    private sealed class TempScope : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "couch-cache-process-" + Guid.NewGuid().ToString("N"));
        public TempScope() => Directory.CreateDirectory(Root);
        public void Dispose() { try { Directory.Delete(Root, recursive: true); } catch (IOException) { } }
    }
}
