namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Where a <c>CouchCoopModalDialog</c> parks keyboard/controller focus, given how the host is driving
/// the game right now.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the answer is not simply "the dismiss button".</b> On a mouse, a dialog whose only button is
/// already lit in its focus state reads as pre-selected, which is why focus originally parked on the
/// card: a <c>Panel</c> draws no focus visual. That reasoning is still right for a mouse and is kept.
/// </para>
/// <para>
/// <b>Why the card is wrong for a controller.</b> The card's comment claimed the arrow keys would walk
/// from it to the dismiss button. The Steam Deck leg measured that they do not — no focus visual appeared
/// anywhere in the dialog after any d-pad direction — and since
/// <see cref="CouchCoopButtonActivation.Resolve"/> gates on <c>IsFocused</c>, the select-action path could
/// never fire on the dismiss button. With a controller the alert could not be dismissed at all: A, Y,
/// Start and every direction left it up, and B backed the player out of the entire lobby. So on a
/// controller focus goes straight onto the one affordance the card has.
/// </para>
/// <para>
/// Split out of the dialog, and free of Godot types, for the same reason as
/// <see cref="CouchCoopButtonActivation"/>: the mod test suite has no Godot engine, so the rule is
/// ordinary C# here and the dialog is a thin ask-and-apply wrapper.
/// </para>
/// </remarks>
internal static class CouchCoopModalFocusParking
{
    /// <summary>The control the dialog should hand focus to.</summary>
    internal enum Target
    {
        /// <summary>Focus is already where it belongs — do not touch it.</summary>
        Leave,

        /// <summary>The card: focusable, but draws no focus visual.</summary>
        Card,

        /// <summary>The dismiss button, lit and activatable by the select action.</summary>
        Dismiss,
    }

    /// <summary>
    /// Where focus goes as the modal opens. Never <see cref="Target.Leave"/>: focus MUST come off the
    /// lobby control behind the scrim, or the select action would activate it straight through the dialog.
    /// </summary>
    /// <param name="isUsingController">
    /// <c>NControllerManager.IsUsingController</c> — the game's own notion of which input the host is on,
    /// the same flag <c>CouchCoopQrHotkeyHint</c> shows its glyph from.
    /// </param>
    internal static Target OnOpen(bool isUsingController)
        => isUsingController ? Target.Dismiss : Target.Card;

    /// <summary>
    /// Where focus goes when the input picture changes while the modal is ALREADY up — a host who puts
    /// the mouse down and picks up a pad must not be left with a dialog they cannot dismiss.
    /// </summary>
    /// <param name="isUsingController">As <see cref="OnOpen"/>.</param>
    /// <param name="isDismissFocused">Does the dismiss button hold focus right now?</param>
    /// <returns>
    /// The dismiss button once a controller is in use; the card when the host goes back to the mouse and
    /// the dismiss button is the thing lit up (so the "nothing looks pre-selected" look is restored);
    /// otherwise <see cref="Target.Leave"/> — in particular this never yanks focus off a body control a
    /// mouse user is part-way through, and never re-grabs focus the dismiss button already has.
    /// </returns>
    internal static Target OnInputModeChanged(bool isUsingController, bool isDismissFocused)
    {
        if (isUsingController)
        {
            return isDismissFocused ? Target.Leave : Target.Dismiss;
        }

        return isDismissFocused ? Target.Card : Target.Leave;
    }

    /// <summary>
    /// Where focus goes on the lobby panel's 0.25s heartbeat, while the modal is up.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This exists for the same reason as the cancel binding's re-assert: the lobby screen finishes its
    /// own setup AFTER a modal that popped by itself, and its setup both re-pushes the back button's
    /// hotkeys and calls <c>Select()</c> on a character button — which takes engine focus. A controller
    /// host would be left back where they started, with a dialog whose one button nothing can activate.
    /// </para>
    /// <para>
    /// Deliberately ASYMMETRIC to <see cref="OnInputModeChanged"/>: it only ever grabs FOR a controller
    /// and never parks back onto the card. A mouse user who clicks and HOLDS the dismiss button holds
    /// engine focus on it, and pulling that away four times a second would flicker the button's focus
    /// visual under their finger for no gain.
    /// </para>
    /// </remarks>
    internal static Target OnHeartbeat(bool isUsingController, bool isDismissFocused)
        => isUsingController && !isDismissFocused ? Target.Dismiss : Target.Leave;
}
