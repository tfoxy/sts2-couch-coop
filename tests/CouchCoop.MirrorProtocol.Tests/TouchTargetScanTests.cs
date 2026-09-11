using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for TouchTargetScan (the native elementsFromPoint replacement): hit eligibility (effective
// visibility, box containment, pure-container skip, clip-ancestor containment), the computeTouchInfo
// classification (target / block / echo / decorative), z-order topmost-first + block truncation, IsCard, and the
// IsHandCard predicate. NOTE (post arm-first change): EVERY NCard classifies as a touch target now — the hand
// ancestor is no longer a scan gate (it only drives the gesture machine's peek/lift/unselect semantics). IsHandCard
// is still tested directly (a deck/reward card is a card touch target but NOT a hand card).
internal static class TouchTargetScanTests
{
    public static void Run()
    {
        ComputeTouchInfoClassifies();
        IsCardByLeafType();
        HandCardClassifiesAsCardTarget();
        NonHandCardIsTouchTargetForArmFirst();
        ShopAndTreasureLeavesAreTargets();
        DecorativeOverlaySuppressed();
        BoxlessRootReachableViaPaintedDescendant();
        EchoAncestryYieldsNone();
        BlockButtonTruncates();
        PureContainerSkipped();
        StackingTopmostWins();
        AncestorHiddenExcluded();
        ClipAncestorExcludesOutsidePoint();
        WidenedClipRightColumnHittable();
        DistinctIdsCollapsed();
        ViewScaleHaloTapResolvesToItem();
        DecisionGridCardPressesImmediately();
        DeckCardRemovePickerPressesImmediately();
        MultiplayerPlayerStateSceneRootIsFallbackTarget();
        ProceedButtonSceneExcludedFromArmFirst();
        RegularEventOptionStaysArmFirstTarget();
        LoneVisibleEventOptionPressesImmediately();
    }

    // R8: the end-of-event "Proceed" option reuses the SAME NEventOptionButton node type as a regular option (so
    // it isn't statically distinguishable by leaf), but its owning SCENE stays res://scenes/ui/proceed_button.tscn
    // (the shared NProceedButton scene) — SceneIdentity.Resolve tells the two apart. Matched to a Block so a tap
    // presses IMMEDIATELY (no arm-first double-tap).
    private static void ProceedButtonSceneExcludedFromArmFirst()
    {
        var (state, _) = Build(
            Node("options", null, "Godot.HBoxContainer"),
            Node(
                "proceed",
                "options",
                "NEventOptionButton",
                0,
                0,
                100,
                100,
                texture: true,
                sceneFile: "res://scenes/ui/proceed_button.tscn"),
            Node("proceedText", "proceed", "Godot.Label", 0, 0, 100, 100, text: true));

        var rootInfo = TouchTargetScan.ComputeTouchInfo(state, "proceed");
        Check.Equal(rootInfo.Kind, TouchInfoKind.Block, "the Proceed option's own scene root → Block (immediate press)");
        Check.Equal(rootInfo.Id, "proceed", "block carries the Proceed option's id");

        var childInfo = TouchTargetScan.ComputeTouchInfo(state, "proceedText");
        Check.Equal(childInfo.Kind, TouchInfoKind.Block, "a descendant of the Proceed option also → Block");
        Check.Equal(childInfo.Id, "proceed", "the descendant's block still carries the Proceed option's id");
    }

    // A REGULAR event option — same NEventOptionButton leaf, but its owning scene is the ordinary option button —
    // keeps the arm-first Target classification.
    private static void RegularEventOptionStaysArmFirstTarget()
    {
        // TWO visible options: a choice is on offer, so arm-first preview semantics apply (the lone-option Block
        // leg below must NOT fire here).
        var (state, index) = Build(
            Node("options", null, "Godot.HBoxContainer"),
            Node(
                "regular",
                "options",
                "NEventOptionButton",
                0,
                0,
                100,
                100,
                texture: true,
                sceneFile: "res://scenes/ui/event_option_button.tscn"),
            Node(
                "regular2",
                "options",
                "NEventOptionButton",
                0,
                200,
                100,
                100,
                texture: true,
                sceneFile: "res://scenes/ui/event_option_button.tscn"));

        var info = TouchTargetScan.ComputeTouchInfo(state, "regular");
        Check.Equal(info.Kind, TouchInfoKind.Target, "a regular event option (non-proceed scene, 2+ choices) stays a Target (arm-first)");
        Check.Equal(info.Id, "regular", "target carries the option's own id");
        Check.SequenceEqual(
            TouchTargetScan.TargetsAt(state, index, 50, 50),
            new[] { "regular" },
            "the regular option is a hit-testable arm-first target");
    }

    // R8 lone-option leg (live-verified): a resolved event's final "Continue" is a REGULAR event_option_button.tscn
    // NEventOptionButton (the proceed_button.tscn key never fires for it — live QA capture). When it is the ONLY
    // effectively-visible event option there is no choice to preview, so it presses IMMEDIATELY. A second but
    // HIDDEN option (an already-collapsed choice) must not re-enable arm-first.
    private static void LoneVisibleEventOptionPressesImmediately()
    {
        var (state, _) = Build(
            Node("options", null, "Godot.HBoxContainer"),
            Node(
                "continue",
                "options",
                "NEventOptionButton",
                0,
                0,
                100,
                100,
                texture: true,
                sceneFile: "res://scenes/ui/event_option_button.tscn"),
            Node(
                "spent",
                "options",
                "NEventOptionButton",
                0,
                200,
                100,
                100,
                visible: false,
                texture: true,
                sceneFile: "res://scenes/ui/event_option_button.tscn"));

        var info = TouchTargetScan.ComputeTouchInfo(state, "continue");
        Check.Equal(info.Kind, TouchInfoKind.Block, "the lone visible event option → Block (immediate press)");
        Check.Equal(info.Id, "continue", "block carries the lone option's id");
    }

    // #19 input inverse: a reward item enlarged 1.2× about its centre gains a "halo" band beyond its true rect. The
    // InputRouter un-maps a design pointer via ViewScale.InverseMapPoint BEFORE the scan, so a tap in that halo band
    // (outside the true rect) resolves to the item; the same point WITHOUT the inverse misses it (the store geometry
    // is un-scaled). Composition test: InverseMapPoint(halo) → TargetsAt → item.
    private static void ViewScaleHaloTapResolvesToItem()
    {
        var (state, index) = Build(
            Node("reward", null, "MegaCrit.Sts2.Core.Nodes.Rewards.NRewardButton", 100, 100, 100, 100, texture: true));

        // The item's design box (100,100)-(200,200), scaled 1.2× about its centre (150,150) → enlarged box (90..210).
        var box = new DesignAabb(100, 100, 200, 200);
        var stamp = HoverTipScaleMath.ComputeCenterStamp(box, 1.2, 1920, 1080)!.Value;

        // Halo point x=205: outside the TRUE rect (…200) but inside the enlarged rect (…210).
        Check.SequenceEqual(
            TouchTargetScan.TargetsAt(state, index, 205, 150),
            Array.Empty<string>(),
            "halo point (x=205) misses the un-scaled true rect without the inverse");

        var (rx, ry) = ViewScale.InverseMapPoint(stamp, 205, 150);
        Check.That(rx <= 200 && rx >= 100, "inverse un-maps the halo point back inside the true rect");
        Check.SequenceEqual(
            TouchTargetScan.TargetsAt(state, index, rx, ry),
            new[] { "reward" },
            "inverse-mapped halo point resolves to the reward item (halo stays tappable)");
    }

    private static void DecisionGridCardPressesImmediately()
    {
        var (visible, _) = Build(
            Node("grid", null, "Game.NCardGridSelectionScreen"),
            Node("card", "grid", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Godot.Sprite2D", 0, 0, 100, 100, texture: true),
            Node("glow", "card", "Godot.Node2D", 0, 0, 100, 100, name: "CardGlow", texture: true),
            Node("preview", "grid", "Game.NCardPreviewContainer"),
            Node("echo", "preview", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("echoArt", "echo", "Godot.Sprite2D", 0, 0, 100, 100, texture: true));

        var card = TouchTargetScan.ComputeTouchInfo(visible, "art");
        Check.Equal(card.Kind, TouchInfoKind.Block, "visible decision-grid card → Block (immediate click)");
        Check.Equal(card.Id, "card", "decision-grid block carries its card id");
        Check.Equal(TouchTargetScan.ComputeTouchInfo(visible, "glow").Kind, TouchInfoKind.None,
            "decorative grid-card glow remains inert, not a blocking surface");
        Check.Equal(TouchTargetScan.ComputeTouchInfo(visible, "echoArt").Kind, TouchInfoKind.None,
            "echo ancestry wins before the decision-grid block");

        var (hidden, _) = Build(
            Node("grid", null, "Game.NCardGridSelectionScreen", visible: false),
            Node("card", "grid", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Godot.Sprite2D", 0, 0, 100, 100, texture: true));
        var hiddenCard = TouchTargetScan.ComputeTouchInfo(hidden, "art");
        Check.Equal(hiddenCard.Kind, TouchInfoKind.Target, "hidden retained grid does not change ordinary card targeting");
        Check.Equal(hiddenCard.Id, "card", "hidden grid card retains its own target id");
    }

    private static void DeckCardRemovePickerPressesImmediately()
    {
        var (visible, _) = Build(
            Node("picker", null, "Game.NDeckCardSelectScreen"),
            Node("grid", "picker", "Game.NCardGrid"),
            Node("holder", "grid", "Game.NGridCardHolder"),
            Node("card", "holder", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Godot.Sprite2D", 0, 0, 100, 100, texture: true));
        var info = TouchTargetScan.ComputeTouchInfo(visible, "art");
        Check.Equal(info.Kind, TouchInfoKind.Block, "visible exact deck remove picker card → Block (immediate click)");
        Check.Equal(info.Id, "card", "exact deck remove picker block carries card id");

        var (hidden, _) = Build(
            Node("picker", null, "Game.NDeckCardSelectScreen", visible: false),
            Node("grid", "picker", "Game.NCardGrid"),
            Node("holder", "grid", "Game.NGridCardHolder"),
            Node("card", "holder", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Godot.Sprite2D", 0, 0, 100, 100, texture: true));
        Check.Equal(TouchTargetScan.ComputeTouchInfo(hidden, "art").Kind, TouchInfoKind.Target,
            "hidden retained remove picker leaves ordinary arm-first card targeting");

        foreach (var selector in new[]
                 {
                     "NDeckUpgradeSelectScreen", "NDeckTransformSelectScreen",
                     "NDeckEnchantSelectScreen", "NSimpleCardSelectScreen", "NCardGrid"
                 })
        {
            var (derived, _) = Build(
                Node("picker", null, $"Game.{selector}"),
                Node("grid", "picker", "Game.NCardGrid"),
                Node("holder", "grid", "Game.NGridCardHolder"),
                Node("card", "holder", "Game.NCard", 0, 0, 100, 100, texture: true),
                Node("art", "card", "Godot.Sprite2D", 0, 0, 100, 100, texture: true));
            Check.Equal(TouchTargetScan.ComputeTouchInfo(derived, "art").Kind, TouchInfoKind.Target,
                $"derived {selector} remains arm-first");
        }
    }

    private static void MultiplayerPlayerStateSceneRootIsFallbackTarget()
    {
        var (state, _) = Build(
            Node("remote", null, "Godot.Control", sceneFile: "res://scenes/ui/multiplayer_player_state.tscn"),
            Node("hp", "remote", "Godot.Label", 0, 0, 100, 30, text: true),
            Node("option", "remote", "Game.NMerchantCard", 0, 40, 100, 30, texture: true),
            Node("optionText", "option", "Godot.Label", 0, 40, 100, 30, text: true),
            Node("button", "remote", "Game.NSkipButton", 0, 80, 100, 30, texture: true),
            Node("buttonText", "button", "Godot.Label", 0, 80, 100, 30, text: true),
            Node("similar", null, "Godot.Control", sceneFile: "res://scenes/ui/multiplayer_player_state_copy.tscn"),
            Node("other", "similar", "Godot.Label", 0, 120, 100, 30, text: true));

        var hp = TouchTargetScan.ComputeTouchInfo(state, "hp");
        Check.Equal(hp.Kind, TouchInfoKind.Target, "HP under exact multiplayer scene root → fallback target");
        Check.Equal(hp.Id, "remote", "HP fallback carries the scene-root id");
        Check.Equal(TouchTargetScan.ComputeTouchInfo(state, "optionText").Id, "option",
            "nearer explicit target takes precedence over multiplayer fallback");
        Check.Equal(TouchTargetScan.ComputeTouchInfo(state, "buttonText").Kind, TouchInfoKind.Block,
            "nearer explicit button blocks before multiplayer fallback");
        Check.Equal(TouchTargetScan.ComputeTouchInfo(state, "other").Kind, TouchInfoKind.None,
            "nearby scene filename is not a multiplayer fallback match");
    }

    // ---- builders ----

    private static MirrorNode Node(
        string id,
        string? parent,
        string type,
        double? x = null,
        double? y = null,
        double? w = null,
        double? h = null,
        bool visible = true,
        int clip = 0,
        string? name = null,
        bool texture = false,
        bool text = false,
        bool fill = false,
        bool range = false,
        bool ninePatch = false,
        string? sceneFile = null)
    {
        var node = new MirrorNode
        {
            Id = id,
            ParentId = parent,
            NodeType = type,
            Name = name ?? id,
            Visible = visible,
            ClipChildren = clip,
            SceneFilePath = sceneFile,
        };
        if (x is not null)
        {
            node.Transform = new double[] { 1, 0, 0, 1, x.Value, y ?? 0 };
            node.LocalRect = new MirrorRect(0, 0, w ?? 0, h ?? 0);
        }

        if (texture)
        {
            node.TextureUrl = "res://t.png";
        }

        if (text)
        {
            node.Text = new MirrorText("hi", null, null, null, null, null, 0);
        }

        if (fill)
        {
            node.FillColor = new MirrorColor(1, 1, 1, 1, "#ffffffff");
        }

        if (range)
        {
            node.Range = new MirrorRange(0.5, 0, 1);
        }

        node.NinePatch = ninePatch;
        return node;
    }

    // Nodes are passed BACK-TO-FRONT (OrderedIds order); the last node is topmost.
    private static (MirrorState State, GlobalTransformIndex Index) Build(params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var node in nodes)
        {
            state.Nodes[node.Id] = node;
            state.OrderedIds.Add(node.Id);
            state.ChangedIds.Add(node.Id);
        }

        state.Revision = 1;
        var index = new GlobalTransformIndex();
        index.Update(state);
        return (state, index);
    }

    // ---- computeTouchInfo classification ----

    private static void ComputeTouchInfoClassifies()
    {
        var (state, _) = Build(
            Node("hand", null, "Game.Combat.NPlayerHand"), // the card lives under a hand container → a hand card
            Node("card", "hand", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Sprite2D", 0, 0, 100, 100, texture: true),
            Node("btn", null, "Ui.NSkipButton", 200, 0, 100, 100, texture: true),
            Node("preview", null, "NCardPreviewContainer", 400, 0, 100, 100),
            Node("echoCard", "preview", "NCard", 0, 0, 100, 100, texture: true),
            Node("plain", null, "Node2D", 600, 0, 100, 100, texture: true));

        var artInfo = TouchTargetScan.ComputeTouchInfo(state, "art");
        Check.Equal(artInfo.Kind, TouchInfoKind.Target, "art → Target");
        Check.Equal(artInfo.Id, "card", "art resolves to owning NCard widget id");

        var btnInfo = TouchTargetScan.ComputeTouchInfo(state, "btn");
        Check.Equal(btnInfo.Kind, TouchInfoKind.Block, "*Button leaf → Block");
        Check.Equal(btnInfo.Id, "btn", "block carries the button id");

        var echoInfo = TouchTargetScan.ComputeTouchInfo(state, "echoCard");
        Check.Equal(echoInfo.Kind, TouchInfoKind.None, "NCard under an echo container → None");

        var plainInfo = TouchTargetScan.ComputeTouchInfo(state, "plain");
        Check.Equal(plainInfo.Kind, TouchInfoKind.None, "non-widget node → None");
    }

    private static void IsCardByLeafType()
    {
        var (state, _) = Build(
            Node("card", null, "Game.Combat.NCard", 0, 0, 10, 10, texture: true),
            Node("opt", null, "NEventOptionButton", 20, 0, 10, 10, texture: true),
            Node("removal", null, "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCardRemoval", 40, 0, 10, 10, texture: true));
        Check.That(TouchTargetScan.IsCard(state, "card"), "NCard leaf → IsCard true");
        Check.That(!TouchTargetScan.IsCard(state, "opt"), "non-NCard → IsCard false");
        Check.That(!TouchTargetScan.IsCard(state, "missing"), "unknown id → IsCard false");
        // R20: the removal coin is a touch TARGET (it arms on the first tap) but deliberately NOT a card. This set
        // drives the non-hand long-press RIGHT-CLICK, which opens an item's detail dialog — a service has none, so
        // the right-click there would be a no-op at best. Pinned by
        // GestureMachineTests.LongPressNonCardTargetNoRightClick, which is exactly this shape.
        Check.That(!TouchTargetScan.IsCard(state, "removal"), "NMerchantCardRemoval → IsCard FALSE (a service has no detail dialog)");
    }

    // ---- hand-card gating (only cards under an NHandCardHolder/NPlayerHand ancestor are card touch targets) ----

    // A card under a HAND container is a card touch target; its painted descendant resolves to the owning card.
    private static void HandCardClassifiesAsCardTarget()
    {
        var (state, index) = Build(
            Node("hand", null, "Game.Combat.NPlayerHand"),        // boxless hand root
            Node("holder", "hand", "Game.Combat.NHandCardHolder"), // boxless per-card holder
            Node("card", "holder", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Sprite2D", 0, 0, 100, 100, texture: true));

        Check.That(TouchTargetScan.IsHandCard(state, "card"), "card under NHandCardHolder/NPlayerHand → IsHandCard true");
        Check.That(TouchTargetScan.IsHandCard(state, "art"), "a descendant of a hand card is also under the hand");

        var info = TouchTargetScan.ComputeTouchInfo(state, "art");
        Check.Equal(info.Kind, TouchInfoKind.Target, "hand card classifies as a Target");
        Check.Equal(info.Id, "card", "art resolves to the owning hand card");

        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "card" }, "a hand card is a hit-testable touch target");
    }

    // A card NOT under a hand container (a deck-dialog / reward popup card) is now a card touch target too: it
    // classifies as a Target (arm-first — a tap hovers/focuses, a re-tap clicks) rather than falling through to a
    // native click. IsHandCard stays false, so the gesture machine still keeps peek/lift/unselect to hand cards only.
    private static void NonHandCardIsTouchTargetForArmFirst()
    {
        var (state, index) = Build(
            Node("dialog", null, "Game.NDeckViewDialog"), // a popup, NOT a hand
            Node("card", "dialog", "Game.NCard", 0, 0, 100, 100, texture: true),
            Node("art", "card", "Sprite2D", 0, 0, 100, 100, texture: true));

        Check.That(!TouchTargetScan.IsHandCard(state, "card"), "a deck-dialog card has no hand ancestor → IsHandCard false");
        Check.That(TouchTargetScan.IsCard(state, "card"), "it is still a card by leaf type (IsCard true)");

        var info = TouchTargetScan.ComputeTouchInfo(state, "art");
        Check.Equal(info.Kind, TouchInfoKind.Target, "a deck/reward card now classifies as a Target (arm-first)");
        Check.Equal(info.Id, "card", "art resolves to the owning deck/reward card");

        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "card" }, "the deck/reward card is a hit-testable touch target");
    }

    // #9: the shop carpet card (NMerchantCard) and the treasure-room relic (NTreasureRoomRelicHolder) now classify as
    // Targets (arm-first), where before they fell to None → an immediate click. NTreasureRoomRelicHolder derives from
    // NButton but its LEAF doesn't end in "Button", so it was never a Block — it was simply unlisted.
    private static void ShopAndTreasureLeavesAreTargets()
    {
        var (state, index) = Build(
            Node("shop", null, "Game.NMerchantRoom"),
            Node("card", "shop", "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCard", 0, 0, 100, 100, texture: true),
            Node("relicHolder", "shop", "MegaCrit.Sts2.Core.Nodes.Screens.TreasureRoomRelic.NTreasureRoomRelicHolder", 200, 0, 100, 100, texture: true),
            // R20: the CARD REMOVAL SERVICE coin, as the wire streams it — the NMerchantCardRemoval root with the
            // NClickableControl "Hitbox" child every other shop slot also has. Neither leaf ends in "Button", so
            // before it was listed BOTH classified as None and one tap was one full click.
            Node("removal", "shop", "MegaCrit.Sts2.Core.Nodes.Screens.Shops.NMerchantCardRemoval", 400, 0, 100, 100, texture: true),
            Node("removalHitbox", "removal", "MegaCrit.Sts2.Core.Nodes.GodotExtensions.NClickableControl", 400, 0, 100, 100));

        var cardInfo = TouchTargetScan.ComputeTouchInfo(state, "card");
        Check.Equal(cardInfo.Kind, TouchInfoKind.Target, "NMerchantCard → Target (arm-first)");
        Check.Equal(cardInfo.Id, "card", "shop card resolves to itself");

        var relicInfo = TouchTargetScan.ComputeTouchInfo(state, "relicHolder");
        Check.Equal(relicInfo.Kind, TouchInfoKind.Target, "NTreasureRoomRelicHolder → Target (not a Block; leaf isn't *Button)");

        var removalInfo = TouchTargetScan.ComputeTouchInfo(state, "removal");
        Check.Equal(removalInfo.Kind, TouchInfoKind.Target, "NMerchantCardRemoval → Target (arm-first, like every other shop slot)");
        Check.Equal(removalInfo.Id, "removal", "the removal coin resolves to itself");

        var hitboxInfo = TouchTargetScan.ComputeTouchInfo(state, "removalHitbox");
        Check.Equal(hitboxInfo.Kind, TouchInfoKind.Target, "its NClickableControl hitbox is not a Block either");
        Check.Equal(hitboxInfo.Id, "removal", "the hitbox resolves to the owning coin");

        Check.SequenceEqual(TouchTargetScan.TargetsAt(state, index, 50, 50), new[] { "card" }, "shop card is a hit-testable target");
        Check.SequenceEqual(TouchTargetScan.TargetsAt(state, index, 250, 50), new[] { "relicHolder" }, "treasure relic is a hit-testable target");
        Check.SequenceEqual(TouchTargetScan.TargetsAt(state, index, 450, 50), new[] { "removal" }, "the removal coin is a hit-testable target");
    }

    // ---- hit eligibility ----

    // A decorative overlay (name matches /glow/) is the ONLY painted node at the point; its NCard is boxless → the
    // whole hit yields None (the overlay can't steal the neighbour's tap).
    private static void DecorativeOverlaySuppressed()
    {
        var (state, index) = Build(
            Node("hand", null, "NPlayerHand"), // hand root so the card would otherwise be a target
            Node("card", "hand", "NCard"), // boxless card
            Node("glow", "card", "Node2D", 0, 0, 100, 100, name: "CardGlow", texture: true));
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, Array.Empty<string>(), "decorative-only hit → no target");
    }

    // A boxless widget root is reachable through a painted (non-decorative) descendant that carries the point.
    private static void BoxlessRootReachableViaPaintedDescendant()
    {
        var (state, index) = Build(
            Node("hand", null, "NHandCardHolder"), // hand ancestor
            Node("card", "hand", "NCard"), // boxless root
            Node("art", "card", "Sprite2D", 0, 0, 100, 100, texture: true));
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "card" }, "boxless NCard reached via its painted descendant");
    }

    // An echo container ancestor suppresses its inner card, so a real card behind it wins.
    private static void EchoAncestryYieldsNone()
    {
        var (state, index) = Build(
            Node("hand", null, "NPlayerHand"), // hand ancestor for the REAL card
            Node("realCard", "hand", "NCard", 0, 0, 100, 100, texture: true), // backmost
            Node("preview", null, "NGridCardPreviewContainer", 0, 0, 100, 100), // pure container over it
            Node("echoCard", "preview", "NCard", 0, 0, 100, 100, texture: true)); // topmost, echo copy
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "realCard" }, "echo copy suppressed → real card behind wins");
    }

    // A painted plain button on top BLOCKS the fall-through to a card behind (the Skip-over-rewards case).
    private static void BlockButtonTruncates()
    {
        var (state, index) = Build(
            Node("hand", null, "NHandCardHolder"), // the card behind is a real hand card (only the block hides it)
            Node("card", "hand", "NCard", 0, 0, 100, 100, texture: true), // behind
            Node("skip", null, "NSkipButton", 0, 0, 100, 100, texture: true)); // topmost block
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, Array.Empty<string>(), "block button truncates (card behind not reached; block id excluded)");
    }

    // A pure container (children + no own paint) is NOT a hit — even a button ROOT with a child but no paint is
    // skipped, so a card behind it is still reachable (contrast BlockButtonTruncates' PAINTED button).
    private static void PureContainerSkipped()
    {
        var (state, index) = Build(
            Node("hand", null, "NHandCardHolder"), // hand ancestor
            Node("card", "hand", "NCard", 0, 0, 100, 100, texture: true), // behind
            Node("ghostBtn", null, "NSkipButton", 0, 0, 100, 100), // topmost: box, NO paint, has a child → pure container
            Node("spacer", "ghostBtn", "Node2D")); // boxless child (gives ghostBtn children, itself not hittable)
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "card" }, "pure-container button skipped → card behind reached (not blocked)");
    }

    // Overlapping cards: topmost (last in OrderedIds) is returned first.
    private static void StackingTopmostWins()
    {
        var (state, index) = Build(
            Node("hand", null, "NPlayerHand"), // both cards under the hand
            Node("cardBot", "hand", "NCard", 0, 0, 100, 100, texture: true),
            Node("cardTop", "hand", "NCard", 0, 0, 100, 100, texture: true));
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "cardTop", "cardBot" }, "topmost wins, both distinct in z-order");
    }

    // A card under a hidden ancestor is not a hit; a visible card at the same point is.
    private static void AncestorHiddenExcluded()
    {
        var (state, index) = Build(
            Node("hand", null, "NPlayerHand"), // both cards are hand cards; only the hidden group excludes one
            Node("cardVisible", "hand", "NCard", 0, 0, 100, 100, texture: true),
            Node("hiddenGroup", "hand", "Node2D", 0, 0, 100, 100, visible: false),
            Node("cardHidden", "hiddenGroup", "NCard", 0, 0, 100, 100, texture: true));
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "cardVisible" }, "ancestor-hidden card excluded; visible card wins");
    }

    // A clip-children ancestor bounds its descendants: a point inside the card but OUTSIDE the clip box misses.
    private static void ClipAncestorExcludesOutsidePoint()
    {
        MirrorNode[] Scene() => new[]
        {
            Node("hand", null, "NHandCardHolder"), // hand ancestor above the clip
            Node("clip", "hand", "Node2D", 0, 0, 100, 100, clip: 1), // clip box (0,0)-(100,100)
            Node("card", "clip", "NCard", 50, 50, 100, 100, texture: true), // card box (50,50)-(150,150)
        };

        var (s1, i1) = Build(Scene());
        var inside = TouchTargetScan.TargetsAt(s1, i1, 75, 75); // inside card AND clip
        Check.SequenceEqual(inside, new[] { "card" }, "inside both clip + card → hit");

        var (s2, i2) = Build(Scene());
        var outsideClip = TouchTargetScan.TargetsAt(s2, i2, 120, 120); // inside card, outside clip
        Check.SequenceEqual(outsideClip, Array.Empty<string>(), "inside card but outside clip ancestor → excluded");
    }

    // #10: a horizontally-stretched ScrollContainer clip (streamed width 100, anchor-widened RenderedWidth 300) clips
    // a card that extends to x=300. A rightmost-column point at x=200 is inside the card AND the WIDENED clip box, but
    // outside the STREAMED clip box. WITH the spread record (the widened width) it hits; WITHOUT it is falsely
    // clip-rejected — while a left-column point inside both boxes hits either way (byte-identical for other columns).
    private static void WidenedClipRightColumnHittable()
    {
        MirrorNode[] Scene() => new[]
        {
            Node("dialog", null, "Game.NDeckViewDialog"),
            Node("clip", "dialog", "Godot.ScrollContainer", 0, 0, 100, 100, clip: 1),
            Node("card", "clip", "Game.NCard", 0, 0, 300, 100, texture: true),
        };
        Func<string, SpreadRecord?> rec = id => id == "clip" ? new SpreadRecord(0, 300, false, false) : null;

        var (s1, i1) = Build(Scene());
        Check.SequenceEqual(
            TouchTargetScan.TargetsAt(s1, i1, 200, 50, rec),
            new[] { "card" },
            "widened clip (record) → rightmost-column point x∈(streamedW, renderedW) hits the card");

        var (s2, i2) = Build(Scene());
        Check.SequenceEqual(
            TouchTargetScan.TargetsAt(s2, i2, 200, 50),
            Array.Empty<string>(),
            "streamed clip (no record) → the same point is falsely clip-rejected");

        var (s3, i3) = Build(Scene());
        Check.SequenceEqual(TouchTargetScan.TargetsAt(s3, i3, 50, 50, rec), new[] { "card" }, "left column hits with the record");
        var (s4, i4) = Build(Scene());
        Check.SequenceEqual(TouchTargetScan.TargetsAt(s4, i4, 50, 50), new[] { "card" }, "left column hits without a record too");
    }

    // Multiple painted descendants of one widget collapse to a single distinct id.
    private static void DistinctIdsCollapsed()
    {
        var (state, index) = Build(
            Node("hand", null, "NHandCardHolder"), // hand ancestor
            Node("card", "hand", "NCard", 0, 0, 100, 100, texture: true),
            Node("art1", "card", "Sprite2D", 0, 0, 100, 100, texture: true),
            Node("art2", "card", "Sprite2D", 0, 0, 100, 100, text: true));
        var hit = TouchTargetScan.TargetsAt(state, index, 50, 50);
        Check.SequenceEqual(hit, new[] { "card" }, "two descendants of one card collapse to one distinct id");
    }
}
