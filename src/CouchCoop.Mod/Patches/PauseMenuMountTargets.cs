namespace CouchCoop.Mod.Patches;

/// <summary>
/// The one game-owned screen that provides the declared, parameterless lifecycle seam the pause-menu QR entry
/// mounts on. Kept as data — like <see cref="LobbyScreenMountTargets"/> — so a metadata-only reference lane can
/// verify the contract without loading a game assembly.
/// </summary>
internal static class PauseMenuMountTargets
{
    internal const string ReadyMethodName = LobbyScreenMountTargets.ReadyMethodName;

    internal static IReadOnlyList<GodotNodeMountTarget> Targets { get; } =
    [
        new("MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu.NPauseMenu", ReadyMethodName),
    ];

    internal static IReadOnlyList<string> TypeNames { get; } = Targets.Select(target => target.TypeName).ToArray();
}
