using System.IO;
using System.Text.Json;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Decides which mods a spawned seat loads, by editing the <c>settings.save</c> files
/// <see cref="HeadlessUserDirSeeder"/> has just copied into the seat's isolated user dir: the copy of CouchCoop
/// the HOST is running, and none of the mods the host switched off for its seats.
/// </summary>
/// <remarks>
/// <para>
/// WHY THE COPY IS NOT ENOUGH. The per-mod enable flag does live in the file the seeder copies —
/// <c>steam/&lt;id&gt;/settings.save</c>, under <c>mod_settings.mod_list</c>, one <c>{id, source,
/// is_enabled}</c> row per (mod, source) pair. But the file is not a record of what the host LOADED. The
/// game reads that list while starting up, decides from it, and then rewrites the list from the mods it
/// actually found; the rewritten rows do not necessarily carry the enable flags the host started with.
/// A seat is seeded from the host's user dir long after that rewrite, so it inherits the rewritten file,
/// not the host's decision. On a developer machine with both a local deploy and a Workshop
/// subscription, the host ran the local build and every seat ran the Workshop one, with one
/// <c>[WARN]</c> in each seat's log to say so.
/// </para>
/// <para>
/// So the seat is told explicitly: the row for the OTHER copy of <c>couchcoop</c> is written
/// <c>is_enabled: false</c>. That is not a version comparison and not a subscription check — the game
/// skips a mod whose (id, source) row is disabled before it ever compares two copies' versions, so the
/// outcome no longer depends on either.
/// </para>
/// <para>
/// SYMMETRIC, which matters for real players rather than for QA. The row disabled is derived from where
/// the host's own CouchCoop was loaded from (<see cref="CouchCoopModBuildIdentity.ModSource"/>): a host
/// running the Workshop build disables the seat's local row, not its Workshop one. Hardcoding "disable
/// the Workshop row" would have left an ordinary subscriber's seats with no CouchCoop at all.
/// </para>
/// <para>
/// THE HOST'S OWN CHOICES ride the same edit. A host can switch mods off for the seats it spawns (a seat runs
/// under a renderer some mods do not survive; see <see cref="SeatModSelectionPlan"/>), and those arrive here
/// as more (id, source) rows to disable — resolved, cascaded and filtered by the caller, because this file is
/// source-linked into the game-free macOS suite and can only be handed data. A host-chosen row can never touch
/// <c>couchcoop</c>: that id's rows are this file's own, and a seat with no CouchCoop is not a seat.
/// </para>
/// <para>
/// Best-effort throughout, like the rest of the seeder: a seat that could not be pinned still launches,
/// because a seat that launches and might load the wrong copy beats a seat that does not launch. Every
/// skip says why on stderr.
/// </para>
/// </remarks>
internal static class HeadlessSeatModSelection
{
    private const string ModId = "couchcoop";

    /// <summary>
    /// The mod-list row source a seat must DISABLE so it loads the same copy of CouchCoop as a host whose
    /// own copy came from <paramref name="hostModSource"/>. <see langword="null"/> when the host's source
    /// could not be told, in which case nothing is pinned.
    /// </summary>
    internal static string? SourceToDisable(string? hostModSource)
        => hostModSource switch
        {
            CouchCoopModBuildIdentity.LocalModSource => CouchCoopModBuildIdentity.WorkshopModSource,
            CouchCoopModBuildIdentity.WorkshopModSource => CouchCoopModBuildIdentity.LocalModSource,
            _ => null,
        };

    /// <summary>The source this process's own CouchCoop implies its seats must disable.</summary>
    internal static string? SourceToDisableForThisHost() => SourceToDisable(CouchCoopModBuildIdentity.ModSource);

    /// <summary>Whether <paramref name="id"/> is CouchCoop itself, whose rows only the copy pin may touch.</summary>
    internal static bool IsCouchCoop(string? id) => SeatModSelectionPlan.IdComparer.Equals(id, ModId);

    /// <summary>
    /// Every row a seat is launched with disabled: the <c>couchcoop</c> copy pin for
    /// <paramref name="copyPinSource"/> (when there is one), then <paramref name="hostChosen"/> in the order
    /// given, minus any host-chosen row for <c>couchcoop</c> and minus duplicates.
    /// </summary>
    internal static IReadOnlyList<SeatModRowKey> RowsToDisable(
        string? copyPinSource,
        IEnumerable<SeatModRowKey>? hostChosen)
    {
        var rows = new List<SeatModRowKey>();
        var seen = new HashSet<SeatModRowKey>();
        if (!string.IsNullOrWhiteSpace(copyPinSource))
        {
            var pin = new SeatModRowKey(ModId, copyPinSource);
            seen.Add(pin);
            rows.Add(pin);
        }

        foreach (var row in HostChosenRows(hostChosen))
        {
            if (seen.Add(row)) rows.Add(row);
        }

        return rows;
    }

