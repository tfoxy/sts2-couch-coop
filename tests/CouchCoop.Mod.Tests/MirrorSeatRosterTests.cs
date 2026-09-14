using CouchCoop.Mod.Session;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.State;

// Checks for the SEAT half of the mirror join screen: the per-seat status the host derives (MirrorSeatDirectory —
// including the grace window that stops a slow cold start being mistaken for a zombie, and the auto-reap) and the
// roster the classifier builds from it (the mp-load-game union of live lobby players with the SAVED RUN's seats,
// the mp_names.json name fallback, and the netId / isMirrorSeat / seatStatus stamps).
//
// These are the two halves of the "a player who drops out of a live run, or reloads a saved multiplayer game, is
// only offered Watch host" defect: the roster has to CONTAIN the seat, and the seat has to be joinable.
internal static class MirrorSeatRosterTests
{
    public static void Run()
    {
        SeatWithNoInstanceIsReady();
        LiveConnectedSeatIsReady();
        LiveDisconnectedSeatStaysReadyThroughTheGraceWindow();
        LiveDisconnectedSeatGoesStuckAndIsReapedAfterTheGrace();
        ReconnectingBeforeTheGraceExpiresRearmsTheClock();
        SeatsAreReadyWithoutASeatTable();

        MidRunSeatMatrix();
        LobbySeatMatrix();
        DeadProcessBeatsTheGamesStaleConnectedFlag();
        MidRunOfflineSeatIsNotReapedButReapsOnceTheHostIsBackInALobby();
        UnknownMirrorModeKeepsTheLobbyRules();

        JoinIsRefusedForANonReadySeat();
        JoinIsAllowedWithoutASeatOpinion();

        LoadGameLobbyUnionsSavedRunSeats();
        SavedSeatNameFallsBackToTheDurableRoster();
        LiveLobbyEntryWinsOverTheSavedSeat();
        RunRosterStampsSeatsAndConnectedness();
        RosterCarriesEachSeatsCharacter();

        // F1 host connectivity log: the SEAT-STATUS transitions this directory narrates onto the lobby panel.
        // Only two of them, and only for a seat this directory has seen before — see NarrateTransition.
    }

    // ---- MirrorSeatDirectory --------------------------------------------------------------------------------

    private sealed class Clock
    {
        public DateTimeOffset Now = new(2026, 8, 1, 12, 0, 0, TimeSpan.Zero);
        public void Advance(TimeSpan by) => Now += by;
    }

    private static (MirrorSeatDirectory Directory, Clock Clock, List<ulong> Reaped) Directory(
        params MirrorSeatDescription[] seats)
    {
        var clock = new Clock();
        var reaped = new List<ulong>();
        var live = seats.ToList();
        var directory = new MirrorSeatDirectory(
            describeSeats: () => live,
            reapSeat: netId =>
            {
                reaped.Add(netId);
                // Model the real reap: the instance is gone, so the seat re-describes as "no process".
                for (var i = 0; i < live.Count; i++)
                {
                    if (live[i].NetId == netId) live[i] = live[i] with { ProcessLive = false, ClaimedName = null };
                }
            },
            clock: () => clock.Now);
        return (directory, clock, reaped);
    }

    private static MirrorSeatDescription Seat(ulong netId, bool processLive, string? name = null)
        => new(netId, name, processLive, Detached: false);

    // No instance at all is READY, not "unavailable": tapping the row spawns a headless bound to that netId, which
    // is exactly how a returning player gets back into their seat.
    private static void SeatWithNoInstanceIsReady()
    {
        var (directory, _, reaped) = Directory(Seat(1002, processLive: false));
        var statuses = directory.Evaluate(new HashSet<ulong>());
        Assert(statuses[1002].Status == MirrorSeatStatuses.Ready, "a seat with no instance is joinable");
        Assert(statuses[1002].Reason is null, "a ready seat carries no reason");
        Assert(reaped.Count == 0, "nothing to reap when nothing is running");
    }

