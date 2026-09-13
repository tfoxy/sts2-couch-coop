using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.MirrorProtocol.Join;

// Pure C# port of the DECISION logic in frontend/src/join/joinModel.ts. Only the browser-independent parts live
// here: lifting the join-screen inputs out of a `session` envelope, the "may this viewer choose an assignment"
// gate, the MIRROR view's pre-join sub-mode, and name trimming. The client-side storage/URL/history bits
// (LAST_PLAYER_NAME_STORAGE_KEY, readUrlName, readStoredName, rememberJoinedName) and the stateful view's
// computeJoinMode stay on their respective clients — the native mirror client only needs these.

// The MIRROR view's pre-join sub-modes, driven by the server's `screen.mirrorMode` (TS MirrorJoinMode).
// PickerWithName = MP character-select (player picker PLUS a name field to add a new remote player);
// Picker = MP load-saved-game / MP run (picker only, no name field); TitleOnly = everything else (singleplayer
// run, the SINGLEPLAYER character select, and host selection are handled by the server's `directView` directive
// or by simply mirroring the screen, not by a form).
public enum MirrorJoinMode
{
    PickerWithName,
    Picker,
    TitleOnly,
}

// The minimal join-screen inputs, lifted from a `session` envelope (TS JoinInfo). Everything the form needs —
// roster, run-vs-lobby, and whether THIS viewer has joined — without the full game state. `Status` is the raw
// connection status string ("connecting" | "connected" | "disconnected" | "unsupported").
public sealed record JoinInfo(
    string Status,
    IReadOnlyList<SessionPlayerOption> Players,
    string? ScreenKind,
    string? ScreenTitle,
    bool Joined,
    // `session.joined === false` (explicitly unassigned) — the viewer is present but not assigned.
    bool Unaffiliated);

public static class JoinModel
{
    // Port of joinInfoFromSession. A null session (mirror before its first session) → title-less + empty roster.
    public static JoinInfo JoinInfoFromSession(SessionEnvelope? session, string status)
    {
        var screen = session?.Screen;
        return new JoinInfo(
            Status: status,
            Players: session?.Players ?? [],
            // screen?.kind ?? null — SessionScreen.Kind is always populated (normalized to "unsupported"), so this
            // is null only when there is no screen at all.
            ScreenKind: screen?.Kind,
            // screen?.title ?? screen?.type ?? null.
            ScreenTitle: screen is null ? null : screen.Title ?? screen.Type,
            // session?.session?.joined === true.
            Joined: session?.Session is { Joined: true },
            // session?.session?.joined === false.
            Unaffiliated: session?.Session is { Joined: false });
    }

    // Port of canChooseAssignment. Whether the viewer may currently choose an assignment: connected, not already
    // joined, and no join in flight. A pending join must collapse the form so the browser never sits in a
    // half-joined loop while the host is still resolving the request. (`!pendingJoinName` in JS is falsy for both
    // null AND the empty string → string.IsNullOrEmpty.)
    public static bool CanChooseAssignment(JoinInfo info, string? pendingJoinName) =>
        !info.Joined
        && info.Status != "connecting"
        && info.Status != "disconnected"
        && string.IsNullOrEmpty(pendingJoinName);

    // Port of computeMirrorJoinMode. Driven by the server's `screen.mirrorMode` rather than `screen.kind`; when it's
    // non-picker values fall back to TitleOnly (the mirror then watches the host stream).
    // That default is load-bearing, not laziness: it is what makes a screen nobody can join — including
    // "sp-character-select", the host's SINGLEPLAYER lobby — render no join form without a case of its own. Only
    // a kind that needs a FORM belongs in the branches below.
    public static MirrorJoinMode ComputeMirrorJoinMode(JoinInfo info, string? pendingJoinName, string? mirrorMode)
    {
        if (!CanChooseAssignment(info, pendingJoinName))
        {
            return MirrorJoinMode.TitleOnly;
        }

        if (mirrorMode == "mp-character-select")
        {
            return MirrorJoinMode.PickerWithName;
        }

        if (mirrorMode is "mp-load-game" or "mp-run")
        {
            return MirrorJoinMode.Picker;
        }

        return MirrorJoinMode.TitleOnly;
    }

