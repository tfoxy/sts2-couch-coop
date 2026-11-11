using System.Diagnostics;
using System.Globalization;
using CouchCoop.Mod.Diagnostics;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Configures each headless seat's capture in standby, ready to arm for a browser page at runtime.
/// </summary>
/// <remarks>
/// The operator's capture and calibration settings take precedence over a packaged capture. Every configured
/// seat gets its own listener port and evidence directory. Inherited capture variables are cleared before the
/// standby environment is applied, so the host cannot accidentally arm a seat or override its capture settings.
/// </remarks>
internal static class StreamingSeatLaunch
{
    internal const string TokenFileName = "live-token";
    internal const string CertificateHashFileName = "live-cert-sha256";

    /// <summary>Optional absolute path of the capture's calibration record (see the remarks for the default).</summary>
    internal const string CalibrationEnvironmentVariable = "COUCHCOOP_RENDER_CAPTURE_CALIBRATION";

    /// <summary>
    /// Dev only: extra page origins (comma list of exact <c>scheme://host:port</c>) the hub accepts and the seat
    /// hands its descriptor to, e.g. the Vite dev server <c>http://127.0.0.1:5190</c>.
    /// </summary>
    internal const string ExtraOriginsEnvironmentVariable = "COUCHCOOP_RENDER_STREAM_EXTRA_ORIGINS";

    /// <summary>
    /// Optional: the widest presentation a capture seat may arm at (an integer, at least
    /// <see cref="PresentationBaseWidth"/>; default <see cref="DefaultMaxPresentationWidth"/>). A seat's width costs
    /// host GPU and stream bytes in proportion, so the operator bounds it.
    /// </summary>
    internal const string MaxPresentationWidthEnvironmentVariable = "COUCHCOOP_RENDER_STREAM_MAX_WIDTH";

    /// <summary>The game's design size and every seat's initial presentation.</summary>
    internal const int PresentationBaseWidth = 1920;
    internal const int PresentationHeight = 1080;

    /// <summary>21:9 at 1080, the old renderer's widescreen cap (frontend <c>MIRROR_MAX_DESIGN_WIDTH</c>).</summary>
    internal const int DefaultMaxPresentationWidth = 2520;

    /// <summary>The bound on an operator's cap: the widest aspect a page may ask for (5:1) at 1080.</summary>
    internal const int UpperMaxPresentationWidth = 5400;

    /// <summary>
    /// The aspects a page may ask for; anything outside (or not finite) is treated as no aspect at all. Narrower than
    /// 16:9 is accepted and simply gets the base width: the game does not lay out taller than its base.
    /// </summary>
    internal const double MinAspect = 0.25;
    internal const double MaxAspect = 5.0;

    /// <summary>The calibration record's file name next to the extension when no calibration variable is set.</summary>
    internal const string DefaultCalibrationFileName = "calibration.json";

    /// <summary>
    /// The calibration record's file name next to a PACKAGED capture. It has no extension because STS2 scans every
    /// <c>*.json</c> under a mod's folder as a mod manifest (scripts/build-render-capture.sh writes it).
    /// </summary>
    internal const string PackagedCalibrationFileName = "calibration";

    /// <summary>
    /// The net module's file name. The capture looks for it beside its own library; the host looks beside the
    /// <c>.gdextension</c>, which is the same directory in every layout that ships it (a payload's
    /// <c>render-capture/</c>, scripts/build-render-capture.sh's staging, godot-scene-web's <c>capture/build/</c>), and
    /// names the file it found in <c>GRC_LIVE_NET_MODULE</c> so the capture loads exactly that one.
    /// </summary>
    internal const string NetModuleFileName = "librender_stream_net.so";

    /// <summary>Where a released payload carries the capture, under the payload root (scripts/package-release.sh).</summary>
    internal static readonly string[] PackagedExtensionRelativePath = ["render-capture", "render_stream_capture.gdextension"];

    /// <summary>
    /// The longest the capture's <c>perf-timeline.jsonl</c> may grow (godot-scene-web
    /// <c>GRC_PERF_TIMELINE_MAX_BYTES</c>): the seat runs for hours and nothing here reads the timeline, so it keeps
    /// only the last 4..8 MiB (two rotating files) for diagnosis.
    /// </summary>
    internal const string PerfTimelineMaxBytes = "8388608";