    private static void LiveConnectedSeatIsReady()
    {
        var (directory, clock, reaped) = Directory(Seat(1002, processLive: true, name: "Ann"));
        var connected = new HashSet<ulong> { 1002 };
        Assert(directory.Evaluate(connected)[1002].Status == MirrorSeatStatuses.Ready, "a live connected seat is ready");
        clock.Advance(TimeSpan.FromHours(1));
        Assert(directory.Evaluate(connected)[1002].Status == MirrorSeatStatuses.Ready, "…and stays ready however long it runs");
        Assert(reaped.Count == 0, "a healthy instance is never reaped");
    }

    // THE COLD-START GUARD. A freshly spawned headless is "up but not connected" for its whole 20-30s load (ENet
    // join, ~770 asset preloads, then HTTP). Judging it on one observation would kill every slow start.
    private static void LiveDisconnectedSeatStaysReadyThroughTheGraceWindow()
    {
        var (directory, clock, reaped) = Directory(Seat(1002, processLive: true, name: "Ann"));
        var none = new HashSet<ulong>();
        Assert(directory.Evaluate(none)[1002].Status == MirrorSeatStatuses.Ready, "first observation starts the clock, reports ready");
        clock.Advance(MirrorSeatDirectory.StuckGrace - TimeSpan.FromSeconds(1));
        Assert(directory.Evaluate(none)[1002].Status == MirrorSeatStatuses.Ready, "still inside the grace window → still ready");
        Assert(reaped.Count == 0, "a cold-starting instance is never reaped");
    }

    private static void LiveDisconnectedSeatGoesStuckAndIsReapedAfterTheGrace()
    {
        var (directory, clock, reaped) = Directory(Seat(1002, processLive: true, name: "Ann"));
        var none = new HashSet<ulong>();
        directory.Evaluate(none);
        clock.Advance(MirrorSeatDirectory.StuckGrace + TimeSpan.FromSeconds(1));

        var stuck = directory.Evaluate(none)[1002];
        Assert(stuck.Status == MirrorSeatStatuses.Stuck, "past the grace window a live-but-disconnected seat is stuck");
        Assert(stuck.Reason is not null && stuck.Reason.Contains("restart", StringComparison.OrdinalIgnoreCase),
            "the disabled row explains that the host must restart the game");
        Assert(reaped.Count == 1 && reaped[0] == 1002, "the zombie instance is reaped exactly once");

        // The reap is the remediation: with the instance gone the seat is joinable again (a netId-bound spawn now
        // starts clean), so the disabled row is transient by design.
        var after = directory.Evaluate(none)[1002];
        Assert(after.Status == MirrorSeatStatuses.Ready, "after the reap the seat is joinable again");
        Assert(reaped.Count == 1, "and it is not reaped a second time");
    }

    private static void ReconnectingBeforeTheGraceExpiresRearmsTheClock()
    {
        var (directory, clock, reaped) = Directory(Seat(1002, processLive: true, name: "Ann"));
        directory.Evaluate(new HashSet<ulong>());
        clock.Advance(MirrorSeatDirectory.StuckGrace - TimeSpan.FromSeconds(5));
        // One healthy observation clears the timer, so a seat that flickers never accumulates toward the window.
        directory.Evaluate(new HashSet<ulong> { 1002 });
        clock.Advance(TimeSpan.FromSeconds(10));
        Assert(directory.Evaluate(new HashSet<ulong>())[1002].Status == MirrorSeatStatuses.Ready,
            "a connected observation re-arms the full grace window");
        Assert(reaped.Count == 0, "so the seat is not reaped on the old clock");
    }

    // A headless client instance owns no seats; the directory then has no opinion and reports nothing, which the
    // classifier reads as "every seat ready" — joinability is the game's call.
    private static void SeatsAreReadyWithoutASeatTable()
    {
        var statuses = new MirrorSeatDirectory().Evaluate(new HashSet<ulong>());
        Assert(statuses.Count == 0, "no seat table → no per-seat opinions");
    }

