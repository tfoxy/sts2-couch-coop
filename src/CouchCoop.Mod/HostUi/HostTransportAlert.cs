namespace CouchCoop.Mod.HostUi;

using CouchCoop.Mod.Localization;

/// <summary>
/// The once-per-mount latch behind the host-transport alert, as a value. Nothing here touches disk.
/// </summary>
/// <param name="Mounted">Was a host lobby on screen at the previous decision?</param>
/// <param name="ShownThisMount">Has the alert already popped during the CURRENT mount?</param>
public readonly record struct HostTransportAlertState(bool Mounted, bool ShownThisMount)
{
    /// <summary>Nothing mounted, nothing shown — also the state an unmount returns to.</summary>
    public static HostTransportAlertState Initial => default;
}

/// <summary>
/// What to do about the host-transport alert this tick: the state to carry forward, and whether to open.
/// </summary>
/// <param name="Next">The state the caller must store; ignoring it breaks the once-per-mount rule.</param>
/// <param name="Open">True on exactly the one tick the modal should be shown.</param>
/// <param name="Text">
/// The note to render, already trimmed. Empty whenever <paramref name="Open"/> is false, so the caller
/// never has to decide between two strings.
/// </param>
public readonly record struct HostTransportAlertDecision(HostTransportAlertState Next, bool Open, string Text);

/// <summary>
/// Decides when the host gets a modal about a degraded hosting transport (today: Steam initialised but
/// offline, so remote friends cannot join and only couch/LAN play works).
/// </summary>
/// <remarks>
/// <para>
/// Pure, in the style of <see cref="QrHostOptions.Build"/>, so the whole rule is testable
/// without a game: the dialog is a thin renderer that asks this once per scan tick and does what it says.
/// </para>
/// <para>
/// <b>Once per MOUNT, and the latch is memory only.</b> The note used to appear solely as a small tip
/// line inside the QR dialog, which a host who never opens that dialog never sees — they just wonder why
/// their friend cannot connect. It now pops as a modal, but a modal that can only ever be seen once per
/// process would be worse than the tip line the moment a host backs out to the menu and comes back. So
/// the latch re-arms on unmount and there is deliberately NO persistence: nothing in
/// <c>COUCHCOOP_QR_PREFS</c>, no preference file, no "don't show again". Entering the lobby is the
/// event; leaving it is the reset.
/// </para>
/// <para>
/// The note is not latched until it is actually SHOWN, so a transport that reports its state a beat after
/// the lobby appears still gets its alert during that same mount rather than being swallowed.
/// </para>
/// </remarks>
public static class HostTransportAlert
{
    public static HostTransportAlertDecision Decide(
        HostTransportAlertState state,
        bool hostLobbyMounted,
        CouchCoopText? transportNote)
        => Decide(state, hostLobbyMounted, transportNote?.Resolve());

    /// <param name="state">The value returned by the previous call; start from <see cref="HostTransportAlertState.Initial"/>.</param>
    /// <param name="hostLobbyMounted">
    /// Is the couch-coop host lobby on screen right now — i.e. <see cref="CouchCoopLobbyHostGate.ShouldShow"/>
    /// held AND a panel is actually installed on a visible screen. Anything else (main menu, a run in
    /// progress, a singleplayer or client lobby) counts as unmounted and re-arms the latch.
    /// </param>
    /// <param name="transportNote">
    /// <see cref="CouchCoopHostUiNotices.HostTransportNote"/>. Null/blank means the transport is healthy
    /// (or has not reported yet) and there is nothing to warn about.
    /// </param>
    public static HostTransportAlertDecision Decide(
        HostTransportAlertState state,
        bool hostLobbyMounted,
        string? transportNote)
    {
        if (!hostLobbyMounted)
        {
            return new HostTransportAlertDecision(HostTransportAlertState.Initial, Open: false, Text: string.Empty);
        }

        // A fresh mount clears the "already shown" flag; a continuing one keeps it.
        var mounted = new HostTransportAlertState(Mounted: true, ShownThisMount: state.Mounted && state.ShownThisMount);

        var note = transportNote?.Trim();
        if (mounted.ShownThisMount || string.IsNullOrEmpty(note))
        {
            return new HostTransportAlertDecision(mounted, Open: false, Text: string.Empty);
        }

        return new HostTransportAlertDecision(
            mounted with { ShownThisMount = true },
            Open: true,
            Text: note);
    }
}
