namespace CouchCoop.Mod.Patches;

/// <summary>A game-agnostic description of one declared, parameterless Godot lifecycle method.</summary>
internal readonly record struct GodotNodeMountTarget(string TypeName, string MethodName)
{
    internal string Key => $"{TypeName}.{MethodName}";
}

/// <summary>
/// The two game-owned lobby controls that provide the narrow, declared lifecycle seam used by the host panel.
/// Kept as data so a metadata-only reference lane can verify the contract without loading a game assembly.
/// </summary>
internal static class LobbyScreenMountTargets
{
    internal const string ReadyMethodName = "_Ready";

    internal static IReadOnlyList<GodotNodeMountTarget> Targets { get; } =
    [
        new("MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NCharacterSelectScreen", ReadyMethodName),
        new("MegaCrit.Sts2.Core.Nodes.Screens.CharacterSelect.NMultiplayerLoadGameScreen", ReadyMethodName),
    ];

    internal static IReadOnlyList<string> TypeNames { get; } = Targets.Select(target => target.TypeName).ToArray();
}