    // ---- host connectivity log: seat-status transitions --------------------------------------------------

    /// <summary>A directory whose seat table can be mutated between evaluations (no reaper wired).</summary>
    private static (MirrorSeatDirectory Directory, List<MirrorSeatDescription> Live) MutableDirectory(
        params MirrorSeatDescription[] seats)
    {
        var live = seats.ToList();
        return (new MirrorSeatDirectory(describeSeats: () => live), live);
    }






    // ---- the mirror-mode matrix ------------------------------------------------------------------------------
    //
    // What the GAME will accept differs between the host's screens, so the same three observations map differently:
    //
    //   host screen              | up + game-connected | up, game-disconnected | no instance
    //   -------------------------+---------------------+-----------------------+-------------
    //   mp-run                   | ready               | offline               | offline
    //   mp-character-select      | ready               | stuck (reaped)        | ready
    //   mp-load-game             | ready               | stuck (reaped)        | ready
    //
    // Mid-run the game refuses a client that is not already in the run (NetError.RunInProgress), so anything but a
    // live game-connected instance is genuinely unusable and has to LOOK unusable — a tappable row there produced a
    // join that silently failed. In a lobby the host still admits peers, so a seat with no instance is
    // spawn-on-demand and only the zombie is disabled (and reaped).
    //
    // THE COLUMNS ARE TESTED IN THAT ORDER FOR A REASON: "no instance" is decided FIRST, because the game keeps a
    // dead peer flagged connected forever, so the third column and the first would otherwise overlap and the first
    // would win — which is exactly the defect DeadProcessBeatsTheGamesStaleConnectedFlag pins.

    private static void MidRunSeatMatrix()
    {
        var (directory, clock, reaped) = Directory(
            // Instance up, the run's live peer, and DETACHED — its browser walked away but the headless was kept
            // alive (MarkDetached). This is the user's working reconnect path; it must stay offered.
            new MirrorSeatDescription(1002, "Ann", ProcessLive: true, Detached: true),
            Seat(1003, processLive: true, name: "Bea"),    // instance up, but the game has no peer for it
            Seat(1004, processLive: false, name: "Cass")); // no instance at all
        var connected = new HashSet<ulong> { 1002 };
        const string mode = MirrorSeatDirectory.RunMirrorMode;

        var first = directory.Evaluate(connected, mode);
        Assert(first[1003].Status == MirrorSeatStatuses.Ready,
            "mid-run, a cold-starting instance inside the grace window is still ready (never judged on one look)");
        Assert(first[1004].Status == MirrorSeatStatuses.Offline,
            "mid-run, a seat with NO instance is offline immediately — there is no cold start to protect");

        clock.Advance(MirrorSeatDirectory.StuckGrace + TimeSpan.FromSeconds(1));
        var statuses = directory.Evaluate(connected, mode);

        Assert(statuses[1002].Status == MirrorSeatStatuses.Ready,
            "mid-run, an instance the game still has a peer for is READY — that is the detached-browser reconnect "
            + "path, which the user confirmed works and this must not break");
        Assert(statuses[1002].Reason is null, "a ready seat carries no reason");
        Assert(statuses[1003].Status == MirrorSeatStatuses.Offline,
            "mid-run, a live-but-game-disconnected seat is offline (not stuck): nothing is broken, the run simply "
            + "cannot be joined");
        Assert(statuses[1004].Status == MirrorSeatStatuses.Offline, "mid-run, a seat with no instance stays offline");
        Assert(statuses[1004].Reason is { } reason && reason.Contains("reload the saved run", StringComparison.OrdinalIgnoreCase),
            "the disabled row names the ONLY way back in — the host reloading the saved run — rather than just "
            + "stating that the run cannot be joined (WS-8: this row is what a viewer whose headless exited reads)");
        Assert(reaped.Count == 0,
            "nothing is reaped mid-run: only the zombie (stuck) case is, and reaping here would buy nothing "
            + "because nothing may spawn into the run anyway");
    }

