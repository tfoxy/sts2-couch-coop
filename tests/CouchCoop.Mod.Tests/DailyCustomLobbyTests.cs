using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;

internal static class DailyCustomLobbyTests
{
    internal static void Run()
    {
        foreach (var (scene, title) in new[]
        {
            (RosterRootScenes.DailyRun, "Daily Challenge"),
            (RosterRootScenes.CustomRun, "Custom Mode"),
        })
        {
            foreach (var role in new[] { NetTypeNames.Host, NetTypeNames.Client, NetTypeNames.Singleplayer })
            {
                var lobby = new RosterLobby(role, "p:1", false,
                    [new("p:1", "Host", "IRONCLAD", true), new("p:1002", "Guest", "SILENT", true)], []);
                var roster = new RosterFacts(scene, lobby, null);
                var description = CouchCoopLobbyParticipation.DescribeJoin(new JoinRead(roster, 4), false);
                Check(description.Context.SpawnAllowed == (role == NetTypeNames.Host), "only a host can spawn a new seat");
                Check(description.Seats.MaxCouchSeats == 3, "capacity comes from the current lobby");
                Check(description.Context.MayRejoinNetId(1002), "the admitted seat retains its identity");
                var state = BrowserAssignmentClassifier.Classify(roster, new BrowserSessionRegistry(), null);
                Check(state.Screen.Kind == "lobby" && state.Screen.Title == title && state.Screen.Type == scene,
                    "the browser sees the actual setup screen");
                Check(state.Screen.MirrorMode == (role == NetTypeNames.Singleplayer ? "sp-character-select" : "mp-character-select"),
                    "existing mirror modes preserve join UI compatibility");
                Check(CouchCoopLobbyHostGate.IsHostLobby(new GateFacts(false, role, null)) == (role == NetTypeNames.Host),
                    "QR eligibility agrees with joining");

                var running = roster with { Run = new RosterRun(NetTypeNames.Host, "p:1",
                    [new("p:1", "Host", "IRONCLAD", true, true), new("p:1002", "Guest", "SILENT", false, true)]) };
                var runJoin = CouchCoopLobbyParticipation.DescribeMirrorJoinContext(running);
                Check(!runJoin.SpawnAllowed && runJoin.MayRejoinNetId(1002), "starting closes new seats and preserves reconnect identity");
            }
            var pending = new RosterFacts(scene, null, null);
            Check(!CouchCoopLobbyParticipation.DescribeMirrorJoinContext(pending).SpawnAllowed,
                "uninitialized or closed lobbies cannot launch seats");
        }

        var screen = new object();
        var otherScreen = new object();
        var oldLobby = new object();
        var nextLobby = new object();
        LobbyAssignmentRecord.RecordLobby(screen, oldLobby);
        LobbyAssignmentRecord.RecordLobby(otherScreen, oldLobby);
        var prefix = typeof(LobbyAssignmentPatch).GetMethod("PrefixClearDailyLobby",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        prefix.Invoke(null, [screen]);
        Check(!LobbyAssignmentRecord.TryGetLobby(screen, out _), "reinitialization clears the previous daily lobby before async setup");
        Check(LobbyAssignmentRecord.TryGetLobby(otherScreen, out _), "clearing one screen preserves another");
        LobbyAssignmentRecord.RecordLobby(screen, nextLobby);
        Check(LobbyAssignmentRecord.TryGetLobby(screen, out var current) && ReferenceEquals(current, nextLobby),
            "delayed construction supplies the new lobby");
        LobbyAssignmentRecord.ClearLobby(screen);
        Check(!LobbyAssignmentRecord.TryGetLobby(screen, out _), "closure removes recorded membership");
        Check(LobbyAssignmentPatch.Bindings.Count(binding => binding.ClearLobbyBefore) == 3,
            "all daily initialization routes clear old state");

        foreach (var type in new[] { LobbyAssignmentTargets.DailyRunScreen, LobbyAssignmentTargets.CustomRunScreen })
            Check(RosterSignalTargets.Targets.Count(target => target.TypeName == type) == 3,
                "join, leave and player changes wake the roster for each new screen");

        var lines = new List<string>();
        var checkpoints = new LobbySupportCheckpoints(_ => { }, lines.Add, _ => { });
        checkpoints.LobbyScreenMounted(LobbyCheckpointScreenKind.DailyRun);
        checkpoints.LobbyScreenMounted(LobbyCheckpointScreenKind.CustomRun);
        Check(lines.SequenceEqual(new[] { "lobby-screen-mounted kind=daily-run", "lobby-screen-mounted kind=custom-run" }),
            "support logs distinguish the two new screens");
        var layout = HostLobbyQrOverlayLayout.Default.ForCompactLobby();
        Check(layout.Left == 220 && layout.Top == 920 && layout.ButtonWidth == 520 && layout.ButtonHeight == 64
            && layout.ButtonFontSize == 28, "compact geometry reserves space above the disclaimer");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"DailyCustomLobbyTests: {message}");
    }
}
