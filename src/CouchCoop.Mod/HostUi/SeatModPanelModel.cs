using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.HostUi;

/// <summary>Where one listed mod stands for the seats the host spawns.</summary>
internal enum SeatModRowState
{
    /// <summary>On, and the host may turn it off.</summary>
    On,

    /// <summary>Off because the host turned it off. Pressing it turns it back on.</summary>
    Off,

    /// <summary>
    /// Off only because a mod it needs is off. Not a choice of its own, so pressing it explains rather than
    /// toggles: turning it on alone would hand a seat a mod without the library it loads on top of.
    /// </summary>
    OffWithDependency,

    /// <summary>A mod a gameplay mod needs. It stays on; pressing it explains.</summary>
    Locked,
}

/// <summary>What pressing a row does.</summary>
internal enum SeatModPressKind
{
    /// <summary>Not a listed row. Nothing happens.</summary>
    None,

    /// <summary>A locked or held-off row: nothing changes, the explanation is shown.</summary>
    Explain,

    /// <summary>Turned off at once — it takes nothing else with it.</summary>
    TurnOff,

    /// <summary>Turned back on at once.</summary>
    TurnOn,

    /// <summary>Would take other mods with it. Nothing changes until the host confirms.</summary>
    ConfirmTurnOff,
}

/// <summary>One row of the seat-mod panel, fully decided.</summary>
/// <param name="Id">The mod id. Stable across openings and the key a press is reported under.</param>
/// <param name="Name">What the row prints: the manifest name, else the id.</param>
/// <param name="LockedBy">For <see cref="SeatModRowState.Locked"/>, the gameplay mod that needs this one.</param>
/// <param name="OffWith">
/// For <see cref="SeatModRowState.OffWithDependency"/>, the mods the host turned off that took this one with
/// them — the ones to turn back on to restore it. Empty otherwise.
/// </param>
/// <param name="Status">The row's second line.</param>
/// <param name="Explanation">What pressing a locked or held-off row says. Null for a row that toggles.</param>
internal sealed record SeatModRowView(
    string Id,
    string Name,
    SeatModRowState State,
    SeatModDescriptor? LockedBy,
    IReadOnlyList<SeatModDescriptor> OffWith,
    CouchCoopText Status,
    CouchCoopText? Explanation)
{
    /// <summary>Whether a seat launched now would load it.</summary>
    public bool IsOn => State is SeatModRowState.On or SeatModRowState.Locked;

    public string NodeName => SeatModPanelModel.RowNodeName(Id);
}

/// <summary>The outcome of pressing (or confirming) a row.</summary>
/// <param name="Next">
/// The explicit-disable set to write, or null when the press changes nothing yet. Holds only ids the host chose
/// — never a cascade, which <see cref="SeatModSelectionPlan.Resolve"/> derives on every read.
/// </param>
/// <param name="Cascade">For <see cref="SeatModPressKind.ConfirmTurnOff"/>, what would go off with it.</param>
/// <param name="Detail">What the panel's explanation box says after the press, or null for its standing copy.</param>
internal sealed record SeatModPress(
    SeatModPressKind Kind,
    string Id,
    IReadOnlySet<string>? Next,
    IReadOnlyList<SeatModDescriptor> Cascade,
    CouchCoopText? Detail);

/// <summary>
/// Every decision the host's seat-mod panel makes — which rows it lists, what each says, and what a press
/// does — with no Godot type in sight, so all of it is testable off-engine. The panel only draws the result.
/// </summary>
/// <remarks>
/// <para>
/// WHAT IS LISTED. Every mod that declares it does not affect gameplay, whether or not it may be turned off: a
/// locked library is listed too, because a host looking for the mod that crashes their players and not
/// finding it deserves to be told why it cannot go. Gameplay mods are never listed. There is nothing to
/// offer — a seat with a different gameplay mod set is a desynchronised run — and a list full of rows that
/// all say "no" would bury the few that do something.
/// </para>
/// <para>
/// WHAT IS STORED. A press produces the next EXPLICIT set: the pressed id added or removed, everything else
/// carried over untouched, including ids this machine no longer has or can no longer turn off. Pruning those
/// is the store's policy to set, not the panel's, and <see cref="SeatModSelectionPlan.Resolve"/> already
/// declines to apply them. What went off WITH a mod is never written, which is what makes turning it back
/// on restore exactly what it took and leave the host's own choices alone.
/// </para>
/// </remarks>
internal static class SeatModPanelModel
{
    public const string RowNamePrefix = "CouchCoopSeatModRow_";

