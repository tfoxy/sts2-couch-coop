using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
#if STS2_API_V113
using MegaCrit.Sts2.Core.Nodes.Screens.Blitz;
using MegaCrit.Sts2.Core.Nodes.Screens.Dread;
#endif

internal static class BlitzDreadLobbyTests
{
    internal static void Run()
    {
        var checks = 0;
        void Check(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException($"BlitzDreadLobbyTests: {message}");
            checks++;
        }

        Check(LobbySupportCheckpoints.PatchTargetCount == LobbyScreenMountTargets.Targets.Count,
            "the checkpoint denominator matches the mount table");
#if STS2_API_V113
        Check(LobbyScreenMountTargets.Targets.Count == 6 && LobbyAssignmentTargets.Targets.Count == 18
            && RosterSignalTargets.Targets.Count == 20, "v113 registers all six lobby screens");
        Check(GameSeatPeerCleanup.LobbyContextOf(typeof(NBlitzScreen)) == GameSeatPeerCleanup.Context.NewRunLobby,
            "Blitz seat cleanup uses the new-run lobby service");
        Check(GameSeatPeerCleanup.LobbyContextOf(typeof(NDreadScreen)) == GameSeatPeerCleanup.Context.NewRunLobby,
            "Dread seat cleanup uses the new-run lobby service");
#else
        Check(LobbyScreenMountTargets.Targets.Count == 4 && LobbyAssignmentTargets.Targets.Count == 12
            && RosterSignalTargets.Targets.Count == 14, "older lanes retain their original target counts");
#endif

        foreach (var (typeName, scene, title, kind, token) in new[]
        {
            (LobbyAssignmentTargets.BlitzScreen, RosterRootScenes.BlitzRun, "Blitz", LobbyCheckpointScreenKind.Blitz, "blitz"),
            (LobbyAssignmentTargets.DreadScreen, RosterRootScenes.DreadRun, "Dread", LobbyCheckpointScreenKind.Dread, "dread"),
        })
        {
            var assignment = LobbyAssignmentTargets.Targets.Where(target => target.TypeName == typeName).ToArray();
            var roster = RosterSignalTargets.Targets.Where(target => target.TypeName == typeName).ToArray();
            var mounts = LobbyScreenMountTargets.Targets.Where(target => target.TypeName == typeName).ToArray();
#if STS2_API_V113
            Check(assignment.SequenceEqual(new[]
            {
                new LobbyAssignmentTarget(typeName, "InitializeMultiplayerAsHost", 2, null),
                new LobbyAssignmentTarget(typeName, "InitializeMultiplayerAsClient", 2, null),
                new LobbyAssignmentTarget(typeName, "InitializeSingleplayer", 0, null),
            }), $"{title}: all three initialization routes wake the host panel");
            var bindings = LobbyAssignmentPatch.Bindings.Where(binding => binding.Type.FullName == typeName).ToArray();
            Check(bindings.Select(binding => binding.Key).SequenceEqual(assignment.Select(target => target.Key))
                && bindings.All(binding => !binding.ClearLobbyBefore && binding.Role is null),
                $"{title}: public lobbies need no construction record or clearing hook");
            Check(bindings.Select(binding => binding.Postfix).SequenceEqual(new[]
                { "PostfixNewRunAsHost", "PostfixWake", "PostfixWake" }),
                $"{title}: host initialization retains host-start bookkeeping");
            Check(roster.SequenceEqual(new[]
            {
                new RosterSignalTarget(typeName, "PlayerConnected", 1),
                new RosterSignalTarget(typeName, "PlayerChanged", 1),
                new RosterSignalTarget(typeName, "RemotePlayerDisconnected", 1),
            }), $"{title}: join, change and leave each wake the roster");
            Check(RosterSignalPatch.Bindings.Where(binding => binding.Type.FullName == typeName)
                .Select(binding => binding.Key).SequenceEqual(roster.Select(target => target.Key)),
                $"{title}: typed roster bindings match the metadata targets");
            Check(mounts.SequenceEqual(new[] { new GodotNodeMountTarget(typeName, "_Ready") }),
                $"{title}: the panel mounts when its screen is ready");
#else
            Check(assignment.Length == 0 && roster.Length == 0 && mounts.Length == 0,
                $"{title}: older lanes do not register the new game types");
            Check(!LobbyAssignmentPatch.Bindings.Any(binding => binding.Type.FullName == typeName)
                && !RosterSignalPatch.Bindings.Any(binding => binding.Type.FullName == typeName),
                $"{title}: older lanes do not bind the new game types");
#endif
            Check(scene == $"screens/{token}/{token}_screen", $"{title}: the root scene keeps its wire spelling");
            Check(BrowserAssignmentClassifier.ScreenTitle(scene) == title, $"{title}: the browser names the lobby");
            foreach (var role in new[] { NetTypeNames.Host, NetTypeNames.Client, NetTypeNames.Singleplayer })
            {
                var facts = new RosterFacts(scene, new RosterLobby(role, "p:1", false,
                    [new("p:1", "Host", "IRONCLAD", true)], []), null);
                var state = BrowserAssignmentClassifier.Classify(facts, new BrowserSessionRegistry(), null);
                Check(state.Screen.Kind == "lobby" && state.Screen.Title == title && state.Screen.Type == scene,
                    $"{title}: initialized screens classify as lobbies for {role}");
                Check(CouchCoopLobbyParticipation.DescribeMirrorJoinContext(facts).SpawnAllowed == (role == NetTypeNames.Host),
                    $"{title}: browser seats can join hosted lobbies only");
            }

            Check(!CouchCoopQrHostPanelOptions.UsesCompactLayout(kind), $"{title}: use the standard-run button position");
            Check(!CouchCoopQrHostPanelOptions.UsesCustomHotkey(kind),
                $"{title}: use the standard-run controller hotkey");

            var lines = new List<string>();
            var checkpoints = new LobbySupportCheckpoints(_ => { }, lines.Add, lines.Add);
            checkpoints.LobbyScreenMounted(kind);
            checkpoints.HostLobbyEvaluated(kind, LobbyCheckpointEvaluation.Host);
            checkpoints.QrPanelInstallEnter(kind);
            checkpoints.QrPanelInstallComplete(kind);
            checkpoints.QrPanelInstallFailed(kind, QrPanelInstallFailureCategory.Attach);
            Check(lines.SequenceEqual(new[]
            {
                $"lobby-screen-mounted kind={token}",
                $"host-lobby-evaluated kind={token} result=host",
                $"qr-panel-install-enter kind={token}",
                $"qr-panel-install-complete kind={token}",
                $"qr-panel-install-failed kind={token} category=attach",
            }), $"{title}: every support checkpoint uses its bounded kind token");
        }
        Check(CouchCoopQrHostPanelOptions.UsesCompactLayout(LobbyCheckpointScreenKind.DailyRun)
            && CouchCoopQrHostPanelOptions.UsesCompactLayout(LobbyCheckpointScreenKind.CustomRun),
            "Daily and Custom keep their compact layouts");
        Check(CouchCoopQrHostPanelOptions.UsesCustomHotkey(LobbyCheckpointScreenKind.CustomRun)
            && !CouchCoopQrHostPanelOptions.UsesCustomHotkey(LobbyCheckpointScreenKind.DailyRun),
            "Custom keeps its modifier-safe hotkey and Daily keeps the standard one");
        Check(!CouchCoopQrHostPanelOptions.UsesCompactLayout(null)
            && !CouchCoopQrHostPanelOptions.UsesCustomHotkey(null),
            "the default panel retains standard layout and hotkey");
        Console.WriteLine($"BlitzDreadLobbyTests: {checks} checks passed");
    }
}
