using CouchCoop.Mod.HostUi;

// Steam Deck: can a controller dismiss a CouchCoop modal at all?
//
// Measured on a 1280x800 controller-driven host lobby: the host-transport alert ("Heads up") popped by
// itself and NOTHING on the pad would dismiss it — A, Y, Start and every d-pad direction left it up, and B
// backed the player out of the whole lobby. The cause on the focus side is that the dialog parked focus on
// its card (a Panel, which draws no focus visual), the d-pad did not walk from there to the dismiss button,
// and CouchCoopButtonActivation.Resolve gates on IsFocused — so the select-action path that landed in
// a6665773 could never fire on a button no controller could focus.
//
// WHAT THIS SUITE CAN AND CANNOT SEE. Same split, and same reason, as CouchCoopButtonActivationTests: the
// dialog is a Godot Control and constructing one needs a live engine this suite deliberately does not have,
// so the RULE lives in CouchCoopModalFocusParking as ordinary C# and is covered here. The Godot half —
// that NControllerManager.IsUsingController is read correctly, that GrabFocus lights the button, that the
// pinned focus neighbours keep the d-pad inside the dialog, and that the re-taken cancel binding beats the
// lobby's back button — is NOT exercised here and needs a real pad in front of the game.
internal static class CouchCoopModalFocusTests
{
    public static void Run()
    {
        MouseParkingIsUnchanged();
        AControllerGetsTheDismissButton();
        PickingUpAPadMovesFocusToTheButton();
        GoingBackToTheMouseUnlightsTheButton();
        NothingElseIsDisturbed();
        TheHeartbeatTakesFocusBackForAControllerOnly();

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
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: true, isDismissFocused: false)
                == CouchCoopModalFocusParking.Target.Dismiss,
            "a pad picked up while the modal is open moves focus to the dismiss button");
        Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: true, isDismissFocused: true)
                == CouchCoopModalFocusParking.Target.Leave,
            "a pad re-detected while the button already has focus does not re-grab it");
    }

    private static void GoingBackToTheMouseUnlightsTheButton()
        => Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: false, isDismissFocused: true)
                == CouchCoopModalFocusParking.Target.Card,
            "going back to the mouse parks focus off the lit button, restoring the mouse look");

    // The one case that must do nothing: a mouse user whose focus is somewhere else entirely (a body
    // control, or the card it already sits on). Yanking it would be a regression for the mouse path, which
    // this change is not allowed to touch.
    private static void NothingElseIsDisturbed()
        => Expect(
            CouchCoopModalFocusParking.OnInputModeChanged(isUsingController: false, isDismissFocused: false)
                == CouchCoopModalFocusParking.Target.Leave,
            "a mouse host whose focus is not on the dismiss button keeps it");

    // The 0.25s heartbeat: the lobby screen finishes its own setup after a modal that popped by itself,
    // and that setup grabs focus (it calls Select() on a character button). Taking focus back is for the
    // controller only — a mouse user holding the dismiss button down holds engine focus on it, and pulling
    // that away four times a second would flicker the focus visual under their finger.
    private static void TheHeartbeatTakesFocusBackForAControllerOnly()
    {
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: true, isDismissFocused: false)
                == CouchCoopModalFocusParking.Target.Dismiss,
            "the heartbeat takes focus back for a controller when something stole it");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: true, isDismissFocused: true)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat does not re-grab focus the dismiss button already has");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: false, isDismissFocused: false)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat never moves a mouse host's focus");
        Expect(
            CouchCoopModalFocusParking.OnHeartbeat(isUsingController: false, isDismissFocused: true)
                == CouchCoopModalFocusParking.Target.Leave,
            "the heartbeat never pulls focus off a dismiss button a mouse host is holding");
    }

    private static void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"CouchCoopModalFocusTests: {what}");
        }
    }
}
