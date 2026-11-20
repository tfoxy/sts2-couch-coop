using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;
using Spirectl.Sts2.Live;

// The EVENT half of the static-background feature (the mirror's "Static background" setting on event screens):
// the /bg/events/<id> grammar, the provider's single literal-scene render rung riding the same
// memory/disk/single-flight belt, the digest-less contract, and the tracker's event-backdrop locate (the pure
// BFS the main-thread probe drives over the live tree).
internal static class StaticBackgroundEventsTests
{
    private const string NeowScene = "res://scenes/events/background_scenes/neow.tscn";

    /// <summary>The game-build qualifier every minted asset URL ends with. Opaque; the grammar around it is not.</summary>
    private static string BuildQualifier => $"&b={Uri.EscapeDataString(CouchCoopAssetVersion.Token)}";

    public static async Task RunAsync()
    {
        FindsCharacterSelectMountedRoot();
        HiddenCharacterSelectScreenRestoresTheLiveBackground();
        CharacterSelectRemovalKeepsTheEmptyContainerObserved();
        CharacterSelectRevealUsesTheTopmostBackground();
        SelectsOnlyOccludedPredecessors();
        HidesCharacterSelectAndOccludedPredecessorsTogether();
        ParsesTheEventBackdropConvention();
        EventKeysAndUrlsAreDigestLessAndNamespaced();
        FrameSpecsFormatValidateAndQualifyKeys();
        await RendersTheLiteralEventSceneThroughTheSharedBeltAsync();
        await EventDigestMisuseThrowsAsync();
        await HeadlessEventServesDiskOr503Async();
        FindsTheShallowestEventBackdropWithinBudget();
        TrackerPublishesEventStatesDigestLess();
        LateBackdropMountReArmsTheProbe();
        Console.WriteLine("StaticBackgroundEventsTests passed");
    }

    private static void FindsCharacterSelectMountedRoot()
    {
        var parent = N(null, N("res://scenes/screens/char_select/char_select_bg_silent.tscn"));
        var root = N(null, parent);
        var found = CouchCoopStaticBackgroundTracker.FindCharacterSelectBackgroundRoot(root,
            n => n.Children, n => n.Scene, n => parent.Children.Contains(n) ? parent : null, _ => true);
        Assert(found is { Id: "silent" } && ReferenceEquals(found.Value.Node, parent), "the mounted container is the hide root");
        Assert(CouchCoopStaticBackgroundTracker.FindCharacterSelectBackgroundRoot(root,
            n => n.Children, n => n.Scene, _ => null, _ => true) is null, "a background without the stable parent is not admitted");
        Console.WriteLine("character-select mounted root: ok (2 checks)");
    }

