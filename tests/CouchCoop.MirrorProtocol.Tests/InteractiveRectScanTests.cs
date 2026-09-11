using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for InteractiveRectScan — the native port of mirrorRenderer.ts forEachInteractiveRect. Verifies the
// eligibility gate (visible + mouse-visible Stop/Pass + transform + box), the paint-order (OrderedIds, back-to-front)
// output, the composed game-space global, the exclusion sets (remote follower / echo container / owner-anchored
// floater / ancestor-hidden), and that the spread shift/width come from the SpreadIndex (0 with the F=1 stub, which
// documents the WS-P seam). Node fixtures are re-expressed from the web pointerMap/mirrorRenderer scene shapes.
internal static class InteractiveRectScanTests
{
    public static void Run()
    {
        MouseVisibleControlsYieldedInPaintOrder();
        IgnoreFilterAndNonControlsSkipped();
        InvisibleAndAncestorHiddenSkipped();
        MissingTransformOrBoxSkipped();
        ExcludedAurasAndFollowersSkipped();
        GlobalIsComposedGameSpace();
        SpreadFieldsComeFromIndexZeroWithStub();
    }

    // ---- fixture helpers ----

    private static MirrorNode Ctrl(
        string id,
        string? parent,
        double x,
        double y,
        double w = 100,
        double h = 40,
        int? mouseFilter = 0,
        bool visible = true,
        string nodeType = "Control",
        string name = "",
        string? anchorOwnerId = null) =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = nodeType,
            Name = name,
            Visible = visible,
            MouseFilter = mouseFilter,
            AnchorOwnerId = anchorOwnerId,
            Transform = [1, 0, 0, 1, x, y],
            LocalRect = new MirrorRect(0, 0, w, h),
        };

    // Build a local-space state with the nodes in draw order (OrderedIds), mark all changed, bump revision. Returns
    // the state + a freshly-updated GlobalTransformIndex + an (empty, F=1) SpreadIndex stub.
    private static (MirrorState State, GlobalTransformIndex Transforms, SpreadIndex Spread) Scene(params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var n in nodes)
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var spread = new SpreadIndex();
        spread.Update(state, transforms, 1); // F=1 stub → no records
        return (state, transforms, spread);
    }

    private static List<string> Ids(MirrorState s, GlobalTransformIndex t, SpreadIndex sp) =>
        InteractiveRectScan.Collect(s, t, sp).ConvertAll(r => r.Id);

    // ---- tests ----

    // Stop (0) AND Pass (1) mouse-visible controls are yielded, in OrderedIds (paint, back-to-front) order.
    private static void MouseVisibleControlsYieldedInPaintOrder()
    {
        var (s, t, sp) = Scene(
            Ctrl("back", null, 100, 100, mouseFilter: 0),
            Ctrl("passtip", null, 300, 100, mouseFilter: 1), // Pass = tooltip-only, still offends the map
            Ctrl("front", null, 500, 100, mouseFilter: 0));

        Check.SequenceEqual(Ids(s, t, sp), ["back", "passtip", "front"], "Stop+Pass controls yielded in paint order");
    }

    // mouse_filter Ignore (2) and non-Control nodes (mouseFilter null) never anchor the map.
    private static void IgnoreFilterAndNonControlsSkipped()
    {
        var (s, t, sp) = Scene(
            Ctrl("stop", null, 0, 0, mouseFilter: 0),
            Ctrl("ignore", null, 200, 0, mouseFilter: 2),      // Ignore → invisible to the mouse
            Ctrl("sprite", null, 400, 0, mouseFilter: null));  // Node2D-family (no mouse_filter) → not a Control

        Check.SequenceEqual(Ids(s, t, sp), ["stop"], "Ignore + non-Control skipped");
    }

    private static void InvisibleAndAncestorHiddenSkipped()
    {
        var (s, t, sp) = Scene(
            Ctrl("shown", null, 0, 0),
            Ctrl("hidden", null, 100, 0, visible: false),      // own-invisible
            Ctrl("group", null, 0, 0, visible: false),         // hidden ancestor...
            Ctrl("child", "group", 200, 0));                   // ...visible child under it

        Check.SequenceEqual(Ids(s, t, sp), ["shown"], "own-invisible + ancestor-hidden controls skipped");
    }

    private static void MissingTransformOrBoxSkipped()
    {
        var noTransform = Ctrl("notf", null, 0, 0);
        noTransform.Transform = null;
        var noBox = Ctrl("nobox", null, 0, 0);
        noBox.LocalRect = null;

        var (s, t, sp) = Scene(Ctrl("ok", null, 0, 0), noTransform, noBox);
        Check.SequenceEqual(Ids(s, t, sp), ["ok"], "controls without a transform or a box skipped");
    }

    // The isHitTestExcluded set: remote followers, echo-container copies (Preview/HoverTip/Inspect), and
    // owner-anchored floaters never anchor.
    private static void ExcludedAurasAndFollowersSkipped()
    {
        var (s, t, sp) = Scene(
            Ctrl("real", null, 0, 0),
            Ctrl("cursor", null, 10, 10, nodeType: "Multiplayer.NRemoteMouseCursor"),
            Ctrl("indicator", null, 20, 20, nodeType: "Combat.NRemoteTargetingIndicator"),
            Ctrl("preview", null, 30, 30, nodeType: "Cards.NCardPreviewContainer"),
            Ctrl("hovertip", null, 40, 40, nodeType: "HoverTips.NHoverTipCardContainer"),
            Ctrl("inspect", null, 50, 50, nodeType: "Cards.NInspectCardScreen"),
            Ctrl("floater", null, 60, 60, anchorOwnerId: "real"));

        Check.SequenceEqual(Ids(s, t, sp), ["real"], "remote followers / echo containers / owner-floaters excluded");
        Check.That(InteractiveRectScan.IsRemoteFollower(s.Nodes["cursor"]), "NRemoteMouseCursor is a remote follower");
        Check.That(!InteractiveRectScan.IsRemoteFollower(s.Nodes["real"]), "a plain Control is not a remote follower");
    }

    // The yielded Global is the node's composed game-space global (local space → parent chain), matching the index —
    // == the web liftEndpointToGlobal.
    private static void GlobalIsComposedGameSpace()
    {
        var parent = Ctrl("parent", null, 500, 300);       // transform tx=500, ty=300
        var child = Ctrl("child", "parent", 20, 10);       // local tx=20, ty=10 → global tx=520, ty=310
        var (s, t, sp) = Scene(parent, child);

        var rects = InteractiveRectScan.Collect(s, t, sp);
        var childRect = rects.Find(r => r.Id == "child");
        Check.That(childRect.Id == "child", "child rect present");
        Check.Close(childRect.Global[4], 520, "child global tx composed (500+20)");
        Check.Close(childRect.Global[5], 310, "child global ty composed (300+10)");
        Check.Close(childRect.LocalRect.Width, 100, "child localRect carried through");
    }

    // With the F=1 SpreadIndex stub every record's SpreadDx/RenderedWidth is 0 (the WS-P seam — WS-P's SpreadWalkTests
    // exercise non-zero values). This pins the frozen contract: the scan reads the spread fields off the index.
    private static void SpreadFieldsComeFromIndexZeroWithStub()
    {
        var (s, t, sp) = Scene(Ctrl("a", null, 0, 0), Ctrl("b", null, 200, 0));
        foreach (var r in InteractiveRectScan.Collect(s, t, sp))
        {
            Check.Close(r.SpreadDx, 0, $"{r.Id}: spreadDx 0 under the F=1 stub");
            Check.Close(r.RenderedWidth, 0, $"{r.Id}: renderedWidth 0 under the F=1 stub");
        }
    }
}
