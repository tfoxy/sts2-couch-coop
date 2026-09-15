using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Bake the geoclips for the creatures of the encounter that just loaded, at LOAD TIME, so that no bake lands in
/// the middle of combat and the client's first request for one is a store hit rather than a main-thread produce.
/// </summary>
/// <remarks>
/// <para>
/// THIS IS NOT A SPEEDUP, AND THE ROUND'S OWN MEASUREMENT SAYS SO. A cold per-request comparison on the
/// KNIGHTS_ELITE encounter put geoclip at 162.5 ms p50 of Godot main-thread BLOCKING time against the shipped
/// <c>/spines/</c> still's 114.4 ms — geoclip lost every one of 40 pairs, on all four creatures, because posing
/// the rig and reading its geometry back cannot leave the main thread while the still's cost is almost entirely
/// the ENCODE, which is already offloaded. Prerendering does not make that work cheaper by a millisecond. It
/// RELOCATES it: the encounter's ~684 ms of main-thread blocking (four creatures, summed medians) is paid once
/// while the room is loading and the player is already watching a transition, instead of in four ~160 ms stalls
/// at whatever moment each browser first asks. The claim is "no stall during combat", never "less work".
/// </para>
/// <para>
/// WHICH IS EXACTLY WHY IT IS OFF BY DEFAULT. Armed, this spends real main-thread time on a schedule the player
/// did not ask for, at the one moment the game is already busy loading a room. Get the settle delay or the roster
/// wrong and it is strictly worse than the on-demand bake it replaces: the stall still happens, it just happens
/// during the load instead of during combat, and it may bake creatures nobody ever requests. An unattended
/// regression of that shape is worse than the problem, so nothing here runs until an operator says so —
/// <see cref="EnvVar"/><c>=1</c> today, a CouchCoop mod setting later, through
/// <see cref="ArmedByEnvironment"/>'s injection seam rather than a rewrite.
/// </para>
/// <para>
/// IT ONLY EXISTS WHILE A BROWSER IS WATCHING. Its lifetime is the scene observer's
/// (<see cref="CouchCoopSceneObserver"/>), which <see cref="CouchCoopBrowserServer"/> creates only while at least
/// one mirror client is STREAMING. With nobody connected there is no one to ask for a geoclip, so a sweep would
/// be pure cost — this is the same reasoning that keeps the whole-catalog sweep opt-in, applied to the one
/// condition that can be checked automatically.
/// </para>
/// <para>
/// THE ROSTER IS THE CLIENT'S OWN QUESTION, ASKED EARLY. It is read from the scene observer's retained keyframe —
/// the very map the browser is sent — and an identity is minted from exactly the three fields the browser builds
/// its <c>/geoclips/</c> URL out of (<c>spineSceneResPath</c>, <c>spineNodePath</c>, <c>spineCurrentAnim</c>; see
/// <c>frontend/src/mirror/spineAttributes.ts</c>'s <c>geoclipUrl</c>). So this sweep cannot bake a key the client
/// would not have asked for, and cannot miss one by spelling it differently: there is one identity rule, on the
/// host, and both lanes go through <see cref="CouchCoopSpineClipProvider.BuildSpineKey"/>. A second source of
/// truth — the encounter model's monster list, say — would have to be joined back to scene paths and could
/// disagree with what is actually mounted.
/// </para>
/// <para>
/// WHAT "AN ENCOUNTER LOADED" ACTUALLY MEANS HERE, because the obvious reading is not available. The scene
/// stream's <c>ScreenInstanceId</c> is NOT an encounter identity: for combat it is the constant
/// <c>screen:combat:active</c> (or <c>…:hand-select</c>), derived from whether a combat is in progress rather
/// than from which one. So the trigger is a screen-instance CHANGE, gated on the resolved roster having actually
/// changed. Two consequences, both deliberate and both tested:
/// </para>
/// <list type="bullet">
/// <item>A mid-combat flip to the hand-select sub-screen and back is a screen change with the SAME creatures. It
/// sweeps once, not three times.</item>
/// <item>Creatures appearing or changing WITHIN one fight — a summon, a boss swapping rig — move the roster
/// without moving the screen id, and are NOT swept. That is the point rather than a gap: a bake landing
/// mid-combat is the exact thing this feature exists to prevent, so those fall back to the on-demand bake, which
/// is today's behaviour.</item>
/// </list>
/// <para>
/// The case it genuinely MISSES is two combats with no screen change between them, if the game has one: no
/// trigger fires and those creatures fall back to the on-demand bake — a miss, never a wrong bake. StateV2 does
/// carry a real <c>Run.CurrentRoom.Combat.EncounterId</c>, and it was deliberately not used: it would identify
/// the encounter but not its rigs, so it would still need a join through the monster model catalog to
/// <c>VisualsPath</c> — a second identity rule that can disagree with what is actually mounted, which is the one
/// failure this lane cannot tolerate.
/// </para>
/// <para>
/// A CLIENT REQUEST NEVER QUEUES BEHIND THIS SWEEP FOR ITS OWN KEY. Every bake goes through
/// <see cref="CouchCoopGeoclipProvider.GetAsync"/>, whose per-key single-flight is <c>static</c>: a browser
/// asking for a pose this sweep is mid-bake on AWAITS THAT BAKE instead of starting a second main-thread render.
/// That is the whole reason <see cref="RigBatchPoses"/> is pinned to 1 rather than reading
/// <see cref="CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses"/> — see that constant.
/// </para>
/// </remarks>
public sealed class CouchCoopEncounterGeoclipPrerender : IDisposable
{
    /// <summary>
    /// The opt-IN switch. Default OFF, exact ordinal <c>1</c> and nothing else — the same vocabulary as the
    /// other three prerender arms (<see cref="CouchCoopMod.GeoclipPrerenderEnvVar"/>,
    /// <c>COUCHCOOP_PRERENDER_SPINES</c>, <c>COUCHCOOP_PRERENDER_BACKGROUNDS</c>), which are opt-in for the same
    /// reason: a sweep is work the player did not ask for.
    /// </summary>
    public const string EnvVar = "COUCHCOOP_PRERENDER_ENCOUNTER_GEOCLIPS";

