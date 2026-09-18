// Custom executable runner: this intentionally source-links shipping filesystem and loader code, so macOS CI
// tests precisely the code a shipped seat uses without needing game assemblies or an STS2 install.
var completed = true;
HeadlessUserDirSeederTests.Run();
MacOsLoaderSelectionTests.Run();
MacOsReleaseArchiveTests.RunGraphTests();
HarmonySmokeSupervisor.RunClassificationTests();
CouchCoop.Mod.Tests.LobbySupportCheckpointsTests.Run();
GodotHarmonyFixtureSupervisor.RunClassificationTests();

if (args.Length == 2 && args[0] == "--verify-archive")
{
    MacOsReleaseArchiveTests.VerifyArchive(args[1]);
}
else if (args.Length >= 2 && args[0] == "--harmony-smoke")
{
    foreach (var smoke in args.Skip(1))
    {
        var outcome = await HarmonySmokeSupervisor.RunAsync(new System.Diagnostics.ProcessStartInfo
        {
            FileName = smoke,
            WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(smoke))!,
            UseShellExecute = false,
        });
        if (outcome != HarmonySmokeSupervisor.Outcome.Success)
            throw new InvalidOperationException($"Harmony smoke '{smoke}' ended as {outcome}.");
    }
}
else if (args is ["--godot-harmony-fixture", var godotExecutable, var fixtureProjectPath])
{
    var result = await GodotHarmonyFixtureSupervisor.RunAsync(godotExecutable, fixtureProjectPath);
    // Do not echo redirected Godot output: it can contain native diagnostics. The supervisor already bounds it
    // for marker parsing; workflow logs get the compact classification only.
    Console.WriteLine($"godot harmony fixture: {result.Outcome}");
    completed = result.Outcome == GodotHarmonyFixtureSupervisor.Outcome.Success;
    if (!completed) Environment.ExitCode = 1;
}
else if (args.Length != 0)
{
    Console.Error.WriteLine(
        "usage: CouchCoop.MacOs.Tests [--verify-archive <release.zip>] [--harmony-smoke <smoke-executable>...] "
        + "[--godot-harmony-fixture <godot-executable> <fixture-project-path>]");
    Environment.ExitCode = 2;
    completed = false;
}

if (completed) Console.WriteLine("macOS game-free checks: ok");
