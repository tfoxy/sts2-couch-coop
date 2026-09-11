using Godot;
using MegaCrit.Sts2.Core.HoverTips;
using MegaCrit.Sts2.Core.Localization;
using MegaCrit.Sts2.Core.Nodes.HoverTips;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Shows the QR dialog's selector and per-option hover tips through the GAME's own hover-tip system
/// (<see cref="NHoverTipSet"/>), so the tips look and behave like every other tooltip on screen.
/// </summary>
/// <remarks>
/// <para>
/// <b>Tips are an enhancement, never a dependency.</b> Every game call in here is fenced: a game
/// update that renames the loc table, a blocked hover-tip system (<c>shouldBlockHoverTips</c>), or a
/// missing <c>LocManager</c> must cost the player the tooltip, not the dialog. Failures log once and
/// go quiet.
/// </para>
/// <para>
/// <b>Titles go through the game's loc pipeline; descriptions are already resolved.</b> <see cref="HoverTip"/>
/// only renders a title it can resolve from a table+key, so <see cref="EnsureTitlesRegistered"/> merges
/// the active catalog's title aliases into an existing game table via <c>LocTable.MergeWith</c>. The
/// merge is re-applied lazily on every show because
/// <c>LocManager.SetLanguage</c> rebuilds its tables from disk, wiping anything merged earlier.
/// </para>
/// <para>
/// <b>The created set must be stamped.</b> <see cref="NHoverTipSet.CreateAndShow(Control, System.Collections.Generic.IEnumerable{IHoverTip}, HoverTipAlignment)"/>
/// parents the set under the game's own tips container — OUTSIDE the CouchCoop subtree whose
/// <see cref="CouchCoopStreamSkip"/> stamp keeps the dialog out of the phone mirror stream. Left
/// unstamped, a tip carrying join-URL text would stream to every mirror client. The stamp is applied
/// synchronously in the same handler, before control returns to the engine, so the producer walk can
/// never observe the set unstamped.
/// </para>
/// <para>
/// One set per owner is the game's invariant (<c>_activeHoverTips.Add</c> THROWS on a duplicate), and
/// hover-enter can arrive twice without a leave (mouse enter + controller focus), so
/// <see cref="Show"/> always removes before creating.
/// </para>
/// </remarks>
internal static class CouchCoopQrHoverTips
{
    private static readonly Dictionary<string, string> TitleTable = new();
    private static bool _warned;

    /// <summary>
    /// Show the method/interface tip pair for <paramref name="option"/> beside <paramref name="owner"/>.
    /// The method is deliberately first because it explains the link type before the adapter explains
    /// which network path carries it. Returns whether a set is actually on screen.
    /// </summary>
    public static bool ShowOption(Control owner, QrHostOption option)
        => ShowSpecs(owner, OptionTipSpecsFor(option));

    /// <summary>Show the generic tip for the closed network-connection selector.</summary>
    public static bool ShowSelector(Control owner)
        => ShowSpecs(owner, SelectorTipSpecs);

    internal static IReadOnlyList<(string TitleKey, string Description)> SelectorTipSpecs
        => [QrHoverTipCopy.NetworkConnectionTip];

    /// <summary>
    /// Builds the option tip order without touching Godot, so the method-before-interface contract is
    /// testable independently of the native hover-tip widgets.
    /// </summary>
    internal static IReadOnlyList<(string TitleKey, string Description)> OptionTipSpecsFor(QrHostOption option)
    {
        ArgumentNullException.ThrowIfNull(option);

        var (methodKey, methodDescription) = QrHoverTipCopy.MethodTipFor(option);
        var tips = new List<(string TitleKey, string Description)>(2)
        {
            (methodKey, methodDescription),
        };

        if (option.Adapter is { } adapter)
        {
            var (adapterKey, adapterDescription) = QrHoverTipCopy.AdapterTipFor(adapter.Kind);
            tips.Add((adapterKey, adapterDescription));
        }

        return tips;
    }

    private static bool ShowSpecs(Control owner, IReadOnlyList<(string TitleKey, string Description)> specs)
    {
        if (owner is null || specs is null)
        {
            return false;
        }

        try
        {
            EnsureTitlesRegistered();

            var tips = specs
                .Select(spec => (IHoverTip)new HoverTip(
                    new LocString(QrHoverTipCopy.LocTableName, spec.TitleKey), spec.Description))
                .ToList();

            NHoverTipSet.Remove(owner);
            var set = NHoverTipSet.CreateAndShow(owner, tips, HoverTipAlignment.None);
            if (set is null)
            {
                return false;
            }

            CouchCoopStreamSkip.Stamp(set);
            set.SetGlobalPosition(AnchorFor(owner, set));
            return true;
        }
        catch (Exception exception)
        {
            WarnOnce($"show failed detail={exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    /// <summary>Take down the set attached to <paramref name="owner"/>, if any. Safe to over-call.</summary>
    public static void Remove(Control? owner)
    {
        if (owner is null)
        {
            return;
        }

        try
        {
            NHoverTipSet.Remove(owner);
        }
        catch (Exception exception)
        {
            WarnOnce($"remove failed detail={exception.GetType().Name}: {exception.Message}");
        }
    }

    // Idempotent dictionary writes into a table that exists in every language. Called per SHOW, not
    // once: SetLanguage rebuilds LocManager's tables and would silently wipe a one-time merge.
    private static void EnsureTitlesRegistered()
    {
        TitleTable.Clear();
        foreach (var (key, value) in QrHoverTipCopy.TitleEntries)
        {
            TitleTable[key] = value;
        }

        LocManager.Instance?.GetTable(QrHoverTipCopy.LocTableName).MergeWith(TitleTable);
    }

    // Right of the row, top-aligned, clamped into the viewport: HoverTipAlignment.None applies no
    // auto-correction, and the bottom rows of an open list sit low enough that two stacked tips would
    // otherwise run off screen. The set's first child is the game's VFlowContainer, already sized by
    // Init, which is what makes the clamp measurable at show time.
    private static Vector2 AnchorFor(Control owner, NHoverTipSet set)
    {
        var rect = owner.GetGlobalRect();
        var viewport = owner.GetViewportRect().Size;
        var tipSize = set.GetChildOrNull<Control>(0)?.Size ?? new Vector2(360f, 200f);

        var x = rect.Position.X + rect.Size.X + 12f;
        if (x + tipSize.X + 12f > viewport.X)
        {
            x = Math.Max(12f, rect.Position.X - tipSize.X - 12f);
        }

        var y = Math.Min(rect.Position.Y, viewport.Y - tipSize.Y - 24f);
        return new Vector2(x, Math.Max(y, 24f));
    }

    private static void WarnOnce(string detail)
    {
        if (_warned)
        {
            return;
        }

        _warned = true;
        Console.Error.WriteLine($"[couch-coop] qr-hover-tips unavailable — dialog unaffected; first failure: {detail}");
    }
}
