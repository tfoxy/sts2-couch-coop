using System;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
#if STS2_API_V111
// Aliased rather than imported: the game's enum shares its name with the controller manager's property that
// carries it, and an unqualified `InputType` in both positions reads as a typo.
using GameInputType = MegaCrit.Sts2.Core.ControllerInput.InputType;
#endif

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// How the host is driving the game right now, as the two facts CouchCoop's own host UI needs.
/// </summary>
/// <remarks>
/// <para>
/// This is the ONLY place in couch that reads the game's input mode, and it exists because the game changed
/// how it reports it. v0.107.1 offers a single boolean, <c>NControllerManager.IsUsingController</c>.
/// v0.111.0 removed that and replaced it with <c>NControllerManager.InputType</c>
/// (<c>MouseAndKeyboard</c> / <c>KeyboardOnlyMode</c> / <c>Controller</c>) — a hard compile break, and a
/// semantically richer answer.
/// </para>
/// <para>
/// The two facts are separated because they are genuinely different questions on the newer build, and the
/// callers want different ones:
/// </para>
/// <list type="bullet">
/// <item><see cref="HostInputMode.WithoutMouse"/> — the host cannot point at things, so anything that relies on
/// the focus ring has to be reachable. Both non-mouse modes qualify: the mouse is taken off screen in each,
/// and a keyboard-only host needs a parked dismiss button exactly as much as a pad does.</item>
/// <item><see cref="HostInputMode.OnController"/> — narrower, and only for a CONTROLLER BUTTON glyph. The
/// game's <c>GetHotkeyIcon</c> resolves through the controller map, so showing it to a keyboard-only host
/// would name a button they do not have.</item>
/// </list>
/// <para>
/// On v0.107.1 the two are the same fact, because that build has no keyboard-only mode to distinguish. So the
/// two lanes behave differently on purpose: the difference is the game's, not a compatibility shim.
/// </para>
/// <para>
/// <b>Keep it the only reader.</b> Two separate call sites grew an unguarded
/// <c>NControllerManager.Instance?.IsUsingController</c> within a day of each other, and the second one broke
/// the beta build after the first had been fixed. Route new host-UI input-mode questions through here.
/// </para>
/// </remarks>
internal static class CouchCoopHostInputMode
{
    /// <summary>
    /// Reads the game's current input mode. Returns <see langword="default"/> — mouse present, no controller —
    /// whenever the manager cannot be reached or throws, because every caller is an affordance and none of them
    /// is worth taking a lobby down for.
    /// </summary>
    internal static HostInputMode Read()
    {
        try
        {
            if (NControllerManager.Instance is not { } controllers)
            {
                return default;
            }

#if STS2_API_V111
            var inputType = controllers.InputType;
            return new HostInputMode(
                WithoutMouse: inputType is GameInputType.Controller or GameInputType.KeyboardOnlyMode,
                OnController: inputType is GameInputType.Controller);
#else
            // v0.107.1 has no keyboard-only mode to distinguish, so the one boolean answers both questions.
            var usingController = controllers.IsUsingController;
            return new HostInputMode(WithoutMouse: usingController, OnController: usingController);
#endif
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[couch-coop] host input mode read failed detail={exception.GetType().Name}: {exception.Message}");
            return default;
        }
    }
}

/// <param name="WithoutMouse">The host is driving by focus ring: a controller, or keyboard-only mode.</param>
/// <param name="OnController">The host is on a controller specifically — the only case a pad glyph fits.</param>
internal readonly record struct HostInputMode(bool WithoutMouse, bool OnController);
