using System.Diagnostics;
using CouchCoop.Mod.Diagnostics;
using CouchCoop.Mod.Session;

// A capture seat keeps the windowless suspender in standby and leaves texture release to the capture.
// Pure decisions plus real ProcessStartInfo environments and source pins; no engine is loaded.
internal static class StreamingSeatRoleTests
{
    public const string Verb = "streaming-seat";

    private const string Extension = "/opt/research/render_stream_capture.gdextension";

    public static void Run()
    {
        OnlyExactlyOneRequestsTheRole();
        UnflaggedInstallsBothSaversAsBefore();
        FlaggedKeepsTheVisualSuspender();
        UnflaggedLoadsNothing();
        UnflaggedIgnoresANamedExtension();
        FlaggedLoadsTheCapture();
        FlaggedWithoutAnExtensionRefuses();
        FlaggedWithABadExtensionRefuses();
        FlaggedWithAFailedLoadRefuses();
        SeatLaunchDropsAnInheritedRole();
        ModInitAsksTheRole();
    }

    private static void OnlyExactlyOneRequestsTheRole()
    {
        Assert(StreamingSeatRole.IsRequested("1"), "1 requests the role");
        foreach (var value in new string?[] { null, "", "0", "true", " 1", "yes" })
        {
            Assert(!StreamingSeatRole.IsRequested(value), $"'{value}' does not request the role");
        }
    }

    private static void UnflaggedInstallsBothSaversAsBefore()
    {
        // Before the role: the evictor on a headless client, the suspender on any windowless instance.
        foreach (var headlessClient in new[] { false, true })
        {
            Assert(
                StreamingSeatRole.InstallsTextureEvictor(streamingSeat: false, headlessClient) == headlessClient,
                $"unflagged evictor follows headless client ({headlessClient})");
        }

        foreach (var windowless in new[] { false, true })
        {
            Assert(
                StreamingSeatRole.InstallsVisualSuspender(streamingSeat: false, windowless) == windowless,
                $"unflagged suspender follows windowless ({windowless})");
        }
    }

    private static void FlaggedKeepsTheVisualSuspender()
    {
        foreach (var instance in new[] { false, true })
        {
            Assert(!StreamingSeatRole.InstallsTextureEvictor(streamingSeat: true, instance), "the streaming seat has no evictor");
            Assert(StreamingSeatRole.InstallsVisualSuspender(streamingSeat: true, instance) == instance,
                "a capture seat installs the suspender when windowless");
        }
    }

