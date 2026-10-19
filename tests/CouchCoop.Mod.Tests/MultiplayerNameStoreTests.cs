using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using CouchCoop.Mod.Session;

internal static class MultiplayerNameStoreTests
{
    internal const string ReadChildVerb = "player-names-read-child";

    public static void Run()
    {
        NamesSurviveAReadOnlyWorkingDirectoryAndProcessRestart();
        LegacyNamesMigrateOnlyWhileTheCanonicalFileIsAbsent();
        EmptyCanonicalRosterOutranksLegacyNames();
        CorruptCanonicalRosterDoesNotResurrectLegacyNames();
        MalformedLegacyRosterIsNotMigrated();
        RelativeEnvironmentPathIsRejected();
        RootDirectoryOverrideStillReadsLegacySafely();
        IsolatedSeatsReadTheHostsSharedRoster();
        WrapperWorkingDirectoryIsPreserved();
    }

    public static void RunReadChild()
    {
        var names = HeadlessClientManager.ReadMultiplayerNames();
        Assert(names.GetValueOrDefault(1002UL) == "Dad", "the fresh process reads Dad's persisted seat");
        Assert(names.GetValueOrDefault(1003UL) == "Mamsha", "the fresh process reads Mamsha's persisted seat");
        Console.WriteLine("multiplayer name store read: ok");
    }

    private static void NamesSurviveAReadOnlyWorkingDirectoryAndProcessRestart()
    {
        using var fixture = new Fixture();
        fixture.MakeWorkingDirectoryReadOnly();
        Assert(MultiplayerNameStore.ResolveWritePath() == fixture.CanonicalPath,
            "the canonical file is independent of the process working directory");

        MultiplayerNameStore.Write(fixture.CanonicalPath, FamilyNames());

        Assert(File.Exists(fixture.CanonicalPath), "names were persisted beneath the configured user directory");
        Assert(!File.Exists(fixture.LegacyPath), "writing names never creates a legacy file in the working directory");
        Assert(MultiplayerNameStore.ResolveReadPath() == fixture.CanonicalPath,
            "the reader and change detector resolve the persisted file");
        Assert(!Directory.EnumerateFiles(Path.GetDirectoryName(fixture.CanonicalPath)!, "*.tmp").Any(),
            "a successful atomic write leaves no temporary roster behind");

        // This is a new process, not a second read against potentially cached process state.
        RunFreshReader(NewReadProcess(fixture.WorkingDirectory));
    }

    private static void LegacyNamesMigrateOnlyWhileTheCanonicalFileIsAbsent()
    {
        using var fixture = new Fixture();
        File.WriteAllText(fixture.LegacyPath, JsonSerializer.Serialize(FamilyNames()));
        Assert(MultiplayerNameStore.ResolveReadPath() == fixture.LegacyPath,
            "an existing legacy roster is readable before the canonical file exists");

        var migrated = MultiplayerNameStore.Read();

        Assert(migrated.GetValueOrDefault(1002UL) == "Dad", "the old installation's names remain available");
        Assert(File.Exists(fixture.CanonicalPath), "reading a valid legacy roster migrates it into user data");
        Assert(MultiplayerNameStore.ResolveReadPath() == fixture.CanonicalPath,
            "subsequent reads and stats select the migrated file");
        File.WriteAllText(fixture.LegacyPath, "[{\"net_id\":1002,\"name\":\"Stale name\"}]");

        RunFreshReader(NewReadProcess(fixture.WorkingDirectory));
        Assert(File.ReadAllText(fixture.LegacyPath).Contains("Stale name", StringComparison.Ordinal),
            "migration does not overwrite or delete the old file");
    }

    private static void EmptyCanonicalRosterOutranksLegacyNames()
    {
        using var fixture = new Fixture();
        File.WriteAllText(fixture.LegacyPath, JsonSerializer.Serialize(FamilyNames()));
        MultiplayerNameStore.Write(fixture.CanonicalPath, []);

        Assert(MultiplayerNameStore.Read().Count == 0, "an intentional empty canonical roster does not restore old names");
        Assert(MultiplayerNameStore.ResolveReadPath() == fixture.CanonicalPath,
            "an empty canonical roster still owns the read path");
        Assert(File.ReadAllText(fixture.CanonicalPath).Trim() == "[]", "legacy fallback leaves the empty roster intact");
    }

