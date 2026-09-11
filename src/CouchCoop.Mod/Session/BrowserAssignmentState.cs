using System.Globalization;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.State;

namespace CouchCoop.Mod.Session;

// The browser DTO records (BrowserSessionDto / BrowserPlayerOption / BrowserScreenDto / BrowserAssignmentNotice)
// moved to the shared CouchCoop.MirrorProtocol library (namespace CouchCoop.MirrorProtocol.Envelopes) so the native
// Godot client and the mod share one definition; the wire bytes are unchanged. BrowserAssignmentState + the
// classifier stay here (they depend on spirectl StateSnapshot).
public sealed record BrowserAssignmentState(
    BrowserSessionDto Session,
    IReadOnlyList<BrowserPlayerOption> Players,
    BrowserScreenDto Screen,
    IReadOnlyList<BrowserAssignmentNotice> Notices)
{
    public string? AssignedPlayerId => Session.Joined ? Session.PlayerId : null;
}

public static class BrowserAssignmentNoticeCodes
{
    public const string HostInLobby = "host-in-lobby";
    public const string HostInRun = "host-in-run";
    public const string UnsupportedScreen = "unsupported-screen";
    public const string SingleplayerUnsupported = "singleplayer-unsupported";
}

public static class BrowserAssignmentClassifier
{
    public static BrowserAssignmentState Classify(
        StateSnapshot? state,
        BrowserSessionRegistry registry,
        string? requestedName)
        => Classify(state, registry, requestedName, handle: null);

    public static BrowserAssignmentState Classify(
        StateSnapshot? state,
        BrowserSessionRegistry registry,
        string? requestedName,
        BrowserSessionHandle? handle,
        // Derives the per-seat joinability the clients render (and auto-reaps a zombie instance). Null → every seat
        // reports ready, which is how a headless client instance and the unit tests classify.
        MirrorSeatDirectory? seats = null)
    {
        ArgumentNullException.ThrowIfNull(registry);

        var screenType = NullIfBlank(state?.RootScene);
        var screenTitle = ScreenTitle(screenType);
        var mirrorMode = MirrorModeFor(state);
        if (state?.CharacterSelect is not null)
        {
            var players = LobbyPlayers(state, registry);
            var lobbyScreen = new BrowserScreenDto("lobby", screenType, screenTitle, mirrorMode);
            var assignment = handle is not null
                ? registry.JoinHandle(handle, requestedName, players, lobbyScreen, hostInRun: false)
                : registry.JoinLobby(requestedName, players, lobbyScreen);
            return StampSeats(assignment, LobbyConnectedNetIds(state), seats, mirrorMode);
        }

        if (state?.Run is not null)
        {
            var runPlayers = RunPlayers(state, registry);
            var runScreen = new BrowserScreenDto("run", screenType, screenTitle, mirrorMode);
            // Singleplayer runs are browser-controllable too: the local bridge can execute the local
            // player's actions (the "local-only-degraded" orchestration capability). The auto-player
            // drives a singleplayer run, so it is treated as a normal, joinable run.
            var assignment = handle is not null
                ? registry.JoinHandle(handle, requestedName, runPlayers, runScreen, hostInRun: true)
                : registry.JoinRun(requestedName, runPlayers, runScreen);
            return StampSeats(assignment, RunConnectedNetIds(state), seats, mirrorMode);
        }

        return registry.Unjoined(
            requestedName,
            [],
            new BrowserScreenDto("unsupported", screenType, screenTitle, mirrorMode),
            new BrowserAssignmentNotice(
                BrowserAssignmentNoticeCodes.UnsupportedScreen,
                "info",
                "This screen is not available in the browser session.",
                screenType,
                screenTitle));
    }

    // ---- seat stamping -----------------------------------------------------------------------------------------

