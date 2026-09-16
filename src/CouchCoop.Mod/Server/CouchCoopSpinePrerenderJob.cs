using System.Diagnostics;
using System.Text.Json;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Live;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Server;

public sealed class CouchCoopSpinePrerenderJob(
    CouchCoopRuntimeHost runtime,
    CouchCoopSpineClipProvider clips,
    Action<string>? log = null)
{
    private readonly CouchCoopRuntimeHost _runtime = runtime ?? throw new ArgumentNullException(nameof(runtime));
    private readonly CouchCoopSpineClipProvider _clips = clips ?? throw new ArgumentNullException(nameof(clips));
    private readonly Action<string> _log = log ?? CouchCoopLog.Stderr;

    public async Task<CouchCoopSpinePrerenderSummary> RunAsync(CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        SpineCatalogOperationResult catalog;
        try
        {
            // The live catalog and each render are dispatched through the Godot bridge. Keep the job off
            // the mod initialization thread so the browser listener remains available immediately.
            catalog = await Task.Run(
                () => _runtime.GetSpineCatalog(new SpineCatalogRequestSnapshot()),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return Complete(stopwatch, "cancelled", 0, 0, 0, 0, 0, 0);
        }
        catch (Exception exception)
        {
            _log($"spine-prerender catalog failed detail={exception.GetType().Name}: {exception.Message}");
            return Complete(stopwatch, "failed", 0, 0, 0, 0, 0, 1);
        }

        var totalClips = catalog.ClipCount;
        // The route mints still keys only, so prerendering animated clips would produce unrequestable cache entries.
        var passes = new[] { SpinePrerenderPass.Stills };
        var totalItems = totalClips * passes.Length;
        var discoveredFailures = catalog.Failures.Count + (catalog.Error is null ? 0 : 1);
        _log($"spine-prerender discovered scenes={catalog.ScannedSceneCount} spineNodes={catalog.SpineNodeCount} clips={totalClips} items={totalItems} discoveryFailures={discoveredFailures}");

        var hits = 0;
        var rendered = 0;
        var failures = discoveredFailures;
        var cacheWriteFailures = 0;
        var completed = 0;

        // #14 STILLS BEFORE CLIPS. Both clients paint a cheap 1-frame `&still=1` placeholder while the full clip
        // bakes (FIX 2b), and the host's degraded-admission path answers with that same still key — so the still
        // cache is what decides whether a spine appears IMMEDIATELY. A single pass in catalog order used to leave
        // every still unbaked until its (30-60x more expensive) clip had finished, i.e. exactly when the cheap win
        // was still worth having. Pass 1 bakes every still (~1 frame each), pass 2 the animated clips; a cancel
        // between them leaves a strictly more useful cache than the old ordering did.
        foreach (var pass in passes)
        {
            foreach (var entry in catalog.Entries)
            {
                completed++;
                var itemWatch = Stopwatch.StartNew();
                var key = $"{entry.SceneResPath}#{entry.AnimationName}";

                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    key = CouchCoopSpineClipProvider.BuildSpineKey(
                        entry.SceneResPath,
                        entry.NodePath,
                        entry.AnimationName,
                        still: pass == SpinePrerenderPass.Stills);
                    var result = await _clips.GetClipAsync(key, cancellationToken).ConfigureAwait(false);
                    if (result.Error is not null || result.Blob is null)
                    {
                        failures++;
                        _log($"spine-prerender {completed}/{totalItems} pass={pass} status=failed key={key} detail={result.Error?.Message ?? "empty-render"} elapsedMs={itemWatch.ElapsedMilliseconds}");
                        continue;
                    }

                    if (result.CacheStatus == "HIT")
                    {
                        hits++;
                        _log($"spine-prerender {completed}/{totalItems} pass={pass} status=hit key={key}");
                        continue;
                    }

                    rendered++;
                    if (result.CacheWriteFailed)
                    {
                        cacheWriteFailures++;
                    }

                    var status = result.CacheWriteFailed ? "rendered-cache-write-failed" : "rendered";
                    // The sweep IS the whole-catalog bake benchmark, so each item carries its phase breakdown:
                    // a cold prerender log is then a per-spine answer to "where did the bake time go".
                    _log($"spine-prerender {completed}/{totalItems} pass={pass} status={status} key={key} elapsedMs={itemWatch.ElapsedMilliseconds}{DescribePhases()}");
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return Complete(stopwatch, "cancelled", catalog.ScannedSceneCount, catalog.SpineNodeCount, totalClips, hits, rendered, failures, cacheWriteFailures);
                }
                catch (Exception exception)
                {
                    failures++;
                    _log($"spine-prerender {completed}/{totalItems} pass={pass} status=failed key={key} detail={exception.GetType().Name}: {exception.Message} elapsedMs={itemWatch.ElapsedMilliseconds}");
                }
            }
        }

        return Complete(stopwatch, "complete", catalog.ScannedSceneCount, catalog.SpineNodeCount, totalClips, hits, rendered, failures, cacheWriteFailures);
    }

    // The phase breakdown of the bake that JUST finished — the newest sample in the ring, which under the
    // sweep's strictly sequential bakes is this item's. Empty string when nothing was recorded, so the log line
    // degrades to exactly what it printed before rather than to a row of zeros.
    private static string DescribePhases()
    {
        var samples = SpineBakeMetrics.Snapshot();
        if (samples.Count == 0 || samples[^1].PhaseCosts.Count == 0)
        {
            return string.Empty;
        }

        var sample = samples[^1];
        return " " + Sts2RenderPhaseProfile.FormatLogLine(new Sts2RenderPhaseProfile.Snapshot(
            sample.Key,
            sample.BakeMs,
            sample.PhaseCosts.Where(phase => phase.Blocking).Sum(phase => phase.Ms),
            sample.PhaseCosts.Where(phase => !phase.Blocking).Sum(phase => phase.Ms),
            sample.PhaseCosts,
            new Dictionary<string, long> { ["outputBytes"] = sample.OutputBytes, ["frames"] = sample.Frames }));
    }

    private CouchCoopSpinePrerenderSummary Complete(
        Stopwatch stopwatch,
        string status,
        int scenes,
        int spineNodes,
        int clips,
        int hits,
        int rendered,
        int failures,
        int cacheWriteFailures = 0)
    {
        stopwatch.Stop();
        var summary = new CouchCoopSpinePrerenderSummary(
            status,
            scenes,
            spineNodes,
            clips,
            hits,
            rendered,
            failures,
            cacheWriteFailures,
            stopwatch.ElapsedMilliseconds);
        _log($"COUCHCOOP_SPINE_PRERENDER {JsonSerializer.Serialize(summary, JsonOptions)}");
        return summary;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Which key shape a prerender pass bakes (#14 stills-before-clips ordering).</summary>
    private enum SpinePrerenderPass
    {
        Stills,
        Clips,
    }
}

public sealed record CouchCoopSpinePrerenderSummary(
    string Status,
    int DiscoveredScenes,
    int SpineNodes,
    int TotalClips,
    int CacheHits,
    int RenderedClips,
    int Failures,
    int CacheWriteFailures,
    long ElapsedMs);
