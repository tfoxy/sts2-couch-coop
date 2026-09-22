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
Console.WriteLine("beta-targets metadata: both lobby _Ready declarations resolve, and the pause menu's");
return 0;
