using System.Collections.Concurrent;
using System.Diagnostics;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Produces a baked GEOCLIP (per-part mesh geometry for one pose of one Spine rig) for the <c>/geoclips/</c>
/// route, and caches it in <see cref="CouchCoopGeoclipStore"/>. The twin of
/// <see cref="CouchCoopSpineClipProvider"/>, deliberately: same three layers, same reasons.
/// </summary>
/// <remarks>
/// <list type="number">
/// <item>
/// STORE PROBE — a pose's geometry is static per (scene, node, anim, policy) within a game/mod version, so a
/// complete directory on disk is served straight from the request thread with no Godot main-thread hop.
/// </item>
/// <item>
/// SINGLE-FLIGHT — the first request for an uncached key runs ONE bake under a per-key
/// <see cref="Lazy{T}"/>; concurrent requests for the same key await that task instead of each starting their
/// own main-thread render. The per-request <see cref="CancellationToken"/> is deliberately NOT threaded into the
/// shared bake: one caller cancelling (a browser tab closing) must not abort a bake others are awaiting. It
/// bounds the WAIT, not the work.
/// </item>
/// <item>
/// WRITE-THROUGH — the bake's output directory is adopted into the store (pages content-addressed and shared,
/// <c>.complete</c> last) before the result is returned, so the next request is a HIT.
/// </item>
/// </list>
/// <para>
/// THE GATE IS MANDATORY. A bake renders on the Godot MAIN THREAD, and
/// <see cref="CouchCoopAssetExtractionGate"/> is the one host-wide admission semaphore that keeps such renders
/// serialized across spine clips, stills and backgrounds. It exists because N simultaneous main-thread renders
/// collapse the frame rate far enough that the ENet co-op client misses its tick and the host drops it — a bake
/// that skips the gate can disconnect a player. The blocking call is additionally offloaded with
/// <see cref="Task.Run(Action)"/> so the awaiting request thread is not parked on it.
/// </para>
/// <para>
/// A REFUSAL IS REMEMBERED, and it is the only reason the sweep converges. About half of a real catalog's
/// identities come back incomplete; each costs seconds, and re-deciding that on every launch of a host that dies
/// every few hundred bakes means the store never fills. So a refusal writes a receipt
/// (<see cref="CouchCoopGeoclipStore.RecordRefusalAsync"/>) and the next ask for that identity is answered from
/// it, under the same code family and without a bake. The receipt is scoped to a separate refusal-policy revision,
/// so it is a verdict of THIS baker rather than a property of the rig: changing that revision retries refusals
/// without changing the address of completed artifacts.
/// </para>
/// <para>
/// Production is current-only and unconditional whenever the managed cache is available. A cold miss therefore
/// either bakes, returns a remembered refusal, or reports a real runtime/cache failure.
/// </para>
/// <para>
/// A COLD MISS BLOCKS ON THE BAKE. It deliberately does NOT fall back to the raster still: the raster has to be
/// produced on demand through this same single-slot main-thread gate (measured 271 ms / 658 ms on the two
/// reference rigs), so "serve the raster while the delta bakes" is a slower bake plus a wasted one. The raster
/// is reached only through the CLIENT's one-way per-node revert, on a refusal or a failure.
/// </para>
/// </remarks>
public sealed class CouchCoopGeoclipProvider(
    ICouchCoopGeoclipBaker baker,
    CouchCoopGeoclipStore store,
    Action<string>? log = null)
{
    /// <summary>
    /// Opt-IN switch for geoclip DIAGNOSTICS on the wire: the <c>/geoclips/</c> 404 gains an
    /// <see cref="RefusalHeader"/> naming the cause it otherwise swallows. Default OFF, exact <c>1</c> — the same
    /// opt-in vocabulary as <see cref="SpineBakeMetrics.BenchEnvVar"/> and <c>COUCHCOOP_BG_BENCH</c>.
    /// </summary>
    /// <remarks>
    /// It is off by default because the header carries producer-authored text (a completeness detail, a bake
    /// error) to every caller of a route that answers a wildcard CORS grant, and because the body it accompanies
    /// is deliberately generic. It exists because the alternative — the one this project has actually lived with —
    /// is recovering what a 404 meant from refusal-receipt archaeology after the fact.
    /// </remarks>
    public const string DiagnosticsEnvVar = "COUCHCOOP_GEOCLIP_DIAGNOSTICS";

    /// <summary>The response header <see cref="DiagnosticsEnvVar"/> arms: <c>&lt;arm&gt;; &lt;detail&gt;</c>.</summary>
    public const string RefusalHeader = "X-Geoclip-Refusal";

    /// <summary>
    /// A cap on the header's detail. A refusal detail is a short counted phrase; a bake ERROR message is
    /// producer-authored and unbounded, and an unbounded response header is a way to make a route hostile.
    /// </summary>
    public const int MaxRefusalDetailLength = 300;

    /// <summary>Whether this host explains its geoclip 404s on the wire. OFF unless the switch says exactly <c>1</c>.</summary>
    public static bool DiagnosticsEnabled
        => Environment.GetEnvironmentVariable(DiagnosticsEnvVar) == "1";

    /// <summary>The <see cref="SpineBakeMetrics"/> route token for the single-key on-demand lane.</summary>
    public const string SingleBakeRoute = "geoclip";

    /// <summary>…and for the rig lane, which bakes N poses of one rig under ONE gate admission.</summary>
    public const string RigBakeRoute = "geoclip-rig";

    /// <summary>A bake RAN just now and was kept out of the store because it did not cover the whole rig.</summary>
    public const string RefusedCode = "geoclip-bake-incomplete";

    /// <summary>
    /// A bake of this identity was refused EARLIER, under this same refusal-policy revision, and was not re-attempted.
    /// </summary>
    /// <remarks>
    /// Its own code rather than a repeat of <see cref="RefusedCode"/> because the two are different facts about
    /// the host: one says a bake just ran and failed the completeness guard, the other says no bake ran at all.
    /// A reader watching a resumed sweep needs to be able to tell "still broken" from "remembered as broken", and
    /// a client that gets this 404 in a millisecond instead of four seconds deserves to be told why.
    /// </remarks>
    public const string RefusedCachedCode = "geoclip-bake-refused-cached";

    /// <summary>
    /// The frame rate a bake is asked for. Matches the raster lane's
    /// <see cref="CouchCoopSpineClipProvider.SpineClipSizePolicy"/> so a delta and the still it replaces describe
    /// the same instant of the same clip; irrelevant for a single-pose bake, load-bearing the moment
    /// <see cref="SinglePoseFrames"/> stops being 1.
    /// </summary>
    public const int BakeFps = 15;

    /// <summary>
    /// A geoclip minted on demand is a ONE-FRAME clip at the pose the still renderer would have picked. That is
    /// the round's decision: zero new schema (it packs through CouchCoop's geoclip/1 path), zero new player
    /// code, and a static pose the browser draws once and never re-ticks.
    /// </summary>
    public const int SinglePoseFrames = 1;

    private readonly ICouchCoopGeoclipBaker _baker = baker ?? throw new ArgumentNullException(nameof(baker));
    private readonly CouchCoopGeoclipStore _store = store ?? throw new ArgumentNullException(nameof(store));
    private readonly Action<string> _log = log ?? CouchCoopLog.Stderr;

    // In-flight bakes only — an entry is removed once its task settles, so the map holds at most one Lazy per
    // concurrently-requested key (the store is the durable half). Keyed by the GEOCLIP key, so a geoclip request
    // never coalesces with the raster clip request for the same identity.
    private static readonly ConcurrentDictionary<string, Lazy<Task<CouchCoopGeoclipResult>>> InFlight = new(StringComparer.Ordinal);

    /// <summary>The store this provider writes through to — the route reads from the same instance.</summary>
    public CouchCoopGeoclipStore Store => _store;

    /// <summary>
    /// The complete pose directory for <paramref name="request"/>, baking it first if it is missing and
    /// on-demand production when it is missing.
    /// </summary>
    public async Task<CouchCoopGeoclipResult> GetAsync(
        CouchCoopGeoclipRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        var cached = _store.TryResolveDirectory(request.SpineKey);
        if (cached is not null)
        {
            return CouchCoopGeoclipResult.Hit(cached);
        }

        if (!_store.IsEnabled)
        {
            return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                "geoclip-store-disabled",
                "No geoclip cache root could be resolved on this host.",
                "key",
                request.SpineKey));
        }

        // THE NEGATIVE PROBE is before anything is created. It keeps a resumed sweep from re-deciding several
        // hundred multi-second bakes it has already decided, and keeps a client hammering a refused identity from
        // re-baking it per request.
        if (_store.TryReadRefusal(request.SpineKey) is { } remembered)
        {
            return CachedRefusal(request, remembered);
        }

        var geoclipKey = CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey);
        var lazy = InFlight.GetOrAdd(
            geoclipKey,
            _ => new Lazy<Task<CouchCoopGeoclipResult>>(
                () => BakeAsync(request),
                LazyThreadSafetyMode.ExecutionAndPublication));
        try
        {
            return await lazy.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            InFlight.TryRemove(geoclipKey, out _);
        }
    }

    private async Task<CouchCoopGeoclipResult> BakeAsync(CouchCoopGeoclipRequest request)
    {
        // Re-probe under the flight: a request that queued behind a bake for the same key while the winner was
        // adopting would otherwise bake it a second time.
        var settled = _store.TryResolveDirectory(request.SpineKey);
        if (settled is not null)
        {
            return CouchCoopGeoclipResult.Hit(settled);
        }

        var staging = _store.TryCreateStagingDirectory();
        if (staging is null)
        {
            return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                "geoclip-staging-failed",
                "Could not create a staging directory for the bake.",
                "key",
                request.SpineKey));
        }

        // ONE BAKE, ONE SAMPLE, filed with the raster lane's instrument so /perf/spine.json can lay the two
        // side by side. Opened HERE rather than after the gate, so the queue wait is inside the measurement:
        // every geoclip bake, every raster bake and every /bg/ render share ONE admission slot, so with four
        // creatures on screen the wait for it is a first-class part of "how long until the client has data".
        var bake = SpineBakeRecorder.Start(
            CouchCoopGeoclipStore.BuildGeoclipKey(request.SpineKey),
            SingleBakeRoute,
            SpineBakeMetrics.GeoclipKind);
        try
        {
            var started = Stopwatch.GetTimestamp();
            var command = new CouchCoopGeoclipBakeCommand(
                request.SceneResPath,
                request.NodePath,
                request.AnimationName,
                request.SampleTimeSeconds,
                staging,
                BakeFps,
                SinglePoseFrames,
                AnimationNames: null,
                // What this host already has, so the bake describes those pages instead of producing them. Read
                // per bake rather than cached: the set only grows (the store has no eviction), so a stale read
                // costs a re-encode and never a missing page.
                KnownPageContentIds: _store.KnownPageContentIds());

            CouchCoopGeoclipBakeOutcome outcome;
            await CouchCoopAssetExtractionGate.Gate.WaitAsync().ConfigureAwait(false);
            bake.GateAdmitted();
            try
            {
                // The bake marshals onto the Godot main thread and blocks; offload so the awaiting request
                // thread(s) are not parked and the result is a shareable task. The gate above bounds how many
                // main-thread renders run at once — one.
                outcome = await Task.Run(() => _baker.Bake(command)).ConfigureAwait(false);
            }
            catch (NotSupportedException exception)
            {
                bake.Failed();
                return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    CouchCoopRuntimeGeoclipBaker.GeoclipBakeCapability,
                    exception.Message,
                    "capabilityId",
                    CouchCoopRuntimeGeoclipBaker.GeoclipBakeCapability));
            }
            finally
            {
                CouchCoopAssetExtractionGate.Gate.Release();
            }

            bake.RenderReturned();
            if (!outcome.Success)
            {
                bake.Failed();
                _log($"geoclip bake failed key={request.SpineKey} code={outcome.ErrorCode ?? "unspecified"}");
                return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    outcome.ErrorCode ?? "geoclip-bake-failed",
                    outcome.ErrorMessage ?? "The geoclip bake did not succeed.",
                    "key",
                    request.SpineKey));
            }

            // WHERE THE BAKE ACTUALLY LANDED — resolved BEFORE the completeness verdict, because a bake that is
            // about to be refused still ran, still held the main thread for seconds, and still wrote the
            // breakdown of where that time went into the manifest it produced. Reading it only on the success
            // path would make a lane whose refusals are the common case look free.
            var produced = ResolveProducedDirectory(staging, outcome.ManifestPath);
            var profile = produced is null ? null : GeoclipBakeProfileReader.TryReadFile(outcome.ManifestPath);
            bake.ProducerProfile(profile?.Phases, profile?.Counters);
            // The ownership evidence, filed with the SAMPLE rather than only with a refusal — an ADMITTED bake
            // has no refusal header to carry it, and "admitted, and here is what on" is the reading that says
            // whether the ownership arm is doing anything. Sourced from the seam, not from the manifest, so it
            // survives a host whose producer-side phase profiler is switched off.
            bake.ClaimProvenance(outcome.ClaimsProven, outcome.ClaimsUnproven);

            // COMPLETENESS IS FATAL, NOT ADVISORY. An incomplete bake is not a failed bake: it writes a
            // WELL-FORMED directory holding wrong data (a measured example dropped 2 of 28 parts, found 0 of 44
            // colour-flip associations, and fell through to an atlas fallback that mis-assigned the rest — 8
            // vertices where the good bake had 58). Nothing downstream can tell that apart from a correct bake:
            // the manifest parses, the pages decode, the client draws it.
            //
            // Same hazard class as the 1x1 texture in CachedSpirectlAssetHttpAdapter's headless-seat belt, and
            // for the same reason it is not paranoia: this store is CONTENT-ADDRESSED and its pages are SHARED
            // across poses, so one bad bake can taint poses that were themselves fine, permanently, with no way
            // to distinguish the bad bytes from good ones at any later read. Refuse it: no .complete, no adopt,
            // staging swept by the finally below, a structured error, and the route 404s — which is exactly what
            // the route did before this lane existed.
            // THE PRODUCER NOW REPORTS ITS VERDICT. spirectl runs the same completeness rule with the same arm
            // vocabulary and hands back the reason it reached, so read that instead of asking the counters the
            // same question a second time. The local admission guard remains for producer results that have not
            // already been refused, but it grades the current claim provenance contract directly.
            if ((outcome.RefusalReason ?? IncompletenessReason(outcome)) is { } reason)
            {
                var arm = outcome.RefusalArm ?? ClassifyRefusal(reason);
                // AND REMEMBER IT, ON DISK — UNLESS IT IS RETRYABLE. spirectl's own memo is in-process and dies
                // with the game; without a persisted receipt this whole branch is re-derived from scratch on
                // every launch and every request — measured at a median 1.45 s and a p90 4.15 s per identity, on
                // a catalog where roughly half of them land here.
                //
                // But a receipt is DURABLE and is answered without baking, so the one refusal it must never
                // capture is the one that was never about the rig. When the producer's sweep validated fewer
                // meshes than there were slots and was not cut short by its own cap, its plan missed geometry
                // that a creature death had moved out of the inferred index hull — a property of the allocator at
                // that instant. Pin that and one unlucky bake poisons the identity on every later launch, for
                // ever. Refuse THIS request (nothing may be adopted: the bytes on disk are still wrong) and write
                // nothing, so the next ask re-bakes.
                //
                // ONLY WHERE THE PRODUCER JUDGED. The flag is the producer's answer about its own sweep; when the
                // reason came from couch's local backstop instead, the producer said nothing about this bake and
                // a stale-defaulted `true` must not be read as consent. Sticky is the safe direction.
                var retryable = outcome.RefusalReason is not null && outcome.RefusalRetryable;
                var recorded = !retryable
                    && await _store.RecordRefusalAsync(
                        request.SpineKey, arm, reason, outcome.ClaimsProven, outcome.ClaimsUnproven).ConfigureAwait(false);
                bake.Failed();
                _log(
                    $"geoclip bake REFUSED (incomplete) key={request.SpineKey} {reason} arm={arm} "
                    + $"producerJudged={(outcome.RefusalReason is null ? 0 : 1)} "
                    + $"fromMemo={(outcome.RefusedFromMemo ? 1 : 0)} "
                    + $"refusalRetryable={(retryable ? 1 : 0)} "
                    + $"{DescribeClaimProvenance(outcome.ClaimsProven, outcome.ClaimsUnproven)} "
                    + FormatBakeCost(bake, profile, started) + " — "
                    + $"not committed to the store; refusal recorded={(recorded ? 1 : 0)}");
                return CouchCoopGeoclipResult.Refused(
                    new CouchCoopAssetHttpError(
                        RefusedCode,
                        $"The geoclip bake did not acquire the whole rig ({reason}); it was not cached.",
                        "key",
                        request.SpineKey),
                    new CouchCoopGeoclipRefusal(
                        arm,
                        reason,
                        DateTimeOffset.UtcNow,
                        Cached: false,
                        outcome.ClaimsProven,
                        outcome.ClaimsUnproven));
            }

            // `produced` was resolved above, before the completeness verdict. Same rule, unchanged: spirectl
            // writes its artifacts into a per-target SUBDIRECTORY of the output directory
            // (`Sts2SpineGeoClipSpec.DirectoryName` — "<rig>--<node>--<anim>"), so adopting `staging` itself finds
            // no manifest, fails `geoclip-manifest-missing`, and throws away a bake that cost seconds — for every
            // request, for ever, with the route answering the same 404 it answers when nothing is armed at all.
            // The outcome NAMES the manifest it wrote; that path is constrained to the staging tree so a producer
            // that answered a path outside it can never make the store adopt somebody else's directory.
            if (produced is null)
            {
                bake.Failed();
                _log(
                    $"geoclip bake produced no manifest under staging key={request.SpineKey} "
                    + $"manifestPath={outcome.ManifestPath ?? "<null>"}");
                return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    "geoclip-manifest-missing",
                    "The geoclip bake reported success but wrote no manifest inside its staging directory.",
                    "key",
                    request.SpineKey));
            }

            // Measured BEFORE the adopt, because the adopt is what deduplicates the pages away: this is the bake's
            // own output, which is also what a cold client has to be sent.
            var producedBytes = MeasureBakeBytes(produced);
            var adoptStarted = Stopwatch.GetTimestamp();
            var adopted = await _store.AdoptAsync(request.SpineKey, produced).ConfigureAwait(false);
            bake.CacheWritten(adoptStarted);
            if (!adopted.Success || adopted.Directory is null)
            {
                bake.Failed();
                _log($"geoclip adopt failed key={request.SpineKey} code={adopted.ErrorCode ?? "unspecified"}");
                return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    adopted.ErrorCode ?? "geoclip-adopt-failed",
                    adopted.ErrorMessage ?? "The geoclip bake could not be published.",
                    "key",
                    request.SpineKey));
            }

            bake.Succeeded(producedBytes, outcome.FrameCount);
            _log(
                $"geoclip baked key={request.SpineKey} "
                + $"frames={outcome.FrameCount} parts={outcome.PartCount} pages={adopted.PageFiles.Count} "
                + $"t={outcome.SampleTimeSeconds:0.###}s source={outcome.SampleTimeSource ?? "unspecified"} "
                + $"bake={outcome.ElapsedMs}ms " + FormatBakeCost(bake, profile, started));
            return CouchCoopGeoclipResult.Miss(adopted.Directory, adopted.PageFiles);
        }
        finally
        {
            // A path that reached neither Succeeded nor Failed still records — a bake that threw its way out of
            // here cost the main thread exactly as much as one that returned, and an unrecorded sample is a hole
            // in the very number this lane exists to report. Finish() is idempotent, so the ordinary paths above
            // are unaffected.
            bake.Failed();
            _store.ReleaseStagingDirectory(staging);
        }
    }

    /// <summary>
    /// The bake's cost as a log fragment: the queue wait this side measured, then the producer's own
    /// blocking/parked split when it published one. Absent numbers are simply not printed.
    /// </summary>
    private static string FormatBakeCost(
        SpineBakeRecorder bake,
        GeoclipBakeProfileReader.Reading? profile,
        long started)
    {
        var text = $"gate={bake.GateWaitMs:0}ms total={Stopwatch.GetElapsedTime(started).TotalMilliseconds:0}ms";
        return profile is null
            // Not "blocking=0": the producer's profiler was off, or wrote a shape this host could not read, and a
            // zero here would be read as a bake that never held the main thread.
            ? text + " profile=unmeasured"
            : text + $" blocking={profile.BlockingMs:0}ms parked={profile.ParkedMs:0}ms"
                + $" other={profile.UnattributedMs:0}ms";
    }

    /// <summary>
    /// How many bytes a bake wrote, or 0 when that could not be measured. Best-effort by construction: an
    /// instrument may not be able to fail a bake.
    /// </summary>
    /// <remarks>
    /// This is the bake's OWN output, which is not the same as the artifact's total size: a pose whose atlas pages
    /// this store already holds is told so (<see cref="CouchCoopGeoclipStore.KnownPageContentIds"/>) and does not
    /// write them, so a warm store's second pose of a rig measures as geometry alone. That is the honest number
    /// for "what did this bake produce"; it is not the number for "what does a cold client download".
    /// </remarks>
    private static int MeasureBakeBytes(string directory)
    {
        try
        {
            long total = 0;
            foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            {
                total += new FileInfo(file).Length;
                if (total >= int.MaxValue)
                {
                    return int.MaxValue;
                }
            }

            return (int)total;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    /// <summary>
    /// Answer a request from a refusal receipt, without baking.
    /// </summary>
    /// <remarks>
    /// Deliberately NOT logged. The caller gets the whole verdict as structured data, and the two callers that
    /// exist would both be made worse by a line here: a sweep prints its own per-item row (so this would double
    /// every one of several hundred), and a browser retrying a refused creature would otherwise be able to fill
    /// the log by asking. The receipt on disk is the durable record; this is just reading it out.
    /// </remarks>
    private static CouchCoopGeoclipResult CachedRefusal(
        CouchCoopGeoclipRequest request,
        CouchCoopGeoclipRefusalRecord record)
        => CouchCoopGeoclipResult.Refused(
            new CouchCoopAssetHttpError(
                RefusedCachedCode,
                // The guard's own detail rides LAST, in parentheses, exactly as the fresh refusal's message
                // shapes it — so anything that reads these messages sees one shape, not two.
                $"A geoclip bake of this identity was refused at {record.RefusedUtc:u} under geoclip refusal policy "
                + $"'{record.RefusalPolicyRevision}' and was not re-attempted ({record.Detail}).",
                "key",
                request.SpineKey),
            new CouchCoopGeoclipRefusal(
                record.Reason,
                record.Detail,
                record.RefusedUtc,
                Cached: true,
                record.ClaimsProven,
                record.ClaimsUnproven));

    /// <summary>
    /// Bucket a refusal DETAIL onto one of four stable reason tokens — <c>incomplete</c> (the baker's own
    /// verdict), <c>unassociated</c> (slots it saw but could not tie to a mesh surface), <c>ownership</c>
    /// (unclaimed geometry in the bracket beside a claim that carries no positive proof), and <c>foreign</c> (the
    /// legacy bare-leftover arm, still reached whenever no claim provenance was available to grade).
    /// </summary>
    /// <remarks>
    /// <para><see cref="IncompletenessReason(bool,int,int,int,int,int,bool?)"/>'s arms carry COUNTS
    /// (<c>associated=40 of slotsEverVisible=44</c>), so the raw text is unbucketable — one distinct value per
    /// rig. What is stable is WHICH ARM fired, which is the text before the first <c>=</c>. That token is then
    /// renamed to the vocabulary a reader uses rather than the guard's field names. The full detail is kept
    /// beside the bucket everywhere it is stored or logged, so summarising here loses nothing.</para>
    /// <para><c>ownership</c> and <c>claim-provenance-missing</c> remain distinct: the first has graded evidence
    /// with weak claims; the second is rejected because current evidence was absent.</para>
    /// </remarks>
    public static string ClassifyRefusal(string? reasonDetail)
    {
        if (string.IsNullOrWhiteSpace(reasonDetail))
        {
            return "other";
        }

        var equals = reasonDetail.IndexOf('=', StringComparison.Ordinal);
        return (equals > 0 ? reasonDetail[..equals] : reasonDetail).Trim() switch
        {
            "complete" => "incomplete",
            "associated" => "unassociated",
            "foreignMeshes" => "foreign",
            "claim-provenance-missing" => "provenance",
            "ownership" => "ownership",
            _ => "other",
        };
    }

    // ── The refusal, as a response header (diagnostics only) ──────────────────────────────────────────

    /// <summary>
    /// What a geoclip request came back with, in the <see cref="RefusalHeader"/> form <c>&lt;arm&gt;; &lt;detail&gt;</c>
    /// — or null when the result is not a failure and there is nothing to explain.
    /// </summary>
    /// <remarks>
    /// The ARM is the structured code the provider already returns (<see cref="RefusedCode"/>,
    /// <see cref="RefusedCachedCode"/>, <c>geoclip-manifest-missing</c>, <c>geoclip-store-disabled</c>, …) — the
    /// distinction the 404 body deliberately flattens into one <c>geoclip-not-found</c>. The DETAIL prefers the
    /// completeness verdict when there is one, because <c>arm=foreign foreignMeshes=74</c> is the sentence a
    /// diagnosis actually needs, and falls back to the error's own message otherwise.
    ///
    /// <para>THE CLAIM PROVENANCE RIDES WITH IT because the arm alone is no longer enough to act on. Under the
    /// ownership rule <c>arm=foreign</c> means "nothing graded the claims" and <c>arm=ownership</c> means "they
    /// were graded and N failed", and the difference decides whether an operator goes looking at the rig or at
    /// the bridge build. Recovering that from the host log afterwards is exactly the archaeology this header
    /// exists to end.</para>
    /// </remarks>
    public static string? TryDescribeRefusal(CouchCoopGeoclipResult? produced)
    {
        if (produced?.Error is not { } error)
        {
            return null;
        }

        return produced.Refusal is { } refusal
            ? FormatRefusalHeader(
                error.Code,
                $"arm={refusal.Reason} cached={(refusal.Cached ? 1 : 0)} refusedUtc={refusal.RefusedUtc:u} "
                + $"{DescribeClaimProvenance(refusal.ClaimsProven, refusal.ClaimsUnproven)} {refusal.Detail}")
            : FormatRefusalHeader(error.Code, error.Message);
    }

    /// <summary>The same form for a receipt read straight off disk, when no bake was attempted at all.</summary>
    public static string DescribeCachedRefusal(CouchCoopGeoclipRefusalRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        return FormatRefusalHeader(
            RefusedCachedCode,
            $"arm={record.Reason} cached=1 refusedUtc={record.RefusedUtc:u} policy={record.RefusalPolicyRevision} "
            + $"{DescribeClaimProvenance(record.ClaimsProven, record.ClaimsUnproven)} "
            + record.Detail);
    }

    /// <summary>
    /// The ownership evidence behind a verdict, as a header/log fragment.
    /// </summary>
    /// <remarks>
    /// <para>A ZERO PAIR IS NAMED, not printed as two zeros. <c>claimsProven=0 claimsUnproven=0</c> reads as "no
    /// claim was proven", which is the opposite of what it means: it means nothing recorded HOW the claims were
    /// made, so the rule fell back to the legacy leftover arm and no ownership question was ever asked. Same
    /// discipline as the phase profile's "absent means unmeasured" — a reader who cannot tell "not measured"
    /// from "measured as nothing" will misdiagnose, and here the two lead to opposite actions (upgrade the
    /// bridge vs. investigate the rig).</para>
    /// <para>It also carries the ROUND'S OPEN QUESTION on the wire. An Ironclad's atlas claims are proofs only
    /// when they matched at <c>uv-region-exact</c>; a bare containment match is not. So <c>claimsProven=37
    /// claimsUnproven=0</c> and <c>claimsProven=0 claimsUnproven=37</c> are the two live outcomes of the same
    /// bake, they decide whether the artifact is admitted, and until this fragment existed the only way to tell
    /// them apart was to shape a separate env-lane bake and read its log.</para>
    /// </remarks>
    public static string DescribeClaimProvenance(int claimsProven, int claimsUnproven)
        => claimsProven + claimsUnproven <= 0
            ? "claimProvenance=none"
            : $"claimsProven={claimsProven} claimsUnproven={claimsUnproven}";

    /// <summary>
    /// <c>&lt;arm&gt;; &lt;detail&gt;</c>, made safe to put in an HTTP header.
    /// </summary>
    /// <remarks>
    /// BOTH halves are sanitized, not just the detail. The arm is a code this host chose, but the detail is
    /// producer-authored (a spirectl failure message can quote an exception), and a header value carrying a CR or
    /// an LF is response splitting. So: control characters and non-ASCII out, runs of whitespace collapsed, the
    /// detail truncated at <see cref="MaxRefusalDetailLength"/>. Truncation is marked with a trailing ellipsis so
    /// a reader can tell a cut-off detail from a short one.
    /// </remarks>
    public static string FormatRefusalHeader(string arm, string? detail)
    {
        var safeArm = SanitizeHeaderText(arm, 120);
        var safeDetail = SanitizeHeaderText(detail, MaxRefusalDetailLength);
        return safeArm.Length == 0
            ? (safeDetail.Length == 0 ? "unspecified" : safeDetail)
            : (safeDetail.Length == 0 ? safeArm : $"{safeArm}; {safeDetail}");
    }

    private static string SanitizeHeaderText(string? text, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return string.Empty;
        }

        var builder = new System.Text.StringBuilder(Math.Min(text!.Length, maxLength));
        var pendingSpace = false;
        var truncated = false;
        foreach (var character in text)
        {
            // Printable US-ASCII only: everything else — CR and LF above all, which is response splitting — is
            // treated as a word break rather than escaped, because none of it carries meaning here.
            if (character is < ' ' or > '~' or ' ')
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (builder.Length + (pendingSpace ? 1 : 0) >= maxLength)
            {
                truncated = true;
                break;
            }

            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }

            builder.Append(character);
        }

        // Marked, so a reader can tell a detail that was cut from one that was short.
        return truncated ? builder.Append("...").ToString() : builder.ToString();
    }

    /// <summary>
    /// The directory holding the manifest this bake wrote, or null when it wrote none inside
    /// <paramref name="staging"/>.
    /// </summary>
    /// <remarks>
    /// Two shapes are legal and both resolve here: a producer that writes straight into the directory it was given
    /// (the staging root itself), and one that nests a per-target folder under it (what spirectl's baker does). The
    /// containment check is not decoration — the manifest path is an answer from another assembly, and it selects
    /// the directory the store is about to publish, so a path outside staging must be refused rather than adopted.
    /// </remarks>
    internal static string? ResolveProducedDirectory(string staging, string? manifestPath)
    {
        if (string.IsNullOrWhiteSpace(staging) || string.IsNullOrWhiteSpace(manifestPath))
        {
            return null;
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(manifestPath));
        if (string.IsNullOrEmpty(directory))
        {
            return null;
        }

        var root = Path.GetFullPath(staging).TrimEnd(Path.DirectorySeparatorChar);
        var inside = string.Equals(directory, root, StringComparison.Ordinal)
            || directory.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        return inside ? directory : null;
    }

    /// <summary>
    /// Why this bake may not enter the store, or null when it may. Three arms that fail independently: the
    /// baker's own <c>complete</c> verdict, slots it saw but could not associate with a mesh surface, and — when
    /// unclaimed geometry sits inside the bracket — whether the claims it DID make are actually proven.
    /// </summary>
    public static string? IncompletenessReason(CouchCoopGeoclipBakeOutcome outcome)
    {
        ArgumentNullException.ThrowIfNull(outcome);
        return IncompletenessReason(
            outcome.Complete,
            outcome.Associated,
            outcome.SlotsEverVisible,
            outcome.ForeignMeshes,
            outcome.ClaimsProven,
            outcome.ClaimsUnproven);
    }

    /// <summary>
    /// The same verdict for ONE pose of a rig bake. Same function, not a second copy of the rule: a batch that
    /// graded its poses by a slightly different rule than a single bake would let a pose into the store that the
    /// on-demand path would have refused, on a store that is content-addressed and never re-decided.
    /// </summary>
    public static string? IncompletenessReason(CouchCoopGeoclipPoseOutcome pose)
    {
        ArgumentNullException.ThrowIfNull(pose);
        return IncompletenessReason(
            pose.Complete,
            pose.Associated,
            pose.SlotsEverVisible,
            pose.ForeignMeshes,
            pose.ClaimsProven,
            pose.ClaimsUnproven);
    }

    /// <summary>
    /// The rule, on raw counters — couch's own copy of spirectl's admission rule, kept deliberately independent
    /// so an unjudged bake cannot enter a content-addressed store just because the producer said nothing.
    /// </summary>
    /// <remarks>
    /// <para>THE THIRD ARM IS OWNERSHIP, not a mesh count, and it has to move in lockstep with spirectl's
    /// (<c>Sts2SpineGeoClipRequestLane.IncompletenessReason</c>, spirectl <c>71c92bc7</c>) or couch simply
    /// re-refuses on its own arm and the upstream change is invisible on this route. Because the two arms above
    /// it fire first, the third is only ever reached by a bake that COMPLETED with every drawable slot
    /// associated — so what it is really asking is whether those claims are sound, and unclaimed leftovers were
    /// only ever a proxy for that. A measured counter-example retired the proxy: a complete, fully associated
    /// Ironclad bake was discarded over 8 leftovers that were its own geometry for attachments not drawable at
    /// the sampled pose. The arm now fires when the bracket holds leftovers AND at least one claim rests on
    /// something weaker than a colour flip or an exact atlas match.</para>
    /// </remarks>
    public static string? IncompletenessReason(
        bool complete,
        int associated,
        int slotsEverVisible,
        int foreignMeshes,
        int claimsProven,
        int claimsUnproven)
    {
        if (!complete)
        {
            return "complete=false";
        }

        if (associated < slotsEverVisible)
        {
            return $"associated={associated} of slotsEverVisible={slotsEverVisible}";
        }

        if (foreignMeshes <= 0)
        {
            // Nothing unclaimed in the bracket, so no ownership question arises: the claims exhaust the
            // validated mesh pool and there is nothing an unproven claim could have taken instead.
            return null;
        }

        var claims = claimsProven + claimsUnproven;
        if (claims <= 0)
        {
            return "claim-provenance-missing";
        }

        return claimsUnproven > 0 ? $"ownership={claimsUnproven} of claimed={claims}" : null;
    }

    /// <summary>
    /// Whether a REFUSED pose's own sweep counters say the refusal is an acquisition fault a later bake of the
    /// same identity could pass — in which case it must NOT get a durable receipt.
    /// </summary>
    /// <remarks>
    /// <para>THE MIRROR OF <c>Sts2SpineGeoClipRequestLane.IsRetryableAcquisitionShortfall</c> (spirectl
    /// <c>7cb0e6b5</c>), byte for byte, and a couch-local copy for the same reason
    /// <see cref="IncompletenessReason(bool,int,int,int,int,int,bool?)"/> is one: the producer's is
    /// <c>internal</c> to <c>Spirectl.Sts2</c> and its class is internal too, so this assembly cannot call it. It
    /// exists ONLY because the rig lane judges each pose alone and there is no per-pose flag upstream to carry —
    /// the single lane reads the producer's own <see cref="CouchCoopGeoclipBakeOutcome.RefusalRetryable"/>
    /// instead, and must keep doing so. If spirectl ever publishes the predicate, delete this and call it.</para>
    /// <para>BOTH CLAUSES ARE LOAD-BEARING, and both narrow it. <paramref name="sweepTruncated"/> means a window
    /// swept a subset of its own plan because it hit its candidate cap: the sweep did not finish, so re-running it
    /// under the same cap reproduces the shortfall exactly. That is a configuration verdict and it STICKS. And
    /// <paramref name="meshesValidated"/> zero is MISSING evidence rather than a measured shortfall — a producer
    /// too old to report the counters, or a seam that dropped them — so it also sticks, the same fail-closed
    /// asymmetry the ownership arm takes on <c>claimsProven + claimsUnproven == 0</c>.</para>
    /// <para>ERR STICKY. A refusal wrongly called retryable costs a full re-bake on every request for ever; one
    /// wrongly called sticky costs what the previous behaviour cost. So this widens nothing on its own: it is
    /// applied to a pose the completeness rule ALREADY refused, and it only ever decides whether that refusal is
    /// written down.</para>
    /// </remarks>
    public static bool IsRetryableAcquisitionShortfall(int meshesValidated, int slotsEverVisible, bool sweepTruncated)
        => meshesValidated > 0 && !sweepTruncated && meshesValidated < slotsEverVisible;

    /// <summary>The same verdict for one pose of a rig bake, on the counters the seam carried for it.</summary>
    public static bool IsRetryableAcquisitionShortfall(CouchCoopGeoclipPoseOutcome pose)
    {
        ArgumentNullException.ThrowIfNull(pose);
        return IsRetryableAcquisitionShortfall(pose.MeshesValidated, pose.SlotsEverVisible, pose.SweepTruncated);
    }

    // ── The RIG lane: N poses of one (scene, node), ONE bake ──────────────────────────────────────────

    /// <summary>
    /// Produce every requested pose of ONE rig, baking the ones this host does not already have or has not
    /// already refused — in a single bake, so the per-scene sweep and association are paid once rather than N
    /// times.
    /// </summary>
    /// <remarks>
    /// <para>THE PRODUCER DECIDES WHETHER IT REALLY BATCHED. Sharing a slot↔mesh association across poses is only
    /// sound while the rig neither re-mints mesh RIDs nor swaps what a slot draws; spirectl measures both and
    /// re-bakes what it must, per target. So this lane asks for the amortisation and reads back whether it
    /// happened (<see cref="CouchCoopGeoclipPoseOutcome.Batched"/>), never assumes it.</para>
    /// <para>EACH POSE IS STILL JUDGED AND ADOPTED ALONE. The completeness guard, the refusal receipt and the
    /// adopt are per identity exactly as on the single lane — one bad pose of a rig must not keep its siblings out
    /// of the store, and one good pose must not carry a bad one in.</para>
    /// <para>NO RIG-LEVEL SINGLE-FLIGHT. Its caller is the prerender sweep, which is serial; a browser asking for
    /// one of these keys concurrently would bake it a second time and adopt identical bytes, which is wasted work
    /// and not a wrong answer (the adopt is idempotent and <c>.complete</c> is still written last).</para>
    /// </remarks>
    public async Task<IReadOnlyList<CouchCoopGeoclipResult>> GetRigAsync(
        IReadOnlyList<CouchCoopGeoclipRequest> requests,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(requests);
        cancellationToken.ThrowIfCancellationRequested();
        if (requests.Count == 0)
        {
            return [];
        }

        var results = new CouchCoopGeoclipResult?[requests.Count];
        var pending = new List<int>();
        for (var i = 0; i < requests.Count; i += 1)
        {
            if (_store.TryResolveDirectory(requests[i].SpineKey) is { } cached)
            {
                results[i] = CouchCoopGeoclipResult.Hit(cached);
                continue;
            }

            if (!_store.IsEnabled)
            {
                // Both refusals are per-request and identical for every one of them; let the single lane state
                // them so there is exactly one wording.
                results[i] = await GetAsync(requests[i], cancellationToken).ConfigureAwait(false);
                continue;
            }

            if (_store.TryReadRefusal(requests[i].SpineKey) is { } remembered)
            {
                results[i] = CachedRefusal(requests[i], remembered);
                continue;
            }

            pending.Add(i);
        }

        // Nothing to bake, or one thing to bake: the single lane is strictly better for one (it single-flights
        // against concurrent browser requests, which this lane does not).
        if (pending.Count == 0)
        {
            return [.. results.Select(result => result!)];
        }

        if (pending.Count == 1)
        {
            results[pending[0]] = await GetAsync(requests[pending[0]], cancellationToken).ConfigureAwait(false);
            return [.. results.Select(result => result!)];
        }

        var baked = await BakeRigAsync([.. pending.Select(index => requests[index])]).ConfigureAwait(false);
        for (var i = 0; i < pending.Count; i += 1)
        {
            results[pending[i]] = baked[i];
        }

        return [.. results.Select(result => result!)];
    }

    private async Task<IReadOnlyList<CouchCoopGeoclipResult>> BakeRigAsync(IReadOnlyList<CouchCoopGeoclipRequest> requests)
    {
        var staging = _store.TryCreateStagingDirectory(requests.Count);
        if (staging is null)
        {
            return [.. requests.Select(request => CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                "geoclip-staging-failed",
                "Could not create a staging directory for the bake.",
                "key",
                request.SpineKey)))];
        }

        // ONE SAMPLE FOR THE WHOLE RIG BAKE, not one per pose. This lane takes the extraction gate ONCE and runs
        // ONE main-thread bake for N animations — the per-pose bookkeeping below is adoption, not baking — so N
        // samples would report the same seconds N times. It is named for the rig's FIRST key because a sample has
        // one key and that is the only real one available; `frames` and the pose count in the log say how many
        // poses it covers.
        var bake = SpineBakeRecorder.Start(
            CouchCoopGeoclipStore.BuildGeoclipKey(requests[0].SpineKey),
            RigBakeRoute,
            SpineBakeMetrics.GeoclipKind);
        try
        {
            var started = Stopwatch.GetTimestamp();
            var head = requests[0];
            var command = new CouchCoopGeoclipBakeCommand(
                head.SceneResPath,
                head.NodePath,
                head.AnimationName,
                head.SampleTimeSeconds,
                staging,
                BakeFps,
                SinglePoseFrames,
                AnimationNames: [.. requests.Select(request => request.AnimationName)],
                KnownPageContentIds: _store.KnownPageContentIds());

            CouchCoopGeoclipBakeOutcome outcome;
            await CouchCoopAssetExtractionGate.Gate.WaitAsync().ConfigureAwait(false);
            bake.GateAdmitted();
            try
            {
                outcome = await Task.Run(() => _baker.Bake(command)).ConfigureAwait(false);
            }
            catch (NotSupportedException exception)
            {
                bake.Failed();
                return [.. requests.Select(request => CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    CouchCoopRuntimeGeoclipBaker.GeoclipBakeCapability,
                    exception.Message,
                    "capabilityId",
                    CouchCoopRuntimeGeoclipBaker.GeoclipBakeCapability)))];
            }
            finally
            {
                CouchCoopAssetExtractionGate.Gate.Release();
            }

            bake.RenderReturned();
            var poses = outcome.PoseOutcomes;
            if (!outcome.Success && poses.Count == 0)
            {
                bake.Failed();
                _log(
                    $"geoclip rig bake failed scene={head.SceneResPath} "
                    + $"poses={requests.Count} code={outcome.ErrorCode ?? "unspecified"}");
                return [.. requests.Select(request => CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                    outcome.ErrorCode ?? "geoclip-bake-failed",
                    outcome.ErrorMessage ?? "The geoclip bake did not succeed.",
                    "key",
                    request.SpineKey)))];
            }

            var profile = ReadRigProfile(staging, poses);
            bake.ProducerProfile(profile?.Phases, profile?.Counters);
            // SUMMED OVER POSES, unlike the phase profile just above (which takes the last pose's reading because
            // a rig's per-pose profiles multiply-count the shared sweep). These are not durations: a rig bake
            // grades each pose's claims separately, so the sum is literally how many claims this ONE bake graded
            // and how many of them proved out. Nothing is double-counted; the same slot claimed in two poses is
            // two claims, graded twice.
            var claimsProven = poses.Sum(pose => pose.ClaimsProven);
            var claimsUnproven = poses.Sum(pose => pose.ClaimsUnproven);
            bake.ClaimProvenance(claimsProven, claimsUnproven);
            _log(
                $"geoclip rig baked scene={head.SceneResPath} poses={poses.Count}/{requests.Count} "
                + $"scenesLoaded={outcome.ScenesLoaded} note={outcome.BatchNote ?? "unspecified"} "
                + $"batched={poses.Count(pose => pose.Batched)} "
                + $"{DescribeClaimProvenance(claimsProven, claimsUnproven)} "
                + $"bake={outcome.ElapsedMs}ms " + FormatBakeCost(bake, profile, started));

            var producedBytes = MeasureBakeBytes(staging);
            var adoptStarted = Stopwatch.GetTimestamp();
            var results = new List<CouchCoopGeoclipResult>(requests.Count);
            foreach (var request in requests)
            {
                var pose = poses.FirstOrDefault(
                    candidate => string.Equals(candidate.AnimationName, request.AnimationName, StringComparison.Ordinal));
                results.Add(pose is null
                    ? CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                        "geoclip-pose-missing",
                        $"The rig bake answered for {poses.Count} pose(s) and none of them was "
                        + $"'{request.AnimationName}'.",
                        "key",
                        request.SpineKey))
                    : await AdoptPoseAsync(request, staging, pose).ConfigureAwait(false));
            }

            bake.CacheWritten(adoptStarted);
            // The BAKE ran and produced poses, which is what this sample prices. Whether each pose then passed the
            // completeness guard is a separate per-identity verdict recorded per pose — one refused pose does not
            // make the rig's main-thread seconds un-spent.
            bake.Succeeded(producedBytes, poses.Sum(pose => pose.FrameCount));
            return results;
        }
        finally
        {
            bake.Failed(); // idempotent; see the single lane
            _store.ReleaseStagingDirectory(staging);
        }
    }

    /// <summary>
    /// The rig bake's phase profile, taken from the LAST pose that published one.
    /// </summary>
    /// <remarks>
    /// A rig bake writes each pose's manifest while the pass is still running, so the profile inside it is the
    /// bake SO FAR — every per-rig cost plus that pose's own — rather than that pose's share. Reading them all and
    /// summing would therefore multiply-count the sweep and the association, which are 90-96 % of the total; the
    /// LAST one is the closest thing to the whole bake's cost, which is the quantity this one-sample-per-bake lane
    /// wants. It is still an under-count by whatever the final pose did after writing its manifest, and it is
    /// carried anyway: an under-count of the thing being reported is honest, while an invented per-pose split
    /// would not be.
    /// </remarks>
    private static GeoclipBakeProfileReader.Reading? ReadRigProfile(
        string staging,
        IReadOnlyList<CouchCoopGeoclipPoseOutcome> poses)
    {
        for (var i = poses.Count - 1; i >= 0; i -= 1)
        {
            if (ResolveProducedDirectory(staging, poses[i].ManifestPath) is null)
            {
                continue;
            }

            if (GeoclipBakeProfileReader.TryReadFile(poses[i].ManifestPath) is { } profile)
            {
                return profile;
            }
        }

        return null;
    }

    /// <summary>
    /// Judge and publish ONE pose of a rig bake — the same three steps the single lane takes after its bake, in
    /// the same order and with the same wording, because a sweep must not be able to tell which lane produced a
    /// row.
    /// </summary>
    private async Task<CouchCoopGeoclipResult> AdoptPoseAsync(
        CouchCoopGeoclipRequest request,
        string staging,
        CouchCoopGeoclipPoseOutcome pose)
    {
        if (!pose.Success)
        {
            _log($"geoclip bake failed key={request.SpineKey} detail={pose.FailureReason ?? "unspecified"}");
            return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                "geoclip-bake-failed",
                pose.FailureReason ?? "The geoclip bake did not succeed.",
                "key",
                request.SpineKey));
        }

        if (IncompletenessReason(pose) is { } reason)
        {
            var arm = ClassifyRefusal(reason);
            // The same durable-receipt rule the single lane applies, on the only evidence this lane has. A rig
            // result's top-level RefusalRetryable describes the FIRST refused pose and is absent entirely when
            // some other pose was adoptable, while this lane refuses and records each pose ALONE — so the flag
            // upstream cannot answer for this pose and the verdict is derived from the pose's own sweep counters
            // instead. Same predicate, same two clauses; see IsRetryableAcquisitionShortfall for why couch keeps
            // its own copy and why both clauses narrow it.
            var retryable = IsRetryableAcquisitionShortfall(pose);
            var recorded = !retryable
                && await _store.RecordRefusalAsync(
                    request.SpineKey, arm, reason, pose.ClaimsProven, pose.ClaimsUnproven).ConfigureAwait(false);
            _log(
                $"geoclip bake REFUSED (incomplete) key={request.SpineKey} {reason} arm={arm} "
                + $"refusalRetryable={(retryable ? 1 : 0)} "
                + $"{DescribeClaimProvenance(pose.ClaimsProven, pose.ClaimsUnproven)}"
                + (pose.ClaimProofNote is { Length: > 0 } note ? $" [{note}]" : string.Empty)
                + " — not committed to the store; refusal recorded="
                + $"{(recorded ? 1 : 0)}");
            return CouchCoopGeoclipResult.Refused(
                new CouchCoopAssetHttpError(
                    RefusedCode,
                    $"The geoclip bake did not acquire the whole rig ({reason}); it was not cached.",
                    "key",
                    request.SpineKey),
                new CouchCoopGeoclipRefusal(
                    arm,
                    reason,
                    DateTimeOffset.UtcNow,
                    Cached: false,
                    pose.ClaimsProven,
                    pose.ClaimsUnproven));
        }

        var produced = ResolveProducedDirectory(staging, pose.ManifestPath);
        if (produced is null)
        {
            _log(
                $"geoclip bake produced no manifest under staging key={request.SpineKey} "
                + $"manifestPath={pose.ManifestPath ?? "<null>"}");
            return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                "geoclip-manifest-missing",
                "The geoclip bake reported success but wrote no manifest inside its staging directory.",
                "key",
                request.SpineKey));
        }

        var adopted = await _store.AdoptAsync(request.SpineKey, produced).ConfigureAwait(false);
        if (!adopted.Success || adopted.Directory is null)
        {
            _log($"geoclip adopt failed key={request.SpineKey} code={adopted.ErrorCode ?? "unspecified"}");
            return CouchCoopGeoclipResult.Failure(new CouchCoopAssetHttpError(
                adopted.ErrorCode ?? "geoclip-adopt-failed",
                adopted.ErrorMessage ?? "The geoclip bake could not be published.",
                "key",
                request.SpineKey));
        }

        _log(
            $"geoclip baked key={request.SpineKey} "
            + $"frames={pose.FrameCount} parts={pose.PartCount} pages={adopted.PageFiles.Count} "
            + $"t={pose.SampleTimeSeconds:0.###}s source={pose.SampleTimeSource ?? "unspecified"} "
            + $"batched={(pose.Batched ? 1 : 0)}");
        return CouchCoopGeoclipResult.Miss(adopted.Directory, adopted.PageFiles);
    }
}

