using System.Runtime.CompilerServices;
using CouchCoop.Mod.HostUi;
using CouchCoop.MirrorProtocol.SceneModel;
using CouchCoop.Mod.Session;
using Godot;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Server;

/// <summary>
/// The CURRENT static background as the tracker last probed it: the bg scene root's path, the ORDERED layer
/// sub-scene paths actually MOUNTED in the live room (combat rooms randomize layers; event backdrops mount none,
/// so theirs is always empty), their digest (null = no layers read — the deterministic-discovery variant for
/// combat, and ALWAYS null for events), and the ready-to-fetch <c>/bg/</c> URL. Published to
/// <see cref="CouchCoopStaticBackgroundTracker.Published"/>; null there = no static-backgroundable screen.
/// </summary>
public sealed record CouchCoopStaticBackgroundState(
    string ScenePath,
    IReadOnlyList<string> LayerPaths,
    string? Digest,
    string Url,
    // EVENTS and ROOMS only: the probed live backdrop frame spec riding the Url ("x,y,scale" in the 1920x1080
    // reference — see CouchCoopStaticBackgroundTracker.NormalizeProbedFrameSpec). The route's stale-frame rule
    // compares against this, exactly the way the combat digest rule compares against Digest. Null for combat and
    // for a probe that could not read a transform (the Url is then the deterministic reference-lerp variant).
    string? EventFrame = null);

// The static-background tracker, two halves sharing ONE deferred main-thread probe:
//
// Stage-A probe/publish: the probe locates the live background root — the COMBAT background (child of
// `BgContainer` under `CombatSceneContainer` whose SceneFilePath matches the
// res://scenes/backgrounds/<id>/<id>_background.tscn convention; combat wins when both are mounted, e.g.
// EventRoom-wrapped combat), failing that the EVENT backdrop (the shallowest node whose SceneFilePath matches
// res://scenes/events/background_scenes/<id>.tscn), failing that a ROOM backdrop (the committed
// RoomBackgroundSubtrees table — the shop). For combat it reads the layer sub-scenes actually MOUNTED and publishes
// {scenePath, layerSet, digest, url}; an event or room backdrop mounts no variants, so it publishes digest-less
// with a probed frame. Screens with none of the three (map, rest site, menus) publish null. The server re-sends
// `session` envelopes to EVERY connection — gated ones included — when the published value changes, so clients
// learn the new URL.
//
// THE HOST'S PUBLISH IS THE SOURCE OF TRUTH for every viewer of the run, seat viewers included: a browser on a
// headless seat shows the HOST's descriptor (received over its gated host socket), never one derived from the
// seat's own tree. So the probe has to run whenever anybody is showing a still, not only while a host socket
// streams. Three triggers schedule it, all folding into the one queued probe
// (CouchCoopStaticBackgroundProbeScheduler):
//   1. OnSceneDelta — the mirror scene stream's SCREEN signature changed (the discriminator
//      ResendSessionsIfSceneScreenChanged keys on), or a late event/room backdrop mounted. Runs only while a
//      host socket streams, because that is when the scene observer exists.
//   2. RequestProbe — the game's own "the screen on top may have changed" event, which the host's browser server
//      subscribes to while any viewer shows a still (CouchCoopBrowserServer.RefreshScreenProbeLocked). This is
//      what keeps the publish live for seat viewers, whose host socket is gated and streams nothing. Each such
//      probe earns ONE bounded follow-up for backdrops that mount after the event; no timer runs at idle.
//   3. SetDesiredSkip — the Stage-B verdict flipped (below).
//
// Stage-B walk skip (the stamping half): the server's unanimity aggregate hands the tracker a DESIRED-SKIP flag
// (SetDesiredSkip — every streaming mirror viewer shows the static image), and the probe applies it to the located
// bg root with CouchCoopStreamSkip.Stamp/RemoveMeta. The probe re-runs on desired-skip CHANGE and on screen change
// (a fresh room's bg root is a fresh, unstamped node), so the stamp follows both the viewers and the rooms. A
// stamped root emits NOTHING to the wire — that is fine, because scene identity rides the session envelope's
// staticBackground descriptor. ACCEPTED, DOCUMENTED COST: the stamp is deferred onto the main thread, so a fresh
// room's bg may stream for one producer tick before the stamp lands; it then stale-sweeps (RemovedIds), and the
// client shows the static image over the gap. Un-stamping is exactly symmetric (the Sts2StreamSkipMeta contract):
// the next walk re-admits the whole subtree as fresh static-bearing upserts, so a viewer that toggles the setting
// OFF gets the live scenery back without a keyframe. The producer may also ignore stamps through its explicit
// stream-skip configuration.
//
// Threading: OnSceneDelta runs on the single scene-observer thread; SetDesiredSkip on whatever thread flips the
// server aggregate (accept loop / receive loop / teardown); RequestProbe on the game's main thread, from inside
// the game's own screen transition (so it only schedules — see its remarks), and once from a server thread when
// the server arms the screen-event probe; the probe body — locate, stamp,
// publish — runs on the Godot main thread (Callable.From(...).CallDeferred(), the
// CouchCoopHeadlessVisualSuspender idiom — reading live Node state off-thread is unsafe). The publish slot is a
// process-wide volatile (one host process serves one game), read by BrowserStateEnvelopeFactory on whatever
// thread builds a session envelope.
public sealed class CouchCoopStaticBackgroundTracker
{
    private static CouchCoopStaticBackgroundState? _published;