    private static void HiddenCharacterSelectScreenRestoresTheLiveBackground()
    {
        var checks = 0;
        void Check(bool condition, string because) { Assert(condition, because); checks++; }
        var animated = N(null, N("res://scenes/screens/char_select/char_select_bg_silent.tscn"));
        var screen = N(null, animated);
        var tree = N(null, screen);
        var screenVisible = true;
        var visibilityReads = 0;
        var backgroundState = (Visible: true, ProcessMode: Godot.Node.ProcessModeEnum.Inherit);
        var predecessorState = (Visible: true, ProcessMode: Godot.Node.ProcessModeEnum.Always);
        var hidden = (Visible: false, ProcessMode: Godot.Node.ProcessModeEnum.Disabled);
        var states = new Dictionary<ulong, (bool Visible, Godot.Node.ProcessModeEnum ProcessMode)>
            { [1] = backgroundState, [2] = predecessorState };
        var hide = new CouchCoopStaticBackgroundTracker.StreamBackgroundHideSet();
        var hops = 0;
        var timers = 0;
        var scheduler = new CouchCoopStaticBackgroundProbeScheduler(
            () => hops++, _ => { timers++; return true; }, _ => { });
        var subscription = new CouchCoopStaticBackgroundTracker.CharacterSelectProbeSubscription(
            () => scheduler.TrySchedule("character-select scene"));
        var connected = false;
        var tracker = new CouchCoopStaticBackgroundTracker();
        (string ScenePath, string Id, TestNode Node)? Find()
            => CouchCoopStaticBackgroundTracker.FindCharacterSelectBackgroundRoot(tree,
                n => n.Children, n => n.Scene, n => animated.Children.Contains(n) ? animated : null,
                parent => { visibilityReads++; return ReferenceEquals(parent, animated) && screenVisible; });
        void Probe()
        {
            var found = Find();
            subscription.Update(true, found is not null ? 1UL : 0, _ => true,
                (_, subscribe) => connected = subscribe);
            tracker.PublishForTest(found is { } bg
                ? new CouchCoopStaticBackgroundState(bg.ScenePath, [], null, "/bg/char-select/" + bg.Id) : null);
            hide.Apply(found is not null, found is not null ? 1UL : 0, [2], id => states[id],
                (id, visible, mode) => states[id] = (visible, mode));
        }
        void VisibilityChanged()
        {
            if (connected) subscription.Changed(true);
        }
        void RunHop()
        {
            Check(hops == 1, "visibility signals fold into one deferred probe");
            hops--;
            scheduler.RunProbe(Probe);
        }

        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var initial = Find();
            Check(initial is { Id: "silent" } && ReferenceEquals(initial.Value.Node, animated),
                "a visible screen resolves to its mounted AnimatedBg");
            Probe();
            Check(states[1] == hidden && states[2] == hidden, "the still hides the root and its predecessor");
            Check(Find() is not null, "our hide on AnimatedBg does not invalidate the visible screen's descriptor");
            screenVisible = false;
            var reads = visibilityReads;
            VisibilityChanged();
            VisibilityChanged();
            Check(visibilityReads == reads && CouchCoopStaticBackgroundTracker.Published is not null,
                "visibility callbacks only schedule and leave game reads to the deferred probe");
            RunHop();
            Check(Find() is null && CouchCoopStaticBackgroundTracker.Published is null,
                "a hidden screen no longer supplies a descriptor even with its background mounted");
            Check(states[1] == backgroundState, "hiding the screen restores the root's visibility and process mode");
            Check(states[2] == predecessorState, "hiding the screen restores the predecessor's visibility and process mode");
            Check(connected && subscription.RootId == 1, "the hidden screen stays observed for its next reveal");
            screenVisible = true;
            VisibilityChanged();
            RunHop();
            var revealed = Find();
            Check(revealed is { Id: "silent" } && ReferenceEquals(revealed.Value.Node, initial!.Value.Node),
                "revealing the screen resolves to the same AnimatedBg identity");
            Check(CouchCoopStaticBackgroundTracker.Published is not null && states[1] == hidden && states[2] == hidden,
                "a visibility signal alone republishes and hides the revealed screen");
            subscription.Update(false, 0, _ => true, (_, subscribe) => connected = subscribe);
            VisibilityChanged();
            Check(!connected && hops == 0, "demand loss disconnects the visibility subscription");
            Check(timers == 0, "screen visibility probes never arm timers");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
        Console.WriteLine($"character-select screen visibility: ok ({checks} checks)");
    }

