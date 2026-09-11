using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for HandChoiceScan — the pure #12 signal behind GestureCallbacks.HandChoiceActive. A from-hand card
// CHOICE screen (NChooseACardSelectionScreen: Survivor discard / exhaust / enchant) that is EFFECTIVELY visible ⇒
// IsActive true (a hand-card tap then single-taps). The card GRID screen (NCardGridSelectionScreen) is NOT a
// hand-choice. Web twin: mirrorRenderer.handChoiceActive.
internal static class HandChoiceScanTests
{
    public static void Run()
    {
        VisibleChooseACardScreenIsActive();
        HiddenChooseACardScreenIsNotActive();
        AncestorHiddenChooseACardScreenIsNotActive();
        NoChoiceScreenIsNotActive();
        CardGridScreenIsNotAHandChoice();
        VisibleSelectModeBackstopIsActive();
        HiddenSelectModeBackstopIsNotActive();
    }

    private static MirrorNode Node(string id, string? parent, string type, bool visible = true) => new()
    {
        Id = id,
        ParentId = parent,
        NodeType = type,
        Name = id,
        Visible = visible,
    };

    private static MirrorState Build(params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var n in nodes)
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
        }

        state.Revision = 1;
        return state;
    }

    private static void VisibleChooseACardScreenIsActive()
    {
        var state = Build(
            Node("root", null, "Node"),
            Node("screen", "root", "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen"));
        Check.That(HandChoiceScan.IsActive(state), "a visible NChooseACardSelectionScreen → hand-choice active");
    }

    private static void HiddenChooseACardScreenIsNotActive()
    {
        var state = Build(
            Node("root", null, "Node"),
            Node("screen", "root", "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen", visible: false));
        Check.That(!HandChoiceScan.IsActive(state), "a hidden choose-a-card screen → not active");
    }

    private static void AncestorHiddenChooseACardScreenIsNotActive()
    {
        var state = Build(
            Node("root", null, "Node"),
            Node("group", "root", "Node", visible: false),
            Node("screen", "group", "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NChooseACardSelectionScreen"));
        Check.That(!HandChoiceScan.IsActive(state), "an ancestor-hidden choose-a-card screen → not active");
    }

    private static void NoChoiceScreenIsNotActive()
    {
        var state = Build(
            Node("root", null, "Node"),
            Node("hand", "root", "MegaCrit.Sts2.Core.Nodes.Cards.Holders.NPlayerHand"));
        Check.That(!HandChoiceScan.IsActive(state), "no choose-a-card screen → not active");
    }

    private static void CardGridScreenIsNotAHandChoice()
    {
        // The card GRID selection screen is EXCLUDED because its cards are not hand cards. TouchTargetScan applies
        // the grid's separate immediate-click block, so this signal must not pretend an in-hand choice is active.
        var state = Build(
            Node("root", null, "Node"),
            Node("grid", "root", "MegaCrit.Sts2.Core.Nodes.Screens.CardSelection.NCardGridSelectionScreen"));
        Check.That(!HandChoiceScan.IsActive(state), "a card-grid selection screen is NOT a hand-choice");
    }

    private static void VisibleSelectModeBackstopIsActive()
    {
        // The in-hand SELECT mode (Survivor discard / exhaust / enchant) hosts no NChooseACardSelectionScreen — its one
        // select-mode-exclusive node is the player_hand.tscn backstop NAMED "SelectModeBackstop" (a plain ColorRect, so
        // it is matched by NAME, not type leaf). Node() sets Name = id, so the id doubles as the node name here.
        var state = Build(
            Node("root", null, "MegaCrit.Sts2.Core.Nodes.Cards.Holders.NPlayerHand"),
            Node("SelectModeBackstop", "root", "ColorRect"));
        Check.That(HandChoiceScan.IsActive(state), "a visible SelectModeBackstop (in-hand select mode) → hand-choice active");
    }

    private static void HiddenSelectModeBackstopIsNotActive()
    {
        var state = Build(
            Node("root", null, "MegaCrit.Sts2.Core.Nodes.Cards.Holders.NPlayerHand"),
            Node("SelectModeBackstop", "root", "ColorRect", visible: false));
        Check.That(!HandChoiceScan.IsActive(state), "a hidden SelectModeBackstop (normal combat) → not active");
    }
}