    /// <summary>The tracker's published volatile: the current combat bg descriptor source, null when unknown.</summary>
    public static CouchCoopStaticBackgroundState? Published => Volatile.Read(ref _published);

    /// <summary>
    /// How long after an event-driven probe the one follow-up probe runs. Long enough for a backdrop that mounts a
    /// frame or more after the game's screen event, short enough that a seat viewer is not left without a picture.
    /// </summary>
    public const double FollowUpProbeDelaySeconds = 0.5;

    // The engine latch this probe path needs is CouchCoopMod.EngineAvailable — one flag, one writer (Init), read
    // here and by every other native-call gate in the mod. It used to be stored on THIS type, which made it a
    // per-assembly static: Server/*.cs is link-compiled into CouchCoop.Mod.HotReload too, so the reloaded copy
    // could never be set and silently read false. See the flag's own remarks.

    private readonly Action? _onPublishedChanged;
    private readonly Action<string> _log;

    // WARM-AT-PUBLISH (see PublishAndNotify): hands the freshly published QUALIFIED variant to whoever can render
    // it. Null in every host that has no renderer behind it (test harnesses, the standalone server), which is why
    // the tracker keeps no provider reference of its own.
    private readonly Action<CouchCoopStaticBackgroundState>? _warmVariant;

    // The ONE deferred main-thread probe's fold, and the follow-up an event-driven request earns. Every trigger
    // (screen signature, game screen event, desired-skip flip) funnels through it, so a burst of any mix of them
    // costs one probe; the probe reads the LIVE tree and the LIVE desired-skip flag, so it always answers for the
    // newest state anyway.
    private readonly CouchCoopStaticBackgroundProbeScheduler _scheduler;

    public CouchCoopStaticBackgroundTracker(
        Action? onPublishedChanged = null,
        Action<string>? log = null,
        Action<CouchCoopStaticBackgroundState>? warmVariant = null)
    {
        _onPublishedChanged = onPublishedChanged;
        _log = log ?? CouchCoopLog.Stderr;
        _warmVariant = warmVariant;
        _scheduler = new CouchCoopStaticBackgroundProbeScheduler(
            ScheduleProbeOnMainThread,
            ArmFollowUpTimerOnMainThread,
            _log);
    }

    // The screen fingerprint last seen (scene-observer thread; cleared by ResetScreenBaseline when the observer
    // stops). Unlike the session-resend twin, the FIRST delta of a generation DOES probe: a viewer connecting
    // mid-combat needs the descriptor immediately.
    private string? _lastScreenSignature;

    // Stage-B: the server's unanimity verdict (every streaming mirror viewer shows the static image). Written by
    // SetDesiredSkip on server threads, read by the main-thread probe.
    private volatile bool _desiredSkip;

    // Stage-B: the instance id of the node currently carrying OUR stamp (0 = none). Main-thread only (the probe is
    // the sole reader/writer), so no synchronization. Held as an id, not a Node reference, so a freed room cannot
    // leave a dangling managed wrapper alive — InstanceFromId of a freed id is simply null (nothing to unstamp;
    // the node's removal already swept its subtree off the wire).
    private ulong _stampedInstanceId;

