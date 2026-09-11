namespace CouchCoop.Mod.Activity;

/// <summary>
/// The one bit of the activity panel that must OUTLIVE the panel: whether the host collapsed it.
/// </summary>
/// <remarks>
/// <para>
/// The panel is injected per lobby screen and <c>QueueFree</c>d whenever the host leaves one, so any state
/// held on the node itself is lost on every screen change — a host who collapsed the log would find it
/// expanded again after backing out to the menu and returning. Parking the flag on a process static (in
/// <c>Activity/</c>, so it is singular across hot-reload generations for the same reason the ring is)
/// makes the collapse stick for the session.
/// </para>
/// <para>
/// Deliberately NOT persisted to disk. It is a per-session view preference, not a setting, and the mod has
/// no settings store of its own to put it in.
/// </para>
/// <para>
/// Written only from the Godot main thread (the header's <c>gui_input</c>) and read from the same thread's
/// scan tick; <c>volatile</c> rather than a lock because it is one bool with no invariants attached.
/// </para>
/// </remarks>
public static class CouchCoopActivityPanelState
{
    private static volatile bool _collapsed;

    /// <summary>False (expanded) by default — the log has to be SEEN to do its job the first time.</summary>
    public static bool Collapsed
    {
        get => _collapsed;
        set => _collapsed = value;
    }

    /// <summary>Flips the collapse and returns the new value.</summary>
    public static bool Toggle() => _collapsed = !_collapsed;
}