    /// <summary>The one value of <see cref="EnvVar"/> that arms this.</summary>
    public const string ArmedValue = "1";

    /// <summary>
    /// Poses per bake on this lane, PINNED — deliberately not <see cref="CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A cap of 1 means every identity goes down <see cref="CouchCoopGeoclipProvider.GetAsync"/>, the SINGLE-KEY
    /// lane, which single-flights per key against concurrent browser requests. Above 1 the job hands a rig's
    /// poses to <see cref="CouchCoopGeoclipProvider.GetRigAsync"/>, and that lane has NO single-flight of its own
    /// (it says so): a browser asking for a key inside an in-flight rig batch bakes it a SECOND time, on the same
    /// one-slot main-thread gate.
    /// </para>
    /// <para>
    /// For the whole-catalog sweep that gap is theoretical — it runs at startup, before anyone is looking. For
    /// THIS sweep it is the normal case: it runs at exactly the moment the client is asking about exactly these
    /// creatures. So the encounter lane does not read the operator's
    /// <c>COUCHCOOP_GEOCLIP_RIG_BATCH</c> at all; a host that re-arms rig batching for the catalog sweep must not
    /// silently turn double-baking on here. (The gap is left where it is rather than fixed: closing it means
    /// giving the rig lane its own multi-key flight, which is a change to the lane the catalog sweep depends on,
    /// and this lane does not need it.)
    /// </para>
    /// <para>
    /// It costs nothing measurable either. Batching is OFF in the shipped default anyway, because it refuses
    /// itself on every rig measured live and cost +22 %/+18 % over not batching — see
    /// <see cref="CouchCoopGeoclipPrerenderJob.MaxRigBatchPoses"/>.
    /// </para>
    /// </remarks>
    public const int RigBatchPoses = 1;

