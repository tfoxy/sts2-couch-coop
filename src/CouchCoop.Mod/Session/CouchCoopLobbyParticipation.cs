using CouchCoop.Mod.Runtime;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Core.State;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Bridges a browser viewer's join/leave to a REAL player in the live game's character-select
/// lobby, using spirectl's existing semantic actions (<see cref="SemanticActionKind.JoinLobbyPlayer"/>
/// / <see cref="SemanticActionKind.LeaveLobbyPlayer"/>). spirectl adds a synthetic host-local
/// <c>LobbyPlayer</c> to the live <c>StartRunLobby</c> and surfaces it back through StateV2
/// (<c>characterSelect.lobby.players</c>), so the browser session binds to it by name and renders
/// the per-viewer view. There are NO direct Godot/Harmony calls here — the game integration lives
/// in spirectl; this only invokes it on the existing action seam.
/// </summary>
public sealed class CouchCoopLobbyParticipation(CouchCoopRuntimeHost runtimeHost)
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));

    /// <summary>
    /// Ensure a live lobby player exists for <paramref name="name"/>, so the joining browser binds
    /// to a real <c>p:N</c> player (and the player appears in the live game). Idempotent — spirectl
    /// dedupes by display name. Returns true when a matching lobby player exists or was created;
    /// false (no-op) when semantic actions are unavailable or the game is not in a character-select
    /// lobby (then the viewer stays a spectator, as before).
    /// </summary>
    public bool EnsureLobbyPlayer(string? name)
    {
        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed)
            || !_runtimeHost.HasCapability(CouchCoopRuntimeHost.SemanticActionsCapability))
        {
            return false;
        }

        // Already a lobby player (e.g. reconnect, or the host's own name) — nothing to add.
        if (FindPlayerIdByName(trimmed) is not null)
        {
            return true;
        }

        // Only joinable while a character-select lobby is live.
        if (CurrentState()?.CharacterSelect?.Lobby is null)
        {
            return false;
        }

        var result = _runtimeHost.ExecuteAction(new EmbeddableActionRequest(
            RequestId: Guid.NewGuid().ToString("N"),
            Kind: SemanticActionKind.JoinLobbyPlayer,
            DisplayName: trimmed));

        return result.Success && FindPlayerIdByName(trimmed) is not null;
    }

    /// <summary>
    /// Remove a synthetic lobby player when its last browser disconnects (matches the browser
    /// contract: a lobby-only player is removed at zero browser connections). No-op without the
    /// semantic-actions capability or a blank id.
    /// </summary>
    public void LeaveLobbyPlayer(string? playerId)
    {
        if (string.IsNullOrWhiteSpace(playerId)
            || !_runtimeHost.HasCapability(CouchCoopRuntimeHost.SemanticActionsCapability))
        {
            return;
        }

        _ = _runtimeHost.ExecuteAction(new EmbeddableActionRequest(
            RequestId: Guid.NewGuid().ToString("N"),
            Kind: SemanticActionKind.LeaveLobbyPlayer,
            PlayerId: playerId));
    }

    /// <summary>
    /// Force-disconnect a remote ENet peer by its netId when its browser/headless goes away. Mirrors
    /// <see cref="LeaveLobbyPlayer"/> but evicts the real ENet peer from the host's net server (a SIGKILL'd
    /// headless leaves its peer registered, holding the netId, so the next headless reusing it fails its ENet
    /// join). No-op without the semantic-actions capability.
    /// </summary>
    public void DisconnectClient(ulong netId)
    {
        if (!_runtimeHost.HasCapability(CouchCoopRuntimeHost.SemanticActionsCapability))
        {
            return;
        }

        var result = _runtimeHost.ExecuteAction(new EmbeddableActionRequest(
            RequestId: Guid.NewGuid().ToString("N"),
            Kind: SemanticActionKind.DisconnectClient,
            PlayerId: netId.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        // Surface only failures: a stale peer that isn't evicted would block a same-netId rejoin.
        if (!result.Success)
        {
            Console.Error.WriteLine($"[couch-coop] DisconnectClient({netId}) failed: {result.Result?.Message ?? result.Error?.Message}");
        }
    }

    /// <summary>
    /// Override the display name the live game shows for a REAL networked client (the headless ENet peer that
    /// joined as <paramref name="netId"/>), so the host lobby + per-viewer mirror render the browser-chosen name
    /// instead of the raw netId. Unlike <see cref="EnsureLobbyPlayer"/> this adds NO synthetic seat — the headless
    /// IS the player — so it does not create a duplicate lobby entry. No-op without the semantic-actions capability.
    /// </summary>
    /// <returns>
    /// True when the override actually landed. Callers that CACHE what they have applied (the seat-side
    /// <see cref="HeadlessClientNameSync"/>) must key that cache on this, or a no-op during early boot — the
    /// capability check below, before the runtime is up — would latch as "already applied" and the name would
    /// never be retried.
    /// </returns>
    public bool SetClientName(ulong netId, string? displayName)
    {
        if (!_runtimeHost.HasCapability(CouchCoopRuntimeHost.SemanticActionsCapability))
        {
            return false;
        }

        var result = _runtimeHost.ExecuteAction(new EmbeddableActionRequest(
            RequestId: Guid.NewGuid().ToString("N"),
            Kind: SemanticActionKind.SetClientName,
            PlayerId: netId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            DisplayName: displayName));
        if (!result.Success)
        {
            Console.Error.WriteLine($"[couch-coop] SetClientName({netId}, '{displayName}') failed: {result.Result?.Message ?? result.Error?.Message}");
        }

        return result.Success;
    }

    /// <summary>Clear a client's display-name override (its browser/headless went away). No-op without the capability.</summary>
    public void ClearClientName(ulong netId) => SetClientName(netId, null);

    /// <summary>
    /// Every netId this process can put a NAME to right now, for publishing to the couch seats
    /// (<see cref="HeadlessClientManager.PublishRosterNames"/> → <c>mp_names.json</c>).
    /// <para>
    /// WHY THE HOST HAS TO PUBLISH THIS. A name is never sent over the wire: every label the game draws goes
    /// through <c>PlatformUtil.GetPlayerNameRaw(NetService.Platform, netId)</c>, and a couch seat's platform is
    /// <c>None</c> — its <c>NullPlatformUtilStrategy</c> knows only <c>mp_names.json</c> and otherwise prints the
    /// raw netId. So a seat can only ever name a player the HOST wrote down for it. That includes the host
    /// itself (whose netId is its SteamID64 on a Steam-hosted session — hence a 17-digit "name" on every seat)
    /// and any genuine remote Steam friend, neither of which the seat can resolve on its own.
    /// </para>
    /// <para>
    /// Read from the host's OWN resolution, which is already correct for everyone: a Steam id resolves through
    /// the Steam persona lookup, and a couch seat through the display-name override registry
    /// (<see cref="SetClientName"/>) — both behind spirectl's lobby name resolver.
    /// </para>
    /// </summary>
    public IReadOnlyList<(ulong NetId, string Name)> RosterNames()
        => CurrentState() is { } state ? RosterNames(state) : [];

    /// <summary>
    /// <see cref="RosterNames()"/> from a snapshot the caller already holds (the state observer's, so the roster
    /// can be republished on a roster change without a second state pull). Pure, so it is unit-testable.
    /// </summary>
    public static IReadOnlyList<(ulong NetId, string Name)> RosterNames(StateSnapshot state)
    {
        var names = new List<(ulong NetId, string Name)>();
        var seen = new HashSet<ulong>();

        void Add(string? playerId, string? displayName)
        {
            var name = displayName?.Trim();
            if (string.IsNullOrEmpty(name)
                || !MirrorSeatNetIds.TryParsePlayerId(playerId, out var netId)
                || !seen.Add(netId))
            {
                return;
            }

            // Both platform strategies fall back to `playerId.ToString()` when they cannot name a player
            // (SteamPlatformUtilStrategy on an empty persona, NullPlatformUtilStrategy on an unknown netId), so a
            // "name" that IS the netId means "unknown" — publishing it would bake that placeholder into the
            // durable roster and then override the real name once it resolved.
            if (string.Equals(name, netId.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                return;
            }

            names.Add((netId, name));
        }

        foreach (var player in state.Run?.Players ?? [])
        {
            Add(player.Id, player.DisplayName);
        }

        // The lobby is read even during a run: nothing populates both, so this is simply "whichever the host is
        // in". A saved run's players carry no name at all (the save has NetIds only), which is exactly what the
        // durable roster remembers FOR them — so there is nothing to add from SavedRun here.
        foreach (var player in state.CharacterSelect?.Lobby?.Players ?? [])
        {
            Add(player.Id, player.DisplayName);
        }

        return names;
    }

    /// <summary>
    /// True when a RUN is in progress (combat / map / event / reward — anything past character select). Used to
    /// gate the headless lifecycle on browser disconnect: mid-run we KEEP the player's headless alive (so the
    /// browser reconnects instantly to the live run) instead of killing it; in the lobby we kill it as before.
    /// Null/unknown state (no capability, main menu) reads as "not in a run".
    /// </summary>
    public bool IsRunInProgress() => CurrentState()?.Run is not null;

    /// <summary>
    /// True when the host may LAUNCH A NEW headless client right now: no run is in progress AND the game is in a
    /// multiplayer character-select / load-saved-game lobby (<c>NetGameType == "host"</c>). These are the only
    /// moments the host's ENet session accepts a newly joining peer. Once a run starts, or in singleplayer / on the
    /// main menu, no NEW mirror client may be instanced — a same-name reconnect to an already-live headless is still
    /// allowed (that reuses an existing slot, it does not launch). The multiplayer load-saved-game screen is also a
    /// <c>CharacterSelect</c> lobby with <c>NetGameType=="host"</c> (<c>SavedRun != null</c>), so this single
    /// predicate covers both lobby variants.
    /// <para>
    /// This is the NEW-PEER window only. A RESPAWN of a seat that already exists in the current run or the loaded
    /// save is a different question and is answered by <see cref="MirrorJoinContext.MayRejoinNetId"/> — see there.
    /// </para>
    /// </summary>
    public bool MayLaunchNewHeadless()
        => CurrentState() is { Run: null, CharacterSelect.Lobby: { NetGameType: "host" } lobby }
            && HasFreeLobbySlot(lobby.Players.Count, lobby.ConnectingPlayerCount, lobby.MaxPlayers);

    /// <summary>
    /// How many COUCH SEATS the live lobby has room for: its own player cap minus the host's seat. Asked of the
    /// game rather than hardcoded — the stock lobby caps at four players, but the multiplayer limit mods raise it
    /// ("Multiplayer Limit Break" writes 16 onto the lobby; "Unlimited" overrides the cap the lobby is built with),
    /// and a hardcoded 3 here was what kept a fifth player out of a 16-player lobby.
    /// <para>
    /// Wired into <see cref="HeadlessClientManager"/> as its max-seats probe, so it is re-read per allocation
    /// rather than sampled once — Limit Break raises the cap lazily, from its own join/connect hooks, well after
    /// the host mod is constructed. Falls back to the stock three seats whenever there is no lobby to ask
    /// (main menu, mid-run, no state capability), which is also when nothing is allocating seats anyway.
    /// </para>
    /// </summary>
    public int MaxCouchSeats() => MaxLobbyPlayers() - 1;

    /// <summary>
    /// The live lobby's own player cap, host seat included — <see cref="MaxCouchSeats"/>'s source, and what the
    /// host transport sizes its ENet listener from. Falls back to the stock cap when there is no lobby to ask.
    /// </summary>
    public int MaxLobbyPlayers()
        => CurrentState()?.CharacterSelect?.Lobby is { MaxPlayers: > 1 } lobby
            ? lobby.MaxPlayers
            : StateCharacterSelectLobbyDefaults.MaxPlayers;

    /// <summary>
    /// Whether a NEW peer could still be admitted. Slots used to be a couch-only resource (three seats beside the
    /// host); with Steam hosting they are SHARED with remote players, so the host must ask the lobby rather than
    /// assume. Peers still mid-handshake are counted: they hold a slot the moment the lobby accepts them, and a
    /// seat launched into the gap would be rejected on arrival after a ~30s startup.
    /// <para>
    /// <paramref name="maxLobbyPlayers"/> is the lobby's OWN cap (<c>StartRunLobby.MaxPlayers</c>), not a constant
    /// of ours. It used to be hardcoded to 4, justified by the slotId being serialized in two bits — but both
    /// multiplayer limit mods rewrite that serialization (Limit Break ships its own lobby codec, Unlimited
    /// transpiles the packed bit widths), so the wire is no longer the limit and the lobby is the only honest
    /// source. A non-positive value reads as the stock cap.
    /// </para>
    /// </summary>
    internal static bool HasFreeLobbySlot(int playerCount, uint connectingPlayerCount, int maxLobbyPlayers)
        => playerCount + (long)connectingPlayerCount
            < (maxLobbyPlayers > 0 ? maxLobbyPlayers : StateCharacterSelectLobbyDefaults.MaxPlayers);

    /// <summary>
    /// One-shot snapshot of the inputs the mirror join handler needs to decide DIRECT_VIEW vs SPAWN/REUSE vs REJECT,
    /// read from a SINGLE state pull for consistency. <see cref="IsSingleplayerRun"/> is a TRUE singleplayer run
    /// (<c>NetGameType == "singleplayer"</c>) — nothing can join it, so the viewer watches the host directly.
    /// <see cref="SpawnAllowed"/> mirrors <see cref="MayLaunchNewHeadless"/>. <see cref="HostName"/> is the display
    /// name of the host seat so the handler can recognise "the host was selected" → watch directly, never spawn.
    /// (A couch-coop host always reports <c>NetGameType=="host"</c> even solo — a multiplayer host is a host
    /// whatever transport it runs on, Steam lobby or ENet — so a 1-player couch-coop run is NOT
    /// <see cref="IsSingleplayerRun"/>.)
    /// <para>
    /// <see cref="SeatNetIds"/> is every netId that ALREADY has a seat in whatever the host is currently in — the
    /// live run's players, or the lobby's players unioned with the seats of the saved run it is about to resume.
    /// </para>
    /// </summary>
    public readonly record struct MirrorJoinContext(
        bool IsSingleplayerRun,
        bool SpawnAllowed,
        string? HostName,
        IReadOnlySet<ulong>? SeatNetIds = null,
        // Every netId the host can name right now (see RosterNames), carried on the SAME state pull that answered
        // the join question so publishing the roster to the seats costs no extra main-thread marshal.
        IReadOnlyList<(ulong NetId, string Name)>? RosterNames = null)
    {
        /// <summary>
        /// Whether a headless may be launched for <paramref name="netId"/> even outside the
        /// <see cref="SpawnAllowed"/> window. True for a netId that is already a seat here, because that is a
        /// RESPAWN of an existing peer rather than a new peer joining: the game gates a rejoin on netId — the
        /// load-run lobby accepts exactly the netIds in the save (<c>NetError.NotInSaveGame</c> otherwise) and a
        /// running <c>RunLobby</c> accepts exactly the peers already in the run (<c>NetError.RunInProgress</c>
        /// otherwise) — so a seat-matched instance is precisely what it WILL take back. Refusing to launch it was
        /// the second half of the "a dropped-out player is only offered Watch host" defect: even an unfiltered
        /// roster row was unjoinable because the spawn window was shut.
        /// <para>
        /// This deliberately does NOT widen the window any further: a netId with no seat here is still refused
        /// mid-run, exactly as before.
        /// </para>
        /// </summary>
        public bool MayRejoinNetId(ulong netId) => SeatNetIds is not null && SeatNetIds.Contains(netId);
    }

    public MirrorJoinContext DescribeMirrorJoinContext()
    {
        var state = CurrentState();
        if (state?.Run is { } run)
        {
            var runHost = run.Players.FirstOrDefault(player => player.IsHost)?.DisplayName?.Trim();
            return new MirrorJoinContext(
                IsSingleplayerRun: string.Equals(run.NetGameType, "singleplayer", StringComparison.Ordinal),
                SpawnAllowed: false,
                HostName: string.IsNullOrEmpty(runHost) ? null : runHost,
                SeatNetIds: NetIdsOf(run.Players.Select(player => player.Id)),
                RosterNames: RosterNames(state));
        }

        if (state?.CharacterSelect?.Lobby is { } lobby)
        {
            var lobbyHost = lobby.Players
                .FirstOrDefault(player => string.Equals(player.Id, lobby.HostPlayerId, StringComparison.Ordinal))
                ?.DisplayName?.Trim();
            return new MirrorJoinContext(
                IsSingleplayerRun: false,
                SpawnAllowed: string.Equals(lobby.NetGameType, "host", StringComparison.Ordinal),
                HostName: string.IsNullOrEmpty(lobbyHost) ? null : lobbyHost,
                // The saved run's seats count as seats HERE: on the load-game screen the host is typically alone in
                // the lobby while the save still expects everyone, and those absent netIds are exactly the ones the
                // returning devices must be able to spawn into.
                SeatNetIds: NetIdsOf(lobby.Players.Select(player => player.Id)
                    .Concat((lobby.SavedRun?.Players ?? []).Select(player => player.Id))),
                RosterNames: RosterNames(state));
        }

        return new MirrorJoinContext(false, false, null);
    }

    // Every player id in a StateSnapshot is "p:{netId}"; anything that doesn't parse is not a seat we can spawn.
    private static IReadOnlySet<ulong> NetIdsOf(IEnumerable<string?> playerIds)
    {
        var netIds = new HashSet<ulong>();
        foreach (var playerId in playerIds)
        {
            if (MirrorSeatNetIds.TryParsePlayerId(playerId, out var netId))
            {
                netIds.Add(netId);
            }
        }

        return netIds;
    }

    private string? FindPlayerIdByName(string name)
    {
        var players = CurrentState()?.CharacterSelect?.Lobby?.Players;
        if (players is null)
        {
            return null;
        }

        foreach (var player in players)
        {
            if (!string.IsNullOrWhiteSpace(player.Id)
                && string.Equals(player.DisplayName?.Trim(), name, StringComparison.Ordinal))
            {
                return player.Id;
            }
        }

        return null;
    }

    private StateSnapshot? CurrentState()
    {
        if (!_runtimeHost.HasCapability(CouchCoopRuntimeHost.StateCapability))
        {
            return null;
        }

        var result = _runtimeHost.GetCurrentState(new CurrentStateRequest());
        return result.Success ? result.State : null;
    }
}
