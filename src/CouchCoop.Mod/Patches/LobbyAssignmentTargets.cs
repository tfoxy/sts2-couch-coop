namespace CouchCoop.Mod.Patches;

/// <summary>
/// One method that assigns a lobby to a lobby screen, as data: which declared method, how many parameters, and the
/// role the assignment implies (null when the hook only needs to wake the evaluation).
/// </summary>
internal readonly record struct LobbyAssignmentTarget(string TypeName, string MethodName, int ParameterCount, string? Role)
{
    internal string Key => $"{TypeName}.{MethodName}/{ParameterCount}";
}

/// <summary>
/// The game methods that assign a lobby to one of the two lobby screens. The QR panel hooks each one: the saved-run
/// screen's two methods also RECORD which role the lobby got, because that screen exposes no lobby to read, and
/// every method WAKES the evaluation, because an assignment on a screen that is already current is a change the
/// screen event alone would not announce.
/// </summary>
/// <remarks>
/// Kept as plain data, with no game type, so the metadata-only reference lane can verify that each is still declared
/// with the same parameter count without loading a game assembly. The typed binding (parameter types, the
/// <c>nameof</c> members) is <see cref="LobbyAssignmentPatch.Bindings"/>, and a test holds the two in step. The role
/// strings equal <c>CouchCoop.Mod.Contracts.NetTypeNames.Host</c> and <c>.Client</c>; that contracts assembly is not
/// referenced here for the same reason, and a test holds those in step too.
/// </remarks>
internal static class LobbyAssignmentTargets
{
    internal const string CharacterSelectScreen = "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen";
    internal const string LoadRunScreen = "MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NMultiplayerLoadGameScreen";

    internal static IReadOnlyList<LobbyAssignmentTarget> Targets { get; } =
    [
        new(CharacterSelectScreen, "InitializeMultiplayerAsHost", 2, Role: null),
        new(CharacterSelectScreen, "InitializeMultiplayerAsClient", 2, Role: null),
        new(CharacterSelectScreen, "InitializeSingleplayer", 0, Role: null),
        new(LoadRunScreen, "InitializeAsHost", 2, Role: "host"),
        new(LoadRunScreen, "InitializeAsClient", 2, Role: "client"),
    ];
}