    private static void CorruptCanonicalRosterDoesNotResurrectLegacyNames()
    {
        using var fixture = new Fixture();
        File.WriteAllText(fixture.LegacyPath, JsonSerializer.Serialize(FamilyNames()));
        Directory.CreateDirectory(Path.GetDirectoryName(fixture.CanonicalPath)!);
        File.WriteAllText(fixture.CanonicalPath, "{");

        Assert(MultiplayerNameStore.Read().Count == 0, "a bad canonical read does not select stale legacy identities");
        Assert(File.ReadAllText(fixture.CanonicalPath) == "{", "a read does not replace a corrupt canonical file");
    }

    private static void MalformedLegacyRosterIsNotMigrated()
    {
        using var fixture = new Fixture();
        File.WriteAllText(fixture.LegacyPath, "{");

        Assert(MultiplayerNameStore.Read().Count == 0, "malformed legacy input is an empty read");
        Assert(!File.Exists(fixture.CanonicalPath), "a failed legacy read is not persisted as an empty canonical roster");
    }

    private static void RelativeEnvironmentPathIsRejected()
    {
        using var fixture = new Fixture();
        Environment.SetEnvironmentVariable(MultiplayerNameStore.PathEnvironmentVariable,
            Path.Combine("relative-user-data", MultiplayerNameStore.FileName));

        // These tests have no Godot engine. Rejecting this override must not call native Godot interop or turn
        // the working directory into a writable data directory by resolving the relative value against it.
        Assert(MultiplayerNameStore.ResolveWritePath() is null, "a relative override is not a canonical write target");
        Assert(MultiplayerNameStore.ResolveReadPath() is null, "a missing legacy roster supplies no alternate read path");
        Assert(MultiplayerNameStore.Read().Count == 0, "the engine-free fallback stays safe and empty");
        Assert(!Directory.Exists(Path.Combine(fixture.WorkingDirectory, "relative-user-data")),
            "rejecting the override creates nothing relative to the working directory");
    }

    private static void RootDirectoryOverrideStillReadsLegacySafely()
    {
        using var fixture = new Fixture();
        File.WriteAllText(fixture.LegacyPath, JsonSerializer.Serialize(FamilyNames()));
        Environment.SetEnvironmentVariable(MultiplayerNameStore.PathEnvironmentVariable, Path.GetPathRoot(fixture.Root));

        Assert(MultiplayerNameStore.ResolveWritePath() is null, "a filesystem root is not a names-file path");
        Assert(MultiplayerNameStore.ResolveReadPath() == fixture.LegacyPath,
            "rejecting an invalid override still permits an existing legacy roster");
        Assert(MultiplayerNameStore.Read().GetValueOrDefault(1002UL) == "Dad",
            "legacy reads stay available without attempting migration into a filesystem root");
        Assert(!File.Exists(fixture.CanonicalPath), "an invalid target creates no canonical file");
    }

    private static void IsolatedSeatsReadTheHostsSharedRoster()
    {
        using var fixture = new Fixture();
        MultiplayerNameStore.Write(fixture.CanonicalPath, FamilyNames());
        var child = NewReadProcess(fixture.WorkingDirectory);
        var isolatedHome = Path.Combine(fixture.Root, "seat-home");
        var isolatedData = Path.Combine(fixture.Root, "seat-data");
        child.Environment["HOME"] = isolatedHome;
        child.Environment["XDG_DATA_HOME"] = isolatedData;
        child.Environment["APPDATA"] = isolatedData;
        // A previous seat-specific value must not displace the host's canonical path.
        child.Environment[MultiplayerNameStore.PathEnvironmentVariable] = Path.Combine(isolatedData, "wrong.json");

        MultiplayerNameStore.ConfigureSeatLaunch(child, hasWrapper: false);

        Assert(child.Environment[MultiplayerNameStore.PathEnvironmentVariable] == fixture.CanonicalPath,
            "the child receives the host's absolute path despite profile isolation");
        Assert(child.Environment["HOME"] == isolatedHome && child.Environment["XDG_DATA_HOME"] == isolatedData
            && child.Environment["APPDATA"] == isolatedData, "sharing names preserves the isolated child profile");
        Assert(child.WorkingDirectory == Path.GetDirectoryName(fixture.CanonicalPath),
            "the native startup reader also finds the host's roster");
        Assert(Path.Combine(child.WorkingDirectory, MultiplayerNameStore.FileName) == fixture.CanonicalPath,
            "native and mod startup reads address the same file");
        RunFreshReader(child);
        Assert(!File.Exists(Path.Combine(isolatedData, "wrong.json")), "the child creates no private names roster");
    }