    /// <summary>
    /// How long after a screen change the roster is read.
    /// </summary>
    /// <remarks>
    /// A screen's instance id changes when the load STARTS; its creature nodes are added over the ticks that
    /// follow, and a keyframe read at the instant of the change would find few of them or none. This is the one
    /// number in this type that is a guess rather than a measurement, and it is a constructor parameter so a live
    /// leg can tune it without touching any logic.
    /// <para>Getting it too SHORT is benign and self-correcting: a creature that appears after the snapshot is
    /// simply not pre-baked, and its first request is the ordinary on-demand bake this feature is trying to move
    /// — i.e. exactly today's behaviour. Getting it too LONG is also benign: the sweep starts later and races the
    /// client, which the single-flight makes safe. Neither failure produces a wrong artifact.</para>
    /// </remarks>
    public static readonly TimeSpan DefaultSettleDelay = TimeSpan.FromMilliseconds(1500);

    /// <summary>
    /// The most identities one encounter's sweep will bake, ever.
    /// </summary>
    /// <remarks>
    /// A combat encounter holds a handful of creatures; this is not a tuning knob but the BOUND that makes
    /// "bounded" a property of the code rather than an assumption about the game. A screen that somehow carried
    /// hundreds of spine nodes must not be able to turn an encounter load into a catalog sweep — that is the
    /// whole-catalog job's business, behind its own flag, and it is opt-in for the same reason.
    /// </remarks>
    public const int MaxIdentitiesPerEncounter = 24;

    /// <summary>Whether <see cref="EnvVar"/> arms this on the current process. Default OFF.</summary>
    public static bool ArmedByEnvironment
        => Environment.GetEnvironmentVariable(EnvVar) == ArmedValue;

    private readonly CouchCoopSceneObserver _observer;
    private readonly Func<CouchCoopGeoclipPrerenderJob?> _job;
    private readonly Action<string> _log;
    private readonly Func<bool> _armed;
    private readonly TimeSpan _settleDelay;
    private readonly object _gate = new();

    private CancellationTokenSource? _stop;
    private string? _screenInstanceId;
    private string? _sweptRoster;
    private bool _started;
    private bool _disposed;
    private int _dispatched;
    private Task? _sweep;

    /// <summary>
    /// TEST SEAM. How many sweeps have been DISPATCHED, and the most recent one's task.
    /// </summary>
    /// <remarks>
    /// A prerender is fire-and-forget by construction — nothing in the product may await one, which is exactly
    /// why it cannot stall an encounter load — so a test has no other way to join it. Both are written under
    /// <see cref="_gate"/> inside <see cref="OnDelta"/>, i.e. synchronously with the delta that caused them, so a
    /// caller that has pushed a delta can read them without racing the sweep it started. Deltas that start no
    /// sweep (unarmed, the baseline screen) do not move the counter, which is how a test tells "nothing was
    /// dispatched" from "something was dispatched and did nothing".
    /// </remarks>
    internal (int Dispatched, Task? Sweep) PendingSweep
    {
        get
        {
            lock (_gate)
            {
                return (_dispatched, _sweep);
            }
        }
    }

    /// <param name="job">
    /// Builds the sweep for ONE encounter, or returns null when this host cannot bake at all (no embedded
    /// runtime). A factory rather than an instance because the job carries a per-run tally, and because the
    /// provider it bakes through must be the browser server's own — the same object the <c>/geoclips/</c> route
    /// answers from, so the store root and the single-flight are shared by construction rather than by
    /// coincidence. It is also what keeps an unarmed host from constructing any of that: nothing calls this until
    /// a sweep is actually about to run.
    /// </param>
    /// <param name="armed">
    /// WHERE THE SWITCH COMES FROM, injected. Defaults to <see cref="ArmedByEnvironment"/>, which is the whole of
    /// the answer today. The user's plan is a CouchCoop mod settings surface later; when it exists it supplies a
    /// different reader here and nothing else in this type changes. It is read on each SCREEN CHANGE rather than
    /// once at <see cref="Start"/>, so a setting toggled mid-session takes effect at the next encounter instead
    /// of at the next launch — and reading it there rather than per delta keeps an env lookup off a path that
    /// runs at frame rate.
    /// </param>
    public CouchCoopEncounterGeoclipPrerender(
        CouchCoopSceneObserver observer,
        Func<CouchCoopGeoclipPrerenderJob?> job,
        Action<string>? log = null,
        Func<bool>? armed = null,
        TimeSpan? settleDelay = null)
    {
        _observer = observer ?? throw new ArgumentNullException(nameof(observer));
        _job = job ?? throw new ArgumentNullException(nameof(job));
        _log = log ?? (message => Console.Error.WriteLine(message));
        _armed = armed ?? (() => ArmedByEnvironment);
        _settleDelay = settleDelay ?? DefaultSettleDelay;
    }