    /// <summary>
    /// Stage-B walk skip: the server's unanimity aggregate changed. Stores the new verdict and schedules the
    /// deferred main-thread probe, which stamps/un-stamps the located combat bg root accordingly. Inert in a
    /// Godot-less host (test harnesses) exactly like the screen-change path — the flag still latches, so a later
    /// real probe applies it.
    /// </summary>
    public void SetDesiredSkip(bool desired)
    {
        if (_desiredSkip == desired)
        {
            return;
        }

        _desiredSkip = desired;
        if (!CouchCoopMod.EngineAvailable)
        {
            return; // Godot-less server process: nothing to stamp, and native calls would crash
        }

        _scheduler.TrySchedule("skip"); // a probe already queued reads the fresh flag
    }

    /// <summary>Test seam: the latched desired-skip verdict (SetDesiredSkip must latch even Godot-less).</summary>
    internal bool DesiredSkipForTest => _desiredSkip;

    /// <summary>
    /// EVENT-DRIVEN probe: the game says the screen on top may have changed. Schedules the (folded) main-thread
    /// probe plus ONE bounded follow-up for a backdrop that mounts after the event. This is what keeps the host's
    /// publish live while nobody streams — a seat viewer's host socket is gated, so no scene delta ever arrives.
    /// </summary>
    /// <remarks>
    /// Called from INSIDE the game's own screen transition, so it must ask the engine nothing: no tree read, no
    /// current-screen read. Reading the game's active screen at that point is the process-killing segfault
    /// recorded at <c>CouchCoopQrHostPanelController.WakeEvaluation</c>. Everything here is a latch read, two
    /// interlocked flags and a <c>CallDeferred</c> post; the probe reads the tree a frame boundary later.
    /// </remarks>
    public void RequestProbe()
    {
        if (!CouchCoopMod.EngineAvailable)
        {
            return; // Godot-less server process (test harnesses): nothing to probe, and native calls would crash
        }

        _scheduler.Request();
    }

    /// <summary>
    /// Drop any pending follow-up probe (any thread). The server calls this when it drops its screen-event
    /// subscription, so a stopped generation cannot probe after it is gone.
    /// </summary>
    public void CancelFollowUps() => _scheduler.CancelFollowUps();

    /// <summary>
    /// Forget the screen signature <see cref="OnSceneDelta"/> last saw. The server calls this when the scene
    /// observer stops, so a restarted observer on the SAME screen probes on its first delta instead of treating
    /// it as already announced — the publish may have gone stale while nothing was streaming.
    /// </summary>
    public void ResetScreenBaseline() => Volatile.Write(ref _lastScreenSignature, null);

    /// <summary>Test seam: the screen signature <see cref="OnSceneDelta"/> last recorded (null = no baseline).</summary>
    internal string? LastScreenSignatureForTest => Volatile.Read(ref _lastScreenSignature);

    /// <summary>
    /// Feed one mirror scene delta (scene-observer thread). Probes on screen-signature change — and on the
    /// LATE MOUNT of an event backdrop: unlike the combat background (mounted synchronously with its
    /// CombatSceneContainer), the event backdrop scene arrives one-or-more producer ticks AFTER the screen delta
    /// that announced its room, so the screen-change probe can run against a tree that does not hold it yet and
    /// publish null (measured live on the first Neow fixture entry). The backdrop's ADD is itself an upsert
    /// carrying its SceneFilePath (a static, add/keyframe-only field), so scanning the CHANGED nodes for the
    /// strict event convention re-arms exactly one probe per mount and can never storm: once the publish names
    /// that path, further upserts of the node stop matching the re-probe condition.
    /// </summary>
    public void OnSceneDelta(RuntimeSceneDelta delta)
    {
        var signature = delta.ScreenType + "|" + delta.ScreenInstanceId;
        if (string.Equals(signature, Volatile.Read(ref _lastScreenSignature), StringComparison.Ordinal)
            && !CarriesUnpublishedEventBackdrop(delta))
        {
            return;
        }

        Volatile.Write(ref _lastScreenSignature, signature);
        if (!CouchCoopMod.EngineAvailable)
        {
            return; // Godot-less server process (test harnesses): nothing to probe, and native calls would crash
        }

        // A scheduling failure (a teardown race) leaves the published value untouched — it can only ever have been
        // set by a real probe in this process.
        _scheduler.TrySchedule("probe");
    }