    private static void LobbySeatMatrix()
    {
        foreach (var mode in new[] { "mp-character-select", "mp-load-game" })
        {
            var (directory, clock, reaped) = Directory(
                Seat(1002, processLive: true, name: "Ann"),
                Seat(1003, processLive: true, name: "Bea"),
                Seat(1004, processLive: false, name: "Cass"));
            var connected = new HashSet<ulong> { 1002 };

            var first = directory.Evaluate(connected, mode);
            Assert(first[1004].Status == MirrorSeatStatuses.Ready,
                $"{mode}: a seat with no instance is spawn-on-demand — tapping it IS the rejoin");
            Assert(first[1003].Status == MirrorSeatStatuses.Ready, $"{mode}: a cold start stays ready inside the grace");

            clock.Advance(MirrorSeatDirectory.StuckGrace + TimeSpan.FromSeconds(1));
            var statuses = directory.Evaluate(connected, mode);

            Assert(statuses[1002].Status == MirrorSeatStatuses.Ready, $"{mode}: a connected instance is ready");
            Assert(statuses[1003].Status == MirrorSeatStatuses.Stuck,
                $"{mode}: past the grace window a live-but-disconnected seat is a zombie");
            Assert(statuses[1004].Status == MirrorSeatStatuses.Ready, $"{mode}: an absent instance stays joinable");
            Assert(reaped.Count == 1 && reaped[0] == 1003, $"{mode}: exactly the zombie is reaped");
        }
    }

    // THE REGRESSION THIS SUITE MISSED, and the exact state live validation found: mid-run, the seat's headless has
    // been SIGKILLed and there is NO instance on the box — yet the GAME still lists that netId as connected. STS2
    // keeps a dead peer flagged connected indefinitely (the host log spams "ERROR: Peer not connected." while the
    // run roster still reports IsConnected), so the netId never leaves gameConnectedNetIds. While connectedness was
    // asked FIRST, that made the mid-run "no instance" cell unreachable in practice: the wire reported ready, the
    // picker offered the row, and the join was ACCEPTED — spawning an instance the run refuses. Process liveness is
    // the one signal that cannot be stale, so it is authoritative.
    private static void DeadProcessBeatsTheGamesStaleConnectedFlag()
    {
        var (directory, _, reaped) = Directory(Seat(1002, processLive: false, name: "Phone1"));
        // The game is STILL insisting this seat is connected — the whole point of the case.
        var staleConnected = new HashSet<ulong> { 1002 };

        var midRun = directory.Evaluate(staleConnected, MirrorSeatDirectory.RunMirrorMode)[1002];
        Assert(midRun.Status == MirrorSeatStatuses.Offline,
            "mid-run, a seat with no headless process is offline even while the game still reports it connected — "
            + "the process is gone, which is the signal that cannot be stale");
        Assert(midRun.Reason is { } reason && reason.Contains("reload the saved run", StringComparison.OrdinalIgnoreCase),
            "…and the disabled row tells the viewer what has to happen (the host reloads the saved run)");
        Assert(directory.RefuseJoin(1002) == MirrorSeatStatuses.UnavailableRejection,
            "…and the join handler refuses it, instead of accepting and spawning into a run that will not take it");
        Assert(reaped.Count == 0, "there is no process to reap");

        // Immediately, with no grace window: the grace exists to protect a COLD START, and a seat with no process
        // has nothing starting up. (It is also the only reason the live defect was observable indefinitely.)
        Assert(directory.Evaluate(staleConnected, MirrorSeatDirectory.RunMirrorMode)[1002].Status == MirrorSeatStatuses.Offline,
            "…and it does not drift back to ready on later observations");

        // The reorder must NOT touch the lobby column: there, no-instance is spawn-on-demand whatever the game says.
        Assert(directory.Evaluate(staleConnected, "mp-character-select")[1002].Status == MirrorSeatStatuses.Ready,
            "in a lobby the same seat stays joinable — tapping it spawns a headless bound to its netId");
        Assert(directory.RefuseJoin(1002) is null, "…so the lobby join is not refused");
    }