    private static void CharacterSelectRemovalKeepsTheEmptyContainerObserved()
    {
        var checks = 0;
        void Check(bool condition, string because) { Assert(condition, because); checks++; }
        var mounted = new List<TestNode> { N("res://scenes/screens/char_select/char_select_bg_silent.tscn") };
        var parent = new TestNode(null, mounted);
        var tree = N(null, parent);
        var hops = 0;
        var timers = 0;
        var scheduler = new CouchCoopStaticBackgroundProbeScheduler(
            () => hops++, _ => { timers++; return true; }, _ => { });
        var subscription = new CouchCoopStaticBackgroundTracker.CharacterSelectProbeSubscription(
            () => scheduler.TrySchedule("character-select child"));
        var connected = new HashSet<ulong>();
        var attached = true;
        var demand = true;
        var tracker = new CouchCoopStaticBackgroundTracker();
        var hide = new CouchCoopStaticBackgroundTracker.StreamBackgroundHideSet();
        var visible = true;
        var mode = Godot.Node.ProcessModeEnum.Inherit;
        void Probe()
        {
            var found = CouchCoopStaticBackgroundTracker.FindCharacterSelectBackgroundRoot(tree,
                n => n.Children, n => n.Scene, n => mounted.Contains(n) ? parent : null, _ => true);
            subscription.Update(demand, found is not null ? 1UL : 0, _ => attached,
                (id, subscribe) => { if (subscribe) connected.Add(id); else connected.Remove(id); });
            tracker.PublishForTest(found is { } bg
                ? new CouchCoopStaticBackgroundState(bg.ScenePath, [], null, "/bg/char-select/" + bg.Id) : null);
            hide.Apply(demand && found is not null, found is not null ? 1UL : 0, [],
                _ => (visible, mode), (_, value, processMode) => { visible = value; mode = processMode; });
        }
        void ChildChanged()
        {
            if (connected.Contains(1)) subscription.Changed(demand);
        }
        void RunHop()
        {
            Check(hops == 1, "child signals fold into exactly one deferred probe");
            hops--;
            scheduler.RunProbe(Probe);
        }

        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            Probe();
            Check(CouchCoopStaticBackgroundTracker.Published is not null && !visible, "the mounted still is published and hidden");
            ChildChanged(); // ChildExitingTree arrives before the child leaves the container.
            Check(CouchCoopStaticBackgroundTracker.Published is not null && !visible, "the exit callback only schedules");
            mounted.Clear();
            RunHop();
            Check(CouchCoopStaticBackgroundTracker.Published is null && visible && mode == Godot.Node.ProcessModeEnum.Inherit,
                "a removal-only probe clears the descriptor and restores the live screen");
            Check(subscription.RootId == 1 && connected.Contains(1), "the empty mounted container stays subscribed");
            mounted.Add(N("res://scenes/screens/char_select/char_select_bg_ironclad.tscn"));
            ChildChanged(); // ChildEnteredTree observes a later replacement without a screen event.
            ChildChanged();
            Check(CouchCoopStaticBackgroundTracker.Published is null, "entry also waits for the deferred probe");
            RunHop();
            Check(CouchCoopStaticBackgroundTracker.Published?.ScenePath == mounted[0].Scene && !visible,
                "the replacement publishes and hides again without a mirror delta");
            demand = false;
            Probe();
            Check(subscription.RootId == 0 && connected.Count == 0 && visible, "demand loss disconnects and restores visibility");
            subscription.Changed(demand);
            Check(hops == 0, "an exit racing demand loss cannot queue another probe");
            demand = true;
            Probe();
            mounted.Clear();
            attached = false;
            Probe();
            Check(subscription.RootId == 0 && connected.Count == 0, "a detached empty container disconnects");
            Check(timers == 0, "child entry and exit probes never arm timers");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
        Console.WriteLine($"character-select removal and empty container: ok ({checks} checks)");
    }

    private static void CharacterSelectRevealUsesTheTopmostBackground()
    {
        var mounted = new List<TestNode> { N("res://scenes/screens/char_select/char_select_bg_random_character.tscn") };
        var parent = new TestNode(null, mounted);
        var root = N(null, parent);
        (string ScenePath, string Id, TestNode Node)? Find()
            => CouchCoopStaticBackgroundTracker.FindCharacterSelectBackgroundRoot(root,
                n => n.Children, n => n.Scene, n => mounted.Contains(n) ? parent : null, _ => true);
        CouchCoopStaticBackgroundState State((string ScenePath, string Id, TestNode Node) found)
        {
            var url = "/bg/char-select/" + found.Id;
            return new(found.ScenePath, [], null, url, Id: "tracker:1:" + url);
        }

        var before = Find();
        Assert(before is { Id: "random_character" }, "the random still starts as the only mounted background");
        mounted.Add(N("res://scenes/screens/char_select/char_select_bg_ironclad.tscn"));
        mounted.Add(N("res://scenes/screens/char_select/char_select_bg_silent.tscn::prop"));
        var after = Find();
        Assert(after is { Id: "ironclad" } && after.Value.ScenePath == mounted[1].Scene,
            "the last matching child supplies the revealed character's descriptor");
        Assert(ReferenceEquals(before!.Value.Node, after!.Value.Node) && ReferenceEquals(after.Value.Node, parent),
            "the stable AnimatedBg remains the hide root when both backgrounds coexist");
        Assert(CouchCoopStaticBackgroundTracker.StreamHideIdentity(State(before.Value))
            == CouchCoopStaticBackgroundTracker.StreamHideIdentity(State(after.Value)),
            "the image changes without changing the hide identity");
        Console.WriteLine("character-select topmost reveal: ok (4 checks)");
    }