    // True when this delta upserts an event-backdrop scene root the current publish does not already name —
    // the late-mount re-probe condition. Pure over the delta + the published volatile, so it is unit-testable
    // and costs one strict-parse per CHANGED node (the overwhelming majority have no SceneFilePath at all).
    internal static bool CarriesUnpublishedEventBackdrop(RuntimeSceneDelta delta)
    {
        foreach (var upsert in delta.Upserts)
        {
            if (upsert.SceneFilePath is not { Length: > 0 } path
                || (CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(path) is null
                    && BackgroundSceneFamilies.TryParseRoomBackgroundId(path) is null))
            {
                continue;
            }

            return Published is not { } published
                || !string.Equals(published.ScenePath, path, StringComparison.Ordinal);
        }

        return false;
    }

    // Godot-typed, isolated + NoInlining so a Godot-less process fails HERE (caught by the scheduler) instead of
    // poisoning the caller's JIT — the same contract as SpirectlAssetBinaryCache.TryResolveGameDataDir.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private void ScheduleProbeOnMainThread()
        => Callable.From(() => _scheduler.RunProbe(ProbeOnMainThread)).CallDeferred();

    // Main thread only (the scheduler arms the follow-up from inside RunProbe). A one-shot SceneTreeTimer that the
    // tree frees after it fires — never a repeating one. processAlways so a paused tree (a pause menu over the
    // room) still gets its follow-up; ignoreTimeScale so a slowed game does not stretch it.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool ArmFollowUpTimerOnMainThread(Action onElapsed)
    {
        if (Engine.GetMainLoop() is not SceneTree tree)
        {
            return false;
        }

        tree.CreateTimer(FollowUpProbeDelaySeconds, processAlways: true, processInPhysics: false, ignoreTimeScale: true)
            .Timeout += onElapsed;
        return true;
    }

    // Runs on the game main thread (deferred).
    private void ProbeOnMainThread()
    {
        CouchCoopStaticBackgroundState? next = null;
        Node? bgRoot = null;
        if (Engine.GetMainLoop() is SceneTree { Root: { } root }
            && GodotObject.IsInstanceValid(root))
        {
            // Combat first: EventRoom-WRAPPED combat mounts BOTH an event backdrop and a combat background, and
            // the combat one is what the viewer is looking at. Rooms (the shop) coexist with neither.
            next = LocateCombatBackground(root, out bgRoot)
                ?? LocateEventBackground(root, out bgRoot)
                ?? LocateRoomBackground(root, out bgRoot);
        }

        // Stage-B stamping half: apply the current desired-skip verdict to the LOCATED root (the node whose
        // SceneFilePath produced `next.ScenePath`). Runs before the publish so a screen-change probe stamps the
        // new room's root in the same main-thread hop that announces it.
        ApplyStreamSkip(bgRoot);
        PublishAndNotify(next);
    }

    // Main thread only (probe body). Reconciles OUR stamp with (a) the located combat bg root and (b) the
    // desired-skip verdict, symmetrically:
    //   desired && root       → stamp the root (idempotent), remember it;
    //   anything else         → un-stamp whatever we last stamped, if it still exists (a freed room needs no
    //                           un-stamp — its removal already swept the subtree), and forget it.
    // A room change while skipping unstamps the OLD root (if alive) and stamps the NEW one in one pass, so a
    // still-mounted previous room (EventRoom wrapping) can never keep a stale stamp.
    private void ApplyStreamSkip(Node? bgRoot)
    {
        var desired = _desiredSkip;

        if (_stampedInstanceId != 0
            && (!desired || bgRoot is null || bgRoot.GetInstanceId() != _stampedInstanceId))
        {
            if (GodotObject.InstanceFromId(_stampedInstanceId) is Node previous)
            {
                CouchCoopStreamSkip.RemoveMeta(previous);
            }

            _stampedInstanceId = 0;
        }

        if (desired && bgRoot is not null)
        {
            CouchCoopStreamSkip.Stamp(bgRoot);
            _stampedInstanceId = bgRoot.GetInstanceId();
        }
    }

