using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.Artifacts;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Bake a single-pose GEOCLIP for every (scene, node, animation) the live Spine catalog knows about, ahead of the
/// first client that asks for one. The delta twin of <see cref="CouchCoopSpinePrerenderJob"/>, and deliberately a
/// SEPARATE type behind a SEPARATE flag.
/// </summary>
/// <remarks>
/// <para>
/// WHY NOT EXTEND THE STILL SWEEP. Deltas are expected to eventually REPLACE rasterised stills, so the two sweeps
/// have to be flippable independently: a host must be able to run deltas without paying for stills (the end
/// state), stills without deltas (today), or both (the comparison). A fused job can express none of those, and
/// the day the raster pass is retired it would have to be split again anyway.
/// </para>
/// <para>
/// THIS IS THE PRIMARY PRODUCTION PATH, not a warm-up. A pose-only bake is measurably cheaper than a whole clip
/// (7.98x on one rig) but still costs 1.9-9.9 s, because 90-96% of it is the per-SCENE bracket RID sweep and
/// association, which one pose pays in full. On-demand-on-first-request therefore cannot be the sole path — a
/// browser is not going to wait seconds for a creature — so the sweep is what actually fills the store.
/// </para>
/// <para>
/// RESTARTABLE BY CONSTRUCTION, because the host can die mid-bake. Silent deaths were measured in roughly a
/// quarter of bake sessions, at or inside the bracket RID sweep, with no crash dump and a truncated log. There is
/// therefore NO in-memory progress state: the resume mechanism is the store's own <c>.complete</c> marker, which
/// is written last and atomically, so an identity already on disk is a <c>hit</c> and is never re-baked — and its
/// negative twin, the refusal receipt, which is why a catalog that is roughly half refusals converges at all
/// instead of re-deciding several hundred multi-second bakes on every launch. A sweep killed at item 400 of 900
/// skips those 400 on the next launch and continues. The per-item <c>start</c> line below exists for the same
/// reason — it is the only forensic trail a silent death leaves, so the identity is logged BEFORE the bake that
/// may kill the process, not after.
/// </para>
/// <para>
/// AND SO IS THE REPORT. The same death that makes the store the resume mechanism makes an end-of-sweep-only
/// report worthless: two full runs against the real catalog died at items 406 and 857 of 1175, and between them
/// emitted ZERO rig rows and ZERO summaries while leaving 318 finished poses on disk. So progress is flushed as
/// it is made — rig rows the moment a rig is done with, plus a running summary under a <c>partial</c> status —
/// and the flush happens BEFORE the next bake rather than after the last one, because the next bake is the thing
/// that might take the process down. The end-of-sweep emission is unchanged and still authoritative: a reader of
/// a completed run sees exactly what it always saw, and a reader of a killed one takes the LAST line per rig.
/// </para>
/// <para>
/// THIS SWEEP IS ALSO THE MEASUREMENT. It is the round's cost-and-coverage number, so the summary answers,
/// without anyone re-deriving it from a log: how many catalog entries baked completely, how many were REFUSED and
/// for which reason, how many FAILED and with which code, the wall time, the bytes on disk with atlas pages
/// counted ONCE, and — per RIG — whether deltas are cheaper than the raster stills they would replace at all.
/// That last one is not rhetorical: it is rig-dependent. A rig with a small atlas and many poses wins several
/// fold; a rig whose atlas outweighs its own stills never breaks even.
/// </para>
/// </remarks>
public sealed class CouchCoopGeoclipPrerenderJob(
    CouchCoopRuntimeHost runtime,
    CouchCoopGeoclipProvider geoclips,
    Action<string>? log = null,
    SpirectlAssetBinaryCache? rasterBaseline = null)
{
    /// <summary>Served from the store; no bake ran. Also what a resumed sweep reports for prior progress.</summary>
    public const string StatusHit = "hit";

    /// <summary>Baked and committed to the store.</summary>
    public const string StatusBaked = "baked";

    /// <summary>
    /// The bake RAN and produced an artifact, and the provider REFUSED to commit it because it did not cover the
    /// whole rig. Counted apart from <see cref="StatusFailed"/> on purpose: this is a guard doing its job on a rig
    /// that does not bake cleanly, not the host falling over, and a sweep that conflates the two cannot tell an
    /// incomplete rig from a broken machine (or from a process that died). Incomplete bakes are ordinary on real
    /// content — a measured rig's <c>attack</c> came back with 8 foreign meshes and its <c>die</c> with
    /// <c>complete=false</c> — so COVERAGE WILL NOT BE 100%, and that is the correct outcome rather than a defect.
    /// </summary>
    public const string StatusRefused = "refused";

    /// <summary>Anything else: no capability, no store, a throw, a bake that never produced counters.</summary>
    public const string StatusFailed = "failed";

    /// <summary>The one-line machine-readable summary this job emits, on a cadence and again at the end.</summary>
    public const string SummaryLogPrefix = "COUCHCOOP_GEOCLIP_PRERENDER";

    /// <summary>
    /// The <c>status</c> of a running snapshot, as against <c>complete</c> / <c>cancelled</c> / <c>failed</c>.
    /// One field tells a reader whether the line in front of them is the answer or a progress report; without it
    /// a truncated log and a finished sweep are indistinguishable, which is the exact confusion that makes an
    /// incremental report worse than none.
    /// </summary>
    public const string StatusPartial = "partial";

    /// <summary>
    /// How many poses of one rig a single bake may cover.
    ///
    /// <para>THE ARGUMENT FOR BATCHING, which is still sound: 90-96 % of a pose-only bake is the per-SCENE
    /// bracket sweep and slot↔mesh association, and asking for a rig's poses one at a time pays that once per
    /// pose. The catalog is already grouped by scene, so consecutive entries of one (scene, node) could go to
    /// the producer together.</para>
    ///
    /// <para>DEFAULT 1 ANYWAY — i.e. rig batching is OFF and each pose is baked on its own, which is what this job did
    /// before the batch existed. <c>COUCHCOOP_GEOCLIP_RIG_BATCH=&lt;n&gt;</c> re-arms it.
    ///
    /// <para>The batch was built to amortise the per-scene sweep and association (90-96 % of a pose-only bake)
    /// across a rig's animations, and measured live it REFUSES ITSELF on both measured rigs, every arm:
    /// byrdonis reports <c>staleMeshFrames=100</c> with 100 <c>Parameter "mesh" is null</c> engine errors
    /// (zero in every per-target arm), and the merchant reports <c>attachmentDrift=34</c>. So every rig falls
    /// back to per-target bakes and pays the batch attempt first — measured at <b>+22 % / +18 %</b> over not
    /// batching at all. Worse, the merchant batch delivers ZERO usable poses: its <c>cast</c> pose is kept with
    /// 20 of 45 parts and <c>complete=false</c>, and only the store's own completeness refusal keeps that out.
    /// Even granting correctness, the batch pass alone prices the merchant at 588 ms/pose against a 277 ms
    /// raster, so it would not have met the round's gate either.</para>
    ///
    /// <para>Kept rather than deleted because the amortisation argument is still the right one and the artifact
    /// comparison shows the per-target lane is byte-correct. Re-arming it needs the null-mesh cause understood
    /// (a batched pose reads back meshes the rig no longer owns) and the drift guard's per-pose narrowing
    /// fixed — it exempts the pose association was measured at, which by construction cannot be seen to drift.</para>
    ///
    /// <para>WHAT ARMING ACTUALLY REACHES, because the cap above is the ONLY thing holding it. Set the variable
    /// past 1 and this sweep hands a rig's poses to <see cref="CouchCoopGeoclipProvider.GetRigAsync"/> as one
    /// multi-animation request, and every lane below here batches on that list alone — there is no second gate,
    /// so the exposure is latent rather than absent. It matters because the drift guard cannot see its own
    /// worst case: the acquisition pose is the baseline every other pose is compared against, so IT can never be
    /// reported as drifting, and phase 5's F3 arm shipped exactly that — a kept pose carrying a fifth of the
    /// merchant's parts, stopped only by <see cref="CouchCoopGeoclipProvider.IncompletenessReason"/> downstream.
    /// Re-arming therefore needs a SYMMETRIC drift check (one that covers the acquisition pose too) and
    /// incompleteness treated as a refusal at the producer, where the pose can still go back for a per-target
    /// bake, instead of as a rejection after the artifact has already been emitted.</para>
    /// </summary>
    public static int MaxRigBatchPoses => ReadRigBatchPoses();

    /// <summary>The measured-catalog batch size the sweep used before the live evidence turned it off.</summary>
    public const int RigBatchPosesWhenArmed = 12;

    /// <summary>
    /// Upper bound on POSES between progress flushes, INDEPENDENT of the batch size. A flush also happens at
    /// every rig change, so on the measured catalog (1 175 items, 197 rigs) this is the backstop for a rig with
    /// many poses rather than the usual trigger. It exists because the cadence used to BE the batch cap, and
    /// with batching off a chunk is one pose — which would have put a snapshot after every one of 1 175 items.
    /// Counting poses rather than chunks is what makes the cadence mean the same thing at either cap.
    /// </summary>
    public const int ProgressFlushPoses = 12;

    private static int ReadRigBatchPoses()
    {
        var raw = Environment.GetEnvironmentVariable("COUCHCOOP_GEOCLIP_RIG_BATCH");
        return int.TryParse(raw, out var parsed) && parsed > 1 ? parsed : 1;
    }

    /// <summary>
    /// One line per RIG, emitted before the summary. The same rows ride inside the summary's <c>rigs</c> array;
    /// they are also emitted individually because a per-rig grep is what a reader actually does with a table of a
    /// few hundred rows, and one row surviving on its own is worth more than none.
    /// </summary>
    public const string RigLogPrefix = "COUCHCOOP_GEOCLIP_RIG";

    private readonly CouchCoopRuntimeHost _runtime = runtime ?? throw new ArgumentNullException(nameof(runtime));
    private readonly CouchCoopGeoclipProvider _geoclips = geoclips ?? throw new ArgumentNullException(nameof(geoclips));
    private readonly Action<string> _log = log ?? (message => Console.Error.WriteLine(message));

    // The RASTER baseline the per-rig comparison is measured against: the webp stills already on disk for the
    // same identities. Size-only probes, so a rig with no cached stills simply reports no baseline rather than
    // costing the sweep a few hundred multi-hundred-KB reads.
    private readonly SpirectlAssetBinaryCache _rasterBaseline = rasterBaseline ?? new SpirectlAssetBinaryCache();

    public async Task<CouchCoopGeoclipPrerenderSummary> RunAsync(CancellationToken cancellationToken = default)
    {
        var stopwatch = Stopwatch.StartNew();
        var tally = new Tally(_geoclips.Store);
        if (RefuseToStart(stopwatch, tally) is { } refused)
        {
            return refused;
        }

        SpineCatalogOperationResult catalog;
        try
        {
            // The catalog walk and every bake are dispatched onto the Godot main thread. Keep the job off the mod
            // initialization thread so the browser listener stays available immediately — the same reason the
            // still sweep does it, and additionally load-bearing here: spirectl REFUSES a bake requested from the
            // main thread (it would deadlock awaiting frames the blocked thread cannot produce).
            catalog = await Task.Run(
                () => _runtime.GetSpineCatalog(new SpineCatalogRequestSnapshot()),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return Complete(stopwatch, "cancelled", default, tally);
        }
        catch (Exception exception)
        {
            _log($"[couchcoop] geoclip-prerender catalog failed detail={exception.GetType().Name}: {exception.Message}");
            tally.Fail(null, "catalog-" + Kebab(exception.GetType().Name));
            return Complete(stopwatch, "failed", default, tally);
        }

        var found = new Discovery(catalog.ScannedSceneCount, catalog.SpineNodeCount, catalog.ClipCount);
        var discoveryFailures = catalog.Failures.Count + (catalog.Error is null ? 0 : 1);
        for (var index = 0; index < discoveryFailures; index++)
        {
            tally.Fail(null, "catalog-discovery");
        }

        _log(
            $"[couchcoop] geoclip-prerender discovered scenes={found.Scenes} spineNodes={found.SpineNodes} "
            + $"clips={found.Clips} discoveryFailures={discoveryFailures} "
            + $"store={_geoclips.Store.RootPath ?? "disabled"}");

        return await SweepAsync(catalog.Entries, found, MaxRigBatchPoses, stopwatch, tally, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Sweep a SUPPLIED list of identities instead of discovering the whole catalog — the entry point the
    /// encounter-scoped prerender uses (<see cref="CouchCoopEncounterGeoclipPrerender"/>).
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY A SECOND ENTRY POINT RATHER THAN A FILTER ARGUMENT. The catalog walk itself is the thing being
    /// skipped: <see cref="SpineCatalogRequestSnapshot"/> takes no arguments and scans everything reachable
    /// through <c>res://</c>, so there is no "catalog of this encounter" to ask for. A caller that knows which
    /// creatures are on screen already has the identities, and making it round-trip them through a 1 175-entry
    /// project scan would cost more than the bakes.
    /// </para>
    /// <para>
    /// EVERYTHING ELSE IS THE SAME SWEEP, deliberately: the same store probe, the same durable refusal receipt,
    /// the same per-item and per-rig log vocabulary, the same summary shape. A reader must not have to know which
    /// entry point produced a line, and a scoped sweep must not be able to admit a pose the whole-catalog sweep
    /// would have refused.
    /// </para>
    /// </remarks>
    /// <param name="maxRigBatchPoses">
    /// Poses per bake. The encounter lane passes <c>1</c> and does NOT read
    /// <see cref="MaxRigBatchPoses"/> — see <see cref="CouchCoopEncounterGeoclipPrerender"/> for why a sweep that
    /// runs CONCURRENTLY with client requests must take the single-key lane.
    /// </param>
    public async Task<CouchCoopGeoclipPrerenderSummary> RunAsync(
        IReadOnlyList<SpineCatalogEntrySnapshot> entries,
        int maxRigBatchPoses,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(entries);
        var stopwatch = Stopwatch.StartNew();
        var tally = new Tally(_geoclips.Store);
        if (RefuseToStart(stopwatch, tally) is { } refused)
        {
            return refused;
        }

        // The same three numbers the catalog walk would have reported, derived from the roster instead — so the
        // summary's shape and meaning are unchanged and one parser reads both lanes.
        var found = new Discovery(
            entries.Select(entry => entry.SceneResPath).Distinct(StringComparer.Ordinal).Count(),
            entries.Select(Tally.RigId).Distinct(StringComparer.Ordinal).Count(),
            entries.Count);

        _log(
            $"[couchcoop] geoclip-prerender scoped scenes={found.Scenes} spineNodes={found.SpineNodes} "
            + $"clips={found.Clips} discoveryFailures=0 store={_geoclips.Store.RootPath ?? "disabled"}");

        return await SweepAsync(entries, found, maxRigBatchPoses, stopwatch, tally, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>
    /// The cache-root check every sweep makes before it touches the catalog or the clock — or null when the sweep
    /// may proceed.
    /// </summary>
    private CouchCoopGeoclipPrerenderSummary? RefuseToStart(Stopwatch stopwatch, Tally tally)
    {
        if (!_geoclips.Store.IsEnabled)
        {
            _log("[couchcoop] geoclip-prerender REFUSED to start: no geoclip cache root could be resolved.");
            return Complete(stopwatch, "store-disabled", default, tally);
        }

        return null;
    }

    private async Task<CouchCoopGeoclipPrerenderSummary> SweepAsync(
        IReadOnlyList<SpineCatalogEntrySnapshot> entries,
        Discovery found,
        int maxRigBatchPoses,
        Stopwatch stopwatch,
        Tally tally,
        CancellationToken cancellationToken)
    {
        var completed = 0;
        var first = true;
        var sinceFlush = 0;
        var lastRig = string.Empty;
        foreach (var chunk in RigChunks(entries, maxRigBatchPoses))
        {
            // PROGRESS BEFORE THE WORK THAT MAY KILL US, not after it. A chunk is ONE bake, and a bake is where
            // the measured silent deaths happen — so flushing in front of it means the rows describing
            // everything up to here are already on disk when the process goes down. Flushing after would lose
            // exactly the work that mattered. A chunk boundary is also a rig boundary in every case but a rig
            // with more poses than the cap, which is what makes a rig row FINAL when it is emitted.
            // The cadence is DECOUPLED from the chunk size. It used to be "one flush per chunk", which was the
            // same thing while a chunk was a whole rig — but with rig batching off (the shipped default, see
            // MaxRigBatchPoses) a chunk is one POSE, and flushing per chunk would put 1 175 snapshots in the log
            // for the measured catalog: exactly the per-item spam the cadence exists to avoid. Flush when a rig
            // has finished, or every ProgressFlushChunks bakes, whichever comes first.
            var chunkRig = chunk.Count == 0
                ? string.Empty
                : $"{chunk[0].SceneResPath} {chunk[0].NodePath}";
            // Counted in POSES, not chunks, so the cadence means the same thing whatever the batch cap is: at a
            // cap of 12 a 30-pose rig flushes twice on the way through, and at a cap of 1 the same rig flushes
            // twice as well, rather than thirty times.
            if (!first
                && (sinceFlush >= ProgressFlushPoses
                    || !string.Equals(chunkRig, lastRig, StringComparison.Ordinal)))
            {
                EmitProgress(found, tally, stopwatch);
                sinceFlush = 0;
            }

            sinceFlush += chunk.Count;

            lastRig = chunkRig;
            first = false;

            var chunkWatch = Stopwatch.StartNew();
            var startedAt = completed;
            var keys = new string[chunk.Count];
            try
            {
                cancellationToken.ThrowIfCancellationRequested();

                // The geoclip rides the ANIMATED clip identity (the store appends its own `&geo=1&gv=1` tail), so
                // a delta and the raster clip for the same creature share a byte-identical key prefix.
                var requests = new List<CouchCoopGeoclipRequest>(chunk.Count);
                for (var i = 0; i < chunk.Count; i += 1)
                {
                    keys[i] = CouchCoopSpineClipProvider.BuildSpineKey(
                        chunk[i].SceneResPath, chunk[i].NodePath, chunk[i].AnimationName);
                    requests.Add(new CouchCoopGeoclipRequest(
                        keys[i], chunk[i].SceneResPath, chunk[i].NodePath, chunk[i].AnimationName));
                }

                // Announce the identities BEFORE the bake that may take the process down with them — see the
                // class remarks. Only the ones that can actually bake: an identity already in the store, or one
                // already refused under this policy, cannot be the one that dies, so a resumed sweep does not
                // bury the interesting lines under a thousand no-ops.
                for (var i = 0; i < chunk.Count; i += 1)
                {
                    if (_geoclips.Store.TryResolveDirectory(keys[i]) is null && !_geoclips.Store.HasRefusal(keys[i]))
                    {
                        _log($"[couchcoop] geoclip-prerender {startedAt + i + 1}/{found.Clips} start key={keys[i]}");
                    }
                }

                var results = await _geoclips.GetRigAsync(requests, cancellationToken).ConfigureAwait(false);

                for (var i = 0; i < chunk.Count; i += 1)
                {
                    completed++;
                    var entry = chunk[i];
                    var key = keys[i];
                    var result = results[i];

                    // `elapsedMs` is the WHOLE CHUNK's wall time on every row of it, because that is what was
                    // actually spent — the per-scene work is shared and cannot be attributed to one pose.
                    // `posesInBake` is what turns it into the amortized per-pose number without anyone guessing.
                    var timing = $"elapsedMs={chunkWatch.ElapsedMilliseconds} posesInBake={chunk.Count}";

                    // REFUSED IS DECIDED BY STRUCTURE, not by matching a code or re-parsing a message: the
                    // provider sets Refusal exactly when the completeness guard kept the identity out of the
                    // store, fresh or remembered, and carries the bucketed arm with it.
                    if (result.Refusal is { } refusal)
                    {
                        tally.Refuse(entry, refusal.Reason, refusal.Cached);
                        _log(
                            $"[couchcoop] geoclip-prerender {completed}/{found.Clips} status={StatusRefused} "
                            + $"key={key} reason={refusal.Reason} cached={(refusal.Cached ? 1 : 0)} "
                            + $"detail={refusal.Detail} {timing}");
                        continue;
                    }

                    if (result.Error is { } error)
                    {
                        tally.Fail(entry, error.Code);
                        _log(
                            $"[couchcoop] geoclip-prerender {completed}/{found.Clips} status={StatusFailed} "
                            + $"key={key} code={error.Code} detail={error.Message} {timing}");
                        continue;
                    }

                    if (result.Directory is null)
                    {
                        // Belt: a success with nothing to serve is not a success.
                        tally.Fail(entry, "geoclip-empty-result");
                        _log(
                            $"[couchcoop] geoclip-prerender {completed}/{found.Clips} status={StatusFailed} "
                            + $"key={key} code=geoclip-empty-result {timing}");
                        continue;
                    }

                    var hit = string.Equals(result.CacheStatus, "HIT", StringComparison.Ordinal);
                    var raster = _rasterBaseline.TryMeasureBytes(
                        CouchCoopSpineClipProvider.BuildSpineKey(
                            entry.SceneResPath,
                            entry.NodePath,
                            entry.AnimationName,
                            still: true));
                    var measured = tally.Store(entry, result.Directory, hit, raster);
                    _log(
                        $"[couchcoop] geoclip-prerender {completed}/{found.Clips} "
                        + $"status={(hit ? StatusHit : StatusBaked)} key={key} "
                        + $"geometryBytes={measured.GeometryBytes} pages={measured.PageReferences} "
                        + $"newPages={measured.NewPages} newPageBytes={measured.NewPageBytes} "
                        + $"rasterBytes={(raster is { } bytes ? bytes.ToString() : "n/a")} {timing}");
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return Complete(stopwatch, "cancelled", found, tally);
            }
            catch (Exception exception)
            {
                // A bake covers the whole chunk, so a throw takes the whole chunk with it — every one of its
                // identities is unaccounted for, and a sweep that counted only the first would report a total
                // smaller than the catalog it walked.
                for (var i = completed - startedAt; i < chunk.Count; i += 1)
                {
                    completed++;
                    tally.Fail(chunk[i], Kebab(exception.GetType().Name));
                    _log(
                        $"[couchcoop] geoclip-prerender {completed}/{found.Clips} status={StatusFailed} "
                        + $"key={keys[i] ?? chunk[i].SceneResPath} detail={exception.GetType().Name}: "
                        + $"{exception.Message} elapsedMs={chunkWatch.ElapsedMilliseconds} posesInBake={chunk.Count}");
                }
            }
        }

        return Complete(stopwatch, "complete", found, tally);
    }

    /// <summary>
    /// Split the catalog into bakes: CONSECUTIVE entries sharing a (scene, node), in runs of at most
    /// <paramref name="maxPoses"/>.
    /// </summary>
    /// <remarks>
    /// Consecutive rather than globally grouped, because the catalog's order is the order the sweep announces and
    /// resumes in, and re-sorting it would silently move which bake runs when — the one property a resumed sweep
    /// and a forensic log both depend on. A catalog that interleaves rigs simply batches less.
    /// </remarks>
    internal static List<List<SpineCatalogEntrySnapshot>> RigChunks(
        IReadOnlyList<SpineCatalogEntrySnapshot> entries,
        int maxPoses)
    {
        var chunks = new List<List<SpineCatalogEntrySnapshot>>();
        foreach (var entry in entries)
        {
            var last = chunks.Count > 0 ? chunks[^1] : null;
            if (last is not null
                && last.Count < Math.Max(1, maxPoses)
                && string.Equals(Tally.RigId(last[0]), Tally.RigId(entry), StringComparison.Ordinal))
            {
                last.Add(entry);
                continue;
            }

            chunks.Add([entry]);
        }

        return chunks;
    }

    /// <summary>
    /// Flush what is known so far: one line per rig whose numbers have MOVED since the last flush, then a running
    /// summary under <see cref="StatusPartial"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Only DIRTY rigs, because the point of a flush is to get new facts onto disk, not to re-print a table
    /// whose last row changed twenty minutes ago. A rig's most recent line is therefore always its current state,
    /// and a reader of a truncated log takes the last line per rig — which is the same rule they need anyway,
    /// since a completed sweep re-emits every row at the end.
    /// </para>
    /// <para>
    /// The partial summary carries an EMPTY <c>rigs</c> array while still reporting <c>rigCount</c>. The rows
    /// ride their own lines precisely so they survive independently, and repeating all of them inside a snapshot
    /// emitted a couple of hundred times would multiply the log by an order of magnitude to say nothing new. The
    /// final summary is the one that carries the table.
    /// </para>
    /// </remarks>
    private void EmitProgress(Discovery found, Tally tally, Stopwatch stopwatch)
    {
        foreach (var rig in tally.TakeDirtyRows())
        {
            _log($"{RigLogPrefix} {JsonSerializer.Serialize(rig, JsonOptions)}");
        }

        _log(
            $"{SummaryLogPrefix} "
            + JsonSerializer.Serialize(
                tally.ToSummary(StatusPartial, found, stopwatch.ElapsedMilliseconds, withRigRows: false),
                JsonOptions));
    }

    private CouchCoopGeoclipPrerenderSummary Complete(
        Stopwatch stopwatch,
        string status,
        Discovery found,
        Tally tally)
    {
        stopwatch.Stop();
        var summary = tally.ToSummary(status, found, stopwatch.ElapsedMilliseconds);
        foreach (var rig in summary.Rigs)
        {
            _log($"{RigLogPrefix} {JsonSerializer.Serialize(rig, JsonOptions)}");
        }

        _log($"{SummaryLogPrefix} {JsonSerializer.Serialize(summary, JsonOptions)}");
        return summary;
    }

    private static string Kebab(string pascal)
    {
        var builder = new System.Text.StringBuilder(pascal.Length + 4);
        foreach (var character in pascal)
        {
            if (char.IsUpper(character) && builder.Length > 0)
            {
                builder.Append('-');
            }

            builder.Append(char.ToLowerInvariant(character));
        }

        return builder.ToString();
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly record struct Discovery(int Scenes, int SpineNodes, int Clips);

    /// <summary>What one item added to the store's marginal cost.</summary>
    internal readonly record struct StoredCost(long GeometryBytes, int PageReferences, int NewPages, long NewPageBytes);

    /// <summary>
    /// The sweep's running counters, including the SIZE accounting — which is the part that is easy to get
    /// dishonestly wrong.
    /// </summary>
    /// <remarks>
    /// Atlas pages are content-addressed and SHARED across every pose of every rig, so a per-pose size sum
    /// double-counts them: a rig's four poses would report four copies of an atlas that exists once on disk and is
    /// fetched once by a browser. The marginal cost is what this round is claiming, so pages are counted ONCE, by
    /// file name — and the naive figure is reported ALONGSIDE it
    /// (<see cref="CouchCoopGeoclipPrerenderSummary.PageBytesUnshared"/>) so the saving is visible rather than
    /// asserted.
    /// </remarks>
    private sealed class Tally(CouchCoopGeoclipStore store)
    {
        private readonly Dictionary<string, long> _pages = new(StringComparer.Ordinal);
        private readonly HashSet<string> _poses = new(StringComparer.Ordinal);
        private readonly SortedDictionary<string, int> _refusals = new(StringComparer.Ordinal);
        private readonly SortedDictionary<string, int> _failures = new(StringComparer.Ordinal);
        private readonly SortedDictionary<string, Rig> _rigs = new(StringComparer.Ordinal);

        private int _hits;
        private int _baked;
        private int _refusedCached;
        private long _geometryBytes;
        private int _pageReferences;
        private long _pageBytesUnshared;
        private int _measureFailures;

        /// <summary>The rig identity a catalog entry belongs to: one rig is one (scene, node).</summary>
        public static string RigId(SpineCatalogEntrySnapshot entry)
            => $"{entry.SceneResPath}|{entry.NodePath ?? string.Empty}";

        /// <param name="cached">
        /// Whether the refusal was remembered rather than re-decided. Counted INSIDE
        /// <see cref="CouchCoopGeoclipPrerenderSummary.Refused"/>, not beside it: a resumed sweep and a cold one
        /// must report the same refused total for the same catalog, or the two runs cannot be compared at all.
        /// The subset is what says how much of that total was paid for this time.
        /// </param>
        public void Refuse(SpineCatalogEntrySnapshot entry, string reason, bool cached)
        {
            Bump(_refusals, reason);
            if (cached)
            {
                _refusedCached++;
            }

            RigFor(entry).Refused++;
        }

        public void Fail(SpineCatalogEntrySnapshot? entry, string code)
        {
            Bump(_failures, code);
            if (entry is not null)
            {
                RigFor(entry).Failed++;
            }
        }

        public StoredCost Store(SpineCatalogEntrySnapshot entry, string directory, bool hit, long? rasterBytes)
        {
            if (hit)
            {
                _hits++;
            }
            else
            {
                _baked++;
            }

            var rig = RigFor(entry);
            if (rasterBytes is { } raster)
            {
                rig.RasterBytes += raster;
                rig.RasterSamples++;
            }

            return Measure(rig, directory);
        }

        /// <summary>
        /// Size one pose directory and fold it in, globally and into its rig. Idempotent per directory: a catalog
        /// that lists one identity twice must not be billed twice for it.
        /// </summary>
        private StoredCost Measure(Rig rig, string directory)
        {
            if (!_poses.Add(Path.GetFullPath(directory)))
            {
                return default;
            }

            rig.Poses++;
            long geometry = 0;
            var references = 0;
            var newPages = 0;
            long newPageBytes = 0;
            try
            {
                // Pose-local bytes only. The .complete marker is a local receipt no client ever fetches, so
                // billing it would inflate the transfer number this sweep exists to produce.
                foreach (var file in Directory.EnumerateFiles(directory))
                {
                    if (!string.Equals(Path.GetFileName(file), CouchCoopGeoclipStore.CompleteMarkerName, StringComparison.Ordinal))
                    {
                        geometry += new FileInfo(file).Length;
                    }
                }

                // Follow the MANIFEST for the page list, not the completion marker: the manifest is what the
                // client reads, so it is what the client's transfer is billed against.
                var manifest = Path.Combine(directory, CouchCoopGeoclipStore.ManifestFileName);
                if (JsonNode.Parse(File.ReadAllText(manifest)) is JsonObject document
                    && document["pages"] is JsonArray pages)
                {
                    foreach (var entry in pages)
                    {
                        if (entry is not JsonObject page || page["file"]?.GetValue<string>() is not { } name)
                        {
                            continue;
                        }

                        references++;
                        rig.Pages.Add(name);
                        if (_pages.TryGetValue(name, out var known))
                        {
                            _pageBytesUnshared += known;
                            continue;
                        }

                        var path = store.PagesPath is null ? null : Path.Combine(store.PagesPath, name);
                        var bytes = path is not null && File.Exists(path) ? new FileInfo(path).Length : 0L;
                        _pages[name] = bytes;
                        _pageBytesUnshared += bytes;
                        newPages++;
                        newPageBytes += bytes;
                    }
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                // A pose that cannot be measured is still a pose that was produced; count the measurement gap
                // rather than silently reporting a smaller store than exists.
                _measureFailures++;
            }

            rig.GeometryBytes += geometry;
            _geometryBytes += geometry;
            _pageReferences += references;
            return new StoredCost(geometry, references, newPages, newPageBytes);
        }

        /// <param name="withRigRows">
        /// False for a running snapshot, whose rows go out on their own lines instead — see
        /// <see cref="EmitProgress"/>. <c>rigCount</c> is reported either way, so an empty array in a
        /// <see cref="StatusPartial"/> line reads as "not repeated here", never as "no rigs found".
        /// </param>
        public CouchCoopGeoclipPrerenderSummary ToSummary(
            string status,
            Discovery found,
            long elapsedMs,
            bool withRigRows = true)
        {
            var sharedPageBytes = _pages.Values.Sum();
            IReadOnlyList<CouchCoopGeoclipRigCost> rows = withRigRows
                ? [.. _rigs.Values.Select(rig => rig.ToRow(_pages))]
                : [];
            return new CouchCoopGeoclipPrerenderSummary(
                status,
                found.Scenes,
                found.SpineNodes,
                found.Clips,
                _hits + _baked + _refusals.Values.Sum() + _failures.Values.Sum(),
                _hits,
                _baked,
                _refusals.Values.Sum(),
                _refusedCached,
                _failures.Values.Sum(),
                _refusals,
                _failures,
                _poses.Count,
                _geometryBytes,
                _pages.Count,
                _pageReferences,
                sharedPageBytes,
                _pageBytesUnshared,
                _geometryBytes + sharedPageBytes,
                _measureFailures,
                _rigs.Count,
                rows,
                elapsedMs);
        }

        /// <summary>
        /// The rows for every rig whose counters have moved since the last call, clearing them as it goes.
        /// </summary>
        public IReadOnlyList<CouchCoopGeoclipRigCost> TakeDirtyRows()
        {
            var rows = new List<CouchCoopGeoclipRigCost>();
            foreach (var rig in _rigs.Values)
            {
                if (!rig.Dirty)
                {
                    continue;
                }

                rig.Dirty = false;
                rows.Add(rig.ToRow(_pages));
            }

            return rows;
        }

        private Rig RigFor(SpineCatalogEntrySnapshot entry)
        {
            var id = RigId(entry);
            if (!_rigs.TryGetValue(id, out var rig))
            {
                rig = new Rig(entry.SceneResPath, entry.NodePath);
                _rigs[id] = rig;
            }

            // EVERY mutation of a rig's counters goes through here, so this is the one place that has to mark it
            // for the next flush.
            rig.Dirty = true;
            return rig;
        }

        private static void Bump(SortedDictionary<string, int> counters, string key)
        {
            var name = string.IsNullOrWhiteSpace(key) ? "unspecified" : key;
            counters[name] = counters.TryGetValue(name, out var count) ? count + 1 : 1;
        }

        /// <summary>
        /// One rig = one (scene, node). Its pages are counted once WITHIN the rig, which is the number that
        /// answers "what does shipping this creature's deltas cost" — so per-rig page bytes can sum to more than
        /// the sweep-wide figure if two rigs happen to share an atlas, and that is correct for both readings.
        /// </summary>
        private sealed class Rig(string scene, string? node)
        {
            /// <summary>Set by every counter change, cleared by the flush that reports it.</summary>
            public bool Dirty { get; set; }

            public HashSet<string> Pages { get; } = new(StringComparer.Ordinal);

            public int Poses { get; set; }

            public int Refused { get; set; }

            public int Failed { get; set; }

            public long GeometryBytes { get; set; }

            public long RasterBytes { get; set; }

            public int RasterSamples { get; set; }

            public CouchCoopGeoclipRigCost ToRow(IReadOnlyDictionary<string, long> pageBytes)
            {
                var pages = Pages.Sum(name => pageBytes.TryGetValue(name, out var bytes) ? bytes : 0L);
                var perPose = Poses > 0 ? GeometryBytes / (double)Poses : 0d;
                var perStill = RasterSamples > 0 ? RasterBytes / (double)RasterSamples : 0d;

                // Delta cost for n poses is pages + n*geometry; raster cost is n*still. The atlas is a one-off,
                // so the question is whether a pose's geometry undercuts the still it replaces by enough to pay
                // that atlas off — and on a rig whose atlas outweighs its own stills, it never does. Say so
                // rather than printing a number that is only true past the end of the rig's animation list.
                int? breakEven = null;
                string verdict;
                if (RasterSamples == 0)
                {
                    verdict = "no-raster-baseline";
                }
                else if (perStill <= perPose)
                {
                    verdict = "never";
                }
                else
                {
                    breakEven = Math.Max(1, (int)Math.Ceiling(pages / (perStill - perPose)));
                    verdict = $"breaks-even-at-{breakEven}";
                }

                return new CouchCoopGeoclipRigCost(
                    scene,
                    node,
                    Poses,
                    Refused,
                    Failed,
                    GeometryBytes,
                    Pages.Count,
                    pages,
                    GeometryBytes + pages,
                    RasterBytes,
                    RasterSamples,
                    breakEven,
                    verdict);
            }
        }
    }
}

/// <param name="Poses">Poses of this rig actually stored (complete on disk).</param>
/// <param name="PageBytes">This rig's distinct atlas pages, counted ONCE.</param>
/// <param name="TotalBytes"><paramref name="GeometryBytes"/> + <paramref name="PageBytes"/>: what shipping every
/// stored pose of this rig as a delta costs on disk and, page caching aside, over the wire.</param>
/// <param name="RasterBytes">
/// The webp stills those same poses would have cost, summed over the <paramref name="RasterSamples"/> of them
/// that were found in the raster cache. Zero samples means this host has not baked those stills, NOT that they
/// are free.
/// </param>
/// <param name="BreakEvenPoses">
/// How many poses of this rig must ship before deltas cost less than the stills they replace, or null when there
/// is no baseline or the rig never breaks even.
/// </param>
/// <param name="Verdict"><c>breaks-even-at-N</c> / <c>never</c> / <c>no-raster-baseline</c>.</param>
public sealed record CouchCoopGeoclipRigCost(
    string Scene,
    string? Node,
    int Poses,
    int Refused,
    int Failed,
    long GeometryBytes,
    int Pages,
    long PageBytes,
    long TotalBytes,
    long RasterBytes,
    int RasterSamples,
    int? BreakEvenPoses,
    string Verdict);

/// <param name="Status">
/// <c>complete</c> / <c>cancelled</c> / <c>failed</c>, a running <c>partial</c> snapshot, or a refusal to start
/// at all (<c>ondemand-disabled</c>, <c>store-disabled</c>) — a sweep that never ran must not read as a sweep
/// that found nothing, and a progress line must not read as a verdict.
/// </param>
/// <param name="Hits">
/// Identities already complete in the store. On a resumed sweep this is the progress the previous run made:
/// there is no other progress state, by design.
/// </param>
/// <param name="Refused">
/// Identities the completeness guard kept out of the store because a bake of them did not cover the whole rig.
/// Separate from <paramref name="Failed"/>: this is a guard firing on a rig, that is the host failing. Expected
/// to be non-zero on real content — a measured catalog was roughly half refusals.
/// </param>
/// <param name="RefusedCached">
/// How many of <paramref name="Refused"/> were answered from a refusal receipt rather than by a bake that ran
/// this time. A SUBSET, not a sibling: the refused total means the same thing on a cold sweep and a resumed one,
/// and this says how much of it this run actually paid for. <c>Refused - RefusedCached</c> is the number of
/// multi-second bakes that ended in a refusal on this run; on a converged store it should be zero.
/// </param>
/// <param name="RefusalReasons">
/// Which arm of the completeness guard fired, by count: <c>incomplete</c> / <c>unassociated</c> / <c>foreign</c>.
/// </param>
/// <param name="FailureCodes">Structured error codes, by count — including catalog-discovery failures.</param>
/// <param name="GeometryBytes">
/// Pose-local bytes across every stored pose this sweep touched (manifest + vertex blob), EXCLUDING atlas pages
/// and the <c>.complete</c> receipt.
/// </param>
/// <param name="SharedPages">Distinct content-addressed atlas pages those poses reference.</param>
/// <param name="PageReferences">
/// How many times a pose referenced a page. <c>PageReferences - SharedPages</c> is the sharing that happened.
/// </param>
/// <param name="SharedPageBytes">Those distinct pages' bytes, counted ONCE — the honest marginal page cost.</param>
/// <param name="PageBytesUnshared">
/// What the page bytes would have summed to if every pose carried its own copy. The gap against
/// <paramref name="SharedPageBytes"/> IS the page-sharing payoff, reported rather than claimed.
/// </param>
/// <param name="TotalStoredBytes"><paramref name="GeometryBytes"/> + <paramref name="SharedPageBytes"/>.</param>
/// <param name="MeasureFailures">
/// Poses that were produced but could not be sized. Non-zero means the byte figures above are a LOWER bound.
/// </param>
/// <param name="Rigs">
/// Per-rig cost rows, also emitted one per line under <see cref="CouchCoopGeoclipPrerenderJob.RigLogPrefix"/>.
/// The delta-vs-raster answer is PER RIG, not global: it depends on a rig's atlas size against its own stills.
/// EMPTY on a <see cref="CouchCoopGeoclipPrerenderJob.StatusPartial"/> snapshot — the rows are on their own
/// lines, which is what makes them survive a kill; <paramref name="RigCount"/> is populated either way.
/// </param>
public sealed record CouchCoopGeoclipPrerenderSummary(
    string Status,
    int DiscoveredScenes,
    int SpineNodes,
    int TotalClips,
    int Attempted,
    int Hits,
    int Baked,
    int Refused,
    int RefusedCached,
    int Failed,
    IReadOnlyDictionary<string, int> RefusalReasons,
    IReadOnlyDictionary<string, int> FailureCodes,
    int StoredPoses,
    long GeometryBytes,
    int SharedPages,
    int PageReferences,
    long SharedPageBytes,
    long PageBytesUnshared,
    long TotalStoredBytes,
    int MeasureFailures,
    int RigCount,
    IReadOnlyList<CouchCoopGeoclipRigCost> Rigs,
    long ElapsedMs);
