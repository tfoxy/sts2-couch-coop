using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// R8 (WS-2) truth table for the PURE per-drain view-scale stamp index (ViewScaleStampIndex.Build) — the replacement
// for the stateful native ViewScaler pass whose per-drain "drop to scale 1" branches were the event-option scale
// flicker (reported after R4, R6 and R7 each patched one of them with a carry).
//
// The load-bearing properties this file pins are the ones the old design could not state:
//   * a node either resolves a stamp from THIS DRAIN'S wire state or it does not — there is no memory to carry and
//     none to drop (NoCrossDrainMemory);
//   * transient conditions that used to DROP the stamp (a momentarily invisible container, a degenerate own rect)
//     no longer do (StampSurvivesTransientInvisible / DegenerateGroupRectFallsBackToUnion);
//   * the design→parent conversion goes through the WIRE parent global, so a NESTED stamp is unaffected by its
//     stamped ancestor and a StaticBake clone (whose Godot parent chain is a throwaway viewport tree) folds the same
//     numbers as the live view (ParentFrameUsesWireParent / NestedStampIgnoresAncestorStamp);
//   * the two REAL rejects survive: the P4 parked-off-stage guard (unless a tween endpoint lands on-screen) and the
//     clip-ancestor containment rule.
internal static class ViewScaleStampIndexTests
{
    private const double W = 1920, H = 1080;
    private const string AncientEventLayout = "res://scenes/events/ancient_event_layout.tscn";
    private const string MerchantInventory = "res://scenes/merchant/merchant_inventory.tscn";

    public static void Run()
    {
        EmptyOffViewScaleScreen();
        AncientOptionsStampsBottomCenter();
        NoCrossDrainMemory();
        StampSurvivesTransientInvisible();
        DegenerateGroupRectFallsBackToUnion();
        ParentFrameUsesWireParent();
        NestedStampIgnoresAncestorStamp();
        ParkedOffStageGroupIsRejected();
        ParkedGroupStampsAtTweenEndpoint();
        TweenEndpointIsTheEffectiveBox();
        ClipAncestorRejectsEscapingBox();
        BakeExclusionCoversSubtree();
    }

    // The cheap presence gate: no view-scale scene file anywhere ⇒ an EMPTY index (combat pays one dictionary walk
    // and every MirrorNodeView fold stays on its byte-identical early-out).
    private static void EmptyOffViewScaleScreen()
    {
        var (state, t, sp) = Scene(
            Node("root", null, "Combat", file: "res://scenes/combat/combat_scene.tscn", rect: (0, 0, W, H)),
            Node("card", "root", "NCard", rect: (100, 100, 200, 300)));
        Check.Equal(ViewScaleStampIndex.Build(state, t, sp, W, H).Count, 0,
            "[stamp-index] no view-scale scene ⇒ empty index");
        Check.That(!ViewScaleStampIndex.AnyViewScaleScenePresent(state), "[stamp-index] presence gate is false in combat");
    }

    // The ancient-event OptionsContainer: 1.2× GROUP pinned at its BOTTOM (grows UP so it never collides with the
    // play area below), horizontal centre pivot, no clamp needed at this size.
    private static void AncientOptionsStampsBottomCenter()
    {
        var (state, t, sp) = AncientScene();
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        Check.That(index.TryGetValue("options", out var s), "[stamp-index] ancient OptionsContainer is stamped");
        Check.Close(s.Design.Scale, ViewScale.EventOptionsScale, "[stamp-index] ancient options → 1.2×");
        Check.That(s.IsGroup, "[stamp-index] ancient options stamps as a GROUP");
        Check.Close(s.DesignBox.MinX, 460, "[stamp-index] design box left");
        Check.Close(s.DesignBox.MaxY, 992, "[stamp-index] design box bottom");
        Check.Close(s.Design.PivotY, 992, "[stamp-index] BottomCenter pivots at the box BOTTOM");
        Check.Close(s.Design.PivotX, 960, "[stamp-index] pivot X is the box centre");
        Check.Close(s.ScaledBox.MinY, 992 - (1.2 * 292), "[stamp-index] the enlarged box grows UPWARD only");
        Check.Close(s.ScaledBox.MaxY, 992, "[stamp-index] the enlarged box keeps its bottom pinned");

        // The ancient DIALOGUE lift is a TRANSLATE-ONLY entry (scale 1) and must still produce a stamp — the clamp
        // channel carries it. A scale-only index would silently drop it.
        Check.That(index.TryGetValue("dialogue", out var d), "[stamp-index] the ancient dialogue lift is stamped");
        Check.Close(d.Design.Scale, 1.0, "[stamp-index] dialogue entry is translate-only (scale 1)");
        Check.Close(d.Design.ClampY, ViewScale.AncientDialogueTranslateY, "[stamp-index] dialogue lifts by the table's translateY");
        Check.Close(d.ClampY, ViewScale.AncientDialogueTranslateY, "[stamp-index] the parent-frame clamp carries the lift too");
    }

