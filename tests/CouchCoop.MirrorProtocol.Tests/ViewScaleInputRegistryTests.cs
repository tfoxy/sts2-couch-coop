using System;
using System.Collections.Generic;
using System.Linq;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R5 (WS-A) truth table for the PURE view-scale input-gate registry construction (ViewScaleInputRegistry.Build) and
// its four neighbour-exclusion rules. The regression the whole file guards: a scaled GROUP's full-viewport ANCESTORS
// (NGame / RootSceneContainer / … / NRewardsScreen) must NOT be collected as neighbours — the pre-R5 walk only went UP
// so they were, and IsExempt then exempted EVERY interior tap → the group's inverse never fired → "taps land as if the
// container was never scaled" (the card-reward Skip / side-card mis-tap).
internal static class ViewScaleInputRegistryTests
{
    private const double W = 1920, H = 1080;

    public static void Run()
    {
        AncestorRectsAreNotNeighbors();
        EnclosingBackdropIsNotNeighbor();
        StageBandIsNotNeighbor();
        UnderlayBelowGroupIsNotNeighbor();
        OverlayAboveGroupIsNeighbor();
        ItemHaloSiblingSurvivesFilter();
        FullViewportNoClampEdgeRemap();
        HiddenAncestorStampIsNotPublished();
        NestedRewardCardsUseComposedChannels();
    }

    // R10 WS-F — EFFECTIVE VISIBILITY. A SCREEN is hidden by clearing the flag on its ROOT; every descendant keeps
    // Visible=true, and the stamp INDEX deliberately still stamps such a node (an invisible node draws nothing, and
    // dropping the stamp is what made the reappear frame render at scale 1 — see
    // ViewScaleStampIndexTests.StampSurvivesTransientInvisible). This registry is the opposite case: it draws nothing
    // and is consulted for EVERY pointer, so an invisible stamp silently claims coordinates. A closed map screen
    // behind a combat room kept remapping pointers that crossed the MapLegend's 1.2 band — measured on the web twin
    // as a 66.7 design-px cursor jump at 1920x1080 and 67.6 at 2520x1080 (scripts/probe-targeting-drag-jump.mjs).
    // Web twin: the ancestorChainHidden gate in mirrorRenderer.buildViewScaleInputStamps + its
    // "effective visibility" describe in frontend/src/mirror/__tests__/viewScaleInputRegistry.spec.ts.
    private static void HiddenAncestorStampIsNotPublished()
    {
        var (state, t, sp, group) = ZScene();
        Check.That(Build(state, t, sp, new[] { group }, Set("group")).Count == 1,
            "[registry] the visible stamp is published (baseline)");

        // Hide the SCREEN the way the game does: the ancestor's flag drops, the stamped node's own stays true.
        state.Nodes["root"].Visible = false;
        Check.That(state.Nodes["group"].Visible, "[registry] the stamped node's OWN flag is still true");
        Check.That(Build(state, t, sp, new[] { group }, Set("group")).Count == 0,
            "[registry] a stamp under a HIDDEN ancestor publishes nothing (it would claim pointers invisibly)");

        // Re-opening the screen re-publishes on the very next build — there is no memory to go stale.
        state.Nodes["root"].Visible = true;
        Check.That(Build(state, t, sp, new[] { group }, Set("group")).Count == 1,
            "[registry] re-published as soon as the ancestor is visible again");

        // The node's OWN flag counts too, and so does a stamp whose node has left the state entirely.
        state.Nodes["group"].Visible = false;
        Check.That(Build(state, t, sp, new[] { group }, Set("group")).Count == 0,
            "[registry] a stamp whose own node is invisible publishes nothing either");
        state.Nodes.Remove("group");
        Check.That(Build(state, t, sp, new[] { group }, Set("group")).Count == 0,
            "[registry] a stamp for a node no longer in the state publishes nothing");
    }

