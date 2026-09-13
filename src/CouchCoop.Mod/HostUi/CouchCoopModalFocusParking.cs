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

        /// <summary>
        /// The first control in the dialog's focus chain — the top of what the player walks down. For a
        /// modal that declares no chain of its own that IS the dismiss button, so nothing changes for it.
        /// </summary>
        ChainHead,
    }

    /// <summary>
    /// Where engine focus sits right now, as far as one modal is concerned.
    /// </summary>
    /// <param name="IsInsideModal">
    /// Is the focus owner somewhere in this dialog that a player can actually USE — the dismiss button,
    /// or one of the body's rows? This is the predicate the re-grabbing rules below are written against,
    /// and it is deliberately NOT "is the dismiss button focused": once a dialog has a walkable chain, a
    /// player who d-pads onto one of its rows is inside the modal and must be left alone. Reading it as
    /// "dismiss focused" is what would yank them back to the close button within 250ms.
    /// <para>
    /// The dialog's CARD is deliberately excluded even though it is part of the dialog: it is the mouse's
    /// "nothing is selected" parking spot, it draws no focus visual and it has nothing to activate, so a
    /// controller left standing on it is as stranded as one whose focus the lobby stole.
    /// </para>
    /// </param>
    /// <param name="IsDismissFocused">
    /// Is the dismiss button itself the focus owner? Implies <paramref name="IsInsideModal"/>. Only the
    /// mouse-look rule needs this finer fact.
    /// </param>
    internal readonly record struct FocusState(bool IsInsideModal, bool IsDismissFocused);

    /// <summary>
    /// Where focus goes as the modal opens. Never <see cref="Target.Leave"/>: focus MUST come off the
    /// lobby control behind the scrim, or the select action would activate it straight through the dialog.
    /// </summary>
    /// <param name="isUsingController">
    /// Whether the host is driving without a mouse, from <c>CouchCoopHostInputMode</c> — which is the one
    /// place that knows the game reports this differently per build (a single boolean on v0.107.1, a
    /// three-way <c>InputType</c> on v0.111.0, where keyboard-only mode counts too).
    /// </param>
    internal static Target OnOpen(bool isUsingController)
        => isUsingController ? Target.Dismiss : Target.Card;

    /// <summary>
    /// Where focus goes when the input picture changes while the modal is ALREADY up — a host who puts
    /// the mouse down and picks up a pad must not be left with a dialog they cannot dismiss.
    /// </summary>
    /// <param name="isUsingController">As <see cref="OnOpen"/>.</param>
    /// <param name="focus">Where focus sits right now.</param>
    /// <returns>
    /// The dismiss button once a controller is in use and focus is NOT already somewhere in the dialog;
    /// the card when the host goes back to the mouse and the dismiss button is the thing lit up (so the
    /// "nothing looks pre-selected" look is restored); otherwise <see cref="Target.Leave"/> — in
    /// particular this never yanks focus off a body control either input is part-way through.
    /// </returns>
    internal static Target OnInputModeChanged(bool isUsingController, FocusState focus)
    {
        if (isUsingController)
        {
            return focus.IsInsideModal ? Target.Leave : Target.Dismiss;
        }

        return focus.IsDismissFocused ? Target.Card : Target.Leave;
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
    /// <para>
    /// <b>The predicate is "inside the modal", not "on the dismiss button".</b> While the dialog was a
    /// single pinned button those two were the same sentence. They are not once the dialog has a chain: a
    /// player who d-pads onto the QR dialog's host rows would be dragged back to the close button on the
    /// next scan, four times a second, and the rows would be unusable even though they are reachable.
    /// Where it grabs BACK to is still the dismiss button, because this fires when something outside took
    /// focus away and the guaranteed way out is what matters then.
    /// </para>
    /// </remarks>
    internal static Target OnHeartbeat(bool isUsingController, FocusState focus)
        => isUsingController && !focus.IsInsideModal ? Target.Dismiss : Target.Leave;

    /// <summary>
    /// Where focus goes when the dialog's own focus chain changes shape — the QR dialog's option list
    /// expanding or collapsing, or its rows being rebuilt by a re-scan.
    /// </summary>
    /// <remarks>
    /// The case this exists for: a controller host activates a host row, the list collapses under them,
    /// and Godot releases focus from the row it just hid — leaving the dialog with no focus owner at all,
    /// so the select action has nothing to fire on until the next heartbeat. Sending focus to the head of
    /// the chain (the selector they were just using) rather than to the dismiss button keeps them where
    /// they were working; the heartbeat's harsher answer is for focus that something OUTSIDE stole.
    /// <para>
    /// A mouse host is never moved. A row clicked with a mouse also holds engine focus, and grabbing to
    /// the chain head afterwards would light the selector's highlight up under the cursor — the same
    /// "nothing should look pre-selected" reasoning that parks a mouse on the card.
    /// </para>
    /// </remarks>
    internal static Target OnChainChanged(bool isUsingController, FocusState focus)
        => isUsingController && !focus.IsInsideModal ? Target.ChainHead : Target.Leave;
}
