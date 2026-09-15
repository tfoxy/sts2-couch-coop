namespace CouchCoop.Mod.Connections;

/// <summary>
/// Process-wide record of whether this mod's Harmony hooks could actually be installed, and the one place that
/// turns "they could not" into something a player can find.
/// </summary>
/// <remarks>
/// <para>
/// Every patch in <c>CouchCoopMod.Init</c> degrades on its own terms and, until this existed, said so only on
/// <c>Console.Error</c> — a stream a Steam-launched game discards. The visible consequence is the same whichever
/// patch died: no QR button in the lobby, or no seat able to join. That reads to a player as "the mod does not
/// work", with nothing in <c>godot.log</c> and nothing in the connections panel to say why.
/// </para>
/// <para>
/// Deliberately free of Harmony, Godot and game types: it is read from <see cref="ConnectionRegistry.BuildReport"/>
/// and written from the patch call sites, so it must stay constructible in a process with no engine.
/// </para>
/// </remarks>
internal static class CouchCoopPatchHealth
{
    /// <summary>
    /// The single code every patch-health failure reports under, so <see cref="ConnectionRegistry.ReportHostIssue"/>
    /// deduplicates them into ONE row. A host whose native patching is broken loses every patch at once; a row per
    /// patch would be eight copies of one fact.
    /// </summary>
    internal const string IssueCode = "host-patch-failed";

    internal const string IssueSummary = "Couch Co-op could not attach to the game, so co-op cannot run this session.";

    internal const string IssueAction =
        "Restart the game. If co-op still cannot start, copy this report — it names the check that blocked the mod.";

    private static readonly object Gate = new();
    private static readonly List<string> FailedPatches = [];
    private static string _probe = "not-run";

    /// <summary>
    /// Where a failure raises its row. The process always reports to <see cref="ConnectionRegistry.Shared"/>;
    /// a test points this at its own registry so it never has to reach into the singleton.
    /// </summary>
    internal static ConnectionRegistry Registry { get; set; } = ConnectionRegistry.Shared;

    /// <summary>Forget everything recorded so far. Tests only — a real process records once and keeps it.</summary>
    internal static void Reset()
    {
        lock (Gate)
        {
            FailedPatches.Clear();
            _probe = "not-run";
        }
    }

    /// <summary>Record what the pre-patch probe decided, without raising anything.</summary>
    internal static void RecordProbe(string outcome)
    {
        lock (Gate)
        {
            _probe = outcome;
        }
    }

    /// <summary>
    /// The probe could not install a trial patch of our own method, so no patch below it will install either.
    /// Records the outcome and raises the fatal row.
    /// </summary>
    internal static void ProbeFailed(string error, string detail)
    {
        lock (Gate)
        {
            _probe = $"failed({error})";
        }

        // Outside the lock: the registry takes its own, and reporting kicks off a log read.
        Registry.ReportHostIssue(IssueCode, IssueSummary, IssueAction, detail);
    }

    /// <summary>
    /// One patch could not be installed.
    /// </summary>
    /// <param name="patch">The patch type's name, for the report's patch-health fact.</param>
    /// <param name="costsCoop">
    /// Whether this patch's absence costs the lobby QR button or a seat's ability to join. Only those raise the
    /// row: a failure the player can neither see nor act on is noise in a panel that exists for the ones they can.
    /// </param>
    /// <param name="detail">Free-form technical cause, carried into the report.</param>
    internal static void PatchFailed(string patch, bool costsCoop, string detail)
    {
        lock (Gate)
        {
            if (!FailedPatches.Contains(patch))
            {
                FailedPatches.Add(patch);
            }
        }

        if (costsCoop)
        {
            Registry.ReportHostIssue(IssueCode, IssueSummary, IssueAction, detail);
        }
    }

    /// <summary>
    /// One line for the connection report: what the probe said, and every patch that failed since — including the
    /// ones recorded AFTER the row was raised, which the deduplicated row itself cannot carry.
    /// </summary>
    internal static string Describe()
    {
        lock (Gate)
        {
            var failed = FailedPatches.Count == 0 ? "none" : string.Join(", ", FailedPatches);
            return $"probe={_probe}; failedPatches={failed}";
        }
    }
}
