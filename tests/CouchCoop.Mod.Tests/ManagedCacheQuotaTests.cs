using CouchCoop.Mod.Server;

internal static class ManagedCacheQuotaTests
{
    public static async Task RunAsync()
    {
        using var scope = new TempScope();
        var oldGeneration = Path.Combine(scope.Root, "old-generation");
        Directory.CreateDirectory(oldGeneration);
        await File.WriteAllBytesAsync(Path.Combine(oldGeneration, "stale.bin"), new byte[7]);

        var quota = new ManagedCacheQuota(scope.Root, [scope.Root], ceilingBytes: 10,
            freeSpaceReserveBytes: 0, entryLimitBytes: 8, freeSpace: _ => 100, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        Expect(quota.TryReserve(4) is null, "old cache generations count against admission");

        File.Delete(Path.Combine(oldGeneration, "stale.bin"));
        using (var first = quota.TryReserve(6))
        {
            Expect(first is not null, "the first concurrent reservation is admitted");
            Expect(quota.TryReserve(5) is null, "a second reservation cannot overcommit the shared ceiling");
        }
        using (var released = quota.TryReserve(5))
            Expect(released is not null, "a completed or failed write releases its reservation");

        var alias = Path.Combine(Path.GetDirectoryName(scope.Root)!, "couch-quota-alias-" + Guid.NewGuid().ToString("N"));
        Directory.CreateSymbolicLink(alias, scope.Root);
        try
        {
            var throughAlias = new ManagedCacheQuota(alias, [alias], 10, 0, 8, _ => 100, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
            using var realReservation = quota.TryReserve(6);
            Expect(realReservation is not null && throughAlias.TryReserve(5) is null,
                "symlinked headless cache roots share one cross-process reservation identity");

            var outside = Path.Combine(Path.GetDirectoryName(scope.Root)!, "couch-quota-outside-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(outside);
            await File.WriteAllBytesAsync(Path.Combine(outside, "operator.bin"), new byte[100]);
            Directory.CreateSymbolicLink(Path.Combine(scope.Root, "operator-link"), outside);
            using var ignoringDescendantLink = quota.TryReserve(4);
            Expect(ignoringDescendantLink is not null, "descendant symlinks are excluded from managed-cache accounting");
            Directory.Delete(Path.Combine(scope.Root, "operator-link"));
            Directory.Delete(outside, recursive: true);
        }
        finally { Directory.Delete(alias); }

        // A headless seat reaches the host's warm cache through a symlinked `cache` leaf. Two spellings of one
        // directory must not become two independent ceilings over the same disk, so the quota resolves the path.
        var hostCouch = Path.Combine(scope.Root, "host", "couch-coop");
        var hostCache = Path.Combine(hostCouch, "cache");
        var seatCouch = Path.Combine(scope.Root, "host", "couch-coop", "headless-slots", "slot-2", "SlayTheSpire2", "couch-coop");
        Directory.CreateDirectory(Path.Combine(hostCache, "public"));
        Directory.CreateDirectory(seatCouch);
        Directory.CreateSymbolicLink(Path.Combine(seatCouch, "cache"), hostCache);
        var hostQuota = ManagedCacheQuota.ForCacheRoot(Path.Combine(hostCache, "public"));
        var seatQuota = ManagedCacheQuota.ForCacheRoot(Path.Combine(seatCouch, "cache", "public"));
        Expect(hostQuota.CoordinationRoot == seatQuota.CoordinationRoot,
            "host and headless cache-leaf symlinks resolve through the shared cache target");

        var lowDisk = new ManagedCacheQuota(scope.Root, [scope.Root], ceilingBytes: 100,
            freeSpaceReserveBytes: 20, entryLimitBytes: 50, freeSpace: _ => 24, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        Expect(lowDisk.TryReserve(5) is null, "the free-space reserve is enforced");

        var cacheRoot = Path.Combine(scope.Root, "binary");
        var allow = new ManagedCacheQuota(cacheRoot, [cacheRoot], 100, 0, 50, _ => 100, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        var cache = new SpirectlAssetBinaryCache(cacheRoot, allow);
        Expect(await cache.TryWriteAsync("res://kept.png", [1, 2, 3], "image/png"), "an admitted entry is persisted");

        var deny = new ManagedCacheQuota(cacheRoot, [cacheRoot], 3, 0, 50, _ => 100, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        var readOnly = new SpirectlAssetBinaryCache(cacheRoot, deny);
        var hit = await readOnly.TryReadAsync("res://kept.png");
        Expect(hit?.Bytes.SequenceEqual(new byte[] { 1, 2, 3 }) == true, "existing hits remain readable after writes are denied");
        Expect(!await readOnly.TryWriteAsync("res://denied.png", [4], "image/png"), "a denied write reports refusal");
        Expect(!Directory.EnumerateFiles(cacheRoot, "*.tmp", SearchOption.AllDirectories).Any(),
            "denial happens before a destination temp file is created");

        var entryLimited = new ManagedCacheQuota(scope.Root, [scope.Root], 100, 0, 2, _ => 100, allocationUnitBytes: 1, reconcileInterval: TimeSpan.Zero);
        Expect(entryLimited.TryReserve(3) is null, "the generated-entry limit is enforced independently");
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"ManagedCacheQuotaTests: {label}");
    }

    private sealed class TempScope : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "couch-quota-tests-" + Guid.NewGuid().ToString("N"));
        public TempScope() => Directory.CreateDirectory(Root);
        public void Dispose() => Directory.Delete(Root, recursive: true);
    }
}
