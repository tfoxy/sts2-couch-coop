// Custom executable runner: this intentionally source-links shipping filesystem and loader code, so macOS CI
// tests precisely the code a shipped seat uses without needing game assemblies or an STS2 install.
HeadlessUserDirSeederTests.Run();
MacOsLoaderSelectionTests.Run();
MacOsReleaseArchiveTests.RunGraphTests();
HarmonySmokeSupervisor.RunClassificationTests();

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
else if (args.Length != 0)
{
    Console.Error.WriteLine("usage: CouchCoop.MacOs.Tests [--verify-archive <release.zip>] [--harmony-smoke <smoke-executable>...]");
    Environment.ExitCode = 2;
}

Console.WriteLine("macOS game-free checks: ok");
