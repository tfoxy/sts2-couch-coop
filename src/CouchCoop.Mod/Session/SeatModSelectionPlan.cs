using System;
using System.Collections.Generic;
using System.Linq;

namespace CouchCoop.Mod.Session;

/// <summary>
/// One installed mod, as far as seat selection cares: who it is, whether the game considers it able to
/// change gameplay, and what it declares a dependency on.
/// </summary>
/// <param name="Id">The mod's manifest <c>id</c>, which is also the key in the game's <c>mod_list</c> rows.</param>
/// <param name="Source">
/// <see cref="Connections.CouchCoopModBuildIdentity.LocalModSource"/> or
/// <see cref="Connections.CouchCoopModBuildIdentity.WorkshopModSource"/> — the copy this descriptor is named
/// after. The same id can be installed twice, and is still ONE descriptor (the inventory ORs the copies'
/// gameplay flags and unions their dependencies); the (id, source) rows a seat disables for it are the
/// inventory's, not this field.
/// </param>
/// <param name="Name">The manifest <c>name</c>, for the host's UI. Falls back to the id.</param>
/// <param name="AffectsGameplay">The manifest <c>affects_gameplay</c> flag.</param>
/// <param name="DependencyIds">Manifest <c>dependencies[].id</c>. Empty when it declares none.</param>
internal sealed record SeatModDescriptor(
    string Id,
    string Source,
    string Name,
    bool AffectsGameplay,
    IReadOnlyList<string> DependencyIds);

/// <summary>
/// Which mods a host may switch off for the seats it spawns, and what switching one off drags with it.
///
/// <para>
/// WHY THIS EXISTS. A seat is a real game process that no human looks at, running with Godot's
/// <c>--headless</c> dummy renderer. That renderer is not a complete one, so a mod which instantiates
/// visual resources can kill the process outright — and a killed seat is a player whose game vanished
/// mid-run. CouchCoop is the outlier here: it runs game instances as other people's clients, so it cannot
/// depend on every mod author having tested under headless. This gives the host a switch instead.
/// </para>
/// </summary>
/// <remarks>
/// <para>
/// THE RULE, and it is the whole design: a mod may be disabled for seats when it declares
/// <c>affects_gameplay: false</c> AND every mod that (transitively) depends on it also declares
/// <c>affects_gameplay: false</c>. The first half is because a seat that runs a different GAMEPLAY mod set
/// than the host is a desynchronised run, not a working one. The second half is the one that is easy to
/// miss: a library can be harmless on its own and still be load-bearing for something that is not.
/// `BaseLib` is exactly that — it declares `affects_gameplay: false` while gameplay mods depend on it — so
/// it is disableable only on a machine where nothing gameplay-affecting needs it.
/// </para>
/// <para>
/// CASCADE, and why nothing is remembered about it. Disabling a mod also disables everything that depends
/// on it, and that set is DERIVED from the graph on every read rather than stored. Deriving it is what
/// gives the host the behaviour they asked for, for free: re-enabling a mod brings back the dependents
/// that were only ever off because of it, while a dependent the host switched off deliberately stays off,
/// because its own explicit entry is still there. Storing cascade records instead would mean reconciling
/// them every time a subscription changes, and a stale record is a mod silently missing from a seat.
/// </para>
/// <para>
/// Ids are matched case-insensitively. A manifest and a <c>mod_list</c> row are written by different
/// parties, and a mod that is silently NOT the one you disabled is worse than a slightly lenient match.
/// </para>
/// </remarks>
internal static class SeatModSelectionPlan
{
    internal static readonly StringComparer IdComparer = StringComparer.OrdinalIgnoreCase;

    /// <summary>
    /// Every mod that depends on <paramref name="id"/>, directly or through other mods, excluding
    /// <paramref name="id"/> itself. Breadth-first: direct dependents come before anything reached through
    /// them, which is what lets <see cref="CanDisable"/> name the nearest one.
    /// </summary>
    /// <remarks>
    /// Breadth-first over a visited set, so a malformed manifest that declares a dependency cycle costs a
    /// bounded walk rather than hanging the host's UI thread.
    /// </remarks>
    internal static IReadOnlyList<SeatModDescriptor> DependentsOf(
        IReadOnlyList<SeatModDescriptor> mods,
        string id)
    {
        ArgumentNullException.ThrowIfNull(mods);
        if (string.IsNullOrWhiteSpace(id)) return [];

        var found = new List<SeatModDescriptor>();
        var frontier = new Queue<string>();
        frontier.Enqueue(id);
        var seen = new HashSet<string>(IdComparer) { id };

        while (frontier.Count > 0)
        {
            var needle = frontier.Dequeue();
            foreach (var candidate in mods)
            {
                if (candidate.DependencyIds is null) continue;
                if (!candidate.DependencyIds.Contains(needle, IdComparer)) continue;
                if (IdComparer.Equals(candidate.Id, id)) continue;
                if (!seen.Add(candidate.Id)) continue;

                found.Add(candidate);
                frontier.Enqueue(candidate.Id);
            }
        }

        return found;
    }

