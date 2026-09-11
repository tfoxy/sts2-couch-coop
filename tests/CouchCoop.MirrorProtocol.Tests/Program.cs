using CouchCoop.MirrorProtocol.Tests;

// Custom Exe test runner (assert-or-throw), matching tests/CouchCoop.Mod.Tests. Any failing suite throws and the
// process exits non-zero; a clean run prints a machine-readable success line last.
AffineTests.Run();
WireDefaultsTests.Run();
RoundTripFixtureTests.Run();
StaticFieldsTests.Run();
OrderPatchTests.Run();
CardFlightTests.Run(); // WS-3: declarative discard→draw shuffle card-flight wire contract (strict reader + one-shot applier valve)
EnvelopeTests.Run();
NewFixtureReaderTests.Run();
RecordingReplayTests.Run();
SceneDeltaParseParityTests.Run(); // WS-B: zero-copy Parse(byte[]) == Parse(span) == Parse(string) on the wire fixtures
JoinModelTests.Run();
GlobalTransformIndexTests.Run();
SelectFlashReplayProbe.Run(); // WS-select P2: transform-less reparent holds card at centre (self-contained) + env-gated real-capture replay (COUCHCOOP_MIRROR_SELECTFLASH_PROBE_NDJSON)
CullIndexTests.Run();
StaticBakePlannerTests.Run();
BandFlattenPlannerTests.Run(); // WS-BGBAKE: the K≤2 combat background band-flatten planner
BandOrderingExactTests.Run(); // WS-BGBAKE round 3: ordering-exactness enforcing suite (the "looks identical" gate, pure)
StaticBakePlanProbe.Run(); // optional; env-gated (COUCHCOOP_STATICBAKE_PROBE_NDJSON), skips silently
BandResidencyReplayProbe.Run(); // optional; env-gated (COUCHCOOP_BGBAKE_RESIDENCY_NDJSON), skips silently — WS-BGBAKE residency
EnergyCounterRestOriginReplayProbe.Run(); // optional; env-gated (COUCHCOOP_ENERGY_ORB_NDJSON), skips silently — WS-3 energy-orb rest origin
ArtAlphaScanTests.Run(); // WS-crisp2: threshold-aware alpha used-rect + fade-hole scan (TextureStore.RecordArtInfo)
TextOverlayPlannerTests.Run();
CardLayerPlannerTests.Run(); // Track-C: full-resolution card layer planner
TextOverlayPlanProbe.Run(); // optional; env-gated (COUCHCOOP_TEXTOVL_PROBE_NDJSON), skips silently — Track-Z verify
CrispTargetsProbe.Run(); // optional; env-gated (COUCHCOOP_CRISP_PROBE_NDJSON), skips silently — WS-CRISP diagnosis
Crisp2HoleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_CRISP2_PROBE_NDJSON), skips silently — WS-crisp2 hole before/after
TextOverlayPlanBench.Run(); // optional; env-gated (COUCHCOOP_TEXTOVL_BENCH_NDJSON), skips silently
SpineClipTests.Run();
SpineWireFieldsTests.Run(); // WS-spine: SpineSkin (volatile) + spine.skelResPath (static) reader/merge/differ
SpineClipEscalationTests.Run(); // WS-7 (#14): a host-degraded single-frame clip must never trigger the &retry=1 re-request
HoverTipScaleMathTests.Run(); // Feature A (WS-VIEW): HoverTip 1.2× anchor + clamp geometry
HideLatchPolicyTests.Run(); // Feature B (WS-VIEW): tween hide-latch state machine
RestFocusReplayProbe.Run(); // WS-REST: rest-site refocus held-restore self-heal (synthetic) + env-gated real capture (COUCHCOOP_MIRROR_RESTFOCUS_PROBE_NDJSON)
ShaderResourceParserTests.Run();
MaterialSamplerParserTests.Run(); // WS-EMITTER: material `.tres` sampler sub-resource (Curve/Gradient) materialization
AtlasTextureParserTests.Run(); // WS-ATLAS: standalone AtlasTexture `.tres` (relic/intent icon) page+region+margin parse
ShaderStaticRewriteTests.Run();
ShaderBakeRewriteTests.Run(); // WS-ADDBAKE: gdshader Add-blend → bake-add premul variant (blend swap + epilogue)
ShaderIncludeExpanderTests.Run(); // WS-SHINC: gdshader #include directive scan + splice + cycle/depth guards
ShaderFallbackTests.Run(); // WS-SHADER: screen-read classifier + scrim alpha + paint suppression + .exr 16-bit exemption
RasterTextureUrlTests.Run(); // WS-PARTICLE: raster-format policy for `.tres` particle/sampler textures
BackgroundSceneFamiliesTests.Run(); // static-bg events: the shared combat/event background scene-path grammar
IntentMathTests.Run();
FlameMathTests.Run(); // Q1: Tezcatara candle-fire scaleY/skew sine tracks + per-flame FNV-1a phase (web twin)
GestureMachineTests.Run();
EndTurnScanTests.Run(); // R4 change 2: the pure end-turn scene-file box lookup behind GestureCallbacks.EndTurnBoxAt
HandChoiceScanTests.Run(); // #12: the pure from-hand card-choice signal behind GestureCallbacks.HandChoiceActive
TouchTargetScanTests.Run();
PlayZoneTests.Run();
HeldCardLiftModelTests.Run();