    private static void UnflaggedLoadsNothing()
    {
        foreach (var blank in new string?[] { null, "", "  " })
        {
            var loader = new RecordingLoader(loaded: true);
            var outcome = StreamingSeatRole.StartCapture(false, blank, _ => true, loader.Load);
            Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.Off && outcome.Message is null,
                "unflagged with no extension is off and silent");
            Assert(loader.Calls.Count == 0, "unflagged never calls the loader");
        }
    }

    private static void UnflaggedIgnoresANamedExtension()
    {
        var loader = new RecordingLoader(loaded: true);
        var outcome = StreamingSeatRole.StartCapture(false, Extension, _ => true, loader.Load);
        Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.IgnoredExtension && outcome.Message is not null,
            "a named extension without the flag is ignored, with a warning");
        Assert(loader.Calls.Count == 0, "a named extension without the flag is not loaded");
    }

    private static void FlaggedLoadsTheCapture()
    {
        var loader = new RecordingLoader(loaded: true);
        var outcome = StreamingSeatRole.StartCapture(true, $" {Extension}\n", path => path == Extension, loader.Load);
        Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.Loaded, "the streaming seat loads its capture");
        Assert(loader.Calls is [Extension], "the loader is called once, with the trimmed path");
        Assert(outcome.Message!.Contains("capture in standby", StringComparison.Ordinal),
            "the load log describes standby without claiming the suspender is absent");
    }

    private static void FlaggedWithoutAnExtensionRefuses()
    {
        foreach (var blank in new string?[] { null, "", "  " })
        {
            var loader = new RecordingLoader(loaded: true);
            var outcome = StreamingSeatRole.StartCapture(true, blank, _ => true, loader.Load);
            Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.Refused && outcome.Message is not null,
                "a streaming seat with no extension refuses to start");
            Assert(loader.Calls.Count == 0, "nothing is loaded when no extension is named");
        }
    }

    private static void FlaggedWithABadExtensionRefuses()
    {
        foreach (var (value, exists) in new (string, bool)[]
                 {
                     ("build/render_stream_capture.gdextension", true),
                     ("/opt/research/librender_stream_capture.so", true),
                     (Extension, false),
                 })
        {
            var loader = new RecordingLoader(loaded: true);
            var outcome = StreamingSeatRole.StartCapture(true, value, _ => exists, loader.Load);
            Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.Refused, $"'{value}' (exists={exists}) refuses");
            Assert(loader.Calls.Count == 0, $"'{value}' is not loaded");
        }
    }

    private static void FlaggedWithAFailedLoadRefuses()
    {
        var loader = new RecordingLoader(loaded: false);
        var outcome = StreamingSeatRole.StartCapture(true, Extension, _ => true, loader.Load);
        Assert(outcome.Kind == StreamingSeatRole.CaptureOutcomeKind.Refused
               && outcome.Message!.Contains("status=Failed", StringComparison.Ordinal),
            "a failed load refuses, naming the status");
        Assert(loader.Calls is [Extension], "the failed load was attempted once");
    }

    private static void SeatLaunchDropsAnInheritedRole()
    {
        // A real ProcessStartInfo: its environment is a copy of this process's, and its indexer throws on a missing
        // key, which a Dictionary stand-in would hide.
        var inherited = new ProcessStartInfo("true");
        inherited.EnvironmentVariables[StreamingSeatRole.EnvironmentVariable] = "1";
        inherited.EnvironmentVariables[RenderCaptureExtensionLoader.EnvironmentVariable] = Extension;
        StreamingSeatRole.ClearInheritedRole(inherited);
        Assert(!inherited.EnvironmentVariables.ContainsKey(StreamingSeatRole.EnvironmentVariable),
            "a seat launch drops the inherited role");
        Assert(inherited.EnvironmentVariables.ContainsKey(RenderCaptureExtensionLoader.EnvironmentVariable),
            "the rest of the environment is untouched");

        var clean = new ProcessStartInfo("true");
        clean.EnvironmentVariables.Remove(StreamingSeatRole.EnvironmentVariable);
        var before = clean.EnvironmentVariables.Count;
        StreamingSeatRole.ClearInheritedRole(clean);
        Assert(clean.EnvironmentVariables.Count == before, "an unflagged launch environment is unchanged");
    }

    private static void ModInitAsksTheRole()
    {
        var root = RepoRoot();
        var init = File.ReadAllText(Path.Combine(root, "src", "CouchCoop.Mod", "CouchCoopMod.cs"));

        var cloudGuard = init.IndexOf("HeadlessSeatCloudIsolationGuard.EnforceOrExit();", StringComparison.Ordinal);
        var capture = init.IndexOf("StreamingSeatRole.StartCaptureOrExit();", StringComparison.Ordinal);
        var join = init.IndexOf("CommandLineOverridePatch.Apply();", StringComparison.Ordinal);
        Assert(cloudGuard >= 0 && capture > cloudGuard && join > capture,
            "the capture starts below the seat's cloud guard and above the override that lets a seat join");

        AssertGated(init, "HeadlessTextureImageEvictor.Install();", "StreamingSeatRole.InstallsTextureEvictor(");
        AssertGated(init, "CouchCoopHeadlessVisualSuspender.Install();", "StreamingSeatRole.InstallsVisualSuspender(");
        AssertGated(init, "Session.RenderStreamItemTagger.Install();", "if (StreamingSeatRole.IsStreamingSeat)");
        AssertGated(init, "StreamDesignPlacementPatch.Apply();", "if (IsHeadlessClient && StreamingSeatRole.IsStreamingSeat)");
        AssertGated(init, "StreamMapDrawingToolsPatch.Apply();", "if (IsHeadlessClient && StreamingSeatRole.IsStreamingSeat)");
        AssertGated(init, "StreamHandPlacementPatch.Apply();", "if (IsHeadlessClient && StreamingSeatRole.IsStreamingSeat)");
        AssertGated(init, "StreamCreaturePlacementPatch.Apply();", "if (IsHeadlessClient && StreamingSeatRole.IsStreamingSeat)");
        AssertGated(init, "StreamEnergyPlacementPatch.Apply();", "if (IsHeadlessClient && StreamingSeatRole.IsStreamingSeat)");

        var launcher = File.ReadAllText(
            Path.Combine(root, "src", "CouchCoop.Mod", "Session", "HeadlessClientManager.cs"));
        Assert(launcher.Contains("StreamingSeatRole.ClearInheritedRole(psi);", StringComparison.Ordinal),
            "the seat launcher drops an inherited role");
    }

    // Every install call in mod init sits right under its role gate (within a few lines), so no install escapes it.
    private static void AssertGated(string source, string install, string gate)
    {
        var index = source.IndexOf(install, StringComparison.Ordinal);
        Assert(index >= 0, $"mod init still calls {install}");
        while (index >= 0)
        {
            var window = source[Math.Max(0, index - 200)..index];
            Assert(window.Contains(gate, StringComparison.Ordinal), $"{install} is gated by {gate}");
            index = source.IndexOf(install, index + install.Length, StringComparison.Ordinal);
        }
    }

    private sealed class RecordingLoader(bool loaded)
    {
        public List<string> Calls { get; } = [];

        public RenderCaptureExtensionLoader.LoadResult Load(string path)
        {
            Calls.Add(path);
            return new RenderCaptureExtensionLoader.LoadResult(loaded, loaded ? "Ok" : "Failed");
        }
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "CouchCoop.sln")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName
            ?? throw new Exception("[StreamingSeatRoleTests] could not locate the repo root (CouchCoop.sln).");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[StreamingSeatRoleTests] FAILED: {label}");
        }
    }
}
