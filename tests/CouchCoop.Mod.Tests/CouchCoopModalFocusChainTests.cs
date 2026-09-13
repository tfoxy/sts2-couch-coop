using CouchCoop.Mod.HostUi;

// The shape of a modal's focus ring. This is the half of the Steam Deck reachability fix that decides
// WHICH controls a d-pad walks and which two each one walks to; where focus goes when something takes it
// away is CouchCoopModalFocusTests.
//
// The bug it exists for: pinning the ring around the dismiss button alone (80de5c2c) closed the escape onto
// a lobby control behind the scrim, but orphaned the QR dialog's host-select rows — they were focusable and
// nothing walked to them, so a Deck host could scan the default LAN address and could not switch adapter or
// pick the HTTPS option at all.
//
// Pure C# by construction, so unlike the dialog itself this IS covered here. What is not: that the NodePath
// the dialog writes from a Link resolves to the right node, and that Godot honours it. That needs a pad.
internal static class CouchCoopModalFocusChainTests
{
    public static void Run()
    {
        ALoneDismissButtonIsTheOldSelfPinnedRing();
        TheChainWrapsAtBothEnds();
        UnfocusableControlsDropOut();
        TheDismissButtonIsNeverDroppedFromTheChain();
        AChainMustBeDeclared();
        KeyboardStartsAndWrapsInsideTheModal();

        Console.WriteLine("CouchCoopModalFocusChainTests: ok");
    }

    // A modal that declares no chain of its own (the host-transport alert) must behave EXACTLY as it did
    // before chains existed: one control whose up and down are itself. That is the live-verified state —
    // eight d-pad presses moved focus nowhere — so it is the thing this refactor must not change.
    private static void ALoneDismissButtonIsTheOldSelfPinnedRing()
    {
        var participants = CouchCoopModalFocusChain.Participants([true]);
        Expect(participants.Count == 1 && participants[0] == 0, "a lone dismiss button is the whole chain");

        var link = CouchCoopModalFocusChain.Neighbors(0, 1);
        Expect(link.Previous == 0 && link.Next == 0, "a one-control chain pins both neighbours to itself");
    }

    // The QR dialog's shape: selector, rows, dismiss. The ends are what matter — an unset neighbour is
    // where Godot's viewport-wide geometric search takes over and hands focus to the lobby behind the scrim.
    private static void TheChainWrapsAtBothEnds()
    {
        const int count = 4;

        var head = CouchCoopModalFocusChain.Neighbors(0, count);
        Expect(head.Previous == count - 1, "up from the head of the chain wraps to the dismiss button");
        Expect(head.Next == 1, "down from the head of the chain is the next control");

        var tail = CouchCoopModalFocusChain.Neighbors(count - 1, count);
        Expect(tail.Next == 0, "down from the dismiss button wraps back to the head of the chain");
        Expect(tail.Previous == count - 2, "up from the dismiss button is the control above it");

        var middle = CouchCoopModalFocusChain.Neighbors(2, count);
        Expect(middle.Previous == 1 && middle.Next == 3, "a control in the middle walks to its neighbours");
    }

    // A greyed-out host row (no usable address, HTTPS unavailable) is set FocusMode.None, and a chain that
    // steps onto one is a dead end. It drops out and the walk closes over what is left.
    private static void UnfocusableControlsDropOut()
    {
        var participants = CouchCoopModalFocusChain.Participants([true, false, true, false, true]);
        Expect(
            participants.Count == 3 && participants[0] == 0 && participants[1] == 2 && participants[2] == 4,
            "unfocusable controls drop out of the chain, in declared order");
    }

    // The failure this guards is total, not cosmetic: an empty chain is a modal with no closed ring at all,
    // and the d-pad goes straight back to escaping onto the lobby.
    private static void TheDismissButtonIsNeverDroppedFromTheChain()
    {
        var participants = CouchCoopModalFocusChain.Participants([false, false, false]);
        Expect(
            participants.Count == 1 && participants[0] == 2,
            "the dismiss button stays in the chain even if it reports itself unfocusable");
    }

    private static void KeyboardStartsAndWrapsInsideTheModal()
    {
        Expect(CouchCoopModalFocusChain.KeyboardTarget(-1, 8, false) == 0, "Tab leaves parking for the first modal control");
        Expect(CouchCoopModalFocusChain.KeyboardTarget(-1, 8, true) == 7, "Shift+Tab leaves parking for Close");
        Expect(CouchCoopModalFocusChain.KeyboardTarget(7, 8, false) == 0, "Tab after Close returns to the first row");
        Expect(CouchCoopModalFocusChain.KeyboardTarget(0, 8, true) == 7, "Shift+Tab before the first row returns to Close");
        Expect(CouchCoopModalFocusChain.KeyboardTarget(3, 8, false) == 4, "Tab advances once through details and actions");
        Expect(CouchCoopModalFocusChain.KeyboardTarget(4, 8, true) == 3, "Shift+Tab reverses one step");
    }

    private static void AChainMustBeDeclared()
    {
        try
        {
            CouchCoopModalFocusChain.Participants([]);
        }
        catch (ArgumentException)
        {
            return;
        }

        throw new InvalidOperationException("CouchCoopModalFocusChainTests: an empty declaration must be rejected");
    }

    private static void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopModalFocusChainTests: {what}");
        }
    }
}