    private static void SelectsOnlyOccludedPredecessors()
    {
        var checks = 0;
        void Check(bool condition, string because) { Assert(condition, because); checks++; }
        var animated = new OcclusionNode();
        var lower = new OcclusionNode();
        var lowerLater = new OcclusionNode();
        var screen = new OcclusionNode(lower, animated, lowerLater);
        var middle = new OcclusionNode();
        var middleLater = new OcclusionNode();
        var submenus = new OcclusionNode(middle, screen, middleLater);
        var outer = new OcclusionNode();
        var later = new OcclusionNode();
        var menu = new OcclusionNode(outer, submenus, later) { Scene = CouchCoopStaticBackgroundTracker.MainMenuScenePath };
        var outside = new OcclusionNode();
        _ = new OcclusionNode(outside, menu);
        IReadOnlyList<OcclusionNode> Find() => CouchCoopStaticBackgroundTracker.FindOccludedPredecessors(animated,
            n => n.Parent, n => n.Children, n => n.Scene, n => n.IsControl,
            n => n.IsCanvasItem && CouchCoopStaticBackgroundTracker.IsOccludedPredecessor(n.ZIndex, n.ZAsRelative, n.TopLevel));

        Check(Find().SequenceEqual(new[] { lower, middle, outer }), "earlier branches at all three ancestor levels are selected");
        Check(!Find().Contains(outside), "selection stops at the menu root");
        Check(!Find().Contains(later) && !Find().Contains(middleLater) && !Find().Contains(lowerLater),
            "later siblings remain untouched at every level");
        foreach (var zIndex in new[] { -1, 1 })
        {
            lower.ZIndex = zIndex;
            Check(!Find().Contains(lower), "nonzero z-index predecessors are conservatively skipped");
        }
        lower.ZIndex = 0;
        lower.ZAsRelative = false;
        Check(!Find().Contains(lower), "absolute z-order predecessors are skipped");
        lower.ZAsRelative = true;
        lower.TopLevel = true;
        Check(!Find().Contains(lower), "top-level predecessors are skipped");
        lower.TopLevel = false;
        lower.IsCanvasItem = false;
        Check(!Find().Contains(lower), "non-CanvasItem predecessors are skipped");
        lower.IsCanvasItem = true;
        menu.Scene = null;
        menu.IsControl = false;
        Check(Find().SequenceEqual(new[] { lower, middle }), "an unknown non-Control ancestor bounds the walk");
        Console.WriteLine($"character-select occluded predecessor selection: ok ({checks} checks)");
    }

    private sealed class OcclusionNode
    {
        internal OcclusionNode(params OcclusionNode[] children)
        {
            Children = children;
            foreach (var child in children) child.Parent = this;
        }
        internal OcclusionNode? Parent { get; private set; }
        internal IReadOnlyList<OcclusionNode> Children { get; }
        internal string? Scene { get; set; }
        internal bool IsControl { get; set; } = true;
        internal bool IsCanvasItem { get; set; } = true;
        internal int ZIndex { get; set; }
        internal bool ZAsRelative { get; set; } = true;
        internal bool TopLevel { get; set; }
    }

