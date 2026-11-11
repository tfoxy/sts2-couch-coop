using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>
/// A seat with the render-stream capture loaded in standby, flagged with <c>COUCHCOOP_STREAMING_SEAT=1</c>.
/// </summary>
/// <remarks>
/// Capture seats keep the visual suspender while using the mirror; arming disables it until capture teardown
/// finishes. They never install the texture evictor: the capture releases compressed texture pixels itself and
/// reloads them for each arm. A flagged seat must load its capture before joining or refuse to start.
/// The host clears inherited capture settings and applies this role to each configured seat launch.
/// </remarks>
internal static class StreamingSeatRole
{
    internal const string EnvironmentVariable = "COUCHCOOP_STREAMING_SEAT";

    /// <summary>This process has the capture loaded. Read once; the loaded role lasts for the process lifetime.</summary>
    public static bool IsStreamingSeat { get; } = IsRequested(Environment.GetEnvironmentVariable(EnvironmentVariable));

    /// <summary>Exactly <c>1</c>, like every other opt-in <c>COUCHCOOP_*</c> flag.</summary>
    internal static bool IsRequested(string? value) => value == "1";

    /// <summary>A headless client installs the texture evictor unless it is the streaming seat.</summary>
    internal static bool InstallsTextureEvictor(bool streamingSeat, bool isHeadlessClient)
        => isHeadlessClient && !streamingSeat;

    /// <summary>Every windowless instance installs the visual suspender, including a capture seat in standby.</summary>
    internal static bool InstallsVisualSuspender(bool streamingSeat, bool isWindowless)
        => isWindowless;

    internal enum CaptureOutcomeKind
    {
        /// <summary>
        /// Not a streaming seat and no extension named — or the HOST, for which the variable is the operator's
        /// configuration of its streaming seat (StreamingSeatLaunch logs it): nothing happens and nothing is logged.
        /// </summary>
        Off,

        /// <summary>A seat that is not the streaming seat, with an extension named: not loaded, with a warning.</summary>
        IgnoredExtension,

        /// <summary>The streaming seat loaded its capture.</summary>
        Loaded,

        /// <summary>The streaming seat could not load its capture: the instance must not start.</summary>
        Refused,
    }

    internal readonly record struct CaptureOutcome(CaptureOutcomeKind Kind, string? Message);

    /// <summary>
    /// What mod init does about the capture. Pure apart from <paramref name="load"/>, which is called at most once,
    /// and only for the streaming seat with a valid extension path. <paramref name="isHeadlessClient"/> false is the
    /// host, whose extension variable configures the seat it may launch to stream.
    /// </summary>
    internal static CaptureOutcome StartCapture(
        bool streamingSeat,
        string? extensionValue,
        Func<string, bool> fileExists,
        Func<string, RenderCaptureExtensionLoader.LoadResult> load,
        bool isHeadlessClient = true)
    {
        if (!streamingSeat)
        {
            return string.IsNullOrWhiteSpace(extensionValue) || !isHeadlessClient
                ? new CaptureOutcome(CaptureOutcomeKind.Off, null)
                : new CaptureOutcome(
                    CaptureOutcomeKind.IgnoredExtension,
                    $"render-capture extension not loaded: {RenderCaptureExtensionLoader.EnvironmentVariable} is "
                    + $"set but this instance is not the streaming seat ({EnvironmentVariable}=1)");
        }

        var request = RenderCaptureExtensionLoader.Resolve(extensionValue, fileExists);
        if (request.Path is null)
        {
            var reason = request.Refusal ?? $"{RenderCaptureExtensionLoader.EnvironmentVariable} is not set";
            return new CaptureOutcome(CaptureOutcomeKind.Refused, $"streaming seat refused: {reason}");
        }

        var result = load(request.Path);
        return result.Loaded
            ? new CaptureOutcome(
                CaptureOutcomeKind.Loaded,
                $"streaming seat: render-capture extension load status={result.Status} path={request.Path}; "
                + "capture in standby; texture evictor is not installed")
            : new CaptureOutcome(
                CaptureOutcomeKind.Refused,
                $"streaming seat refused: render-capture extension load status={result.Status} path={request.Path}");
    }

    /// <summary>
    /// Mod init's capture step: logs the outcome of <see cref="StartCapture"/> and terminates this process when
    /// the streaming seat cannot load its capture. Returns normally in every other case.
    /// </summary>
    public static void StartCaptureOrExit()
    {
        var outcome = StartCapture(
            IsStreamingSeat,
            Environment.GetEnvironmentVariable(RenderCaptureExtensionLoader.EnvironmentVariable),
            File.Exists,
            RenderCaptureExtensionLoader.Load,
            CouchCoopMod.IsHeadlessClient);
        switch (outcome.Kind)
        {
            case CaptureOutcomeKind.Off:
                return;
            case CaptureOutcomeKind.IgnoredExtension:
                CouchCoopLog.Warn(outcome.Message!);
                return;
            case CaptureOutcomeKind.Loaded:
                CouchCoopLog.Info(outcome.Message!);
                return;
            default:
                CouchCoopLog.Error(outcome.Message!);
                CouchCoopLog.Stderr(outcome.Message!);
                // Same exit as a seat that fails its build check: nothing has started, and the outcome that must
                // be impossible is this instance going on to join with its texture evictor off and no capture.
                HeadlessForceExit.Now();
                return;
        }
    }

    /// <summary>Remove the role from a seat launch, so a flag on the host never reaches the seats it spawns.</summary>
    internal static void ClearInheritedRole(System.Diagnostics.ProcessStartInfo psi)
    {
        ArgumentNullException.ThrowIfNull(psi);
        psi.EnvironmentVariables.Remove(EnvironmentVariable);
    }
}
