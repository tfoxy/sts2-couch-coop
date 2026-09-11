using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Serialization;
using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.Loader;

public static class CouchCoopHotReloadProtocol
{
    private const string ProtocolId = "spirectl.m57.hot-reload-shell";
    private const int ProtocolVersion = 0;
    private const int ContractVersion = 1;
    private const string ShellModId = "couchcoop";
    private const string ImplementationAssemblyName = "CouchCoop.Mod";
    private const string ImplementationTypeName = "CouchCoop.Mod.CouchCoopMod";
    private const string LogicAssemblyName = "CouchCoop.Mod.HotReload";
    private const string LogicTypeName = "CouchCoop.Mod.HotReload.CouchCoopHotLogic";
    private const string LayoutMethodName = "DescribeOverlayLayoutJson";
    private const string CreateGenerationMethodName = "CreateGeneration";

    // MUST stay declared above _overlayLayoutJson. Static field initializers run in textual order, and
    // this is a static property whose backing field is one of them: with the declaration further down,
    // DefaultOverlayLayoutJson below serialised against a NULL options object and silently fell back to
    // PascalCase, so the shell's copy of the layout was a different document from every other producer's.
    private static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) }
    };

    private static readonly object Gate = new();
    private static string? _modDirectory;
    private static string _overlayLayoutJson = DefaultOverlayLayoutJson;
    private static int _activeGeneration;
    private static bool _reloadInProgress;
    private static HotReloadReport? _lastReloadReport;
    private static AssemblyLoadContext? _activeLoadContext;

    // ONE OF FOUR COPIES of the overlay layout contract — must stay in sync with
    // HostLobbyQrOverlayLayout.Default, CouchCoopHotLogic.DescribeOverlayLayoutJson() and
    // ValidateOverlayLayout below. This shell copy is what the lobby UI runs on until a hot-reload
    // generation activates. CouchCoopQrLayoutContractTests fails the moment any copy drifts.
    private static string DefaultOverlayLayoutJson => JsonSerializer.Serialize(new CouchCoopOverlayLayout(
        Left: 226f,
        Top: 732f,
        Right: 578f,
        Bottom: 868f,
        QrDialogExtent: 592f,
        QuietZoneModules: 0,
        TitleFontScale: 1.75f,
        UrlFontScale: 1.375f,
        ButtonFontScale: 1.75f,
        PanelPadding: 24f,
        PanelCornerRadius: 16f,
        PanelBorderWidth: 3f,
        PanelColor: "#0e1117f7",
        PanelBorderColor: "#ffffff33"),
        // Explicitly the Web options, matching CouchCoopHotLogic. Without them this copy serialised in
        // PascalCase while every other producer emitted camelCase; it went unnoticed because both
        // consumers deserialise case-insensitively, but it meant the shell's "default" and a reloaded
        // layout were not the same document, and anything comparing them as text disagreed.
        JsonOptions);

    public static void Initialize(string modDirectory)
    {
        lock (Gate)
        {
            _modDirectory = modDirectory;
            var initialLogicPath = ExpectedLogicArtifactPathUnsafe();
            if (File.Exists(initialLogicPath))
            {
                _ = ReloadCore(new HotReloadRequest(
                    RequestId: "initial-load",
                    ProjectId: ShellModId,
                    ShellModId: ShellModId,
                    LogicArtifactPath: initialLogicPath,
                    ExpectedContractVersion: ContractVersion,
                    WaitForCompletion: true,
                    TimeoutMs: 5000));
            }
        }
    }

    public static string GetOverlayLayoutJson()
    {
        lock (Gate)
        {
            return _overlayLayoutJson;
        }
    }

    public static string DescribeSpirectlHotReloadStatusJson()
    {
        lock (Gate)
        {
            return JsonSerializer.Serialize(CurrentStatusUnsafe(), JsonOptions);
        }
    }

    public static Task<string> RequestSpirectlHotReloadJsonAsync(string requestJson)
    {
        HotReloadRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<HotReloadRequest>(requestJson, JsonOptions);
        }
        catch (Exception exception)
        {
            var report = HotReloadReport.Failed(
                sourceAssemblyPath: string.Empty,
                shadowAssemblyPath: string.Empty,
                previousGeneration: CurrentActiveGeneration(),
                code: "hot-reload-request-invalid",
                phase: "request",
                message: exception.Message,
                restartRequired: false,
                exception);
            return Task.FromResult(JsonSerializer.Serialize(
                HotReloadResponse.Rejected(CurrentStatus(), report, "hot-reload-request-invalid", exception.Message),
                JsonOptions));
        }

        if (request is null)
        {
            var report = HotReloadReport.Failed(
                sourceAssemblyPath: string.Empty,
                shadowAssemblyPath: string.Empty,
                previousGeneration: CurrentActiveGeneration(),
                code: "hot-reload-request-invalid",
                phase: "request",
                message: "Hot-reload request was empty.",
                restartRequired: false);
            return Task.FromResult(JsonSerializer.Serialize(
                HotReloadResponse.Rejected(CurrentStatus(), report, "hot-reload-request-invalid", "Hot-reload request was empty."),
                JsonOptions));
        }

        HotReloadResponse response;
        lock (Gate)
        {
            response = ReloadCore(request);
        }

        return Task.FromResult(JsonSerializer.Serialize(response, JsonOptions));
    }

    private static HotReloadResponse ReloadCore(HotReloadRequest request)
    {
        if (_reloadInProgress)
        {
            var busyReport = HotReloadReport.Failed(
                request.LogicArtifactPath,
                shadowAssemblyPath: string.Empty,
                previousGeneration: _activeGeneration,
                code: "reload_busy",
                phase: "load",
                message: "A reload is already running.",
                restartRequired: false);
            _lastReloadReport = busyReport;
            return new HotReloadResponse(false, CurrentStatusUnsafe(), busyReport, []);
        }

        _reloadInProgress = true;
        try
        {
            var started = DateTimeOffset.UtcNow;
            if (!string.Equals(request.ShellModId, ShellModId, StringComparison.Ordinal))
            {
                return Failure(request, string.Empty, "reload_shell_mismatch", "contract", "The hot-reload request targeted a different shell.", false);
            }

            if (request.ExpectedContractVersion != ContractVersion)
            {
                return Failure(request, string.Empty, "reload_contract_version_mismatch", "contract", $"Expected contract version {request.ExpectedContractVersion}, but CouchCoop supports {ContractVersion}.", true);
            }

            if (!File.Exists(request.LogicArtifactPath))
            {
                return Failure(request, string.Empty, "reload_source_missing", "source", $"Reload source assembly does not exist: {request.LogicArtifactPath}", false);
            }

            var generation = _activeGeneration + 1;
            var shadowAssemblyPath = ShadowCopy(request.LogicArtifactPath, generation);
            var loadContext = new AssemblyLoadContext($"{LogicAssemblyName}:{generation}", isCollectible: true);
            ICouchCoopHotGeneration? newGeneration = null;
            try
            {
                loadContext.Resolving += (_, assemblyName) => ResolveSharedAssembly(assemblyName, shadowAssemblyPath);
                var assembly = loadContext.LoadFromAssemblyPath(shadowAssemblyPath);
                var type = assembly.GetType(LogicTypeName, throwOnError: false);
                if (type is null)
                {
                    loadContext.Unload();
                    return Failure(request, shadowAssemblyPath, "reload_entry_type_missing", "entry_type", $"Reloadable logic type was not found: {LogicTypeName}", false);
                }

                var method = type.GetMethod(LayoutMethodName, BindingFlags.Public | BindingFlags.Static);
                if (method is null || method.ReturnType != typeof(string))
                {
                    loadContext.Unload();
                    return Failure(request, shadowAssemblyPath, "reload_contract_missing", "contract", $"Reloadable logic must expose public static string {LayoutMethodName}().", false);
                }

                var createMethod = type.GetMethod(CreateGenerationMethodName, BindingFlags.Public | BindingFlags.Static);
                if (createMethod is null || createMethod.ReturnType != typeof(ICouchCoopHotGeneration))
                {
                    loadContext.Unload();
                    return Failure(request, shadowAssemblyPath, "reload_contract_missing", "contract", $"Reloadable logic must expose public static ICouchCoopHotGeneration {CreateGenerationMethodName}(IHotServerHost, HotReloadActivationContext).", false);
                }

                var layoutJson = method.Invoke(null, null) as string;
                if (string.IsNullOrWhiteSpace(layoutJson))
                {
                    loadContext.Unload();
                    return Failure(request, shadowAssemblyPath, "reload_contract_missing", "contract", "Reloadable logic returned an empty overlay layout.", false);
                }

                var layoutValidation = ValidateOverlayLayout(layoutJson);
                if (layoutValidation is not null)
                {
                    loadContext.Unload();
                    return Failure(request, shadowAssemblyPath, "reload_layout_invalid", "contract", layoutValidation, false);
                }

                var serverHost = TryGetHotServerHost();
                if (serverHost is not null)
                {
                    newGeneration = createMethod.Invoke(null, [serverHost, new HotReloadActivationContext(generation, _modDirectory ?? AppContext.BaseDirectory, shadowAssemblyPath)]) as ICouchCoopHotGeneration;
                    if (newGeneration is null)
                    {
                        loadContext.Unload();
                        return Failure(request, shadowAssemblyPath, "reload_activation_failed", "activate", "Reloadable logic did not create a server generation.", false);
                    }

                    ActivateHotReloadGeneration(newGeneration, generation);
                    newGeneration = null;
                }

                var previousLoadContext = _activeLoadContext;
                _activeLoadContext = serverHost is null ? null : loadContext;
                _overlayLayoutJson = layoutJson;
                _activeGeneration = generation;
                var report = HotReloadReport.Loaded(
                    generation,
                    started,
                    request.LogicArtifactPath,
                    shadowAssemblyPath,
                    LogicAssemblyName,
                    LogicTypeName,
                    generation - 1,
                    ContractVersion);
                _lastReloadReport = report;
                RefreshOverlayLayout();
                if (serverHost is null)
                {
                    loadContext.Unload();
                }

                previousLoadContext?.Unload();
                return new HotReloadResponse(true, CurrentStatusUnsafe(), report, []);
            }
            catch (Exception exception)
            {
                try
                {
                    if (newGeneration is not null)
                    {
                        newGeneration.DisposeAsync().AsTask().GetAwaiter().GetResult();
                    }
                }
                catch
                {
                }

                loadContext.Unload();
                return Failure(request, shadowAssemblyPath, "reload_activation_failed", "load", exception.Message, false, exception);
            }
        }
        finally
        {
            _reloadInProgress = false;
        }
    }

    private static HotReloadResponse Failure(
        HotReloadRequest request,
        string shadowAssemblyPath,
        string code,
        string phase,
        string message,
        bool restartRequired,
        Exception? exception = null)
    {
        var report = HotReloadReport.Failed(
            request.LogicArtifactPath,
            shadowAssemblyPath,
            _activeGeneration,
            code,
            phase,
            message,
            restartRequired,
            exception);
        _lastReloadReport = report;
        return new HotReloadResponse(false, CurrentStatusUnsafe(), report, []);
    }

    private static string ShadowCopy(string sourceAssemblyPath, int generation)
    {
        var shadowDirectory = Path.Combine(ExpectedHotReloadDirectoryUnsafe(), ".shadow", $"generation-{generation}");
        Directory.CreateDirectory(shadowDirectory);
        var shadowAssemblyPath = Path.Combine(shadowDirectory, Path.GetFileName(sourceAssemblyPath));
        File.Copy(sourceAssemblyPath, shadowAssemblyPath, overwrite: true);

        foreach (var suffix in new[] { ".pdb", ".deps.json", ".runtimeconfig.json" })
        {
            var source = Path.ChangeExtension(sourceAssemblyPath, null) + suffix;
            if (File.Exists(source))
            {
                File.Copy(source, Path.ChangeExtension(shadowAssemblyPath, null) + suffix, overwrite: true);
            }
        }

        return shadowAssemblyPath;
    }

    /// <summary>
    /// Shell-side gate for an incoming overlay layout. Returns <see langword="null"/> when the layout
    /// is usable, otherwise a human-readable rejection reason. The caller rejects the whole reload on
    /// a non-null result, so a bad layout never half-applies over the active one.
    /// </summary>
    public static string? ValidateOverlayLayout(string layoutJson)
    {
        CouchCoopOverlayLayout? layout;
        try
        {
            layout = JsonSerializer.Deserialize<CouchCoopOverlayLayout>(layoutJson, JsonOptions);
        }
        catch (JsonException exception)
        {
            return $"Overlay layout JSON is invalid: {exception.Message}";
        }

        if (layout is null)
        {
            return "Overlay layout JSON was empty.";
        }

        foreach (var (name, value) in new[]
        {
            ("left", layout.Left),
            ("top", layout.Top),
            ("right", layout.Right),
            ("bottom", layout.Bottom),
            ("qrDialogExtent", layout.QrDialogExtent),
            ("titleFontScale", layout.TitleFontScale),
            ("urlFontScale", layout.UrlFontScale),
            ("buttonFontScale", layout.ButtonFontScale),
            ("panelPadding", layout.PanelPadding),
            ("panelCornerRadius", layout.PanelCornerRadius),
            ("panelBorderWidth", layout.PanelBorderWidth)
        })
        {
            if (!float.IsFinite(value))
            {
                return $"Overlay {name} must be a finite number.";
            }
        }

        if (layout.Left < 0f || layout.Top < 0f)
        {
            return "Overlay rect origin must be non-negative in design space.";
        }

        if (layout.Right > MaxOverlayCoordinate || layout.Bottom > MaxOverlayCoordinate)
        {
            return $"Overlay rect must stay within {MaxOverlayCoordinate} design units.";
        }

        if (layout.Right - layout.Left < MinOverlayExtent)
        {
            return $"Overlay rect width must be at least {MinOverlayExtent} design units (right must exceed left).";
        }

        if (layout.Bottom - layout.Top < MinOverlayExtent)
        {
            return $"Overlay rect height must be at least {MinOverlayExtent} design units (bottom must exceed top).";
        }

        if (layout.QrDialogExtent < MinQrDialogExtent)
        {
            return $"Overlay QR dialog extent must be at least {MinQrDialogExtent} design units (one version-1 code at 4px per module).";
        }

        if (layout.QuietZoneModules < 0 || layout.QuietZoneModules > MaxQuietZoneModules)
        {
            return $"Overlay QR quiet zone modules must be between 0 and {MaxQuietZoneModules}.";
        }

        if (layout.TitleFontScale <= 0f || layout.TitleFontScale > MaxFontScale)
        {
            return $"Overlay title font scale must be greater than 0 and at most {MaxFontScale}.";
        }

        if (layout.UrlFontScale <= 0f || layout.UrlFontScale > MaxFontScale)
        {
            return $"Overlay URL font scale must be greater than 0 and at most {MaxFontScale}.";
        }

        if (layout.ButtonFontScale <= 0f || layout.ButtonFontScale > MaxFontScale)
        {
            return $"Overlay button font scale must be greater than 0 and at most {MaxFontScale}.";
        }

        if (layout.PanelPadding < 0f || layout.PanelCornerRadius < 0f || layout.PanelBorderWidth < 0f)
        {
            return "Overlay panel padding, corner radius and border width must be non-negative.";
        }

        // The dialog card is a fixed 1000x940 and the padding is its content inset, so past this there
        // is no text column left and the URL fallback becomes unreadable.
        if (layout.PanelPadding > MaxPanelPadding)
        {
            return $"Overlay panel padding must be at most {MaxPanelPadding} design units (it insets a fixed-size dialog card).";
        }

        foreach (var (name, value) in new[]
        {
            ("panelColor", layout.PanelColor),
            ("panelBorderColor", layout.PanelBorderColor)
        })
        {
            if (value is not null && !IsHtmlColor(value))
            {
                return $"Overlay {name} must be an #rgb/#rgba/#rrggbb/#rrggbbaa colour string.";
            }
        }

        // The rect is now the BUTTON, so the fit question is "can its own label fit inside it" rather
        // than the old "is there room under the text band for a QR" (the QR moved to the dialog, whose
        // card is a fixed size). A layout that scales the label past the button height would render a
        // clipped caption on the only entry point to the join flow, so reject it outright.
        var buttonLineHeight = layout.ButtonFontScale * BaseFontSize * LineHeightFactor;
        var buttonHeight = layout.Bottom - layout.Top;
        if (buttonHeight - buttonLineHeight < 0f)
        {
            return $"Overlay button height {buttonHeight:0.#} cannot fit its own {buttonLineHeight:0.#} unit label line.";
        }

        return null;
    }

    /// <summary>
    /// Shell-side mirror of <c>Godot.Color.HtmlIsValid</c>. The stable shell must not bind to
    /// GodotSharp just to gate a layout, so the accepted forms are checked directly.
    /// </summary>
    private static bool IsHtmlColor(string value)
    {
        var span = value.AsSpan();
        if (span.Length > 0 && span[0] == '#')
        {
            span = span[1..];
        }

        if (span.Length is not (3 or 4 or 6 or 8))
        {
            return false;
        }

        foreach (var character in span)
        {
            if (!Uri.IsHexDigit(character))
            {
                return false;
            }
        }

        return true;
    }

    private static HotReloadStatus CurrentStatus()
    {
        lock (Gate)
        {
            return CurrentStatusUnsafe();
        }
    }

    private static int CurrentActiveGeneration()
    {
        lock (Gate)
        {
            return _activeGeneration;
        }
    }

    private static HotReloadStatus CurrentStatusUnsafe()
        => new(
            new HotReloadProtocolInfo(ProtocolId, ProtocolVersion),
            ShellModId,
            (uint)_activeGeneration,
            ExpectedLogicArtifactPathUnsafe(),
            ContractVersion,
            _reloadInProgress,
            _lastReloadReport,
            RestartRequired: _lastReloadReport?.Error?.RestartRequired ?? false);

    private static string ExpectedLogicArtifactPathUnsafe()
        => Path.Combine(ExpectedHotReloadDirectoryUnsafe(), $"{LogicAssemblyName}.dll");

    private static string ExpectedHotReloadDirectoryUnsafe()
        => Path.Combine(_modDirectory ?? AppContext.BaseDirectory, "hot-reload");

    private static void RefreshOverlayLayout()
    {
        var implementation = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(assembly => string.Equals(assembly.GetName().Name, ImplementationAssemblyName, StringComparison.Ordinal));
        var type = implementation?.GetType(ImplementationTypeName, throwOnError: false);
        // Name-matched by reflection across the shell/implementation boundary: this string and
        // CouchCoopMod.RefreshQrHostPanelLayout must be renamed together or a hot-reloaded layout will
        // be accepted and then silently never applied.
        var method = type?.GetMethod("RefreshQrHostPanelLayout", BindingFlags.Public | BindingFlags.Static);
        method?.Invoke(null, null);
    }

    private static IHotServerHost GetHotServerHost()
    {
        var type = ResolveImplementationType();
        var property = type.GetProperty("HotServerHost", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"{ImplementationTypeName}.HotServerHost was not found.");
        return property.GetValue(null) as IHotServerHost
            ?? throw new InvalidOperationException("The CouchCoop hot server host is not available.");
    }

    private static IHotServerHost? TryGetHotServerHost()
    {
        try
        {
            return GetHotServerHost();
        }
        catch
        {
            return null;
        }
    }

    private static void ActivateHotReloadGeneration(ICouchCoopHotGeneration generation, int generationNumber)
    {
        var type = ResolveImplementationType();
        var method = type.GetMethod("ActivateHotReloadGeneration", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException($"{ImplementationTypeName}.ActivateHotReloadGeneration was not found.");
        method.Invoke(null, [generation, generationNumber]);
    }

    private static Type ResolveImplementationType()
    {
        var implementation = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(assembly => string.Equals(assembly.GetName().Name, ImplementationAssemblyName, StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"Implementation assembly '{ImplementationAssemblyName}' is not loaded.");
        return implementation.GetType(ImplementationTypeName, throwOnError: true)
            ?? throw new InvalidOperationException($"Unable to resolve type '{ImplementationTypeName}'.");
    }

    private static Assembly? ResolveSharedAssembly(AssemblyName assemblyName, string shadowAssemblyPath)
    {
        var loadedAssembly = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(candidate => string.Equals(candidate.GetName().Name, assemblyName.Name, StringComparison.Ordinal));
        if (loadedAssembly is not null && !string.Equals(loadedAssembly.GetName().Name, LogicAssemblyName, StringComparison.Ordinal))
        {
            return loadedAssembly;
        }

        return null;
    }

    // Shell-side mirror of the hot-reloadable overlay contract. Kept as its own declaration (rather
    // than a reference to the reloaded logic's type) so the stable shell can validate an incoming
    // layout without binding to the collectible load context. Field meanings:
    //   left/top/right/bottom  absolute rect of the QR BUTTON in the 1920x1080 canvas_items design space
    //   qrDialogExtent         on-screen extent budget for the dialog's QR; the consumer displays the
    //                          largest whole multiple of the module grid that fits inside it
    //   quietZoneModules       EXTRA quiet zone added on top of QRCoder's own embedded 4-module
    //                          zone; 0 is correct and anything higher double-pads the code
    //   titleFontScale/urlFontScale/buttonFontScale  multipliers over Godot's default 16px theme font size
    //   panelPadding/panelCornerRadius/panelBorderWidth  DIALOG CARD geometry, design units
    //   panelColor/panelBorderColor  dialog card colours as #rrggbbaa HTML strings
    private sealed record CouchCoopOverlayLayout(
        float Left,
        float Top,
        float Right,
        float Bottom,
        float QrDialogExtent,
        int QuietZoneModules,
        float TitleFontScale,
        float UrlFontScale,
        float ButtonFontScale,
        float PanelPadding,
        float PanelCornerRadius,
        float PanelBorderWidth,
        string PanelColor,
        string PanelBorderColor);

    private const float MaxOverlayCoordinate = 8192f;
    private const float MinOverlayExtent = 1f;
    private const int MaxQuietZoneModules = 32;
    private const float MaxFontScale = 32f;
    private const float BaseFontSize = 16f;
    private const float LineHeightFactor = 1.4f;

    // A version-1 (21-module) QR at 4 source px per module. The consumer renders EVERY code at this
    // extent (the leftover becomes white quiet-zone padding, see QrRasterPlan), so this is the point
    // below which the modules themselves get too coarse to be worth rasterizing.
    private const float MinQrDialogExtent = 84f;

    // Half the narrower side of the dialog card the consumer draws (1000x940).
    private const float MaxPanelPadding = 400f;

    private sealed record HotReloadProtocolInfo(string Id, int Version);

    private sealed record HotReloadStatus(
        HotReloadProtocolInfo Protocol,
        string ShellModId,
        uint ActiveGeneration,
        string ExpectedLogicArtifactPath,
        int ContractVersion,
        bool ReloadInProgress,
        HotReloadReport? LastReloadReport,
        bool RestartRequired);

    private sealed record HotReloadRequest(
        string RequestId,
        string ProjectId,
        string ShellModId,
        string LogicArtifactPath,
        int ExpectedContractVersion,
        bool WaitForCompletion,
        int TimeoutMs);

    private sealed record HotReloadResponse(
        bool Accepted,
        HotReloadStatus Status,
        HotReloadReport? Report,
        IReadOnlyList<HotReloadNotice> Notices)
    {
        public static HotReloadResponse Rejected(HotReloadStatus status, HotReloadReport report, string code, string message)
            => new(false, status, report, [new HotReloadNotice(code, message)]);
    }

    private sealed record HotReloadNotice(string Code, string Message);

    private sealed record HotReloadReport(
        string Status,
        uint Generation,
        string RequestedAt,
        string SourceAssemblyPath,
        string ShadowAssemblyPath,
        uint ContractVersion,
        string LogicAssemblyName,
        string EntryType,
        uint PreviousGeneration,
        bool PreviousRemainsActive,
        bool PreviousDisposed,
        bool PreviousUnloadRequested,
        bool PreviousCollected,
        ulong DurationMs,
        HotReloadError? Error,
        IReadOnlyList<HotReloadWarning> Warnings)
    {
        public static HotReloadReport Loaded(
            int generation,
            DateTimeOffset started,
            string sourceAssemblyPath,
            string shadowAssemblyPath,
            string logicAssemblyName,
            string entryType,
            int previousGeneration,
            int contractVersion)
            => new(
                "loaded",
                (uint)generation,
                started.ToString("O"),
                sourceAssemblyPath,
                shadowAssemblyPath,
                (uint)contractVersion,
                logicAssemblyName,
                entryType,
                (uint)Math.Max(previousGeneration, 0),
                PreviousRemainsActive: false,
                PreviousDisposed: true,
                PreviousUnloadRequested: true,
                PreviousCollected: true,
                DurationMs: 0,
                Error: null,
                Warnings: []);

        public static HotReloadReport Failed(
            string sourceAssemblyPath,
            string shadowAssemblyPath,
            int previousGeneration,
            string code,
            string phase,
            string message,
            bool restartRequired,
            Exception? exception = null)
            => new(
                "failed",
                Generation: 0,
                DateTimeOffset.UtcNow.ToString("O"),
                sourceAssemblyPath,
                shadowAssemblyPath,
                ContractVersion: 1,
                LogicAssemblyName: string.Empty,
                EntryType: string.Empty,
                (uint)Math.Max(previousGeneration, 0),
                PreviousRemainsActive: true,
                PreviousDisposed: false,
                PreviousUnloadRequested: false,
                PreviousCollected: false,
                DurationMs: 0,
                new HotReloadError(code, phase, message, exception?.GetType().FullName ?? string.Empty, exception?.Message ?? string.Empty, restartRequired),
                Warnings: []);
    }

    private sealed record HotReloadError(
        string Code,
        string Phase,
        string Message,
        string ExceptionType,
        string ExceptionMessage,
        bool RestartRequired);

    private sealed record HotReloadWarning(string Code, string Phase, string Message);
}