    // Main thread only. The combat bg root is a CHILD of `BgContainer` under `CombatSceneContainer` — this shape
    // holds for a plain CombatRoom and for EventRoom-WRAPPED combat, and deliberately excludes the
    // MainMenu/RestSite/Merchant background scenes (those are not mounted under a CombatSceneContainer).
    // `bgRoot` (Stage B) is the LIVE node behind the returned state — the stamping target.
    private static CouchCoopStaticBackgroundState? LocateCombatBackground(Node root, out Node? bgRoot)
    {
        bgRoot = null;
        foreach (var container in root.FindChildren("CombatSceneContainer", "", recursive: true, owned: false))
        {
            if (container.GetNodeOrNull("BgContainer") is not { } bgContainer)
            {
                continue;
            }

            foreach (var child in bgContainer.GetChildren())
            {
                var scenePath = child.SceneFilePath;
                if (CouchCoopStaticBackgroundProvider.TryParseBackgroundId(scenePath) is not { } id)
                {
                    continue;
                }

                var layers = CollectMountedLayerPaths(child);

                var digest = CouchCoopStaticBackgroundProvider.ComputeLayersDigest(layers);
                bgRoot = child;
                return new CouchCoopStaticBackgroundState(
                    scenePath,
                    layers,
                    digest,
                    CouchCoopStaticBackgroundProvider.BuildImageUrl(id, digest));
            }
        }

        return null;
    }