    /// <summary>
    /// Apply the copy pin and the host's choices to a freshly seeded seat, and say in one line which mods the
    /// seat was launched with switched off.
    /// </summary>
    /// <param name="hostChosen">
    /// The host's resolved choices, or <see langword="null"/> for a caller that has none to offer (the pure
    /// seeding tests) — in which case only the copy pin applies and no line is written.
    /// </param>
    /// <remarks>
    /// <para>
    /// THE LINE is the evidence a live QA harvest reads to prove what a seat ran with, so it is written for
    /// every seat a real launch prepares, one line per seat, including the ones with nothing host-chosen. It
    /// always reaches stderr and the host's <c>godot.log</c>.
    /// </para>
    /// <para>
    /// It is ESCALATED — the seeder's own channel (<see cref="HeadlessUserDirSeeder.Log"/>), which is ERROR level
    /// and so is what the connections report quotes — only when the host switched something off AND the seat
    /// may not honour it (<see cref="SeatModPinOutcome.FellShort"/>): a profile that could have been pinned was
    /// not, so a seat started from it may load a mod the host switched off. That is the line a player's report
    /// must carry. Every other outcome is routine and is written at INFO, including a seat whose offline or
    /// never-modded profile has no mod list to pin: that is how an ordinary modded host's seats are seeded, and
    /// an ERROR per seat would put an alarming line in every report such a host sends.
    /// </para>
    /// </remarks>
    internal static SeatModPinOutcome ApplyToSeat(
        string slotUserDir,
        string? copyPinSource,
        IReadOnlyCollection<SeatModRowKey>? hostChosen,
        int slot)
    {
        var chosen = HostChosenRows(hostChosen).ToList();
        var rows = RowsToDisable(copyPinSource, chosen);
        var outcome = rows.Count == 0 ? SeatModPinOutcome.None : PinSeatProfiles(slotUserDir, rows, slot);
        if (hostChosen is null) return outcome;

        var line = DescribeSeat(slot, copyPinSource, chosen, outcome);
        if (chosen.Count > 0 && outcome.FellShort)
        {
            HeadlessUserDirSeeder.Log(line);
        }
        else
        {
            CouchCoopLog.Stderr(line);
            CouchCoopLog.Info(line);
        }

        return outcome;
    }

    /// <summary>
    /// The per-seat line: which ids were switched off by the host, with the sources each was disabled for, the
    /// copy pin, and how many of the seat's profiles actually carry the result. A profile with no mod list is
    /// named as having nothing to pin, never as one the result is missing from.
    /// </summary>
    internal static string DescribeSeat(
        int slot,
        string? copyPinSource,
        IReadOnlyList<SeatModRowKey> hostChosen,
        SeatModPinOutcome outcome)
    {
        var chosen = hostChosen.Count == 0
            ? "none"
            : string.Join(", ", hostChosen
                .GroupBy(row => row.Id, SeatModSelectionPlan.IdComparer)
                .Select(group => $"{group.Key} ({string.Join(", ", group.Select(row => row.Source))})"));
        var pin = string.IsNullOrWhiteSpace(copyPinSource) ? "none" : $"{ModId} ({copyPinSource})";
        var applied = outcome switch
        {
            { Profiles: 0 } => "no seeded profile carried a settings.save, so nothing was disabled",
            { Missed: > 0, NothingToPin: 0 } =>
                $"applied to only {outcome.Applied} of {outcome.Profiles} profile(s) — the skip lines above say why",
            { Missed: > 0 } =>
                $"applied to only {outcome.Applied} of {outcome.Profiles} profile(s) — the skip lines above say why; "
                + $"{outcome.NothingToPin} without a mod list had nothing to pin",
            { Applied: 0 } => $"nothing to pin — none of the {outcome.Profiles} profile(s) has a mod list",
            { NothingToPin: 0 } => $"applied to {outcome.Applied} of {outcome.Profiles} profile(s)",
            _ => $"applied to {outcome.Applied} of {outcome.Profiles} profile(s) — every one with a mod list; "
                + $"{outcome.NothingToPin} without one had nothing to pin",
        };
        return $"headless seat mods slot={slot}: disabled by the host=[{chosen}] copy pin={pin} — {applied}";
    }