    /// <summary>
    /// Whether the host may switch <paramref name="id"/> off for its seats.
    /// </summary>
    /// <param name="blockedBy">
    /// When the answer is <see langword="false"/>, the mod that makes it so — either the mod itself
    /// (it affects gameplay) or the gameplay-affecting dependent that needs it. This is the reason the UI
    /// shows; "cannot be disabled" with no name attached is not an explanation.
    /// </param>
    internal static bool CanDisable(
        IReadOnlyList<SeatModDescriptor> mods,
        string id,
        out SeatModDescriptor? blockedBy)
    {
        ArgumentNullException.ThrowIfNull(mods);
        blockedBy = null;

        if (!mods.Any(m => IdComparer.Equals(m.Id, id))) return false;

        // Every descriptor carrying the id is asked, not just the first. The inventory collapses an id to one
        // descriptor, but a list that did not would otherwise let a gameplay flag on a second copy go unread —
        // and an unread gameplay flag is a desynchronised seat.
        var gameplaySelf = GameplayDescriptorOf(mods, id);
        if (gameplaySelf is not null)
        {
            blockedBy = gameplaySelf;
            return false;
        }

        // The load-bearing-library case. A gameplay dependent means this mod has to stay, however harmless
        // it looks on its own. Walked in DependentsOf's breadth-first order, so the mod named is the nearest
        // one — the direct dependent a host will recognise, not something three libraries away.
        foreach (var dependent in DependentsOf(mods, id))
        {
            var gameplayDependent = GameplayDescriptorOf(mods, dependent.Id);
            if (gameplayDependent is not null)
            {
                blockedBy = gameplayDependent;
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// The mods the host may offer a switch for, in a stable order (name, then id) so the panel does not
    /// reshuffle between openings.
    /// </summary>
    internal static IReadOnlyList<SeatModDescriptor> Disableable(IReadOnlyList<SeatModDescriptor> mods)
    {
        ArgumentNullException.ThrowIfNull(mods);
        return [.. mods
            .Where(m => CanDisable(mods, m.Id, out _))
            .OrderBy(m => m.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(m => m.Id, IdComparer)];
    }

    /// <summary>
    /// The set of mod ids a seat must actually load with disabled, given the ids the host switched off.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Explicit choices plus their transitive dependents, then filtered so nothing that is not allowed to be
    /// disabled can end up disabled — a stored choice can outlive the mod set that justified it. Subscribing
    /// to a gameplay mod that depends on a library the host switched off last week must not quietly produce a
    /// desynchronised seat; here that stored choice simply stops taking effect, and
    /// <see cref="CanDisable"/> will show the host why the switch is now locked.
    /// </para>
    /// <para>
    /// Unknown ids are dropped for the same reason: they name a mod this machine no longer has.
    /// </para>
    /// </remarks>
    internal static IReadOnlySet<string> Resolve(
        IReadOnlyList<SeatModDescriptor> mods,
        IReadOnlyCollection<string>? explicitlyDisabled)
    {
        ArgumentNullException.ThrowIfNull(mods);

        var effective = new HashSet<string>(IdComparer);
        if (explicitlyDisabled is null || explicitlyDisabled.Count == 0) return effective;

        foreach (var id in explicitlyDisabled)
        {
            if (string.IsNullOrWhiteSpace(id)) continue;
            if (!CanDisable(mods, id, out _)) continue;

            // The inventory's spelling of the id, not the stored one: the result is what a seat's log names and
            // what the mod-list rows are looked up by, and both should read as the mod itself spells it.
            effective.Add(mods.First(m => IdComparer.Equals(m.Id, id)).Id);
            foreach (var dependent in DependentsOf(mods, id))
            {
                // A dependent is only disableable-by-cascade under the same rule. The gameplay filter above
                // already guarantees this for a well-formed graph; re-checking keeps the guarantee local.
                if (GameplayDescriptorOf(mods, dependent.Id) is null) effective.Add(dependent.Id);
            }
        }

        return effective;
    }

    private static SeatModDescriptor? GameplayDescriptorOf(IReadOnlyList<SeatModDescriptor> mods, string id)
        => mods.FirstOrDefault(m => m.AffectsGameplay && IdComparer.Equals(m.Id, id));

    /// <summary>
    /// What disabling <paramref name="id"/> would take with it, for the host to read BEFORE deciding — the
    /// dependents that are currently on and would go off. Excludes anything already off.
    /// </summary>
    internal static IReadOnlyList<SeatModDescriptor> CascadePreview(
        IReadOnlyList<SeatModDescriptor> mods,
        string id,
        IReadOnlyCollection<string>? explicitlyDisabled)
    {
        ArgumentNullException.ThrowIfNull(mods);

        var alreadyOff = Resolve(mods, explicitlyDisabled);
        return [.. DependentsOf(mods, id)
            .Where(d => !d.AffectsGameplay && !alreadyOff.Contains(d.Id))
            .OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(d => d.Id, IdComparer)];
    }
}