    // Main thread only. The EVENT backdrop root is the shallowest node in the tree whose SceneFilePath follows
    // the strict res://scenes/events/background_scenes/<id>.tscn convention (Neow, ancient events; every shipped
    // scene in that family). Unlike combat there is no container-chain requirement — the event layouts mount the
    // backdrop scene directly and nothing else in the game instances scenes from that directory — and no layer
    // variant, so the publish is digest-less. Runs ONLY when the combat locate found nothing (combat wins for
    // EventRoom-wrapped combat).
    private static CouchCoopStaticBackgroundState? LocateEventBackground(Node root, out Node? bgRoot)
    {
        bgRoot = null;
        if (FindEventBackgroundRoot<Node>(
                root,
                node => [.. node.GetChildren()],
                node => node.SceneFilePath) is not { } found)
        {
            return null;
        }

        bgRoot = found.Node;
        // The probed LIVE frame: the backdrop root's global transform (its container carries the game's
        // placement; everything above streams identity), expressed in the 1920x1080 reference the renderer
        // composes in (NormalizeProbedFrameSpec), so a host at any window size and aspect mints a spec that
        // lands the still where that host shows the backdrop. The recovered placement lerp has DRIFTED from the
        // shipped game (measured container y 99.4 vs the lerp's 40 on Neow), so the still renders from the
        // measurement, not the prediction; a probe that cannot read a transform publishes the frame-less
        // reference URL.
        var frame = ProbeFrameSpec(found.Node);

        return new CouchCoopStaticBackgroundState(
            found.ScenePath,
            [],
            Digest: null,
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, found.Id, null, frame),
            EventFrame: frame);
    }

    // Breadth-first so the SHALLOWEST matching root wins (the backdrop mounts near the room root; a nested prop
    // scene must never shadow it), with a node budget bounding the sweep on any unexpected tree shape — hitting
    // the budget means "no backdrop", never a partial answer from a deeper level. GENERIC over (children,
    // scenePath) accessors for the same reason as CollectMountedLayerPaths: the test host has Godot loaded but no
    // engine, so the tests drive this code over a plain record tree.
    internal const int EventProbeNodeBudget = 20000;

    internal static (string ScenePath, string Id, TNode Node)? FindEventBackgroundRoot<TNode>(
        TNode root,
        Func<TNode, IReadOnlyList<TNode>> children,
        Func<TNode, string?> scenePath,
        int nodeBudget = EventProbeNodeBudget)
        => FindBackgroundSceneRoot(root, children, scenePath, CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId, nodeBudget);

    internal static (string ScenePath, string Id, TNode Node)? FindBackgroundSceneRoot<TNode>(
        TNode root,
        Func<TNode, IReadOnlyList<TNode>> children,
        Func<TNode, string?> scenePath,
        Func<string?, string?> parseId,
        int nodeBudget = EventProbeNodeBudget)
    {
        var visited = 0;
        var frontier = new Queue<TNode>();
        frontier.Enqueue(root);
        while (frontier.Count > 0 && visited < nodeBudget)
        {
            var node = frontier.Dequeue();
            visited++;
            if (scenePath(node) is { Length: > 0 } path
                && parseId(path) is { } id)
            {
                return (path, id, node);
            }

            foreach (var child in children(node))
            {
                frontier.Enqueue(child);
            }
        }

        return null;
    }

    // Main thread only. The ROOM backdrop is an INLINE subtree of the room scene itself (the committed
    // RoomBackgroundSubtrees table — the merchant shop's SceneContainer/BgContainer): locate the room scene
    // root, resolve the subtree, and publish a frame-qualified digest-less descriptor. bgRoot (the Stage-B
    // stamping target) is the SUBTREE node, never the room root — the button/inventory siblings keep streaming.
    private static CouchCoopStaticBackgroundState? LocateRoomBackground(Node root, out Node? bgRoot)
    {
        bgRoot = null;
        if (FindBackgroundSceneRoot<Node>(
                root,
                node => [.. node.GetChildren()],
                node => node.SceneFilePath,
                BackgroundSceneFamilies.TryParseRoomBackgroundId) is not { } found)
        {
            return null;
        }

        var subtreePath = BackgroundSceneFamilies.RoomBackgroundSubtrees[found.ScenePath];
        if (found.Node.GetNodeOrNull(subtreePath) is not { } subtree)
        {
            return null;
        }

        var frame = ProbeFrameSpec(subtree);

        bgRoot = subtree;
        return new CouchCoopStaticBackgroundState(
            found.ScenePath,
            [],
            Digest: null,
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Rooms, found.Id, null, frame),
            EventFrame: frame);
    }

    // Main thread only. The probed frame spec of a live backdrop node, or null when it is not a CanvasItem (no
    // transform to read). Both lengths come from the SAME space: GetGlobalTransform is in canvas units, and
    // GetViewportRect is the viewport's visible rect in canvas units — under the game's canvas_items stretch that
    // is the DESIGN-space size (1920x1080 at any 16:9 window, whatever its pixel size; 1080 tall and wider on a
    // wider window; 1920 wide and taller on a taller one), never window pixels.
    private static string? ProbeFrameSpec(Node node)
    {
        if (node is not CanvasItem canvasItem)
        {
            return null;
        }

        var transform = canvasItem.GetGlobalTransform();
        var viewport = canvasItem.GetViewportRect().Size;
        return NormalizeProbedFrameSpec(
            transform.Origin.X,
            transform.Origin.Y,
            transform.X.Length(),
            viewport.X,
            viewport.Y);
    }

    /// <summary>
    /// The width the still's frame spec is expressed in: the renderer places a probed frame by assuming it was
    /// measured in a 1920-wide, 1080-tall reference centred in its wider capture (spirectl's CenterFrame adds half
    /// the capture's extra width back).
    /// </summary>
    public const float FrameReferenceWidth = 1920f;

    /// <summary>The height the still's frame spec is normalized to (the game's design height).</summary>
    public const float FrameReferenceHeight = 1080f;

    /// <summary>
    /// A probed backdrop transform (origin + uniform scale, in the viewport's canvas units) as the <c>frame=</c>
    /// spec the <c>/bg/</c> renderer expects: scaled to a 1080-tall viewport, then shifted so x is measured in
    /// the 1920-wide reference centred in it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THE SHIFT. The renderer re-centres a probed frame into its 2520-wide capture by adding half the
    /// capture's extra width over 1920 — it assumes the frame came from a 16:9 layout. A host whose normalized
    /// viewport is wider (21:9: 2520) or narrower (16:10: 1728) than 1920 would otherwise have that half-margin
    /// counted twice or not at all, and its still would land off to one side of where the host shows the
    /// backdrop. Subtracting <c>(normalizedWidth − 1920) / 2</c> here is the inverse of that re-centre, so the
    /// still composites where the host's own screen has it: a node at the host's horizontal centre maps to 960.
    /// </para>
    /// <para>
    /// A NO-OP AT 16:9, byte for byte. There the normalized width is exactly 1920, the shift is exactly zero, and
    /// the arithmetic is the same single-precision chain the probe always ran — so a seat (forced to 1920x1080)
    /// and a 16:9 host keep minting the very URLs they minted before, and their cached stills stay valid.
    /// </para>
    /// </remarks>
    public static string NormalizeProbedFrameSpec(
        float originX,
        float originY,
        float scale,
        float viewportWidth,
        float viewportHeight)
    {
        var normalize = viewportHeight > 0 ? FrameReferenceHeight / viewportHeight : 1f;
        // Only with a real viewport: an unreadable size keeps the unshifted spec rather than inventing a margin.
        var referenceMargin = viewportHeight > 0 && viewportWidth > 0
            ? ((viewportWidth * normalize) - FrameReferenceWidth) / 2f
            : 0f;
        return CouchCoopStaticBackgroundProvider.FormatEventFrameSpec(
            (originX * normalize) - referenceMargin,
            originY * normalize,
            scale * normalize);
    }

    // The MOUNTED layer variant, in paint order. The bg root's direct children are the PLACEHOLDER containers the
    // scene declares (`Layer_00`..`Layer_NN`, `Foreground`) — plain nodes with NO SceneFilePath — and the randomly
    // chosen layer variant is instanced one level BELOW each of them:
    //     UnderdocksBackground/Layer_01/C  -> res://scenes/backgrounds/underdocks/layers/underdocks_bg_01_c.tscn
    // Reading only the direct children therefore found nothing, published a digest-less descriptor, and silently
    // served the DETERMINISTIC-first-sorted render instead of the variant the room actually mounted (measured live:
    // mounted 00_a/01_c/02_c/03_c/04_b/fg_a vs a first-sorted render — four layers wrong).
    //
    // Rule: per direct child, take the SHALLOWEST scene-instanced descendant (the child itself if it carries a
    // SceneFilePath, else a breadth-first probe of its subtree). Shallowest is what keeps a layer scene's OWN
    // nested instances (props inside underdocks_bg_01_c.tscn) from being mistaken for the layer; the depth cap
    // bounds the probe on any unexpected scene shape. A placeholder with nothing instanced contributes nothing
    // (legal: the live room may mount no variant there) — the render's selector honors per-placeholder absence.
    // The traversal is GENERIC over (children, scenePath) accessors purely so it is unit-testable: the test host
    // has Godot loaded but no engine, so a real Node tree cannot be built (it segfaults) — the tests drive this
    // same code over a plain record tree. The live call site below passes the Godot accessors.
    internal const int LayerProbeMaxDepth = 3;

    internal static List<string> CollectMountedLayerPaths<TNode>(
        TNode bgRoot,
        Func<TNode, IReadOnlyList<TNode>> children,
        Func<TNode, string?> scenePath,
        int maxDepth = LayerProbeMaxDepth)
    {
        var layers = new List<string>();
        foreach (var placeholder in children(bgRoot))
        {
            if (FindShallowestInstancedScene(placeholder, children, scenePath, maxDepth) is { } layerPath)
            {
                layers.Add(layerPath);
            }
        }

        return layers;
    }

    // Breadth-first so the SHALLOWEST instanced scene wins (see CollectMountedLayerPaths).
    private static string? FindShallowestInstancedScene<TNode>(
        TNode start,
        Func<TNode, IReadOnlyList<TNode>> children,
        Func<TNode, string?> scenePath,
        int maxDepth)
    {
        var frontier = new List<TNode> { start };
        for (var depth = 0; depth <= maxDepth && frontier.Count > 0; depth++)
        {
            var next = new List<TNode>();
            foreach (var node in frontier)
            {
                if (scenePath(node) is { Length: > 0 } path)
                {
                    return path;
                }

                next.AddRange(children(node));
            }

            frontier = next;
        }

        return null;
    }

    private static List<string> CollectMountedLayerPaths(Node bgRoot)
        => CollectMountedLayerPaths<Node>(
            bgRoot,
            node => [.. node.GetChildren()],
            node => node.SceneFilePath);

    /// <summary>
    /// WARM-AT-PUBLISH gate: is this publish a QUALIFIED variant — one carrying a layer digest (combat) or a
    /// probed frame spec (events, the shop)?
    /// </summary>
    /// <remarks>
    /// Only a qualified variant needs warming. Its URL names a variant that exists ONLY while the tracker is
    /// publishing it: the route refuses to render a digest/frame that is no longer current
    /// (CouchCoopBrowserServer.HandleStaticBackgroundRequestAsync), and the host keeps no digest→layers history,
    /// so a variant that loses that race 404s <c>unknown-background-variant</c> FOREVER rather than transiently.
    /// The UNqualified variant has no such window — it is always renderable, and
    /// <see cref="CouchCoopStaticBackgroundPrerenderJob"/> bakes every one of them at startup — so warming it
    /// again would buy nothing.
    /// </remarks>
    internal static bool IsWarmableVariant(CouchCoopStaticBackgroundState? state)
        => state is not null && (state.Digest is not null || state.EventFrame is not null);

    /// <summary>
    /// The <c>(family, id)</c> a published state addresses — the pair <c>CouchCoopStaticBackgroundProvider</c>
    /// renders from — resolved from its scene path through the same three family grammars the probe located it
    /// with. Null when the path follows none of them (nothing warmable).
    /// </summary>
    internal static (StaticBackgroundFamily Family, string Id)? TryResolveVariantTarget(
        CouchCoopStaticBackgroundState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        if (CouchCoopStaticBackgroundProvider.TryParseBackgroundId(state.ScenePath) is { } combatId)
        {
            return (StaticBackgroundFamily.Combat, combatId);
        }

        if (CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(state.ScenePath) is { } eventId)
        {
            return (StaticBackgroundFamily.Events, eventId);
        }

        if (BackgroundSceneFamilies.TryParseRoomBackgroundId(state.ScenePath) is { } roomId)
        {
            return (StaticBackgroundFamily.Rooms, roomId);
        }

        return null;
    }

    // Publish + fire the change callback (the server re-sends sessions). Change = scenePath/digest/url identity;
    // the digest already fingerprints the layer list.
    //
    // WARM-AT-PUBLISH. A qualified variant's bytes are then rendered IMMEDIATELY, off this thread, instead of
    // on the first client fetch. That is what closes the permanent-404 hole: the URL the envelope is about to
    // advertise is renderable only while it is the CURRENT publish, and a client fetch that arrives after the
    // next publish (~125ms of deferred probe hops away at the host's 8fps idle) finds a route that refuses to
    // render it and a host with no digest history to render it FROM. Warming here means the bytes are on disk
    // before the race can be lost, so the currency rule never has to adjudicate — a later stale-digest fetch is
    // a disk hit, not a 404. Fire-and-forget by contract: this runs on the Godot main thread (the probe body),
    // so the callback must return immediately and do its render on a pool thread.
    private void PublishAndNotify(CouchCoopStaticBackgroundState? next)
    {
        var current = Volatile.Read(ref _published);
        var unchanged = current is null
            ? next is null
            : next is not null
              && string.Equals(current.ScenePath, next.ScenePath, StringComparison.Ordinal)
              && string.Equals(current.Digest, next.Digest, StringComparison.Ordinal)
              && string.Equals(current.EventFrame, next.EventFrame, StringComparison.Ordinal)
              && string.Equals(current.Url, next.Url, StringComparison.Ordinal);
        if (unchanged)
        {
            return;
        }

        Volatile.Write(ref _published, next);
        _onPublishedChanged?.Invoke();

        if (_warmVariant is { } warm && IsWarmableVariant(next))
        {
            try
            {
                warm(next!);
            }
            catch (Exception exception)
            {
                // A warm is an optimization; its failure must never break the publish the clients are waiting on.
                _log($"static-bg-warm scheduling failed: {exception.GetType().Name}: {exception.Message}");
            }
        }
    }

    /// <summary>Test seam: publish a value through the real change-detection path (fires the callback).</summary>
    internal void PublishForTest(CouchCoopStaticBackgroundState? state) => PublishAndNotify(state);

    /// <summary>Test seam: clear the process-wide published slot between tests.</summary>
    internal static void ResetForTest() => Volatile.Write(ref _published, null);
}
