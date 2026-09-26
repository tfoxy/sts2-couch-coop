using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Reflection;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using Spirectl.Sts2.Core.Actions;
using Spirectl.Sts2;
using Spirectl.Sts2.Embedding;

/// <summary>
/// The Couch embedder deliberately consumes the reduced shared runtime, not BridgeMod. Keep this at the
/// consuming boundary so a new bridge aggregate cannot accidentally become a Couch dependency again.
/// </summary>
internal static class SpirectlEmbeddedAssemblyBoundaryTests
{
    /// <summary>Runs this suite alone: <c>dotnet run --project tests/CouchCoop.Mod.Tests -- embedded-boundary</c>.</summary>
    public const string Verb = "embedded-boundary";

    private static readonly string[] RetainedTypes =
    [
        "Spirectl.Sts2.Sts2EmbeddableRuntimeFactory",
        "Spirectl.Sts2.SpirectlSts2Runtime",
        "Spirectl.Sts2.Embedding.ISpirectlRuntime",
        "Spirectl.Sts2.Embedding.IRuntimeCapabilitySource",
        "Spirectl.Sts2.Embedding.IRuntimeAssetSource",
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
        // The read-only active-screen seam. CouchCoopQrHostPanelController subscribes to its Updated event
        // instead of polling, and gates the lobby state pull on IsCurrent — so losing it from the embedded
        // runtime would silently return the mod to a 0.25s tick that never parks.
        "Spirectl.Sts2.Live.Sts2ScreenContext",
        // What the embedded profile keeps standing in for what it leaves out: the composition entry point, the
        // action handler with its embedded dispatcher, and the placeholder and port types that the reference-data
        // slot holds. ISpirectlRuntime inherits the reference port, so its
        // DTOs must stay even though the provider behind them does not. (The extractor slot is gone altogether:
        // nothing in this mod names IGameStateExtractor or a GameStateSnapshot.)
        "Spirectl.Sts2.Live.Sts2RuntimeFactory",
        "Spirectl.Sts2.Live.Sts2ActionHandler",
        "Spirectl.Sts2.Live.GameApi.Sts2GameApiProbe",
        "Spirectl.Sts2.Core.Actions.SemanticActionKind",
        "Spirectl.Sts2.Core.Reference.IReferenceDataProvider",
        "Spirectl.Sts2.Core.Reference.PlaceholderReferenceDataProvider",
        "Spirectl.Sts2.Sts2HostLocalSeatRegistry",
    ];

