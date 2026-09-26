namespace CouchCoop.Mod.Patches;

/// <summary>
/// One game method the roster observer is told by, as data: which declared method, and how many parameters.
/// <c>.ctor</c> names a constructor.
/// </summary>
internal readonly record struct RosterSignalTarget(string TypeName, string MethodName, int ParameterCount)
{
    internal string Key => $"{TypeName}.{MethodName}/{ParameterCount}";
}

/// <summary>
/// The game methods whose running means the lobby or run roster may have changed. Each one is hooked by
/// <see cref="RosterSignalPatch"/>, whose postfix only RECORDS and WAKES: the roster is read one frame later.
/// </summary>
/// <remarks>
/// <para>
/// What each one means on screen. <c>PlayerConnected</c> and <c>RemotePlayerDisconnected</c> on the two lobby screens:
/// someone joined or left the lobby. The two lobby constructors: the game has just built a lobby (the new-run one, or the
/// saved-run one whose screen exposes nothing), which also names the net service the host's peer connections are
/// reported on. <c>RunManager.CleanUp</c>: the run has ended and the game is on its way to the menu.
/// </para>
/// <para>
/// Not hooked, deliberately: a player changing character or readiness. Nothing acts on either (the join screen's
/// re-send is keyed on who is present and connected, and a read always sees the current character). The screen event,
/// the run-started event, the host's peer events and the display-name change are the other signals; they are events,
/// not patches, and are wired in <see cref="Runtime.GameRosterSignals"/>.
/// </para>
/// <para>
/// Kept as plain data, with no game type, so the metadata-only reference lane can verify that each is still declared
/// with the same parameter count without loading a game assembly. The typed binding (parameter types) is
/// <see cref="RosterSignalPatch.Bindings"/>, and a test holds the two in step.
/// </para>
/// </remarks>
internal static class RosterSignalTargets
{
    internal const string CharacterSelectScreen = "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen";
    internal const string LoadRunScreen = "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NMultiplayerLoadGameScreen";
    internal const string StartRunLobby = "MegaCrit.Sts2.Core.Multiplayer.Game.Lobby.StartRunLobby";
    internal const string LoadRunLobby = "MegaCrit.Sts2.Core.Multiplayer.Game.Lobby.LoadRunLobby";
    internal const string RunManager = "MegaCrit.Sts2.Core.Runs.RunManager";
    internal const string Constructor = ".ctor";

    internal static IReadOnlyList<RosterSignalTarget> Targets { get; } =
    [
        new(CharacterSelectScreen, "PlayerConnected", 1),
        new(CharacterSelectScreen, "RemotePlayerDisconnected", 1),
        new(LoadRunScreen, "PlayerConnected", 1),
        new(LoadRunScreen, "RemotePlayerDisconnected", 1),
        new(StartRunLobby, Constructor, 4),
        new(LoadRunLobby, Constructor, 3),
        new(RunManager, "CleanUp", 1),
    ];
}