    private static void HidesCharacterSelectAndOccludedPredecessorsTogether()
    {
        var checks = 0;
        void Check(bool condition, string because) { Assert(condition, because); checks++; }
        var backgroundState = (Visible: true, ProcessMode: Godot.Node.ProcessModeEnum.Inherit);
        var predecessorState = (Visible: true, ProcessMode: Godot.Node.ProcessModeEnum.Always);
        var hidden = (Visible: false, ProcessMode: Godot.Node.ProcessModeEnum.Disabled);
        var states = new Dictionary<ulong, (bool Visible, Godot.Node.ProcessModeEnum ProcessMode)>();
        var hide = new CouchCoopStaticBackgroundTracker.StreamBackgroundHideSet();
        var writes = new List<ulong>();
        void Apply(bool desired, ulong root, params ulong[] predecessors)
            => hide.Apply(desired, root, predecessors, id => states.TryGetValue(id, out var state) ? state : null,
                (id, visible, mode) => { states[id] = (visible, mode); writes.Add(id); });

        foreach (var reason in new[] { "demand loss", "disarm", "old-renderer viewer", "root loss" })
        {
            states[1] = backgroundState;
            states[2] = predecessorState;
            states[4] = predecessorState;
            Apply(true, 1, 2, 4);
            Check(states[1] == hidden && states[2] == hidden && states[4] == hidden, "the background and predecessors hide and stop processing");
            Apply(true, 1, 2, 4);
            Check(states[1] == hidden && states[2] == hidden && states[4] == hidden, "a same-root pick holds all roots hidden");
            Apply(reason == "root loss", reason == "root loss" ? 0UL : 1UL, 2, 4);
            Check(states[1] == backgroundState && states[2] == predecessorState && states[4] == predecessorState,
                $"{reason} restores all original states");
        }

        Apply(true, 1, 2);
        states[3] = backgroundState;
        Apply(true, 3);
        Check(states[1] == backgroundState && states[2] == predecessorState, "a root change restores the previous background and predecessors");
        Check(states[3] == hidden, "the new background hides without predecessors");
        Apply(false, 3);
        Check(states[3] == backgroundState, "a background without predecessors restores alone");
        Apply(true, 0, 2);
        Check(states[2] == predecessorState, "no descriptor root keeps the live predecessors");

        states[1] = (false, Godot.Node.ProcessModeEnum.Pausable);
        states[2] = (false, Godot.Node.ProcessModeEnum.Always);
        Apply(true, 1, 2);
        Check(states[2] == (false, Godot.Node.ProcessModeEnum.Always), "an invisible predecessor is left alone");
        states[2] = predecessorState;
        Apply(true, 1, 2);
        Check(states[2] == hidden, "the next probe hides a predecessor shown later");
        Apply(true, 1);
        Check(states[2] == predecessorState, "a predecessor outside the recomputed set restores immediately");
        Apply(false, 1);
        Check(states[1] == (false, Godot.Node.ProcessModeEnum.Pausable), "an originally invisible root keeps its original state");

        foreach (var changedId in new[] { 1UL, 2UL })
        {
            states[1] = (false, Godot.Node.ProcessModeEnum.Pausable);
            states[2] = predecessorState;
            Apply(true, 1, 2);
            states[changedId] = (true, Godot.Node.ProcessModeEnum.WhenPaused);
            writes.Clear();
            Apply(false, 1);
            Check(!writes.Contains(changedId), "restore does not write a node whose properties both changed");
            Check(states[changedId] == (true, Godot.Node.ProcessModeEnum.WhenPaused), "restore preserves both properties changed by the game");

            states[1] = backgroundState;
            states[2] = predecessorState;
            Apply(true, 1, 2);
            states[changedId] = (false, Godot.Node.ProcessModeEnum.WhenPaused);
            Apply(false, 1);
            Check(states[changedId] == (true, Godot.Node.ProcessModeEnum.WhenPaused), "visibility restores independently of a changed process mode");

            states[1] = (false, Godot.Node.ProcessModeEnum.Pausable);
            states[2] = predecessorState;
            Apply(true, 1, 2);
            states[changedId] = (true, Godot.Node.ProcessModeEnum.Disabled);
            Apply(false, 1);
            Check(states[changedId] == (true, changedId == 1 ? Godot.Node.ProcessModeEnum.Pausable : predecessorState.ProcessMode),
                "process mode restores independently of changed visibility");
        }

        states[1] = backgroundState;
        states[2] = predecessorState;
        Apply(true, 1, 2);
        states[2] = (true, Godot.Node.ProcessModeEnum.WhenPaused);
        Apply(true, 1, 2);
        Check(states[2] == hidden, "a later probe reapplies the hide after the game shows a held predecessor");
        Apply(false, 1);
        Check(states[2] == (true, Godot.Node.ProcessModeEnum.WhenPaused), "reapplying keeps the game's newer state for restore");
        Console.WriteLine($"character-select predecessor hide set: ok ({checks} checks)");
    }

