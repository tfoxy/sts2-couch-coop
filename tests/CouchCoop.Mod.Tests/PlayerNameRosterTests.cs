using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.State;

// The netId→name pipeline that stops a couch seat rendering other players as raw netIds.
//
// A seat resolves every label through NullPlatformUtilStrategy, which reads mp_names.json ONCE at startup and
// otherwise prints the netId — so it can only name players the HOST wrote into that file, and only ones written
// before it booted. Three pieces close that:
//   * CouchCoopLobbyParticipation.RosterNames — what the host can name (itself, remote Steam friends, seats);
//   * HeadlessClientManager.BuildMultiplayerNameEntries — how that merges into the durable roster file;
//   * HeadlessClientNameSync — how an ALREADY-RUNNING seat picks up later changes to it.
internal static class PlayerNameRosterTests
{
    public static void Run()
    {
        RosterNamesCarriesTheHostAndRemotePlayers();
        RosterNamesSkipsPlaceholderAndUnnamedPlayers();

        JoiningSeatAndClaimsOutrankThePublishedRoster();
        PublishedRosterNamesNonSeatNetIds();
        ExistingFileEntriesSurviveARewrite();

        SyncAppliesEveryEntryOnTheFirstTick();
        SyncIsQuietUntilTheRosterFileChanges();
        SyncAppliesOnlyTheDeltaOnAChange();
        SyncRetriesEntriesThatDidNotLand();
        SyncRetriesATornRead();
    }

    // ---- CouchCoopLobbyParticipation.RosterNames -------------------------------------------------------------

    // The whole point of publishing: a seat cannot resolve the HOST (whose netId is its SteamID64 on a Steam-
    // hosted session) or a genuine remote Steam friend on its own. Both must travel in the roster.
    private static void RosterNamesCarriesTheHostAndRemotePlayers()
    {
        const ulong steamHost = 76561198000000123UL;
        const ulong steamFriend = 76561198000000999UL;
        var names = CouchCoopLobbyParticipation.RosterNames(Lobby(
            LobbyPlayer($"p:{steamHost}", "Plapla"),
            LobbyPlayer($"p:{steamFriend}", "Remote Friend"),
            LobbyPlayer("p:1002", "pla1")));

        Assert(names.Count == 3, "every named lobby player is published");
        Assert(names.Any(entry => entry.NetId == steamHost && entry.Name == "Plapla"),
            "the Steam-hosted host's own SteamID64 → persona name is published (the seats cannot resolve it)");
        Assert(names.Any(entry => entry.NetId == steamFriend && entry.Name == "Remote Friend"),
            "a genuine remote Steam player is published too");
        Assert(names.Any(entry => entry.NetId == 1002UL && entry.Name == "pla1"), "couch seats are published");

        var runNames = CouchCoopLobbyParticipation.RosterNames(Run(
            RunPlayer($"p:{steamHost}", "Plapla", isHost: true),
            RunPlayer("p:1002", "pla1", isHost: false)));
        Assert(runNames.Count == 2 && runNames.Any(entry => entry.NetId == steamHost),
            "a live run publishes its players the same way (the lobby is gone by then)");
    }

    private static void RosterNamesSkipsPlaceholderAndUnnamedPlayers()
    {
        var names = CouchCoopLobbyParticipation.RosterNames(Lobby(
            LobbyPlayer("p:1002", null),
            LobbyPlayer("p:1003", "   "),
            // Both platform strategies fall back to playerId.ToString() when they cannot name someone, so a
            // "name" that IS the netId means UNKNOWN — publishing it would bake the placeholder into the durable
            // roster and then beat the real name once it resolved.
            LobbyPlayer("p:1004", "1004"),
            LobbyPlayer("not-a-player-id", "Nope"),
            LobbyPlayer("p:1005", "pla3")));

        Assert(names.Count == 1 && names[0].NetId == 1005UL && names[0].Name == "pla3",
            "unnamed, blank, netId-placeholder and unparseable players are all skipped");
    }

    // ---- HeadlessClientManager.BuildMultiplayerNameEntries ---------------------------------------------------

