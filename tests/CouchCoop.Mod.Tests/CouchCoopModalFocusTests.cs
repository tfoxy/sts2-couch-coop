using CouchCoop.Mod.HostUi;

// Steam Deck: can a controller drive a CouchCoop modal at all?
//
// Measured on a 1280x800 controller-driven host lobby: the host-transport alert ("Heads up") popped by
// itself and NOTHING on the pad would dismiss it — A, Y, Start and every d-pad direction left it up, and B
// backed the player out of the whole lobby. The cause on the focus side is that the dialog parked focus on
// its card (a Panel, which draws no focus visual), the d-pad did not walk from there to the dismiss button,
// and CouchCoopButtonActivation.Resolve gates on IsFocused — so the select-action path that landed in
// a6665773 could never fire on a button no controller could focus.
//
// The follow-up this suite also covers: closing that ring around a SINGLE button left the QR dialog's
// host-select rows orphaned — focusable, but nothing walked to them, so a Deck host could scan the default
// LAN address and nothing else. The ring is now a chain the dialog declares (CouchCoopModalFocusChain), and
// the rule below had to change with it: "should I take focus back?" is answered by whether focus is
// anywhere INSIDE the modal, not by whether the dismiss button holds it.
//
// WHAT THIS SUITE CAN AND CANNOT SEE. Same split, and same reason, as CouchCoopButtonActivationTests: the
// dialog is a Godot Control and constructing one needs a live engine this suite deliberately does not have,
// so the RULE lives in CouchCoopModalFocusParking as ordinary C# and is covered here. The Godot half —
// that NControllerManager.IsUsingController is read correctly, that GrabFocus lights the button, that
// IsAncestorOf answers the "inside the modal" question against a real focus owner, that the pinned focus
// neighbours keep the d-pad inside the dialog, and that the re-taken cancel binding beats the lobby's back
// button — is NOT exercised here and needs a real pad in front of the game.
//
// One consequence of that split worth naming, because it is invisible from in here: a mouse host parked on
// the dialog's CARD reports IsInsideModal FALSE, not true. The card is the "nothing is selected" spot — no
// focus visual, nothing to activate — so a controller left on it is stranded exactly like one whose focus
// the lobby stole, and the rules below must treat it as outside. That mapping lives in the dialog.
internal static class CouchCoopModalFocusTests
{
    // Focus states, named once so the cases below read as sentences.
    private static readonly CouchCoopModalFocusParking.FocusState Outside = new(IsInsideModal: false, IsDismissFocused: false);
    private static readonly CouchCoopModalFocusParking.FocusState OnDismiss = new(IsInsideModal: true, IsDismissFocused: true);
    private static readonly CouchCoopModalFocusParking.FocusState OnARow = new(IsInsideModal: true, IsDismissFocused: false);

    public static void Run()
    {
        MouseParkingIsUnchanged();
        AControllerGetsTheDismissButton();
        PickingUpAPadMovesFocusToTheButton();
        APadRedetectedOnARowLeavesThatRowAlone();
        GoingBackToTheMouseUnlightsTheButton();
        NothingElseIsDisturbed();
        TheHeartbeatTakesFocusBackForAControllerOnly();
        TheHeartbeatLeavesAPlayerStandingOnARow();
        ACollapsedListSendsAControllerToTheChainHead();
        AChainChangeNeverMovesAMouseHost();

        Console.WriteLine("CouchCoopModalFocusTests: ok");
    }

    // The pre-existing look, pinned: on a mouse the dialog opens with nothing lit up, because a lone button
    // that opens already in its focus state reads as pre-selected.
    private static void MouseParkingIsUnchanged()
        => Expect(
            CouchCoopModalFocusParking.OnOpen(isUsingController: false) == CouchCoopModalFocusParking.Target.Card,
            "a mouse host opens the modal with focus parked on the card");

    // The fix. Note this is never Target.Leave: focus must come OFF the lobby control behind the scrim
    // either way, or the select action would activate it through the dialog.
    private static void AControllerGetsTheDismissButton()
        => Expect(
            CouchCoopModalFocusParking.OnOpen(isUsingController: true) == CouchCoopModalFocusParking.Target.Dismiss,
            "a controller host opens the modal with focus on the dismiss button");