    // THE structural property. Build is a pure function of the state handed in: removing the screen empties the
    // index, and re-adding it re-stamps — nothing is remembered between calls, so there is no stamp to "carry" and,
    // crucially, none to DROP. (The old pass kept LastStamped/LastApplied and un-stamped from them; every gate that
    // failed to re-stamp therefore reset a correct scale to 1 for a frame.)
    private static void NoCrossDrainMemory()
    {
        var (state, t, sp) = AncientScene();
        Check.Equal(ViewScaleStampIndex.Build(state, t, sp, W, H).Count, 2, "[stamp-index] drain 1 stamps options + dialogue");

        // Drain 2: the screen closed (nodes gone).
        var (empty, t2, sp2) = Scene(Node("root", null, "Combat", file: "res://scenes/combat/combat_scene.tscn", rect: (0, 0, W, H)));
        Check.Equal(ViewScaleStampIndex.Build(empty, t2, sp2, W, H).Count, 0, "[stamp-index] drain 2 (screen gone) stamps nothing");

        // Drain 3: the screen is back — an identical index, with no dependence on drain 1 or 2.
        var (state3, t3, sp3) = AncientScene();
        var a = ViewScaleStampIndex.Build(state3, t3, sp3, W, H);
        var b = ViewScaleStampIndex.Build(state3, t3, sp3, W, H);
        Check.Equal(a.Count, 2, "[stamp-index] drain 3 re-stamps from scratch");
        Check.That(a["options"] == b["options"], "[stamp-index] repeated builds are identical (pure)");
    }

    // A drain in which the container (or an ancestor) is momentarily NOT visible must still resolve a stamp. The old
    // pass gated on EffectivelyVisible and DROPPED the stamp, so the frame the container came back it rendered at
    // scale 1 — the snap-back. An invisible node draws nothing, so stamping it is free and strictly safer.
    private static void StampSurvivesTransientInvisible()
    {
        var (state, t, sp) = AncientScene();
        state.Nodes["content"] = With(state.Nodes["content"], visible: false);
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        Check.That(index.ContainsKey("options"),
            "[stamp-index] a transiently INVISIBLE ancestor no longer drops the stamp (no snap-back on reappear)");
    }

    // A GROUP whose own rect is momentarily degenerate (0×0 during a layout pass) falls back to the union of its
    // paint-bearing subtree instead of dropping the stamp — the exact transient round-7's ViewScaleGroupCarry existed
    // to paper over.
    private static void DegenerateGroupRectFallsBackToUnion()
    {
        var (state, t, sp) = AncientScene();
        state.Nodes["options"] = With(state.Nodes["options"], rect: (0, 0, 0, 0));
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        Check.That(index.TryGetValue("options", out var s), "[stamp-index] a degenerate GROUP rect falls back to the subtree union");
        // The union of the two option rows (local origins (20,10) and (20,150), 960×120, under a container translated
        // to (460,700)) — a real box, so a real 1.2 stamp.
        Check.Close(s.Design.Scale, ViewScale.EventOptionsScale, "[stamp-index] the union stamp is still 1.2×");
        Check.Close(s.DesignBox.MinX, 480, "[stamp-index] union left edge = the option rows");
        Check.Close(s.DesignBox.MaxY, 970, "[stamp-index] union bottom edge = the last option row");
    }