    // The reap is tied to `stuck`, so a mid-run zombie survives — but its grace timer stays ARMED, so the cleanup
    // happens on the first lobby evaluation rather than after another full 60s.
    private static void MidRunOfflineSeatIsNotReapedButReapsOnceTheHostIsBackInALobby()
    {
        var (directory, clock, reaped) = Directory(Seat(1002, processLive: true, name: "Ann"));
        var none = new HashSet<ulong>();

        directory.Evaluate(none, MirrorSeatDirectory.RunMirrorMode);
        clock.Advance(MirrorSeatDirectory.StuckGrace + TimeSpan.FromSeconds(1));
        Assert(directory.Evaluate(none, MirrorSeatDirectory.RunMirrorMode)[1002].Status == MirrorSeatStatuses.Offline,
            "mid-run the zombie reads offline");
        Assert(reaped.Count == 0, "…and is left running");

        // The host saves and quits to the load-game lobby: the SAME observation is now a reapable zombie.
        var back = directory.Evaluate(none, "mp-load-game")[1002];
        Assert(back.Status == MirrorSeatStatuses.Stuck, "back in a lobby the same seat reads stuck");
        Assert(reaped.Count == 1 && reaped[0] == 1002, "…and is reaped on the FIRST lobby evaluation (timer stayed armed)");
    }

    // Anything that is not "mp-run" keeps the lobby rules — including null (an older/unknown host screen). Erring
    // that way means an unrecognized screen leaves seats offered rather than locking every one of them out.
    private static void UnknownMirrorModeKeepsTheLobbyRules()
    {
        var (directory, _, _) = Directory(Seat(1002, processLive: false, name: "Ann"));
        var none = new HashSet<ulong>();
        Assert(directory.Evaluate(none, null)[1002].Status == MirrorSeatStatuses.Ready, "a null mirror mode is not the run column");
        Assert(directory.Evaluate(none, "main-menu")[1002].Status == MirrorSeatStatuses.Ready, "nor is an unrelated screen");
        Assert(directory.Evaluate(none, "bogus")[1002].Status == MirrorSeatStatuses.Ready, "nor is an unknown one");
        // The singleplayer character select is a real, current kind that this directory deliberately does NOT
        // name: only "mp-run" takes the run column, and everything else takes the permissive lobby one.
        Assert(directory.Evaluate(none, "sp-character-select")[1002].Status == MirrorSeatStatuses.Ready,
            "nor is the singleplayer character select");
    }

    // ---- the server-side join gate ----------------------------------------------------------------------------

    // The picker disables a non-ready row, and the JOIN HANDLER refuses it too (CouchCoopWebSocketConnection asks
    // this through BrowserStateEnvelopeFactory.RefuseSeatJoin): a stale roster or a hand-crafted client must not be
    // able to drive a join the picker would not offer — that spawns an instance the game then refuses.
    private static void JoinIsRefusedForANonReadySeat()
    {
        var (directory, clock, _) = Directory(
            Seat(1002, processLive: true, name: "Ann"),
            Seat(1003, processLive: false, name: "Bea"));

        Assert(directory.RefuseJoin(1003) is null, "before any evaluation there is no opinion, so nothing is refused");

        directory.Evaluate(new HashSet<ulong> { 1002 }, MirrorSeatDirectory.RunMirrorMode);
        Assert(directory.RefuseJoin(1002) is null, "a ready seat is joinable");
        Assert(directory.RefuseJoin(1003) == MirrorSeatStatuses.UnavailableRejection,
            "a mid-run offline seat is refused with the shared rejection code");
        Assert(directory.RefuseJoin(null) is null,
            "a free-text name submit targets no seat, so the seat gate has nothing to say about it");
        Assert(directory.RefuseJoin(1099) is null, "an unknown netId is left to the game to judge");

        // The lobby zombie is refused for the same reason (it is about to be reaped, not joined). 1002's timer was
        // cleared by the connected observation above, so arm a fresh spell before stepping past the grace.
        directory.Evaluate(new HashSet<ulong>(), "mp-character-select");
        clock.Advance(MirrorSeatDirectory.StuckGrace + TimeSpan.FromSeconds(1));
        directory.Evaluate(new HashSet<ulong>(), "mp-character-select");
        Assert(directory.RefuseJoin(1002) == MirrorSeatStatuses.UnavailableRejection, "a stuck seat is refused too");
        Assert(directory.RefuseJoin(1003) is null, "…while the lobby's instance-less seat stays joinable");
    }

