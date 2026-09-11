using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Session;

public sealed class BrowserSessionRegistry
{
    private readonly object _gate = new();
    private readonly Dictionary<string, BrowserIdentity> _identities = new(StringComparer.Ordinal);

    public BrowserSessionHandle CreateHandle() => new(this);

    public BrowserAssignmentState JoinLobby(
        string? requestedName,
        IReadOnlyList<BrowserPlayerOption> upstreamPlayers,
        BrowserScreenDto screen)
    {
        lock (_gate)
        {
            SyncRunPlayers(upstreamPlayers);
            var name = TrimName(requestedName);
            BrowserIdentity? identity = null;
            if (name is not null)
            {
                var upstream = FindByName(upstreamPlayers, name);
                var playerId = upstream?.PlayerId ?? name;
                identity = GetOrCreate(name, playerId, isRunPlayer: false);
                identity.ConnectionCount++;
            }

            var players = MergePlayers(upstreamPlayers, identity);
            return new BrowserAssignmentState(
                ToSession(identity),
                players,
                screen,
                [new BrowserAssignmentNotice(BrowserAssignmentNoticeCodes.HostInLobby, "info", "Host is in lobby.", screen.Type, screen.Title)]);
        }
    }

    public BrowserAssignmentState JoinRun(
        string? requestedName,
        IReadOnlyList<BrowserPlayerOption> upstreamPlayers,
        BrowserScreenDto screen)
    {
        lock (_gate)
        {
            SyncRunPlayers(upstreamPlayers);
            var name = TrimName(requestedName);
            BrowserIdentity? identity = null;
            if (name is not null && FindByName(upstreamPlayers, name) is { } upstream)
            {
                identity = GetOrCreate(upstream.Name, upstream.PlayerId, isRunPlayer: true);
                identity.ConnectionCount++;
            }

            return new BrowserAssignmentState(
                ToSession(identity),
                MergePlayers(upstreamPlayers, identity),
                screen,
                [new BrowserAssignmentNotice(BrowserAssignmentNoticeCodes.HostInRun, "info", "Host is in run.", screen.Type, screen.Title)]);
        }
    }

    public BrowserAssignmentState Unjoined(
        string? requestedName,
        IReadOnlyList<BrowserPlayerOption> upstreamPlayers,
        BrowserScreenDto screen,
        BrowserAssignmentNotice notice)
    {
        lock (_gate)
        {
            SyncRunPlayers(upstreamPlayers);
            var name = TrimName(requestedName);
            return new BrowserAssignmentState(
                new BrowserSessionDto(name, "unassigned", Joined: false, PlayerId: null, ConnectionCount: 0),
                MergePlayers(upstreamPlayers, local: null),
                screen,
                [notice]);
        }
    }

    // `characterId` is the seat's character model id where the state snapshot has one (R19 WP-2 — the picker's
    // per-seat icon). Trailing + defaulted so every existing call site is unaffected; the registry itself never
    // invents one, since it only knows names and connection counts.
    public BrowserPlayerOption ToPlayerOption(
        string playerId,
        string name,
        bool isHost,
        bool isRunPlayer,
        string? characterId = null)
    {
        lock (_gate)
        {
            _identities.TryGetValue(name, out var identity);
            return new BrowserPlayerOption(
                playerId,
                name,
                isHost,
                isRunPlayer,
                identity?.ConnectionCount ?? 0,
                isRunPlayer && (identity is null || identity.ConnectionCount == 0),
                CharacterId: string.IsNullOrWhiteSpace(characterId) ? null : characterId);
        }
    }

    public void Disconnect(string? viewerName)
    {
        var name = TrimName(viewerName);
        if (name is null)
        {
            return;
        }

        lock (_gate)
        {
            DisconnectLocked(name);
        }
    }

    internal BrowserAssignmentState JoinHandle(
        BrowserSessionHandle handle,
        string? requestedName,
        IReadOnlyList<BrowserPlayerOption> upstreamPlayers,
        BrowserScreenDto screen,
        bool hostInRun)
    {
        ArgumentNullException.ThrowIfNull(handle);

        lock (_gate)
        {
            SyncRunPlayers(upstreamPlayers);
            var name = TrimName(requestedName);
            BrowserIdentity? identity = null;
            if (name is not null)
            {
                var upstream = FindByName(upstreamPlayers, name);
                if (!hostInRun || upstream is not null)
                {
                    identity = GetOrCreate(upstream?.Name ?? name, upstream?.PlayerId ?? name, hostInRun);
                    if (!string.Equals(handle.AssignedName, identity.Name, StringComparison.Ordinal))
                    {
                        DisconnectLocked(handle.AssignedName);
                        identity.ConnectionCount++;
                        handle.AssignedName = identity.Name;
                    }
                }
            }

            var local = identity ?? IdentityForHandle(handle);
            return new BrowserAssignmentState(
                ToSession(local),
                MergePlayers(upstreamPlayers, local),
                screen,
                [new BrowserAssignmentNotice(
                    hostInRun ? BrowserAssignmentNoticeCodes.HostInRun : BrowserAssignmentNoticeCodes.HostInLobby,
                    "info",
                    hostInRun ? "Host is in run." : "Host is in lobby.",
                    screen.Type,
                    screen.Title)]);
        }
    }

    internal void Disconnect(BrowserSessionHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        lock (_gate)
        {
            DisconnectLocked(handle.AssignedName);
            handle.AssignedName = null;
        }
    }

