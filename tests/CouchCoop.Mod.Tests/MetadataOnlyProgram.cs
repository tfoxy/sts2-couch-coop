using CouchCoop.Mod.Patches;

if (args is not ["beta-targets", var assemblyPath])
{
    Console.Error.WriteLine(
        "usage: CouchCoop.Mod.Tests beta-targets <staged-sts2.dll> "
        + "(build with -p:CouchCoopBetaTargetsMode=metadata)");
    return 2;
}

MetadataOnlyLobbyScreenMountTests.RunFixtureCases();
MetadataOnlyLobbyScreenMountTests.AssertMetadataOnlyDependencyPolicy();
MetadataOnlyLobbyScreenMountTests.RunProductionTargets(assemblyPath);
Console.WriteLine($"beta-targets metadata: {LobbyScreenMountTargets.Targets.Count} lobby mounts, "
    + $"{LobbyAssignmentTargets.Targets.Count} lobby assignments and {RosterSignalTargets.Targets.Count} roster signals "
    + "resolve; pause-menu, player-cap and host-access targets resolve");
return 0;
