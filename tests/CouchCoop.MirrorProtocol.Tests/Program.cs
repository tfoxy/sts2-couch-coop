using CouchCoop.MirrorProtocol.Tests;

// Custom Exe test runner (assert-or-throw), matching tests/CouchCoop.Mod.Tests. Any failing suite throws and the
// process exits non-zero; a clean run prints a machine-readable success line last.
AffineTests.Run();
AudioWireTests.Run();
WireDefaultsTests.Run();
RoundTripFixtureTests.Run();
StaticFieldsTests.Run();
OrderPatchTests.Run();
CardFlightTests.Run(); // Declarative discard→draw shuffle card-flight wire contract (strict reader + one-shot applier valve)
EnvelopeTests.Run();
NewFixtureReaderTests.Run();
RecordingReplayTests.Run();
SceneDeltaParseParityTests.Run(); // Zero-copy Parse(byte[]) == Parse(span) == Parse(string) on the wire fixtures
JoinModelTests.Run();
GlobalTransformIndexTests.Run();
SelectFlashReplayProbe.Run(); // WS-select P2: transform-less reparent holds card at centre (self-contained) + env-gated real-capture replay (COUCHCOOP_MIRROR_SELECTFLASH_PROBE_NDJSON)
CullIndexTests.Run();
StaticBakePlannerTests.Run();
BandFlattenPlannerTests.Run(); // The K≤2 combat background band-flatten planner
BandOrderingExactTests.Run(); // Ordering-exactness enforcing suite (the "looks identical" gate, pure)
StaticBakePlanProbe.Run(); // optional; env-gated (COUCHCOOP_STATICBAKE_PROBE_NDJSON), skips silently
BandResidencyReplayProbe.Run(); // optional; env-gated (COUCHCOOP_BGBAKE_RESIDENCY_NDJSON), skips silently — band-flatten residency
EnergyCounterRestOriginReplayProbe.Run(); // optional; env-gated (COUCHCOOP_ENERGY_ORB_NDJSON), skips silently — energy-orb rest origin
ArtAlphaScanTests.Run(); // WS-crisp2: threshold-aware alpha used-rect + fade-hole scan (TextureStore.RecordArtInfo)
TextOverlayPlannerTests.Run();
CardLayerPlannerTests.Run(); // Track-C: full-resolution card layer planner
TextOverlayPlanProbe.Run(); // optional; env-gated (COUCHCOOP_TEXTOVL_PROBE_NDJSON), skips silently — Track-Z verify
CrispTargetsProbe.Run(); // optional; env-gated (COUCHCOOP_CRISP_PROBE_NDJSON), skips silently — crisp-targets diagnosis
Crisp2HoleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_CRISP2_PROBE_NDJSON), skips silently — WS-crisp2 hole before/after
TextOverlayPlanBench.Run(); // optional; env-gated (COUCHCOOP_TEXTOVL_BENCH_NDJSON), skips silently
SpineClipTests.Run();
SpineWireFieldsTests.Run(); // WS-spine: SpineSkin (volatile) + spine.skelResPath (static) reader/merge/differ
SpineClipEscalationTests.Run(); // A host-degraded single-frame clip must never trigger the &retry=1 re-request
HoverTipScaleMathTests.Run(); // Feature A: HoverTip 1.2× anchor + clamp geometry
HideLatchPolicyTests.Run(); // Feature B: tween hide-latch state machine
RestFocusReplayProbe.Run(); // Rest-site refocus held-restore self-heal (synthetic) + env-gated real capture (COUCHCOOP_MIRROR_RESTFOCUS_PROBE_NDJSON)
ShaderResourceParserTests.Run();
MaterialSamplerParserTests.Run(); // Material `.tres` sampler sub-resource (Curve/Gradient) materialization
AtlasTextureParserTests.Run(); // Standalone AtlasTexture `.tres` (relic/intent icon) page+region+margin parse
ShaderStaticRewriteTests.Run();
ShaderBakeRewriteTests.Run(); // gdshader Add-blend → bake-add premul variant (blend swap + epilogue)
ShaderIncludeExpanderTests.Run(); // gdshader #include directive scan + splice + cycle/depth guards
ShaderFallbackTests.Run(); // Screen-read classifier + scrim alpha + paint suppression + .exr 16-bit exemption
RasterTextureUrlTests.Run(); // Raster-format policy for `.tres` particle/sampler textures
BackgroundSceneFamiliesTests.Run(); // static-bg events: the shared combat/event background scene-path grammar
IntentMathTests.Run();
FlameMathTests.Run(); // Q1: Tezcatara candle-fire scaleY/skew sine tracks + per-flame FNV-1a phase (web twin)
GestureMachineTests.Run();
EndTurnScanTests.Run(); // The pure end-turn scene-file box lookup behind GestureCallbacks.EndTurnBoxAt
HandChoiceScanTests.Run(); // #12: the pure from-hand card-choice signal behind GestureCallbacks.HandChoiceActive
TouchTargetScanTests.Run();
PlayZoneTests.Run();
HeldCardLiftModelTests.Run();

