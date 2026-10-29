using System.Diagnostics;
using System.Globalization;
using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>
/// The host's half of the streaming seat (handoff-mirror-new-renderer.md MIR-3): which seat launch becomes the
/// streaming seat, and the environment it is launched with.
/// </summary>
/// <remarks>
/// <para>
/// WHO STREAMS. At most one seat per host: the seat of the first viewer whose join asks for the new renderer
/// (<c>renderer: "stream"</c>). <see cref="HeadlessClientManager"/> makes that decision when it launches a seat
/// process; a seat that is already running keeps the role it started with, because the texture evictor a normal
/// seat installs cannot be undone. So the choice applies at the seat's next start.
/// </para>
/// <para>
/// THE OPERATOR CONFIGURES IT. For the beta the capture is not shipped with the mod: the host process is given
/// <see cref="RenderCaptureExtensionLoader.EnvironmentVariable"/> (an absolute <c>.gdextension</c> path) and,
/// optionally, <see cref="CalibrationEnvironmentVariable"/>. Without a calibration variable the calibration record
/// is the file <see cref="DefaultCalibrationFileName"/> next to the extension, which is how a packaged capture
/// would ship it. A host with neither launches every seat exactly as before.
/// </para>
/// <para>
/// THE ENVIRONMENT IS THE HOST'S. <see cref="Environment"/> is the whole <c>GRC_*</c> table, taken from the live
/// acceptance setup (godot-scene-web <c>results/p3/w11z.md</c>, C3's <c>a12</c> mode): render-stream/12, a
/// loopback listener on a per-slot port, token auth, the host's own page origins, live coding, inline records up
/// to 4096 bytes and NO hook log (on a real seat it grows by ~38 GB in 22 minutes). Every inherited
/// <c>GRC_*</c> is dropped first, from every seat, so a value on the host can never leak into a seat.
/// </para>
/// </remarks>
internal static class StreamingSeatLaunch
{
    /// <summary>Optional absolute path of the capture's calibration record (see the remarks for the default).</summary>
    internal const string CalibrationEnvironmentVariable = "COUCHCOOP_RENDER_CAPTURE_CALIBRATION";

    /// <summary>
    /// Dev only: extra page origins (comma list of exact <c>scheme://host:port</c>) the hub accepts and the seat
    /// hands its descriptor to, e.g. the Vite dev server <c>http://127.0.0.1:5190</c>.
    /// </summary>
    internal const string ExtraOriginsEnvironmentVariable = "COUCHCOOP_RENDER_STREAM_EXTRA_ORIGINS";

    /// <summary>The calibration record's file name next to the extension when no calibration variable is set.</summary>
    internal const string DefaultCalibrationFileName = "calibration.json";

    /// <summary>The wire version the seat speaks (GPU particles simulated on the client).</summary>
    internal const int StreamVersion = 12;

    /// <summary>
    /// The hub listens on the last port of the seat's 10-port band (<see cref="HeadlessClientManager.SlotToPort"/>
    /// + 9): stable for a slot across sessions, so a returning viewer's browser cache (keyed by port) stays warm.
    /// </summary>
    internal const int HubPortOffset = 9;

    /// <summary>Its private evidence directory (the token file lives there), under the host's couch-coop dir.</summary>
    internal static string EvidenceDirectory(string hostUserDir, int slot)
        => Path.Combine(hostUserDir, "couch-coop", "render-stream", $"slot-{slot.ToString(CultureInfo.InvariantCulture)}");

    internal static int HubPortForSlot(int slot) => HeadlessClientManager.SlotToPort(slot) + HubPortOffset;

    /// <summary>What the operator configured: the capture to load and its calibration record.</summary>
    internal sealed record Config(string Extension, string Calibration);

    /// <summary>The configuration, or why there is none. Both null means the host is simply not configured.</summary>
    internal readonly record struct ConfigResult(Config? Config, string? Refusal);

    internal static ConfigResult ResolveConfig(string? extension, string? calibration, Func<string, bool> fileExists)
    {
        ArgumentNullException.ThrowIfNull(fileExists);
        var request = RenderCaptureExtensionLoader.Resolve(extension, fileExists);
        if (request.Path is null) return new ConfigResult(null, request.Refusal);

        string calibrationPath;
        if (string.IsNullOrWhiteSpace(calibration))
        {
            calibrationPath = Path.Combine(Path.GetDirectoryName(request.Path)!, DefaultCalibrationFileName);
        }
        else
        {
            calibrationPath = calibration.Trim();
            if (!Path.IsPathFullyQualified(calibrationPath))
            {
                return new ConfigResult(null,
                    $"{CalibrationEnvironmentVariable} must be an absolute path, got '{calibrationPath}'");
            }
        }

        return fileExists(calibrationPath)
            ? new ConfigResult(new Config(request.Path, calibrationPath), null)
            : new ConfigResult(null, $"the capture's calibration record does not exist: '{calibrationPath}'");
    }

    /// <summary>Read the host's own configuration once (the variables cannot change while it runs).</summary>
    internal static ConfigResult ResolveConfigFromEnvironment()
        => ResolveConfig(
            System.Environment.GetEnvironmentVariable(RenderCaptureExtensionLoader.EnvironmentVariable),
            System.Environment.GetEnvironmentVariable(CalibrationEnvironmentVariable),
            File.Exists);

