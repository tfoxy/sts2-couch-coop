using CouchCoop.Mod.Server;

// The belt that keeps a headless seat from writing bad bytes into the SHARED on-disk asset cache.
//
// A seat cannot render (dummy renderer -> empty viewport frames), and once HeadlessTextureImageEvictor has
// released a texture's retained pixels a texture extraction on that process SUCCEEDS and returns a 1x1. The
// cache is write-through and shared with the host (HeadlessUserDirSeeder links it across slots), so one stray
// direct fetch at a seat's port would persist that 1x1 under a real asset key, for every client, forever —
// and there is no way to tell the bad bytes from good ones after the fact. So a seat serves disk-or-error and
// never calls the extracting inner adapter at all.
//
// Pure: a fake inner adapter records whether it was reached, and the cache is pointed at a temp root so
// nothing touches the real one.
internal static class HeadlessAssetExtractionGuardTests
{
    public static void Run()
    {
        HeadlessSeatNeverExtractsOnAMiss();
        HeadlessSeatStillServesADiskHit();
        NonHeadlessStillExtracts();
    }

    private static void HeadlessSeatNeverExtractsOnAMiss()
    {
        using var root = new TempCacheRoot();
        var inner = new RecordingAdapter();
        var adapter = new CachedSpirectlAssetHttpAdapter(inner, new SpirectlAssetBinaryCache(root.Path), isHeadlessClient: true);

        var response = adapter.TryGetAssetAsync("res://images/icon.png").GetAwaiter().GetResult();

        Assert(!inner.WasCalled, "a headless seat must not reach the extracting adapter on a cache miss");
        Assert(response.Bytes is null, "a headless seat serves no bytes on a miss");
        Assert(response.Error?.Code == CachedSpirectlAssetHttpAdapter.ExtractionUnavailableCode,
            "the miss reports the extraction-unavailable code, which the route maps to 503 (retry the host) "
            + "rather than 404 (give up)");
    }

    // The guard is about EXTRACTION, not about serving: a seat with warm cache bytes still answers them, which
    // is what makes a direct fetch to a seat harmless in the common case.
    private static void HeadlessSeatStillServesADiskHit()
    {
        using var root = new TempCacheRoot();
        var cache = new SpirectlAssetBinaryCache(root.Path);
        var bytes = "cached-png-bytes"u8.ToArray();
        cache.WriteAsync("res://images/icon.png", bytes, "image/png").GetAwaiter().GetResult();

        var inner = new RecordingAdapter();
        var adapter = new CachedSpirectlAssetHttpAdapter(inner, cache, isHeadlessClient: true);
        var response = adapter.TryGetAssetAsync("res://images/icon.png").GetAwaiter().GetResult();

        Assert(!inner.WasCalled, "a disk hit never reaches the inner adapter, headless or not");
        Assert(response.Error is null && response.Bytes is not null,
            "a headless seat still serves cached bytes");
        Assert(response.Bytes!.Length == bytes.Length, "the cached bytes are served verbatim");
    }

    private static void NonHeadlessStillExtracts()
    {
        using var root = new TempCacheRoot();
        var inner = new RecordingAdapter();
        var adapter = new CachedSpirectlAssetHttpAdapter(inner, new SpirectlAssetBinaryCache(root.Path), isHeadlessClient: false);

        var response = adapter.TryGetAssetAsync("res://images/icon.png").GetAwaiter().GetResult();

        Assert(inner.WasCalled, "a host still extracts on a cache miss — the guard is seat-only");
        Assert(response.Bytes is not null, "the host's extracted bytes are served");
    }

    private sealed class RecordingAdapter : ICouchCoopAssetHttpAdapter
    {
        public bool WasCalled { get; private set; }

        public Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
            string opaqueKey,
            CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
            CouchCoopAssetRenderSize renderSize = default,
            CancellationToken cancellationToken = default)
        {
            WasCalled = true;
            return Task.FromResult(CouchCoopAssetHttpResponse.Found(
                "extracted"u8.ToArray(),
                "image/png",
                new Dictionary<string, string>()));
        }
    }

    private sealed class TempCacheRoot : IDisposable
    {
        public TempCacheRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-asset-guard-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch (IOException)
            {
                // Best effort — a leftover temp dir is not worth failing a suite over.
            }
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"HeadlessAssetExtractionGuardTests: {label}");
        }
    }
}