    /// <summary>
    /// Types spirectl's embedded compile profile (<c>Sts2Profile=Embedded</c>) does not compile, because nothing
    /// this mod can reach calls them. The full profile, which the bridge and the CLI build, still has them, so a
    /// name here reappearing means the project reference lost the profile or the profile lost a file.
    /// </summary>
    private static readonly string[] EmbeddedProfileExcludedTypes =
    [
        "Spirectl.Sts2.Embedding.ICombatEventSource",
        "Spirectl.Sts2.Embedding.CombatEventSubscriptionRequest",
        "Spirectl.Sts2.Embedding.CombatWatchEvent",
        "Spirectl.Sts2.Live.Sts2StateProvider",
        // The legacy state-extractor lane and everything only it called.
        "Spirectl.Sts2.Core.State.ObservedGameStateExtractor",
        "Spirectl.Sts2.Core.State.RuntimeStateMapper",
        "Spirectl.Sts2.Core.State.ScaffoldRuntimeObservationProvider",
        "Spirectl.Sts2.Core.State.IRuntimeObservationProvider",
        "Spirectl.Sts2.Core.State.BridgeRuntimeObservation",
        "Spirectl.Sts2.Live.Sts2RuntimeObservationProvider",
        "Spirectl.Sts2.Live.Sts2LobbyPresentationGeometryResolver",
        "Spirectl.Sts2.Live.Sts2PresentationStateResolver",
        "Spirectl.Sts2.Live.Sts2CardOverlayInspector",
        "Spirectl.Sts2.Sts2UnsupportedScreenNotice",
        "Spirectl.Sts2.Core.Models.RandomCharacterFacts",
        "Spirectl.Sts2.Core.State.StateResourceReferenceCollector",
        // The state-extractor port, its placeholder and scaffold, and the snapshot types only that port carried
        // (the rest of GameStateSnapshot.cs is what the live StateSnapshot uses, and stays).
        "Spirectl.Sts2.Core.State.IGameStateExtractor",
        "Spirectl.Sts2.Core.State.PlaceholderStateExtractor",
        "Spirectl.Sts2.Core.State.PresentationScaffoldState",
        "Spirectl.Sts2.Core.State.PresentationScaffoldSnapshot",
        "Spirectl.Sts2.Core.State.MultiplayerPresentationScaffoldSnapshot",
        "Spirectl.Sts2.Core.State.AvailableActionSnapshot",
        "Spirectl.Sts2.Core.State.BundleSelectionStateSnapshot",
        "Spirectl.Sts2.Core.State.CardOverlayStateSnapshot",
        "Spirectl.Sts2.Core.State.CardSelectionStateSnapshot",
        "Spirectl.Sts2.Core.State.CombatPlayerStateSnapshot",
        "Spirectl.Sts2.Core.State.CombatStateSnapshot",
        "Spirectl.Sts2.Core.State.DebugStateSnapshot",
        "Spirectl.Sts2.Core.State.DeckCardSelectionStateSnapshot",
        "Spirectl.Sts2.Core.State.EncounterVisualPartStateSnapshot",
        "Spirectl.Sts2.Core.State.EncounterVisualsStateSnapshot",
        "Spirectl.Sts2.Core.State.EncounterVisualTransitionEventSnapshot",
        "Spirectl.Sts2.Core.State.EnemyIntentSnapshot",
        "Spirectl.Sts2.Core.State.EnemyStateSnapshot",
        "Spirectl.Sts2.Core.State.EnemyVisualMetadataSnapshot",
        "Spirectl.Sts2.Core.State.EventRoomStateSnapshot",
        "Spirectl.Sts2.Core.State.GameStateQuery",
        "Spirectl.Sts2.Core.State.GameStateSnapshot",
        "Spirectl.Sts2.Core.State.MapStateSnapshot",
        "Spirectl.Sts2.Core.State.MenuStateSnapshot",
        "Spirectl.Sts2.Core.State.MultiplayerLobbyStateSnapshot",
        "Spirectl.Sts2.Core.State.OverlayAffordanceSnapshot",
        "Spirectl.Sts2.Core.State.OverlayBreadcrumbSnapshot",
        "Spirectl.Sts2.Core.State.RelicSelectionStateSnapshot",
        "Spirectl.Sts2.Core.State.RestSiteStateSnapshot",
        "Spirectl.Sts2.Core.State.RewardsStateSnapshot",
        "Spirectl.Sts2.Core.State.ShopStateSnapshot",
        "Spirectl.Sts2.Core.State.SimpleCardSelectionStateSnapshot",
        "Spirectl.Sts2.Core.State.TreasureRoomStateSnapshot",
        "Spirectl.Sts2.Core.State.VisibleControlStateSnapshot",
        "Spirectl.Sts2.Core.State.VisibleItemStateSnapshot",
        // The full composition (the embedded factory builds its own) and the reference-data implementation.
        "Spirectl.Sts2.Live.Sts2ReusableLiveComposition",
        "Spirectl.Sts2.Live.Sts2ReusableLiveCompositionFactory",
        "Spirectl.Sts2.Live.Sts2ReferenceDataProvider",
        // Synthetic host-local seats and the VFX-spawn hook.
        "Spirectl.Sts2.Live.Sts2HostLocalSeatSyncWatcher",
        "Spirectl.Sts2.Live.Sts2HostLocalSeatTurnWatcher",
        "Spirectl.Sts2.Live.Sts2VfxSpawnEventHooks",
        // Left with no caller once the action bodies are gone.
        "Spirectl.Sts2.Live.Sts2MainMenuStartRunHooks",
        "Spirectl.Sts2.Live.Sts2CrystalSphereScreenInspector",
        "Spirectl.Sts2.Sts2LobbyCharacterButtonInvoker",
        "Spirectl.Sts2.Sts2PartialChoiceNotice",
        "Spirectl.Sts2.Core.Map.Sts2MapDrawingTransform",
        "Spirectl.Sts2.Live.EncounterVisuals.Sts2EncounterVisualEventStore",
        "Spirectl.Sts2.Live.EncounterVisuals.Sts2KaiserCrabVisualHooks",
        // Nested types that moved out with the action bodies no embedded dispatch arm reaches.
        "Spirectl.Sts2.Live.Sts2ActionHandler+CombatActionContext",
        "Spirectl.Sts2.Live.Sts2ActionHandler+ShopActionContext",
        "Spirectl.Sts2.Live.Sts2ActionHandler+ResolvedCombatCard",
        "Spirectl.Sts2.Live.Sts2ActionHandler+LobbySeatOwnership",
    ];