// M2 wide-screen re-layout + widened input suites.
// SpreadMathTests + InteractiveRectScanTests are FULL; the rest are placeholders (SpreadWalk,
// PointerField, NearMiss, PointerResolver) are filled in by their own changes.
SpreadMathTests.Run();
InteractiveRectScanTests.Run();
SpreadWalkTests.Run();
TipFloaterReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_TIPPROBE_NDJSON), skips silently — live-data verify
GeometryDumpProbe.Run(); // optional; env-gated (COUCHCOOP_GEOMDUMP_NDJSON), skips silently — path+geometry dumps
PointerFieldTests.Run();
NearMissTests.Run();
PointerResolverTests.Run();
NearMissRecordingProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_NEARMISS_PROBE_NDJSON), skips silently — r3/nearmiss real-geometry verification

// Per-label text-scale port (SceneIdentity resolver + TextScale table; mirrorTextScale.css transliteration).
TextScaleTests.Run();
TextPlacementTests.Run(); // TextScale.PlacementLift overflow-aware Center growth-centering truth table

// Card block-scale table (TextScale sibling → MirrorNodeView.FoldCosmetic transform scale).
BlockScaleTests.Run();
BlockScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_BLOCKSCALE_PROBE_NDJSON), skips silently — live-data verify

// #19 general per-node view-scale table + centre-pivot stamp + input inverse round-trip.
ViewScaleTests.Run();
CardRewardScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_CARDREWARD_PROBE_NDJSON), skips silently — nesting live-data verify
EventOptionsScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_EVENT_PROBE_NDJSON), skips silently — combat-event options coverage live-data verify
// View-scale input-remap gate truth table (pure ViewScaleInput.Remap).
ViewScaleInputTests.Run();
// View-scale input-gate registry construction + the four neighbour-exclusion rules (pure).
ViewScaleInputRegistryTests.Run();
ViewScaleTapReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_NDJSON +_SHOP/_EVENT), skips silently — tap-remap live-data verify
// Composed tip owner-follow: group∘card forward-map pure truth table + env-gated replay verify.
RewardTipComposeTests.Run();
RewardTipComposeReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_REWARDTIP_PROBE_NDJSON +_LIST/_NONREG), skips silently — tip-follow live-data verify
// Endpoint-based tween-stamp geometry + predicate (shop open slide / event-entry deferral fix).
ViewScaleTweenStampTests.Run();
ShopOpenScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_SHOPOPEN_PROBE_NDJSON / _SHOP_PROBE_NDJSON), skips silently — shop open slide + closed non-regression
EventEnterScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_EVENTENTER_PROBE_NDJSON), skips silently — regular-event OptionsContainer resolve
// Event-option scale flicker gate: per-DRAIN purity/coverage of the ancient OptionsContainer stamp over a
// recorded ancient-event stream, plus the StaticBake exclusion. Skips when absent.
ViewScaleStampReplayProbe.Run();
// Pure per-drain view-scale stamp index: measure/anchor/clip/parent-frame + bake exclusion truth table.
ViewScaleStampIndexTests.Run();
ScalePackReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_{MAP,PILES,TREASURE}_PROBE_NDJSON), skips silently — scale-pack live-data verify

// Mirror perf reductions: per-node change classification (light-apply eligibility + LOAD-BEARING completeness
// guard) and the memoizing scene-identity/text-scale cache.
NodeChangeDifferTests.Run();
SceneIdentityCacheTests.Run();

// Host-discovery wire codec.
HostDiscoveryCodecTests.Run();
// Disk asset cache helpers (token composition, sha/prune path math) + shared percentile math.
AssetCacheTokenTests.Run();
AssetCachePathsTests.Run();
PercentilesTests.Run();
// Missing-textures fix: the asset stores' bounded transient-retry policy.
AssetFetchPolicyTests.Run();
// Track F2a: the CCTX host-precompressed-texture container header parse.
CctxContainerTests.Run();
// QA hide verbs (GPU-experiment tooling): the pure selector parse + wire-node match grammar.
QaHideSelectorTests.Run();

Console.WriteLine("""{"ok":true,"mirrorProtocolTests":true}""");