    private static void JoinIsAllowedWithoutASeatOpinion()
    {
        Assert(new MirrorSeatDirectory().RefuseJoin(1002) is null,
            "a headless client instance owns no seats, so its gate never blocks a join");
    }

    // ---- BrowserAssignmentClassifier ------------------------------------------------------------------------

    // THE mp-load-game CASE. On the load-run screen the host is alone in the lobby while the save still expects
    // everyone, so without the union a returning device is offered nothing but "Watch host".
    private static void LoadGameLobbyUnionsSavedRunSeats()
    {
        var state = LoadGameLobby(
            lobby: [LobbyPlayer("p:1", "Hosty", connected: true)],
            saved: ["p:1", "p:1002", "p:1003"]);

        var players = WithNames(new Dictionary<ulong, string> { [1002] = "Ann" },
            () => BrowserAssignmentClassifier.Classify(state, new BrowserSessionRegistry(), requestedName: null).Players);

        Assert(players.Count == 3, "the lobby's host plus the two absent saved seats");
        var seat1002 = Find(players, "p:1002");
        Assert(seat1002.Name == "Ann", "a saved seat is labelled from the durable mp_names.json roster");
        Assert(seat1002.NetId == 1002UL, "netId is recovered from the p:N player id");
        Assert(seat1002.IsMirrorSeat, "1002 is inside the couch-coop seat guard band");
        Assert(seat1002.Disconnected, "a saved seat nobody has rejoined yet renders dimmed (free to reclaim)");
        Assert(seat1002.SeatStatus == MirrorSeatStatuses.Ready, "…and joinable, which is the whole point");

        var host = Find(players, "p:1");
        Assert(host.IsHost && !host.IsMirrorSeat, "the host is netId 1 — kept by the filter, but not a seat");
    }

    // R19 WP-2d: the roster carries each seat's character so the picker can draw an icon beside the name. In
    // the multiplayer SAVE lobby every row is otherwise just a name, which is exactly where telling seats apart
    // matters most.
    private static void RosterCarriesEachSeatsCharacter()
    {
        var lobbyState = LoadGameLobby(
            lobby: [LobbyPlayer("p:1", "Hosty", connected: true)],
            saved: ["p:1", "p:1002"]);

        var lobbyPlayers = WithNames(new Dictionary<ulong, string> { [1002] = "Ann" },
            () => BrowserAssignmentClassifier.Classify(lobbyState, new BrowserSessionRegistry(), requestedName: null).Players);

        Assert(Find(lobbyPlayers, "p:1").CharacterId == "ironclad", "a live lobby entry publishes its character");
        // A saved seat nobody has rejoined has no LIVE lobby entry to read a character from, and the save
        // snapshot carries none — so the field is absent rather than guessed, and the row simply has no icon.
        Assert(Find(lobbyPlayers, "p:1002").CharacterId is null, "an absent saved seat publishes no character rather than a guess");

        var runPlayers = BrowserAssignmentClassifier
            .Classify(Run(RunPlayer("p:1", "Hosty", isHost: true, connected: true)), new BrowserSessionRegistry(), requestedName: null)
            .Players;
        Assert(Find(runPlayers, "p:1").CharacterId == "ironclad", "a run player publishes its character too");
    }