    // A full-viewport GROUP under a chain of full-viewport mouse-visible ANCESTORS drops every ancestor.
    // A second, SMALL non-enclosing non-stage-band ancestor isolates rule 1 (only the ancestor rule can drop it).
    private static void AncestorRectsAreNotNeighbors()
    {
        // Realistic shape: Game (full) → Screen (full group). Both mouse-visible.
        var (state, t, sp) = Scene(
            Ctrl("game", null, 0, 0, W, H),
            Ctrl("screen", "game", 0, 0, W, H));
        var group = Group("screen", 0, 0, W, H, ViewScale.CardRewardGroupScale, noClamp: true);

        var registry = Build(state, t, sp, new[] { group }, Set("screen"));
        Check.That(Neighbors(registry).Count == 0, "[registry] full-viewport ancestor is not a group neighbour");

        // Isolate rule 1: a SMALL ancestor (200×200) that neither encloses the group nor spans the stage — only the
        // ancestor rule can exclude it.
        var (s2, t2, sp2) = Scene(
            Ctrl("small", null, 0, 0, 200, 200),      // small ancestor
            Ctrl("scr2", "small", 0, 0, W, H));       // group overflows its parent
        var g2 = Group("scr2", 0, 0, W, H, ViewScale.CardRewardGroupScale, noClamp: true);
        Check.That(ViewScaleInputRegistry.IsStrictAncestor(s2, "small", "scr2"), "[registry] small is a strict ancestor of scr2");
        Check.That(!ViewScaleInputRegistry.EnclosesDesignBox(new DesignAabb(0, 0, 200, 200), new DesignAabb(0, 0, W, H)),
            "[registry] the small ancestor does NOT enclose the full-viewport group");
        Check.That(!ViewScaleInputRegistry.IsStageBand(new DesignAabb(0, 0, 200, 200), W), "[registry] small ancestor is not a stage band");
        var registry2 = Build(s2, t2, sp2, new[] { g2 }, Set("scr2"));
        Check.That(Neighbors(registry2).Count == 0, "[registry] small ancestor dropped by the ancestor rule alone");
    }

