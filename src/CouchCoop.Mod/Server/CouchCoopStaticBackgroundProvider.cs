using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Runtime;
using CouchCoop.MirrorProtocol.SceneModel;
using Spirectl.Sts2.Embedding;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Which background scene-path convention a <c>/bg/</c> id names (BackgroundSceneFamilies holds both grammars).
/// COMBAT backgrounds mount randomized layer variants, so their URLs/keys may carry a <c>layers=</c> digest and
/// their render walks the composed-key fallback chain; EVENT backdrops are single fixed scenes
/// (<c>res://scenes/events/background_scenes/&lt;id&gt;.tscn</c>), so their URLs/keys are always digest-less and
/// render as one literal-scene rung.
/// </summary>
public enum StaticBackgroundFamily
{
    Combat,
    Events,
    // Inline room-backdrop subtrees (the merchant shop) — see BackgroundSceneFamilies.RoomBackgroundSubtrees.
    // Digest-less like events; frame-qualified like events; rendered via a scene-subtree:// key.
    Rooms,
}

// Produces the host-rendered STATIC background image for the `/bg/` route (the mirror's "Static background"
// setting): one 2520x1080 render of the room's background — the combat background scene matching the layer
// variant the live room actually mounted, or an event backdrop scene — instead of the phone compositing the
// whole live bg subtree every frame. Skeleton = CouchCoopSpineClipProvider, with the same three layers plus a
// memory cache in front:
//
//   1. Memory HIT   — a handful of most-recent variants served straight from RAM (the same URL is fetched by every
//      viewer of the same room, often within milliseconds of each other).
//   2. Disk HIT     — a rendered background is static per (id, layer variant) within a game/mod version, so a
//      serialized PNG on disk serves from the request thread with no Godot main-thread hop.
//   3. Single-flight + write-through — one extraction per uncached key under the SHARED main-thread extraction
//      gate (CouchCoopAssetExtractionGate); waiters are served from memory, then the bytes land on disk.
public sealed class CouchCoopStaticBackgroundProvider(
    ISpirectlAssetProvider assets,
    SpirectlAssetBinaryCache cache,
    Action<string>? log = null,
    bool? isHeadlessClient = null)
{
    // FIXED render policy, part of every cache key (fixed-policy-in-key doctrine, same as the spine provider's
    // SpineClipSizePolicy): ONE render size for the whole fleet — the widescreen max design size, centered — so one
    // render -> one cache entry -> identical bytes to every client. The client letterboxes/crops; it never asks for
    // a per-device size.
    public const int RenderWidthPx = 2520;
    public const int RenderHeightPx = 1080;

    /// <summary>
    /// The ENCODER half of that fixed policy: JPEG at q90, measured (Aug-22 round 2, see
    /// <c>docs/agents/host-render-cost-aug22-round2.md</c>) against the whole browser-decodable field at this size.
    /// </summary>
    /// <remarks>
    /// PNG cost <b>650 ms of encode and 2.1 MB</b>; jpg@0.9 costs <b>46 ms and 280 KB</b> — a 14x cheaper encoder
    /// and 7.5x smaller bytes. webp@0.95 lands within 1% of jpg@0.9 on BOTH size (278 KB) and measured error
    /// (MAE 266 vs 263) while costing 263 ms, so the only thing it buys is the alpha channel.
    /// <para>
    /// Which we can afford to lose: the 2520x1080 render's alpha is exactly 39 fully-transparent columns at the
    /// LEFT edge (x 0-38, mean alpha 0.9848, nothing in the interior or on the right), and the RGB underneath is
    /// already ~black. The client clips the outer 300 px per side on 16:9, so that strip is off-screen there.
    /// ONE codec for every render path also keeps that edge from being transparent on one path and black on
    /// another.
    /// </para>
    /// </remarks>
    public const string RenderCodec = "jpg";

    public const float RenderQuality = 0.9f;

    /// <summary>The shipped encode candidate. Every non-bench render asks for exactly this.</summary>
    public static StaticBackgroundRenderMetrics.BenchCodec ShippedCodec => new(RenderCodec, RenderQuality);

    // Version selector for the bg:// encoding policy (not the cache layout). Bump it whenever the fixed encoding
    // policy changes so URLs and disk keys move to a fresh byte namespace together.
    public const string KeyVersion = "1";

    // How many hex chars of the SHA-256 the layer digest keeps. 16 (64 bits) is comfortably collision-free for the
    // handful of layer variants a background randomizes over, and keeps URLs readable.
    private const int LayersDigestLength = 16;

    private readonly ISpirectlAssetProvider _assets = assets ?? throw new ArgumentNullException(nameof(assets));
    private readonly SpirectlAssetBinaryCache _cache = cache ?? throw new ArgumentNullException(nameof(cache));
    private readonly Action<string> _log = log ?? (message => Console.Error.WriteLine(message));
    private readonly RateLimitedDiagnosticLog _cacheDiagnostics = new(log ?? Console.Error.WriteLine);
    private readonly bool _isHeadlessClient = isHeadlessClient ?? CouchCoopMod.IsHeadlessClient;

    // In-flight extractions only — an entry is removed once its task settles (the memory/disk caches are the
    // durable stores). Keyed by the canonical bg:// cache key, so concurrent requests for the same variant
    // coalesce onto ONE main-thread render.
    private static readonly ConcurrentDictionary<string, Lazy<Task<CouchCoopStaticBackgroundResult>>> InFlight = new(StringComparer.Ordinal);

    // Small bounded memory cache: the ~4 most recent variants (the current room's variant + the previous room's,
    // with headroom for a digest-less fallback fetch alongside). Each entry is a 1-3MB encoded image, so this is <=~12MB of
    // RAM on the host. Deliberately NO eviction policy beyond the recency cap: nothing else in the mod evicts
    // either (the disk cache is unbounded by design), and a background image's working set is bounded by how fast
    // rooms change — a plain oldest-out queue is exactly enough.
    private const int MemoryCapacity = 4;
    private readonly object _memoryGate = new();
    private readonly Dictionary<string, (byte[] Bytes, string ContentType)> _memory = new(StringComparer.Ordinal);
    private readonly Queue<string> _memoryOrder = new();

    /// <summary>
    /// The background id for a scene path following the combat-background convention
    /// <c>res://scenes/backgrounds/&lt;id&gt;/&lt;id&gt;_background.tscn</c>, or null when the path is anything
    /// else (twin of SpreadIndex's event-background SceneFilePath matching — here the id must ALSO be the
    /// directory name, which is what keeps this from matching per-layer sub-scenes like
    /// <c>&lt;id&gt;_bg_00_c.tscn</c>). Ids are the lowercase snake_case directory names the game ships.
    /// </summary>
    public static string? TryParseBackgroundId(string? scenePath)
    {
        const string prefix = "res://scenes/backgrounds/";
        const string suffix = "_background.tscn";
        if (scenePath is null
            || !scenePath.StartsWith(prefix, StringComparison.Ordinal)
            || !scenePath.EndsWith(suffix, StringComparison.Ordinal))
        {
            return null;
        }

        var middle = scenePath[prefix.Length..^suffix.Length]; // "<dir>/<file-stem>"
        var slash = middle.IndexOf('/');
        if (slash <= 0 || slash != middle.LastIndexOf('/'))
        {
            return null;
        }

        var dir = middle[..slash];
        var stem = middle[(slash + 1)..];
        if (!string.Equals(dir, stem, StringComparison.Ordinal) || !IsValidBackgroundId(dir))
        {
            return null;
        }

        return dir;
    }

    /// <summary>Whether <paramref name="id"/> is a plausible background id (lowercase snake_case / digits).</summary>
    public static bool IsValidBackgroundId(string id)
        => BackgroundSceneFamilies.IsValidBackgroundId(id);

    /// <summary>
    /// The event-background id for a scene path following the STRICT event convention
    /// <c>res://scenes/events/background_scenes/&lt;id&gt;.tscn</c>, else null (BackgroundSceneFamilies is the
    /// grammar; this forwarder keeps the provider the one façade the tracker/route/prerender call).
    /// </summary>
    public static string? TryParseEventBackgroundId(string? scenePath)
        => BackgroundSceneFamilies.TryParseEventBackgroundId(scenePath);

    /// <summary>
    /// The short stable digest of an ORDERED layer-scene-path list: the first 16 lowercase hex chars of the
    /// SHA-256 over the newline-joined paths. Order-sensitive on purpose — layer order is paint order.
    /// Null for an empty set (the digest-less key/URL is the deterministic-discovery variant).
    /// </summary>
    public static string? ComputeLayersDigest(IReadOnlyList<string> orderedLayerScenePaths)
    {
        if (orderedLayerScenePaths.Count == 0)
        {
            return null;
        }

        var joined = string.Join('\n', orderedLayerScenePaths);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(joined));
        return Convert.ToHexString(hash)[..LayersDigestLength].ToLowerInvariant();
    }

    // Cache key doctrine (CouchCoopSpineClipProvider.SpineClipSizePolicy): the FULL render policy rides the key, so
    // flipping any of it invalidates cleanly. `layers=<digest>` is present only for a tracker-probed variant; the
    // digest-less key is the deterministic-discovery fallback variant.
    public static string BuildCacheKey(string id, string? layersDigest)
        => BuildCacheKey(StaticBackgroundFamily.Combat, id, layersDigest);

    // The EVENT family keys ride a `bg://events/` namespace — a brand-new key space (no v1 bytes to invalidate),
    // which is why KeyVersion stays "2". `layers=` never appears there: event backdrops mount no layer variants.
    // `frame=` is the events COUNTERPART of the combat digest: the LIVE backdrop container transform the tracker
    // probed (the recovered placement lerp has drifted from the shipped game — measured container y 99.4 vs the
    // lerp's 40 on Neow), qualifying a variant exactly the way a layer digest does. Frame-less = the
    // deterministic reference-lerp variant (what the prerender sweep bakes and the wire fallback asks for).
    public static string BuildCacheKey(StaticBackgroundFamily family, string id, string? layersDigest, string? eventFrame = null)
        => $"bg://{FamilyPathPrefix(family)}{id}?w={RenderWidthPx}&h={RenderHeightPx}"
           + (layersDigest is null ? string.Empty : $"&layers={layersDigest}")
           + (eventFrame is null ? string.Empty : $"&frame={eventFrame}")
           + $"&v={KeyVersion}";

    private static string FamilyPathPrefix(StaticBackgroundFamily family)
        => family switch
        {
            StaticBackgroundFamily.Events => "events/",
            StaticBackgroundFamily.Rooms => "rooms/",
            _ => string.Empty,
        };

    /// <summary>
    /// The canonical frame-spec formatting — invariant culture, 0.1px positions, 0.001 scale — so the same live
    /// transform always mints the same URL (the frame IS a cache-key component).
    /// </summary>
    public static string FormatEventFrameSpec(double x, double y, double scale)
        => string.Create(
            System.Globalization.CultureInfo.InvariantCulture,
            $"{x:0.0},{y:0.0},{scale:0.000}");

    /// <summary>Frame-spec shape guard for the route: "x,y,scale" with bounded, sane numbers.</summary>
    public static bool IsValidEventFrameSpec(string spec)
        => System.Text.RegularExpressions.Regex.IsMatch(
            spec,
            @"^-?\d{1,5}(\.\d)?,-?\d{1,5}(\.\d)?,\d{1,2}(\.\d{1,3})?$");

    /// <summary>
    /// The ready-to-fetch `/bg/` URL for a background variant — the exact grammar the route parses back:
    /// <c>/bg/&lt;id&gt;?layers=&lt;digest&gt;&amp;v=1</c> (digest-absent = deterministic variant). The digest in
    /// the URL is what keeps the bytes cache-stable under the route's immutable caching: a NEW layer variant mints
    /// a NEW URL (via the envelope descriptor) instead of new bytes under the old one.
    /// </summary>
    /// <remarks>
    /// NO file extension, deliberately. It used to be <c>.png</c>, which stopped being true the moment the encoder
    /// became a policy (<see cref="RenderCodec"/>) — and pinning the codec into the path means every future codec
    /// change also has to move the URL, the client fallback and the route grammar together. <c>Content-Type</c> is
    /// the authoritative answer to "what is this image", so the path names only the thing that never changes: which
    /// background variant it is. The route still accepts the old suffixed forms so a stale tab resolves.
    /// </remarks>
    public static string BuildImageUrl(string id, string? layersDigest)
        => BuildImageUrl(StaticBackgroundFamily.Combat, id, layersDigest);

    /// <summary>
    /// Family-aware URL minting: events ride <c>/bg/events/&lt;id&gt;?[frame=&lt;spec&gt;&amp;]v=1</c> — always
    /// digest-less, optionally frame-qualified (see BuildCacheKey).
    /// </summary>
    public static string BuildImageUrl(StaticBackgroundFamily family, string id, string? layersDigest, string? eventFrame = null)
        => $"/bg/{FamilyPathPrefix(family)}{id}?"
           + (layersDigest is null ? string.Empty : $"layers={layersDigest}&")
           + (eventFrame is null ? string.Empty : $"frame={Uri.EscapeDataString(eventFrame)}&")
           + $"v={KeyVersion}";

    /// <summary>
    /// Serve the static background image for <paramref name="id"/>. <paramref name="layerScenePaths"/> is the
    /// ORDERED mounted layer set to render (must correspond to <paramref name="layersDigest"/>); null renders the
    /// deterministic-discovery variant. <paramref name="allowRender"/> false = cache-only (the route's stale-digest
    /// rule: a digest that is no longer the tracker's CURRENT variant serves disk bytes or 404s — rendering "some"
    /// layer set under an immutable URL that names another is the one forbidden outcome).
    /// </summary>
    public Task<CouchCoopStaticBackgroundResult> GetImageAsync(
        string id,
        string? layersDigest,
        IReadOnlyList<string>? layerScenePaths,
        bool allowRender = true,
        CancellationToken cancellationToken = default)
        => GetImageAsync(StaticBackgroundFamily.Combat, id, layersDigest, layerScenePaths, allowRender, cancellationToken);

    /// <summary>
    /// Family-aware core; the digest/layer parameters are a COMBAT concept and must be null for events, and
    /// <paramref name="eventFrame"/> (the tracker-probed live frame spec) is an EVENTS concept and must be null
    /// for combat.
    /// </summary>
    public async Task<CouchCoopStaticBackgroundResult> GetImageAsync(
        StaticBackgroundFamily family,
        string id,
        string? layersDigest,
        IReadOnlyList<string>? layerScenePaths,
        bool allowRender = true,
        CancellationToken cancellationToken = default,
        string? eventFrame = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        if (family != StaticBackgroundFamily.Combat && (layersDigest is not null || layerScenePaths is not null))
        {
            // Internal misuse, not a client input: the route 400s an event URL carrying `layers=` before it
            // gets here, so a digest on this path means a caller confused the two families' grammars.
            throw new ArgumentException("Event backgrounds are digest-less; layers are a combat-family concept.", nameof(layersDigest));
        }

        if (family == StaticBackgroundFamily.Combat && eventFrame is not null)
        {
            throw new ArgumentException("Frame specs are an event-family concept.", nameof(eventFrame));
        }

        cancellationToken.ThrowIfCancellationRequested();

        var cacheKey = BuildCacheKey(family, id, layersDigest, eventFrame);
        lock (_memoryGate)
        {
            if (_memory.TryGetValue(cacheKey, out var inMemory))
            {
                return CouchCoopStaticBackgroundResult.Memory(inMemory.Bytes, inMemory.ContentType);
            }
        }

        var cached = await _cache.TryReadAsync(cacheKey, cancellationToken).ConfigureAwait(false);
        if (cached is not null && cached.ContentType.StartsWith("image/", StringComparison.Ordinal))
        {
            StoreMemory(cacheKey, cached.Bytes, cached.ContentType);
            return CouchCoopStaticBackgroundResult.Hit(cached.Bytes, cached.ContentType);
        }

        if (!allowRender)
        {
            // Stale digest (the tracker has re-pointed the envelope at a newer variant): the client fail-opens on
            // this 404 and re-fetches off the next publish.
            return CouchCoopStaticBackgroundResult.Failure(new CouchCoopAssetHttpError(
                "unknown-background-variant",
                "The requested background layer variant is not cached and is no longer the current one.",
                "key",
                cacheKey));
        }

        if (_isHeadlessClient)
        {
            // Headless guard (belt): a dummy-renderer seat process cannot render — its viewport produces empty
            // frames — so it serves disk-or-503 only. Asset HTTP normally goes to the HOST origin anyway; a 503
            // tells a stray direct fetch to retry against a host that can actually render.
            return CouchCoopStaticBackgroundResult.Unavailable(new CouchCoopAssetHttpError(
                "static-bg-unavailable",
                "This headless instance cannot render backgrounds; fetch from the host origin.",
                "key",
                cacheKey));
        }

        // Single-flight: the per-request cancellation token is intentionally NOT threaded into the shared
        // extraction — one caller cancelling must not abort the render others are awaiting. The extraction
        // is bounded by the bridge itself. (Same contract as CouchCoopSpineClipProvider.GetClipAsync.)
        var lazy = InFlight.GetOrAdd(
            cacheKey,
            key => new Lazy<Task<CouchCoopStaticBackgroundResult>>(
                () => ExtractAsync(family, id, layersDigest, layerScenePaths, eventFrame, key),
                LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            return await lazy.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            InFlight.TryRemove(cacheKey, out _);
        }
    }

    private async Task<CouchCoopStaticBackgroundResult> ExtractAsync(
        StaticBackgroundFamily family,
        string id,
        string? layersDigest,
        IReadOnlyList<string>? layerScenePaths,
        string? eventFrame,
        string cacheKey)
    {
        RenderChainResult chain;
        // Queue time for the shared admission gate is part of what a client waits for and is invisible to the
        // render lane, so it is timed here and merged into the same phase table the lane produced.
        var gateWaitStarted = Stopwatch.GetTimestamp();
        await CouchCoopAssetExtractionGate.Gate.WaitAsync().ConfigureAwait(false);
        var gateWaitMs = ElapsedMs(gateWaitStarted);
        try
        {
            // GetAsset marshals the render to the Godot main thread and blocks; offload so the awaiting request
            // thread(s) aren't parked. The SHARED gate (above) keeps this render from overlapping a spine bake.
            chain = await Task.Run(
                () => family switch
                {
                    StaticBackgroundFamily.Events => RenderEventScene(id, eventFrame, RenderWidthPx, RenderHeightPx),
                    StaticBackgroundFamily.Rooms => RenderRoomSubtree(id, eventFrame, RenderWidthPx, RenderHeightPx),
                    _ => RenderWithFallback(id, layersDigest, layerScenePaths, RenderWidthPx, RenderHeightPx),
                })
                .ConfigureAwait(false);
        }
        catch (NotSupportedException exception)
        {
            return CouchCoopStaticBackgroundResult.Failure(new CouchCoopAssetHttpError(
                CouchCoopRuntimeHost.AssetExtractionCapability,
                exception.Message,
                "capabilityId",
                CouchCoopRuntimeHost.AssetExtractionCapability));
        }
        finally
        {
            CouchCoopAssetExtractionGate.Gate.Release();
        }

        var result = chain.Result;
        if (!result.Success || result.Payload is null || result.Payload.Contents.Length == 0)
        {
            PublishSamples(chain, gateWaitMs, cacheWriteMs: null);
            return CouchCoopStaticBackgroundResult.Failure(result.Error is null
                ? new CouchCoopAssetHttpError("missing-background", "Background image was not found.", "key", cacheKey)
                : CouchCoopAssetHttpError.FromEmbeddable(result.Error));
        }

        // Fall back to the SHIPPED codec's type, never a hardcoded image/png: announcing JPEG bytes as PNG is the
        // one thing an extension-free URL cannot survive, since Content-Type is now the only answer there is.
        var contentType = string.IsNullOrWhiteSpace(result.Payload.ContentType)
            ? ShippedCodec.ContentType
            : result.Payload.ContentType;
        var bytes = result.Payload.Contents;

        // Populate the MEMORY map BEFORE the (slow, best-effort) disk write and before any waiter resumes, so the
        // burst of simultaneous askers that single-flighted onto this render all serve from RAM immediately.
        StoreMemory(cacheKey, bytes, contentType);
        var cacheWriteStarted = Stopwatch.GetTimestamp();
        if (!await _cache.TryWriteAsync(cacheKey, bytes, contentType).ConfigureAwait(false))
        {
            // Best-effort cache; serve the freshly rendered image even if the write-through fails.
            _cacheDiagnostics.Write("static-bg-cache-write-failed", $"[couch-coop] static-bg cache write failed key={cacheKey}");
        }

        // Published only now: the requester is still blocked on the write-through, so it belongs in the same
        // phase table as the render it followed rather than being invisible.
        PublishSamples(chain, gateWaitMs, ElapsedMs(cacheWriteStarted));
        return CouchCoopStaticBackgroundResult.Miss(bytes, contentType);
    }

    private static double ElapsedMs(long startedTimestamp)
        => (Stopwatch.GetTimestamp() - startedTimestamp) * 1000.0 / Stopwatch.Frequency;

    /// <summary>
    /// Record the chain's samples, merging this side's phases into the LAST rung — the one that actually produced
    /// the served bytes. An earlier (failed) rung keeps its own phases untouched: its render really did happen,
    /// and the gate wait/cache write were not part of it.
    /// </summary>
    private static IReadOnlyList<StaticBackgroundRenderMetrics.Sample> PublishSamples(
        RenderChainResult chain,
        double gateWaitMs,
        double? cacheWriteMs)
    {
        var published = new List<StaticBackgroundRenderMetrics.Sample>(chain.Samples.Count);
        for (var index = 0; index < chain.Samples.Count; index++)
        {
            var sample = chain.Samples[index];
            if (index == chain.Samples.Count - 1)
            {
                var phases = sample.PhaseCosts.ToList();
                // Only decorate a table that HAS phases: appending to an empty one would turn "the render lane
                // was not recording" into a table that claims the whole render was gate wait.
                if (phases.Count > 0)
                {
                    phases.Add(HostRenderPhases.Phase(HostRenderPhases.GateWait, gateWaitMs));
                    if (cacheWriteMs is { } writeMs)
                    {
                        phases.Add(HostRenderPhases.Phase(HostRenderPhases.CacheWrite, writeMs));
                    }

                    sample = sample with { Phases = phases };
                }
            }

            StaticBackgroundRenderMetrics.Record(sample);
            published.Add(sample);
        }

        return published;
    }

    // The three-step render chain (runs synchronously inside Task.Run, under the shared extraction gate):
    //   1. composed://combat-background/<id>/image with the EXPLICIT mounted-layer CompositionSelector,
    //   2. same composed key with a null selector (spirectl's deterministic-first-sorted discovery),
    //   3. the literal res://scenes/backgrounds/<id>/<id>_background.tscn scene key.
    // Every step honors RenderWidth/RenderHeight (the literal combat-bg branch re-centers on the requested
    // viewport too), so the fallback stays 2520x1080. A selector failure reports failure field
    // "composition_selector"; we fall through on ANY failure — the next rung can only be more conservative.
    //
    // S10 instrument: width/height are PARAMETERS rather than the constants read inline, so the measurement
    // route can price a second size. Every production caller passes RenderWidthPx/RenderHeightPx — the shipped
    // policy is unchanged. Each rung's wall time, output size and PHASE BREAKDOWN come back on the result; the
    // caller records them once it also knows this side's queue/disk phases (see PublishSamples).
    //
    // `codec` is the bench's second knob (the shipped policy is always lossless PNG with alpha): the encode is the
    // single biggest segment of every render, so "would another encoder be cheaper, and at what fidelity?" is a
    // question the instrument must be able to ANSWER rather than estimate. Bench-only bytes are never served or
    // cached.
    private RenderChainResult RenderWithFallback(
        string id,
        string? layersDigest,
        IReadOnlyList<string>? layerScenePaths,
        int renderWidthPx,
        int renderHeightPx,
        bool bench = false,
        StaticBackgroundRenderMetrics.BenchCodec? codec = null)
    {
        var encode = codec ?? ShippedCodec;
        var composedKey = $"composed://combat-background/{id}/image";
        var samples = new List<StaticBackgroundRenderMetrics.Sample>(3);

        EmbeddableAssetResult result;
        if (layerScenePaths is { Count: > 0 })
        {
            result = TimeRender(
                id,
                renderWidthPx,
                renderHeightPx,
                "selector",
                bench,
                encode,
                samples,
                requestId => _assets.GetAsset(new EmbeddableAssetRequest(
                    composedKey,
                    encode.Codec,
                    requestId,
                    RenderWidth: renderWidthPx,
                    RenderHeight: renderHeightPx,
                    CompositionSelector: string.Join(',', layerScenePaths),
                    ImageQuality: encode.Quality,
                    ImageOpaque: encode.Opaque)));
            if (IsUsable(result))
            {
                return new RenderChainResult(result, samples);
            }

            _log($"[couch-coop] static-bg selector render failed id={id} field={result.Error?.Field} code={result.Error?.Code}; retrying deterministic discovery");
        }

        result = TimeRender(
            id,
            renderWidthPx,
            renderHeightPx,
            "discovery",
            bench,
            encode,
            samples,
            requestId => _assets.GetAsset(new EmbeddableAssetRequest(
                composedKey,
                encode.Codec,
                requestId,
                RenderWidth: renderWidthPx,
                RenderHeight: renderHeightPx,
                ImageQuality: encode.Quality,
                ImageOpaque: encode.Opaque)));
        if (IsUsable(result))
        {
            return new RenderChainResult(result, samples);
        }

        _log($"[couch-coop] static-bg composed render failed id={id} code={result.Error?.Code}; retrying literal scene");
        result = TimeRender(
            id,
            renderWidthPx,
            renderHeightPx,
            "literal",
            bench,
            encode,
            samples,
            requestId => _assets.GetAsset(new EmbeddableAssetRequest(
                $"res://scenes/backgrounds/{id}/{id}_background.tscn",
                encode.Codec,
                requestId,
                RenderWidth: renderWidthPx,
                RenderHeight: renderHeightPx,
                ImageQuality: encode.Quality,
                ImageOpaque: encode.Opaque)));
        return new RenderChainResult(result, samples);
    }

    // One rung of the chain, timed. The Stopwatch brackets the main-thread marshalled GetAsset call — i.e. the
    // whole render wall time as the request thread experiences it, which is the number a client waits on.
    //
    // The process CPU counter is read at the SAME two points, so `CpuMs` and `RenderMs` describe exactly the same
    // interval and their ratio is a real core count rather than two clocks compared across different spans. It is
    // process-wide (see ProcessCpuMetrics): an upper bound on the render's own CPU, which for a seconds-scale
    // foreground render is dominated by the render itself.
    //
    // The request id is minted PER RUNG (not per request) because it is the key the render lane's phase
    // breakdown is filed under: two rungs sharing one id would let the second drain the first's table.
    private static EmbeddableAssetResult TimeRender(
        string id,
        int widthPx,
        int heightPx,
        string rung,
        bool bench,
        StaticBackgroundRenderMetrics.BenchCodec codec,
        List<StaticBackgroundRenderMetrics.Sample> samples,
        Func<string, EmbeddableAssetResult> render)
    {
        var requestId = $"bg:{id}:{rung}:{Guid.NewGuid():N}";
        var cpuMark = ProcessCpuMetrics.TryMark();
        var started = Stopwatch.GetTimestamp();
        var result = render(requestId);
        var elapsedMs = (Stopwatch.GetTimestamp() - started) * 1000.0 / Stopwatch.Frequency;
        var cpuWindow = ProcessCpuMetrics.TryClose(cpuMark);
        // Drained ONCE: the phase table and the counters that explain it come from the same snapshot, so they
        // can never describe two different renders.
        var phases = Sts2RenderPhaseProfile.TryTake(requestId);
        samples.Add(new StaticBackgroundRenderMetrics.Sample(
            TimestampMs: Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency,
            Id: id,
            WidthPx: widthPx,
            HeightPx: heightPx,
            RenderMs: elapsedMs,
            OutputBytes: result.Payload?.Contents.Length ?? 0,
            Rung: rung,
            Success: IsUsable(result),
            Bench: bench,
            CpuMs: cpuWindow?.CpuMs,
            CpuWallMs: cpuWindow?.WallMs,
            Codec: codec.Label,
            Phases: phases?.Phases,
            Counters: phases?.Counters));
        return result;
    }

    // The EVENT family's render "chain": ONE literal-scene rung. There is no composed key and no layer variant
    // for an event backdrop — the scene file IS the whole picture — so the combat chain's selector/discovery
    // rungs have nothing to select or discover. The metric id is namespaced (`events/<id>`) so /perf/bg.json
    // rows can never collide with a combat background that happens to share the name.
    private RenderChainResult RenderEventScene(string id, string? eventFrame, int renderWidthPx, int renderHeightPx)
    {
        var encode = ShippedCodec;
        var samples = new List<StaticBackgroundRenderMetrics.Sample>(1);
        var result = TimeRender(
            $"events/{id}",
            renderWidthPx,
            renderHeightPx,
            "literal",
            bench: false,
            encode,
            samples,
            requestId => _assets.GetAsset(new EmbeddableAssetRequest(
                BackgroundSceneFamilies.BuildEventBackgroundScenePath(id),
                encode.Codec,
                requestId,
                RenderWidth: renderWidthPx,
                RenderHeight: renderHeightPx,
                ImageQuality: encode.Quality,
                ImageOpaque: encode.Opaque,
                EventBackgroundFrame: eventFrame)));
        return new RenderChainResult(result, samples);
    }

    // The ROOMS family: one scene-subtree:// rung addressing the room's inline backdrop subtree (the committed
    // table names it) — the subtree is detached from a never-tree-entered instantiation on the spirectl side, so
    // the room's interactive scripts (NMerchantHand) never run. Frame semantics identical to the event rung.
    private RenderChainResult RenderRoomSubtree(string id, string? frame, int renderWidthPx, int renderHeightPx)
    {
        var scenePath = BackgroundSceneFamilies.BuildRoomScenePath(id);
        var subtree = BackgroundSceneFamilies.RoomBackgroundSubtrees.TryGetValue(scenePath, out var nodePath)
            ? nodePath
            : null;
        var encode = ShippedCodec;
        var samples = new List<StaticBackgroundRenderMetrics.Sample>(1);
        var result = TimeRender(
            $"rooms/{id}",
            renderWidthPx,
            renderHeightPx,
            "subtree",
            bench: false,
            encode,
            samples,
            requestId => _assets.GetAsset(new EmbeddableAssetRequest(
                $"scene-subtree://{scenePath}?node={Uri.EscapeDataString(subtree ?? string.Empty)}",
                encode.Codec,
                requestId,
                RenderWidth: renderWidthPx,
                RenderHeight: renderHeightPx,
                ImageQuality: encode.Quality,
                ImageOpaque: encode.Opaque,
                EventBackgroundFrame: frame)));
        return new RenderChainResult(result, samples);
    }

    /// <summary>One pass of the fallback chain: what it produced, and the per-rung samples it measured.</summary>
    private sealed record RenderChainResult(
        EmbeddableAssetResult Result,
        IReadOnlyList<StaticBackgroundRenderMetrics.Sample> Samples);

    /// <summary>
    /// S10 MEASUREMENT path (route-gated behind <c>COUCHCOOP_BG_BENCH=1</c>): render <paramref name="id"/> at an
    /// explicit size and encode candidate, bypassing BOTH caches in both directions. Nothing it produces is ever
    /// served or stored under a policy key — a non-policy render must not land under one, and the immutable
    /// <c>/bg/</c> URLs must keep meaning exactly one byte stream. Returns the samples the render chain recorded.
    /// </summary>
    /// <param name="dumpPath">
    /// Optional artifact path for the encoded bytes. A LOSSY candidate's cost is only half its story — the other
    /// half is what it did to the picture, and there is no other way to get real bytes at real encoder settings
    /// out of the host (the render-size fields are embeddable-only, so the CLI cannot ask for 2520x1080). The
    /// caller owns the path: this method never derives one from request input. Best-effort — a failed dump is
    /// logged and never fails the measurement.
    /// </param>
    public async Task<IReadOnlyList<StaticBackgroundRenderMetrics.Sample>> MeasureRenderAsync(
        string id,
        IReadOnlyList<string>? layerScenePaths,
        int widthPx,
        int heightPx,
        StaticBackgroundRenderMetrics.BenchCodec? codec = null,
        string? dumpPath = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        cancellationToken.ThrowIfCancellationRequested();

        RenderChainResult chain;
        var gateWaitStarted = Stopwatch.GetTimestamp();
        await CouchCoopAssetExtractionGate.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        var gateWaitMs = ElapsedMs(gateWaitStarted);
        try
        {
            chain = await Task.Run(
                () => RenderWithFallback(id, layersDigest: null, layerScenePaths, widthPx, heightPx, bench: true, codec),
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            CouchCoopAssetExtractionGate.Gate.Release();
        }

        if (dumpPath is { Length: > 0 } && chain.Result.Payload is { Contents.Length: > 0 } payload)
        {
            using var reservation = _cache.Quota?.TryReserve(payload.Contents.LongLength);
            if (reservation is null)
            {
                _log($"[couch-coop] static-bg bench dump refused by managed-cache quota path={dumpPath}");
            }
            else try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(dumpPath)!);
                var temp = dumpPath + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
                try
                {
                    await File.WriteAllBytesAsync(temp, payload.Contents, cancellationToken).ConfigureAwait(false);
                    File.Move(temp, dumpPath, overwrite: true);
                }
                finally
                {
                    try { File.Delete(temp); }
                    catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                }
            }
            catch (Exception exception)
            {
                _log($"[couch-coop] static-bg bench dump failed path={dumpPath} error={exception.GetType().Name}: {exception.Message}");
            }
        }

        // No cache write to price: a bench render is never stored (that is the point of the bench).
        return PublishSamples(chain, gateWaitMs, cacheWriteMs: null);
    }

    private static bool IsUsable(EmbeddableAssetResult result)
        => result.Success && result.Payload is { Contents.Length: > 0 };

    private void StoreMemory(string cacheKey, byte[] bytes, string contentType)
    {
        lock (_memoryGate)
        {
            if (_memory.ContainsKey(cacheKey))
            {
                _memory[cacheKey] = (bytes, contentType);
                return; // already in the recency queue; refreshing bytes never grows the map
            }

            _memory[cacheKey] = (bytes, contentType);
            _memoryOrder.Enqueue(cacheKey);
            while (_memoryOrder.Count > MemoryCapacity)
            {
                _memory.Remove(_memoryOrder.Dequeue());
            }
        }
    }
}

/// <param name="CacheStatus">Rides the route's <c>X-Cache</c> header verbatim: "memory" | "hit" | "miss".</param>
/// <param name="ServiceUnavailable">True = answer 503 (a headless seat that cannot render), not 404.</param>
public sealed record CouchCoopStaticBackgroundResult(
    byte[]? Bytes,
    string ContentType,
    string CacheStatus,
    CouchCoopAssetHttpError? Error,
    bool ServiceUnavailable = false)
{
    public static CouchCoopStaticBackgroundResult Memory(byte[] bytes, string contentType) => new(bytes, contentType, "memory", null);

    public static CouchCoopStaticBackgroundResult Hit(byte[] bytes, string contentType) => new(bytes, contentType, "hit", null);

    public static CouchCoopStaticBackgroundResult Miss(byte[] bytes, string contentType) => new(bytes, contentType, "miss", null);

    public static CouchCoopStaticBackgroundResult Failure(CouchCoopAssetHttpError error) => new(null, "application/octet-stream", "miss", error);

    public static CouchCoopStaticBackgroundResult Unavailable(CouchCoopAssetHttpError error) => new(null, "application/octet-stream", "miss", error, ServiceUnavailable: true);
}
