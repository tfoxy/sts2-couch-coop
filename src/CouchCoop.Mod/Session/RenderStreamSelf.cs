using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>A capture loaded for this process's own view, in standby until a browser requests it.</summary>
internal static class RenderStreamSelf
{
    public static bool Enabled { get; private set; }

    internal static void MarkLoaded() => Enabled = true;

    internal enum HostCaptureOutcomeKind { Off, Loaded, Unavailable }
    internal readonly record struct HostCaptureOutcome(HostCaptureOutcomeKind Kind, string? Message);

    // A host failure leaves the old renderer available; only a streaming seat refuses to start.
    internal static HostCaptureOutcome StartHostCapture(
        bool isHeadlessClient, bool isHeadlessDisplay,
        Func<StreamingSeatLaunch.ConfigResult> resolve,
        Action<StreamingSeatLaunch.Config> prepare,
        Func<string, RenderCaptureExtensionLoader.LoadResult> load)
    {
        if (isHeadlessClient || !isHeadlessDisplay) return new(HostCaptureOutcomeKind.Off, null);
        try
        {
            var resolved = resolve();
            if (resolved.Config is not { } config)
                return resolved.Refusal is { } refusal
                    ? new(HostCaptureOutcomeKind.Unavailable, $"host render-capture unavailable: {refusal}")
                    : new(HostCaptureOutcomeKind.Off, null);
            prepare(config);
            var result = load(config.Extension);
            return new(result.Loaded ? HostCaptureOutcomeKind.Loaded : HostCaptureOutcomeKind.Unavailable,
                $"host render-capture load status={result.Status}; "
                + (result.Loaded ? "capture in standby" : "keeping the old renderer"));
        }
        catch (Exception exception)
        {
            return new(HostCaptureOutcomeKind.Unavailable,
                $"host render-capture unavailable: {exception.GetType().Name}: {exception.Message}");
        }
    }

    public static void StartCaptureOrExit(bool isHeadlessClient, bool isHeadlessDisplay)
    {
        if (isHeadlessClient)
        {
            StreamingSeatRole.StartCaptureOrExit();
            return;
        }
        var outcome = StartHostCapture(false, isHeadlessDisplay, StreamingSeatLaunch.ResolveConfigFromEnvironment,
            config =>
            {
                var hostUserDir = HeadlessUserDirSeeder.ResolveHostUserDir()
                    ?? throw new InvalidOperationException("the host user dir is unresolved");
                var evidence = StreamingSeatLaunch.EvidenceDirectory(hostUserDir, 0);
                Directory.CreateDirectory(evidence);
                ApplyHostEnvironment(StreamingSeatLaunch.HostEnvironment(config, evidence,
                    StreamingSeatLaunch.AllowedOrigins(HeadlessClientManager.HostPort,
                        Environment.GetEnvironmentVariable(StreamingSeatLaunch.ExtraOriginsEnvironmentVariable))));
            }, RenderCaptureExtensionLoader.Load);
        if (outcome.Kind == HostCaptureOutcomeKind.Loaded) MarkLoaded();
        if (outcome.Message is { } message) CouchCoopLog.Info(message);
    }

    private static void ApplyHostEnvironment(IReadOnlyDictionary<string, string> environment)
        => ApplyHostEnvironment(environment, Environment.GetEnvironmentVariables().Keys.Cast<string>(),
            (key, value) =>
            {
                if (value is null) Godot.OS.UnsetEnvironment(key);
                else Godot.OS.SetEnvironment(key, value);
            }, Environment.SetEnvironmentVariable);

    // Native capture and managed relay read different environment copies on Linux. Keep both in sync.
    internal static void ApplyHostEnvironment(IReadOnlyDictionary<string, string> environment,
        IEnumerable<string> inheritedKeys, Action<string, string?> setNative, Action<string, string?> setManaged)
    {
        foreach (var key in inheritedKeys.Where(key => key.StartsWith("GRC_", StringComparison.Ordinal)).ToArray())
        {
            setNative(key, null);
            setManaged(key, null);
        }
        foreach (var (key, value) in environment)
        {
            setNative(key, value);
            setManaged(key, value);
        }
    }
}
