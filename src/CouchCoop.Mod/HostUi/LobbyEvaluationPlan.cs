namespace CouchCoop.Mod.HostUi;

/// <summary>One registered lobby screen, as the evaluation sees it.</summary>
/// <param name="Id">The Godot instance id, for the checkpoint record only.</param>
/// <param name="Visible">
/// <c>IsVisibleInTree</c>. Panel REMOVAL is driven by this and nothing else — see
/// <see cref="LobbyEvaluationPlanner.IsParkedUnderAnotherScreen"/>.
/// </param>
/// <param name="Current">
/// Is this the screen the player is actually on (<c>Sts2ScreenContext.IsCurrent</c>)? Strictly stronger than
/// <paramref name="Visible"/>: a screen can sit visible underneath a modal or a submenu and still not be current.
/// Always <see langword="false"/> when the seam could not answer — which is what
/// <c>currentScreenKnown</c> is for.
/// </param>
internal readonly record struct LobbyScreenFacts(ulong Id, bool Visible, bool Current);

/// <summary>What an evaluation does with <c>HostTransportAlert</c>'s once-per-mount latch.</summary>
internal enum LobbyAlertUpdate
{
    /// <summary>Decide from the panel this evaluation mounted (possibly none) — the normal path.</summary>
    Decide,

    /// <summary>
    /// No lobby is on screen at all: decide with "nothing mounted", which RE-ARMS the latch so returning to a
    /// lobby shows the alert again.
    /// </summary>
    Rearm,

    /// <summary>
    /// A lobby screen is visible but is not the current screen. Leave the latch exactly as it is: the alert
    /// is a once-per-MOUNT modal, and a modal opening over the lobby is not an unmount. Re-arming here would
    /// pop the alert again every time the player closed a dialog.
    /// </summary>
    Hold,
}

/// <summary>What one evaluation should do, decided before anything fallible runs.</summary>
/// <param name="PullState">
/// Whether to read <c>CouchCoopMod.TryGetLobbyState()</c> — the expensive half of an evaluation, and the only
/// thing that can answer host-vs-not.
/// </param>
/// <param name="KeepTicking">
/// Whether the bounded 0.25s chain should keep running. It exists for ONE reason: <c>netGameType</c> flips live
/// while the host sits in the lobby (a singleplayer lobby becoming a host lobby), so presence alone cannot be
/// read once and trusted. Outside a current lobby there is nothing for it to re-read, so it parks.
/// </param>
/// <param name="Alert">See <see cref="LobbyAlertUpdate"/>.</param>
internal readonly record struct LobbyEvaluationPlan(bool PullState, bool KeepTicking, LobbyAlertUpdate Alert);

/// <summary>
/// The rule that decides whether a lobby evaluation pulls state and whether the tick chain survives it.
/// </summary>
/// <remarks>
/// <para>
/// THIS EXISTS TO DELETE A TICK THAT NEVER PARKED. <see cref="LobbyScreenRegistry"/> already removed the 4 Hz
/// whole-tree walk, but the chain it gates is started when a lobby screen is READIED and stops only when every
/// registered screen has been FREED — and the game readies its character-select screen during main-menu load and
/// then keeps that node for the rest of the process. So in practice the timer started at the main menu and ran
/// for the whole session: a registry prune plus one <c>IsVisibleInTree</c> per screen, four times a second,
/// through combat, the map and the menu, on every platform. Presence is now pushed (the game's active-screen
/// event, plus Godot's own <c>visibility_changed</c> on the registered screens) and the timer only exists while a
/// lobby screen is the CURRENT screen.
/// </para>
/// <para>
/// Godot-free by construction, in the style of <see cref="LobbyScreenRegistry"/> and
/// <see cref="HostTransportAlert"/>: the controller gathers facts from the engine and this decides, so the
/// gate is unit-testable with no engine behind the process.
/// </para>
/// <para>
/// <c>currentScreenKnown</c> is the safety valve, and it is the reason this takes a flag rather than reading
/// <see cref="LobbyScreenFacts.Current"/> alone. "Not current" and "could not tell" are the same bit in the
/// facts and must NOT mean the same thing: a game build whose active-screen seam has moved would otherwise
/// report every screen as not-current forever, and the QR button would never install again. When the seam
/// cannot answer — no subscription, or no resolvable current screen — this degrades to exactly the pre-existing
/// behaviour: pull on visible, tick unconditionally.
/// </para>
/// </remarks>
internal static class LobbyEvaluationPlanner
{
    public static LobbyEvaluationPlan Decide(IReadOnlyList<LobbyScreenFacts> screens, bool currentScreenKnown)
    {
        if (screens.Count == 0)
        {
            // No lobby in the tree at all. Nothing to tick for, and as far as the alert is concerned this is
            // an unmount.
            return new LobbyEvaluationPlan(PullState: false, KeepTicking: false, LobbyAlertUpdate.Rearm);
        }

        var anyVisible = false;
        var anyCurrentVisible = false;
        foreach (var screen in screens)
        {
            if (!screen.Visible)
            {
                continue;
            }

            anyVisible = true;
            if (screen.Current)
            {
                anyCurrentVisible = true;
                break;
            }
        }

        if (!currentScreenKnown)
        {
            // The pre-change rule, kept verbatim: state is pulled whenever anything is visible, and the chain
            // never parks while a screen is registered.
            return new LobbyEvaluationPlan(
                PullState: anyVisible,
                KeepTicking: true,
                anyVisible ? LobbyAlertUpdate.Decide : LobbyAlertUpdate.Rearm);
        }

        if (anyCurrentVisible)
        {
            return new LobbyEvaluationPlan(PullState: true, KeepTicking: true, LobbyAlertUpdate.Decide);
        }

        return new LobbyEvaluationPlan(
            PullState: false,
            KeepTicking: false,
            anyVisible ? LobbyAlertUpdate.Hold : LobbyAlertUpdate.Rearm);
    }

    /// <summary>
    /// Whether this screen must be left ENTIRELY alone this evaluation — panel included.
    /// </summary>
    /// <remarks>
    /// The game's current-screen answer is whatever is on top, which includes a modal opened OVER the lobby. So
    /// "not current ⇒ remove the panel" would tear the panel down the moment any modal appeared — and CouchCoop's
    /// own QR dialog is a CHILD of that panel, so it would take the dialog with it. Removal therefore stays keyed
    /// on VISIBILITY, exactly as before this change, and not-current only suppresses the state pull. Closing the
    /// modal raises the active-screen event, which re-evaluates, so nothing is lost by waiting.
    /// </remarks>
    public static bool IsParkedUnderAnotherScreen(LobbyScreenFacts screen, bool currentScreenKnown)
        => currentScreenKnown && screen.Visible && !screen.Current;
}