    private static void SavedSeatNameFallsBackToTheDurableRoster()
    {
        var state = LoadGameLobby(lobby: [LobbyPlayer("p:1", "Hosty", connected: true)], saved: ["p:1003"]);

        // The save file stores NO display names anywhere, so with nothing remembered the seat still has to be
        // legible — "Player 1003" beats the raw "p:1003" player id the old code fell back to.
        var unnamed = WithNames(new Dictionary<ulong, string>(),
            () => BrowserAssignmentClassifier.Classify(state, new BrowserSessionRegistry(), requestedName: null).Players);
        Assert(Find(unnamed, "p:1003").Name == "Player 1003", "an unknown saved seat synthesizes a legible label");

        var remembered = WithNames(new Dictionary<ulong, string> { [1003] = "Bea" },
            () => BrowserAssignmentClassifier.Classify(state, new BrowserSessionRegistry(), requestedName: null).Players);
        Assert(Find(remembered, "p:1003").Name == "Bea", "a remembered name wins over the synthesized one");
    }

    private static void LiveLobbyEntryWinsOverTheSavedSeat()
    {
        // The same netId in both lists: the live entry has the real name and the live connected flag, so it wins.
        var state = LoadGameLobby(
            lobby: [LobbyPlayer("p:1", "Hosty", connected: true), LobbyPlayer("p:1002", "Ann", connected: true)],
            saved: ["p:1002", "p:1003"]);

        var players = WithNames(new Dictionary<ulong, string> { [1002] = "STALE" },
            () => BrowserAssignmentClassifier.Classify(state, new BrowserSessionRegistry(), requestedName: null).Players);

        Assert(players.Count == 3, "the union deduplicates by netId, not by list");
        var back = Find(players, "p:1002");
        Assert(back.Name == "Ann", "the live lobby entry's display name beats both the roster file and the save");
        Assert(!back.Disconnected, "a lobby seat the game reports connected is not dimmed");
    }