    /// <summary>
    /// WS-B STREAM GATE — whether this viewer may have the host's live game streamed to it right now.
    /// <para>
    /// The product rule, in one place: <b>never render (nor even pull) a multiplayer host's game behind the join
    /// picker.</b> The host is streamed only when this device has been granted its own view — <paramref name="joined"/>
    /// (its own headless instance) or <paramref name="directView"/> (the host handed over its own stream) — or when the
    /// host is NOT on a multiplayer screen at all, which <see cref="ComputeMirrorJoinMode"/> already expresses as
    /// <see cref="MirrorJoinMode.TitleOnly"/> (main menu / singleplayer run / singleplayer character select).
    /// </para>
    /// <para>
    /// The two extra conditions are why this can't just be `mode == TitleOnly`: that mode is ALSO returned while a
    /// join is in flight or the socket isn't connected (via CanChooseAssignment), which are transient states owned by
    /// a placeholder, not permission to stream.
    /// </para>
    /// <para>
    /// <paramref name="seatIntent"/> — "this page's URL names a SEAT" (the web client's <c>?name=Ann</c>) — is
    /// REQUIRED rather than optional so neither client can forget it. Such a viewer is a player waiting for a game,
    /// not a spectator: on a screen it cannot join it must pull NO scene bytes at all and wait instead. Its position
    /// is deliberate: BELOW <paramref name="joined"/>/<paramref name="directView"/>, so an explicit grant always
    /// outranks a mere URL marker; ABOVE everything else, so a title-only host screen no longer opens the gate for a
    /// viewer that named a seat. The NATIVE client has no <c>?name=</c> state and always passes <c>false</c>.
    /// </para>
    /// <para>
    /// This is deliberately the SAME predicate both clients use to decide whether to show the scene, so what is on
    /// the wire and what is on the screen can never disagree. TS twin: `shouldWatchHostStream` in
    /// frontend/src/join/joinModel.ts — keep them in lockstep.
    /// </para>
    /// </summary>
    public static bool ShouldWatchHostStream(
        JoinInfo info,
        string? pendingJoinName,
        string? mirrorMode,
        bool joined,
        bool directView,
        bool seatIntent)
    {
        if (joined || directView)
        {
            return true;
        }

        if (seatIntent)
        {
            return false;
        }

        if (!string.IsNullOrEmpty(pendingJoinName) || info.Status != "connected")
        {
            return false;
        }

        // No session yet (ScreenKind is populated on every real one) ⇒ we do not know which screen the host is on,
        // and "unknown" must read as "do not stream". Without this the gate opens for the few ms between the socket
        // opening and the first `session` landing — long enough for the host to build and ship a multi-MB keyframe
        // of a game we are about to hide again (observed as a watch:true→false flip 7ms apart in a live smoke run).
        if (info.ScreenKind is null)
        {
            return false;
        }

        // A name-based roster assignment is not a view grant.
        return mirrorMode is not null and not "mp-character-select" and not "mp-load-game" and not "mp-run";
    }

    // ---- roster filter -------------------------------------------------------------------------------------------
    //
    // The picker used to filter on "host + local" until a user report exposed the structural defect: `isLocal` is
    // stamped from the connection's ALREADY-ASSIGNED name, so a device that has not joined YET has no local player
    // — and the filter therefore degraded to host-only exactly when it mattered most, offering a player who dropped
    // out of a live run (or who reloaded a saved multiplayer game) nothing but "Watch host" instead of their seat.
    //
    // C# twin of frontend/src/join/joinModel.ts (mirrorRosterFor); keep them in lockstep so the native and web
    // clients render identical rosters.

    /// <summary>
    /// The MIRROR view's roster: host + every MIRROR SEAT, regardless of which device (if any) currently holds the
    /// seat. That is what makes a rejoin possible — a returning device sees the seat it must reclaim before it has
    /// any identity of its own. Genuine remote (non-couch-coop) players are never listed: the host cannot instance
    /// a mirror for them, so offering the row would only produce a rejected join. The host is always kept — every
    /// mode offers it (badged [HOST], never highlighted: picking it HANDLES the host player, which the host machine
    /// already drives, so it is not the row a phone viewer is looking for).
    /// </summary>
    public static IReadOnlyList<SessionPlayerOption> MirrorRosterFor(IReadOnlyList<SessionPlayerOption> players)
    {
        var kept = new List<SessionPlayerOption>(players.Count);
        foreach (var player in players)
        {
            if (player.IsHost || player.IsMirrorSeat)
            {
                kept.Add(player);
            }
        }

        return kept;
    }

    // ---- roster row presentation ---------------------------------------------------------------------------------
    //
    // The per-row emphasis + secondary line every picker renders, in ONE place. TS twins:
    // seatIsUnavailable / seatIsClaimable / shouldShowConnectionCount / connectionCountLabel in
    // frontend/src/join/joinModel.ts — keep them in lockstep (both web pickers and the native JoinPanel render
    // from these, so a rule can only ever be changed for all three at once).

    /// <summary>
    /// A seat the host has declared un-joinable on THIS screen: a lobby zombie (<c>stuck</c> — a live instance with
    /// no game connection, awaiting its reap) or a mid-run seat with no game-connected instance (<c>offline</c> —
    /// the game refuses to admit it). Both render truly disabled with the server's reason, because the server
    /// refuses such a join too. The HOST row is never unavailable: a seat status on it is meaningless (the host
    /// machine drives that player).
    /// </summary>
    public static bool SeatIsUnavailable(SessionPlayerOption player)
        => !player.IsHost && !MirrorSeatStatuses.IsJoinable(player.SeatStatus);

    /// <summary>
    /// The rows to HIGHLIGHT: a ready seat with nobody on it — what this viewer is here to claim. The host is
    /// never highlighted (the host machine already drives that player).
    /// </summary>
    public static bool SeatIsClaimable(SessionPlayerOption player)
        => !player.IsHost && !SeatIsUnavailable(player) && player.ConnectionCount == 0;

    /// <summary>The controller count is only worth words from here up (see <see cref="ShouldShowConnectionCount"/>).</summary>
    public const int MinShownConnectionCount = 2;

    /// <summary>
    /// Whether a roster row shows its controller count at all. ONLY when 2+ devices are on the seat — the unusual
    /// case worth explaining. "0 controllers" / "1 controller" are pure noise on a picker: the <i>claimable</i>
    /// highlight already says "nobody is on this seat", and one controller is simply the normal state. Users read
    /// the zero as a fault ("is this seat broken?"), which is exactly the inverted signal the emphasis rules
    /// removed elsewhere.
    /// </summary>
    public static bool ShouldShowConnectionCount(int connectionCount)
        => connectionCount >= MinShownConnectionCount;

    /// <summary>"N controllers" (the singular is unreachable through the gate above, but kept correct).</summary>
    public static string ConnectionCountLabel(int connectionCount)
        => $"{connectionCount} {(connectionCount == 1 ? "controller" : "controllers")}";

    // Port of trimName: trim, and treat a blank (or null) as null.
    public static string? TrimName(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