/// <param name="SpineKey">
/// The canonical <c>spine://</c> key for the ANIMATED clip identity, minted by
/// <see cref="CouchCoopSpineClipProvider.BuildSpineKey"/>. The store appends
/// <see cref="CouchCoopGeoclipStore.GeoclipSelector"/> itself, so callers never spell the geoclip tail.
/// </param>
public sealed record CouchCoopGeoclipRequest(
    string SpineKey,
    string SceneResPath,
    string? NodePath,
    string AnimationName,
    double? SampleTimeSeconds = null);

/// <param name="Reason">
/// The stable arm token: <c>incomplete</c> / <c>unassociated</c> / <c>ownership</c> / <c>foreign</c>.
/// </param>
/// <param name="Detail">The completeness guard's full text, counts included.</param>
/// <param name="Cached">
/// Whether this verdict was READ from a receipt rather than reached by a bake that just ran. The distinction is
/// what keeps a resumed sweep's numbers comparable to a cold one's: both report the identity as refused, and only
/// one of them paid for it.
/// </param>
/// <param name="ClaimsProven">
/// The ownership evidence the refused bake carried, so a reader of the verdict can see WHY the third arm decided
/// as it did. Both zero means the bake reported no provenance — which is itself the answer to "why did this
/// refuse on <c>foreign</c> when the ownership arm exists", and the reason
/// <see cref="CouchCoopGeoclipProvider.DescribeClaimProvenance"/> spells that case out rather than printing
/// <c>0</c> and <c>0</c>.
/// </param>
/// <param name="ClaimsUnproven">The other half of the same pair.</param>
public sealed record CouchCoopGeoclipRefusal(
    string Reason,
    string Detail,
    DateTimeOffset RefusedUtc,
    bool Cached,
    int ClaimsProven = 0,
    int ClaimsUnproven = 0);

/// <param name="Refusal">
/// Set exactly when the completeness guard kept this identity out of the store — fresh or remembered. Carried as
/// STRUCTURE rather than left to be re-parsed out of <paramref name="Error"/>'s message, because the sweep's
/// per-rig table is bucketed by it and a table bucketed by prose is one wording change from being all
/// <c>other</c>.
/// </param>
public sealed record CouchCoopGeoclipResult(
    string? Directory,
    string CacheStatus,
    IReadOnlyList<string> PageFiles,
    CouchCoopAssetHttpError? Error,
    CouchCoopGeoclipRefusal? Refusal = null)
{
    public static CouchCoopGeoclipResult Hit(string directory) => new(directory, "HIT", [], null);

    public static CouchCoopGeoclipResult Miss(string directory, IReadOnlyList<string> pageFiles)
        => new(directory, "MISS", pageFiles, null);

    public static CouchCoopGeoclipResult Failure(CouchCoopAssetHttpError error) => new(null, "MISS", [], error);

    public static CouchCoopGeoclipResult Refused(CouchCoopAssetHttpError error, CouchCoopGeoclipRefusal refusal)
        => new(null, "MISS", [], error, refusal);
}