    // A host who puts the mouse down and picks up a pad while the alert is already up must not be stuck.
    private static void PickingUpAPadMovesFocusToTheButton()
    {
        Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: true, Outside)
                == CouchCoopModalFocusParking.Target.Dismiss,
            "a pad picked up while the modal is open moves focus to the dismiss button");
        Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: true, OnDismiss)
                == CouchCoopModalFocusParking.Target.Leave,
            "a pad re-detected while the button already has focus does not re-grab it");
    }

    // Changed by the chain. The old rule asked only "is the dismiss button focused", so a controller host
    // standing on a host-select row was sent back to the close button by any re-detection of their own pad.
    private static void APadRedetectedOnARowLeavesThatRowAlone()
        => Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: true, OnARow)
                == CouchCoopModalFocusParking.Target.Leave,
            "a pad re-detected while focus is on a dialog row leaves that row focused");

    private static void GoingBackToTheMouseUnlightsTheButton()
        => Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: false, OnDismiss)
                == CouchCoopModalFocusParking.Target.Card,
            "going back to the mouse parks focus off the lit button, restoring the mouse look");

    // The one case that must do nothing: a mouse user whose focus is somewhere else entirely (a body
    // control, or the card it already sits on). Yanking it would be a regression for the mouse path, which
    // this change is not allowed to touch.
    private static void NothingElseIsDisturbed()
        => Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: false, Outside)
                == CouchCoopModalFocusParking.Target.Leave,
            "a mouse host whose focus is not on the dismiss button keeps it");

    // The 0.25s heartbeat: the lobby screen finishes its own setup after a modal that popped by itself,
    // and that setup grabs focus (it calls Select() on a character button). Taking focus back is for the
    // controller only — a mouse user holding the dismiss button down holds engine focus on it, and pulling
    // that away four times a second would flicker the focus visual under their finger.
    private static void TheHeartbeatTakesFocusBackForAControllerOnly()
    {
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: true, Outside)
                == CouchCoopModalFocusParking.Target.Dismiss,
            "the heartbeat takes focus back for a controller when something stole it");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: true, OnDismiss)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat does not re-grab focus the dismiss button already has");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: false, Outside)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat never moves a mouse host's focus");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: false, OnDismiss)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat never pulls focus off a dismiss button a mouse host is holding");
    }

    // The trap the chain created, and the reason the predicate had to change. Under the old rule this case
    // returned Dismiss: a player who d-padded down onto a host-select row was dragged back to the close
    // button within 250ms, and the rows would have been reachable but unusable.
    private static void TheHeartbeatLeavesAPlayerStandingOnARow()
        => Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: true, OnARow)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat leaves a controller host standing on a dialog row");

    // Activating a row collapses the list, and Godot releases focus from the row it just hid — so the
    // dialog is left with no focus owner and the select action has nothing to fire on. The chain head (the
    // selector they were just using) is where they came from, so that is where they go back to.
    private static void ACollapsedListSendsAControllerToTheChainHead()
    {
        Expect(
            CouchCoopModalFocusParking.OnChainChanged(isUsingController: true, Outside)
                == CouchCoopModalFocusParking.Target.ChainHead,
            "a chain change that left focus nowhere sends a controller to the head of the chain");
        Expect(
            CouchCoopModalFocusParking.OnChainChanged(isUsingController: true, OnARow)
                == CouchCoopModalFocusParking.Target.Leave,
            "a chain change does not move a controller whose focus is still inside the dialog");
    }

    // A row clicked with a mouse holds engine focus too, and grabbing to the chain head after the list
    // collapses would light the selector's highlight up under the cursor.
    private static void AChainChangeNeverMovesAMouseHost()
    {
        Expect(
            CouchCoopModalFocusParking.OnChainChanged(isUsingController: false, Outside)
                == CouchCoopModalFocusParking.Target.Leave,
            "a chain change never moves a mouse host's focus");
        Expect(
            CouchCoopModalFocusParking.OnChainChanged(isUsingController: false, OnDismiss)
                == CouchCoopModalFocusParking.Target.Leave,
            "a chain change never pulls a mouse host off the dismiss button");
    }

    private static void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopModalFocusTests: {what}");
        }
    }
}
