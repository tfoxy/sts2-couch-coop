using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.MirrorProtocol.Envelopes;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Session;

/// <summary>
/// What the host side of a browser join needs from the live game: whether a run or a lobby is current, the
/// lobby's player cap, which netIds already hold a seat, and the names the host can put to them. It also carries
/// the two per-peer actions a couch seat needs, evicting its ENet peer and overriding its display name. The seats
/// are real networked clients, so there is no lobby player to add or remove here. There are NO direct
/// Godot/Harmony calls and no game types in this type (it is source-linked into the hot-reload assembly): the reads go
/// through <see cref="CouchCoopGameFacts"/>, CouchCoop's own typed reader, peer cleanup through the host runtime,
/// and display-name changes through spirectl's existing seam. None builds a full game-state snapshot.
/// </summary>
public sealed class CouchCoopLobbyParticipation(CouchCoopRuntimeHost runtimeHost)
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));

    /// <summary>
    /// How long a lobby may report no usable cap before <see cref="LobbyCapOf"/> says so. A lobby that has just
    /// opened has not negotiated one yet, so the first observation is evidence of nothing.
    /// </summary>
    internal static readonly TimeSpan UnreadableLobbyCapGrace = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Clock behind <see cref="UnreadableLobbyCapGrace"/>. A settable seam rather than a constructor parameter
    /// because the state it measures is static — this type is allocated fresh on every cap read, by three
    /// separate call sites, which is why the notice cannot remember anything on an instance.
    /// </summary>
    internal static Func<DateTimeOffset> LobbyCapClock = () => DateTimeOffset.UtcNow;

    /// <summary>When the cap first read back unusable, or null while it is readable.</summary>
    private static DateTimeOffset? _lobbyCapUnreadableSince;

    /// <summary>Whether <see cref="LobbyCapOf"/> has spoken and still owes a line saying the cap came back.</summary>
    private static bool _warnedUnreadableLobbyCap;

    /// <summary>Forgets an earlier lobby's cap history. For tests, which share one process across suites.</summary>
    internal static void ResetLobbyCapNotice()
    {
        _lobbyCapUnreadableSince = null;
        _warnedUnreadableLobbyCap = false;
    }

    /// <summary>
    /// Force-disconnect a remote ENet peer by its netId when its browser/headless goes away. A SIGKILL'd
    /// headless leaves its peer registered in the host's net server, holding the netId, so the next headless
    /// reusing it fails its ENet join.
    /// </summary>
    public void DisconnectClient(ulong netId) => DisconnectClient(netId, requireSuccess: false);

    public void DisconnectClient(ulong netId, bool requireSuccess)
    {
        try
        {
            _runtimeHost.DisconnectSeatPeer(netId);
        }
        catch (Exception exception)
        {
            if (requireSuccess) throw new InvalidOperationException($"Peer cleanup failed for {netId}: {exception.Message}", exception);
            CouchCoopLog.Stderr($"DisconnectClient({netId}) failed: {exception.Message}");
        }
    }

    /// <summary>
    /// Override the display name the live game shows for a REAL networked client (the headless ENet peer that
    /// joined as <paramref name="netId"/>), so the host lobby + per-viewer mirror render the browser-chosen name
    /// instead of the raw netId. It names the seat that client already holds and adds none — the headless IS the
    /// player, so a second lobby entry would be a duplicate. No-op without the semantic-actions capability.
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
            CouchCoopLog.Stderr($"SetClientName({netId}, '{displayName}') failed: {result.Result?.Message ?? result.Error?.Message}");
        }
        else
        {
            // The name the roster reports for this seat just changed; the game raises nothing for it, so say so.
            CouchCoopRosterSignals.NoteNameChanged();
        }

        return result.Success;
    }

    /// <summary>Clear a client's display-name override (its browser/headless went away). No-op without the capability.</summary>
    public void ClearClientName(ulong netId) => SetClientName(netId, null);

    /// <summary>
    /// Every netId this process can put a NAME to right now, read from a snapshot the caller already holds, for
    /// publishing to the couch seats (<see cref="HeadlessClientManager.PublishRosterNames"/> →
    /// <c>mp_names.json</c>). Pure, so it is unit-testable. This snapshot form is the retired read, kept as the
    /// test-only parity oracle for <see cref="RosterNames(RosterFacts)"/> until the last WP3 read path lands.
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
    /// <summary>The names in the typed roster, without another game read.</summary>
    public static IReadOnlyList<(ulong NetId, string Name)> RosterNames(RosterFacts roster)
    {
        ArgumentNullException.ThrowIfNull(roster);
        return CollectRosterNames(
            (roster.Run?.Seats ?? []).Select(seat => ((string?)seat.Id, seat.DisplayName))
                .Concat((roster.Lobby?.Seats ?? []).Select(seat => ((string?)seat.Id, seat.DisplayName))));
    }

    private static IReadOnlyList<(ulong NetId, string Name)> CollectRosterNames(
        IEnumerable<(string? PlayerId, string? DisplayName)> players)
    {
        var names = new List<(ulong NetId, string Name)>();
        var seen = new HashSet<ulong>();

        foreach (var (playerId, displayName) in players)
        {
            var name = displayName?.Trim();
            if (string.IsNullOrEmpty(name)
                || !MirrorSeatNetIds.TryParsePlayerId(playerId, out var netId)
                || !seen.Add(netId))
            {
                continue;
            }

            // Both platform strategies fall back to `playerId.ToString()` when they cannot name a player
            // (SteamPlatformUtilStrategy on an empty persona, NullPlatformUtilStrategy on an unknown netId), so a
            // "name" that IS the netId means "unknown" — publishing it would bake that placeholder into the durable
            // roster and then override the real name once it resolved.
            if (string.Equals(name, netId.ToString(System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                continue;
            }

            names.Add((netId, name));
        }

        return names;
    }

    /// <summary>
    /// True when a RUN is in progress (combat / map / event / reward — anything past character select, through the
    /// end-of-run summary). Used to gate the headless lifecycle on browser disconnect: mid-run we KEEP the
    /// player's headless alive (so the browser reconnects instantly to the live run) instead of killing it; in the
    /// lobby we kill it as before. It also refuses a seat LAUNCH once the host is in a run.
    /// <para>
    /// One typed member read through <see cref="CouchCoopGameFacts"/>, with no state snapshot and no marshal to
    /// the main thread, so it is safe from a WebSocket or listener thread and cheap enough to ask on every
    /// disconnect and every launch. An unreadable answer (no engine behind the process, or the read threw) reads
    /// as "not in a run", the same answer an unreadable state has always given here: a launch the game would
    /// refuse is refused by the game itself, and a disconnect that cannot tell releases the seat.
    /// </para>
    /// </summary>
    public bool IsRunInProgress() => CouchCoopGameFacts.ReadRunInProgress() == true;

    /// <summary>
    /// Whether the game currently lists <paramref name="netId"/> as a CONNECTED player of the lobby or the run.
    /// This is lobby membership, which is what the join wait needs: a peer is connected before the lobby admits
    /// it, so a seat that is not on the lobby's list yet is not a member. One roster read (see
    /// <see cref="CouchCoopGameFacts.ReadRoster"/>), asked every ~200 ms while a seat joins. A seat that has already
    /// joined uses <see cref="IsSeatPeerConnected"/> instead.
    /// </summary>
    /// <remarks>
    /// An unreadable roster is "not connected", the answer an unreadable game state always gave here.
    /// </remarks>
    public bool IsGamePlayerConnected(ulong netId) => IsPlayerConnected(CouchCoopGameFacts.ReadRoster(), netId);

    /// <summary>
    /// <see cref="IsGamePlayerConnected"/> over a roster the caller already holds. A lobby seat counts only when the
    /// roster marks it connected (the local player, or in the host's peer list, or admitted by the saved-run lobby); a
    /// run seat counts when it is marked connected, which fails open when the game cannot say. Pure.
    /// </summary>
    public static bool IsPlayerConnected(RosterFacts? roster, ulong netId)
        => (roster?.Lobby?.Seats ?? []).Any(seat => seat.IsConnected
                && MirrorSeatNetIds.TryParsePlayerId(seat.Id, out var id) && id == netId)
            || (roster?.Run?.Seats ?? []).Any(seat => seat.IsConnected
                && MirrorSeatNetIds.TryParsePlayerId(seat.Id, out var id) && id == netId);

    private static int _seatPeerCheckFailureLogged;

    /// <summary>
    /// The seat monitor's membership check: whether the host's net layer still has <paramref name="netId"/>
    /// connected. One main-thread read of the host's peer list, where <see cref="IsGamePlayerConnected"/> asks the
    /// roster for the same answer. Falls back to the roster read when this process's host transport is not the one
    /// running (the game's own ENet host, which never passes through CouchCoop's transport) or its peer list cannot be
    /// read.
    /// </summary>
    /// <remarks>
    /// Only for a seat that has already joined. Peer connectivity is not lobby membership: a peer is connected
    /// before the lobby admits it, so the join wait keeps asking <see cref="IsGamePlayerConnected"/>. Once joined,
    /// the two agree, and the monitor asks this every 250 ms per seat for the seat's whole life. Both the peer read
    /// and the roster fallback run in ONE hop onto the main thread (the peer list is the net layer's live state),
    /// and this never holds a mod lock.
    /// </remarks>
    public bool IsSeatPeerConnected(ulong netId)
    {
        try
        {
            return GameMainThread.Invoke(
                () => CouchCoopHostPeers.IsPeerConnected(netId) ?? IsGamePlayerConnected(netId));
        }
        catch (Exception exception)
        {
            // Asked every 250 ms per seat, so say it once rather than flood the log.
            if (Interlocked.Exchange(ref _seatPeerCheckFailureLogged, 1) == 0)
            {
                CouchCoopLog.Stderr($"seat peer check failed ({exception.GetType().Name}: {exception.Message}); using the roster read.");
            }

            return IsGamePlayerConnected(netId);
        }
    }

    /// <summary>
    /// How many COUCH SEATS the live lobby has room for: its own player cap minus the host's seat, or
    /// <see langword="null"/> when there is no lobby to ask (main menu, mid-run, no state capability). Asked of
    /// the game rather than hardcoded — the stock lobby caps at four players, but the multiplayer limit mods
    /// raise it ("Multiplayer Limit Break" writes 16 onto the lobby; "Unlimited" overrides the cap the lobby is
    /// built with), and a hardcoded 3 here was what kept a fifth player out of a 16-player lobby.
    /// <para>
    /// Wired into <see cref="HeadlessClientManager"/> as its max-seats probe, so it is re-read per allocation
    /// rather than sampled once — Limit Break raises the cap lazily, from its own join/connect hooks, well after
    /// the host mod is constructed.
    /// </para>
    /// </summary>
    public int? MaxCouchSeats() => MaxCouchSeatsOf(CouchCoopGameFacts.ReadLobbyCap());

    /// <summary>
    /// <see cref="MaxCouchSeats"/> for a caller that has already read the raw lobby cap (the session envelope reads it
    /// with the roster, in one hop): the cap judged usable by <see cref="LobbyCapOf"/> (which owns the "unreadable
    /// for too long" notice, so every read that reaches the seat table still feeds it), minus the host's seat. Null when
    /// the cap is unknown or unusable.
    /// </summary>
    internal static int? MaxCouchSeatsOf(int? rawLobbyCap)
        => rawLobbyCap is { } reported && LobbyCapOf(reported) is { } usable ? usable - 1 : null;

    /// <summary>
    /// The live lobby's own player cap, host seat included — <see cref="MaxCouchSeats"/>'s source, what browser
    /// admission sizes its socket ceiling from, and what the host transport sizes its ENet listener from.
    /// <see langword="null"/> means UNKNOWN, and every caller has to say what it does with that.
    /// </summary>
    /// <remarks>
    /// It used to answer the stock 4 instead, which was the wrong kind of wrong: the whole reason this reads the
    /// lobby is that a 5-to-8-player game caps at whatever the limit mod wrote, so a fabricated 4 does not
    /// degrade the feature, it silently revokes it. The honest answer when there is no lobby screen on top is
    /// "there is no lobby".
    /// <para>
    /// Read from the lobby on the current screen, live, on the game's main thread, from whichever thread asks:
    /// no game state snapshot is built for it (see <see cref="CouchCoopGameFacts.ReadLobbyCap"/>). The static
    /// <see cref="ReadMaxLobbyPlayers"/> serves a caller that holds no instance.
    /// </para>
    /// </remarks>
    public int? MaxLobbyPlayers() => ReadMaxLobbyPlayers();

    /// <summary><see cref="MaxLobbyPlayers"/>, for a caller with no instance to ask (the host transport at host start).</summary>
    public static int? ReadMaxLobbyPlayers()
        => CouchCoopGameFacts.ReadLobbyCap() is { } cap ? LobbyCapOf(cap) : null;

    /// <summary>
    /// One lobby's reported player cap, or <see langword="null"/> when it is not a usable one.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A cap of 0 is a read that failed, and a lobby admitting one player is not a lobby anyone can join —
    /// either way there is nothing here to size by, and the answer is UNKNOWN. Returning null is deliberately
    /// fail-open: a caller with no cap must not refuse anyone on a guess, because the game is the admission
    /// authority and refuses with a <c>NetError</c> either way. Guessing LOW is the one error the game cannot
    /// correct — it would refuse a seat the lobby had room for, which is exactly how a 5-to-8-player game gets
    /// capped at four.
    /// </para>
    /// <para>
    /// IT IS NOT ANOMALOUS ON ITS OWN, which is what this used to get wrong. A lobby that has only just opened
    /// has not negotiated a cap yet: issue #2 caught a real macOS host reporting <c>-1</c>, at startup, in a
    /// session that then played for an hour — the cap read back on its own and nothing was ever mis-sized. The
    /// old notice fired on that first observation and latched for the process, so a healthy host left a
    /// permanent-looking error in its log and no line to say it had resolved.
    /// </para>
    /// <para>
    /// So the notice has to be EARNED: it speaks only once the cap has stayed unusable across
    /// <see cref="UnreadableLobbyCapGrace"/>, and says so again when it reads back. Being read-driven rather
    /// than timed, a host nobody is asking about never trips it at all — which is right, because with no
    /// caller there is no decision being taken without a cap, and therefore nothing to warn anyone about.
    /// </para>
    /// <para>
    /// The two statics race on a thread-pool caller; the worst a race can produce is a duplicate line, and a
    /// lock around a diagnostic would cost more than the duplicate it prevents.
    /// </para>
    /// </remarks>
    internal static int? LobbyCapOf(int reportedCap)
    {
        if (reportedCap > 1)
        {
            if (_warnedUnreadableLobbyCap)
            {
                CouchCoopLog.Stderr(
                    $"the live lobby now reports a player cap of {reportedCap} — seat limits, the ENet "
                    + "listener size and browser admission are sized by it again.");
            }

            _warnedUnreadableLobbyCap = false;
            _lobbyCapUnreadableSince = null;
            return reportedCap;
        }

        var now = LobbyCapClock();
        _lobbyCapUnreadableSince ??= now;

        if (!_warnedUnreadableLobbyCap && now - _lobbyCapUnreadableSince.Value >= UnreadableLobbyCapGrace)
        {
            _warnedUnreadableLobbyCap = true;
            CouchCoopLog.Stderr(
                $"the live lobby has reported a player cap of {reportedCap} for over "
                + $"{UnreadableLobbyCapGrace.TotalSeconds:0}s — seat limits, the ENet listener size and browser "
                + "admission are all running WITHOUT a known cap until it reads back.");
        }

        return null;
    }

    /// <summary>
    /// One-shot snapshot of the inputs the mirror join handler needs to decide DIRECT_VIEW vs SPAWN/REUSE vs REJECT,
    /// read from a SINGLE roster read for consistency. <see cref="IsSingleplayerRun"/> is a TRUE singleplayer run
    /// (<c>NetGameType == "singleplayer"</c>) — nothing can join it, so the viewer watches the host directly.
    /// <see cref="SpawnAllowed"/> is the window in which the host's session accepts a NEW peer: no run is in
    /// progress and the game is in a multiplayer character-select or load-saved-game lobby
    /// (<c>NetGameType == "host"</c>; the load-saved-game screen is the same lobby shape with a saved run
    /// attached, so one predicate covers both). Once a run starts, or in singleplayer or on the main menu, no NEW
    /// mirror client may be instanced; a same-name reconnect to an already-live headless still reuses its slot,
    /// and a RESPAWN of a seat that already exists is <see cref="MayRejoinNetId"/>'s question, not this one's.
    /// <see cref="HostName"/> is the display name of the host seat so the handler can recognise "the host was
    /// selected" → watch directly, never spawn.
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
        // Every netId the host can name right now (see RosterNames), carried on the SAME roster read that answered
        // the join question so publishing the roster to the seats costs no extra main-thread marshal.
        IReadOnlyList<(ulong NetId, string Name)>? RosterNames = null)
    {
        /// <summary>
        /// Whether a headless may be launched for <paramref name="netId"/> even outside the
        /// <see cref="SpawnAllowed"/> window. True for a netId that is already a seat here, because that is a
        /// RESPAWN of an existing peer rather than a new peer joining. It exists for the LOAD-SAVED-RUN LOBBY,
        /// where the host is typically alone while the save still expects everyone: that lobby accepts exactly
        /// the netIds in the save (<c>NetError.NotInSaveGame</c> otherwise), so a seat-matched instance is
        /// precisely what it will take back, and refusing to launch one was the second half of the "a dropped-out
        /// player is only offered Watch host" defect.
        /// <para>
        /// IT DOES NOT MEAN A RUNNING RUN WILL TAKE THE PEER BACK, and this comment used to say it did ("a
        /// running <c>RunLobby</c> accepts exactly the peers already in the run"). It does not. A host observed
        /// live refused a replacement instance carrying the netId of a player who WAS in that run:
        /// </para>
        /// <para>
        ///   <c>[StartRunLobby (…)] Client 1002 connected but we are already beginning the run!</c><br/>
        ///   <c>[ENetHost] Disconnecting client 1002, reason: RunInProgress</c>
        /// </para>
        /// <para>
        /// What the host actually gates on is whether the peer is already CONNECTED when the run starts, not
        /// whether its netId is in the run. So a seat that keeps its process alive across a browser drop rejoins
        /// (it never disconnected); a seat whose process died is out until the host reloads the save. The launch
        /// itself is refused on that ground in <see cref="HeadlessClientManager"/>, which reads
        /// <see cref="IsRunInProgress"/> directly — this predicate is only about the NEW-peer window.
        /// </para>
        /// <para>
        /// This deliberately does NOT widen the window any further: a netId with no seat here is still refused
        /// mid-run, exactly as before.
        /// </para>
        /// </summary>
        public bool MayRejoinNetId(ulong netId) => SeatNetIds is not null && SeatNetIds.Contains(netId);
    }

    /// <summary>
    /// What a join decides on, read from ONE roster read (<see cref="CouchCoopGameFacts.ReadRoster"/>). An unreadable
    /// roster is the empty context: no run, no spawn window, no host name and no seat table.
    /// </summary>
    public MirrorJoinContext DescribeMirrorJoinContext() => DescribeMirrorJoinContext(CouchCoopGameFacts.ReadRoster());

    /// <summary>
    /// Everything the join handler reads of the game in one hop: the <see cref="MirrorJoinContext"/> its spawn
    /// decision is made on, and the two <see cref="JoinSeatFacts"/> the seat manager launches on. The roster and the
    /// lobby cap come from one marshal onto the main thread (<see cref="CouchCoopGameFacts.ReadRosterAndLobbyCap"/>)
    /// and run presence from its own unmarshalled member read, so a join asks the game once and hands the manager what
    /// it already knows. Never call it while holding a mod lock.
    /// </summary>
    public JoinDescription DescribeJoin()
    {
        var read = CouchCoopGameFacts.ReadRosterAndLobbyCap();
        return DescribeJoin(read, IsRunInProgress());
    }

    /// <summary><see cref="DescribeJoin()"/> over reads the caller already holds. Pure apart from the cap notice.</summary>
    public static JoinDescription DescribeJoin(JoinRead read, bool runInProgress)
        => new(
            DescribeMirrorJoinContext(read.Roster),
            new JoinSeatFacts(read.LobbyCap is { } cap && LobbyCapOf(cap) is { } lobbyCap ? lobbyCap - 1 : null, runInProgress));

    /// <summary>The join handler's whole read of the game: the spawn decision's context and the seat manager's facts.</summary>
    public readonly record struct JoinDescription(MirrorJoinContext Context, JoinSeatFacts Seats);

    /// <summary>
    /// <see cref="DescribeMirrorJoinContext()"/> over a roster the caller already holds. Pure. The run wins over the
    /// lobby, exactly as the roster reports them: the new-peer window is shut for a run, and open for a lobby only when
    /// this process is its host.
    /// </summary>
    public static MirrorJoinContext DescribeMirrorJoinContext(RosterFacts? roster)
    {
        if (roster?.Run is { } run)
        {
            var runHost = run.Seats.FirstOrDefault(seat => seat.IsHost)?.DisplayName?.Trim();
            return new MirrorJoinContext(
                IsSingleplayerRun: string.Equals(run.NetType, NetTypeNames.Singleplayer, StringComparison.Ordinal),
                SpawnAllowed: false,
                HostName: string.IsNullOrEmpty(runHost) ? null : runHost,
                SeatNetIds: NetIdsOf(run.Seats.Select(seat => seat.Id)),
                RosterNames: RosterNames(roster));
        }

        if (roster?.Lobby is { } lobby)
        {
            var lobbyHost = lobby.Seats
                .FirstOrDefault(seat => string.Equals(seat.Id, lobby.HostPlayerId, StringComparison.Ordinal))
                ?.DisplayName?.Trim();
            return new MirrorJoinContext(
                IsSingleplayerRun: false,
                SpawnAllowed: string.Equals(lobby.NetType, NetTypeNames.Host, StringComparison.Ordinal),
                HostName: string.IsNullOrEmpty(lobbyHost) ? null : lobbyHost,
                // The saved run's seats count as seats HERE: on the load-game screen the host is typically alone in
                // the lobby while the save still expects everyone, and those absent netIds are exactly the ones the
                // returning devices must be able to spawn into.
                SeatNetIds: NetIdsOf(lobby.Seats.Select(seat => seat.Id).Concat(lobby.SavedRunSeatIds)),
                RosterNames: RosterNames(roster));
        }

        return new MirrorJoinContext(false, false, null);
    }

    // Every player id in a roster is "p:{netId}"; anything that doesn't parse is not a seat we can spawn.
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
}