    // The panel's standing copy. Named here so the suite can prove each key ships.
    public const string TitleKey = "couchcoop_seatmods_title";
    public const string PurposeKey = "couchcoop_seatmods_purpose";
    public const string VisualsKey = "couchcoop_seatmods_visuals";
    public const string DeclaredKey = "couchcoop_seatmods_declared";
    public const string AppliesToNewKey = "couchcoop_seatmods_applies_to_new";
    public const string ConfirmKey = "couchcoop_seatmods_confirm";
    public const string CancelKey = "couchcoop_seatmods_cancel";

    public const string RowOnKey = "couchcoop_seatmods_row_on";
    public const string RowOffKey = "couchcoop_seatmods_row_off";
    public const string RowLockedKey = "couchcoop_seatmods_row_locked";
    public const string RowOffWithKey = "couchcoop_seatmods_row_off_with";
    public const string DetailLockedKey = "couchcoop_seatmods_detail_locked";
    public const string DetailOffWithKey = "couchcoop_seatmods_detail_off_with";
    public const string ConfirmPromptKey = "couchcoop_seatmods_confirm_prompt";

    public static IReadOnlyList<string> StandingCopyKeys { get; } =
        [TitleKey, PurposeKey, VisualsKey, DeclaredKey, AppliesToNewKey, ConfirmKey, CancelKey];

    // Mod names are external text and mostly Latin whatever the host's language, so a comma list reads in all of
    // them; a localized list pattern would buy nothing a host would notice.
    private const string NameSeparator = ", ";

    private static StringComparer Ids => SeatModSelectionPlan.IdComparer;

