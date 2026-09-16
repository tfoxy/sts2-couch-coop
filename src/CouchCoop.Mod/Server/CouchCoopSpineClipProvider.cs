using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Server;

// Produces a streamable Spine animation clip (a `spine://...` key -> SpineClipWire blob) for the
// `/spines/` route, in-process via the embeddable asset seam — so it never hits the standalone CLI's
// bridge-IPC payload cap (a full-screen background spine overflows that cap; the in-process call does
// not). Three concerns, layered:
//
//   1. Disk cache HIT  — a clip's frames are static per (scene, node, anim) within a game/mod version,
//      so a serialized blob on disk serves straight from the request thread with no Godot main-thread hop
//      (the extraction renders frame-by-frame on the main thread; ~1.5s for a 61-frame clip).
//   2. Single-flight    — the first request for an uncached key runs ONE extraction under a per-key
//      Lazy; any number of concurrent requests for the same key await that one task rather than each
//      kicking off their own (expensive) main-thread render.
//   3. Write-through    — the freshly extracted blob is cached before returning, so the next request HITs.
//
// Unlike the /res and /models seam (CachedSpirectlAssetHttpAdapter over ICouchCoopAssetHttpAdapter), this
// goes straight to ISpirectlAssetProvider: a Timeline payload carries its frames in payload.Frames, but
// the HTTP adapter flattens a result to a single payload.Contents blob and drops them. v1 fills the blob
// from the whole batch result at once; true mid-extraction progressive streaming (frames flushed as they
// encode) is a format-ready follow-up once the bridge exposes a per-frame callback.
public sealed class CouchCoopSpineClipProvider(
    ISpirectlAssetProvider assets,
    SpirectlAssetBinaryCache cache,
    Action<string>? log = null,
    Func<int>? gameInstances = null)
{
    public const string SpineClipSizePolicy = "codec=webp&fps=15&q=85";

    // The still tail every MINTED still key carries. `still=1` is the producer's own selector (Sts2AssetExtract's
    // key parser only accepts 1/true/on/yes); `sf` is an OPAQUE discriminator (same trick as WS-6's `mat`) that the
    // producer ignores and the disk cache keys on — it versions the STILL-FRAME POLICY, so bumping it invalidates
    // stills alone and leaves every cached full clip valid. sf=1 = "mid frame, last frame for die/defeat" (#14).
    public const string StillSelector = "&still=1&sf=1";

    // R10 PAUSED-STILL TIME. The still-frame policy above only GUESSES where a clip rests (mid frame, or the last
    // frame for a die/defeat). A track the GAME has explicitly PAUSED needs no guess — its frozen track time IS the
    // pose — and the guess is visibly wrong there: the treasure chest's sole clip is named "animation" (the lid
    // opening) and the room freezes it at t=0 for a CLOSED chest, so the mid-clip still rendered a half-open lid on
    // an untouched chest. `&t=<seconds>` (Sts2SpineStillFrame.ChooseSampleTime) pins the sample; the client sends it
    // ONLY for a paused node, so every other still keeps a byte-identical key. Quantized to 2 decimals because the
    // value is the clip cache key: an unrounded double would mint a fresh bake per millisecond of drift.
    private const int StillTimeDecimals = 2;

    // Upper bound on an accepted `&t=`. Spine clips are seconds long; anything past this is a garbled query (or a
    // wall-clock track time that ran away), and the render clamps to the real duration anyway.
    private const double MaxStillTimeSeconds = 600d;

    /// <summary>
    /// The quantized `&amp;t=` seconds string for a paused still, or null when there is nothing to pin (no value,
    /// negative, NaN/infinite, or out of range) — in which case the key keeps its byte-identical pre-R10 form.
    /// </summary>
    public static string? FormatStillTime(double? seconds)
    {
        if (seconds is not { } value
            || double.IsNaN(value)
            || double.IsInfinity(value)
            || value < 0d
            || value > MaxStillTimeSeconds)
        {
            return null;
        }

        return Math.Round(value, StillTimeDecimals).ToString("F" + StillTimeDecimals, CultureInfo.InvariantCulture);
    }

    private readonly ISpirectlAssetProvider _assets = assets ?? throw new ArgumentNullException(nameof(assets));
    private readonly SpirectlAssetBinaryCache _cache = cache ?? throw new ArgumentNullException(nameof(cache));
    private readonly Action<string> _log = log ?? CouchCoopLog.Stderr;
    private readonly RateLimitedDiagnosticLog _cacheDiagnostics = new(log ?? CouchCoopLog.Stderr);

    // Live count of STS2 instances on this machine (host + headless seats), sampled per admission. Null on a host
    // that could not resolve its seat table — the budget then behaves as "one instance" (never degrade), which is
    // the pre-#14 behavior.
    private readonly Func<int>? _gameInstances = gameInstances;

    // In-flight extractions only — an entry is removed once its task settles, so the map holds at most one
    // Lazy per concurrently-requested key (the disk cache is the durable store). Keyed by the canonical
    // spine:// key minted by the route, so two requests for the same clip coalesce.
    private static readonly ConcurrentDictionary<string, Lazy<Task<CouchCoopSpineClipResult>>> InFlight = new(StringComparer.Ordinal);

    // Selector order (WS-spine wire contract, FIXED): node → anim → skin → mat → skel → policy → retry. Each
    // optional selector is appended only when present. `skin`
    // folds the runtime skin into the clip identity (#3); `mat` folds the SHADER MATERIAL the bake applies to a
    // standalone-skeleton render (#8 — the boss map point's channel-remap mask, re-tinted per act + travel state,
    // so the pixels depend on values outside the address); `skel` is the one-shot skeleton-fallback retry key (#8);
    // `retry=1` is the one-shot budget-collapse escalation key. The size policy always rides after skel;
    // `still` stays last (byte-identical stills).
    public static string BuildSpineKey(
        string sceneResPath,
        string? nodePath,
        string? animationName,
        bool still = false,
        string? skin = null,
        string? skel = null,
        bool retry = false,
        string? mat = null,
        // R10: the PAUSED track time a still should sample (see FormatStillTime / StillSelector). Rides the still
        // tail, so it is present only on a still key AND only when the client actually pinned a time — every other
        // key (including every animated clip) is byte-identical to the pre-R10 form.
        double? stillTimeSeconds = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sceneResPath);
        if (!still)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(animationName);
        }

        var scene = sceneResPath.StartsWith("res://", StringComparison.Ordinal)
            ? sceneResPath["res://".Length..]
            : sceneResPath;
        scene = scene.Trim().Trim('/');
        if (scene.Length == 0 || scene.Contains("://", StringComparison.Ordinal))
        {
            throw new ArgumentException("The scene path must be a non-empty res:// path.", nameof(sceneResPath));
        }

        var query = new StringBuilder();
        void Append(string selector)
        {
            if (query.Length > 0)
            {
                query.Append('&');
            }

            query.Append(selector);
        }

        if (!string.IsNullOrWhiteSpace(nodePath))
        {
            Append($"node={nodePath.Trim()}");
        }

        if (!string.IsNullOrWhiteSpace(animationName))
        {
            Append($"anim={animationName.Trim()}");
        }

        if (!string.IsNullOrWhiteSpace(skin))
        {
            Append($"skin={skin.Trim()}");
        }

        if (!string.IsNullOrWhiteSpace(mat))
        {
            Append($"mat={mat.Trim()}");
        }

        if (!string.IsNullOrWhiteSpace(skel))
        {
            Append($"skel={skel.Trim()}");
        }

        Append(SpineClipSizePolicy); // always present (its own codec&fps&q are already &-joined)

        if (retry)
        {
            Append("retry=1");
        }

        var stillTail = still
            ? StillSelector + (FormatStillTime(stillTimeSeconds) is { } t ? $"&t={t}" : string.Empty)
            : string.Empty;
        return $"spine://{scene}?{query}{stillTail}";
    }

    /// <summary>
    /// The SINGLE-FRAME key for the same clip identity — what a DEGRADED admission serves instead of a full bake
    /// (#14). Byte-identical to <see cref="BuildSpineKey"/>'s still form for that identity, so a degraded response
    /// reuses (and populates) the ordinary still cache entry: under pressure the answer is usually a disk HIT.
    /// Returns null when there is nothing to degrade to — the key IS already a still.
    /// </summary>
    /// <remarks>
    /// The one-shot <c>&amp;retry=1</c> selector is stripped first: it only ever addressed a fresh FULL bake, so
    /// keeping it would mint a second, pointless still entry per escalated identity.
    /// </remarks>
    public static string? ToDegradedStillKey(string spineKey)
    {
        if (string.IsNullOrWhiteSpace(spineKey) || spineKey.Contains("&still=", StringComparison.Ordinal))
        {
            return null;
        }

        var trimmed = spineKey.TrimEnd();
        var retryAt = trimmed.LastIndexOf("&retry=1", StringComparison.Ordinal);
        if (retryAt > 0)
        {
            trimmed = trimmed[..retryAt];
        }

        return trimmed + StillSelector;
    }

    public async Task<CouchCoopSpineClipResult> GetClipAsync(string spineKey, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spineKey);
        cancellationToken.ThrowIfCancellationRequested();

        var cached = await _cache.TryReadAsync(spineKey, cancellationToken).ConfigureAwait(false);
        if (cached is not null && string.Equals(cached.ContentType, SpineClipWire.ContentType, StringComparison.Ordinal))
        {
            return CouchCoopSpineClipResult.Hit(cached.Bytes);
        }

        // Single-flight: the per-request cancellation token is intentionally NOT threaded into the shared
        // extraction — one caller cancelling must not abort the render others are awaiting. The extraction
        // is bounded by the bridge itself.
        var lazy = InFlight.GetOrAdd(
            spineKey,
            key => new Lazy<Task<CouchCoopSpineClipResult>>(
                () => ExtractAsync(key),
                LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            return await lazy.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            InFlight.TryRemove(spineKey, out _);
        }
    }

    /// <summary>
    /// MEASUREMENT path (route-gated behind <c>COUCHCOOP_SPINE_BENCH=1</c>): bake <paramref name="spineKey"/>
    /// with the disk cache bypassed in BOTH directions, so the phase breakdown describes a cold bake rather than
    /// a cache read. Nothing it produces is served or stored — a bench must not be able to change what a client
    /// gets, and a bake is already addressed by a cache key whose bytes must keep meaning one thing.
    /// </summary>
    /// <remarks>
    /// It goes through the ordinary extraction gate and the ordinary degraded-admission check, so what it prices
    /// is the bake a client would really get on this machine right now — including a degradation to a still.
    /// </remarks>
    public async Task<IReadOnlyList<SpineBakeMetrics.Sample>> MeasureBakeAsync(
        string spineKey,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(spineKey);
        cancellationToken.ThrowIfCancellationRequested();

        var before = SpineBakeMetrics.Snapshot().Count;
        var bake = SpineBakeRecorder.Start(spineKey, "bench");
        await ExtractionGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        bake.GateAdmitted();
        try
        {
            var result = await Task.Run(
                () => _assets.GetAsset(new EmbeddableAssetRequest(spineKey, "auto", bake.RequestId)),
                cancellationToken).ConfigureAwait(false);
            bake.RenderReturned();
            var frames = result.Payload?.Frames ?? [];
            if (result.Success && frames.Count > 0)
            {
                bake.Succeeded(frames.Sum(frame => frame.Contents.Length), frames.Count);
            }
            else
            {
                bake.Failed();
            }
        }
        catch (Exception) when (BenchFailureRecorded(bake))
        {
            throw; // unreachable: the filter always returns false after recording
        }
        finally
        {
            ExtractionGate.Release();
        }

        return [.. SpineBakeMetrics.Snapshot().Skip(before)];
    }

    // An exception filter, not a catch: it records the failed bake and then declines to handle, so the caller
    // still sees the original exception with its stack intact.
    private static bool BenchFailureRecorded(SpineBakeRecorder bake)
    {
        bake.Failed();
        return false;
    }

    // The host-wide main-thread extraction admission gate, SHARED with the static-background provider — see
    // CouchCoopAssetExtractionGate for the ENet-tick hazard that mandates serializing these renders.
    private static SemaphoreSlim ExtractionGate => CouchCoopAssetExtractionGate.Gate;

    // Sample the live instance count and publish it to the producer's encode budget. Called at every bake
    // admission, so the encode fan-out tracks seats joining/leaving without any seat-change plumbing of its own.
    // Never throws: a failing sampler degrades to "one instance" (the pre-#14 behavior).
    private int SampleGameInstances()
    {
        var instances = 1;
        try
        {
            instances = Math.Max(1, _gameInstances?.Invoke() ?? 1);
        }
        catch
        {
            instances = 1;
        }

        Sts2RenderEncodeBudget.GameInstances = instances;
        return instances;
    }

    private async Task<CouchCoopSpineClipResult> ExtractAsync(string spineKey)
    {
        // ADMISSION (#14). A full clip bake is expensive main-thread work; when this machine is already running
        // one game instance per core, serve the SINGLE-FRAME still for the same identity instead of baking. The
        // still key is the ordinary one, so this both reuses and populates the still cache (usually a disk HIT),
        // and the result is flagged Degraded: it is NEVER written under the full-clip key and NEVER escalated by a
        // client, so the next request once the pressure drops bakes the real clip. Sampled per request — nothing
        // latches. A still request is already single-frame, so it is never degraded (ToDegradedStillKey => null).
        var degradedKey = ToDegradedStillKey(spineKey);
        if (degradedKey is not null)
        {
            var instances = SampleGameInstances();
            if (SpineBakeBudget.ShouldDegrade(instances, SpineBakeBudget.InstanceLimit))
            {
                _log($"spine-clip degraded instances={instances} limit={SpineBakeBudget.InstanceLimit} key={spineKey}");
                var degraded = await GetClipAsync(degradedKey).ConfigureAwait(false);
                return degraded with { Degraded = true };
            }
        }

        EmbeddableAssetResult result;
        var bake = SpineBakeRecorder.Start(spineKey, "clip-wire");
        await ExtractionGate.WaitAsync().ConfigureAwait(false);
        bake.GateAdmitted();
        try
        {
            // GetAsset marshals the render to the Godot main thread and blocks; offload so the awaiting
            // request thread(s) aren't parked and the result is a shareable task. The gate (above) bounds how
            // many of these main-thread renders run at once.
            result = await Task.Run(() => _assets.GetAsset(new EmbeddableAssetRequest(spineKey, "auto", bake.RequestId))).ConfigureAwait(false);
        }
        catch (NotSupportedException exception)
        {
            bake.Failed();
            return CouchCoopSpineClipResult.Failure(new CouchCoopAssetHttpError(
                CouchCoopRuntimeHost.AssetExtractionCapability,
                exception.Message,
                "capabilityId",
                CouchCoopRuntimeHost.AssetExtractionCapability));
        }
        finally
        {
            ExtractionGate.Release();
        }

        bake.RenderReturned();
        if (!result.Success || result.Payload is null)
        {
            bake.Failed();
            return CouchCoopSpineClipResult.Failure(result.Error is null
                ? new CouchCoopAssetHttpError("missing-spine-clip", "Spine clip was not found.", "key", spineKey)
                : CouchCoopAssetHttpError.FromEmbeddable(result.Error));
        }

        var payload = result.Payload;
        if (payload.Frames.Count == 0)
        {
            // A non-timeline payload (e.g. a still) or a clip that rendered no frames — the route addresses
            // animation clips, so surface this as a structured miss rather than streaming an empty body.
            bake.Failed();
            return CouchCoopSpineClipResult.Failure(new CouchCoopAssetHttpError(
                "empty-spine-clip",
                "Spine clip produced no frames; addressed a still or an empty animation.",
                "key",
                spineKey));
        }

        var frames = payload.Frames
            .OrderBy(frame => frame.Index)
            .Select(frame => new SpineClipFrame(
                frame.Index,
                frame.OffsetX,
                frame.OffsetY,
                frame.Width,
                frame.Height,
                frame.DurationMs,
                frame.Contents))
            .ToList();
        var canvasWidth = payload.Frames.Max(frame => frame.CanvasWidth);
        var canvasHeight = payload.Frames.Max(frame => frame.CanvasHeight);
        var serialize = Stopwatch.GetTimestamp();
        var blob = SpineClipWire.Serialize(
            frames,
            canvasWidth,
            canvasHeight,
            payload.DurationMs,
            payload.ClipLocalX,
            payload.ClipLocalY,
            payload.ClipLocalWidth,
            payload.ClipLocalHeight);
        bake.Serialized(serialize);

        var cacheWrite = Stopwatch.GetTimestamp();
        var cacheWriteFailed = !await _cache.TryWriteAsync(spineKey, blob, SpineClipWire.ContentType).ConfigureAwait(false);
        if (cacheWriteFailed)
        {
            // Best-effort cache; serve the freshly rendered clip even if the write-through fails.
            _cacheDiagnostics.Write("spine-clip-cache-write-failed", $"spine-clip cache write failed key={spineKey}");
        }

        bake.CacheWritten(cacheWrite);
        bake.Succeeded(blob.Length, frames.Count);
        return CouchCoopSpineClipResult.Miss(blob, cacheWriteFailed);
    }
}

/// <param name="Degraded">
/// #14: this blob is the SINGLE-FRAME stand-in served because the machine was oversubscribed, not the clip that was
/// asked for. Two hard rules ride this flag: it is never cache-written under the full-clip key (the provider
/// returns the still's own cache entry instead), and the response tells the clients so, so neither escalates it
/// down the `&amp;retry=1` "the producer collapsed my clip" path nor persists it in a client-side cache.
/// </param>
public sealed record CouchCoopSpineClipResult(
    byte[]? Blob,
    string CacheStatus,
    CouchCoopAssetHttpError? Error,
    bool CacheWriteFailed = false,
    bool Degraded = false)
{
    public static CouchCoopSpineClipResult Hit(byte[] blob) => new(blob, "HIT", null);

    public static CouchCoopSpineClipResult Miss(byte[] blob, bool cacheWriteFailed = false)
        => new(blob, "MISS", null, cacheWriteFailed);

    public static CouchCoopSpineClipResult Failure(CouchCoopAssetHttpError error) => new(null, "MISS", error);
}
