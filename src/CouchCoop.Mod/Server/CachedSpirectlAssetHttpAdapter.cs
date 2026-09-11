namespace CouchCoop.Mod.Server;

// Decorates the spirectl asset seam with the on-disk binary cache: a disk HIT serves bytes straight from
// the request (background) thread with no Godot main-thread hop; a MISS extracts via the inner adapter
// (the slow main-thread GetAsset), then writes the bytes through to disk so the next request is fast. The
// X-Cache: HIT|MISS header is a diagnostic. Errors from the inner adapter pass through uncached.
public sealed class CachedSpirectlAssetHttpAdapter(
    ICouchCoopAssetHttpAdapter inner,
    SpirectlAssetBinaryCache cache,
    bool? isHeadlessClient = null) : ICouchCoopAssetHttpAdapter
{
    /// <summary>Error code a headless seat answers a cache MISS with; the route maps it to 503, not 404.</summary>
    public const string ExtractionUnavailableCode = "asset-extraction-unavailable";

    private readonly bool _isHeadlessClient = isHeadlessClient ?? CouchCoopMod.IsHeadlessClient;

    public async Task<CouchCoopAssetHttpResponse> TryGetAssetAsync(
        string opaqueKey,
        CouchCoopResourceFormat format = CouchCoopResourceFormat.Raw,
        CouchCoopAssetRenderSize renderSize = default,
        CancellationToken cancellationToken = default)
    {
        // Raster variants of the same res:// key map to different bytes, so the cache key carries the format.
        var cacheKey = CacheKey(opaqueKey, format, renderSize);
        var cached = await cache.TryReadAsync(cacheKey, cancellationToken).ConfigureAwait(false);
        if (cached is not null)
        {
            return CouchCoopAssetHttpResponse.Found(cached.Bytes, cached.ContentType, ImmutableHeaders("HIT"));
        }

        if (_isHeadlessClient)
        {
            // Headless seats serve disk-or-503 and NEVER extract — the same belt CouchCoopStaticBackgroundProvider
            // applies to /bg, for a sharper reason here.
            //
            // A seat cannot render (its dummy-renderer viewport produces empty frames), so a render-backed
            // extraction was already worthless. Worse, once HeadlessTextureImageEvictor has released a texture's
            // retained pixels, a texture extraction on this process succeeds and returns a 1x1 — and the
            // write-through below would persist that 1x1 into the asset cache, which is SHARED with the host
            // (HeadlessUserDirSeeder links the caches across slots). One stray direct fetch would then poison a
            // real asset key for every client, permanently, with no way to tell the bad bytes from good ones.
            //
            // Asset HTTP goes to the host origin in normal operation, so this only closes that stray path; 503
            // (not 404) because AssetFetchPolicy treats 5xx as transient and retries against a host that can
            // actually render.
            return CouchCoopAssetHttpResponse.Missing(new CouchCoopAssetHttpError(
                ExtractionUnavailableCode,
                "This headless seat does not extract assets; fetch from the host origin.",
                "key",
                opaqueKey));
        }

        var response = await inner.TryGetAssetAsync(opaqueKey, format, renderSize, cancellationToken).ConfigureAwait(false);
        if (response.Error is null && response.Bytes is not null)
        {
            // Write-through (small, local-disk write — negligible next to the main-thread extraction).
            await cache.WriteAsync(cacheKey, response.Bytes, response.ContentType, cancellationToken).ConfigureAwait(false);
            return CouchCoopAssetHttpResponse.Found(
                response.Bytes,
                response.ContentType ?? "application/octet-stream",
                ImmutableHeaders("MISS", response.Headers));
        }

        return response;
    }

    // Qualify the cache key with the format for the non-default variants only; the raw variant keeps the bare key
    // so the scheme-partitioned cache layout is unchanged for the default path. (All variants are already
    // invalidated by the SpirectlAssetBinaryCache schema-version bump, so there is no collision with pre-switch
    // entries.) A `png` (WS-PARTICLE raster) hit must never serve raw `.tres` text or vice versa.
    //
    // R19: a RENDER SIZE is part of the identity for the same reason the format is — /icons/icon-192.png and
    // /icons/icon-512.png resolve the SAME res:// key and differ only in the resample spirectl performs, so
    // without the suffix the first one cached would be served for both. A request that asks for no size keeps
    // the bare key, so every pre-R19 entry stays addressable.
    private static string CacheKey(string opaqueKey, CouchCoopResourceFormat format, CouchCoopAssetRenderSize renderSize)
        => format switch
        {
            CouchCoopResourceFormat.Png => $"{opaqueKey}|format=png{renderSize.KeySuffix}",
            _ => $"{opaqueKey}{renderSize.KeySuffix}",
        };

    private static IReadOnlyDictionary<string, string> ImmutableHeaders(
        string cacheStatus,
        IReadOnlyDictionary<string, string>? baseHeaders = null)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (baseHeaders is not null)
        {
            foreach (var (key, value) in baseHeaders)
            {
                headers[key] = value;
            }
        }

        headers["Cache-Control"] = "public, max-age=31536000, immutable";
        headers["X-Cache"] = cacheStatus;
        return headers;
    }
}