    private static void ParsesTheEventBackdropConvention()
    {
        Assert(CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(NeowScene) == "neow", "the event convention parses to its id");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/tezcatara.tscn") == "tezcatara",
            "tezcatara lives under the same directory and parses");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/backgrounds/underdocks/underdocks_background.tscn") is null,
            "combat backgrounds (a different convention) do not parse");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/neow/props.tscn") is null,
            "a nested sub-scene is not the backdrop root");
        Assert(
            CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId("res://scenes/events/background_scenes/neow_water.gdshader") is null,
            "non-scene resources under the directory do not parse");
        Assert(CouchCoopStaticBackgroundProvider.TryParseEventBackgroundId(null) is null, "null is rejected");
    }

    private static void EventKeysAndUrlsAreDigestLessAndNamespaced()
    {
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null)
            == "bg://events/neow?w=2520&h=1080&v=1",
            "the event cache key rides the bg://events/ namespace with the fixed policy");
        // `&b=<build>` rides every URL this host mints and NO cache key — see the note on the same pair in
        // StaticBackgroundProviderTests for why the two sides differ. The token is opaque, so it is read from
        // the host; the grammar around it is pinned literally.
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null)
            == $"/bg/events/neow?v=1{BuildQualifier}",
            "the event URL grammar is /bg/events/<id>?v=1&b=<build>");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null)
            != CouchCoopStaticBackgroundProvider.BuildCacheKey("neow", null),
            "an event id can never collide with a combat background of the same name");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey("underdocks", null)
            == CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Combat, "underdocks", null),
            "the combat shorthand and the family overload mint the same key (no combat key changed)");
    }

    // `frame=` is the events counterpart of the combat layers digest: the tracker-probed LIVE backdrop frame
    // (the recovered placement lerp drifted from the shipped game — measured container y 99.4 vs the lerp's 40
    // on Neow), minted canonically so the same transform always produces the same immutable URL.
    private static void FrameSpecsFormatValidateAndQualifyKeys()
    {
        var frame = CouchCoopStaticBackgroundProvider.FormatEventFrameSpec(105.6, 99.44, 0.89);
        Assert(frame == "105.6,99.4,0.890", $"the spec format is invariant 0.1/0.001 (got {frame})");
        Assert(CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec(frame), "the canonical format validates");
        Assert(CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("-140.0,110.0,1.000"), "negative positions validate");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("105.6,99.4"), "two segments are garbled");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("105.6,99.4,-1.0"), "a negative scale is garbled");
        Assert(!CouchCoopStaticBackgroundProvider.IsValidEventFrameSpec("1e3,0,1"), "exponent notation is garbled");

        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null, frame)
            == $"bg://events/neow?w=2520&h=1080&frame={frame}&v=1",
            "the frame rides the cache key (a distinct variant)");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null, frame)
            == $"/bg/events/neow?frame={Uri.EscapeDataString(frame)}&v=1{BuildQualifier}",
            "the frame rides the URL, escaped");
        Assert(
            CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null, frame)
            != CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null),
            "frame-qualified and reference variants are distinct cache entries");
    }

    private static async Task RendersTheLiteralEventSceneThroughTheSharedBeltAsync()
    {
        var root = TempRoot();
        try
        {
            var fake = new RecordingAssetProvider();
            var provider = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);

            var miss = await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(miss.Error is null && miss.CacheStatus == "miss", "the first event request renders");
            Assert(fake.Requests.Count == 1, "the event chain is ONE literal rung — no composed keys to fall back through");
            Assert(fake.Requests[0].Key == NeowScene, "the rung addresses the literal event backdrop scene");
            Assert(fake.Requests[0] is { RenderWidth: 2520, RenderHeight: 1080, CompositionSelector: null }, "the render is pinned to the digest-less 2520x1080 policy");

            var memory = await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(memory.CacheStatus == "memory" && fake.Requests.Count == 1, "the second event request is a memory hit");

            // A COLD provider instance (fresh memory map, same disk root) serves the write-through.
            var coldFake = new RecordingAssetProvider();
            var cold = new CouchCoopStaticBackgroundProvider(coldFake, new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            var hit = await cold.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(hit.CacheStatus == "hit" && coldFake.Requests.Count == 0, "a cold instance serves the event disk cache without extracting");
            Assert(hit.Bytes!.SequenceEqual(miss.Bytes!), "disk serves the identical bytes");
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task EventDigestMisuseThrowsAsync()
    {
        var root = TempRoot();
        try
        {
            var provider = new CouchCoopStaticBackgroundProvider(new RecordingAssetProvider(), new SpirectlAssetBinaryCache(root), isHeadlessClient: false);
            try
            {
                await provider.GetImageAsync(StaticBackgroundFamily.Events, "neow", "0123456789abcdef", null);
                Assert(false, "an event request carrying a digest must throw");
            }
            catch (ArgumentException)
            {
                // The route 400s this before the provider; reaching here means a CALLER confused the families.
            }
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static async Task HeadlessEventServesDiskOr503Async()
    {
        var root = TempRoot();
        try
        {
            var fake = new RecordingAssetProvider();
            var headless = new CouchCoopStaticBackgroundProvider(fake, new SpirectlAssetBinaryCache(root), isHeadlessClient: true);

            var cold = await headless.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(cold.Error?.Code == "static-bg-unavailable" && cold.ServiceUnavailable, "a cold headless event answer is a 503-mapped structured error");
            Assert(fake.Requests.Count == 0, "a dummy-renderer process never extracts");

            var key = CouchCoopStaticBackgroundProvider.BuildCacheKey(StaticBackgroundFamily.Events, "neow", null);
            Assert(await new SpirectlAssetBinaryCache(root).TryWriteAsync(key, [1, 2, 3], "image/jpeg"), "seeding the event disk cache succeeds");
            var seeded = await headless.GetImageAsync(StaticBackgroundFamily.Events, "neow", null, null);
            Assert(seeded.Error is null && seeded.Bytes is [1, 2, 3], "a headless instance serves disk-cached event bytes");
        }
        finally
        {
            TryDelete(root);
        }
    }

    // The tracker's pure BFS half (FindEventBackgroundRoot): shallowest match wins, the parse is the STRICT
    // convention, and the node budget bounds the sweep — a budget hit means "no backdrop", never a partial answer.
    private static void FindsTheShallowestEventBackdropWithinBudget()
    {
        // room ── ui ──── deep(tezcatara)          <- deeper match, must lose
        //      └─ layout ─ backdrop(neow)          <- shallowest match, must win
        var deeper = N("res://scenes/events/background_scenes/tezcatara.tscn");
        var backdrop = N(NeowScene);
        var tree = N(null, N(null, N(null, deeper)), N(null, backdrop));

        var found = CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(tree, n => n.Children, n => n.Scene);
        Assert(found is { Id: "neow" }, "the shallowest backdrop wins");
        Assert(ReferenceEquals(found!.Value.Node, backdrop), "the located node is the backdrop root itself (the Stage-B stamping target)");
        Assert(found.Value.ScenePath == NeowScene, "the located path is the scene path the descriptor publishes");

        // Non-matching scene paths (combat convention, nested event sub-scenes) never match.
        var noMatch = N(null, N("res://scenes/backgrounds/underdocks/underdocks_background.tscn"), N("res://scenes/events/background_scenes/neow/props.tscn"));
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(noMatch, n => n.Children, n => n.Scene) is null,
            "foreign conventions do not locate");

        // Budget: a sweep that would only reach the backdrop beyond the budget reports "none".
        var wide = N(null, Enumerable.Range(0, 8).Select(_ => N(null)).Append(backdrop).ToArray());
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(wide, n => n.Children, n => n.Scene, nodeBudget: 4) is null,
            "hitting the node budget means no backdrop, not a partial answer");
        Assert(
            CouchCoopStaticBackgroundTracker.FindEventBackgroundRoot(wide, n => n.Children, n => n.Scene) is { Id: "neow" },
            "the same tree locates under the real budget");
    }

    private static void TrackerPublishesEventStatesDigestLess()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            var fired = 0;
            var tracker = new CouchCoopStaticBackgroundTracker(() => fired++);
            var state = new CouchCoopStaticBackgroundState(
                NeowScene,
                [],
                Digest: null,
                CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null));

            tracker.PublishForTest(state);
            Assert(fired == 1 && CouchCoopStaticBackgroundTracker.Published == state, "an event publish fires the change callback");
            Assert(CouchCoopStaticBackgroundTracker.Published!.Url == $"/bg/events/neow?v=1{BuildQualifier}", "the published URL is the digest-less event URL");
            Assert(CouchCoopStaticBackgroundTracker.Published.Digest is null, "an event publish is always digest-less");

            tracker.PublishForTest(state with { LayerPaths = [] });
            Assert(fired == 1, "an identical event re-publish is a no-op (no session resend storm)");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    // The late-mount race, measured live on the first Neow fixture entry: the screen-change probe ran one
    // main-thread hop after the screen delta, the backdrop scene mounted a tick LATER, and the tracker published
    // null forever (nothing re-probed). The backdrop's ADD is itself an upsert carrying SceneFilePath, so the
    // re-probe condition is "this delta upserts a strict event backdrop the current publish does not name".
    private static void LateBackdropMountReArmsTheProbe()
    {
        CouchCoopStaticBackgroundTracker.ResetForTest();
        try
        {
            static RuntimeSceneDelta Delta(params RuntimeSceneNodeDelta[] upserts)
                => new(false, "Rooms.NEventRoom", "screen:1", upserts, [], null);

            Assert(
                CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", NeowScene))),
                "an unpublished backdrop upsert re-arms the probe");
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", null), WireNode("b", "res://scenes/rooms/rest_site_room.tscn"))),
                "deltas without an event backdrop never re-arm");
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", "res://scenes/events/background_scenes/neow/props.tscn"))),
                "a nested sub-scene is not a backdrop mount");

            new CouchCoopStaticBackgroundTracker().PublishForTest(new CouchCoopStaticBackgroundState(
                NeowScene,
                [],
                Digest: null,
                CouchCoopStaticBackgroundProvider.BuildImageUrl(StaticBackgroundFamily.Events, "neow", null)));
            Assert(
                !CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(Delta(WireNode("a", NeowScene))),
                "once the publish names the path, further upserts of the backdrop stop re-arming (no probe storm)");
            Assert(
                CouchCoopStaticBackgroundTracker.CarriesUnpublishedEventBackdrop(
                    Delta(WireNode("a", "res://scenes/events/background_scenes/tezcatara.tscn"))),
                "a DIFFERENT backdrop mounting still re-arms");
        }
        finally
        {
            CouchCoopStaticBackgroundTracker.ResetForTest();
        }
    }

    private static RuntimeSceneNodeDelta WireNode(string id, string? scenePath)
        => new(id, null, id, "Node2D", null, true, 1, null, 0, null, false, null, SceneFilePath: scenePath);

    private sealed record TestNode(string? Scene, IReadOnlyList<TestNode> Children);

    private static TestNode N(string? scene, params TestNode[] children) => new(scene, children);

    private static string TempRoot()
        => Path.Combine(Path.GetTempPath(), "couchcoop-static-bg-events-" + Guid.NewGuid().ToString("N"));

    private static void TryDelete(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort temp cleanup.
        }
    }

    private static void Assert(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException(because);
        }
    }

    // Succeeds for any key with tiny JPEG-tagged bytes; the event chain has no rungs to script, so recording the
    // requests is the whole job.
    private sealed class RecordingAssetProvider : ISpirectlAssetProvider
    {
        public List<EmbeddableAssetRequest> Requests { get; } = [];

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request)
        {
            Requests.Add(request);
            return new(
                true,
                new EmbeddableAssetPayload(
                    request.RequestId ?? string.Empty,
                    request.Key,
                    "image",
                    "jpeg",
                    "image/jpeg",
                    request.RenderWidth ?? 0,
                    request.RenderHeight ?? 0,
                    [0xFF, 0xD8, 0xFF, 0xE0],
                    [],
                    new EmbeddableAssetProvenance("bg", request.Key, request.Key, "event_background", "test"),
                    []),
                null);
        }

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request)
            => new("ok", [GetAsset(request.Requests[0])]);
    }
}