    // The design→parent conversion goes through the parent's WIRE global (plus the PARENT's own spread Dx), which is
    // exactly the frame MirrorNodeView.FoldCosmetic works in. With a parent translated by (300, 200) the parent-frame
    // pivot is the design pivot minus that translation.
    private static void ParentFrameUsesWireParent()
    {
        var (state, t, sp) = AncientScene(contentOrigin: (300, 200));
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        Check.That(index.TryGetValue("options", out var s), "[stamp-index] stamped under a translated parent");
        Check.Close(s.PivotX, s.Design.PivotX - 300, "[stamp-index] parent-frame pivot X = design pivot − parent origin X");
        Check.Close(s.PivotY, s.Design.PivotY - 200, "[stamp-index] parent-frame pivot Y = design pivot − parent origin Y");
        Check.Close(s.ClampX, s.Design.ClampX, "[stamp-index] a pure-translation parent leaves the clamp unrotated");
    }

    // A stamp nested UNDER another stamped node (the card-reward 1.10 group ∘ per-card 1.15) converts through the
    // WIRE parent global, so its parent-frame numbers do NOT depend on the ancestor's stamp. This is what makes the
    // composition group(card(box)) come out right on both clients — and what makes a StaticBake clone, whose Godot
    // parent chain is a throwaway SubViewport tree rather than the live one, fold the identical matrix.
    private static void NestedStampIgnoresAncestorStamp()
    {
        // shop: SlotsContainer (a GROUP) with a draw_pile.tscn button inside it (an ITEM entry) — both stamped.
        var (state, t, sp) = Scene(
            Node("shop", null, "NMerchantInventory", file: MerchantInventory, name: "MerchantInventory", rect: (0, 0, W, H)),
            Node("slots", "shop", "Control", name: "SlotsContainer", rect: (0, 0, 1000, 400), origin: (400, 300)),
            Node("row", "slots", "NDrawPileButton", file: "res://scenes/combat/draw_pile.tscn", name: "DrawPile",
                rect: (0, 0, 400, 90), origin: (50, 50), texture: "res://x.png"));

        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        Check.That(index.ContainsKey("slots"), "[stamp-index] the shop SlotsContainer GROUP is stamped");
        Check.That(index.TryGetValue("row", out var row), "[stamp-index] the nested reward row is stamped too");

        // The row's parent (`slots`) sits at design (400,300) with an identity basis, so the parent-frame pivot is the
        // design pivot shifted by that — INDEPENDENT of the 1.2 group stamp applied to `slots`.
        Check.Close(row.PivotX, row.Design.PivotX - 400, "[stamp-index] nested pivot X uses the WIRE parent origin");
        Check.Close(row.PivotY, row.Design.PivotY - 300, "[stamp-index] nested pivot Y uses the WIRE parent origin");
    }

    // P4 closed-shop phantom guard: a group PARKED entirely off-stage (Visible, but at y≈−1000) must NOT be stamped —
    // the on-screen clamp would otherwise drag the whole rug + empty slots back into view.
    private static void ParkedOffStageGroupIsRejected()
    {
        var (state, t, sp) = ParkedShop();
        Check.That(!ViewScaleStampIndex.Build(state, t, sp, W, H).ContainsKey("slots"),
            "[stamp-index] a parked off-stage GROUP is NOT stamped (the closed-shop phantom guard)");
    }

    // …unless a transform tween's ENDPOINT lands on-screen (the shop OPEN slide): measure there so the whole slide
    // renders scaled. A close-slide's endpoint is off-stage too, so the guard above still holds for it.
    private static void ParkedGroupStampsAtTweenEndpoint()
    {
        var (state, t, sp) = ParkedShop();
        var onScreenEndpoint = new Dictionary<string, IReadOnlyList<double>>(StringComparer.Ordinal)
        {
            ["slots"] = new double[] { 1, 0, 0, 1, 400, 300 },
        };
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H, onScreenEndpoint);
        Check.That(index.TryGetValue("slots", out var s), "[stamp-index] a parked group with an ON-SCREEN tween endpoint IS stamped");
        Check.Close(s.DesignBox.MinY, 300, "[stamp-index] it is measured at the tween ENDPOINT, not the parked position");