    // Authority order: the seat being bound right now, then live name claims, then the host's published roster.
    // A claim is the name that player typed for this seat; the published roster is the host's resolution of the
    // same seat and may lag it by a state tick, so it must never overwrite one.
    private static void JoiningSeatAndClaimsOutrankThePublishedRoster()
    {
        var entries = HeadlessClientManager.BuildMultiplayerNameEntries(
            joiningNetId: 1003UL,
            joiningName: "pla2",
            claimedSlotNames: [(1002UL, "pla1")],
            publishedNames: new Dictionary<ulong, string> { [1002] = "stale-pla1", [1003] = "stale-pla2" },
            existingEntries: new Dictionary<ulong, string>());

        Assert(NameFor(entries, 1003) == "pla2", "the joining seat's name wins over a lagging published entry");
        Assert(NameFor(entries, 1002) == "pla1", "a live name claim wins over a lagging published entry");
        Assert(entries.Count == 2, "…and neither is duplicated");
    }

    private static void PublishedRosterNamesNonSeatNetIds()
    {
        const ulong steamHost = 76561198000000123UL;
        var entries = HeadlessClientManager.BuildMultiplayerNameEntries(
            joiningNetId: 1002UL,
            joiningName: "pla1",
            claimedSlotNames: [],
            publishedNames: new Dictionary<ulong, string> { [steamHost] = "Plapla" },
            existingEntries: new Dictionary<ulong, string>());

        Assert(NameFor(entries, steamHost) == "Plapla",
            "the host's SteamID64 is written into the roster the seat reads at construction — without it the "
            + "seat prints 17 digits where the host's name belongs");
        Assert(NameFor(entries, 1002) == "pla1", "…alongside the joining seat");
    }

    private static void ExistingFileEntriesSurviveARewrite()
    {
        var entries = HeadlessClientManager.BuildMultiplayerNameEntries(
            joiningNetId: 1002UL,
            joiningName: "pla1",
            claimedSlotNames: [],
            publishedNames: new Dictionary<ulong, string>(),
            existingEntries: new Dictionary<ulong, string> { [1002] = "someone-else", [1004] = "Bob" });

        Assert(NameFor(entries, 1004) == "Bob",
            "a netId this session knows nothing about keeps its remembered name: the file is the ONLY persistent "
            + "netId→name map, and it is what relabels the seats of a reloaded saved run");
        Assert(NameFor(entries, 1002) == "pla1", "…but the live joiner overrides the remembered name for its seat");
    }

    // ---- HeadlessClientNameSync ------------------------------------------------------------------------------

    private static void SyncAppliesEveryEntryOnTheFirstTick()
    {
        var harness = new SyncHarness();
        harness.Publish(new Dictionary<ulong, string> { [1002] = "pla1", [76561198000000123] = "Plapla" });

        harness.Sync.SyncOnce();

        Assert(harness.Applied.Count == 2, "a seat applies the whole roster it finds on its first tick");
        Assert(harness.Applied.Contains((76561198000000123UL, "Plapla")), "…including the host it cannot resolve itself");
    }

    private static void SyncIsQuietUntilTheRosterFileChanges()
    {
        var harness = new SyncHarness();
        harness.Publish(new Dictionary<ulong, string> { [1002] = "pla1" });
        harness.Sync.SyncOnce();
        harness.Applied.Clear();

        harness.Sync.SyncOnce();
        harness.Sync.SyncOnce();

        Assert(harness.Applied.Count == 0 && harness.Reads == 1,
            "an unchanged file costs a stat and nothing else — no re-read, no semantic action");
    }

    // The reported bug: pla1 was already playing when pla2 joined, so pla1's process never learned pla2's name.
    private static void SyncAppliesOnlyTheDeltaOnAChange()
    {
        var harness = new SyncHarness();
        harness.Publish(new Dictionary<ulong, string> { [1002] = "pla1" });
        harness.Sync.SyncOnce();
        harness.Applied.Clear();

        harness.Publish(new Dictionary<ulong, string> { [1002] = "pla1", [1003] = "pla2" });
        harness.Sync.SyncOnce();

        Assert(harness.Applied.Count == 1 && harness.Applied[0] == (1003UL, "pla2"),
            "a later joiner is picked up by an already-running seat, and only the new entry costs an action");
    }