    /// <summary>
    /// The state-side action catalog keeps two members (the main-menu choice id and the map-node gate); its
    /// AvailableAction builders belong to the full profile, because only the legacy lane called them.
    /// </summary>
    private static readonly string[] OmittedActionCatalogMethods = ["MainMenuActions", "CombatActions", "LobbyActions", "RewardActions"];

    /// <summary>
    /// The semantic action kinds this mod sends, by the private method that carries each out. Read from the
    /// mod's own source: <c>grep -rn SemanticActionKind src</c>. The embedded dispatcher routes exactly these,
    /// and nothing else's body is compiled into the assembly.
    /// </summary>
    private static readonly string[] EmbeddedActionMethods =
    [
        "ExecuteHoverElement", "ExecuteMouseClick", "ExecuteKeyInput", "ExecuteControllerInput",
        "ExecuteSelectMapNode", "ExecuteSetScrollOffset",
        "ExecuteDisconnectClient", "ExecuteSetClientName",
    ];

    private static readonly string[] OmittedActionMethods =
    [
        "ExecutePlayCard", "ExecuteEndTurn", "ExecuteChoose", "ExecuteSelectCard", "ExecuteBuyCard",
        "ExecuteViewDrawPile", "ExecuteSelectHandCard", "ExecuteInspectRelic", "ExecuteToggleDeck",
        "ExecuteJoinLobbyPlayer", "ExecuteLeaveLobbyPlayer", "ExecuteClaimReward",
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
        var profile = shared.GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(attribute => attribute.Key == "SpirectlSts2Profile")?.Value;
        Expect(profile == "Embedded", $"Couch's private copy is spirectl's embedded compile profile (got '{profile}'): the project reference must pass Sts2Profile=Embedded");
        Expect(Path.GetFileName(shared.Location) == "CouchCoop.Spirectl.dll", "loaded shared runtime artifact keeps the Couch filename");

        foreach (var typeName in RetainedTypes)
        {
            Expect(allTypeNames.Contains(typeName), $"Couch-required shared type remains available: {typeName}");
        }

        foreach (var typeName in EmbeddedProfileExcludedTypes)
        {
            Expect(!allTypeNames.Contains(typeName), $"the embedded profile leaves out a lane Couch cannot reach: {typeName}");
        }

        var handler = shared.GetType("Spirectl.Sts2.Live.Sts2ActionHandler")
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: the embedded action handler is missing");
        const BindingFlags declared = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        foreach (var method in EmbeddedActionMethods)
        {
            Expect(handler.GetMethod(method, declared) is not null, $"the embedded dispatcher still carries an action Couch sends: {method}");
        }

        foreach (var method in OmittedActionMethods)
        {
            Expect(handler.GetMethod(method, declared) is null, $"the embedded action handler does not compile a body Couch never asks for: {method}");
        }

        var stateCatalog = shared.GetType("Spirectl.Sts2.Sts2ActionCatalog")
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: Sts2ActionCatalog is missing");
        Expect(stateCatalog.GetMethod("CanSelectMapNode", BindingFlags.Public | BindingFlags.Static) is not null,
            "the state-side action catalog keeps the map-node gate a live arm reads");
        foreach (var method in OmittedActionCatalogMethods)
        {
            Expect(stateCatalog.GetMethod(method, BindingFlags.Public | BindingFlags.Static) is null,
                $"the state-side action catalog does not compile a builder only the legacy lane called: {method}");
        }

        var services = shared.GetType("Spirectl.Sts2.Embedding.SpirectlRuntimeServices")
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: SpirectlRuntimeServices is missing");
        Expect(services.GetProperty("StateExtractor", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is null,
            "the embedded runtime services have no state-extractor slot");

        PinAdvertisedActionsToTheDispatcher(shared, handler);

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
        Expect(fromFactory?.ReturnType == typeof(CouchCoopRuntimeDependencies), "Couch keeps its typed runtime FromFactory adapter");

        AssertNoFullStateReferences(typeof(CouchCoopRuntimeDependencies).Assembly.Location);
        AssertNoFullStateReferences(Path.Combine(AppContext.BaseDirectory, "CouchCoop.Mod.HotReload.dll"));

        PinLiveHostReasonWording();

        Console.WriteLine("SpirectlEmbeddedAssemblyBoundaryTests: ok");
    }

    private static readonly HashSet<string> FullStateMethods =
    ["GetCurrentState", "SubscribeCurrentState", "WatchCurrentStateAsync"];

    private static void AssertNoFullStateReferences(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        foreach (var handle in metadata.TypeReferences)
        {
            var reference = metadata.GetTypeReference(handle);
            var name = metadata.GetString(reference.Name);
            var ns = metadata.GetString(reference.Namespace);
            var fullName = $"{ns}.{name}";
            Expect(fullName != "Spirectl.Sts2.Embedding.IRuntimeStateSource"
                   && !(ns == "Spirectl.Sts2.Core.State" &&
                        (name.Contains("StateSnapshot", StringComparison.Ordinal) ||
                         name.StartsWith("CurrentState", StringComparison.Ordinal))),
                $"{Path.GetFileName(assemblyPath)} must not reference the full-state path: {fullName}");
        }
        foreach (var handle in metadata.MemberReferences)
        {
            var member = metadata.GetMemberReference(handle);
            var name = metadata.GetString(member.Name);
            Expect(!FullStateMethods.Contains(name),
                $"{Path.GetFileName(assemblyPath)} must not call the full-state path: {name}");
        }
        foreach (var handle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(handle);
            var name = metadata.GetString(method.Name);
            Expect(!FullStateMethods.Contains(name),
                $"{Path.GetFileName(assemblyPath)} must not declare a full-state adapter: {name}");
        }
    }

    /// <summary>
    /// The capabilities' <c>SupportedActions</c> is the dispatcher's own route table: the runtime advertises exactly
    /// the kinds it carries out, and those are the kinds this mod sends (<see cref="EmbeddedActionMethods"/>).
    /// </summary>
    /// <remarks>
    /// The catalog reaches the browser as <c>capabilities.supportedActions</c> in every <c>session</c> envelope;
    /// nothing in this repo reads it. What this pins is that an advertised kind is never one the dispatcher
    /// answers InvalidAction for, and the reverse.
    /// </remarks>
    private static void PinAdvertisedActionsToTheDispatcher(Assembly shared, Type handler)
    {
        const BindingFlags any = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        var catalog = shared.GetType("Spirectl.Sts2.Sts2ActionDescriptorCatalog")
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: the embedded action-descriptor catalog is missing");
        var advertised = (IReadOnlyList<Spirectl.Sts2.Core.Actions.ActionDescriptorSnapshot>)(catalog
            .GetMethod("Build", any)?.Invoke(null, [true, false])
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: the action-descriptor catalog has no Build"));
        var routed = (IReadOnlyList<Spirectl.Sts2.Core.Actions.ActionDescriptorSnapshot>)(handler
            .GetProperty("RoutedActionDescriptors", any)?.GetValue(null)
            ?? throw new InvalidOperationException("SpirectlEmbeddedAssemblyBoundaryTests: the dispatcher has no route table"));

        var kinds = advertised.Select(descriptor => descriptor.Kind.ToString()).Order(StringComparer.Ordinal).ToArray();
        Expect(!kinds.Contains(nameof(SemanticActionKind.ClaimReward), StringComparer.Ordinal),
            "the embedded runtime does not advertise the retired reward action");
        var sent = EmbeddedActionMethods.Select(method => method["Execute".Length..]).Order(StringComparer.Ordinal).ToArray();
        Expect(kinds.SequenceEqual(sent),
            $"the embedded runtime advertises exactly the action kinds its dispatcher routes (advertised: {string.Join(", ", kinds)}; routed: {string.Join(", ", sent)})");
        Expect(advertised.SequenceEqual(routed), "the advertised descriptors are the dispatcher's own route table");
        Expect(advertised.All(descriptor => !string.IsNullOrWhiteSpace(descriptor.Id) && !string.IsNullOrWhiteSpace(descriptor.Summary)),
            "every advertised action kind carries an id and a summary");
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
