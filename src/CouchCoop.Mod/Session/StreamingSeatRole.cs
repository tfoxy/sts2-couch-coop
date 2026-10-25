using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>
/// The streaming seat: one instance, flagged with <c>COUCHCOOP_STREAMING_SEAT=1</c>, whose rendering is captured
/// by godot-scene-web's render-stream GDExtension instead of being made cheap.
/// </summary>
/// <remarks>
/// <para>
/// WHAT THE ROLE CHANGES. A windowless instance normally installs two savers that discard exactly what the capture
/// reads: <see cref="CouchCoopHeadlessVisualSuspender"/> freezes spine, particles and decorative animators and drops
/// the idle frame rate, so the scene stops drawing; <see cref="HeadlessTextureImageEvictor"/> replaces the CPU copy
/// of every VRAM-compressed texture with 1x1 data, and the capture's late-join adoption reads those copies, so an
/// evicted texture would stream as 1x1 with nothing on either side noticing. The streaming seat installs neither,
/// and loads the capture through <see cref="RenderCaptureExtensionLoader"/>. Nothing else about the instance
/// changes: a seat still joins, plays and serves its browser exactly as before.
/// </para>
/// <para>
/// THE CAPTURE IS REQUIRED, AND ONLY HERE. A streaming seat without the capture is a seat with its savers off for
/// nothing, streaming nothing — so a flagged instance whose <c>COUCHCOOP_RENDER_CAPTURE_EXTENSION</c> is unset,
/// malformed or fails to load refuses to start, with the reason in its log, before it can join. The other way round,
/// the extension variable alone loads nothing: a capture running under the savers would stream a frozen scene with
/// 1x1 textures. That also keeps a seat that inherits the host's capture environment from loading it.
/// </para>
/// <para>
/// THE ROLE IS NOT INHERITED. Spawned seats copy the host's environment, so a flag set on a host would turn every
/// seat it spawns into a streaming seat, all arming one capture listener. <see cref="ClearInheritedRole"/> removes
/// it from every seat launch: the flag marks the one process it is set on. Choosing a spawned seat to stream is
/// the host's decision to make explicitly, and it does not make it yet.
/// </para>
/// <para>
/// The capture loads at mod init, below the seat's cloud-save guard and above the command-line override that lets
/// a seat join — the capture's "modder route". It arms there, before the game's first scene exists; the capture's
/// own adoption (<c>GRC_ADOPT=arm</c>) is what covers anything created before it armed. Its <c>GRC_*</c>
/// environment is the capture's contract, documented in godot-scene-web
/// (<c>experiments/render-stream/protocol/gate8-product-handoff.md</c>), not read here.
/// </para>
/// </remarks>
internal static class StreamingSeatRole
{
    internal const string EnvironmentVariable = "COUCHCOOP_STREAMING_SEAT";

    /// <summary>This process is the streaming seat. Read once; the role cannot change while the process runs.</summary>
    public static bool IsStreamingSeat { get; } = IsRequested(Environment.GetEnvironmentVariable(EnvironmentVariable));

    /// <summary>Exactly <c>1</c>, like every other opt-in <c>COUCHCOOP_*</c> flag.</summary>
    internal static bool IsRequested(string? value) => value == "1";

    /// <summary>A headless client installs the texture evictor unless it is the streaming seat.</summary>
    internal static bool InstallsTextureEvictor(bool streamingSeat, bool isHeadlessClient)
        => isHeadlessClient && !streamingSeat;

    /// <summary>A windowless instance installs the visual suspender unless it is the streaming seat.</summary>
    internal static bool InstallsVisualSuspender(bool streamingSeat, bool isWindowless)
        => isWindowless && !streamingSeat;

    internal enum CaptureOutcomeKind
    {
        /// <summary>Not a streaming seat and no extension named: nothing happens and nothing is logged.</summary>
        Off,

        /// <summary>Not a streaming seat but an extension named: not loaded, with a warning.</summary>
        IgnoredExtension,

        /// <summary>The streaming seat loaded its capture.</summary>
        Loaded,

        /// <summary>The streaming seat could not load its capture: the instance must not start.</summary>
        Refused,
    }

    internal readonly record struct CaptureOutcome(CaptureOutcomeKind Kind, string? Message);

    /// <summary>
    /// What mod init does about the capture. Pure apart from <paramref name="load"/>, which is called at most once,
    /// and only for the streaming seat with a valid extension path.
    /// </summary>
    internal static CaptureOutcome StartCapture(
        bool streamingSeat,
        string? extensionValue,
        Func<string, bool> fileExists,
        Func<string, RenderCaptureExtensionLoader.LoadResult> load)
    {
        if (!streamingSeat)
        {
            return string.IsNullOrWhiteSpace(extensionValue)
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
                + "visual suspender and texture evictor are not installed")
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
            RenderCaptureExtensionLoader.Load);
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
                // be impossible is this instance going on to join with its savers off and no capture.
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
