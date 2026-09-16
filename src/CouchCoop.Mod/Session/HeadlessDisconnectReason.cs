namespace CouchCoop.Mod.Session;

/// <summary>
/// The shared vocabulary for "why is this seat not in the host's game" — one code, used by the HOST when it
/// refuses to launch a seat into a running run (<see cref="HeadlessClientManager"/>) and by the SEAT when the
/// host's netcode refuses the one it did launch (<see cref="Patches.HeadlessDisconnectExitPatch"/>).
///
/// <para>
/// ONE code for both, deliberately: they are the same situation from two ends of the same socket, they have the
/// same remedy, and the host panel renders a code as a localized sentence (see
/// <c>CouchCoopConnectionPanel.IssueKey</c>). Two codes would mean two translations of one sentence, and the
/// second one would eventually drift.
/// </para>
///
/// <para>
/// CLASSIFICATION IS BEST-EFFORT AND TEXTUAL. The seat learns its refusal as a rendered
/// <c>NetErrorInfo</c> — a string — so <see cref="Classify"/> looks for the game's own
/// <c>DisconnectionReason.RunInProgress</c> name in it and otherwise passes the text through unchanged. That is
/// the honest failure mode: an unrecognised reason stays exactly as informative as it was, and the generic
/// handling downstream is unchanged.
/// </para>
/// </summary>
public static class HeadlessDisconnectReason
{
    /// <summary>
    /// The connection issue code for "the host's run had already begun". Public-facing in the sense that the
    /// panel's copy keys on the literal (<c>couchcoop_connection_error_seat_run_in_progress_*</c>) — three
    /// spellings of it would drift, which is why every emitter takes it from here.
    /// </summary>
    public const string RunInProgressCode = "seat-run-in-progress";

    /// <summary>
    /// The reason recorded when nothing more specific is known. Not a code of ours: it is the generic error code
    /// the native connection snapshot carries for a dropped socket, and it is what usually wins the race to the
    /// exit sequence (the snapshot is published from the transport; the specific reason arrives a beat later,
    /// from the game's own disconnect handler).
    /// </summary>
    public const string NativeNetworkErrorCode = "native-network-error";

    /// <summary>
    /// Whether <paramref name="reason"/> actually names a cause, rather than saying only that the connection
    /// ended. Used by <see cref="HeadlessDisconnectExitSequence"/> to decide whether a reason arriving AFTER the
    /// shutdown started is worth recording over the one that started it.
    /// </summary>
    public static bool IsSpecific(string? reason)
        => !string.IsNullOrWhiteSpace(reason) && !GenericReasons.Contains(reason.Trim());

    /// <summary>
    /// Map a rendered disconnect reason to a code the host can render copy for, or hand it back unchanged when
    /// it names nothing we have a sentence for.
    /// </summary>
    public static string Classify(string? reason)
    {
        var trimmed = reason?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return "connection-ended";
        return trimmed.Contains(RunInProgressToken, StringComparison.OrdinalIgnoreCase)
            ? RunInProgressCode
            : trimmed;
    }

    // The game's own DisconnectionReason member name, as it appears in a rendered NetErrorInfo. Matching on the
    // rendering rather than the enum keeps this file free of a reference to the game's networking types, which
    // is what lets the classifier (and its test) run outside a game process.
    private const string RunInProgressToken = "RunInProgress";

    private static readonly HashSet<string> GenericReasons = new(StringComparer.OrdinalIgnoreCase)
    {
        NativeNetworkErrorCode,
        "native-connection-failed",
        "connection-ended",
        "unknown",
    };
}
