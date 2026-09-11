using System.Text.RegularExpressions;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// The native replacement for the browser's `document.elementsFromPoint` touch scan (frontend
// inputCapture.ts `touchTargetsAt` + mirrorRenderer.ts `computeTouchInfo`). Because the native client hit-tests
// against the retained MirrorState + global transforms (no DOM), this walks the scene tree directly:
//   * <see cref="TargetsAt"/> emulates the z-stack scan — topmost-first DISTINCT hover-first widget ids under a
//     design-space point, truncated at the first blocking button (the block id is NOT included).
//   * <see cref="ComputeTouchInfo"/> is the per-node classification walk (echo/decorative/target/block), exposed
//     for tests + WS-M debug dumps.
//
// This maps to GestureCallbacks.TargetsAt / GestureCallbacks.IsCard after WS-M curries the live state + transforms.
public static class TouchTargetScan
{
    // Hover-first TOUCH target widget types (mirrorRenderer TOUCH_TARGET_TYPES). Keyed by the Godot type LEAF.
    private static readonly HashSet<string> TouchTargetTypes = new(StringComparer.Ordinal)
    {
        "NCard",
        "NEventOptionButton",
        "NRestSiteButton",
        "NMerchantRelic",
        "NMerchantPotion",
        // #9: shop carpet CARDS (NMerchantCard — on the merchant screen, and on the fake-merchant EVENT which
        // reuses the same inventory) and the TREASURE-room relic (NTreasureRoomRelicHolder). The relic behaves like
        // a button on screen but its leaf name doesn't end in "Button", so before this it fell to None → an
        // immediate click, no tap-to-focus arm. Extend from a live QA `dump` over each item if a leaf differs.
        "NMerchantCard",
        "NTreasureRoomRelicHolder",
        "NRewardButton",
        // R20: the shop's CARD REMOVAL SERVICE coin (NMerchantCardRemoval, from
        // res://scenes/merchant/merchant_card_removal.tscn, with an NClickableControl "Hitbox" child — the same shape
        // as every other shop slot). Neither leaf ends in "Button", so it was classified as neither a target nor a
        // block: ComputeTouchInfo answered None, and the gesture machine's "no target" guard runs BEFORE the
        // tap-to-focus check, so the setting was never consulted and one tap was one full click. Exactly the shape
        // NTreasureRoomRelicHolder had before it was listed here. NOT added to CardTouchTargetTypes below: that set
        // drives the non-hand long-press right-click, which opens an item's DETAIL dialog, and a service has none.
        "NMerchantCardRemoval",
    };

    // R8: the end-of-event "Proceed" option is displayed through the SAME reusable NEventOptionButton wrapper as a
    // regular option (so it isn't statically distinguishable by node-type leaf), but keeps the
    // res://scenes/ui/proceed_button.tscn (NProceedButton) SCENE IDENTITY — SceneIdentity.Resolve reads a node's own
    // SceneFilePath before any leaf-type check, so this tells the two apart even though both report the
    // "NEventOptionButton" leaf. Matched to a Block (see ComputeTouchInfo) so a tap on it presses IMMEDIATELY (no
    // arm-first double-tap) — the desktop click-through already presses it in one action. At least one event screen
    // mounts a proceed button alongside ordinary option buttons, so the two affordances co-exist on one screen and
    // the scene path is the only thing that separates them. Scene-file SUFFIX match (EndTurnScan-style; tolerant of
    // a path move). Established from the shipped scene files rather than from a live session; re-verify against a
    // live QA `dumptypes` capture at an event end-state if higher confidence is required.
    private const string ProceedButtonSceneFileSuffix = "proceed_button.tscn";
    private const string CardGridSelectionScreenType = "NCardGridSelectionScreen";
    // Concrete remove-a-card picker only. Do not broaden this to derived upgrade / transform / enchant /
    // simple selectors: those retain the ordinary arm-first card rule.
    private const string DeckCardSelectScreenType = "NDeckCardSelectScreen";
    private const string MultiplayerPlayerStateSceneFile = "res://scenes/ui/multiplayer_player_state.tscn";