    // A SIBLING backdrop (not an ancestor) that encloses the group's PRE-scale DesignBox but is smaller than the stage
    // (rule 2 in isolation). It also does NOT enclose the larger ScaledBox — proving the enclosure test uses DesignBox.
    private static void EnclosingBackdropIsNotNeighbor()
    {
        var groupBox = new DesignAabb(400, 300, 1520, 780);          // 1120×480, centred
        var groupStamp = ViewScaleInputRegistry.ScaledBox(
            groupBox, HoverTipScaleMath.ComputeAnchoredStamp(groupBox, 1.10, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value);
        // Backdrop encloses the DesignBox (±) but sits INSIDE the scaled box — a ScaledBox test would miss it.
        var backdrop = new DesignAabb(395, 295, 1525, 785);
        Check.That(ViewScaleInputRegistry.EnclosesDesignBox(backdrop, groupBox), "[registry] backdrop encloses the pre-scale DesignBox");
        Check.That(!ViewScaleInputRegistry.EnclosesDesignBox(backdrop, groupStamp), "[registry] backdrop does NOT enclose the larger ScaledBox");
        Check.That(backdrop.MaxX - backdrop.MinX < ViewScaleInputRegistry.StageBandFraction * W, "[registry] backdrop is narrower than a stage band");

        var (state, t, sp) = Scene(
            Ctrl("root", null, 0, 0, W, H, mouseFilter: 2),          // non-interactive root (ignored)
            Ctrl("backdrop", "root", 395, 295, 1130, 490),           // sibling backdrop, interactive
            Ctrl("group", "root", 400, 300, 1120, 480));             // the group (sibling of backdrop)
        var g = Group("group", 400, 300, 1120, 480, 1.10, noClamp: true);

        var registry = Build(state, t, sp, new[] { g }, Set("group"));
        Check.That(Neighbors(registry).Count == 0, "[registry] enclosing backdrop is dropped");
    }

    // A full-WIDTH but short bar crossing the group's scaled box (rule 3 in isolation — not an ancestor, does not
    // enclose the tall group).
    private static void StageBandIsNotNeighbor()
    {
        var (state, t, sp) = Scene(
            Ctrl("root", null, 0, 0, W, H, mouseFilter: 2),
            Ctrl("bar", "root", 0, 500, W, 100),                     // full-width band y[500,600]
            Ctrl("widget", "root", 700, 450, 520, 250));             // a central widget group
        var g = Group("widget", 700, 450, 520, 250, 1.10, noClamp: false);
        Check.That(ViewScaleInputRegistry.IsStageBand(new DesignAabb(0, 500, W, 600), W), "[registry] the bar is a stage band");
        Check.That(!ViewScaleInputRegistry.EnclosesDesignBox(new DesignAabb(0, 500, W, 600), new DesignAabb(700, 450, 1220, 700)),
            "[registry] the short bar does NOT enclose the group");

        var registry = Build(state, t, sp, new[] { g }, Set("widget"));
        Check.That(Neighbors(registry).Count == 0, "[registry] full-width bar is dropped");
    }

    // Z-rule (GROUP only): a small sibling painted BELOW the group root (earlier in OrderedIds) is invisible under the
    // group → dropped. Paired with OverlayAboveGroupIsNeighbor over the SAME scene. WEB LOCKSTEP (R9/WS-A): the same
    // underlay/overlay/floor/map-legend truth table runs against the web builder in
    // frontend/src/mirror/__tests__/viewScaleInputRegistry.spec.ts — change one, change both.
    private static void UnderlayBelowGroupIsNotNeighbor()
    {
        var (state, t, sp, group) = ZScene();
        Check.That(ViewScaleInputRegistry.IsPaintedUnderGroup(state, Set("group"), "group", "underlay"),
            "[registry] the underlay paints below the group root");
        var registry = Build(state, t, sp, new[] { group }, Set("group"));
        Check.That(!ContainsBox(Neighbors(registry), UnderlayBox), "[registry] Z-rule drops the underlay");
    }

    private static void OverlayAboveGroupIsNeighbor()
    {
        var (state, t, sp, group) = ZScene();
        Check.That(!ViewScaleInputRegistry.IsPaintedUnderGroup(state, Set("group"), "group", "overlay"),
            "[registry] the overlay paints above the group root");
        var on = Build(state, t, sp, new[] { group }, Set("group"));
        Check.That(ContainsBox(Neighbors(on), OverlayBox), "[registry] Z-rule keeps the overlay");
    }

    // For an ITEM stamp (not a group), a sibling in the halo band survives the filter when it paints ABOVE the item
    // (it is not an ancestor, does not enclose the item, and is not a stage band), so its tap stays exempt. R19 WP-6d
    // gave item stamps a paint floor of their OWN index, so the same sibling painted BELOW the item is now DROPPED —
    // an item's halo is the pixels it paints OVER, and a rect it paints over cannot be what the finger is on. Both
    // legs are asserted here.
    private static void ItemHaloSiblingSurvivesFilter()
    {
        // The item box [100,100,200,200] scaled 1.5 about (150,150) → ScaledBox [75,75,225,225]. The sibling sits in
        // the RIGHT halo band (x 210..260 overlaps the ScaledBox out to 225, outside the item's own 100..200 face).
        var siblingBox = new DesignAabb(210, 140, 260, 160);
        var itemBox = new DesignAabb(100, 100, 200, 200);
        var stamp = HoverTipScaleMath.ComputeCenterStamp(itemBox, 1.5, W, H)!.Value;
        ViewScaleInputRegistry.Applied Item() =>
            new("item", stamp, itemBox, ViewScaleInputRegistry.ScaledBox(itemBox, stamp), IsGroup: false);

        // (a) painted ABOVE the item (a legitimate overlay) → survives.
        var (aState, aT, aSp) = Scene(
            Ctrl("root", null, 0, 0, W, H, mouseFilter: 2),
            Ctrl("item", "root", 100, 100, 100, 100),                // the item (paint FIRST)
            Ctrl("sibling", "root", 210, 140, 50, 20));              // right halo band, painted after → above
        Check.That(ContainsBox(Neighbors(Build(aState, aT, aSp, new[] { Item() }, Set("item"))), siblingBox),
            "[registry] an item's halo sibling painted ABOVE the item survives the filter");

        // (b) painted BELOW the item → dropped by the R19 item paint floor (WP-6d: the dead "Show upgrade" tickbox).
        var (bState, bT, bSp) = Scene(
            Ctrl("root", null, 0, 0, W, H, mouseFilter: 2),
            Ctrl("sibling", "root", 210, 140, 50, 20),               // right halo band, painted first (below the item)
            Ctrl("item", "root", 100, 100, 100, 100));               // the item (paint AFTER the sibling)
        Check.That(!ContainsBox(Neighbors(Build(bState, bT, bSp, new[] { Item() }, Set("item"))), siblingBox),
            "[registry] the item Z-rule drops a halo sibling the item paints OVER");

    }


    // A full-viewport NoClamp GROUP: a pointer at the very TOP edge (960,0) sits inside the OVER-SIZE ScaledBox
    // [-96,-54,2016,1134] and must inverse-remap to the true y≈49.1 — pinning that we KEEP the ScaledBox for
    // containment (the pointer is viewport-clamped, so an oversize NoClamp box is harmless).
    private static void FullViewportNoClampEdgeRemap()
    {
        var (state, t, sp) = Scene(Ctrl("screen", null, 0, 0, W, H));
        var group = Group("screen", 0, 0, W, H, ViewScale.CardRewardGroupScale, noClamp: true);
        var reg = Build(state, t, sp, new[] { group }, Set("screen"));
        Check.That(Neighbors(reg).Count == 0, "[registry] a bare full-viewport group has no neighbours");

        var (x, y) = ViewScaleInput.Remap(960, 0, reg);
        Check.Close(x, 960, "[registry] top-edge x is the pivot (fixed point)");
        // y = 540 + (0 - 540)/1.10 = 49.09…
        Check.That(Math.Abs(y - 49.09) < 0.1, "[registry] top-edge y remaps to the true ≈49.1 (ScaledBox kept)");
    }

    // A card-reward card receives the visual product GROUP ∘ CARD (1.10 × 1.15). Publishing only the group used to
    // leave the card's outer 1.15 border outside its input claim; publishing both but applying independent inverses
    // would double-remap. The registry instead publishes one precomposed channel per node in paint order.
    private static void NestedRewardCardsUseComposedChannels()
    {
        var (state, t, sp) = Scene(
            Ctrl("screen", null, 0, 0, W, H, mouseFilter: 2),
            Ctrl("cardA", "screen", 600, 300, 200, 200, mouseFilter: 2),
            Ctrl("cardB", "screen", 700, 300, 200, 200, mouseFilter: 2),
            Ctrl("overlay", null, 625, 325, 20, 20));
        var group = Group("screen", 0, 0, W, H, 1.10, noClamp: true);
        var cardA = Item("cardA", 600, 300, 200, 200, 1.15);
        var cardB = Item("cardB", 700, 300, 200, 200, 1.15);
        var reg = Build(state, t, sp, new[] { group, cardA, cardB }, Set("screen", "cardA", "cardB"));

        Check.That(reg.Count == 3, "[registry compose] group and both nested cards all publish in paint order");
        Check.Close(reg[1].Channel.Scale, 1.10 * 1.15, "[registry compose] card A channel is group∘card scale");
        Check.Close(reg[2].Channel.Scale, 1.10 * 1.15, "[registry compose] card B channel is group∘card scale");

        // The group moves the card's unscaled face toward screen centre before its own card scale is considered.
        var own = reg[1].OwnUnscaledBox!.Value;
        Check.Close(own.MinX, 564, "[registry compose] own-unscaled card A left carries group scale");
        Check.Close(own.MaxX, 784, "[registry compose] own-unscaled card A right carries group scale");

        // A point in A's outer card border is also in the group. The card (painted later) owns it and the single
        // composed inverse lands back on A's true face; group-only inverse would miss that face.
        const double ax = 560, ay = 370;
        Check.That(Contains(reg[1].ScaledBox, ax, ay) && Contains(reg[0].ScaledBox, ax, ay),
            "[registry compose] A border lies in both the card and group scaled boxes");
        var remappedA = ViewScaleInput.Remap(ax, ay, reg);
        var cardOnlyA = ViewScale.InverseMapPoint(reg[1].Channel, ax, ay);
        var groupOnlyA = ViewScale.InverseMapPoint(reg[0].Channel, ax, ay);
        Check.Close(remappedA.X, cardOnlyA.X, "[registry compose] card border uses composed card inverse");
        Check.That(Math.Abs(remappedA.X - groupOnlyA.X) > 1,
            "[registry compose] card border does not fall back to the group-only inverse");

        // Cards overlap at x=750. Paint-order-last B must claim that point, not A or the group.
        const double overlapX = 750, overlapY = 400;
        Check.That(Contains(reg[1].ScaledBox, overlapX, overlapY) && Contains(reg[2].ScaledBox, overlapX, overlapY),
            "[registry compose] overlapping cards both cover the ownership point");
        var remappedOverlap = ViewScaleInput.Remap(overlapX, overlapY, reg);
        var cardBExpected = ViewScale.InverseMapPoint(reg[2].Channel, overlapX, overlapY);
        Check.Close(remappedOverlap.X, cardBExpected.X, "[registry compose] later-painted card B wins overlap ownership");

        // Outside either card, the parent remains a useful claim for the scaled group.
        const double groupOnlyX = 40, groupOnlyY = 540;
        Check.That(Contains(reg[0].ScaledBox, groupOnlyX, groupOnlyY)
            && !Contains(reg[1].ScaledBox, groupOnlyX, groupOnlyY)
            && !Contains(reg[2].ScaledBox, groupOnlyX, groupOnlyY),
            "[registry compose] group-only point is outside all cards");
        var remappedGroup = ViewScaleInput.Remap(groupOnlyX, groupOnlyY, reg);
        var groupExpected = ViewScale.InverseMapPoint(reg[0].Channel, groupOnlyX, groupOnlyY);
        Check.Close(remappedGroup.X, groupExpected.X, "[registry compose] group owns its outer-only point");

        // Widened-design leg: the card's raw box is shifted +100 while its enclosing group remains centred. The
        // product must be built before any game-space re-expression; its raw left edge is 657.5, whereas dropping
        // the enclosing `(1.10 - 1) * 100` contribution would place it 10px left.
        var wideCardBox = new DesignAabb(700, 340, 900, 380);
        var wideCardStamp = HoverTipScaleMath.ComputeAnchoredStamp(
            wideCardBox, 1.15, 2220, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;
        var wideGroupBox = new DesignAabb(0, 0, W, 800);
        var wideGroupStamp = HoverTipScaleMath.ComputeAnchoredStamp(
            wideGroupBox, 1.10, 2220, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;
        var wideGroup = new ViewScaleInputRegistry.Applied(
            "screen", wideGroupStamp, wideGroupBox, ViewScaleInputRegistry.ScaledBox(wideGroupBox, wideGroupStamp), IsGroup: true);
        var wideCard = new ViewScaleInputRegistry.Applied(
            "cardA", wideCardStamp, wideCardBox, ViewScaleInputRegistry.ScaledBox(wideCardBox, wideCardStamp), IsGroup: false);
        var wide = Build(state, t, sp, new[] { wideGroup, wideCard }, Set("screen", "cardA"));
        Check.Close(wide[1].ScaledBox.MinX, 657.5, "[registry compose] widened card retains group (k−1)·dx");
    }

    // ---- Z-rule scene shared by the underlay/overlay pair ----

    private static readonly DesignAabb UnderlayBox = new(720, 480, 800, 540);
    private static readonly DesignAabb OverlayBox = new(1000, 480, 1080, 540);

    private static (MirrorState, GlobalTransformIndex, SpreadIndex, ViewScaleInputRegistry.Applied) ZScene()
    {
        // Paint order: underlay (below) → group → overlay (above). All small, none ancestors/enclosing/stage-band.
        var (state, t, sp) = Scene(
            Ctrl("root", null, 0, 0, W, H, mouseFilter: 2),
            Ctrl("underlay", "root", 720, 480, 80, 60),
            Ctrl("group", "root", 700, 450, 520, 250),
            Ctrl("overlay", "root", 1000, 480, 80, 60));
        var group = Group("group", 700, 450, 520, 250, 1.10, noClamp: false);
        return (state, t, sp, group);
    }

    // ---- builders ----

    private static MirrorNode Ctrl(
        string id, string? parent, double x, double y, double w, double h, int? mouseFilter = 0) =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = "Control",
            Name = id,
            Visible = true,
            MouseFilter = mouseFilter,
            Transform = [1, 0, 0, 1, 0, 0],
            LocalRect = new MirrorRect(x, y, w, h),
        };

    private static (MirrorState, GlobalTransformIndex, SpreadIndex) Scene(params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var n in nodes)
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;
        var t = new GlobalTransformIndex();
        t.Update(state);
        var sp = new SpreadIndex();
        sp.Update(state, t, 1); // F=1 → no spread records
        return (state, t, sp);
    }

    private static ViewScaleInputRegistry.Applied Group(
        string id, double x, double y, double w, double h, double scale, bool noClamp)
    {
        var box = new DesignAabb(x, y, x + w, y + h);
        var stamp = HoverTipScaleMath.ComputeAnchoredStamp(box, scale, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: noClamp)!.Value;
        return new ViewScaleInputRegistry.Applied(id, stamp, box, ViewScaleInputRegistry.ScaledBox(box, stamp), IsGroup: true);
    }

    private static ViewScaleInputRegistry.Applied Item(string id, double x, double y, double w, double h, double scale)
    {
        var box = new DesignAabb(x, y, x + w, y + h);
        var stamp = HoverTipScaleMath.ComputeAnchoredStamp(box, scale, W, H, HoverTipScaleMath.AnchorPivot.Center, noClamp: true)!.Value;
        return new ViewScaleInputRegistry.Applied(id, stamp, box, ViewScaleInputRegistry.ScaledBox(box, stamp), IsGroup: false);
    }

    private static List<ViewScaleInput.Stamp> Build(
        MirrorState state, GlobalTransformIndex t, SpreadIndex sp,
        IReadOnlyList<ViewScaleInputRegistry.Applied> applied, IReadOnlySet<string> stamped) =>
        ViewScaleInputRegistry.Build(state, t, sp, applied, stamped, W);

    private static IReadOnlySet<string> Set(params string[] ids) => new HashSet<string>(ids, StringComparer.Ordinal);

    // Every scene in this suite publishes a single non-nested stamp, so the sole registry entry's neighbours ARE the
    // group's/item's neighbour list.
    private static IReadOnlyList<DesignAabb> Neighbors(IReadOnlyList<ViewScaleInput.Stamp> registry) =>
        registry.Count > 0 ? registry[0].NeighborRects : Array.Empty<DesignAabb>();

    private static bool ContainsBox(IReadOnlyList<DesignAabb> boxes, DesignAabb target) =>
        boxes.Any(b => Math.Abs(b.MinX - target.MinX) < 0.5 && Math.Abs(b.MinY - target.MinY) < 0.5
                       && Math.Abs(b.MaxX - target.MaxX) < 0.5 && Math.Abs(b.MaxY - target.MaxY) < 0.5);

    private static bool Contains(DesignAabb box, double x, double y) =>
        x >= box.MinX && x <= box.MaxX && y >= box.MinY && y <= box.MaxY;
}