    /// <summary>Watch for encounter loads. Idempotent; safe to call on a host that will never arm this.</summary>
    /// <remarks>
    /// The subscription is taken UNCONDITIONALLY — the arm is checked per screen change, not here — so that a
    /// future settings toggle needs no restart and no re-Start. The cost of that on an unarmed host is one
    /// ordinal string comparison per scene delta, which is why <see cref="OnDelta"/> compares the screen id
    /// BEFORE it asks whether anything is armed.
    /// </remarks>
    public void Start()
    {
        lock (_gate)
        {
            if (_started || _disposed)
            {
                return;
            }

            _started = true;
            _observer.SceneDeltaChanged += OnDelta;
        }
    }

    private void OnDelta(RuntimeSceneDelta delta)
    {
        lock (_gate)
        {
            if (_disposed || string.Equals(_screenInstanceId, delta.ScreenInstanceId, StringComparison.Ordinal))
            {
                // The overwhelmingly common case, and the only work this type does on an idle host: one ordinal
                // compare on a delta that is about the screen we are already on (or have already swept).
                return;
            }

            var previous = _screenInstanceId;
            _screenInstanceId = delta.ScreenInstanceId;

            // A NEW ENCOUNTER CANCELS THE OLD ONE'S SWEEP. Leaving it running would spend main-thread time on
            // creatures that have left the screen while the ones now on it wait behind them for the extraction
            // gate — the precise inversion this feature exists to prevent. Bakes already committed to the store
            // are kept: cancellation stops the sweep, it does not unmake artifacts.
            _stop?.Cancel();
            _stop?.Dispose();
            _stop = null;

            if (previous is null)
            {
                // The first screen this observer ever sees is the one that was ALREADY on display when a browser
                // connected, not an encounter that just loaded. Take it as the baseline and sweep nothing: its
                // creatures are on screen now, so any client that wants them has already asked.
                return;
            }

            if (!_armed())
            {
                return;
            }

            _stop = new CancellationTokenSource();
            var token = _stop.Token;
            var screenInstanceId = delta.ScreenInstanceId;
            var screenType = delta.ScreenType;

            // OFF THE DELTA THREAD, IMMEDIATELY. This callback runs on the scene producer's broadcast path —
            // every mirror client's frame rides it, on one thread, through a subscriber list this type has joined
            // — so anything slow here delays every connected browser's next frame. The settle wait obviously
            // qualifies; so does BuildKeyframe, which takes the observer's own lock and materialises the whole
            // retained node map. Neither belongs in front of the mirror.
            _dispatched++;
            _sweep = Task.Run(() => SweepAsync(screenType, screenInstanceId, token), CancellationToken.None);
        }
    }