    /// <summary>
    /// The wire version the seat speaks: render-stream/13, /12 (GPU particles simulated on the client) with
    /// dynamic mesh and multimesh blocks predicted from the two previous transactions (about half /12's coded
    /// bytes in combat). The listener also offers /12, so an older client still connects.
    /// </summary>
    internal const int StreamVersion = 13;

    /// <summary>
    /// The hub listens on the last port of the seat's 10-port band (<see cref="HeadlessClientManager.SlotToPort"/>
    /// + 9): stable for a slot across sessions, so a returning viewer's browser cache (keyed by port) stays warm.
    /// </summary>
    internal const int HubPortOffset = 9;

    /// <summary>Its private evidence directory (the token file lives there), under the host's couch-coop dir.</summary>
    internal static string EvidenceDirectory(string hostUserDir, int slot)
        => Path.Combine(hostUserDir, "couch-coop", "render-stream", $"slot-{slot.ToString(CultureInfo.InvariantCulture)}");

    internal static int HubPortForSlot(int slot) => HeadlessClientManager.SlotToPort(slot) + HubPortOffset;

    /// <summary>
    /// What the operator configured: the capture to load, its calibration record, and the widest presentation a seat
    /// may arm at (<see cref="MaxPresentationWidthEnvironmentVariable"/>).
    /// </summary>
    /// <param name="NetModule">The net module beside the capture (<see cref="NetModuleFileName"/>), or null: the seat then
    /// serves WebSocket only.</param>
    internal sealed record Config(
        string Extension, string Calibration, int MaxPresentationWidth = DefaultMaxPresentationWidth, string? NetModule = null);

    /// <summary>
    /// A LAN launch (<see cref="StreamingSeatLan"/>): the hub on every interface, and wss through this PEM pair when the
    /// host has a certificate for its LAN pages (both null without one).
    /// </summary>
    internal sealed record LanLaunch(string? TlsCertificate = null, string? TlsKey = null);

    /// <summary>
    /// The operator's <see cref="MaxPresentationWidthEnvironmentVariable"/>: unset or not an integer is the default
    /// (with a warning for the latter), anything else is held to
    /// [<see cref="PresentationBaseWidth"/>, <see cref="UpperMaxPresentationWidth"/>] and made even.
    /// </summary>
    internal static int ParseMaxPresentationWidth(string? value, out string? warning)
    {
        warning = null;
        if (string.IsNullOrWhiteSpace(value)) return DefaultMaxPresentationWidth;
        if (!int.TryParse(value.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var width))
        {
            warning = $"{MaxPresentationWidthEnvironmentVariable} must be an integer, got '{value.Trim()}'; using "
                + DefaultMaxPresentationWidth.ToString(CultureInfo.InvariantCulture);
            return DefaultMaxPresentationWidth;
        }

        width = Math.Clamp(width, PresentationBaseWidth, UpperMaxPresentationWidth);
        return width - (width % 2);
    }

    /// <summary>
    /// The width the capture arms at for a page that sent <paramref name="aspect"/> (width / height of
    /// the box it shows the stream in): <c>clamp(round(1080 * aspect), 1920, cap)</c>, made even, then stepped down
    /// past any width Godot's float32 viewport arithmetic would not reproduce exactly
    /// (<see cref="SurvivesExpandStretch"/>). No aspect, or one that is not finite or outside
    /// [<see cref="MinAspect"/>, <see cref="MaxAspect"/>], is the base width.
    /// </summary>
    internal static int PresentationWidth(double? aspect, int maxWidth)
    {
        if (aspect is not double value || !double.IsFinite(value) || value < MinAspect || value > MaxAspect)
        {
            return PresentationBaseWidth;
        }

        var cap = Math.Clamp(maxWidth, PresentationBaseWidth, UpperMaxPresentationWidth);
        var width = (int)Math.Clamp(Math.Round(PresentationHeight * value, MidpointRounding.AwayFromZero), PresentationBaseWidth, cap);
        width -= width % 2;
        while (width > PresentationBaseWidth && !SurvivesExpandStretch(width)) width -= 2;
        return width;
    }

    /// <summary>
    /// Whether a seat at <paramref name="width"/>x1080 keeps exactly that visible width under the game's
    /// <c>canvas_items</c> / <c>expand</c> stretch. Godot 4.5.1 (<c>Window::_update_viewport_size</c>) computes it in
    /// float32 as <c>floor(1080 * (width / 1080))</c>, which for a few widths lands one short (W-1: a one-pixel
    /// horizontal stretch that blurs the whole stream). Evaluated with the same float32 operations, not a list.
    /// </summary>
    internal static bool SurvivesExpandStretch(int width)
    {
        float height = PresentationHeight;
        float aspect = (float)width / height;
        float visible = height * aspect;
        return MathF.Floor(visible) == width;
    }