    private static void WrapperWorkingDirectoryIsPreserved()
    {
        using var fixture = new Fixture();
        MultiplayerNameStore.Write(fixture.CanonicalPath, FamilyNames());
        var child = NewReadProcess(fixture.WorkingDirectory);

        MultiplayerNameStore.ConfigureSeatLaunch(child, hasWrapper: true);

        Assert(child.WorkingDirectory == fixture.WorkingDirectory,
            "a custom wrapper retains the working directory its relative arguments may depend on");
        Assert(child.Environment[MultiplayerNameStore.PathEnvironmentVariable] == fixture.CanonicalPath,
            "a wrapper still passes the shared absolute roster path to its seat");
        RunFreshReader(child);
    }

    private static HeadlessClientManager.MultiplayerNameEntry[] FamilyNames()
        => [new() { net_id = 1002, name = "Dad" }, new() { net_id = 1003, name = "Mamsha" }];

    private static ProcessStartInfo NewReadProcess(string workingDirectory)
    {
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("No test process executable.");
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workingDirectory,
        };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            start.ArgumentList.Add(Assembly.GetEntryAssembly()!.Location);
        }
        start.ArgumentList.Add(ReadChildVerb);
        return start;
    }

    private static void RunFreshReader(ProcessStartInfo start)
    {
        using var child = Process.Start(start) ?? throw new InvalidOperationException("Could not start names reader.");
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(15_000))
        {
            child.Kill(entireProcessTree: true);
            child.WaitForExit();
            throw new InvalidOperationException("MultiplayerNameStoreTests: fresh reader timed out.");
        }
        Assert(child.ExitCode == 0, "fresh reader failed: " + error.GetAwaiter().GetResult());
        Assert(output.GetAwaiter().GetResult().Contains("multiplayer name store read: ok", StringComparison.Ordinal),
            "the new process completed the persisted-name assertions");
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _previousWorkingDirectory = Directory.GetCurrentDirectory();
        private readonly string? _previousNamesPath = Environment.GetEnvironmentVariable(MultiplayerNameStore.PathEnvironmentVariable);
        private UnixFileMode? _previousMode;

        public string Root { get; } = Path.Combine(Path.GetTempPath(), "couchcoop-name-store-" + Guid.NewGuid().ToString("N"));
        public string WorkingDirectory { get; }
        public string CanonicalPath => Path.Combine(Root, "host-user", "couch-coop", MultiplayerNameStore.FileName);
        public string LegacyPath => Path.Combine(WorkingDirectory, MultiplayerNameStore.FileName);

        public Fixture()
        {
            var launchDirectory = Path.Combine(Root, "launch-directory");
            Directory.CreateDirectory(launchDirectory);
            Environment.SetEnvironmentVariable(MultiplayerNameStore.PathEnvironmentVariable, CanonicalPath);
            Directory.SetCurrentDirectory(launchDirectory);
            // macOS may spell the temporary root through /var while getcwd resolves its /private/var alias.
            WorkingDirectory = Directory.GetCurrentDirectory();
        }

        public void MakeWorkingDirectoryReadOnly()
        {
            if (OperatingSystem.IsWindows()) return;
            _previousMode = File.GetUnixFileMode(WorkingDirectory);
            File.SetUnixFileMode(WorkingDirectory,
                UnixFileMode.UserRead | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            var probe = Path.Combine(WorkingDirectory, "write-probe");
            var denied = false;
            try { File.WriteAllText(probe, "probe"); }
            catch (UnauthorizedAccessException) { denied = true; }
            finally { if (File.Exists(probe)) File.Delete(probe); }
            Assert(denied, "the Unix test working directory actually rejects writes");
        }

        public void Dispose()
        {
            Directory.SetCurrentDirectory(_previousWorkingDirectory);
            Environment.SetEnvironmentVariable(MultiplayerNameStore.PathEnvironmentVariable, _previousNamesPath);
            if (!OperatingSystem.IsWindows() && _previousMode is { } mode)
                File.SetUnixFileMode(WorkingDirectory, mode);
            Directory.Delete(Root, recursive: true);
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("MultiplayerNameStoreTests: " + message);
    }
}
