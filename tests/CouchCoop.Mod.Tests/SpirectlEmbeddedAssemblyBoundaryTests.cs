using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2;
using Spirectl.Sts2.Embedding;

/// <summary>
/// The Couch embedder deliberately consumes the reduced shared runtime, not BridgeMod. Keep this at the
/// consuming boundary so a new bridge aggregate cannot accidentally become a Couch dependency again.
/// </summary>
internal static class SpirectlEmbeddedAssemblyBoundaryTests
{
    private static readonly string[] RetainedTypes =
    [
        "Spirectl.Sts2.Sts2EmbeddableRuntimeFactory",
        "Spirectl.Sts2.SpirectlSts2Runtime",
        "Spirectl.Sts2.Embedding.ISpirectlRuntime",
        "Spirectl.Sts2.Embedding.IRuntimeCapabilitySource",
        "Spirectl.Sts2.Embedding.IRuntimeAssetSource",
        "Spirectl.Sts2.Embedding.IRuntimeStateSource",
        "Spirectl.Sts2.Embedding.ICombatEventSource",
        "Spirectl.Sts2.Embedding.IAnimationHintSource",
        "Spirectl.Sts2.Embedding.IRuntimeSceneDeltaSource",
        "Spirectl.Sts2.Embedding.IGameModelSource",
        "Spirectl.Sts2.Embedding.IGameReferenceSource",
        "Spirectl.Sts2.Embedding.ISpineCatalogSource",
        "Spirectl.Sts2.Embedding.ISemanticActionSource",
        "Spirectl.Sts2.Embedding.IRuntimeSceneWatchControls",
        "Spirectl.Sts2.Embedding.PresentationAssetBatchRequest",
        "Spirectl.Sts2.Core.Artifacts.ISpineGeoClipBaker",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneDelta",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneNodeDelta",
        "Spirectl.Sts2.Core.SceneInspection.SpirectlSceneStreamMeta",
        "Spirectl.Sts2.Live.Sts2MainThreadDispatcher",
        "Spirectl.Sts2.Live.Sts2SceneWatchRuntimeSettings",
        "Spirectl.Sts2.Live.Sts2RenderEncodeBudget",
        "Spirectl.Sts2.Live.Sts2RenderPhaseProfile",
        "Spirectl.Sts2.Live.Sts2ContentKey",
    ];

