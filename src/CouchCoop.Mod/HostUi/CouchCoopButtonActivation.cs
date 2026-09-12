namespace CouchCoop.Mod.HostUi;

/// <summary>
/// The decision behind <c>CouchCoopTextureButton</c>'s click path: given one already-classified
/// <c>gui_input</c> event and the control's state, does this button press, release, or ignore it?
/// </summary>
/// <remarks>
/// <para>
/// Split out of the button so it is testable. <c>CouchCoopTextureButton</c> derives from the game's
/// <c>NButton</c>, and constructing one needs a live Godot engine — the mod test suite deliberately has
/// none (it links GodotSharp for metadata reflection only, and a native call there is an uncatchable
/// SIGSEGV). Everything Godot-shaped therefore stays on the button as a thin classify-and-dispatch
/// wrapper, and the rule that decides the outcome lives here, in ordinary C#.
/// </para>
/// <para>
/// <b>Why the select action is here at all.</b> A Steam Deck in Game Mode has no mouse: the player
/// navigates with the stick and activates with A. The game's own clickable controls act on
/// <c>MegaInput.select</c> in <c>_GuiInput</c>, but that script virtual is never dispatched into this
/// assembly (see the remarks on <c>CouchCoopTextureButton</c>), so before this existed a controller
/// could focus a CouchCoop button and pressing A did nothing at all.
/// </para>
/// </remarks>
internal static class CouchCoopButtonActivation
{
    /// <summary>One <c>gui_input</c> event, reduced to the only distinctions the rule below cares about.</summary>
    internal enum Input
    {
        /// <summary>Not an event this control acts on.</summary>
        None,

        /// <summary>Left mouse button down.</summary>
        MousePress,

        /// <summary>Left mouse button up.</summary>
        MouseRelease,

        /// <summary>The <c>MegaInput.select</c> action went down — a controller's A, or the keyboard equivalent.</summary>
        SelectPress,

        /// <summary>The <c>MegaInput.select</c> action came up.</summary>
        SelectRelease,
    }

    /// <summary>What the button should do about it.</summary>
    internal enum Outcome
    {
        /// <summary>Nothing.</summary>
        None,

        /// <summary>Run the base's press handler.</summary>
        Press,

        /// <summary>Run the base's release handler.</summary>
        Release,
    }

    /// <summary>
    /// The game's own clickable gate — enabled, visible in the tree, and focused — applied to both input
    /// sources alike.
    /// </summary>
    /// <param name="input">The classified event.</param>
    /// <param name="isEnabled">The control's <c>IsEnabled</c>.</param>
    /// <param name="isVisibleInTree">The control's <c>IsVisibleInTree()</c>.</param>
    /// <param name="isFocused">
    /// The control's <c>IsFocused</c> — the base's own notion, which is hovered OR controller-focused.
    /// A controller user satisfies it by navigating onto the button: the base wires that half to the
    /// native <c>focus_entered</c> signal, which reaches a Callable with no script instance, so it works
    /// in this assembly where the virtuals do not.
    /// </param>
    /// <returns>
    /// The handler to run, or <see cref="Outcome.None"/>. Both handlers are idempotent (the base latches
    /// a press, and the button's own <c>OnPress</c> re-checks that latch), so a configuration where
    /// Godot script dispatch DOES deliver <c>_GuiInput</c> as well cannot double-fire the click.
    /// </returns>
    internal static Outcome Resolve(Input input, bool isEnabled, bool isVisibleInTree, bool isFocused)
    {
        if (input == Input.None || !isEnabled || !isVisibleInTree || !isFocused)
        {
            return Outcome.None;
        }

        return input switch
        {
            Input.MousePress or Input.SelectPress => Outcome.Press,
            Input.MouseRelease or Input.SelectRelease => Outcome.Release,
            _ => Outcome.None,
        };
    }
}