// M2 wide-screen re-layout + widened input suites (pre-registered by WS-O so P/Q never touch Program.cs).
// SpreadMathTests + InteractiveRectScanTests are FULL (WS-O); the rest are placeholders WS-P (SpreadWalk) / WS-Q
// (PointerField / NearMiss / PointerResolver) fill in their own worktrees.
SpreadMathTests.Run();
InteractiveRectScanTests.Run();
SpreadWalkTests.Run();
TipFloaterReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_TIPPROBE_NDJSON), skips silently — R5 H1/H2 live-data verify
GeometryDumpProbe.Run(); // optional; env-gated (COUCHCOOP_GEOMDUMP_NDJSON), skips silently — WS-G2 R2/R3/R4/R7/R9/R19/R20 path+geometry dumps
PointerFieldTests.Run();
NearMissTests.Run();
PointerResolverTests.Run();
NearMissRecordingProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_NEARMISS_PROBE_NDJSON), skips silently — r3/nearmiss real-geometry verification

// Per-label text-scale port (SceneIdentity resolver + TextScale table; mirrorTextScale.css transliteration).
TextScaleTests.Run();
TextPlacementTests.Run(); // TextScale.PlacementLift overflow-aware Center growth-centering truth table

// R6 card block-scale table (TextScale sibling → MirrorNodeView.FoldCosmetic transform scale).
BlockScaleTests.Run();
BlockScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_BLOCKSCALE_PROBE_NDJSON), skips silently — R6 live-data verify

// #19 general per-node view-scale table + centre-pivot stamp + input inverse round-trip.
ViewScaleTests.Run();
CardRewardScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_CARDREWARD_PROBE_NDJSON), skips silently — R4-round4 nesting live-data verify
EventOptionsScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_EVENT_PROBE_NDJSON), skips silently — R6 combat-event options coverage live-data verify
// R2 view-scale input-remap gate truth table (pure ViewScaleInput.Remap).
ViewScaleInputTests.Run();
// R5 (WS-A) view-scale input-gate registry construction + the four neighbour-exclusion rules (pure).
ViewScaleInputRegistryTests.Run();
ViewScaleTapReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_VIEWSCALE_TAP_PROBE_NDJSON +_SHOP/_EVENT), skips silently — R5 tap-remap live-data verify
// R6 (WS-TIP) composed tip owner-follow: group∘card forward-map pure truth table + env-gated replay verify.
RewardTipComposeTests.Run();
RewardTipComposeReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_REWARDTIP_PROBE_NDJSON +_LIST/_NONREG), skips silently — R6 tip-follow live-data verify
// WS-SHOP (round 6) endpoint-based tween-stamp geometry + predicate (shop open slide / event-entry deferral fix).
ViewScaleTweenStampTests.Run();
ShopOpenScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_SHOPOPEN_PROBE_NDJSON / _SHOP_PROBE_NDJSON), skips silently — shop open slide + closed non-regression
EventEnterScaleReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_EVENTENTER_PROBE_NDJSON), skips silently — regular-event OptionsContainer resolve
// R8 (WS-2) event-option scale flicker gate: per-DRAIN purity/coverage of the ancient OptionsContainer stamp over a
// recorded ancient-event stream (.sts2/bench/audit-mprun.ndjson), plus the StaticBake exclusion. Skips when absent.
ViewScaleStampReplayProbe.Run();
// R8 (WS-2) pure per-drain view-scale stamp index: measure/anchor/clip/parent-frame + bake exclusion truth table.
ViewScaleStampIndexTests.Run();
ScalePackReplayProbe.Run(); // optional; env-gated (COUCHCOOP_MIRROR_{MAP,PILES,TREASURE}_PROBE_NDJSON), skips silently — R8 scale-pack live-data verify

// WS-P2 mirror perf reductions: per-node change classification (light-apply eligibility + LOAD-BEARING completeness
// guard) and the memoizing scene-identity/text-scale cache.
NodeChangeDifferTests.Run();
SceneIdentityCacheTests.Run();

// M3 WS-T host-discovery wire codec.
HostDiscoveryCodecTests.Run();
// M3 WS-U disk asset cache helpers (token composition, sha/prune path math) + shared percentile math.
AssetCacheTokenTests.Run();
AssetCachePathsTests.Run();
PercentilesTests.Run();
// Missing-textures fix (2026-07-19): the asset stores' bounded transient-retry policy.
AssetFetchPolicyTests.Run();
// Track F2a: the CCTX host-precompressed-texture container header parse.
CctxContainerTests.Run();
// QA hide verbs (GPU-experiment tooling): the pure selector parse + wire-node match grammar.
QaHideSelectorTests.Run();

Console.WriteLine("""{"ok":true,"mirrorProtocolTests":true}""");