    // HAND-card ancestor types (mirrorRenderer HAND_CARD_ANCESTOR_TYPES). Verified live combat ancestry:
    // NCard → NHandCardHolder → CardHolderContainer → Hand(NPlayerHand). Only a card under one of these gets the
    // peek/drag-lift/unselect card semantics; a deck-dialog / reward NCard is a plain node (see IsHandCard).
    private static readonly HashSet<string> HandCardAncestorTypes = new(StringComparer.Ordinal)
    {
        "NHandCardHolder",
        "NPlayerHand",
    };

    // mirrorRenderer ECHO_CONTAINER (case-sensitive) — a non-interactive card copy re-rendered on top of the real
    // one (previews / hover-tips / inspect popup). ANYWHERE in the ancestry ⇒ the widget carries no touch id.
    private static readonly Regex EchoContainer = new("Preview|HoverTip|Inspect", RegexOptions.CultureInvariant);

    // mirrorRenderer DECORATIVE_OVERLAY (case-insensitive) — an oversized flat-DOM effect that must not steal a
    // neighbour's tap. Matched on the node NAME or the type LEAF.
    private static readonly Regex DecorativeOverlay =
        new("flash|glow|highlight|vfx|sparkle|shine|halo", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Topmost-first DISTINCT hover-first widget ids under a design-space point, truncated at the first blocking
    /// button (that block id is not included). Iterates <see cref="MirrorState.OrderedIds"/> REVERSED (paint order
    /// is back-to-front, so reversed = topmost first) and classifies every hittable node.
    /// </summary>
    public static IReadOnlyList<string> TargetsAt(
        MirrorState state,
        GlobalTransformIndex transforms,
        double x,
        double y,
        Func<string, SpreadRecord?>? record = null)
    {
        var result = new List<string>();
        foreach (var id in HittableIdsAt(state, transforms, x, y, record))
        {
            var info = ComputeTouchInfo(state, id);
            if (info.Kind == TouchInfoKind.Block)
            {
                return result; // a plain button blocks the fall-through to anything behind it (id NOT included)
            }

            if (info.Kind == TouchInfoKind.Target && info.Id is { } targetId && !result.Contains(targetId))
            {
                result.Add(targetId);
            }
        }

        return result;
    }

    /// <summary>
    /// The RAW hit-eligibility walk: every id (topmost-first) whose node passes <see cref="IsHittable"/> at the
    /// design/game-space point, WITHOUT the <see cref="ComputeTouchInfo"/> classification or block-truncation
    /// <see cref="TargetsAt"/> layers on. <see cref="TargetsAt"/> is defined in terms of this; the QA <c>dump</c>
    /// verb also consumes it so it can report the classification (None/Target/Block) + ancestor chain of nodes that
    /// <see cref="TargetsAt"/> would otherwise silently drop (the exact #9 diagnosis surface — an unlisted leaf that
    /// classifies None never reaches TargetsAt output). <paramref name="record"/> (null = byte-identical) threads the
    /// live spread lookup for the #10 widened-clip test.
    /// </summary>
    public static IReadOnlyList<string> HittableIdsAt(
        MirrorState state,
        GlobalTransformIndex transforms,
        double x,
        double y,
        Func<string, SpreadRecord?>? record = null)
    {
        var parents = BuildParentSet(state);
        var result = new List<string>();
        for (var i = state.OrderedIds.Count - 1; i >= 0; i--)
        {
            var id = state.OrderedIds[i];
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            if (IsHittable(state, transforms, parents, node, x, y, record))
            {
                result.Add(id);
            }
        }

        return result;
    }

    /// <summary>
    /// The mirrorRenderer.ts `computeTouchInfo` walk: from <paramref name="id"/> up the parent chain (inclusive) to
    /// the nearest interactive ancestor. An ECHO container ANYWHERE in the ancestry ⇒ None; a decorative overlay
    /// BELOW the target ⇒ None; a TOUCH_TARGET type normally ⇒ Target(widget); a "*Button" type nearer than any
    /// target ⇒ Block. A visible decision card-grid or exact deck remove picker turns its NCard into a final Block
    /// after ancestry settles.
    /// </summary>
    public static TouchInfo ComputeTouchInfo(MirrorState state, string id)
    {
        var cur = state.Nodes.TryGetValue(id, out var start) ? start : null;
        var decorative = false;
        string? targetId = null;
        while (cur is not null)
        {
            if (IsEchoContainer(cur))
            {
                return new TouchInfo(TouchInfoKind.None, null);
            }

            if (targetId is null)
            {
                if (IsDecorativeOverlay(cur))
                {
                    decorative = true;
                }

                var leaf = NodeTypeLeaf(cur.NodeType);
                // Every TOUCH_TARGET normally arms first rather than falling through to a native left-click. The
                // visible decision-card grid is the deliberate NCard exception finalized after this full ancestry
                // walk; browse grids retain the normal arm-first target. The HAND-card distinction (IsHandCard) is
                // still only for peek / drag-lift / tap-unselect semantics.
                if (TouchTargetTypes.Contains(leaf))
                {
                    // R8: EXCEPT the end-of-event Proceed option — same leaf, but its owning SCENE stays
                    // proceed_button.tscn (see ProceedButtonSceneFileSuffix) — press it immediately (Block), never
                    // arm-first.
                    var (file, _) = SceneIdentity.Resolve(cur.Id, state);
                    if (file is not null && file.EndsWith(ProceedButtonSceneFileSuffix, StringComparison.Ordinal))
                    {
                        return new TouchInfo(TouchInfoKind.Block, cur.Id);
                    }

                    // R8 (live-verified leg): a resolved event's final "Continue" is a REGULAR
                    // event_option_button.tscn / NEventOptionButton (live QA capture — the proceed_button.tscn key
                    // never fires for it), so the scene file cannot tell it apart. What can: it is the ONLY
                    // effectively-visible event option on screen (an ended event offers no choice to weigh, so
                    // there is nothing for arm-first to preview) — press it immediately, matching the desktop
                    // one-click flow. Any event with 2+ visible options keeps arm-first untouched.
                    if (leaf == "NEventOptionButton" && CountVisibleEventOptions(state) == 1)
                    {
                        return new TouchInfo(TouchInfoKind.Block, cur.Id);
                    }

                    targetId = cur.Id; // owning widget — keep walking up to check for an echo-container ancestor
                }
                else if (cur.SceneFilePath == MultiplayerPlayerStateSceneFile)
                {
                    // This is deliberately scene-identity based: the remote player-state root is a plain Control,
                    // while a nearer real target or button still owns its own interaction.
                    targetId = cur.Id;
                }
                else if (leaf.EndsWith("Button", StringComparison.Ordinal))
                {
                    return new TouchInfo(TouchInfoKind.Block, cur.Id);
                }
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        if (targetId is null || decorative)
        {
            return new TouchInfo(TouchInfoKind.None, null);
        }

        // The grid itself is the decision flow. Its cards click directly so the game-owned confirmation remains the
        // only confirmation; decide only after echo/decorative ancestry has been completely processed.
        return IsVisibleCardGridSelectionCard(state, targetId) || IsVisibleDeckCardSelectCard(state, targetId)
            ? new TouchInfo(TouchInfoKind.Block, targetId)
            : new TouchInfo(TouchInfoKind.Target, targetId);
    }

    // R19: what counts as a CARD for the gesture machine's card semantics (<see cref="IsCard"/>) — the predicate that,
    // with <see cref="IsHandCard"/>, splits a touch target into a HAND card (peek / drag-lift / tap-unselect) and a
    // NON-hand card (the long-press right-click that opens the item's detail dialog). It used to be the single leaf
    // "NCard", which is why a sustained touch on a SHOP card did nothing: a shop item's touch target resolves to
    // NMerchantCard / NMerchantRelic / NMerchantPotion, so BOTH halves were false and the long-press deadline was
    // never armed. Every entry here is already a <see cref="TouchTargetTypes"/> member (it has to be — the target must
    // resolve before this is asked) and none can be a HAND card, so widening this only ever adds the non-hand leg.
    // DELIBERATELY EXCLUDED: NRewardButton and NTreasureRoomRelicHolder — both live on screens where the gesture
    // consumes a real run reward, which is not where a new touch verb gets its first outing.
    // Kill switch: the existing LONGPRESS_RCLICK env / web `?longpressRclick=off`, which gates the whole non-hand leg.
    // Web twin (keep in lockstep — the two clients run the same decision tree): mirrorRenderer CARD_TOUCH_TARGET_TYPES.
    private static readonly HashSet<string> CardTouchTargetTypes = new(StringComparer.Ordinal)
    {
        "NCard",
        "NMerchantCard",
        "NMerchantRelic",
        "NMerchantPotion",
    };

    /// <summary>Whether the id's leaf node type is one of <see cref="CardTouchTargetTypes"/> — the card predicate.</summary>
    public static bool IsCard(MirrorState state, string id) =>
        state.Nodes.TryGetValue(id, out var node) && CardTouchTargetTypes.Contains(NodeTypeLeaf(node.NodeType));

    /// <summary>
    /// Whether <paramref name="id"/> lives under a HAND container — some ancestor (inclusive) has a node-type leaf
    /// in <see cref="HandCardAncestorTypes"/> (NHandCardHolder / NPlayerHand). This is the extra gate that, with
    /// <see cref="IsCard"/>, keeps the peek / drag-lift / unselect card semantics to HAND cards only: a deck-dialog
    /// or reward NCard has no such ancestor, so it is treated as a plain node (a tap falls through to a native
    /// left-click). Bounded parent-chain walk in the same style as <see cref="ComputeTouchInfo"/>. Node NAMES are
    /// anonymous live (no CARD_* prefixes), so this matches by node-type LEAF only. Web twin: mirrorRenderer isHandCard.
    /// </summary>
    public static bool IsHandCard(MirrorState state, string id)
    {
        var cur = state.Nodes.TryGetValue(id, out var start) ? start : null;
        while (cur is not null)
        {
            if (HandCardAncestorTypes.Contains(NodeTypeLeaf(cur.NodeType)))
            {
                return true;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return false;
    }

    // ---- hit eligibility (DOM-truth, replacing elementsFromPoint) ----

    private static bool IsHittable(
        MirrorState state,
        GlobalTransformIndex transforms,
        HashSet<string> parents,
        MirrorNode node,
        double x,
        double y,
        Func<string, SpreadRecord?>? record = null)
    {
        // (a) effectively visible: the node AND every ancestor visible.
        if (!EffectivelyVisible(state, node))
        {
            return false;
        }

        // (b) a global transform + a real box.
        if (!transforms.TryGetGlobal(node.Id, out var global))
        {
            return false;
        }

        if (node.LocalRect is not { } rect || rect.Width <= 0 || rect.Height <= 0)
        {
            return false;
        }

        // (c) NOT a pure container: a node with children but no own paint is a layout group, not a hittable box.
        if (parents.Contains(node.Id) && !HasOwnPaint(node))
        {
            return false;
        }

        // (d) the point lands inside the node's own box...
        if (!PointInBox(global, rect, x, y))
        {
            return false;
        }

        // ...and inside every clip-children ancestor's box (a clipped-away point renders display-clipped, so the
        // DOM hit-test would never see the node). #10: a horizontally-stretched clip (a ScrollContainer anchored 0..1)
        // clips WIDER than its streamed rect on a widened stage, so a rightmost-grid-column point past the streamed
        // width is falsely clip-rejected unless the ancestor's anchor-widened RenderedWidth is used. When a spread
        // `record` is threaded (InputRouter/DoDump) and the ancestor carries a RenderedWidth override, test against
        // that widened width (SpreadMath.EffectiveClipWidth) via PointInRectGame; else the streamed-width PointInBox
        // (byte-identical to before — record null / no override / 16:9).
        for (var p = Parent(state, node); p is not null; p = Parent(state, p))
        {
            if (p.ClipChildren == 0
                || !transforms.TryGetGlobal(p.Id, out var pg)
                || p.LocalRect is not { } pr
                || pr.Width <= 0
                || pr.Height <= 0)
            {
                continue;
            }

            bool inside = record is not null && record(p.Id) is { RenderedWidth: > 0 } prec
                ? NearMiss.PointInRectGame(pg, pr, x, y, SpreadMath.EffectiveClipWidth(pr.Width, prec.RenderedWidth))
                : PointInBox(pg, pr, x, y);

            if (!inside)
            {
                return false;
            }
        }

        return true;
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        var cur = node;
        while (cur is not null)
        {
            if (!cur.Visible)
            {
                return false;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return true;
    }

    private static bool IsVisibleCardGridSelectionCard(MirrorState state, string id)
    {
        var card = state.Nodes.TryGetValue(id, out var start) ? start : null;
        if (card is null || NodeTypeLeaf(card.NodeType) != "NCard" || !EffectivelyVisible(state, card))
        {
            return false;
        }

        for (var current = Parent(state, card); current is not null; current = Parent(state, current))
        {
            if (NodeTypeLeaf(current.NodeType) == CardGridSelectionScreenType)
            {
                return EffectivelyVisible(state, current);
            }
        }

        return false;
    }

    private static bool IsVisibleDeckCardSelectCard(MirrorState state, string id)
    {
        var card = state.Nodes.TryGetValue(id, out var start) ? start : null;
        if (card is null || NodeTypeLeaf(card.NodeType) != "NCard" || !EffectivelyVisible(state, card))
        {
            return false;
        }

        for (var current = Parent(state, card); current is not null; current = Parent(state, current))
        {
            if (NodeTypeLeaf(current.NodeType) == DeckCardSelectScreenType)
            {
                return EffectivelyVisible(state, current);
            }
        }

        return false;
    }

    // R8 lone-option leg: how many effectively-visible NEventOptionButton widgets are on screen. An event screen has
    // ONE options list, so a count of exactly 1 means "no choice left — just a Continue" and the option presses
    // immediately (see ComputeTouchInfo). Bounded by the node map (touch-time only, never per-frame). Web twin:
    // countVisibleEventOptions in mirrorRenderer's computeTouchInfo.
    private static int CountVisibleEventOptions(MirrorState state)
    {
        int n = 0;
        foreach (var node in state.Nodes.Values)
        {
            if (NodeTypeLeaf(node.NodeType) == "NEventOptionButton" && EffectivelyVisible(state, node) && ++n > 1)
            {
                break; // 2+ is all the caller distinguishes
            }
        }

        return n;
    }

    // The own-paint predicate (port of nodeStyle's paint gates — see godot-client PaintGates as a reference SHAPE):
    // a node draws its own content iff it paints a texture, a fill, a range bar, a nine-patch, or a text run.
    private static bool HasOwnPaint(MirrorNode node) =>
        PaintsTexture(node) || node.FillColor is not null || node.Range is not null || node.NinePatch || node.Text is not null;

    // Port of nodeStyles.ts paintsTexture (structural half): a texture paints unless the node is clip-only or a
    // particle sprite. (WebGL-shader / shaders-off nuances live in the client's render layer, not this hit gate.)
    private static bool PaintsTexture(MirrorNode node) =>
        node.TextureUrl is not null && node.ClipChildren != 1 && node.ParticleSpec is null;

    private static bool PointInBox(IReadOnlyList<double> global, MirrorRect rect, double x, double y)
    {
        // NodeMatrix composes the global with a translate to the box origin, so the box renders at (0,0,w,h);
        // inverting it maps a global point into that local box space.
        var m = Affine.NodeMatrix(global, rect.X, rect.Y);
        var inv = Affine.Inverse(m);
        if (inv is null)
        {
            return false;
        }

        var lx = inv[0] * x + inv[2] * y + inv[4];
        var ly = inv[1] * x + inv[3] * y + inv[5];
        return lx >= 0 && lx <= rect.Width && ly >= 0 && ly <= rect.Height;
    }

    private static MirrorNode? Parent(MirrorState state, MirrorNode node) =>
        node.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;

    private static HashSet<string> BuildParentSet(MirrorState state)
    {
        var parents = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in state.Nodes.Values)
        {
            if (node.ParentId is { } pid)
            {
                parents.Add(pid);
            }
        }

        return parents;
    }

    private static bool IsEchoContainer(MirrorNode node) => EchoContainer.IsMatch(NodeTypeLeaf(node.NodeType));

    private static bool IsDecorativeOverlay(MirrorNode node) =>
        DecorativeOverlay.IsMatch(node.Name) || DecorativeOverlay.IsMatch(NodeTypeLeaf(node.NodeType));

    // The leaf (final dotted segment) of a Godot type name — mirrorRenderer nodeTypeLeaf.
    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