    // Disconnect this handle and, if it was the LAST connection for a synthetic lobby-only player
    // (non-run identity, now removed), return that player's id so the caller can remove it from the
    // live game lobby (LeaveLobbyPlayer). Run players are kept (marked disconnected) and return null.
    // Clears the handle so a later Dispose -> Disconnect is a harmless no-op.
    internal string? DisconnectAndCaptureRemoval(BrowserSessionHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        lock (_gate)
        {
            var name = handle.AssignedName;
            handle.AssignedName = null;
            if (name is null || !_identities.TryGetValue(name, out var identity))
            {
                return null;
            }

            identity.ConnectionCount = Math.Max(0, identity.ConnectionCount - 1);
            if (identity.ConnectionCount == 0 && !identity.IsRunPlayer)
            {
                _identities.Remove(name);
                return identity.PlayerId;
            }

            return null;
        }
    }

    internal string? IdentityPlayerId(string? name)
    {
        lock (_gate)
        {
            return name is not null && _identities.TryGetValue(name, out var identity)
                ? identity.PlayerId
                : null;
        }
    }

    private void DisconnectLocked(string? name)
    {
        if (name is null || !_identities.TryGetValue(name, out var identity))
        {
            return;
        }

        identity.ConnectionCount = Math.Max(0, identity.ConnectionCount - 1);
        if (identity.ConnectionCount == 0 && !identity.IsRunPlayer)
        {
            _identities.Remove(name);
        }
    }

    private BrowserIdentity? IdentityForHandle(BrowserSessionHandle handle)
        => handle.AssignedName is not null && _identities.TryGetValue(handle.AssignedName, out var identity)
            ? identity
            : null;

    private void SyncRunPlayers(IReadOnlyList<BrowserPlayerOption> upstreamPlayers)
    {
        foreach (var player in upstreamPlayers.Where(player => player.IsRunPlayer))
        {
            if (_identities.TryGetValue(player.Name, out var identity))
            {
                identity.PlayerId = player.PlayerId;
                identity.IsRunPlayer = true;
            }
        }
    }

    private BrowserIdentity GetOrCreate(string name, string playerId, bool isRunPlayer)
    {
        if (!_identities.TryGetValue(name, out var identity))
        {
            identity = new BrowserIdentity(name, playerId, isRunPlayer);
            _identities[name] = identity;
        }
        else
        {
            identity.PlayerId = playerId;
            identity.IsRunPlayer |= isRunPlayer;
        }

        return identity;
    }

    // `local` is the requesting connection's own identity (from IdentityForHandle for handle paths, or the
    // just-joined identity for JoinLobby/JoinRun); every returned option is stamped IsLocal against its Name so the
    // client roster filter keeps host + this device's players and hides other connections' remote players.
    private IReadOnlyList<BrowserPlayerOption> MergePlayers(IReadOnlyList<BrowserPlayerOption> upstreamPlayers, BrowserIdentity? local)
    {
        var localName = local?.Name;
        var result = upstreamPlayers.ToDictionary(player => player.Name, StringComparer.Ordinal);
        foreach (var identity in _identities.Values)
        {
            if (identity.IsRunPlayer)
            {
                if (result.TryGetValue(identity.Name, out var upstream))
                {
                    result[identity.Name] = upstream with
                    {
                        ConnectionCount = identity.ConnectionCount,
                        Disconnected = identity.ConnectionCount == 0
                    };
                }

                continue;
            }

            if (identity.ConnectionCount > 0 && !result.ContainsKey(identity.Name))
            {
                result[identity.Name] = new BrowserPlayerOption(
                    identity.PlayerId,
                    identity.Name,
                    IsHost: false,
                    IsRunPlayer: false,
                    identity.ConnectionCount,
                    Disconnected: false);
            }
        }

        return result.Values
            .Select(player => player with
            {
                IsLocal = localName is not null && string.Equals(player.Name, localName, StringComparison.Ordinal)
            })
            .OrderBy(player => player.Name, StringComparer.Ordinal)
            .ToArray();
    }

    private static BrowserPlayerOption? FindByName(IReadOnlyList<BrowserPlayerOption> players, string name)
        => players.FirstOrDefault(player => string.Equals(player.Name, name, StringComparison.Ordinal));

    private static BrowserSessionDto ToSession(BrowserIdentity? identity)
        => identity is null
            ? new BrowserSessionDto(null, "unassigned", Joined: false, PlayerId: null, ConnectionCount: 0)
            : new BrowserSessionDto(identity.Name, "joined", Joined: true, identity.PlayerId, identity.ConnectionCount);

    private static string? TrimName(string? name)
        => string.IsNullOrWhiteSpace(name) ? null : name.Trim();

    private sealed class BrowserIdentity(string name, string playerId, bool isRunPlayer)
    {
        public string Name { get; } = name;
        public string PlayerId { get; set; } = playerId;
        public bool IsRunPlayer { get; set; } = isRunPlayer;
        public int ConnectionCount { get; set; }
    }
}

public sealed class BrowserSessionHandle(BrowserSessionRegistry registry) : IDisposable
{
    private BrowserSessionRegistry? _registry = registry;

    // Stable identity used to key per-session state (e.g. headless game instances) across the lifetime
    // of the WebSocket connection.
    public Guid Id { get; } = Guid.NewGuid();

    internal string? AssignedName { get; set; }

    public string? AssignedPlayerId => _registry?.IdentityPlayerId(AssignedName);

    public void Dispose()
    {
        var registry = Interlocked.Exchange(ref _registry, null);
        registry?.Disconnect(this);
    }
}