    // Stamp the mirror-seat facts onto every roster option, AFTER the registry has merged its own bookkeeping in.
    // Doing it as a post-pass (rather than threading the fields through BrowserSessionRegistry) keeps the registry's
    // name/connection semantics untouched and means there is exactly ONE place the wire-visible seat contract is
    // decided. netId is recovered from the option's own player id — every state-snapshot player id is "p:{netId}",
    // so no extra plumbing is needed and the registry's synthetic lobby-only options (whose id is the raw display
    // name) correctly fail to parse and stay non-seats.
    private static BrowserAssignmentState StampSeats(
        BrowserAssignmentState assignment,
        IReadOnlySet<ulong> gameConnectedNetIds,
        MirrorSeatDirectory? seats,
        // The host screen this roster describes. The directory needs it because what the GAME will accept differs
        // between screens: mid-run (mp-run) a seat without a live, game-connected instance is genuinely unusable,
        // while on a lobby screen the same seat is spawn-on-demand. See MirrorSeatDirectory's matrix.
        string? mirrorMode)
    {
        var statuses = seats?.Evaluate(gameConnectedNetIds, mirrorMode);
        var stamped = new List<BrowserPlayerOption>(assignment.Players.Count);
        foreach (var player in assignment.Players)
        {
            if (!MirrorSeatNetIds.TryParsePlayerId(player.PlayerId, out var netId))
            {
                stamped.Add(player);
                continue;
            }

            var isMirrorSeat = MirrorSeatNetIds.IsMirrorSeat(netId);
            var status = isMirrorSeat && statuses is not null && statuses.TryGetValue(netId, out var resolved)
                ? resolved
                : MirrorSeatStatus.Ready;

            var gameConnected = gameConnectedNetIds.Contains(netId);
            stamped.Add(player with
            {
                NetId = netId,
                IsMirrorSeat = isMirrorSeat,
                SeatStatus = status.Status,
                SeatStatusReason = status.Reason,
                // Whether to DIM the row ("someone is here" vs "free to reclaim"). Note this never means
                // "unjoinable" — that is SeatStatus's job.
                //
                // For a MIRROR SEAT the game's connectedness REPLACES the registry's flag rather than being OR-ed
                // with it, because the registry's flag is structurally wrong for these rows: a seat's browser is
                // attached to that seat's own HEADLESS instance, not to the host, so the host's session registry
                // never sees it and marks every mirror seat "disconnected" no matter how live it is. The seat's real
                // ENet peer IS the headless, so the host's netcode is the authority. Every other row keeps the old
                // rule, with the game's connectedness only able to ADD a disconnect.
                Disconnected = isMirrorSeat
                    ? !gameConnected
                    : player.Disconnected || !gameConnected,
            });
        }

        return assignment with { Players = stamped };
    }

    // The netIds the GAME reports as connected in a character-select lobby. Note this is the lobby's own
    // ConnectedPlayerIds (via spirectl), NOT couch-coop's browser-session bookkeeping: for a mirror seat the real
    // ENet peer IS the headless instance, so the game is the authority on whether that seat is live.
    private static IReadOnlySet<ulong> LobbyConnectedNetIds(StateSnapshot state)
    {
        var connected = new HashSet<ulong>();
        foreach (var player in state.CharacterSelect?.Lobby?.Players ?? [])
        {
            if (player.IsConnected && MirrorSeatNetIds.TryParsePlayerId(player.Id, out var netId))
            {
                connected.Add(netId);
            }
        }

        return connected;
    }

    // The run-time counterpart, from spirectl's StateRunPlayerSnapshot.IsConnected (resolved from the host net
    // service's live peer registry). That field defaults TRUE and stays true whenever connectedness cannot be
    // determined, so an unknown never reads as a false "disconnected" here either.
    private static IReadOnlySet<ulong> RunConnectedNetIds(StateSnapshot state)
    {
        var connected = new HashSet<ulong>();
        foreach (var player in state.Run?.Players ?? [])
        {
            if (player.IsConnected && MirrorSeatNetIds.TryParsePlayerId(player.Id, out var netId))
            {
                connected.Add(netId);
            }
        }

        return connected;
    }

    // ---- roster construction -----------------------------------------------------------------------------------