    private static readonly string[] RemovedTypeNames =
    [
        "Spirectl.Sts2.BridgeRuntime",
        "Spirectl.Sts2.BridgeRuntimeBootstrap",
        "Spirectl.Sts2.BridgeRuntimeMainThreadInvoker",
        "Spirectl.Sts2.BridgeRuntimeOptions",
        "Spirectl.Sts2.BridgeRuntimeServices",
        "Spirectl.Sts2.Core.Artifacts.IScreenshotProvider",
        "Spirectl.Sts2.Core.Artifacts.ScreenshotCaptureRequest",
        "Spirectl.Sts2.Core.Artifacts.ScreenshotCaptureResult",
        "Spirectl.Sts2.Core.Combat.ICombatPreviewProvider",
        "Spirectl.Sts2.Core.Combat.CombatPreviewRequestSnapshot",
        "Spirectl.Sts2.Core.Combat.CombatPreviewOperationResult",
        "Spirectl.Sts2.Core.Combat.CombatPreviewFailureSnapshot",
        "Spirectl.Sts2.Core.ConsoleCommands.IConsoleCommandExecutor",
        "Spirectl.Sts2.Core.Debugging.IDebugControl",
        "Spirectl.Sts2.Core.Fixtures.IFixtureLoader",
        "Spirectl.Sts2.Core.Fixtures.IRecordedFixtureProvider",
        "Spirectl.Sts2.Core.HotReload.IHotReloadControl",
        "Spirectl.Sts2.Core.Lifecycle.ILifecycleControl",
        "Spirectl.Sts2.Core.Map.IMapDrawingsProvider",
        "Spirectl.Sts2.Core.Map.MapDrawingsRequestSnapshot",
        "Spirectl.Sts2.Core.Map.MapDrawingsOperationResult",
        "Spirectl.Sts2.Core.Map.MapDrawingStrokeSnapshot",
        "Spirectl.Sts2.Core.Mods.IModInspector",
        "Spirectl.Sts2.Core.Restore.RestoreVerificationSnapshot",
        "Spirectl.Sts2.Core.Restore.MultiplayerRestoreResultSnapshot",
        "Spirectl.Sts2.Core.Scenarios.IScenarioProvider",
        "Spirectl.Sts2.Core.SceneInspection.IRuntimeSceneProvider",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneQuery",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneTreeResult",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneSetVisibleRequestSnapshot",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeSceneSetVisibleResult",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeTransitionStatusRequestSnapshot",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeTransitionStatusResult",
        "Spirectl.Sts2.Core.SceneInspection.RuntimeTransitionWorkClassifier",
        "Spirectl.Sts2.Core.Transport.IBridgeHost",
        "Spirectl.Sts2.Embedding.ProducerWalkProfileRequest",
        "Spirectl.Sts2.Embedding.ProducerWalkProfileResult",
        "Spirectl.Sts2.Embedding.ProducerWalkProfileReport",
        "Spirectl.Sts2.Live.Sts2AnimationHintDiagnostics",
        "Spirectl.Sts2.Live.Sts2PerfReportEnvelope",
        "Spirectl.Sts2.Live.Sts2ProducerWalkProfile",
        "Spirectl.Sts2.Live.Sts2RuntimeSceneProvider",
        "Spirectl.Sts2.Live.Sts2ScreenshotProvider",
        "Spirectl.Sts2.Live.Sts2SpineDebug",
        "Spirectl.Sts2.Live.Sts2SpineGeometryProbe",
        "Spirectl.Sts2.Live.Sts2SpineGeoClipBacktraceBench",
        "Spirectl.Sts2.Live.Sts2StateWatchProfile",
    ];

    private static readonly string[] RemovedNamespacePrefixes =
    [
        "Spirectl.Sts2.Core.ConsoleCommands.",
        "Spirectl.Sts2.Core.Debugging.",
        "Spirectl.Sts2.Core.Fixtures.",
        "Spirectl.Sts2.Core.HotReload.",
        "Spirectl.Sts2.Core.Lifecycle.",
        "Spirectl.Sts2.Core.Mods.",
        "Spirectl.Sts2.Core.Restore.",
        "Spirectl.Sts2.Core.Scenarios.",
        "Spirectl.Sts2.Core.Transport.",
    ];