    private async Task SweepAsync(string screenType, string screenInstanceId, CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(_settleDelay, cancellationToken).ConfigureAwait(false);

            var roster = ResolveRoster(_observer.BuildKeyframe(), MaxIdentitiesPerEncounter);
            if (roster.Count == 0)
            {
                // Ordinary and not worth a line at INFO volume for every menu, map and reward screen: most
                // screens carry no creature rig at all, and this fires on every one of them.
                return;
            }

            // THE SAME CREATURES AS LAST TIME ARE NOT A NEW ENCOUNTER, and on this game they are a case that
            // really occurs: a combat screen's instance id is the CONSTANT `screen:combat:active` (or
            // `…:hand-select`), derived from whether a combat is in progress rather than from which one — see
            // spirectl's Sts2ScreenLocator. So a mid-combat flip to the hand-select sub-screen and back reads as
            // two screen changes with an unchanged roster. The sweep would be nearly free (every identity is
            // already a store hit), but it would log twice per encounter and re-walk the keyframe for nothing.
            var signature = string.Join(
                "\n", roster.Select(entry => $"{entry.SceneResPath}|{entry.NodePath}|{entry.AnimationName}"));
            lock (_gate)
            {
                if (string.Equals(_sweptRoster, signature, StringComparison.Ordinal))
                {
                    return;
                }

                _sweptRoster = signature;
            }

            if (_job() is not { } job)
            {
                // No embedded runtime to bake through — the same degradation the /geoclips/ route makes, and
                // nothing this lane can or should work around.
                return;
            }

            _log(
                $"[couchcoop] geoclip-prerender encounter ARMED screen={screenType} instance={screenInstanceId} "
                + $"identities={roster.Count} settleMs={_settleDelay.TotalMilliseconds:0} batch={RigBatchPoses}");

            var summary = await job.RunAsync(roster, RigBatchPoses, cancellationToken).ConfigureAwait(false);

            _log(
                $"[couchcoop] geoclip-prerender encounter DONE screen={screenType} instance={screenInstanceId} "
                + $"status={summary.Status} hits={summary.Hits} baked={summary.Baked} "
                + $"refused={summary.Refused} refusedCached={summary.RefusedCached} failed={summary.Failed} "
                + $"elapsedMs={summary.ElapsedMs}");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The player left the encounter (or the mirror stream stopped) before the sweep finished. Expected,
            // and deliberately silent: it is the mechanism working, not an error.
        }
        catch (Exception exception)
        {
            // A prerender is an optimisation. It may never take the browser server down with it, and it must not
            // be able to make the mirror worse than the on-demand path it is trying to get ahead of.
            _log(
                $"[couchcoop] geoclip-prerender encounter failed screen={screenType} "
                + $"instance={screenInstanceId} detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// The geoclip identities a keyframe's live spine nodes would make the browser ask for, deduplicated, in draw
    /// order, capped at <paramref name="maxIdentities"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// PURE, so the roster rule is testable without a game. The three fields read here are exactly the three the
    /// client's <c>geoclipUrl</c> reads, and the two guards it applies (a <c>res://</c> scene path, a non-empty
    /// current animation) are exactly its two: a node failing either has no geoclip URL, so baking one for it
    /// would fill the store with an identity nothing can request.
    /// </para>
    /// <para>
    /// INVISIBLE NODES ARE SKIPPED, and the asymmetry is deliberate. Including one costs a multi-second
    /// main-thread bake for a creature that may never be drawn — the exact unattended cost this feature must not
    /// introduce. Excluding one that later becomes visible costs nothing but a fallback to the ordinary
    /// on-demand bake, which is today's behaviour. When the rule is wrong, it should be wrong in the cheap
    /// direction.
    /// </para>
    /// </remarks>
    internal static IReadOnlyList<SpineCatalogEntrySnapshot> ResolveRoster(
        RuntimeSceneDelta? keyframe,
        int maxIdentities)
    {
        if (keyframe is null || maxIdentities <= 0)
        {
            return [];
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var roster = new List<SpineCatalogEntrySnapshot>();
        foreach (var node in keyframe.Upserts)
        {
            if (!node.Visible
                || node.Spine is not { } spine
                || node.SpineCurrentAnim is not { Length: > 0 } animation
                || !spine.SceneResPath.StartsWith("res://", StringComparison.Ordinal))
            {
                continue;
            }

            // One rig instanced twice (two of the same monster) is ONE identity: the geoclip is a property of
            // (scene, node, anim), not of the node that happens to be drawing it.
            if (!seen.Add($"{spine.SceneResPath}|{spine.NodePath ?? string.Empty}|{animation}"))
            {
                continue;
            }

            roster.Add(new SpineCatalogEntrySnapshot(spine.SceneResPath, spine.NodePath, animation));
            if (roster.Count >= maxIdentities)
            {
                break;
            }
        }

        return roster;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            if (_started)
            {
                _observer.SceneDeltaChanged -= OnDelta;
            }

            _stop?.Cancel();
            _stop?.Dispose();
            _stop = null;
        }
    }
}