    /// <summary>
    /// The lobby roster: the live lobby players UNIONED, for a load-saved-game lobby, with the seats of the saved run
    /// itself.
    /// <para>
    /// The union is what makes reloading a saved multiplayer game rejoinable. On the load-run screen the host is
    /// alone in the lobby until the other players come back, so <c>lobby.Players</c> lists only the host — and a
    /// returning device offered that roster has nothing to pick but "Watch host". <c>lobby.SavedRun.Players</c>
    /// carries the seats the save expects, which are exactly the netIds the game will accept
    /// (<c>NetError.NotInSaveGame</c> for anything else), so they are the rows that must be offered.
    /// </para>
    /// <para>
    /// Both lists key on the same identity — a saved seat's id is <c>p:{SerializablePlayer.NetId}</c>, the same
    /// <c>p:{netId}</c> shape as a lobby player — so the union is by netId and the LIVE entry wins where both exist
    /// (it has the real display name and the live connected flag).
    /// </para>
    /// </summary>
    private static IReadOnlyList<BrowserPlayerOption> LobbyPlayers(StateSnapshot state, BrowserSessionRegistry registry)
    {
        var lobby = state.CharacterSelect?.Lobby;
        if (lobby is null)
        {
            return [];
        }

        var hostPlayerId = NullIfBlank(lobby.HostPlayerId);
        // The durable netId→name roster, read ONCE per classification (it is a small file read). This is the only
        // place a player's chosen name survives the host quitting: the game's save stores NetIds but NO display names
        // anywhere, so without it every seat of a reloaded run would render as a bare number.
        var persistedNames = HeadlessClientManager.ReadMultiplayerNames();

        // Ordered + keyed by playerId so the union is by identity while the render order stays lobby-first.
        var byPlayerId = new Dictionary<string, BrowserPlayerOption>(StringComparer.Ordinal);
        var ordered = new List<string>();

        void Add(string playerId, string? displayName, bool isConnected, string? characterId)
        {
            if (byPlayerId.ContainsKey(playerId))
            {
                return; // first writer wins → the live lobby entry beats the saved-run one.
            }

            var option = registry.ToPlayerOption(
                playerId,
                ResolveDisplayName(playerId, displayName, persistedNames),
                string.Equals(playerId, hostPlayerId, StringComparison.Ordinal),
                isRunPlayer: false,
                characterId);
            // A lobby seat the game does not currently have a peer for renders dimmed ("free to reclaim"). Until now
            // StateCharacterSelectPlayerSnapshot.IsConnected was ignored entirely, so every saved/absent seat looked
            // live. (StampSeats re-applies the same rule for run screens; doing it here too keeps a lobby option
            // honest even for the non-seat rows StampSeats leaves alone.)
            byPlayerId[playerId] = isConnected ? option : option with { Disconnected = true };
            ordered.Add(playerId);
        }

        foreach (var player in lobby.Players)
        {
            if (NullIfBlank(player.Id) is { } playerId)
            {
                Add(playerId, player.DisplayName, player.IsConnected, player.CharacterId);
            }
        }

        foreach (var saved in lobby.SavedRun?.Players ?? [])
        {
            if (NullIfBlank(saved.Id) is { } playerId)
            {
                // A saved seat that is not in the lobby has, by definition, nobody connected to it — that IS the
                // rejoin case. The save carries no name at all, so ResolveDisplayName falls through to mp_names.json
                // and finally to a synthesized "Player 1003".
                //
                // …nor a CHARACTER, on this list: StateCharacterSelectSavedRunPlayerSnapshot is the load-run
                // InfoPanel's hp/gold summary and carries no character id. It does not need one — a load-run
                // lobby's `lobby.Players` is itself derived from the SAVE's player list (spirectl's
                // Sts2StateProvider.ResolveLoadRunPlayers, which reads the saved player's own CharacterId), so
                // every saved seat has already been Added above WITH its character. This loop only ever adds a
                // seat the lobby list somehow missed, and for that one an icon is genuinely unknown.
                Add(playerId, displayName: null, isConnected: false, characterId: null);
            }
        }

        // BrowserSessionRegistry.MergePlayers keys its merge dictionary by NAME, so duplicate names would throw.
        // Names are deduped LAST (after the identity union) so the union itself never collapses two distinct seats.
        var players = ordered.Select(id => byPlayerId[id]);
        return players
            .GroupBy(player => player.Name, StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();
    }

    private static IReadOnlyList<BrowserPlayerOption> RunPlayers(StateSnapshot state, BrowserSessionRegistry registry)
    {
        var players = new List<BrowserPlayerOption>();
        var hostPlayerId = NullIfBlank(state.Run?.Players.FirstOrDefault(player => player.IsHost)?.Id);
        var persistedNames = HeadlessClientManager.ReadMultiplayerNames();

        foreach (var player in state.Run?.Players ?? [])
        {
            var playerId = NullIfBlank(player.Id);
            if (playerId is null)
            {
                continue;
            }

            players.Add(registry.ToPlayerOption(
                playerId,
                // Same name resolution as the lobby: the run snapshot normally carries a real DisplayName, but where
                // it doesn't the durable roster beats falling back to the raw "p:1003" the old code showed.
                ResolveDisplayName(playerId, player.DisplayName, persistedNames),
                player.IsHost || string.Equals(playerId, hostPlayerId, StringComparison.Ordinal),
                isRunPlayer: true,
                // A run player always has a character — that is what the seat IS mid-run — so the picker's icon
                // is populated for every mp-run row.
                player.CharacterId));
        }

        return players
            .GroupBy(player => player.PlayerId, StringComparer.Ordinal)
            .Select(group => group.First())
            .ToArray();
    }

    // The label for a seat, in descending order of trustworthiness: the live display name the game reports; else the
    // durable mp_names.json roster (the ONLY persistent netId→name map — the save file stores no names at all);
    // else a synthesized "Player {netId}", which is still far more legible than the raw "p:1003" player id.
    private static string ResolveDisplayName(
        string playerId,
        string? displayName,
        IReadOnlyDictionary<ulong, string> persistedNames)
    {
        if (NullIfBlank(displayName) is { } live)
        {
            return live;
        }

        if (!MirrorSeatNetIds.TryParsePlayerId(playerId, out var netId))
        {
            return playerId;
        }

        if (persistedNames.TryGetValue(netId, out var persisted) && NullIfBlank(persisted) is { } remembered)
        {
            return remembered;
        }

        return "Player " + netId.ToString(CultureInfo.InvariantCulture);
    }

    // Screen discriminator for the mirror view. Both lobby variants (start-run character-select and
    // load-saved-game) are CharacterSelect snapshots; only the load-game one carries a SavedRun, so it is
    // distinguished here. A TRUE singleplayer run (NetGameType "singleplayer") is separated from a multiplayer
    // run so the mirror can enter it directly (nothing can join it). Everything else reads as the main menu.
    //
    // The SINGLEPLAYER character select is split out for exactly the same reason as the singleplayer run: nobody
    // can join it, so a phone must MIRROR the screen rather than be shown a join form that cannot work. Every
    // consumer of the vocabulary (ComputeMirrorJoinMode / computeMirrorJoinMode, isMultiplayerMirrorMode,
    // MirrorSeatDirectory.Evaluate, the native UiRoot) already defaults an unlisted kind to the title-only /
    // non-multiplayer branch, so this arm alone delivers "no name form, stream gate open" on both clients — and
    // an OLDER client, which normalizes the unknown kind to null, lands on the same title-only default.
    //
    // Two deliberate choices:
    //   * the test is `== "singleplayer"`, NOT `!= "host"`. An absent or unreadable NetGameType must degrade to
    //     today's "mp-character-select" — keeping the join form on the one screen this mod exists for is the
    //     fail-safe direction. A "client" lobby (this machine joined someone else's host) is likewise still a
    //     multiplayer context and stays "mp-character-select".
    //   * it sits BELOW the SavedRun arm, so a load-saved-game lobby keeps "mp-load-game" whatever its
    //     NetGameType reads.
    private static string MirrorModeFor(StateSnapshot? state)
        => state switch
        {
            { Run.NetGameType: "singleplayer" } => "singleplayer-run",
            { Run: not null } => "mp-run",
            { CharacterSelect.Lobby.SavedRun: not null } => "mp-load-game",
            { CharacterSelect.Lobby.NetGameType: "singleplayer" } => "sp-character-select",
            { CharacterSelect: not null } => "mp-character-select",
            _ => "main-menu",
        };

    private static string? ScreenTitle(string? screenType)
        => screenType switch
        {
            "screens/character_select_screen" => "Character Select",
            "main-menu" => "Main Menu",
            "run" => "Run",
            null => null,
            _ => screenType
        };

    private static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
