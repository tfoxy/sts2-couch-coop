using System.Diagnostics;
using System.Text.Json;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.Models;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Bakes every combat background the game can show, so a client's first <c>/bg/</c> fetch is a disk hit instead of
/// a render it waits on. The <c>/spines/</c> twin of this job (<see cref="CouchCoopSpinePrerenderJob"/>) has
/// existed since round 8; the background lane never had one, and a background render is the single most expensive
/// thing the host does on demand.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT MATTERS EVEN AFTER THE ENCODE MOVED OFF-THREAD (Aug-22 round 2): offloading turned ~650 ms of game
/// stall into ~650 ms of CLIENT LATENCY. The stall is gone either way, but the phone still waits for the first
/// picture of a room — and this is what removes that.
/// </para>
/// <para>
/// SCOPE, stated plainly: this bakes the DIGEST-LESS deterministic variant of each background, because that is
/// the only one knowable ahead of time. A live room randomizes which layer sub-scenes it mounts, and the URL the
/// envelope descriptor then points clients at is qualified by a digest of that mounted set — which no ahead-of-time
/// sweep can predict. So this warms exactly what the client's wire fallback asks for
/// (<c>StaticBackground.vue</c>'s deterministic URL), not the digest-qualified descriptor URL. Documented
/// limitation, not a defect.
/// </para>
/// <para>
/// Idempotent and re-runnable: an already-cached variant comes back as a cache hit and costs nothing, so a second
/// sweep against a warm cache renders zero.
/// </para>
/// </remarks>
public sealed class CouchCoopStaticBackgroundPrerenderJob(
    CouchCoopRuntimeHost runtime,
    CouchCoopStaticBackgroundProvider backgrounds,
    Action<string>? log = null)
{
    private readonly CouchCoopRuntimeHost _runtime = runtime ?? throw new ArgumentNullException(nameof(runtime));
    private readonly CouchCoopStaticBackgroundProvider _backgrounds = backgrounds ?? throw new ArgumentNullException(nameof(backgrounds));
    private readonly Action<string> _log = log ?? CouchCoopLog.Stderr;

    /// <summary>
    /// The model families that name a background root. The combat pair is required and the split is not obvious:
    /// <c>encounters</c> only carries a <c>BackgroundScenePath</c> for the handful of BOSS encounters with bespoke
    /// artwork (11 on the shipped game), while every ordinary combat room draws its act's background — which lives
    /// on <c>acts</c> (4). Sweeping encounters alone would prerender exactly the rooms a player sees least.
    /// <c>events</c> names the event backdrop scenes (Neow, ancient events — 8 on the shipped game), which the
    /// static-background feature also serves (<c>/bg/events/&lt;id&gt;</c>); their first fetch is MORE visible than
    /// combat's (there is no earlier combat fetch to hide behind), so they are warmed too.
    /// </summary>
    public static readonly IReadOnlyList<string> BackgroundModelFamilies = ["acts", "encounters", "events"];

    public async Task<CouchCoopStaticBackgroundPrerenderSummary> RunAsync(CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        var models = new List<GameModelSnapshot>();
        var catalogFailures = 0;
        foreach (var family in BackgroundModelFamilies)
        {
            ModelCatalogOperationResult catalog;
            try
            {
                // The model catalog is dispatched through the Godot bridge. Keep it off the mod initialization
                // thread so the browser listener stays available immediately (same contract as the spine sweep).
                catalog = await Task.Run(
                    () => _runtime.GetModels(new ModelCatalogRequestSnapshot(family, [])),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return Complete(stopwatch, "cancelled", 0, 0, 0, 0);
            }
            catch (Exception exception)
            {
                catalogFailures++;
                _log($"bg-prerender catalog failed family={family} detail={exception.GetType().Name}: {exception.Message}");
                continue;
            }

            if (catalog.Error is not null)
            {
                catalogFailures++;
                _log($"bg-prerender catalog failed family={family} code={catalog.Error.Code} detail={catalog.Error.Message}");
                continue;
            }

            _log($"bg-prerender catalog family={family} models={catalog.Models.Count} status={catalog.Status}");
            models.AddRange(catalog.Models);
        }

        if (models.Count == 0 && catalogFailures > 0)
        {
            return Complete(stopwatch, "failed", 0, 0, 0, catalogFailures);
        }

        var ids = DiscoverBackgroundIds(models);
        // ZERO DISCOVERED IS A REPORTED OUTCOME. A sweep that silently baked nothing and then announced success
        // would look exactly like a sweep that worked, and the next round would "verify" a prerender that never
        // happened. Say the count first, every time.
        _log($"bg-prerender discovered={ids.Count} models={models.Count} codec={CouchCoopStaticBackgroundProvider.ShippedCodec.Label}");
        if (ids.Count == 0)
        {
            return Complete(stopwatch, "empty", 0, 0, 0, catalogFailures);
        }

        var hits = 0;
        var rendered = 0;
        var failures = catalogFailures;
        var completed = 0;

        // Sequential on purpose: CouchCoopAssetExtractionGate serializes these renders against spine bakes and each
        // other anyway, so a fan-out here would only queue deeper, and a warmup render must never outrank a client.
        foreach (var (family, id) in ids)
        {
            completed++;
            // The logged id is the metric-namespaced one (`events/<id>` for the event family) so a prerender log
            // row and its /perf/bg.json row can never name two different things.
            var loggedId = family == StaticBackgroundFamily.Events ? $"events/{id}" : id;
            var itemWatch = Stopwatch.StartNew();
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                var image = await _backgrounds
                    .GetImageAsync(family, id, layersDigest: null, layerScenePaths: null, allowRender: true, cancellationToken)
                    .ConfigureAwait(false);

                if (image.Error is not null || image.Bytes is null || image.Bytes.Length == 0)
                {
                    failures++;
                    _log($"bg-prerender {completed}/{ids.Count} status=failed id={loggedId} detail={image.Error?.Message ?? "empty-render"} elapsedMs={itemWatch.ElapsedMilliseconds}");
                    continue;
                }

                if (image.CacheStatus is "hit" or "memory")
                {
                    hits++;
                    _log($"bg-prerender {completed}/{ids.Count} status=hit id={loggedId} bytes={image.Bytes.Length}");
                    continue;
                }

                rendered++;
                // The sweep IS the whole-catalog render benchmark, so each item carries its phase breakdown: a cold
                // prerender log is then a per-background answer to "where did the render time go".
                _log($"bg-prerender {completed}/{ids.Count} status=rendered id={loggedId} bytes={image.Bytes.Length} contentType={image.ContentType} elapsedMs={itemWatch.ElapsedMilliseconds}{DescribePhases()}");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return Complete(stopwatch, "cancelled", ids.Count, hits, rendered, failures);
            }
            catch (Exception exception)
            {
                failures++;
                _log($"bg-prerender {completed}/{ids.Count} status=failed id={loggedId} detail={exception.GetType().Name}: {exception.Message} elapsedMs={itemWatch.ElapsedMilliseconds}");
            }
        }

        return Complete(stopwatch, "complete", ids.Count, hits, rendered, failures);
    }

    /// <summary>
    /// The background targets a model set implies: every act's/encounter's <c>BackgroundScenePath</c> that follows
    /// the combat-background convention, and every event's that follows the event-backdrop convention — distinct,
    /// combat first (players spend most of a run there, so those warm first), each family ordered. Pure, so the
    /// mapping is testable without a game.
    /// </summary>
    /// <remarks>
    /// Filtering through <see cref="CouchCoopStaticBackgroundProvider.TryParseBackgroundId"/> /
    /// <see cref="CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId"/> is what keeps this honest: a
    /// model may name a per-layer sub-scene, a foreign-convention background, or nothing at all, and only a path
    /// of an exact family shape addresses a variant the <c>/bg/</c> route can actually serve. Many models share
    /// one background, hence the distinct.
    /// </remarks>
    public static IReadOnlyList<(StaticBackgroundFamily Family, string Id)> DiscoverBackgroundIds(
        IReadOnlyList<GameModelSnapshot> models)
    {
        ArgumentNullException.ThrowIfNull(models);
        var combatIds = new SortedSet<string>(StringComparer.Ordinal);
        var eventIds = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var model in models)
        {
            switch (model)
            {
                case ActGameModelSnapshot act:
                    AddCombat(act.BackgroundScenePath);
                    break;
                case EncounterGameModelSnapshot encounter:
                    AddCombat(encounter.BackgroundScenePath);
                    break;
                case EventGameModelSnapshot gameEvent:
                    if (CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(gameEvent.BackgroundScenePath) is { } eventId)
                    {
                        eventIds.Add(eventId);
                    }

                    break;
            }
        }

        return
        [
            .. combatIds.Select(id => (StaticBackgroundFamily.Combat, id)),
            .. eventIds.Select(id => (StaticBackgroundFamily.Events, id)),
        ];

        void AddCombat(string? scenePath)
        {
            if (CouchCoopStaticBackgroundProvider.TryParseBackgroundId(scenePath) is { } id)
            {
                combatIds.Add(id);
            }
        }
    }

    // The phase breakdown of the render that JUST finished — the newest sample in the ring, which under the
    // sweep's strictly sequential renders is this item's. Empty string when nothing was recorded, so the log line
    // degrades to what it would have printed anyway rather than to a row of zeros.
    private static string DescribePhases()
    {
        var samples = StaticBackgroundRenderMetrics.Snapshot();
        if (samples.Count == 0 || samples[^1].PhaseCosts.Count == 0)
        {
            return string.Empty;
        }

        var sample = samples[^1];
        return " " + Sts2RenderPhaseProfile.FormatLogLine(new Sts2RenderPhaseProfile.Snapshot(
            sample.Id,
            sample.RenderMs,
            sample.PhaseCosts.Where(phase => phase.Blocking).Sum(phase => phase.Ms),
            sample.PhaseCosts.Where(phase => !phase.Blocking).Sum(phase => phase.Ms),
            sample.PhaseCosts,
            sample.Counters ?? new Dictionary<string, long>()));
    }

    private CouchCoopStaticBackgroundPrerenderSummary Complete(
        Stopwatch stopwatch,
        string status,
        int discovered,
        int hits,
        int rendered,
        int failures)
    {
        stopwatch.Stop();
        var summary = new CouchCoopStaticBackgroundPrerenderSummary(
            status,
            discovered,
            hits,
            rendered,
            failures,
            CouchCoopStaticBackgroundProvider.ShippedCodec.Label,
            stopwatch.ElapsedMilliseconds);
        _log($"COUCHCOOP_BG_PRERENDER {JsonSerializer.Serialize(summary, JsonOptions)}");
        return summary;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}

/// <param name="Status">complete | empty | cancelled | failed.</param>
/// <param name="DiscoveredBackgrounds">
/// Distinct backgrounds the model catalog named, across BOTH families (combat + event backdrops). ZERO is a
/// real, reportable answer — see the log line in <see cref="CouchCoopStaticBackgroundPrerenderJob.RunAsync"/>.
/// </param>
public sealed record CouchCoopStaticBackgroundPrerenderSummary(
    string Status,
    int DiscoveredBackgrounds,
    int CacheHits,
    int RenderedBackgrounds,
    int Failures,
    string Codec,
    long ElapsedMs);