    /// <summary>
    /// The rows, in the plan's stable order (name, then id) so the list does not reshuffle between openings.
    /// Empty means the panel stays hidden: a machine with no such mod has nothing to decide.
    /// </summary>
    public static IReadOnlyList<SeatModRowView> Rows(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string>? explicitlyDisabled)
    {
        ArgumentNullException.ThrowIfNull(mods);
        var chosen = explicitlyDisabled ?? [];
        var effective = SeatModSelectionPlan.Resolve(mods, chosen);
        var seen = new HashSet<string>(Ids);
        var rows = new List<SeatModRowView>();
        foreach (var mod in mods
            .Where(m => !m.AffectsGameplay && !string.IsNullOrWhiteSpace(m.Id))
            .OrderBy(m => NameOf(m), StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(m => m.Id, Ids))
        {
            // One row per id: a switch acts on the id, so a second row for another copy would be the same
            // switch twice — and its node name would collide.
            if (seen.Add(mod.Id))
            {
                rows.Add(RowFor(mods, chosen, effective, mod));
            }
        }

        return rows;
    }

    /// <summary>What pressing the row for <paramref name="id"/> does, given the host's current choices.</summary>
    public static SeatModPress Press(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string>? explicitlyDisabled,
        string id)
    {
        ArgumentNullException.ThrowIfNull(mods);
        var chosen = explicitlyDisabled ?? [];
        var row = Rows(mods, chosen).FirstOrDefault(r => Ids.Equals(r.Id, id));
        if (row is null)
        {
            return Nothing(id);
        }

        switch (row.State)
        {
            case SeatModRowState.Locked:
            case SeatModRowState.OffWithDependency:
                return new SeatModPress(SeatModPressKind.Explain, row.Id, null, [], row.Explanation);

            case SeatModRowState.Off:
                return Toggled(SeatModPressKind.TurnOn, mods, row.Id, Without(chosen, row.Id));

            default:
                var cascade = SeatModSelectionPlan.CascadePreview(mods, row.Id, chosen);
                if (cascade.Count == 0)
                {
                    return Toggled(SeatModPressKind.TurnOff, mods, row.Id, With(chosen, row.Id));
                }

                // Nothing is written yet: the host reads what else goes BEFORE anything does.
                var prompt = CouchCoopText.Create(
                    ConfirmPromptKey,
                    ("mod", row.Name),
                    ("mods", JoinNames(cascade)));
                return new SeatModPress(SeatModPressKind.ConfirmTurnOff, row.Id, null, cascade, prompt);
        }
    }

    /// <summary>
    /// The host confirmed a pending turn-off. Re-decided against the current choices rather than trusting the
    /// prompt, so a confirm that no longer applies does nothing instead of writing a stale answer.
    /// </summary>
    public static SeatModPress Confirm(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string>? explicitlyDisabled,
        string id)
    {
        ArgumentNullException.ThrowIfNull(mods);
        var chosen = explicitlyDisabled ?? [];
        var row = Rows(mods, chosen).FirstOrDefault(r => Ids.Equals(r.Id, id));
        return row is { State: SeatModRowState.On }
            ? Toggled(SeatModPressKind.TurnOff, mods, row.Id, With(chosen, row.Id))
            : Nothing(id);
    }

    /// <summary>
    /// The QA-stable node name for a row. Godot refuses <c>. : @ / " %</c> in a node name and would rename the
    /// node behind our back, so those become underscores here, where the suite can see it.
    /// </summary>
    public static string RowNodeName(string id)
    {
        var name = (id ?? string.Empty).ToCharArray();
        for (var index = 0; index < name.Length; index++)
        {
            if (name[index] is '.' or ':' or '@' or '/' or '"' or '%')
            {
                name[index] = '_';
            }
        }

        return RowNamePrefix + new string(name);
    }

    /// <summary>The name a row prints for <paramref name="mod"/>: one line, the manifest name else the id.</summary>
    public static string NameOf(SeatModDescriptor mod)
    {
        var name = string.IsNullOrWhiteSpace(mod.Name) ? mod.Id : mod.Name;
        return (name ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ').Trim();
    }

    private static SeatModRowView RowFor(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string> chosen,
        IReadOnlySet<string> effective,
        SeatModDescriptor mod)
    {
        var name = NameOf(mod);
        if (!SeatModSelectionPlan.CanDisable(mods, mod.Id, out var blockedBy))
        {
            // For a mod that does not affect gameplay itself, the blocker is the gameplay mod that needs it.
            var locker = NameOf(blockedBy ?? mod);
            return new SeatModRowView(
                mod.Id,
                name,
                SeatModRowState.Locked,
                blockedBy,
                [],
                CouchCoopText.Create(RowLockedKey, ("mod", locker)),
                CouchCoopText.Create(DetailLockedKey, ("mod", name), ("dependent", locker)));
        }

        if (!effective.Contains(mod.Id))
        {
            return new SeatModRowView(mod.Id, name, SeatModRowState.On, null, [], CouchCoopText.Create(RowOnKey), null);
        }

        // The host's own choice wins the label even when a cascade covers it too: pressing it removes THAT
        // choice, and if the cascade still holds it the row then says so on its own.
        if (chosen.Contains(mod.Id, Ids))
        {
            return new SeatModRowView(mod.Id, name, SeatModRowState.Off, null, [], CouchCoopText.Create(RowOffKey), null);
        }

        var offWith = OffWith(mods, chosen, mod);
        var names = JoinNames(offWith);
        return new SeatModRowView(
            mod.Id,
            name,
            SeatModRowState.OffWithDependency,
            null,
            offWith,
            CouchCoopText.Create(RowOffWithKey, ("mods", names)),
            CouchCoopText.Create(DetailOffWithKey, ("mod", name), ("mods", names)));
    }

    /// <summary>
    /// The host's own choices whose cascade reaches <paramref name="mod"/> — the mods to turn back on. Every
    /// one of them, not just the nearest: each is independently enough to keep it off.
    /// </summary>
    private static IReadOnlyList<SeatModDescriptor> OffWith(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string> chosen,
        SeatModDescriptor mod)
        => [.. mods
            .Where(m => !Ids.Equals(m.Id, mod.Id) && chosen.Contains(m.Id, Ids))
            .Where(m => SeatModSelectionPlan.CanDisable(mods, m.Id, out _))
            .Where(m => SeatModSelectionPlan.DependentsOf(mods, m.Id).Any(d => Ids.Equals(d.Id, mod.Id)))
            .DistinctBy(m => m.Id, Ids)
            .OrderBy(m => NameOf(m), StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(m => m.Id, Ids)];

    /// <summary>
    /// A write, plus what the pressed row says afterwards. Turning a mod back on can leave it held off by
    /// another choice; the host learns that from the same press rather than from a row that did not move.
    /// </summary>
    private static SeatModPress Toggled(
        SeatModPressKind kind,
        IReadOnlyList<SeatModDescriptor> mods,
        string id,
        IReadOnlySet<string> next)
    {
        var after = Rows(mods, next).FirstOrDefault(r => Ids.Equals(r.Id, id));
        return new SeatModPress(kind, id, next, [], after?.Explanation);
    }

    private static SeatModPress Nothing(string id) => new(SeatModPressKind.None, id ?? string.Empty, null, [], null);

    private static IReadOnlySet<string> With(IReadOnlyCollection<string> chosen, string id)
    {
        var next = new HashSet<string>(chosen.Where(value => !string.IsNullOrWhiteSpace(value)), Ids) { id };
        return next;
    }

    private static IReadOnlySet<string> Without(IReadOnlyCollection<string> chosen, string id)
        => new HashSet<string>(chosen.Where(value => !string.IsNullOrWhiteSpace(value) && !Ids.Equals(value, id)), Ids);

    private static string JoinNames(IEnumerable<SeatModDescriptor> mods)
        => string.Join(NameSeparator, mods.Select(NameOf));
}
