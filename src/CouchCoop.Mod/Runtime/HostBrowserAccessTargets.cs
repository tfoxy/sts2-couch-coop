namespace CouchCoop.Mod.Runtime;

/// <summary>Metadata-only compatibility coverage of the public host-authorization lifecycle hooks.</summary>
internal static class HostBrowserAccessTargets
{
    internal readonly record struct Target(string TypeName, string MethodName, int ParameterCount);
    internal static IReadOnlyList<Target> Targets { get; } =
    [
        new("MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NSubmenuStack", "Push", 1),
        new("MegaCrit.Sts2.Core.Nodes.Screens.MainMenu.NSubmenuStack", "Pop", 0),
        new("MegaCrit.Sts2.Core.Nodes.Screens.NCapstoneSubmenuStack", "ShowScreen", 1),
        new("MegaCrit.Sts2.Core.Nodes.Screens.NCapstoneSubmenuStack", "AfterCapstoneClosed", 0),
        new("MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu.NPauseMenu", "OnSubmenuOpened", 0),
        new("MegaCrit.Sts2.Core.Nodes.Screens.PauseMenu.NPauseMenu", "OnSubmenuClosed", 0),
        new("MegaCrit.Sts2.Core.Nodes.Screens.Settings.NSettingsScreen", "OnSubmenuOpened", 0),
        new("MegaCrit.Sts2.Core.Nodes.Screens.Settings.NSettingsScreen", "OnSubmenuClosed", 0),
        new("MegaCrit.Sts2.Core.Nodes.NTransition", "FadeIn", 3),
        new("MegaCrit.Sts2.Core.Nodes.NTransition", "FadeOut", 3),
        new("MegaCrit.Sts2.Core.Nodes.NTransition", "RoomFadeIn", 1),
        new("MegaCrit.Sts2.Core.Nodes.NTransition", "RoomFadeOut", 0),
        new("MegaCrit.Sts2.Core.Nodes.NSceneContainer", "SetCurrentScene", 1),
        new("MegaCrit.Sts2.Core.Runs.RunManager", "CleanUp", 1),
    ];
}
