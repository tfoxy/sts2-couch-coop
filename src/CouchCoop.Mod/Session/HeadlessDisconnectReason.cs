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
/// <c>NetErrorInfo</c> — a string — so <see cref="Classify"/> looks for one of the game's own refusal names in it
/// (<c>RunInProgress</c>, or the join handshake's <c>VersionMismatch</c> / <c>ModMismatch</c>) and otherwise passes
/// the text through unchanged. That is
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
    /// The connection issue code for the game's own join handshake refusing this seat because its game content
    /// does not match the host's (the game names this <c>VersionMismatch</c>). A seat runs the host's own
    /// executable, so the version itself cannot differ: in practice it means the two processes ended up with
    /// different content loaded — most often a mod that failed to initialise, or loaded differently, in the seat.
    /// </summary>
    public const string GameContentMismatchCode = "seat-game-content-mismatch";

    /// <summary>
    /// The connection issue code for the game's own join handshake refusing this seat because its loaded mods do
    /// not match the host's (the game names this <c>ModMismatch</c>). Same install, same mod list on disk — so,
    /// as above, a mod that did not load in the seat is the usual reason.
    /// </summary>
    public const string ModMismatchCode = "seat-mod-mismatch";

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
        return TryClassify(trimmed) ?? trimmed;
    }

    /// <summary>
    /// The refusal code a rendered reason names, or <see langword="null"/> when it names none we have a sentence
    /// for. The host uses this on the seat's raw error detail, because the seat's generic network-error report
    /// carries the rendered reason as its detail and the specific one may never follow it.
    /// </summary>
    public static string? TryClassify(string? reason)
    {
        if (string.IsNullOrWhiteSpace(reason)) return null;
        foreach (var (token, code) in RefusalTokens)
        {
            if (reason.Contains(token, StringComparison.OrdinalIgnoreCase)) return code;
        }

        return null;
    }

    /// <summary>
    /// Whether <paramref name="code"/> is one of the host's own refusals named above. These are the codes allowed to
    /// REPLACE a generic native failure the host has already recorded (see
    /// <c>HeadlessClientManager.SetTerminalFailure</c> and <c>ConnectionRegistry</c>): each is the specific reason
    /// behind a drop that was first reported only as "the connection ended".
    /// </summary>
    public static bool IsJoinRefusal(string? code)
        => code is RunInProgressCode or GameContentMismatchCode or ModMismatchCode;

    // The game's own refusal member names, as they appear in a rendered NetErrorInfo. Matching on the rendering
    // rather than the enums keeps this file free of a reference to the game's networking types, which is what
    // lets the classifier (and its test) run outside a game process. No token is a substring of another.
    private static readonly (string Token, string Code)[] RefusalTokens =
    [
        ("RunInProgress", RunInProgressCode),
        ("VersionMismatch", GameContentMismatchCode),
        ("ModMismatch", ModMismatchCode),
    ];

    private static readonly HashSet<string> GenericReasons = new(StringComparer.OrdinalIgnoreCase)
    {
        NativeNetworkErrorCode,
        "native-connection-failed",
        "connection-ended",
        "unknown",
    };
}