    /// <summary>
    /// The page origins the hub accepts: this host's own loopback page (both spellings a player can type), plus
    /// the dev extras. A LAN or HTTPS page is deliberately absent: it could not reach a loopback hub, so the seat
    /// withholds the descriptor from it and the page shows "needs-proxy".
    /// </summary>
    internal static IReadOnlyList<string> AllowedOrigins(int hostBrowserPort, string? extraOrigins)
    {
        var port = hostBrowserPort.ToString(CultureInfo.InvariantCulture);
        var origins = new List<string> { $"http://127.0.0.1:{port}", $"http://localhost:{port}" };
        foreach (var entry in (extraOrigins ?? string.Empty).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            // The capture refuses its whole listener on one malformed entry, so a bad extra is dropped here instead.
            if (!OriginEntry.IsMatch(entry)) continue;

            if (!origins.Contains(entry, StringComparer.Ordinal)) origins.Add(entry);
        }

        return origins;
    }

    // The capture's own rule (godot-scene-web rs_ws.h parse_allowed_origins): exactly `scheme://host:port` as a
    // browser serializes an Origin — lowercase, no path or trailing slash, a port with no leading zero.
    private static readonly System.Text.RegularExpressions.Regex OriginEntry = new(
        @"^[a-z][a-z0-9+.-]*://([a-z0-9.-]+|\[[0-9a-f:.]+\]):[1-9][0-9]{0,4}$",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// The streaming seat's launch environment: the role, the capture, and the capture's <c>GRC_*</c> table.
    /// Pure; <see cref="Apply"/> puts it on a launch.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> Environment(
        Config config, int hubPort, string evidenceDirectory, IReadOnlyList<string> allowedOrigins)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(allowedOrigins);
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [StreamingSeatRole.EnvironmentVariable] = "1",
            [RenderCaptureExtensionLoader.EnvironmentVariable] = config.Extension,
            ["GRC_MODE"] = "arm",
            ["GRC_CALIBRATION"] = config.Calibration,
            ["GRC_LIVE_LISTEN"] = $"127.0.0.1:{hubPort.ToString(CultureInfo.InvariantCulture)}",
            ["GRC_STREAM_VERSION"] = StreamVersion.ToString(CultureInfo.InvariantCulture),
            ["GRC_LIVE_AUTH"] = "token",
            ["GRC_EVIDENCE_DIR"] = evidenceDirectory,
            ["GRC_LIVE_ALLOWED_ORIGINS"] = string.Join(',', allowedOrigins),
            // One viewer, plus a second tab of the same viewer.
            ["GRC_LIVE_MAX_CONNECTIONS"] = "2",
            ["GRC_LIVE_CODING"] = "zstd-base",
            // MANDATORY on a real seat: on by default, and its resources.jsonl grows by ~38 GB in 22 minutes.
            ["GRC_HOOK_LOG"] = "off",
            ["GRC_ADOPT"] = "arm",
            ["GRC_UNKNOWN_ITEM"] = "skip",
            ["GRC_TEXTURE_DECODE"] = "engine",
            ["GRC_TEXTURE_WORKERS"] = "2",
            ["GRC_ROOT_SIZE"] = "presentation:1920x1080",
            // The game has ~2,400 live items; C3's raised caps.
            ["GRC_MIRROR_MAX_ITEMS"] = "32768",
            ["GRC_MIRROR_MAX_COMMANDS"] = "16384",
            ["GRC_RESOURCE_MAX_PAYLOAD_BYTES"] = "268435456",
            ["GRC_RESOURCE_BUDGET_BYTES"] = "8589934592",
            // /12's formats: the half-float card glow and the particle curve textures.
            ["GRC_RESOURCE_FORMATS"] = "L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH,RF,RGF,RGBF,RGBAF",
            // Every mesh surface rides the socket instead of a GET (skeletal animation).
            ["GRC_RESOURCE_INLINE_MAX_BYTES"] = "4096",
            ["GRC_MESH_DYNAMIC"] = "auto",
        };
    }

    /// <summary>
    /// Drop everything streaming-related a seat could inherit from its host: the role, the capture variables this
    /// file reads and every <c>GRC_*</c>. Every seat launch calls it; only the streaming seat then gets
    /// <see cref="Environment"/> back through <see cref="Apply"/>.
    /// </summary>
    internal static void ClearInherited(ProcessStartInfo psi)
    {
        ArgumentNullException.ThrowIfNull(psi);
        StreamingSeatRole.ClearInheritedRole(psi);
        // A copy of the keys: the dictionary is edited while walking it.
        foreach (var key in psi.Environment.Keys.ToArray())
        {
            if (key.StartsWith("GRC_", StringComparison.Ordinal)
                || key is RenderCaptureExtensionLoader.EnvironmentVariable or CalibrationEnvironmentVariable
                    or ExtraOriginsEnvironmentVariable)
            {
                psi.Environment.Remove(key);
            }
        }
    }

    internal static void Apply(ProcessStartInfo psi, IReadOnlyDictionary<string, string> environment)
    {
        ArgumentNullException.ThrowIfNull(psi);
        ArgumentNullException.ThrowIfNull(environment);
        ClearInherited(psi);
        foreach (var kv in environment) psi.Environment[kv.Key] = kv.Value;
    }
}