    /// <summary>
    /// The configuration, or why there is none. Both null means the host is simply not configured. A
    /// <paramref name="Warning"/> is a setting that was ignored (the caller logs it; this file logs nothing).
    /// </summary>
    internal readonly record struct ConfigResult(Config? Config, string? Refusal, string? Warning = null);

    internal static ConfigResult ResolveConfig(string? extension, string? calibration, Func<string, bool> fileExists)
    {
        ArgumentNullException.ThrowIfNull(fileExists);
        var request = RenderCaptureExtensionLoader.Resolve(extension, fileExists);
        if (request.Path is null) return new ConfigResult(null, request.Refusal);

        string calibrationPath;
        if (string.IsNullOrWhiteSpace(calibration))
        {
            // `calibration.json` beside a hand-staged capture; the extensionless name a packaged one ships under.
            var directory = Path.GetDirectoryName(request.Path)!;
            calibrationPath = Path.Combine(directory, DefaultCalibrationFileName);
            if (!fileExists(calibrationPath) && fileExists(Path.Combine(directory, PackagedCalibrationFileName)))
            {
                calibrationPath = Path.Combine(directory, PackagedCalibrationFileName);
            }
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

        if (!fileExists(calibrationPath))
        {
            return new ConfigResult(null, $"the capture's calibration record does not exist: '{calibrationPath}'");
        }

        var netModule = Path.Combine(Path.GetDirectoryName(request.Path)!, NetModuleFileName);
        return new ConfigResult(new Config(request.Path, calibrationPath, NetModule: fileExists(netModule) ? netModule : null), null);
    }

    /// <summary>Read the host's own configuration once (the variables cannot change while it runs).</summary>
    internal static ConfigResult ResolveConfigFromEnvironment()
    {
        var assemblyDirectory = Path.GetDirectoryName(typeof(StreamingSeatLaunch).Assembly.Location);
        var result = ResolveConfig(
            System.Environment.GetEnvironmentVariable(RenderCaptureExtensionLoader.EnvironmentVariable),
            System.Environment.GetEnvironmentVariable(CalibrationEnvironmentVariable),
            File.Exists,
            string.IsNullOrWhiteSpace(assemblyDirectory) ? null : assemblyDirectory);
        if (result.Config is not { } config) return result;

        var maxWidth = ParseMaxPresentationWidth(
            System.Environment.GetEnvironmentVariable(MaxPresentationWidthEnvironmentVariable), out var warning);
        return result with { Config = config with { MaxPresentationWidth = maxWidth }, Warning = warning };
    }

    /// <summary>
    /// <see cref="ResolveConfig(string?, string?, Func{string, bool})"/> with the packaged capture as the fallback:
    /// when the operator named no capture, a released payload's own <c>render-capture/</c> (beside the shared tree,
    /// so one level above a lane directory) is the one. An operator's variable always wins, even when it is wrong.
    /// </summary>
    internal static ConfigResult ResolveConfig(
        string? extension, string? calibration, Func<string, bool> fileExists, string? assemblyDirectory)
    {
        ArgumentNullException.ThrowIfNull(fileExists);
        if (string.IsNullOrWhiteSpace(extension) && assemblyDirectory is not null)
        {
            var packaged = Path.Combine(
                [CouchCoop.Mod.HostUi.CouchCoopHostUiServices.ResolvePayloadRoot(assemblyDirectory), .. PackagedExtensionRelativePath]);
            if (fileExists(packaged)) extension = packaged;
        }

        return ResolveConfig(extension, calibration, fileExists);
    }

    /// <summary>
    /// The page origins the hub accepts: this host's own loopback page (both spellings a player can type), plus
    /// the dev extras. The host's LAN pages are added at launch (<see cref="StreamingSeatLan.PageOrigins"/>).
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
    /// <param name="lan">
    /// Set (what the host always launches): the hub listens on every interface under <c>GRC_LIVE_EXPOSE=lan</c> (token
    /// auth and the origin list are already there), with wss through the pair when one is given, beside plain ws for
    /// the host's http pages. The caller has put the LAN page origins into <paramref name="allowedOrigins"/>. Null: the
    /// hub listens on loopback only.
    /// </param>
    internal static IReadOnlyDictionary<string, string> Environment(
        Config config, int hubPort, string evidenceDirectory, IReadOnlyList<string> allowedOrigins,
        LanLaunch? lan = null)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(allowedOrigins);
        var hub = $"{(lan is null ? "127.0.0.1" : "0.0.0.0")}:{hubPort.ToString(CultureInfo.InvariantCulture)}";
        var environment = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [StreamingSeatRole.EnvironmentVariable] = "1",
            [RenderCaptureExtensionLoader.EnvironmentVariable] = config.Extension,
            ["GRC_MODE"] = "standby",
            ["GRC_HEADLESS_TEXTURE_RELEASE"] = "always",
            [MaxPresentationWidthEnvironmentVariable] = config.MaxPresentationWidth.ToString(CultureInfo.InvariantCulture),
            ["GRC_CALIBRATION"] = config.Calibration,
            ["GRC_LIVE_LISTEN"] = hub,
            // The carriers the hub serves (see the remarks): WebSocket always, WebTransport with the net module.
            ["GRC_LIVE_CARRIERS"] = config.NetModule is null ? "ws" : "ws,wt",
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
            // Each arm may override this base presentation with the requesting page's aspect.
            ["GRC_ROOT_SIZE"] = RootSize(PresentationBaseWidth),
            // The game has ~2,400 live items; C3's raised caps.
            ["GRC_MIRROR_MAX_ITEMS"] = "32768",
            ["GRC_MIRROR_MAX_COMMANDS"] = "16384",
            ["GRC_RESOURCE_MAX_PAYLOAD_BYTES"] = "268435456",
            ["GRC_RESOURCE_BUDGET_BYTES"] = "8589934592",
            // /12's formats: the half-float card glow and the particle curve textures.
            ["GRC_RESOURCE_FORMATS"] = "L8,LA8,R8,RG8,RGB8,RGBA8,RGBAH,RF,RGF,RGBF,RGBAF",
            // Every mesh surface rides the socket instead of a GET (skeletal animation).
            ["GRC_RESOURCE_INLINE_MAX_BYTES"] = "4096",
            ["GRC_PERF_TIMELINE_MAX_BYTES"] = PerfTimelineMaxBytes,
            ["GRC_MESH_DYNAMIC"] = "auto",
            // Grant the extension modules their identities, live filters and couch role groups. The capture resolves nothing until a
            // viewer's page actually asks (an extension's `wants`), so a pure viewer pays the same as before.
            ["GRC_ITEM_META"] = "scene,path,script,groups,instance_id,mouse_filter",
        };
        if (config.NetModule is { } netModule)
        {
            environment["GRC_LIVE_NET_MODULE"] = netModule;
            // UDP, the same number as the WebSocket port (TCP and UDP port spaces are separate): one port per seat.
            environment["GRC_LIVE_WT_LISTEN"] = hub;
            environment["GRC_LIVE_WT_CERT"] = "self";
        }