        var offScreenEndpoint = new Dictionary<string, IReadOnlyList<double>>(StringComparer.Ordinal)
        {
            ["slots"] = new double[] { 1, 0, 0, 1, 400, -1400 },
        };
        Check.That(!ViewScaleStampIndex.Build(state, t, sp, W, H, offScreenEndpoint).ContainsKey("slots"),
            "[stamp-index] a CLOSE slide (endpoint also off-stage) still never stamps");
    }

    // WS6 — the SHOP CLOSE defect. The producer suppresses per-frame transforms for a tween's window, so during the
    // close slide the STREAMED box still holds the OPEN (on-stage) position while the consumer already folds the
    // CLOSED (off-stage) endpoint as the node's transform. Measuring the streamed box then computed a stamp for the
    // open position and composed it onto the closed transform — dragging the panel's bottom edge back into view at
    // the top of the screen. The endpoint is now the EFFECTIVE box whenever a tween owns the group, so the shared
    // off-stage guard rejects the close slide, and a group tweening BETWEEN two on-stage positions is measured at the
    // position it is actually being composed onto.
    private static void TweenEndpointIsTheEffectiveBox()
    {
        var (state, t, sp) = OpenShop();
        Check.That(ViewScaleStampIndex.Build(state, t, sp, W, H).ContainsKey("slots"),
            "[stamp-index] the OPEN shop (no tween) is stamped from its streamed box");

        var closing = new Dictionary<string, IReadOnlyList<double>>(StringComparer.Ordinal)
        {
            ["slots"] = new double[] { 1, 0, 0, 1, 400, -1400 }, // the CLOSED endpoint, wholly off-stage
        };
        Check.That(!ViewScaleStampIndex.Build(state, t, sp, W, H, closing).ContainsKey("slots"),
            "[stamp-index] a CLOSE slide is NOT stamped even though its STREAMED box is still on-stage");

        var moving = new Dictionary<string, IReadOnlyList<double>>(StringComparer.Ordinal)
        {
            ["slots"] = new double[] { 1, 0, 0, 1, 400, 500 },
        };
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H, moving);
        Check.That(index.TryGetValue("slots", out var s), "[stamp-index] an on-stage→on-stage slide is still stamped");
        Check.Close(s.DesignBox.MinY, 500, "[stamp-index] it is measured at the ENDPOINT (500), not the streamed box (300)");
    }

    // The ENLARGED box must stay inside every clip-children ancestor (a scaled item must not spill past a scroll/mask
    // edge). This reject is a pure function of the wire state, so it can never oscillate on an idle screen.
    private static void ClipAncestorRejectsEscapingBox()
    {
        var (state, t, sp) = AncientScene();
        // Make Content a tight clip box exactly around the options — the 1.2 enlargement then escapes it.
        state.Nodes["content"] = With(state.Nodes["content"], rect: (460, 700, 1000, 292), clipChildren: 1);
        Check.That(!ViewScaleStampIndex.Build(state, t, sp, W, H).ContainsKey("options"),
            "[stamp-index] an enlargement that escapes a clip ancestor is rejected");

        // A roomy clip ancestor keeps the stamp.
        state.Nodes["content"] = With(state.Nodes["content"], rect: (0, 0, W, H), clipChildren: 1);
        Check.That(ViewScaleStampIndex.Build(state, t, sp, W, H).ContainsKey("options"),
            "[stamp-index] a roomy clip ancestor does not reject the stamp");
    }

    // BELT: a view-scaled node AND its whole subtree stay out of the static bake, so a pre-composited quad can never
    // own the pixels of a cosmetically-scaled surface.
    private static void BakeExclusionCoversSubtree()
    {
        var (state, t, sp) = AncientScene();
        var index = ViewScaleStampIndex.Build(state, t, sp, W, H);
        var excluded = new HashSet<string>(StringComparer.Ordinal);
        ViewScaleStampIndex.CollectBakeExcluded(state, index, excluded);
        Check.That(excluded.Contains("options"), "[stamp-index] the stamped node is bake-excluded");
        Check.That(excluded.Contains("opt1") && excluded.Contains("opt2"), "[stamp-index] its descendants are bake-excluded");
        Check.That(!excluded.Contains("root"), "[stamp-index] an un-stamped ancestor is NOT bake-excluded");

        var none = new HashSet<string>(StringComparer.Ordinal);
        ViewScaleStampIndex.CollectBakeExcluded(state, ViewScaleStampIndex.Empty, none);
        Check.Equal(none.Count, 0, "[stamp-index] an empty index excludes nothing (combat pays nothing)");
    }

    // ---- scenes ----

    // The ancient-event layout shape verified from audit-mprun.ndjson: layout root → ContentContainer → Content →
    // {DialogueContainer, OptionsContainer → two option rows}. `contentOrigin` translates the OptionsContainer's
    // PARENT so the parent-frame conversion can be checked against a known offset.
    private static (MirrorState, GlobalTransformIndex, SpreadIndex) AncientScene((double X, double Y)? contentOrigin = null)
    {
        var (cx, cy) = contentOrigin ?? (0, 0);
        return Scene(
            Node("root", null, "NAncientEventLayout", file: AncientEventLayout, name: "AncientEventLayout", rect: (0, 0, W, H)),
            Node("cc", "root", "Control", name: "ContentContainer", rect: (0, 0, W, H)),
            Node("content", "cc", "Control", name: "Content", rect: (0, 0, W, H), origin: (cx, cy)),
            Node("dialogue", "content", "Control", name: "DialogueContainer", rect: (0, 0, 800, 200), origin: (560 - cx, 400 - cy)),
            Node("options", "content", "Control", name: "OptionsContainer", rect: (0, 0, 1000, 292), origin: (460 - cx, 700 - cy)),
            Node("opt1", "options", "NEventOptionButton", name: "Option1", rect: (0, 0, 960, 120), origin: (20, 10), texture: "res://opt.png"),
            Node("opt2", "options", "NEventOptionButton", name: "Option2", rect: (0, 0, 960, 120), origin: (20, 150), texture: "res://opt.png"));
    }

    // The CLOSED shop: SlotsContainer is Visible but parked at y ≈ −1000 (the P4 phantom shape).
    private static (MirrorState, GlobalTransformIndex, SpreadIndex) ParkedShop() => Scene(
        Node("shop", null, "NMerchantInventory", file: MerchantInventory, name: "MerchantInventory", rect: (0, 0, W, H)),
        Node("slots", "shop", "Control", name: "SlotsContainer", rect: (0, 0, 1000, 400), origin: (400, -1400)));

    // The OPEN shop: the same SlotsContainer settled on-stage (WS6 — the close slide starts from HERE).
    private static (MirrorState, GlobalTransformIndex, SpreadIndex) OpenShop() => Scene(
        Node("shop", null, "NMerchantInventory", file: MerchantInventory, name: "MerchantInventory", rect: (0, 0, W, H)),
        Node("slots", "shop", "Control", name: "SlotsContainer", rect: (0, 0, 1000, 400), origin: (400, 300)));

    // ---- builders ----

    private static MirrorNode Node(
        string id, string? parent, string nodeType, string? file = null, string? name = null,
        (double X, double Y, double W, double H)? rect = null, (double X, double Y)? origin = null,
        string? texture = null) =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = nodeType,
            Name = name ?? id,
            SceneFilePath = file,
            Visible = true,
            Transform = [1, 0, 0, 1, origin?.X ?? 0, origin?.Y ?? 0],
            LocalRect = rect is { } r ? new MirrorRect(r.X, r.Y, r.W, r.H) : null,
            TextureUrl = texture,
        };

    private static MirrorNode With(
        MirrorNode node, bool? visible = null, (double X, double Y, double W, double H)? rect = null,
        int? clipChildren = null) =>
        new()
        {
            Id = node.Id,
            ParentId = node.ParentId,
            NodeType = node.NodeType,
            Name = node.Name,
            SceneFilePath = node.SceneFilePath,
            Visible = visible ?? node.Visible,
            Transform = node.Transform,
            LocalRect = rect is { } r ? new MirrorRect(r.X, r.Y, r.W, r.H) : node.LocalRect,
            TextureUrl = node.TextureUrl,
            ClipChildren = clipChildren ?? node.ClipChildren,
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
}