    private static void SyncRetriesEntriesThatDidNotLand()
    {
        var harness = new SyncHarness { ApplySucceeds = false };
        harness.Publish(new Dictionary<ulong, string> { [1002] = "pla1" });

        harness.Sync.SyncOnce();
        Assert(harness.Applied.Count == 1, "the first tick tries");

        // Ticks during early boot fail because the runtime host isn't up yet. If the sync treated the file as
        // seen, or cached the name as applied, that seat would show a raw netId for the rest of its life.
        harness.ApplySucceeds = true;
        harness.Sync.SyncOnce();
        Assert(harness.Applied.Count == 2 && harness.Applied[1] == (1002UL, "pla1"),
            "a failed apply is retried on the next tick rather than latching as done");

        harness.Applied.Clear();
        harness.Sync.SyncOnce();
        Assert(harness.Applied.Count == 0, "…and stops once it has landed");
    }

    private static void SyncRetriesATornRead()
    {
        var harness = new SyncHarness();
        // A file that reports content but parses to nothing: the host truncating + rewriting it underneath us.
        harness.PublishRaw(new Dictionary<ulong, string>(), fileLength: 64);

        harness.Sync.SyncOnce();
        Assert(harness.Applied.Count == 0, "nothing to apply from a torn read");

        // The rewrite lands: same file stat as the torn read saw, real content now. A sync that had accepted the
        // torn read would skip this file forever and the seat would show raw netIds for the rest of its life.
        harness.SetRosterLeavingTheStatAlone(new Dictionary<ulong, string> { [1002] = "pla1" });
        harness.Sync.SyncOnce();
        Assert(harness.Applied.Count == 1 && harness.Applied[0] == (1002UL, "pla1"),
            "a torn read is not accepted as 'no names' — that stat is read again on the next tick");
    }

    // Drives HeadlessClientNameSync with an in-memory roster + apply, so the tests touch no filesystem and no game.
    private sealed class SyncHarness
    {
        private IReadOnlyDictionary<ulong, string> _roster = new Dictionary<ulong, string>();
        private (DateTime WriteTimeUtc, long Length)? _stat;

        public SyncHarness()
        {
            Sync = new HeadlessClientNameSync(
                () => _stat,
                () =>
                {
                    Reads++;
                    return _roster;
                },
                (netId, name) =>
                {
                    Applied.Add((netId, name));
                    return ApplySucceeds;
                });
        }

        public HeadlessClientNameSync Sync { get; }
        public List<(ulong NetId, string Name)> Applied { get; } = [];
        public int Reads { get; private set; }
        public bool ApplySucceeds { get; set; } = true;

        // Stand-in for the host rewriting mp_names.json: new content, new stat.
        public void Publish(IReadOnlyDictionary<ulong, string> roster)
            => PublishRaw(roster, fileLength: Math.Max(2, roster.Count * 30));

        // …and the same with the stat's LENGTH pinned, so a "the file has bytes but parsed to nothing" read (a
        // torn read of a file being rewritten) can be staged without the length itself giving the game away.
        public void PublishRaw(IReadOnlyDictionary<ulong, string> roster, long fileLength)
        {
            _roster = roster;
            _stat = (new DateTime(2026, 8, 15, 0, 0, ++_writes, DateTimeKind.Utc), fileLength);
        }

        // Content changes, stat does not — how a re-read of the SAME file version looks after a torn read.
        public void SetRosterLeavingTheStatAlone(IReadOnlyDictionary<ulong, string> roster) => _roster = roster;

        private int _writes;
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    private static string? NameFor(IEnumerable<HeadlessClientManager.MultiplayerNameEntry> entries, ulong netId)
        => entries.FirstOrDefault(entry => entry.net_id == netId)?.name;

    private static StateCharacterSelectPlayerSnapshot LobbyPlayer(string id, string? name)
        => new(id, 0, "ironclad", IsReady: false, MaxMultiplayerAscensionUnlocked: 20, DisplayName: name);

    private static StateSnapshot Lobby(params StateCharacterSelectPlayerSnapshot[] players)
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
                    Players: players),
                CharacterButtons: [],
                View: null),
            Run: null);

    private static StateRunPlayerSnapshot RunPlayer(string id, string name, bool isHost)
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
            Notices: []);

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
            throw new InvalidOperationException("PlayerNameRosterTests: " + message);
        }
    }
}