        if (lan is not null)
        {
            // godot-scene-web's opt-in LAN exposure (carrier-design.md D10): with token auth and a non-empty origin
            // list, both of which every streaming seat already has.
            environment["GRC_LIVE_EXPOSE"] = "lan";
            if (lan.TlsCertificate is { } certificate && lan.TlsKey is { } key)
            {
                environment["GRC_LIVE_TLS_CERT"] = certificate;
                environment["GRC_LIVE_TLS_KEY"] = key;
                // The host's plain-http LAN pages stream over plain ws, as their own socket to the host already is;
                // without this the capture refuses LAN plaintext once it has a certificate (tls-required).
                environment[Protocol.StreamingSeatDescriptor.LanPlaintextEnvironmentVariable] = "allow";
            }
        }

        return environment;
    }

    /// <summary>The capture's <c>GRC_ROOT_SIZE</c> value for a seat <paramref name="presentationWidth"/> wide.</summary>
    internal static string RootSize(int presentationWidth)
        => $"presentation:{presentationWidth.ToString(CultureInfo.InvariantCulture)}x{PresentationHeight.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>
    /// Drop everything streaming-related a seat could inherit from its host: the role, the capture variables this
    /// file reads and every <c>GRC_*</c>. Every seat launch calls it; configured capture seats then get
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
                    or ExtraOriginsEnvironmentVariable or MaxPresentationWidthEnvironmentVariable)
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
