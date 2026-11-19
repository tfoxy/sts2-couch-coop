// Custom executable runner: source-links shipping host waits, filesystem and loader code, so macOS CI
// tests precisely the code a shipped seat uses without needing game assemblies or an STS2 install.
var completed = true;
HostExitWaitTests.Run();
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
else if (args.Length >= 3 && args[0] == "--godot-harmony-fixture"
    && GodotHarmonyFixtureSupervisor.TryParseOptions(args[3..], out var options))
{
    var result = await GodotHarmonyFixtureSupervisor.RunAsync(args[1], args[2], options.DotnetRoot, options.ExpectedFramework);
    // Do not echo redirected Godot output: it can contain native diagnostics. Only parsed fixture marker fields
    // are printed for refusal diagnosis; the capped raw output is saved to the optional artifact directory.
    Console.Write(GodotHarmonyFixtureSupervisor.Describe(result));
    if (options.OutputDirectory is { } outputDirectory) GodotHarmonyFixtureSupervisor.WriteArtifacts(outputDirectory, result);
    completed = result.Outcome == GodotHarmonyFixtureSupervisor.Outcome.Success;
    if (!completed) Environment.ExitCode = 1;
}
else if (args.Length != 0)
{
    Console.Error.WriteLine(
        "usage: CouchCoop.MacOs.Tests [--verify-archive <release.zip>] [--harmony-smoke <smoke-executable>...] "
        + "[--godot-harmony-fixture <godot-executable> <fixture-project-path> [--out <dir>] [--dotnet-root <dir>] [--expect-framework <text>]]");
    Environment.ExitCode = 2;
    completed = false;
}

if (completed) Console.WriteLine("macOS game-free checks: ok");