    /// <summary>
    /// Disable <paramref name="rowsToDisable"/> in every profile <c>settings.save</c> under
    /// <paramref name="slotUserDir"/>.
    /// </summary>
    internal static SeatModPinOutcome PinSeatProfiles(
        string slotUserDir,
        IReadOnlyCollection<SeatModRowKey> rowsToDisable,
        int slot)
    {
        var profiles = 0;
        var applied = 0;
        var rewritten = 0;
        var nothingToPin = 0;
        try
        {
            foreach (var settings in SeatModList.ProfileSettingsFiles(slotUserDir))
            {
                profiles++;
                switch (PinFile(settings, rowsToDisable, slot))
                {
                    case PinFileResult.Rewritten:
                        rewritten++;
                        applied++;
                        break;
                    case PinFileResult.AlreadyApplied:
                        applied++;
                        break;
                    case PinFileResult.NothingToPin:
                        nothingToPin++;
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Caught HERE rather than left to the seeder's own catch-all, which answers any failure with "no
            // isolation at all": a profile walk that broke part-way costs the pin, never the seat's user dir.
            CouchCoopLog.Stderr(
                $"headless seat mod selection walk stopped slot={slot} dir={slotUserDir}: {ex.GetType().Name}: {ex.Message}");
        }

        return new SeatModPinOutcome(profiles, applied, rewritten, nothingToPin);
    }

    private enum PinFileResult
    {
        NotApplied,
        NothingToPin,
        AlreadyApplied,
        Rewritten,
    }

    private static PinFileResult PinFile(string settingsPath, IReadOnlyCollection<SeatModRowKey> rows, int slot)
    {
        try
        {
            var edit = SeatModList.Disable(File.ReadAllText(settingsPath), rows);
            if (edit.Refusal is not null && edit.NothingToPin)
            {
                CouchCoopLog.Stderr(
                    $"headless seat mod selection nothing to pin slot={slot} file={settingsPath}: {edit.Refusal}");
                return PinFileResult.NothingToPin;
            }

            if (edit.Refusal is not null)
            {
                CouchCoopLog.Stderr(
                    $"headless seat mod selection skipped slot={slot} file={settingsPath}: {edit.Refusal}");
                return PinFileResult.NotApplied;
            }

            if (edit.NotDisabled.Count > 0)
            {
                CouchCoopLog.Stderr(
                    $"headless seat mod selection could not add slot={slot} file={settingsPath} "
                    + $"rows=[{string.Join(", ", edit.NotDisabled)}]: this mod list does not write `source` as a "
                    + "string, and a row in a shape the game may not read would cost the seat every setting");
            }

            if (edit.Updated is not null)
            {
                // Same-directory temp plus a replacing move: the seat is not running yet, but the HOST may be
                // reading its own tree, and a half-written settings.save is a mod list the game cannot parse.
                var temporary = settingsPath + ".couchcoop-pin.tmp";
                File.WriteAllText(temporary, edit.Updated);
                File.Move(temporary, settingsPath, overwrite: true);
            }

            if (!edit.Applied) return PinFileResult.NotApplied;
            return edit.Updated is null ? PinFileResult.AlreadyApplied : PinFileResult.Rewritten;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            CouchCoopLog.Stderr(
                $"headless seat mod selection skipped slot={slot} file={settingsPath}: {ex.GetType().Name}: {ex.Message}");
            return PinFileResult.NotApplied;
        }
    }

    /// <summary>
    /// Rewrite one <c>settings.save</c> so the <c>couchcoop</c> row for <paramref name="sourceToDisable"/>
    /// is present and disabled. Returns <see langword="null"/> when the file must be left exactly as it
    /// was copied. The copy pin alone, as <see cref="SeatModList.Disable"/> applies it.
    /// </summary>
    internal static string? Pin(string settingsJson, string sourceToDisable)
        => SeatModList.Disable(settingsJson, [new SeatModRowKey(ModId, sourceToDisable)]).Updated;

    private static IEnumerable<SeatModRowKey> HostChosenRows(IEnumerable<SeatModRowKey>? hostChosen)
        => hostChosen is null
            ? []
            : hostChosen.Where(row => !string.IsNullOrWhiteSpace(row.Id)
                && !string.IsNullOrWhiteSpace(row.Source)
                && !IsCouchCoop(row.Id));
}

/// <summary>What pinning one seat's profiles came to.</summary>
/// <param name="Profiles">Profile <c>settings.save</c> files found in the seat.</param>
/// <param name="Applied">Of those, how many now disable every requested row (rewritten, or already so).</param>
/// <param name="Rewritten">Of those, how many had to be rewritten.</param>
/// <param name="NothingToPin">
/// Of those, how many have no mod list to pin — none at all, or an empty one (<see cref="SeatModListEdit.NothingToPin"/>).
/// Left alone on purpose, and not a miss.
/// </param>
internal sealed record SeatModPinOutcome(int Profiles, int Applied, int Rewritten, int NothingToPin)
{
    internal static SeatModPinOutcome None { get; } = new(0, 0, 0, 0);

    /// <summary>
    /// Profiles that could have been pinned and were not: one with a mod list that declined a requested row, or
    /// one that could not be read, parsed or written — any of which a seat started from may load a mod the
    /// host switched off.
    /// </summary>
    internal int Missed => Profiles - Applied - NothingToPin;

    /// <summary>
    /// Whether the seat may not honour what was asked: a profile was <see cref="Missed"/>, or the seat had no
    /// profile to pin at all. A profile with nothing to pin never makes this true on its own.
    /// </summary>
    internal bool FellShort => Profiles == 0 || Missed > 0;
}