    public static void Run()
    {
        var shared = typeof(ISpirectlRuntime).Assembly;
        var allTypeNames = shared.GetTypes()
            .Select(type => type.FullName ?? type.Name)
            .ToHashSet(StringComparer.Ordinal);

        Expect(shared.GetName().Name == "CouchCoop.Spirectl", "Couch loads the shared runtime under its private assembly identity");
        Expect(Path.GetFileName(shared.Location) == "CouchCoop.Spirectl.dll", "loaded shared runtime artifact keeps the Couch filename");

        foreach (var typeName in RetainedTypes)
        {
            Expect(allTypeNames.Contains(typeName), $"Couch-required shared type remains available: {typeName}");
        }

        foreach (var typeName in RemovedTypeNames)
        {
            Expect(!allTypeNames.Contains(typeName), $"bridge-only type no longer leaks into the embedded runtime: {typeName}");
        }

        foreach (var prefix in RemovedNamespacePrefixes)
        {
            Expect(!allTypeNames.Any(typeName => typeName.StartsWith(prefix, StringComparison.Ordinal)),
                $"bridge-only namespace no longer leaks into the embedded runtime: {prefix}");
        }

        var couchModReferences = typeof(CouchCoopRuntimeDependencies).Assembly.GetReferencedAssemblies()
            .Select(reference => reference.Name)
            .ToArray();
        Expect(couchModReferences.Contains("CouchCoop.Spirectl", StringComparer.Ordinal), "Couch mod references the private shared assembly identity");
        Expect(!couchModReferences.Contains("Spirectl.Sts2", StringComparer.Ordinal), "Couch mod does not reference the bridge's default shared identity");
        Expect(!couchModReferences.Any(name => name?.StartsWith("Spirectl.BridgeMod", StringComparison.Ordinal) == true),
            "Couch mod does not reference a bridge-only assembly");
        var factory = typeof(Sts2EmbeddableRuntimeFactory).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .SingleOrDefault(method => method.Name == "Create" && method.GetParameters() is [var capture] && capture.IsOptional);
        Expect(factory?.ReturnType == typeof(ISpirectlRuntime), "Couch keeps the focused embedded factory path");
        var fromFactory = typeof(CouchCoopRuntimeDependencies).GetMethod(
            "FromFactory",
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: [typeof(ISpirectlRuntime)],
            modifiers: null);
        Expect(fromFactory?.ReturnType == typeof(CouchCoopRuntimeDependencies), "Couch keeps its ten-port FromFactory adapter");

        PinLiveHostReasonWording();

        Console.WriteLine("SpirectlEmbeddedAssemblyBoundaryTests: ok");
    }

    /// <summary>
    /// The drift check for the `live-host-runtime` support checkpoint: every reason string spirectl publishes
    /// must still classify onto its bounded token.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THE PIN IS HERE AND NOT BESIDE THE CLASSIFIER. <c>LobbySupportCheckpoints.cs</c> and
    /// <c>LobbySupportCheckpointsTests.cs</c> are both source-linked into <c>CouchCoop.MacOs.Tests</c>, which
    /// carries NO project references at all on purpose — it is the game-free suite that runs on macOS CI with
    /// no STS2 install. Naming a <c>Spirectl.Sts2.*</c> constant in either file breaks that project's compile,
    /// so the classifier keeps private literals and the comparison against the real constants lives here, in a
    /// spirectl-aware suite. That is why the classifier's copies are not simply <c>= &lt;spirectl constant&gt;</c>.
    /// </para>
    /// <para>
    /// It asserts BEHAVIOUR, not storage: feeding spirectl's own constant through the classifier proves the
    /// wording still matches without needing the private literals to be visible. A re-worded constant upstream
    /// falls to <see cref="LiveHostRuntimeReason.Unknown"/> and fails here — which is the point, because the
    /// live failure it would otherwise cause is a macOS support log that says `reason=unknown` instead of
    /// naming the gate that refused.
    /// </para>
    /// </remarks>
    private static void PinLiveHostReasonWording()
    {
        (string Reason, LiveHostRuntimeReason Expected)[] published =
        [
            (LiveSts2HostUnsupportedReasons.OutsideGameProcess, LiveHostRuntimeReason.OutsideGameProcess),
            (LiveSts2HostUnsupportedReasons.NonLiveHostBuild, LiveHostRuntimeReason.NonLiveBuild),
            (LiveSts2HostUnsupportedReasons.NotALiveHostAdapter, LiveHostRuntimeReason.NotLiveAdapter),
        ];

        foreach (var (reason, expected) in published)
        {
            Expect(
                LobbySupportCheckpoints.ClassifyLiveHostReason(reason) == expected,
                $"spirectl's published live-host reason still classifies as {expected} (got "
                + $"{LobbySupportCheckpoints.ClassifyLiveHostReason(reason)}); spirectl re-worded it, so "
                + "LobbySupportCheckpoints' private copy must be updated to match");
        }
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SpirectlEmbeddedAssemblyBoundaryTests: {message}");
        }
    }
}