    private static void RunRosterStampsSeatsAndConnectedness()
    {
        var state = Run(
            RunPlayer("p:1", "Hosty", isHost: true, connected: true),
            RunPlayer("p:1002", "Ann", isHost: false, connected: true),
            // The player who walked away mid-run — the seat this whole workstream exists to make reclaimable.
            RunPlayer("p:1003", "Bea", isHost: false, connected: false),
            // A genuine remote (non-couch-coop) player: outside the guard band, so never a mirror seat.
            RunPlayer("p:1000", "Remote", isHost: false, connected: true));

        var players = WithNames(new Dictionary<ulong, string>(),
            () => BrowserAssignmentClassifier.Classify(state, new BrowserSessionRegistry(), requestedName: null).Players);

        Assert(Find(players, "p:1002").IsMirrorSeat, "1002 is a mirror seat");
        Assert(!Find(players, "p:1002").Disconnected,
            "a CONNECTED seat is not dimmed — the game's peer registry overrides the host's browser bookkeeping, "
            + "which never sees a browser attached to a headless instance");
        Assert(Find(players, "p:1003").Disconnected, "the departed seat is dimmed (free to reclaim)");
        Assert(Find(players, "p:1003").SeatStatus == MirrorSeatStatuses.Ready, "…and still joinable");
        Assert(!Find(players, "p:1000").IsMirrorSeat, "netId 1000 is outside the guard band → not a seat");
        Assert(!Find(players, "p:1").IsMirrorSeat, "the host (netId 1) is not a seat");
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    // Run `body` with a throwaway working directory containing the given mp_names.json roster, so the classifier's
    // ReadMultiplayerNames() call resolves against it instead of whatever is next to the test binary. The tests run
    // sequentially, so swapping the process CWD is safe; it is always restored.
    private static T WithNames<T>(IReadOnlyDictionary<ulong, string> names, Func<T> body)
    {
        var previous = System.IO.Directory.GetCurrentDirectory();
        var temp = Path.Combine(Path.GetTempPath(), "couchcoop-mpnames-" + Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(temp);
        try
        {
            var entries = names.Select(kv => $"{{\"net_id\":{kv.Key},\"name\":\"{kv.Value}\"}}");
            File.WriteAllText(Path.Combine(temp, "mp_names.json"), "[" + string.Join(",", entries) + "]");
            System.IO.Directory.SetCurrentDirectory(temp);
            return body();
        }
        finally
        {
            System.IO.Directory.SetCurrentDirectory(previous);
            try { System.IO.Directory.Delete(temp, recursive: true); } catch { }
        }
    }

    private static BrowserPlayerOption Find(IReadOnlyList<BrowserPlayerOption> players, string playerId)
        => players.FirstOrDefault(player => player.PlayerId == playerId)
            ?? throw new InvalidOperationException($"roster is missing {playerId}: [{string.Join(", ", players.Select(p => p.PlayerId))}]");

    private static StateCharacterSelectPlayerSnapshot LobbyPlayer(string id, string? name, bool connected)
        => new(id, 0, "ironclad", IsReady: false, MaxMultiplayerAscensionUnlocked: 20, DisplayName: name, IsConnected: connected);

    private static StateSnapshot LoadGameLobby(
        IReadOnlyList<StateCharacterSelectPlayerSnapshot> lobby,
        IReadOnlyList<string> saved)
        => new(
            StateSnapshot.CurrentSchemaVersion,
            Language: null,
            RootScene: "screens/character_select_screen",
            CharacterSelect: new StateCharacterSelectSnapshot(
                new StateCharacterSelectLobbySnapshot(
                    "host",
                    LocalPlayerId: "p:1",
                    HostPlayerId: "p:1",
                    ConnectingPlayerCount: 0,
                    Ascension: 0,
                    MaxAscension: 20,
                    Act1: "random",
                    Seed: null,
                    ModifierIds: [],
                    Players: lobby,
                    SavedRun: new StateCharacterSelectSavedRunSnapshot(
                        CurrentActIndex: 0,
                        ActFloor: 3,
                        Players: saved.Select(id => new StateCharacterSelectSavedRunPlayerSnapshot(id, 40, 80, 120)).ToArray())),
                CharacterButtons: [],
                View: null),
            Run: null);

    private static StateRunPlayerSnapshot RunPlayer(string id, string name, bool isHost, bool connected)
        => new(
            id,
            "test",
            NetId: null,
            DisplayName: name,
            CharacterId: "ironclad",
            IsLocal: isHost,
            IsHost: isHost,
            IsRemote: !isHost,
            Creature: null,
            Gold: 0,
            Deck: null,
            Relics: [],
            InventoryComplete: true,
            Notices: [],
            IsConnected: connected);

    private static StateSnapshot Run(params StateRunPlayerSnapshot[] players)
        => new(
            StateSnapshot.CurrentSchemaVersion,
            Language: null,
            RootScene: "run",
            CharacterSelect: null,
            Run: new StateRunSnapshot(
                "test",
                "test",
                "multiplayer",
                "standard",
                "seed:test",
                AscensionLevel: 0,
                ActId: "act1",
                CurrentActIndex: 0,
                ActFloor: 0,
                TotalFloor: 0,
                BossEncounterId: null,
                SecondBossEncounterId: null,
                CurrentMapCoord: null,
                CurrentMapPointId: null,
                VisitedMapCoords: [],
                Players: players,
                Map: null,
                CurrentRoom: null,
                Notices: [],
                View: new StateRunViewSnapshot("p:1", null)));

    private static void Assert(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException("MirrorSeatRosterTests: " + message);
        }
    }
}
