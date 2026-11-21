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
    string? EventFrame = null,
    // Mounted-root identity, independent of the image cache URL.
    string? Id = null,
    // Live combat placement in the centered 1920x1080 reference, independent of the still's capture framing.
    string? CombatFrame = null);

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
// Room stills use the host's publish, including on seats. Character-select stills use the seat's own pick.
// The probe runs whenever anybody shows a still, including viewers whose host socket is gated. Screen and
// demand triggers fold into the one queued probe; char-select also subscribes to its mounted root's child-entry/exit
// and screen visibility signals while stream static-background demand lasts.
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
        Action<CouchCoopStaticBackgroundState>? warmVariant = null,
        Func<CouchCoopStaticBackgroundState, Task<CouchCoopStaticBackgroundResult>>? renderStill = null)
    {
        _onPublishedChanged = onPublishedChanged;
        _log = log ?? CouchCoopLog.Stderr;
        _warmVariant = warmVariant;
        _stillSource = new CouchCoopSeatStillSource(renderStill ?? (_ => Task.FromResult(
            CouchCoopStaticBackgroundResult.Failure(new CouchCoopAssetHttpError("unavailable", "No still provider.")))));
        _scheduler = new CouchCoopStaticBackgroundProbeScheduler(
            ScheduleProbeOnMainThread,
            ArmFollowUpTimerOnMainThread,
            _log);
        _characterSelectSubscription = new(() => _scheduler.TrySchedule("character-select scene"));
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
    private readonly string _identityPrefix = Guid.NewGuid().ToString("N");
    private string? _desiredStreamHide;
    private volatile bool _characterSelectProbeDesired;
    private readonly CharacterSelectProbeSubscription _characterSelectSubscription;
    private ulong _characterSelectScreenInstanceId;
    private readonly StreamBackgroundHideSet _streamBackgroundHide = new();
    private readonly CouchCoopSeatStillSource _stillSource;
    private readonly StreamStillLifetime _stillLifetime = new();
    private ulong _stillNodeId;
    private ulong _stillViewportId;
    private SeatStillAdmission? _streamStillSource;
    private readonly SeatStillSelection _stillSelection = new();
    private CouchCoopStaticBackgroundState? _stillState;


    public void SetDesiredStreamHide(string? descriptorId)
    {
        if (string.Equals(Volatile.Read(ref _desiredStreamHide), descriptorId, StringComparison.Ordinal)) return;
        Volatile.Write(ref _desiredStreamHide, descriptorId);
        if (CouchCoopMod.EngineAvailable) _scheduler.TrySchedule("stream-background");
    }

    public void SetStreamStillSource(string? source, string? sourceFor)
    {
        var admission = source is null && sourceFor is null ? null : new SeatStillAdmission(source, sourceFor);
        if (Volatile.Read(ref _streamStillSource) == admission) return;
        Volatile.Write(ref _streamStillSource, admission);
        if (CouchCoopMod.EngineAvailable) _scheduler.TrySchedule("stream still source");
    }

    public void SetCharacterSelectProbeDesired(bool desired)
    {
        if (_characterSelectProbeDesired == desired) return;
        _characterSelectProbeDesired = desired;
        if (CouchCoopMod.EngineAvailable) _scheduler.TrySchedule("character-select demand");
    }

    // Picks change the image identity, but the mounted container must stay hidden throughout the swap.
    internal static string? StreamHideIdentity(CouchCoopStaticBackgroundState? state)
    {
        if (state?.Id is not { } id) return null;
        return BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId(state.ScenePath) is not null
            && id.EndsWith(":" + state.Url, StringComparison.Ordinal)
                ? id[..^(state.Url.Length + 1)]
                : id;
    }

    internal string? DesiredStreamHideForTest => Volatile.Read(ref _desiredStreamHide);
    internal string? StreamStillSourceForTest => Volatile.Read(ref _streamStillSource)?.Path;
    internal string? StreamStillSourceIdentityForTest => Volatile.Read(ref _streamStillSource)?.SourceFor;

    internal static bool MatchesStreamBackground(string? desiredId, string? currentId)
        => !string.IsNullOrEmpty(desiredId) && string.Equals(desiredId, currentId, StringComparison.Ordinal);

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
            && !CarriesUnpublishedEventBackdrop(delta, _characterSelectProbeDesired))
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
    internal static bool CarriesUnpublishedEventBackdrop(RuntimeSceneDelta delta, bool includeCharacterSelect = false)
    {
        foreach (var upsert in delta.Upserts)
        {
            if (upsert.SceneFilePath is not { Length: > 0 } path
                || (CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(path) is null
                    && BackgroundSceneFamilies.TryParseRoomBackgroundId(path) is null
                    && (!includeCharacterSelect || BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId(path) is null)))
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
                ?? LocateRoomBackground(root, out bgRoot)
                ?? (_characterSelectProbeDesired ? LocateCharacterSelectBackground(root, out bgRoot) : null);
        }

        // Stage-B stamping half: apply the current desired-skip verdict to the LOCATED root (the node whose
        // SceneFilePath produced `next.ScenePath`). Runs before the publish so a screen-change probe stamps the
        // new room's root in the same main-thread hop that announces it.
        if (next is not null && bgRoot is not null)
        {
            next = next with { Id = _identityPrefix + ":" + bgRoot.GetInstanceId() + ":" + next.Url };
        }
        var characterSelect = BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId(next?.ScenePath) is not null;
        UpdateCharacterSelectSignalRoot(_characterSelectProbeDesired && (next is null || characterSelect),
            characterSelect ? bgRoot : null);
        ApplyStreamSkip(characterSelect ? null : bgRoot);
        PublishAndNotify(next);
        ApplyStreamBackgroundHide(bgRoot, next, characterSelect);
    }

    private static CouchCoopStaticBackgroundState? LocateCharacterSelectBackground(Node root, out Node? bgRoot)
    {
        bgRoot = null;
        var found = FindCharacterSelectBackgroundRoot<Node>(root,
            node => [.. node.GetChildren()], node => node.SceneFilePath,
            node => node.GetParent() is Control parent && parent.Name == "AnimatedBg" ? parent : null,
            node => node.GetParent() is CanvasItem screen && screen.IsVisibleInTree());
        if (found is null)
        {
            return null;
        }

        bgRoot = found.Value.Node;
        return new CouchCoopStaticBackgroundState(found.Value.ScenePath, [], null,
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.CharacterSelect, found.Value.Id, null));
    }

    internal static (string ScenePath, string Id, TNode Node)? FindCharacterSelectBackgroundRoot<TNode>(
        TNode root, Func<TNode, IReadOnlyList<TNode>> children, Func<TNode, string?> scenePath,
        Func<TNode, TNode?> animatedParent, Func<TNode, bool> screenVisible) where TNode : class
    {
        var found = FindBackgroundSceneRoot(root, children, scenePath,
            BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId);
        if (found is not { } background || animatedParent(background.Node) is not { } parent) return null;
        // The hide root may carry our own hide; only its screen determines whether the still is current.
        if (!screenVisible(parent)) return null;
        var mounted = children(parent);
        for (var i = mounted.Count - 1; i >= 0; i--)
        {
            if (scenePath(mounted[i]) is { } path
                && BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId(path) is { } id)
            {
                return (path, id, parent);
            }
        }
        return null;
    }

    internal const string MainMenuScenePath = "res://scenes/screens/main_menu.tscn";

    // Earlier sibling branches are occluded by the opaque still. Later siblings remain live above it.
    internal static IReadOnlyList<TNode> FindOccludedPredecessors<TNode>(TNode root,
        Func<TNode, TNode?> parent, Func<TNode, IReadOnlyList<TNode>> children,
        Func<TNode, string?> scenePath, Func<TNode, bool> isControl, Func<TNode, bool> eligible)
        where TNode : class
    {
        var result = new List<TNode>();
        for (var branch = root; parent(branch) is { } ancestor && isControl(ancestor); branch = ancestor)
        {
            foreach (var sibling in children(ancestor))
            {
                if (ReferenceEquals(sibling, branch)) break;
                if (eligible(sibling)) result.Add(sibling);
            }
            if (scenePath(ancestor) == MainMenuScenePath) break;
        }
        return result;
    }

    internal static bool IsOccludedPredecessor(int zIndex, bool zAsRelative, bool topLevel)
        => zIndex == 0 && zAsRelative && !topLevel;

    // Main thread only. Hold an instance id so freed screens do not leave a managed node reference behind.
    private void UpdateCharacterSelectSignalRoot(bool desired, Node? root)
    {
        _characterSelectSubscription.Update(desired, root?.GetInstanceId() ?? 0,
            id => GodotObject.InstanceFromId(id) is Node previous && previous.IsInsideTree(),
            (id, subscribed) =>
            {
                if (subscribed)
                {
                    if (GodotObject.InstanceFromId(id) is not Node node) return;
                    node.ChildEnteredTree += OnCharacterSelectChildChanged;
                    node.ChildExitingTree += OnCharacterSelectChildChanged;
                    if (node.GetParent() is CanvasItem screen)
                    {
                        _characterSelectScreenInstanceId = screen.GetInstanceId();
                        screen.VisibilityChanged += OnCharacterSelectChanged;
                    }
                }
                else
                {
                    if (GodotObject.InstanceFromId(id) is Node node)
                    {
                        node.ChildEnteredTree -= OnCharacterSelectChildChanged;
                        node.ChildExitingTree -= OnCharacterSelectChildChanged;
                    }
                    if (_characterSelectScreenInstanceId != 0
                        && GodotObject.InstanceFromId(_characterSelectScreenInstanceId) is CanvasItem screen)
                        screen.VisibilityChanged -= OnCharacterSelectChanged;
                    _characterSelectScreenInstanceId = 0;
                }
            });
    }

    private void OnCharacterSelectChildChanged(Node child) => OnCharacterSelectChanged();

    private void OnCharacterSelectChanged()
    {
        // Signal callbacks only schedule; the folded probe reads the tree after the frame boundary.
        _characterSelectSubscription.Changed(_characterSelectProbeDesired);
    }

    internal sealed class CharacterSelectProbeSubscription(Action scheduleProbe)
    {
        internal ulong RootId { get; private set; }

        internal void Update(bool desired, ulong locatedRootId, Func<ulong, bool> isInsideTree,
            Action<ulong, bool> setSubscribed)
        {
            // Empty or hidden containers still observe the next pick or reveal; detach or demand loss retires them.
            var nextId = desired ? locatedRootId : 0;
            if (desired && nextId == 0 && RootId != 0 && isInsideTree(RootId)) nextId = RootId;
            if (RootId == nextId) return;
            if (RootId != 0) setSubscribed(RootId, false);
            RootId = nextId;
            if (RootId != 0) setSubscribed(RootId, true);
        }

        internal void Changed(bool desired)
        {
            if (desired) scheduleProbe();
        }
    }

    // Main thread only. Retire the previous root before considering a new room's descriptor.
    private void ApplyStreamBackgroundHide(Node? bgRoot, CouchCoopStaticBackgroundState? state, bool characterSelect)
    {
        var descriptorId = StreamHideIdentity(state);
        var desired = MatchesStreamBackground(Volatile.Read(ref _desiredStreamHide), descriptorId);
        // The still is best effort; the hide below is not. A failure here must never leave the live root showing.
        try
        {
            _stillLifetime.Update(desired, bgRoot is CanvasItem ? bgRoot.GetInstanceId() : 0, state,
                id => GodotObject.InstanceFromId(id) is CanvasItem item && item.IsInsideTree(),
                () => InsertStreamStill((CanvasItem)bgRoot!, state!), RetireStreamStill);
            if (_stillLifetime.RootId != 0)
            {
                RefreshStreamStill(state!);
                UpdateStreamStillPlacement(state!);
            }
        }
        catch (Exception exception)
        {
            _log($"stream-bg still update failed: {exception.GetType().Name}: {exception.Message}");
        }
        var predecessors = desired && characterSelect && bgRoot is not null
            ? FindOccludedPredecessors<Node>(bgRoot, node => node.GetParent(),
                node => [.. node.GetChildren()], node => node.SceneFilePath, node => node is Control,
                node => node.GetInstanceId() != _stillNodeId && node is CanvasItem item
                    && IsOccludedPredecessor(item.ZIndex, item.ZAsRelative, item.TopLevel))
                .Select(node => node.GetInstanceId()).ToArray()
            : [];
        _streamBackgroundHide.Apply(desired, bgRoot is CanvasItem ? bgRoot.GetInstanceId() : 0,
            predecessors,
            id => GodotObject.InstanceFromId(id) is CanvasItem item ? (item.Visible, item.ProcessMode) : null,
            (id, visible, processMode) =>
            {
                if (GodotObject.InstanceFromId(id) is not CanvasItem item) return;
                item.Visible = visible;
                item.ProcessMode = processMode;
            });
    }

    private void OnStreamBackgroundChanged() => _scheduler.TrySchedule("stream background visibility");

    private void InsertStreamStill(CanvasItem root, CouchCoopStaticBackgroundState state)
    {
        var parent = root.GetParent();
        var node = new Node2D { Name = "CouchCoopSeatStill", ZIndex = root.ZIndex, ZAsRelative = root.ZAsRelative };
        CouchCoopStreamSkip.Stamp(node);
        var placeholder = new ColorRect
        {
            Name = "Placeholder", Color = new Color("#181818"), MouseFilter = Control.MouseFilterEnum.Ignore,
        };
        CouchCoopStreamSkip.Stamp(placeholder);
        node.AddChild(placeholder);
        var sprite = new Sprite2D { Name = "Still", Centered = false };
        CouchCoopStreamSkip.Stamp(sprite);
        node.AddChild(sprite);
        parent.AddChild(node);
        parent.MoveChild(node, root.GetIndex());
        _stillNodeId = node.GetInstanceId();
        root.VisibilityChanged += OnStreamBackgroundChanged;
        root.TreeExiting += OnStreamBackgroundChanged;
        var viewport = root.GetViewport();
        _stillViewportId = viewport.GetInstanceId();
        viewport.SizeChanged += OnStreamBackgroundChanged;
        _log($"stream-bg engaged id={state.Id} reason=static demand");
    }

    private void RefreshStreamStill(CouchCoopStaticBackgroundState state)
    {
        _stillState = state;
        var source = Volatile.Read(ref _streamStillSource);
        if (!_stillSelection.Update(state.Id, source)) return;
        // Detach the old texture before the source retires it. Loading and failure keep the same dark node.
        if (GodotObject.InstanceFromId(_stillNodeId) is Node2D node)
            node.GetNode<Sprite2D>("Still").Texture = null;
        _stillSource.Retire();
        if (_stillSelection.Source is not { } path) return;
        var generation = _stillLifetime.Generation;
        var requestGeneration = _stillSelection.Generation;
        _stillSource.Request(state, path, texture =>
        {
            if (!_stillLifetime.IsCurrent(generation)
                || !_stillSelection.IsCurrent(requestGeneration, Published?.Id, Volatile.Read(ref _streamStillSource))
                || !MatchesStreamBackground(Volatile.Read(ref _desiredStreamHide), StreamHideIdentity(state))
                || GodotObject.InstanceFromId(_stillLifetime.RootId) is not CanvasItem live || !live.IsInsideTree()
                || GodotObject.InstanceFromId(_stillNodeId) is not Node2D still) return;
            if (texture is not null) still.GetNode<Sprite2D>("Still").Texture = texture;
            UpdateStreamStillPlacement(_stillState!);
        });
    }

    private void UpdateStreamStillPlacement(CouchCoopStaticBackgroundState state)
    {
        if (GodotObject.InstanceFromId(_stillNodeId) is not Node2D node) return;
        // Cancel the sibling parent's transform without TopLevel, preserving the background's draw order.
        node.Transform = Transform2D.Identity;
        node.Transform = node.GetGlobalTransform().AffineInverse();
        var viewport = node.GetViewportRect().Size;
        node.GetNode<ColorRect>("Placeholder").Size = viewport;
        var family = TryResolveVariantTarget(state)?.Family ?? StaticBackgroundFamily.Events;
        var parentGlobal = node.GetGlobalTransform();
        var transform = CouchCoopSeatStillPlacement.LocalTransform(family, state.CombatFrame, viewport.X,
            new System.Numerics.Matrix3x2(parentGlobal.X.X, parentGlobal.X.Y, parentGlobal.Y.X, parentGlobal.Y.Y,
                parentGlobal.Origin.X, parentGlobal.Origin.Y));
        node.GetNode<Sprite2D>("Still").Transform = new Transform2D(
            new Vector2(transform.M11, transform.M12), new Vector2(transform.M21, transform.M22),
            new Vector2(transform.M31, transform.M32));
    }

    private void RetireStreamStill(string reason)
    {
        if (GodotObject.InstanceFromId(_stillLifetime.RootId) is CanvasItem root)
        {
            root.VisibilityChanged -= OnStreamBackgroundChanged;
            root.TreeExiting -= OnStreamBackgroundChanged;
        }
        if (GodotObject.InstanceFromId(_stillViewportId) is Viewport viewport)
            viewport.SizeChanged -= OnStreamBackgroundChanged;
        if (GodotObject.InstanceFromId(_stillNodeId) is Node2D node)
        {
            node.GetNode<Sprite2D>("Still").Texture = null;
            node.Visible = false;
            node.QueueFree();
        }
        _stillNodeId = _stillViewportId = 0;
        _stillSelection.Retire();
        _stillState = null;
        _stillSource.Retire();
        _log($"stream-bg retired id={_stillLifetime.Descriptor} reason={reason}");
    }

    // Instance ids keep freed screens out of the saved state. All hides share the mounted root's lifetime.
    internal sealed class StreamBackgroundHideSet
    {
        private ulong _rootId;
        private readonly Dictionary<ulong, (bool Visible, Node.ProcessModeEnum ProcessMode)> _saved = [];

        internal void Apply(bool desired, ulong rootId, IReadOnlyList<ulong> predecessors,
            Func<ulong, (bool Visible, Node.ProcessModeEnum ProcessMode)?> read,
            Action<ulong, bool, Node.ProcessModeEnum> write)
        {
            var targets = desired && rootId != 0 ? predecessors.Append(rootId).ToHashSet() : [];
            foreach (var id in _saved.Keys.ToArray())
            {
                if (rootId == _rootId && targets.Contains(id)) continue;
                var saved = _saved[id];
                if (read(id) is { } current)
                {
                    // Restore each property only while it still holds our value.
                    var visible = current.Visible ? current.Visible : saved.Visible;
                    var processMode = current.ProcessMode == Node.ProcessModeEnum.Disabled ? saved.ProcessMode : current.ProcessMode;
                    if (visible != current.Visible || processMode != current.ProcessMode) write(id, visible, processMode);
                }
                _saved.Remove(id);
            }
            _rootId = desired ? rootId : 0;
            foreach (var id in targets)
            {
                if (read(id) is not { } current) continue;
                if (_saved.TryGetValue(id, out var saved))
                {
                    // A later probe can hide a newly shown predecessor without losing the game's newer state.
                    _saved[id] = (current.Visible ? current.Visible : saved.Visible,
                        current.ProcessMode == Node.ProcessModeEnum.Disabled ? saved.ProcessMode : current.ProcessMode);
                }
                else
                {
                    if (id != rootId && !current.Visible) continue;
                    _saved.Add(id, current);
                }
                if (current.Visible || current.ProcessMode != Node.ProcessModeEnum.Disabled)
                    write(id, false, Node.ProcessModeEnum.Disabled);
            }
        }
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
                    CouchCoopStaticBackgroundProvider.BuildImageUrl(id, digest),
                    CombatFrame: ProbeFrameSpec(child));
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

        if (BackgroundSceneFamilies.TryParseCharacterSelectBackgroundId(state.ScenePath) is { } characterId)
        {
            return (StaticBackgroundFamily.CharacterSelect, characterId);
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
              && string.Equals(current.CombatFrame, next.CombatFrame, StringComparison.Ordinal)
              && string.Equals(current.Url, next.Url, StringComparison.Ordinal)
              && string.Equals(current.Id, next.Id, StringComparison.Ordinal);
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
