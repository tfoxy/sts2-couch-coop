// One Node2D per wire mirror node. Holds the node's placement (local Transform2D), visibility, modulate /
// self_modulate tint, z-index, show-behind-parent, clip mode, and material; its _Draw delegates to the small STATIC
// drawers (TextureDrawer / NinePatchDrawer / RangeDrawer) in the FIXED sub-layer paint order, and text is a child
// node synced via TextAttachment. The drawer split + the effect-attachment Sync seam is what lets the M1d effect
// workstreams (WS-H shaders / WS-I spine+particles / WS-J tween+intent+cosmetic) fill their behavior WITHOUT
// touching this file.
//
// Alpha/tint rules ported from mirrorRenderer.ts L2096-2099:
//   modAlpha  = modulate.a ?? opacity        selfAlpha = selfModulate.a ?? 1
//   modulate cascades to children (Godot Modulate), self_modulate is own-draw only (Godot SelfModulate).
// Godot composes the ancestor modulate chain for free via tree nesting, so each view sets only its OWN modulate.
//
// STREAMED-TRUTH + TWEEN OWNERSHIP (the M1d seam). Every Apply records the streamed transform / modulate /
// self_modulate as the authoritative wire truth (StreamedLocal/StreamedModulate/StreamedSelfModulate). A tween
// (WS-J) can then take OWNERSHIP of one channel: while TweenOwnsTransform is set, Apply skips the Transform write;
// while TweenOwnsModulateA/SelfModulateA is set, Apply writes the streamed RGB but PRESERVES the current alpha (the
// tween owns that alpha). This lets the wire keep upserting a tweened node without stomping the animation.
//
// SETTLE (WS-T1): BeginTween(channel) snapshots the channel's streamed truth AT ARM TIME. The producer withholds a
// tweened channel's streamed deltas while it replays (so the wire truth normally sits PINNED at its pre-tween value
// for the tween's whole duration); SettleTween(channel, rawEnd) — called on Finished instead of the old blind
// ResumeStreamed — compares the CURRENT streamed truth to that snapshot. Unchanged (the common, producer-suppressed
// case) → adopt the hint's raw (unfolded) endpoint into streamed truth so the settle is the tween's own endpoint,
// not a stale pre-tween value. Changed (a fresh delta landed mid-tween — streaming was NOT suppressed for this
// node) → today's behavior: apply whatever streamed truth already holds. Either way the channel is re-folded/applied
// through the normal Apply path (FoldCosmetic / RGB compose), so a spread/lift offset that shifted mid-tween is
// still picked up correctly.
//
// COSMETIC animators (WS-J): CosmeticOffset (parent-frame px, folded into Transform.Origin — the intent bob) and
// CosmeticSpin (radians, applied in _Draw about the paint-box center — the orb spin) are cosmetic-only overlays the
// wire does not stream; both defer to a tween that owns the transform.
//
// INTENT frame substitution (WS-J): SetIntentFrame(clone) swaps in a shallow node clone carrying frame-i texture
// fields; while set, _Draw and ResolveTexture read the substitute for texture/region/margin (frame 0 already
// renders on the streamed node itself via the applier's intent override).
//
// ATTACHMENT-CHILD ORDERING RULE (for the effect workstreams): effect children — "__spine" (WS-I), "__particles"
// (WS-I), "__intent" (WS-J), "__anim" (WS-J) — are END-APPENDED and set ShowBehindParent = true, so they draw
// BEFORE the owner's own _Draw (the base art paints over the effect canvas). The reconciler's MoveChild(view, i)
// pass only reorders MirrorNodeView children by orderedIds, which self-pushes these non-view children to the tail —
// no per-Sync re-assert needed. "__text" is the exception: it stays FRONTMOST via TextAttachment's last-child
// re-assert (text draws over everything).

using CouchCoop.GodotClient.Scene.Drawers;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class MirrorNodeView : Node2D
{
    // Feature B hide-latch diagnostics gate (read ONCE): COUCHCOOP_MIRROR_HIDELATCH_PROBE=1 turns on BOTH the latch's
    // own M1D_HIDELATCH armed/clamped/expired lines (here) AND TweenReplayer's independent flash-detector probe. Off
    // by default → zero log cost in normal play.
    internal static readonly bool HideLatchDebug =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_HIDELATCH_PROBE") == "1";

    // A held resting-alpha write is a genuine reveal. This fixes the
    // rest-site refocus/first-click defect where a plain resting-alpha re-show (fade-in hint killed) is mis-clamped
    // to 0 and stuck invisible: once the latch has HELD a resting-valued write for HeldRestoreGraceMs the write is a
    // genuine reveal → release + re-apply the streamed alpha, even with zero further deltas.

    // TextureSettledOrFailed treats a view whose pending fetch url is known-failed as settled
    // (it never decodes — the live view paints the same blank the clone would), so a card/text with an unfetchable
    // member texture (device wifi failures) still promotes crisp.
    // WS-flameperf: the Q1 flame flicker as a TRANSFORM FOLD (CosmeticScaleY/CosmeticSkew fold into the node's
    // Transform via FoldCosmetic, exactly like the intent bob's CosmeticOffset) rather than a per-frame draw-time
    // DrawSetTransformMatrix. The fold is byte-identical to the draw matrix for leaf flame quads.

    // WS-flameperf instrumentation: cumulative count of _Draw() invocations across ALL views this session (a
    // canvas-item re-record — the cost the flame fold eliminates). Exposed via QaStateJson `viewDrawInvocations`; a QA
    // soak samples the delta/sec on an idle Tezcatara scene. A flame changes only its Transform (composed by the
    // render server, without _Draw), so its quads do not re-record on every ticker tick. Plain increment (game main
    // thread only). Never reset.
    public static long DrawInvocations;

    // Re-keyed by SceneReconciler.Acquire when a pooled view is recycled onto a different wire node (WS-P1).
    public string NodeId { get; private set; }

    // WS-P1 recycle generation. Bumped by ResetForPool on every park, so an async callback captured under a prior
    // tenure (ShaderAttachment's mount re-apply) can detect the recycle and drop instead of touching reset state.
    // A brand-new view starts at 0; its first tenant's callbacks capture 0 and match until the first release.
    public int Generation { get; private set; }

    // Current streamed node data (always the live state.Nodes entry the reconciler passed last). Effect attachments
    // read it via NodeData.
    private MirrorNode _node = null!;

    // The render context threaded in on Apply (texture cache + store + options); retained so SetIntentFrame can
    // re-resolve the texture off the same cache without a ctx argument.
    private RenderContext _ctx = null!;

    // Texture resolution: the url we last requested, and the decoded texture once it arrives.
    private string? _wantUrl;
    private Texture2D? _texture;
    private bool _paintsTexture; // TextureDrawer paints (plain/atlas), i.e. paintsTexture gate AND not a nine-patch

    // WS-CRISP R18: the ACTUAL TextureStore url currently in flight (the raster `?format=png` url for a NODETEXRASTER
    // `.tres`, the atlas PAGE url on the client-crop path, or the raw url otherwise) — distinct from `_wantUrl` (the
    // wire identity the change-detection keys on). Set right before the TextureStore.Request that carries it, cleared
    // when its texture lands or the wanted url changes. TextureSettledOrFailed reads TextureStore.IsFailed against it,
    // so a permanently-failed fetch stops holding the view unsettled forever.
    private string? _pendingFetchUrl;

    // WS-ATLAS: when the node texture is a standalone AtlasTexture `.tres` the client crops itself (AtlasTresStore),
    // `_texture` is the whole atlas PAGE and these carry the region+margin parsed from the `.tres`. Non-null ONLY on
    // the client-crop path (and only when the wire supplied no TextureRegion — the wire region always wins). Cleared
    // whenever the wanted url changes.
    private MirrorRect? _clientAtlasRegion;
    private MirrorRect? _clientAtlasMargin;

    // Intent frame substitute (WS-J): non-null → _Draw + ResolveTexture read IT for texture/region/margin.
    private MirrorNode? _intentSubstitute;

    // Cosmetic-animator state (WS-J), applied only when non-default (zero in M1c → no visual change).
    private Vector2 _cosmeticOffset;
    private float _cosmeticSpin;
    // Q1 Tezcatara candle-fire loop: scale.Y + skew (radians) about the paint-box BOTTOM-CENTER, driven by
    // CosmeticAnimator's flame ticker. Identity defaults (scaleY 1, skew 0) → no fold / _Draw skip (byte-stable).
    // Flame channels fold into the node transform, avoiding per-frame canvas-item re-recording.
    private float _cosmeticScaleY = 1f;
    private float _cosmeticSkew;

    // WS-flameperf: the flame's bottom-center paint-box pivot (LOCAL/paint coords), resolved ONCE per full Apply
    // (ResolveFlamePivot, BlockScale precedent) so the flame ticker's per-tick fold reuses it. _flameHasBox guards the
    // fold when the node has no paint box (a flame quad always does, so this mirrors the old draw-time PaintBox guard).
    private Vector2 _flamePivot;
    private bool _flameHasBox;

    // Input-side cosmetic lift (M1e). Additive with _cosmeticOffset in FoldCosmetic. The INPUT side (WS-M's
    // HeldCardLift, via SceneReconciler.TryGetView) is the SOLE writer; nothing under Effects/ may touch it —
    // CosmeticAnimator keeps sole ownership of CosmeticOffset (it force-zeroes CosmeticOffset for non-bob nodes
    // every Apply), and LiftOffset is deliberately outside that ownership so a held card can lift while bobbing.
    private Vector2 _liftOffset;

    // Wide-screen re-layout (M2). SpreadOffset is a THIRD additive FoldCosmetic channel (parent-frame px); the sole
    // writer is SceneReconciler's spread pass (SpreadIndex → parent-relative delta → ParentFrameOffset). SpreadWidth
    // is an anchor-widened box-WIDTH override (0 = none) applied through EffectiveNode as a cached shallow substitute
    // — a rect-width override, NEVER a transform scale (so children/art don't stretch), matching the web CSS width.
    // Both zero at spreadFactor 1 → identical pixels. See MirrorProtocol SpreadTypes / SpreadIndex.
    private Vector2 _spreadOffset;
    private double _spreadWidth;
    private MirrorNode? _spreadSubstitute; // cached width-override clone of (_intentSubstitute ?? _node); invalidated on Apply / SetIntentFrame / SpreadWidth change
    private MirrorNode? _spreadSubstituteSource; // the node the current clone was built from (reference-keyed cache validity)

    // HoverTip 1.2× scale channel (Feature A / WS-VIEW). A FOURTH FoldCosmetic channel — but a SCALE, not an additive
    // offset: T(P)·S(k)·T(−P) about a parent-frame pivot _hoverScalePivot, plus a parent-frame clamp translation
    // _hoverClampOffset, applied BEFORE the additive lift/spread offsets (so those stay expressed in un-scaled parent
    // px). Sole writer: HoverTipScaler's per-drain pass (SetHoverTipScale), only ever on an NHoverTipSet root view.
    // _hoverScale defaults to 1 → the all-identity FoldCosmetic early-out stays byte-identical when the switch is off.
    private float _hoverScale = 1f;
    private Vector2 _hoverScalePivot;
    private Vector2 _hoverClampOffset;

    // R8 (WS-2) VIEW-SCALE channel — the #19 general item/group enlargement (reward list, card rewards, merchant
    // carpet, event options). Same SHAPE as the HoverTip channel above (a parent-frame pivot scale + a parent-frame
    // clamp translation) but a SEPARATE channel with a fundamentally different authority model: it has NO setter and
    // no external writer. It is RESOLVED here, from the pure per-drain ViewScaleStampIndex, keyed on this view's wire
    // NodeId — see EnsureViewScale. That is what makes a StaticBake CLONE (a throwaway view carrying the same wire
    // id), a pool-RECYCLED view, a RefreshEffects re-apply and a tween settle all fold the identical scale without a
    // single line of per-consumer plumbing, and what removed the cross-drain stamp memory whose "drop" branches were
    // the event-option snap-back (patched in R4/R6/R7, reported three times).
    // _viewScaleGen caches the resolve against ViewScaler.Generation so a fold costs one int compare off a
    // view-scale screen and at most one dictionary probe per view per drain on one.
    private float _viewScale = 1f;
    private Vector2 _viewScalePivot;
    private Vector2 _viewScaleClamp;
    private int _viewScaleGen = -1;

    // R6 card block-scale channel — a FIFTH FoldCosmetic input, and a SCALE like _hoverScale, but a LOCAL-space pivot:
    // T(c)·S(k)·T(−c) POST-multiplied onto the streamed local (c = the node's OWN LocalRect centre in local coords),
    // so the node's own content (its text, or — for TypePlaque — its whole child subtree) scales about its visual
    // centre while everything else (spread / hover / clamp / lift, all parent-frame) composes on top. Resolved per
    // full Apply from the identity cache (BlockScale table) — NOT a live wire channel. Defaults 1 → the FoldCosmetic
    // early-out stays byte-identical when the switch/table give no bump. See FoldCosmetic + BlockScale.cs.
    private float _blockScale = 1f;
    private Vector2 _blockPivot;

    // ---- self-paint suppression (a node's OWN paint is skipped while ANY bit is set) ------------------------------
    // Three independent reasons compose here (a [Flags] merge so no producer clobbers another):
    //   * Culled  (M3 CULL, sole writer SceneReconciler's cull pass): the node's paint box is provably off-screen.
    //   * Baked   (Track-D StaticBake, sole writer the StaticBake controller): the node's pixels are already in the
    //     pre-composited quad, so its live self-paint must not double-draw over the quad.
    //   * Hoisted (Track-C CardLayer, sole writer the CardLayer controller): this node is a member of a card whose
    //     whole subtree is cloned crisp onto the card CanvasLayer above the scaled stage, so the live member must not
    //     double-draw UNDER the clone. DISTINCT from cull/bake in ONE way: a hoisted card is still on-screen and
    //     visible, so the card layer's holder-visibility sync must IGNORE this bit (SelfPaintCulledOrBaked) — else the
    //     holder would hide the crisp clone it just built.
    // While ANY bit is set, _Draw skips its drawer content and the "__text" child is hidden — but CHILD VIEWS stay
    // live (they parent under this view and carry their own decisions). Effect-bearing / clip-only nodes are excluded
    // by all producers, so this is only ever set on a plain own-paint node. Zeroed on pool release.
    [System.Flags]
    private enum SelfPaintSuppress
    {
        None = 0,
        Culled = 1 << 0,
        Baked = 1 << 1,
        Hoisted = 1 << 2,
    }

    private SelfPaintSuppress _selfPaintSuppress;

    // ---- Track-B text overlay: this node's "__text" child is promoted to the native-resolution overlay CanvasLayer --
    // When set, the TextOverlay controller renders a native-res PROXY of this node's text above the scaled stage, so
    // the in-stage "__text" child must stay HIDDEN (else the text double-draws — once mushy at Half, once crisp). This
    // is DISTINCT from _selfPaintSuppress: promotion hides ONLY the text, never the node's own drawer content (a button
    // keeps its fill while its label promotes), so it deliberately does NOT gate _Draw. Sole writer: SetTextPromoted
    // (the controller). Cleared on pool release. Composed with the suppress bits in ReconcileTextVisibility.
    private bool _textPromoted;

    // ---- WS-P2 attachment-child presence flags (set by the effect attachments; reset in ResetForPool) -------------
    // Each effect attachment's Sync begins by probing owner.GetNodeOrNull(childName) — a marshalled Godot child
    // lookup. These bools let a Sync SKIP that probe when the node has no relevant field AND the attachment never
    // attached its child (the overwhelmingly common leaf-node case): set true when the child is attached, false when
    // torn down. The gate only skips when the bool is ALSO false, so a REMOVED field still tears down its live child.
    // The "__text" child is tracked privately by SyncText (its gate lives there, not in TextAttachment).
    public bool HasParticleChild;
    public bool HasSpineChild;
    public bool HasIntentChild;
    // Set true by LineAttachment.Sync while a "__line" Line2D (a map quill stroke) is attached.
    public bool HasLineChild;
    private bool _hasTextChild;

    // WS-B: build-once NodePath for this view's own "__text" child probes (GetNodeOrNull(string) marshals a fresh
    // NodePath per call). TextAttachment keeps its own copy for its probe.
    private static readonly NodePath TextChildPath = "__text";

    // Track-D: set true by CosmeticAnimator.Sync while an "__anim" bob/spin ticker is attached (cleared by Detach).
    // A node driven by a cosmetic ticker is animating client-side, so the StaticBake controller excludes it from a
    // bake (it would freeze the bob/spin). Reset in ResetForPool alongside the other attachment presence flags.
    public bool HasAnimChild;

    // True for a throwaway clone a controller builds into its own tree — the Track-D StaticBake bake viewport OR the
    // Track-C CardLayer (both build MirrorNodeView clones via view.Apply). A clone shares its wire node's id with the
    // LIVE view, so it must be plain Free()d — NEVER ResetForPool, which would TweenReplayer.ReleaseFor(id) /
    // ShaderAttachment.ResetView the live node's channels. Guards the DEBUG assert.
    public bool IsBakeClone;

    // WS-ADDBAKE: true ONLY for a StaticBake region-viewport clone (NOT a CardLayer clone). MaterialResolver /
    // ShaderAttachment consult this to render an Add-blend clone with the alpha-preserving additive variant
    // (blend_premul_alpha + fold epilogue) so the region's premult-over composite is a TRUE add. CardLayer clones set
    // IsBakeClone but NOT this, so their Add blends are untouched.
    public bool IsStaticBakeClone;

    // Track-P3 (multi-region static bake): an ABSOLUTE effective-Z override the StaticBake controller stamps on a LIVE
    // background painter that must interleave between baked region quads. When set, the view paints at exactly this z
    // (ZAsRelative=false) regardless of the wire ZIndex or its parent chain, and Apply/ApplyLight RE-ASSERT it so a
    // reconcile pass cannot clobber it. Cleared (→ wire z, ZAsRelative=true) on bake invalidate and on pool reset. Only
    // ever set on LEAF painters (particles) whose absolute placement preserves the exact live paint order below the
    // creatures — see StaticBakePlanner's LiveZ reassignment. Null = normal wire-driven relative z.
    private int? _zOverride;

    // ---- streamed-truth records (written EVERY Apply, even when a tween owns the channel) --------------------------
    public Transform2D StreamedLocal { get; private set; }

    // #11: true once SetLocalTransform, Apply, OR ApplyLight has written a real local at least once — i.e. StreamedLocal
    // holds a REAL placed transform (not the default zero matrix). SceneReconciler.LocalXform uses this to HOLD the
    // last-known local when a node's own global is transiently missing from the transform index during a same-drain
    // reparent (else it collapses to Transform2D.Identity under the parent → global (0,0), the discard-card "goes to
    // (0,0)" symptom). Q6-A: Apply/ApplyLight are the NORMAL per-drain paths (SetLocalTransform is only the transform-only
    // cold path) and must stamp this too, else a reparented/selected card that was placed exclusively via Apply never
    // gets the hold. A never-placed view keeps the old Identity fallback (holding the zero matrix would be worse).
    // Persists across pool recycling like the recycle gen — NOT reset in ResetForPool (StreamedLocal resets to
    // Identity there instead, so a stale `true` on a freshly-recycled view only ever holds a harmless Identity).
    public bool HasPlacedTransform { get; private set; }
    public Color StreamedModulate { get; private set; }
    public Color StreamedSelfModulate { get; private set; }

    // ---- tween channel ownership (set/cleared ONLY by TweenReplayer, WS-J) ----------------------------------------
    public bool TweenOwnsTransform;      // Apply skips the Transform write while true
    public bool TweenOwnsModulateA;      // Apply writes streamed rgb but PRESERVES current Modulate.A while true
    public bool TweenOwnsSelfModulateA;  // same for SelfModulate

    // ---- tween-arm snapshots (WS-T1): the channel's streamed truth AT ARM TIME, taken by BeginTween and compared
    // against the CURRENT streamed truth by SettleTween to detect whether a fresh delta landed mid-tween. Only
    // meaningful while the corresponding TweenOwns* flag above is set.
    private Transform2D _armedStreamedLocal;
    private float _armedStreamedModulateA;
    private float _armedStreamedSelfModulateA;

    // ---- tween HIDE-LATCH (Feature B; per opacity channel) ---------------------------------------------------------
    // After a fade-to-0 tween settles, the producer restores the RESTING alpha (+ Visible) for one drain before it
    // hides/removes the node — a 1-frame reappear FLASH. The latch clamps that lone resting-valued streamed write back
    // to the hidden state (0) for HideLatchPolicy.GraceMs, then releases. `_hideResting*` is the arm-time streamed
    // alpha (the resting SIGNATURE the producer restores to); `_hideArmMs*` is the arm wall-clock (Time.GetTicksMsec)
    // for the grace test. Sole armer: TweenReplayer's fade-settle. Enforced at the THREE streamed-alpha write sites
    // (Apply / ApplyLight / SettleTween) via LatchedAlpha. All reset in ResetForPool → recycled views carry no latch.
    private bool _hideLatchModulateA;
    private bool _hideLatchSelfModulateA;
    private float _hideRestingModulateA;
    private float _hideRestingSelfModulateA;
    private ulong _hideArmMsModulateA;
    private ulong _hideArmMsSelfModulateA;
    // WS-REST held-restore clock (per channel; Time.GetTicksMsec, 0 = not started): stamped on the FIRST Hold of a
    // resting-valued (>AlphaEps) write, so LatchedAlpha/SweepHideLatch can expire a latch that has been clamping a
    // genuine (hint-less) re-show for ≥ HeldRestoreGraceMs. Never stamped on a ≈0 write; reset on arm/clear/pool.
    private ulong _hideHeldRestoreMsModulateA;
    private ulong _hideHeldRestoreMsSelfModulateA;

    public enum TweenChannel
    {
        Transform,
        ModulateA,
        SelfModulateA,
    }

    public MirrorNodeView(string id)
    {
        NodeId = id;

        // T5b sampling side: opt this canvas item into mipmap-aware filtering so a MINIFIED draw (hand cards ~0.5–0.7×
        // + Half render scale) fetches a smaller, cache-friendly mip of the (now-mipped) page instead of thrashing the
        // full-res texel grid. Godot 4
        // canvas items default to Linear with NO mipmaps; this is the one lever that makes the produced mips actually
        // sample. Set here (not in ResetForPool) so it PERSISTS across pool recycling — ResetForPool restores the other
        // Godot base props to a fresh Node2D's defaults but deliberately leaves TextureFilter alone. The effect/text
        // CHILD nodes (__text/__spine/__particles/__intent/__anim) keep their default TextureFilterEnum.Inherit, so
        // they inherit THIS value from their parent view (verified empirically: spine/particles pick up mips, text —
        // whose font atlas has no mips — falls back to the base level, i.e. unchanged). At 1:1 scale LinearWithMipmaps
        // samples mip 0 → identical output.
        TextureFilter = TextureFilterEnum.LinearWithMipmaps;
    }

    // ---- pool recycle (WS-P1) -------------------------------------------------------------------------------------

    // Re-key a POOLED (already reset) view onto a new wire node id. Acquire calls this right after popping from the
    // pool; the full reset happened at RELEASE time (ResetForPool), so this only stamps the new id — the very next
    // Apply repopulates every other field. Generation is NOT re-bumped here (release already bumped it).
    public void Rekey(string id)
    {
        NodeId = id;
    }

    // Full reset to a provably-inert state, done at RELEASE time (SceneReconciler.Release) so a parked view carries
    // NONE of its prior tenant's state. Bumps Generation (drops in-flight async callbacks), runs the two correctness
    // linchpins (TweenReplayer.ReleaseFor + ShaderAttachment.ResetView) while NodeId is still the OUTGOING id, resets
    // every stateful field + Godot base prop to its default, and frees the remaining effect-attachment children. The
    // reconciler releases MirrorNodeView CHILDREN first (child-first), so only effect children (__text/__particles/
    // __spine/__intent/__anim) remain here — asserted in DEBUG.
    public void ResetForPool()
    {
        // Track-D linchpin: a StaticBake clone shares the LIVE view's id, so ResetForPool here would ReleaseFor /
        // ResetView the LIVE node's tween + shader channels. Clones are plain Free()d — never pooled.
        System.Diagnostics.Debug.Assert(!IsBakeClone, "ResetForPool called on a StaticBake clone — clones must be Free()d, not pooled");

        // #7 instrumentation (COUCHCOOP_MIRROR_TWEEN_DEBUG=1): the pool-reset stamps identity onto Transform/Streamed*
        // below — trace the scale it's WIPING so the death-shrink agent can tell a pool-reset shrink from a tween one.
        if (TweenDebugSettings.Enabled)
        {
            GD.Print($"TWEEN_DEBUG: ResetForPool id={NodeId} transformScale=({Transform.Scale.X:0.###},{Transform.Scale.Y:0.###}) streamedScale=({StreamedLocal.Scale.X:0.###},{StreamedLocal.Scale.Y:0.###})");
        }

        // 1. Correctness linchpins, keyed on the OUTGOING id (must run before Generation bump / NodeId reuse).
        TweenReplayer.ReleaseFor(NodeId);
        ShaderAttachment.ResetView(this);

        // 2. Invalidate every async callback armed under this tenure.
        Generation++;

        // 3. Retained references + texture state.
        _node = null!;
        _ctx = null!;
        _wantUrl = null;
        _texture = null;
        _pendingFetchUrl = null; // WS-CRISP R18: drop any in-flight fetch url tracking
        _paintsTexture = false;
        _clientAtlasRegion = null; // WS-ATLAS: a recycled view must not carry the prior tenant's client-crop region/margin
        _clientAtlasMargin = null;
        _intentSubstitute = null;
        _spreadSubstitute = null;
        _spreadSubstituteSource = null;

        // WS-P2: step 8 frees all effect-attachment children, so the presence flags must reset to false (else the next
        // tenant's attachment gates would think a child already exists and skip the probe / mis-track teardown).
        HasParticleChild = false;
        HasSpineChild = false;
        HasIntentChild = false;
        HasLineChild = false;
        HasAnimChild = false;
        _hasTextChild = false;

        // 4. Cosmetic / lift / spread channels (fields directly — bypass the re-folding setters).
        _cosmeticOffset = Vector2.Zero;
        _cosmeticSpin = 0f;
        _cosmeticScaleY = 1f;
        _cosmeticSkew = 0f;
        _flamePivot = Vector2.Zero; // WS-flameperf: re-resolved on the recycled view's first full Apply
        _flameHasBox = false;
        _liftOffset = Vector2.Zero;
        _spreadOffset = Vector2.Zero;
        _spreadWidth = 0;
        _hoverScale = 1f; // Feature A: a recycled view starts un-scaled (FoldCosmetic early-out intact)
        _hoverScalePivot = Vector2.Zero;
        _hoverClampOffset = Vector2.Zero;
        _viewScale = 1f; // R8: neutral + a stale generation, so the recycled view RE-RESOLVES on its first fold
        _viewScalePivot = Vector2.Zero;
        _viewScaleClamp = Vector2.Zero;
        _viewScaleGen = -1;
        _blockScale = 1f; // R6: a recycled view starts un-block-scaled (re-resolved on its first full Apply)
        _blockPivot = Vector2.Zero;
        _selfPaintSuppress = SelfPaintSuppress.None; // a recycled view starts fully painted (cull + bake + hoist cleared)
        _textPromoted = false; // Track-B: a recycled view starts with its text in-stage (not promoted to the overlay)

        // 5. Streamed-truth records → identity / white.
        StreamedLocal = Transform2D.Identity;
        StreamedModulate = Colors.White;
        StreamedSelfModulate = Colors.White;

        // 6. Tween ownership flags + WS-T1 arm snapshots.
        TweenOwnsTransform = false;
        TweenOwnsModulateA = false;
        TweenOwnsSelfModulateA = false;
        _armedStreamedLocal = Transform2D.Identity;
        _armedStreamedModulateA = 1f;
        _armedStreamedSelfModulateA = 1f;

        // Feature B: a recycled view carries no hide-latch (its registry entries are dropped by ReleaseFor below).
        _hideLatchModulateA = false;
        _hideLatchSelfModulateA = false;
        _hideRestingModulateA = 1f;
        _hideRestingSelfModulateA = 1f;
        _hideArmMsModulateA = 0;
        _hideArmMsSelfModulateA = 0;
        _hideHeldRestoreMsModulateA = 0;
        _hideHeldRestoreMsSelfModulateA = 0;

        // 7. Godot base props → defaults (a fresh Node2D's values).
        Transform = Transform2D.Identity;
        Modulate = Colors.White;
        SelfModulate = Colors.White;
        Visible = true;
        _zOverride = null; // Track-P3: drop any multi-region absolute-z override
        ZAsRelative = true;
        ZIndex = 0;
        ShowBehindParent = false;
        ClipChildren = ClipChildrenMode.Disabled;
        Material = null;

        // 8. Free the remaining (effect-attachment) children. Iterate back-to-front (Free removes them). The parent's
        // MirrorNodeView children were released first by the reconciler, so none should remain here.
        for (int i = GetChildCount() - 1; i >= 0; i--)
        {
            var child = GetChild(i);
            System.Diagnostics.Debug.Assert(
                child is not MirrorNodeView,
                "MirrorNodeView child present at park time — reconciler must release child views before their parent");
            child.Free();
        }
    }

    // The node effect attachments read (the current streamed node — NOT the intent substitute).
    public MirrorNode NodeData => _node;

    // The node _Draw / ResolveTexture actually paint from: the intent substitute when set, else the streamed node —
    // then width-adjusted for the wide-screen anchor override (a no-op unless SpreadWidth > 0).
    private MirrorNode EffectiveNode => WidthAdjusted(_intentSubstitute ?? _node);

    // Full property update from the node's current data. `local` is the node's local Transform2D (the reconciler
    // derived it from the wire matrix). Idempotent — safe to call every time the node changes.
    public void Apply(MirrorNode node, Transform2D local, RenderContext ctx)
    {
        _node = node;
        _ctx = ctx;
        _spreadSubstitute = null; // the streamed node's data (possibly mutated in place) refreshed → rebuild the width clone lazily

        // 1. Record the streamed truth for all three tween-owned channels (kept even when a tween owns the write).
        StreamedLocal = local;
        HasPlacedTransform = true; // #11/Q6-A: a real local was just written here too, not only via SetLocalTransform —
        // SceneReconciler.HoldOrIdentity must be able to hold THIS view's last-known local on a later transient
        // global-miss/local-null drain (e.g. the in-hand discard select reparent) instead of collapsing to Identity.
        double modA = node.Modulate is { } m ? m.A : node.Opacity;
        double selfA = node.SelfModulate is { } s ? s.A : 1;
        StreamedModulate = ColorOf(node.Modulate, modA);
        StreamedSelfModulate = ColorOf(node.SelfModulate, selfA);

        // R6: refresh the identity-keyed card block scale + its local pivot BEFORE the ownership-gated Transform write
        // so FoldCosmetic folds it (and a re-sized LocalRect re-pivots it). Stable across light applies (identity +
        // rect don't change on a transform/tint-only drain), so ApplyLight reuses these fields without re-resolving.
        ResolveBlockScale(node);

        // WS-flameperf: resolve the flame's bottom-center paint-box pivot for the SAME reason/timing as the block
        // scale (before the ownership-gated Transform write, once per full Apply). The flame channels are identity for
        // every non-flame node, so this pivot only ever feeds FoldCosmetic on an actual flame quad; the paint box is
        // stable across a transform/tint light apply, so ApplyLight reuses it (parity with ResolveBlockScale).
        ResolveFlamePivot(node);

        // 2. Ownership-gated writes. Transform: skipped entirely while a tween owns it (else stream + cosmetic fold).
        // Modulate/SelfModulate: streamed rgb always; alpha preserved when a tween owns it.
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(StreamedLocal);
        }

        Modulate = TweenOwnsModulateA
            ? new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, Modulate.A)
            : new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, LatchedAlpha(TweenChannel.ModulateA, StreamedModulate.A, node.Visible));
        SelfModulate = TweenOwnsSelfModulateA
            ? new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, SelfModulate.A)
            : new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, LatchedAlpha(TweenChannel.SelfModulateA, StreamedSelfModulate.A, node.Visible));

        // Non-tweened static/structural properties. The QA forced-hide (hide/show verbs) is enforced against the
        // WIRE node at apply time — never a cached per-view flag — so pooled/recycled and fresh views all comply;
        // the Active guard makes this free when no selectors are set.
        Visible = node.Visible && !(QaForcedHide.Active && QaForcedHide.Matches(node));
        WriteZ(node);
        ShowBehindParent = node.ShowBehindParent;
        ClipChildren = (ClipChildrenMode)node.ClipChildren; // wire enum IS Godot's own enum (0/1/2)

        // 3. Material (blend mode now; WS-H adds the ShaderMaterial branch behind this seam).
        Material = MaterialResolver.For(this, node);

        // 4. Texture (consults the intent substitute when set).
        ResolveTexture(EffectiveNode, ctx.Textures);

        // 5. Effect attachments, in fixed order (each a no-op stub in the foundation; the WS agents fill them).
        ShaderAttachment.Sync(this, node, ctx);
        ParticleAttachment.Sync(this, node, ctx);
        SpineAttachment.Sync(this, node, ctx);
        // A map quill stroke's ENTIRE appearance is its Line2D geometry — the wire carries no localRect for it, so
        // TextureDrawer.PaintBox is null and this view's own _Draw contributes nothing. The `__line` child paints it.
        LineAttachment.Sync(this, node, ctx);
        IntentPlayer.Sync(this, node, ctx);
        CosmeticAnimator.Sync(this, node, ctx);

        // 6. Text renders as a child node (WS-F filled TextAttachment); stays last / frontmost. Routed through
        // EffectiveNode so text centered in a wide-screen-WIDENED span re-centers (web parity); identical to `node`
        // when there's no width override (SpreadWidth 0 → EffectiveNode is the same box).
        SyncText();

        RenderActivity.Mark(); // a full apply re-recorded this node — the stage must render this grace window
        QueueRedraw();
    }

    // WS-P2 LIGHT apply: the cheap subset of Apply for an EXISTING view whose change set is transform/tint-only
    // (SceneTreeApplier's differ, gated by SceneReconciler). It refreshes the retained node reference + the streamed
    // truth, then does exactly the ownership-gated Transform/Modulate/SelfModulate writes + Visible/ZIndex — the same
    // bookkeeping Apply steps 1–2 do — and DELIBERATELY SKIPS MaterialResolver, ResolveTexture, all five effect
    // Syncs, SyncText, and QueueRedraw: none of those inputs changed, and a transform/modulate/visibility change does
    // not require re-recording this node's canvas in Godot (the engine re-composes those at the scene-graph level).
    // A view only reaches here AFTER a prior full Apply (fresh + recycled views full-apply on acquisition), so _ctx
    // is already threaded and the effect children / material / texture are all already in their correct state.
    public void ApplyLight(MirrorNode node, Transform2D local)
    {
        _node = node;
        _spreadSubstitute = null; // the streamed node object changed → invalidate the width clone (rebuilt lazily)

        // 1. Streamed truth (identical to Apply step 1) — kept accurate even while a tween owns a channel.
        StreamedLocal = local;
        HasPlacedTransform = true; // #11/Q6-A: same stamp as Apply — the light path is a normal per-drain path too.
        double modA = node.Modulate is { } m ? m.A : node.Opacity;
        double selfA = node.SelfModulate is { } s ? s.A : 1;
        StreamedModulate = ColorOf(node.Modulate, modA);
        StreamedSelfModulate = ColorOf(node.SelfModulate, selfA);

        // 2. Ownership-gated writes (identical to Apply step 2) + Visible/ZIndex.
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(StreamedLocal);
        }

        Modulate = TweenOwnsModulateA
            ? new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, Modulate.A)
            : new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, LatchedAlpha(TweenChannel.ModulateA, StreamedModulate.A, node.Visible));
        SelfModulate = TweenOwnsSelfModulateA
            ? new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, SelfModulate.A)
            : new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, LatchedAlpha(TweenChannel.SelfModulateA, StreamedSelfModulate.A, node.Visible));

        // QA forced-hide enforced here too (same wire-node check as Apply — the light path re-writes Visible).
        Visible = node.Visible && !(QaForcedHide.Active && QaForcedHide.Matches(node));
        WriteZ(node);
    }

    // R11 light region re-crop. ApplyLight already refreshed `_node` (so EffectiveNode.TextureRegion is the new atlas
    // frame) and invalidated the spread substitute, but it DELIBERATELY skips QueueRedraw — a pure transform/tint light
    // apply changes no pixels this node records. A same-size atlas-FRAME swap (a Sprite2D flip-book flame) DOES change
    // this node's pixels though, so the drawer must re-run: Mark the render grace window + QueueRedraw so _Draw
    // re-samples the new crop. Called from the reconciler's light-apply sites when the change set carries the Region
    // flag (never on a plain transform/tint light apply — that stays QueueRedraw-free). ResolveTexture is NOT re-run
    // (the atlas URL is unchanged, so `_texture` is already correct — only the crop rect moved).
    public void MarkRegionRedraw()
    {
        RenderActivity.Mark();
        QueueRedraw();
    }

    // Write ZIndex from either the multi-region absolute-z override (ZAsRelative=false) or the wire's relative z. Called
    // from Apply/ApplyLight so a reconcile pass re-asserts an active override instead of clobbering it back to wire z.
    private void WriteZ(MirrorNode node)
    {
        if (_zOverride is { } z)
        {
            ZAsRelative = false;
            ZIndex = z;
        }
        else
        {
            ZAsRelative = true;
            ZIndex = node.ZIndex ?? 0;
        }
    }

    // Track-A keyframe SKIP: a keyframe re-parse produced a content-IDENTICAL node object for this id (ClassifyKeyframe
    // == None), so NO render work is owed — but repoint _node at the live store instance so NodeData stays reference-
    // consistent with state.Nodes (a later RefreshEffects / effect-attachment Sync must read the current instance, not
    // the detached pre-keyframe one). Deliberately touches NOTHING else: the Godot Transform/Modulate/etc. already hold
    // the correct pixels, and a live tween / cosmetic fold that owns the transform must not be stomped. Near-free.
    public void RebindNode(MirrorNode node)
    {
        _node = node;
        _spreadSubstitute = null; // the width-override clone was keyed off the old instance — rebuilt lazily on demand
    }

    // Reconcile the child text Label/RichTextLabel against the CURRENT EffectiveNode (which folds the wide-screen
    // width override). The per-label text-scale multiplier (mirrorTextScale.css port) is resolved here — cheaply,
    // only when the node actually has text — against the retained state (same parent-chain walk CosmeticAnimator
    // uses) and folded into the font size. Called from Apply AND from the SpreadWidth setter: a wide-screen width
    // override is stamped by the reconciler's spread pass AFTER Apply, so the box the text centers/right-aligns in
    // must be re-placed then too — otherwise a centered/right label keeps its un-widened Label size and its text
    // strands at the old box's center (the game-vs-web wide-screen off-center bug). No-op-cheap when nothing changed.
    private void SyncText()
    {
        var effective = EffectiveNode;
        bool hasText = effective.Text is { Text: { Length: > 0 } };

        // WS-P2 gate: no text now AND no "__text" label ever attached → skip the child probe entirely (the common
        // leaf case). A node that HAD text still reaches TextAttachment.Sync (hasText false, _hasTextChild true) to
        // tear its label down.
        if (!hasText && !_hasTextChild)
        {
            return;
        }

        // WS-P2: the per-label text metrics (scale + WS-TXT line-spacing ratios) come from the memoizing identity
        // cache (same values as the TextScale table walk); cheap — only when the node actually has text. The
        // TextureStore is threaded so the rich builder can fetch inline `[img]` energy-orb icons off the same cache.
        var m = hasText
            ? _ctx.IdentityCache.Resolve(effective.Id, _ctx.Store.State)
            : new SceneIdentityCache.Entry(null, null, 1.0);
        TextAttachment.Sync(this, effective, m.TextScale, m.LineHeight, m.ParagraphExtra, _ctx.Textures, m.MaxSizePx, m.Wrap, m.NudgeYPx);
        _hasTextChild = hasText; // after Sync the "__text" child exists iff the node has text

        // Track-B self-heal: when this node's text is promoted to the overlay, TextAttachment just (re-)created/updated
        // "__text" with Visible=true, so re-hide it here. Gated on _textPromoted so a NON-promoted node's SyncText is
        // byte-identical to pre-Track-B (a culled node is re-hidden by the post-Apply cull pass, not here).
        if (_textPromoted)
        {
            ReconcileTextVisibility();
        }
    }

    // Transform-only refresh (global-space cold path: a moved ancestor shifts an unchanged node's local). Keeps the
    // streamed-truth record accurate and respects tween ownership + the cosmetic fold.
    public void SetLocalTransform(Transform2D local)
    {
        StreamedLocal = local;
        HasPlacedTransform = true;
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(local);
        }
    }

    // ---- tween-channel handoff (WS-J / WS-T1) ----------------------------------------------------------------------

    // Snapshot the channel's CURRENT streamed truth. Called by TweenReplayer.Arm right before it takes ownership, so
    // SettleTween can later tell whether the wire kept streaming this channel during the tween (producer did NOT
    // suppress it) or held it pinned (the common case — the producer withholds a tweened channel's deltas).
    public void BeginTween(TweenChannel ch)
    {
        switch (ch)
        {
            case TweenChannel.Transform:
                _armedStreamedLocal = StreamedLocal;
                break;
            case TweenChannel.ModulateA:
                _armedStreamedModulateA = StreamedModulate.A;
                break;
            case TweenChannel.SelfModulateA:
                _armedStreamedSelfModulateA = StreamedSelfModulate.A;
                break;
        }
    }

    // Settle a finished tween: clear the channel's ownership flag and re-apply. `rawEnd` is the hint's UNFOLDED
    // endpoint (a Transform2D for the Transform channel, a double alpha for the modulate channels) — the value Arm
    // had before FoldForTween. If streamed truth is still bit-exactly what it was at BeginTween (the producer
    // suppressed this channel throughout, so it never caught up to the tween's own endpoint), adopt `rawEnd` into
    // streamed truth so the settle lands on the tween's actual endpoint instead of the stale pre-tween value; if
    // streamed truth already moved (a fresh, unsuppressed delta landed mid-tween), leave it alone — same as the old
    // blind resume. Either branch re-folds/applies through the normal path, so a spread/lift shift that changed
    // mid-tween is still picked up.
    public void SettleTween(TweenChannel ch, Variant rawEnd)
    {
        switch (ch)
        {
            case TweenChannel.Transform:
                if (StreamedLocal == _armedStreamedLocal)
                {
                    StreamedLocal = rawEnd.AsTransform2D();
                }

                TweenOwnsTransform = false;
                Transform = FoldCosmetic(StreamedLocal);
                break;
            case TweenChannel.ModulateA:
                if (StreamedModulate.A == _armedStreamedModulateA)
                {
                    StreamedModulate = new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, (float)rawEnd.AsDouble());
                }

                TweenOwnsModulateA = false;
                Modulate = new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, LatchedAlpha(TweenChannel.ModulateA, StreamedModulate.A, Visible));
                break;
            case TweenChannel.SelfModulateA:
                if (StreamedSelfModulate.A == _armedStreamedSelfModulateA)
                {
                    StreamedSelfModulate = new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, (float)rawEnd.AsDouble());
                }

                TweenOwnsSelfModulateA = false;
                SelfModulate = new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, LatchedAlpha(TweenChannel.SelfModulateA, StreamedSelfModulate.A, Visible));
                break;
        }
    }

    // ---- tween hide-latch (Feature B) -----------------------------------------------------------------------------

    // Arm the hide-latch on an opacity channel (called by TweenReplayer right when a fade-to-≈0 tween finishes, BEFORE
    // SettleTween). The resting SIGNATURE is the channel's arm-time streamed alpha (BeginTween's snapshot — the value
    // the producer restores to). Returns false (not armed / not registered) when that resting value was itself already
    // ≈0 (nothing visible to flash). Idempotent-safe: re-arming refreshes the clock.
    public bool TryArmHideLatch(TweenChannel ch)
    {
        switch (ch)
        {
            case TweenChannel.ModulateA:
                if (_armedStreamedModulateA <= (float)HideLatchPolicy.AlphaEps)
                {
                    return false;
                }

                _hideLatchModulateA = true;
                _hideRestingModulateA = _armedStreamedModulateA;
                _hideArmMsModulateA = Time.GetTicksMsec();
                _hideHeldRestoreMsModulateA = 0; // fresh latch: the held-restore clock starts on the first resting Hold
                break;
            case TweenChannel.SelfModulateA:
                if (_armedStreamedSelfModulateA <= (float)HideLatchPolicy.AlphaEps)
                {
                    return false;
                }

                _hideLatchSelfModulateA = true;
                _hideRestingSelfModulateA = _armedStreamedSelfModulateA;
                _hideArmMsSelfModulateA = Time.GetTicksMsec();
                _hideHeldRestoreMsSelfModulateA = 0; // fresh latch: the held-restore clock starts on the first resting Hold
                break;
            default:
                return false; // the transform channel never latches
        }

        if (HideLatchDebug)
        {
            GD.Print($"M1D_HIDELATCH: armed id={NodeId} ch={ch} resting={RestingOf(ch):0.###}");
        }

        return true;
    }

    // The SHARED latched-alpha helper at the three streamed-alpha write sites (Apply, ApplyLight, SettleTween). When
    // the channel is latched it runs HideLatchPolicy over the incoming streamed alpha: Hold → write the hidden 0
    // (clamping the resting flash); Cancel/Expire → release the latch and write the incoming through. It is a bare
    // passthrough when nothing is latched.
    private float LatchedAlpha(TweenChannel ch, float incoming, bool visible)
    {
        if (!IsHideLatched(ch))
        {
            return incoming;
        }

        ulong nowMs = Time.GetTicksMsec();
        double elapsed = (double)(nowMs - ArmMsOf(ch));
        // The held-restore clock feeds the ≥150ms short expiry; null means it has not started yet.
        double? heldRestoreElapsed = HeldRestoreElapsedOf(ch, nowMs);
        var decision = HideLatchPolicy.Decide(true, RestingOf(ch), incoming, visible, elapsed, heldRestoreElapsed);
        if (decision == HideLatchPolicy.Decision.Hold)
        {
            // Start the held-restore clock on the FIRST resting-valued (>AlphaEps) Hold — a ≈0 write never starts it,
            // so the settle / a hidden re-affirm keeps the full 400ms grace and only a genuine visible restore expires.
            if (incoming > (float)HideLatchPolicy.AlphaEps && HeldRestoreMsOf(ch) == 0)
            {
                SetHeldRestoreMs(ch, nowMs);
            }

            if (HideLatchDebug && incoming > (float)HideLatchPolicy.AlphaEps)
            {
                GD.Print($"M1D_HIDELATCH: clamped id={NodeId} ch={ch} incoming={incoming:0.###}->0");
            }

            return 0f; // clamp the flash (or keep the ≈0 hidden state)
        }

        // Cancel / Expire: release the latch (unregister from the sweep registry) and write the incoming through.
        DropHideLatch(ch, decision == HideLatchPolicy.Decision.Expire ? "expired" : "cancelled");
        return incoming;
    }

    // Sweep entry (TweenReplayer's per-drain + per-frame sweep, drain-starvation safety): drop + log the latch when its
    // grace elapsed. Returns true when it dropped (the caller unregisters). No streamed write is needed to expire.
    public bool SweepHideLatch(TweenChannel ch)
    {
        if (!IsHideLatched(ch))
        {
            return true; // already gone → let the caller prune the registry entry
        }

        ulong nowMs = Time.GetTicksMsec();
        bool graceExpired = (double)(nowMs - ArmMsOf(ch)) >= HideLatchPolicy.GraceMs;
        // WS-REST held-restore short expiry: a latch that has been clamping a resting-valued re-show for ≥150ms with no
        // hide catching up is a genuine (hint-less) reveal — release it here, since the rest-site case ships no further
        // delta to run LatchedAlpha.
        double? heldRestoreElapsed = HeldRestoreElapsedOf(ch, nowMs);
        bool heldExpired = heldRestoreElapsed is >= HideLatchPolicy.HeldRestoreGraceMs;

        if (graceExpired || heldExpired)
        {
            ClearHideLatchField(ch);
            // Self-heal: today the sweep only cleared the flag, leaving the channel stuck at the clamped 0 forever when
            // no further streamed write arrives (the rest-site defect). Re-apply the streamed (resting) alpha so the
            // node reappears with zero further deltas — but only when a tween doesn't own the channel (else the tween
            // owns the visible alpha and we must not fight it).
            ReapplyStreamedAlphaAfterLatch(ch);

            if (HideLatchDebug)
            {
                GD.Print($"M1D_HIDELATCH: expired id={NodeId} ch={ch}{(heldExpired && !graceExpired ? " (held-restore)" : string.Empty)}");
            }

            return true;
        }

        return false;
    }

    // Sweep self-heal: re-write the streamed (resting) alpha onto the base prop after a latch expiry so a node that was
    // clamped to 0 and got no further delta becomes visible again. No-op while a tween owns the channel.
    private void ReapplyStreamedAlphaAfterLatch(TweenChannel ch)
    {
        switch (ch)
        {
            case TweenChannel.ModulateA when !TweenOwnsModulateA:
                Modulate = new Color(StreamedModulate.R, StreamedModulate.G, StreamedModulate.B, StreamedModulate.A);
                break;
            case TweenChannel.SelfModulateA when !TweenOwnsSelfModulateA:
                SelfModulate = new Color(StreamedSelfModulate.R, StreamedSelfModulate.G, StreamedSelfModulate.B, StreamedSelfModulate.A);
                break;
            default:
                return;
        }

        RenderActivity.Mark(); // the stage must render the frame that re-reveals this node
        QueueRedraw();
    }

    // Registry-initiated drop (a new tween superseding, a view release, teardown): clear the field only — the registry
    // side already removed its entry, so this must NOT re-unregister. Idempotent.
    public void ForceDropHideLatch(TweenChannel ch) => ClearHideLatchField(ch);

    // Write-site-initiated drop: clear the field AND unregister from the sweep registry (the write helper observed a
    // cancel/expire before the sweep did).
    private void DropHideLatch(TweenChannel ch, string reason)
    {
        ClearHideLatchField(ch);
        if (HideLatchDebug && reason == "expired")
        {
            GD.Print($"M1D_HIDELATCH: expired id={NodeId} ch={ch}");
        }

        TweenReplayer.UnregisterHideLatch(NodeId, ch);
    }

    private void ClearHideLatchField(TweenChannel ch)
    {
        switch (ch)
        {
            case TweenChannel.ModulateA:
                _hideLatchModulateA = false;
                _hideHeldRestoreMsModulateA = 0;
                break;
            case TweenChannel.SelfModulateA:
                _hideLatchSelfModulateA = false;
                _hideHeldRestoreMsSelfModulateA = 0;
                break;
        }
    }

    // The held-restore clock's raw stamp (0 = not started) and optional elapsed duration.
    private ulong HeldRestoreMsOf(TweenChannel ch) => ch switch
    {
        TweenChannel.ModulateA => _hideHeldRestoreMsModulateA,
        TweenChannel.SelfModulateA => _hideHeldRestoreMsSelfModulateA,
        _ => 0,
    };

    private double? HeldRestoreElapsedOf(TweenChannel ch, ulong nowMs)
    {
        ulong stamp = HeldRestoreMsOf(ch);
        return stamp == 0 ? null : (double)(nowMs - stamp);
    }

    private void SetHeldRestoreMs(TweenChannel ch, ulong ms)
    {
        switch (ch)
        {
            case TweenChannel.ModulateA:
                _hideHeldRestoreMsModulateA = ms;
                break;
            case TweenChannel.SelfModulateA:
                _hideHeldRestoreMsSelfModulateA = ms;
                break;
        }
    }

    private bool IsHideLatched(TweenChannel ch) => ch switch
    {
        TweenChannel.ModulateA => _hideLatchModulateA,
        TweenChannel.SelfModulateA => _hideLatchSelfModulateA,
        _ => false,
    };

    private float RestingOf(TweenChannel ch) => ch switch
    {
        TweenChannel.ModulateA => _hideRestingModulateA,
        TweenChannel.SelfModulateA => _hideRestingSelfModulateA,
        _ => 1f,
    };

    private ulong ArmMsOf(TweenChannel ch) => ch switch
    {
        TweenChannel.ModulateA => _hideArmMsModulateA,
        TweenChannel.SelfModulateA => _hideArmMsSelfModulateA,
        _ => 0,
    };

    // ---- cosmetic animators (WS-J) --------------------------------------------------------------------------------

    // Parent-frame px offset folded into the transform origin (the intent bob). Writing it re-folds immediately,
    // unless a tween owns the transform (then the offset applies on the next non-owned Apply/Resume).
    public Vector2 CosmeticOffset
    {
        get => _cosmeticOffset;
        set
        {
            _cosmeticOffset = value;
            RenderActivity.Mark(); // the bob ticker re-folds the transform each frame with NO QueueRedraw — Mark here
            if (!TweenOwnsTransform)
            {
                Transform = FoldCosmetic(StreamedLocal);
            }
        }
    }

    // Input-side cosmetic lift (M1e; parent-frame px), folded into the transform origin additively with
    // CosmeticOffset. Writing it re-folds immediately unless a tween owns the transform (then it applies on the next
    // non-owned Apply/Resume). WS-M is the sole writer (see the _liftOffset field note).
    public Vector2 LiftOffset
    {
        get => _liftOffset;
        set
        {
            _liftOffset = value;
            RenderActivity.Mark(); // input-driven lift re-folds the transform with NO QueueRedraw — Mark here
            if (!TweenOwnsTransform)
            {
                Transform = FoldCosmetic(StreamedLocal);
            }
        }
    }

    // ---- wide-screen re-layout (M2; sole writer: SceneReconciler's spread pass) -----------------------------------

    // The parent-frame px shift folded into the transform origin additively with CosmeticOffset + LiftOffset (the
    // third FoldCosmetic channel). Writing it re-folds immediately unless a tween owns the transform (then it applies
    // on the next non-owned Apply/Resume, and armed tween endpoints already carry it via FoldForTween). Early-outs on
    // an unchanged value so the reconciler's per-view stamp is near-free at steady state.
    public Vector2 SpreadOffset
    {
        get => _spreadOffset;
        set
        {
            if (_spreadOffset == value)
            {
                return;
            }

            _spreadOffset = value;
            RenderActivity.Mark(); // wide-screen re-layout shifted this node — the stage must render (also covered by the Drained/SpreadChanged marks)
            if (!TweenOwnsTransform)
            {
                Transform = FoldCosmetic(StreamedLocal);
            }
        }
    }

    // The anchor-widened painted box width (design px; 0 = no override). Applied as a rect-WIDTH substitute through
    // EffectiveNode (all drawers paint the widened box with ZERO edits) — never a scale. Invalidates the cached clone
    // + re-resolves the texture (a widened region/atlas base) and redraws. Early-outs on an unchanged value.
    public double SpreadWidth
    {
        get => _spreadWidth;
        set
        {
            if (_spreadWidth == value)
            {
                return;
            }

            _spreadWidth = value;
            _spreadSubstitute = null;
            if (_ctx is not null)
            {
                ResolveTexture(EffectiveNode, _ctx.Textures);
                // Re-place/re-size the child text against the widened box so a center/right-aligned label re-centers
                // within the new width (web CSS width parity). Without this the box paints widened but the text
                // stays centered in the OLD width — the wide-screen off-center text bug. Cheap: only when the node
                // has text (TextAttachment.Sync early-returns otherwise).
                SyncText();
            }

            RenderActivity.Mark(); // a widened paint box changed this node's pixels
            QueueRedraw();
        }
    }

    // ---- HoverTip 1.2× scale channel (Feature A; sole writer: HoverTipScaler's per-drain pass) --------------------

    // Set the hover-tip scale factor + parent-frame pivot + parent-frame clamp translation. Early-outs (byte-identical)
    // when nothing changed, so a steady tip re-stamps for free and — crucially — the switch-OFF path (never called at
    // all) leaves _hoverScale at 1 and the FoldCosmetic early-out intact. Re-folds immediately unless a tween owns the
    // transform (then it applies on the next non-owned Apply/Resume, exactly like the additive cosmetic setters).
    public void SetHoverTipScale(float scale, Vector2 pivot, Vector2 clampOffset)
    {
        if (_hoverScale == scale && _hoverScalePivot == pivot && _hoverClampOffset == clampOffset)
        {
            return;
        }

        _hoverScale = scale;
        _hoverScalePivot = pivot;
        _hoverClampOffset = clampOffset;
        RenderActivity.Mark(); // the tip grew/shrank/moved — the stage must render this grace window
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(StreamedLocal);
        }
    }

    // ---- self-paint suppression toggles (M3 CULL + Track-D StaticBake) -------------------------------------------

    // Set/clear the CULL bit (sole caller: SceneReconciler's cull pass). Composes with the Baked bit below.
    public void SetSelfPaintCulled(bool culled) => SetSuppressBit(SelfPaintSuppress.Culled, culled);

    // Set/clear the BAKE bit (sole caller: the StaticBake controller — set on swap-to-Active, cleared on invalidate).
    public void SetSelfPaintBaked(bool baked) => SetSuppressBit(SelfPaintSuppress.Baked, baked);

    // Track-P3 multi-region: stamp/clear the absolute-effZ override (sole caller: the StaticBake controller — set on
    // swap-to-Active for LIVE band painters that interleave between region quads, cleared on invalidate). Applies the z
    // immediately (a live particle is stable, so no full Apply is otherwise pending). Idempotent-safe.
    public void SetZOverride(int z)
    {
        _zOverride = z;
        ZAsRelative = false;
        ZIndex = z;
        RenderActivity.Mark();
        QueueRedraw();
    }

    public void ClearZOverride()
    {
        if (_zOverride is null)
        {
            return;
        }

        _zOverride = null;
        ZAsRelative = true;
        ZIndex = _node?.ZIndex ?? 0;
        RenderActivity.Mark();
        QueueRedraw();
    }

    // Track-C: set/clear the HOIST bit (sole caller: the CardLayer controller — set the frame it clones this card
    // member onto the card layer, cleared the frame it demotes). Suppresses the live member's in-stage self-paint (+
    // "__text") so it doesn't double-draw under the crisp clone; the card layer's holder-visibility sync reads
    // SelfPaintCulledOrBaked (below) so this bit never hides the clone.
    public void SetSelfPaintHoisted(bool hoisted) => SetSuppressBit(SelfPaintSuppress.Hoisted, hoisted);

    // Track-B: mark/unmark this node's text as promoted to the native-resolution overlay (sole caller: the TextOverlay
    // controller — set the frame it builds the proxy, cleared the frame it demotes). Hides ONLY the in-stage "__text"
    // child (never the node's own drawer content), so a button keeps its fill while its label renders crisp above.
    // Marks RenderActivity so the stage renders the hide/show. Idempotent (no-op when unchanged → no needless mark).
    public void SetTextPromoted(bool promoted)
    {
        if (_textPromoted == promoted)
        {
            return;
        }

        _textPromoted = promoted;
        ReconcileTextVisibility();
        RenderActivity.Mark(); // the in-stage text just hid/showed — the stage must render this grace window
    }

    // True while ANY suppression bit is set (cull / bake / hoist). The TextOverlay controller reads this so a proxy
    // hides in lockstep with a suppressed owner (a card member that got hoisted has its stale text proxy hidden here
    // until the next text-overlay eval demotes it).
    public bool SelfPaintSuppressed => _selfPaintSuppress != SelfPaintSuppress.None;

    // Track-C: true while a CULL or BAKE bit is set, IGNORING the Hoisted bit. The CardLayer controller's per-frame
    // holder-visibility sync uses THIS (not SelfPaintSuppressed) so a hoisted card — which is on-screen and whose
    // crisp clone must show — doesn't self-blind its own holder, while a culled (off-screen) / baked owner still hides
    // the holder in lockstep.
    public bool SelfPaintCulledOrBaked => (_selfPaintSuppress & ~SelfPaintSuppress.Hoisted) != SelfPaintSuppress.None;

    // The node the text sub-layer actually configures from: the intent substitute (WS-J) when set, else the streamed
    // node, width-adjusted for the wide-screen anchor override. The TextOverlay controller builds its native proxy
    // from THIS (the exact same MirrorNode SyncText hands TextBuilder) so the overlay layout matches the in-stage one.
    public MirrorNode TextEffectiveNode => EffectiveNode;

    // Track E (measured text extents): the ACTUAL laid-out glyph box of this node's in-stage "__text" child, in THIS
    // view's LOCAL frame (the controller multiplies by GetGlobalTransform() for the design-space AABB the planner
    // consumes). The child Control fills the node's streamed rect (Position/Size), but the glyphs occupy only a
    // sub-region of it — a centered/right-aligned counter (HP, gold, energy) sits AWAY from the rect's left edge — so
    // the planner's blanket rect+24 halo phantom-blocks the label against an adjacent icon. This returns the tight,
    // ALIGNMENT-AWARE glyph box (natural text advance size positioned by h/v alignment within the box, extended by the
    // outline + shadow ink that fall OUTSIDE the advance box). false when there is no "__text" child yet or the label
    // has not shaped (measurement unreliable) → the planner falls back to its conservative rect+24 guess for this id.
    // WS-CRISP v3: a shadow whose stamped color alpha is at or below this does not EXTEND the measured ink box (the
    // shadow still renders — but inverting the paint order of a ≤30%-alpha smudge sliver against an adjacent icon is
    // imperceptible, while treating it as opaque ink phantom-blocks the TopBar floor number and the hover-tip title).
    private const float LowAlphaShadowMax = 0.30f;

    // WS-CRISP v3: cap the measured OUTLINE extension at the stroke width the mega_text MSDF fonts actually rasterize.
    // The game stamps outline_size values like 12 (the TopBar floor number), but an MSDF font's outline stroke is
    // clamped by its SDF pixel range — the rendered rim measures ~3.5 design px (verified on the crisp deck-count
    // proxy). Counting the full stamped 12 phantom-extends every outlined label ~8px into whatever sits beside it.
    private const float OutlineInkCapPx = 4f;

    public bool TryGetTextGlyphRect(out Rect2 glyph) => TryGetTextGlyphRect(out glyph, exemptLowAlphaShadow: false);

    public bool TryGetTextGlyphRect(out Rect2 glyph, bool exemptLowAlphaShadow) =>
        TryGetTextGlyphRect(out glyph, exemptLowAlphaShadow, tightRichWidth: false);

    // WS-EVENTTEXT #14 Leg B: `tightRichWidth` (default false → byte-identical for every existing caller) narrows the
    // HORIZONTAL extent of a SINGLE-LINE RichTextLabel to its real laid-out ink (GetContentWidth positioned by the
    // label's HorizontalAlignment) instead of the full box width. The ancient-event name banner ("NEOW") is a
    // full-SCREEN-box, single-line, Left-aligned MegaRichTextLabel whose glyphs occupy only the bottom-left corner; the
    // full-box-width measurement made it a screen-wide in-stage text BLOCKER that phantom-occluded the last event
    // option (design-verified: the option sits well to the right of the drawn "NEOW"). Only the OCCLUDER-role
    // measurement passes true (TextOverlay._textBlockerExtents); the candidate-role measurement keeps the conservative
    // full box width (a wrapped/mixed-alignment candidate must never UNDER-cover). Guarded to a single visible line +
    // a Left/Center/Right (not Fill) alignment + a content width strictly inside the box, so it can only ever SHRINK
    // the box toward the drawn art — never claim ink the label does not paint.
    public bool TryGetTextGlyphRect(out Rect2 glyph, bool exemptLowAlphaShadow, bool tightRichWidth)
    {
        glyph = default;
        if (GetNodeOrNull<Control>(TextChildPath) is not { } text)
        {
            return false;
        }

        Vector2 boxPos = text.Position;
        Vector2 boxSize = text.Size;
        float x0, y0, x1, y1;

        if (text is RichTextLabel rtl)
        {
            // RichTextLabel has no minimum-size text metric; use its laid-out content extent. Alignment is via bbcode
            // paragraphs WITHIN the box width (WordSmart wrap), so keep the full box width horizontally (conservative —
            // never under-covers a wrapped/aligned line) and tighten VERTICALLY to the real content height (card
            // descriptions leave large empty vertical space in their box). Position.Y already carries the valign nudge.
            float ch = rtl.GetContentHeight();
            if (ch <= 0.5f)
            {
                return false; // not shaped yet → fall back
            }

            y0 = boxPos.Y;
            y1 = boxPos.Y + ch;

            // tightRichWidth (occluder-role only): for a single visible line with a uniform (non-Fill) alignment the
            // drawn ink is exactly GetContentWidth() wide, positioned by that alignment — so shrink to it. Any wrap
            // (GetLineCount > 1), a Fill alignment, or a content width that already fills the box keeps the full width.
            float cw = tightRichWidth ? rtl.GetContentWidth() : 0f;
            bool tightable = tightRichWidth && rtl.GetLineCount() <= 1 && cw > 0.5f && cw < boxSize.X
                && rtl.HorizontalAlignment is HorizontalAlignment.Left or HorizontalAlignment.Center
                    or HorizontalAlignment.Right;
            if (tightable)
            {
                x0 = rtl.HorizontalAlignment switch
                {
                    HorizontalAlignment.Center => boxPos.X + ((boxSize.X - cw) / 2f),
                    HorizontalAlignment.Right => boxPos.X + boxSize.X - cw,
                    _ => boxPos.X, // Left
                };
                x1 = x0 + cw;
            }
            else
            {
                x0 = boxPos.X;
                x1 = boxPos.X + boxSize.X;
            }
        }
        else
        {
            var label = (Label)text;
            Vector2 natural = label.GetMinimumSize(); // the text's natural advance box (autowrap Off → full text size)
            float tw = natural.X;
            float th = natural.Y;
            if (th <= 0.5f)
            {
                return false;
            }

            // Horizontal placement of the glyphs within the box (overflow extends OUTSIDE the box for Left/Center/Right,
            // exactly as Godot draws with ClipText=false — that is the real extent the blanket slack was approximating).
            switch (label.HorizontalAlignment)
            {
                case HorizontalAlignment.Center:
                    x0 = boxPos.X + ((boxSize.X - tw) / 2f);
                    x1 = x0 + tw;
                    break;
                case HorizontalAlignment.Right:
                    x1 = boxPos.X + boxSize.X;
                    x0 = x1 - tw;
                    break;
                case HorizontalAlignment.Fill:
                    x0 = boxPos.X;
                    x1 = boxPos.X + Mathf.Max(tw, boxSize.X);
                    break;
                default: // Left
                    x0 = boxPos.X;
                    x1 = boxPos.X + tw;
                    break;
            }

            switch (label.VerticalAlignment)
            {
                case VerticalAlignment.Center:
                    y0 = boxPos.Y + ((boxSize.Y - th) / 2f);
                    y1 = y0 + th;
                    break;
                case VerticalAlignment.Bottom:
                    y1 = boxPos.Y + boxSize.Y;
                    y0 = y1 - th;
                    break;
                case VerticalAlignment.Fill:
                    y0 = boxPos.Y;
                    y1 = boxPos.Y + Mathf.Max(th, boxSize.Y);
                    break;
                default: // Top
                    y0 = boxPos.Y;
                    y1 = boxPos.Y + th;
                    break;
            }
        }

        // Outline + shadow ink render OUTSIDE the advance/content box, so extend the glyph box to cover them (both are
        // theme overrides TextBuilder stamps only when present). Shadow extends only in its offset direction.
        // WS-CRISP v3 (exemptLowAlphaShadow): a NEAR-TRANSPARENT shadow (alpha ≤ LowAlphaShadowMax — the TopBar floor
        // number's is 0.125, the hover-tip title's 0.25) is not counted as ink, so the tail it would add no longer
        // phantom-extends the label under an exactly-adjacent icon. An opaque shadow still extends the box.
        float outline = text.HasThemeConstantOverride("outline_size") ? text.GetThemeConstant("outline_size") : 0f;
        float shX = text.HasThemeConstantOverride("shadow_offset_x") ? text.GetThemeConstant("shadow_offset_x") : 0f;
        float shY = text.HasThemeConstantOverride("shadow_offset_y") ? text.GetThemeConstant("shadow_offset_y") : 0f;
        if (exemptLowAlphaShadow)
        {
            outline = Mathf.Min(outline, OutlineInkCapPx); // v3: MSDF stroke clamp (see OutlineInkCapPx)
        }

        if (exemptLowAlphaShadow && (shX != 0f || shY != 0f))
        {
            float shadowAlpha = text.HasThemeColorOverride("font_shadow_color")
                ? text.GetThemeColor("font_shadow_color").A
                : 1f; // offsets stamped but no color → assume opaque (conservative)
            if (shadowAlpha <= LowAlphaShadowMax)
            {
                shX = 0f;
                shY = 0f;
            }
        }

        x0 -= outline + Mathf.Max(0f, -shX);
        y0 -= outline + Mathf.Max(0f, -shY);
        x1 += outline + Mathf.Max(0f, shX);
        y1 += outline + Mathf.Max(0f, shY);

        glyph = new Rect2(x0, y0, x1 - x0, y1 - y0);
        return true;
    }

    // WS-CRISP v3 (occluder-box tightening): the tight DRAWN-ART rect of this view's own texture, in view-LOCAL space
    // (the controller multiplies by GetGlobalTransform for the design-space box the planner consumes as a blocker).
    // Uses the DECODE-TIME alpha used-rect + intrinsic size TextureStore captured (see RecordArtInfo), mapped through
    // the node's stretch mode into its layout rect:
    //   STRETCH_SCALE (0)                — art fills the rect; the used-rect maps per-axis proportionally.
    //   STRETCH_KEEP_ASPECT_CENTERED (5) — art is aspect-fit + centered (letterboxed); map the used-rect within that
    //                                      drawn sub-rect. This is what v2's region-letterbox could not do for a
    //                                      texture that streams NO TextureRegion (the TopBar room icons).
    // False for every other/unknown stretch mode, region'd (atlas) textures (the used-rect is of the whole page),
    // nine-patches (margins re-stretch content), and un-decoded / compressed-path textures — the planner then keeps
    // the conservative full layout-rect blocker box, exactly as v2.
    public bool TryGetBlockerArtRect(TextureStore textures, out Rect2 local, out Rect2? localHole)
    {
        local = default;
        localHole = null;
        var node = EffectiveNode;
        if (node.TextureUrl is not { } url || node.TextureRegion is not null || node.NinePatch
            || node.TextureStretchMode is not (0 or 5))
        {
            return false;
        }

        var rect = node.LocalRect;
        if (rect is null || rect.Width <= 0 || rect.Height <= 0
            || !textures.TryGetArtInfo(url, out var used, out var size, out var hole)
            || size.X <= 0 || size.Y <= 0 || used.Size.X <= 0 || used.Size.Y <= 0)
        {
            return false;
        }

        double rx = rect.X, ry = rect.Y, rw = rect.Width, rh = rect.Height;
        if (node.TextureStretchMode == 5)
        {
            // Letterbox: aspect-fit the WHOLE texture into the rect, centered; the art occupies used*scale within it.
            double scale = System.Math.Min(rw / size.X, rh / size.Y);
            double ox = rx + ((rw - (size.X * scale)) / 2.0);
            double oy = ry + ((rh - (size.Y * scale)) / 2.0);
            local = MapRect(used, ox, oy, scale, scale);
            localHole = hole is { } hp ? MapRect(hp, ox, oy, scale, scale) : null;
        }
        else
        {
            // Plain scale: per-axis proportional mapping.
            double sx = rw / size.X, sy = rh / size.Y;
            local = MapRect(used, rx, ry, sx, sy);
            localHole = hole is { } hp ? MapRect(hp, rx, ry, sx, sy) : null;
        }

        return true;
    }

    // Map a texture-space Rect2I into the drawn frame (origin + per-axis scale).
    private static Rect2 MapRect(Rect2I texRect, double ox, double oy, double sx, double sy) => new(
        (float)(ox + (texRect.Position.X * sx)), (float)(oy + (texRect.Position.Y * sy)),
        (float)(texRect.Size.X * sx), (float)(texRect.Size.Y * sy));

    // Reconcile the in-stage "__text" child's visibility from BOTH gates: it is visible only when the node's own paint
    // is not suppressed (cull/bake) AND its text is not promoted to the overlay. Called from SetSuppressBit,
    // SetTextPromoted, and the tail of SyncText (so any re-Apply that re-creates/re-shows the label immediately
    // re-hides it per the retained flags). A cheap child probe; a no-op when there is no "__text" child.
    private void ReconcileTextVisibility()
    {
        if (GetNodeOrNull<Control>(TextChildPath) is { } text)
        {
            bool want = _selfPaintSuppress == SelfPaintSuppress.None && !_textPromoted;
            if (text.Visible != want)
            {
                text.Visible = want; // guarded: never a redundant write (keeps the OFF path byte-identical to pre-Track-B)
            }
        }
    }

    // Toggle ONE suppression bit, reconcile the "__text" child, and redraw on an own-paint flip. While the merged
    // field is non-zero the node's own paint is skipped; text visibility is RE-ASSERTED every call (Apply → SyncText
    // may have just re-shown the text, and the cull/bake passes run after Apply) via ReconcileTextVisibility. The
    // QueueRedraw fires only on an actual suppressed↔visible flip (near-free for a node that stays fully painted).
    // Preserves the exact pre-Track-D cull semantics when only the Culled bit is ever used.
    private void SetSuppressBit(SelfPaintSuppress bit, bool on)
    {
        var previous = _selfPaintSuppress;
        if (on)
        {
            _selfPaintSuppress |= bit;
        }
        else
        {
            _selfPaintSuppress &= ~bit;
        }

        ReconcileTextVisibility();

        if ((previous != SelfPaintSuppress.None) != (_selfPaintSuppress != SelfPaintSuppress.None))
        {
            QueueRedraw(); // own-paint suppressed↔visible flip — re-record this node's canvas
        }
    }

    // Track-D: true when this view has NO pending texture fetch — it paints no texture, or the one it wants has
    // decoded. The StaticBake controller excludes a not-yet-settled node from a bake (baking it would freeze a blank).
    public bool TextureSettled => _wantUrl is null || _texture is not null;

    // WS-CRISP R18: TextureSettled OR the pending fetch has PERMANENTLY failed. A permanently-failed url never
    // decodes (Request returns null with no callback), so the live view is frozen blank forever — a clone/promotion
    // gated on TextureSettled would be forgone forever too, leaving the card/text mushy in-stage. Since the promoted
    // clone would paint the same blank, so a failed member is safe to treat as settled. Consumed by
    // SceneReconciler.CollectUnsettledTextures.
    public bool TextureSettledOrFailed() =>
        TextureSettled
        || (_pendingFetchUrl is { } f && _ctx is { } c && c.Textures.IsFailed(f));

    // WS-CRISP dumpcrisp accessors: the wire texture identity currently wanted, the in-flight TextureStore fetch url,
    // and whether that fetch has permanently failed — reported per unsettled card/text member so a device capture
    // names exactly which url is the black hole.
    public string? WantUrl => _wantUrl;

    public string? PendingFetchUrl => _pendingFetchUrl;

    public bool TextureFailed => _pendingFetchUrl is { } f && _ctx is { } c && c.Textures.IsFailed(f);

    // Expose the cosmetic fold so TweenReplayer folds a tween's END (and START) transform endpoints. Without this a
    // tweened node on a widened stage animates to the UN-shifted endpoint and snaps to the shifted resting placement
    // on finish (the web stashes record.spreadDx for exactly this). At factor 1 with no cosmetic offsets FoldCosmetic
    // is identity → byte-identical replay.
    public Transform2D FoldForTween(Transform2D endpoint) => FoldCosmetic(endpoint);

    // Build (or return the cached) width-override clone of `source`. A shallow MirrorNode.Clone with LocalRect.Width
    // replaced by SpreadWidth; the clone is independent (leaf records immutable), so mutating its rect never touches
    // the streamed node. Cache keyed by the source reference; invalidated whenever the streamed/intent node refreshes
    // (Apply / SetIntentFrame) or SpreadWidth changes, so an in-place-mutated node never reads a stale clone.
    private MirrorNode WidthAdjusted(MirrorNode source)
    {
        if (_spreadWidth <= 0 || source.LocalRect is not { } lr)
        {
            return source;
        }

        if (_spreadSubstitute is not null && ReferenceEquals(_spreadSubstituteSource, source))
        {
            return _spreadSubstitute;
        }

        var clone = source.Clone();
        clone.LocalRect = lr with { Width = _spreadWidth };
        _spreadSubstitute = clone;
        _spreadSubstituteSource = source;
        return clone;
    }

    // In-place spin (radians) applied in _Draw about the paint-box center — the orb rotation layers. Leaf-only.
    public float CosmeticSpin
    {
        get => _cosmeticSpin;
        set
        {
            if (_cosmeticSpin == value)
            {
                return;
            }

            _cosmeticSpin = value;
            RenderActivity.Mark(); // the orb-spin ticker rotates this leaf each frame
            QueueRedraw();
        }
    }

    // Q1 flame loop: scale.Y multiplier (1 = identity) about the paint-box bottom-center. Set by CosmeticAnimator's
    // flame ticker; Leaf-only (flame quads). Zero-cost early-out on an unchanged value. WS-flameperf: with the fold
    // (default) it re-folds the Transform via FoldCosmetic — NO QueueRedraw, exactly like the intent bob's
    // CosmeticOffset (the flame quad's canvas item is unchanged, so the render server composes the new transform with
    // no CPU re-record) — deferred while a tween owns the transform.
    public float CosmeticScaleY
    {
        get => _cosmeticScaleY;
        set
        {
            if (_cosmeticScaleY == value)
            {
                return;
            }

            _cosmeticScaleY = value;
            RenderActivity.Mark(); // the flame ticker rescales this quad — the stage must render this grace window
            ApplyFlameChannelWrite();
        }
    }

    // Q1 flame loop: skew in radians (0 = identity), same bottom-center pivot as CosmeticScaleY.
    public float CosmeticSkew
    {
        get => _cosmeticSkew;
        set
        {
            if (_cosmeticSkew == value)
            {
                return;
            }

            _cosmeticSkew = value;
            RenderActivity.Mark(); // the flame ticker skews this quad — the stage must render this grace window
            ApplyFlameChannelWrite();
        }
    }

    // Shared tail for both flame-channel setters. It re-folds the Transform without QueueRedraw, gated on
    // !TweenOwnsTransform like the bob. FoldForTween keeps a tween's endpoints composed and the ticker holds the last
    // value while a tween owns it. Both channels share the pivot, so a scaleY+skew pair re-folds once each.
    private void ApplyFlameChannelWrite()
    {
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(StreamedLocal);
        }
    }

    // ---- intent frame substitution (WS-J) -------------------------------------------------------------------------

    // Swap in a shallow node clone carrying frame-i texture fields (or null to revert to the streamed node). Re-
    // resolves the texture off the retained render context and redraws.
    public void SetIntentFrame(MirrorNode? frameSubstitute)
    {
        _intentSubstitute = frameSubstitute;
        _spreadSubstitute = null; // the width-override base changed (intent swap) → rebuild the clone lazily
        if (_ctx is not null)
        {
            ResolveTexture(EffectiveNode, _ctx.Textures);
        }

        RenderActivity.Mark(); // the intent ticker swapped this frame's texture (drives every later intent frame)
        QueueRedraw();
    }

    // ---- draw -----------------------------------------------------------------------------------------------------

    public override void _Draw()
    {
        DrawInvocations++; // WS-flameperf: a canvas-item re-record (counted before the suppression early-out — the
        // engine invoked _Draw regardless). The flame fold's win is that folded flame quads never reach here per frame.

        // Self-paint suppressed (CULL: own box off-screen, and/or Track-D: pixels already in the pre-composited bake
        // quad). Skip ALL own drawer content; child views + effect canvases still draw (separate child nodes). Never
        // set on clip-only nodes (both producers exempt them), so a suppressed node never owed a clip stencil.
        if (_selfPaintSuppress != SelfPaintSuppress.None)
        {
            return;
        }

        var node = EffectiveNode;

        // Cosmetic in-place spin (orb rotation layers): rotate this node's OWN paint about its paint-box center
        // before delegating to the drawers — M = T(c)·R(spin)·T(-c), i.e. basis R with origin c − R·c. Leaf-only
        // (WS-J sets CosmeticSpin only on spin-layer leaves). Zero in M1c → skipped, so no pixels move.
        if (_cosmeticSpin != 0f && TextureDrawer.PaintBox(node) is { } spinBox)
        {
            Vector2 c = spinBox.Position + (spinBox.Size * 0.5f);
            var rot = new Transform2D(_cosmeticSpin, Vector2.Zero);
            DrawSetTransformMatrix(new Transform2D(_cosmeticSpin, c - rot.BasisXform(c)));
        }
        // Fixed back-to-front sub-layer order (mirrorRenderer.ts L1735-1755): fill/texture → nine-patch → range.
        // Text is a child node (drawn after this via Godot child order) and behind-parent children draw before this
        // via Godot's show_behind_parent. The engine applies this node's modulate × self_modulate to each draw.
        TextureDrawer.Draw(this, node, _paintsTexture ? _texture : null, PaintGates.PaintFill(node), _clientAtlasRegion, _clientAtlasMargin);
        ScrimDrawer.Draw(this, node); // WS-SHADER: dark_blur flat-scrim approximation (screen-read shader fallback); base already suppressed by PaintGates
        NinePatchDrawer.Draw(this, node, _texture);
        RangeDrawer.Draw(this, node);
    }

    // ---- texture --------------------------------------------------------------------------------------------------

    private void ResolveTexture(MirrorNode node, TextureStore textures)
    {
        bool paints = PaintGates.PaintsTexture(node);
        bool isNinePatch = node is { NinePatch: true, NinePatchMargins: not null };
        _paintsTexture = paints && !isNinePatch;

        // Fetch when we'd paint it (TextureDrawer plain/atlas) OR the nine-patch drawer needs the page (WS-G).
        string? want = paints ? node.TextureUrl : null;
        if (want == _wantUrl)
        {
            return; // unchanged — keep the resolved texture (or the pending fetch)
        }

        _wantUrl = want;
        _texture = null;
        _pendingFetchUrl = null; // WS-CRISP R18: the wanted url changed → the prior fetch is abandoned (re-set below when the new one issues)
        _clientAtlasRegion = null;
        _clientAtlasMargin = null;
        if (want is null)
        {
            return;
        }

        BeginTextureResolution(node, textures, want);
    }

    // Kick off (or complete synchronously) the resolution of `want` into `_texture` (+ the client-crop region/margin).
    // Two routes: WS-ATLAS client crop for a standalone AtlasTexture `.tres` whose wire node carried NO region, else
    // the pre-existing server-crop / plain fetch. Re-entrant from the atlas store's settle callback — it never repeats
    // the _wantUrl change-detection (ResolveTexture owns that), so a re-run here always applies the resolved route.
    private void BeginTextureResolution(MirrorNode node, TextureStore textures, string want)
    {
        // Atlas client-crop eligibility: the EXACT NeedsNodeTextureRaster class (a standalone non-image `.tres`, not a
        // `::` sub-resource ref), NOT a nine-patch (NinePatchDrawer needs the resolved sprite, not the whole page),
        // and ONLY when the wire supplied no region (the wire region always wins — kept on the server-crop path).
        bool atlasEligible = _paintsTexture // we DO paint via TextureDrawer plain/atlas (not a nine-patch, which needs the sprite)
            && node.TextureRegion is null
            && RasterTextureUrl.NeedsNodeTextureRaster(want);

        if (atlasEligible)
        {
            var atlas = AtlasTresStore.For(this);
            if (atlas.Peek(want) is { } ready)
            {
                ApplyAtlasCrop(textures, want, ready);
                return;
            }

            if (!atlas.PeekFailed(want))
            {
                var captured = want;
                atlas.Request(want, () =>
                {
                    if (!GodotObject.IsInstanceValid(this) || _wantUrl != captured)
                    {
                        return; // freed, or the wanted url changed (intent swap / pool reuse) before the `.tres` settled
                    }

                    if (atlas.Peek(captured) is { } parsed)
                    {
                        ApplyAtlasCrop(textures, captured, parsed);
                    }
                    else
                    {
                        FetchServerTexture(textures, captured); // parse failed → the proven `?format=png` server crop
                    }

                    QueueRedraw();
                });
                return; // pending — the callback finishes the resolution
            }

            // atlas.PeekFailed(want): a prior tenant already learned this `.tres` isn't croppable — fall through.
        }

        FetchServerTexture(textures, want);
    }

    // WS-ATLAS: the node texture is a standalone AtlasTexture `.tres` the client cropped itself. Stash the parsed
    // region/margin (the drawer uses them only because the wire supplied no region) and request the atlas PAGE once
    // from TextureStore (decode-once, coalesced — every sprite on the page shares ONE fetch/decode).
    private void ApplyAtlasCrop(TextureStore textures, string want, ParsedAtlasTexture parsed)
    {
        _clientAtlasRegion = parsed.Region;
        _clientAtlasMargin = parsed.Margin;

        string pageUrl = SceneDeltaReader.MirrorResourceUrl(parsed.AtlasPath);
        _pendingFetchUrl = pageUrl; // WS-CRISP R18: TextureStore.IsFailed is keyed on this
        var captured = want;
        var page = textures.Request(pageUrl, tex =>
        {
            if (GodotObject.IsInstanceValid(this) && _wantUrl == captured)
            {
                _texture = tex;
                _pendingFetchUrl = null;
                RenderActivity.Mark();
                QueueRedraw();
            }
        });

        if (page is not null)
        {
            _texture = page;
            _pendingFetchUrl = null;
        }
    }

    // The pre-existing node-texture fetch: a standalone `.tres` (non-`::`) is served by the /res route as `.tres` TEXT
    // the codec sniff can't decode, so under NODETEXRASTER we ask the host to RASTERIZE it (`?format=png` → spirectl
    // cropped-region PNG). The raster url is a DISTINCT TextureStore/disk-cache key; the change detection in
    // ResolveTexture stays on the raw url (_wantUrl), so the callback guard keeps comparing that raw identity.
    private void FetchServerTexture(TextureStore textures, string want)
    {
        var fetchUrl = RasterTextureUrl.NeedsNodeTextureRaster(want)
            ? RasterTextureUrl.For(want)
            : want;

        _pendingFetchUrl = fetchUrl; // WS-CRISP R18: TextureStore.IsFailed is keyed on this (the raster/plain fetch url)
        var captured = want;
        var resolved = textures.Request(fetchUrl, tex =>
        {
            // The view may have been freed (node removed) before its texture arrived — a pending fetch callback
            // must not touch the disposed node. IsInstanceValid short-circuits before any instance-field access.
            if (GodotObject.IsInstanceValid(this) && _wantUrl == captured) // still THIS url (guards intent swaps / reuse)
            {
                _texture = tex;
                _pendingFetchUrl = null;
                RenderActivity.Mark(); // a texture decoded asynchronously — render so the art appears (grace covers late arrivals)
                QueueRedraw();
            }
        });

        // Only assign a NON-null return (missing-textures fix 2026-07-19): a synchronous disk-cache hit fires the
        // callback DURING Request, so unconditionally assigning the return value here clobbered the callback's
        // texture with null for the first requester of every warm asset.
        if (resolved is not null)
        {
            _texture = resolved;
            _pendingFetchUrl = null;
        }
    }

    // ---- helpers --------------------------------------------------------------------------------------------------

    // R6: resolve the identity-keyed card block scale + its LOCAL-space pivot (own LocalRect centre) for THIS node,
    // called from a full Apply so the FoldCosmetic block-scale channel is current before the ownership-gated Transform
    // write. Uses the SAME memoizing identity cache (keyed on node.Id) CosmeticAnimator/SyncText resolve — the first
    // resolve of the drain populates it, so this is a dictionary hit in the common case. No rule (scale 1) or no box
    // to pivot about → the channel stays 1 and the FoldCosmetic early-out is byte-identical. Switch-off → same.
    private void ResolveBlockScale(MirrorNode node)
    {
        double scale = _ctx.IdentityCache.Resolve(node.Id, _ctx.Store.State).BlockScale;
        if (scale == 1.0 || node.LocalRect is not { } box)
        {
            _blockScale = 1f;
            return;
        }

        _blockScale = (float)scale;
        _blockPivot = new Vector2((float)(box.X + box.Width / 2.0), (float)(box.Y + box.Height / 2.0));
    }

    // The block-scale matrix T(c)·S(k)·T(−c) about the local-space pivot c = _blockPivot (basis k·I, origin c·(1−k)),
    // POST-multiplied onto `local` so the node's own content scales about its visual centre in its OWN frame.
    private Transform2D BlockScaleAboutPivot() => new(
        _blockScale, 0, 0, _blockScale, _blockPivot.X * (1f - _blockScale), _blockPivot.Y * (1f - _blockScale));

    // WS-flameperf: resolve the flame's BOTTOM-CENTER paint-box pivot (LOCAL/paint coords), the exact `c` the old
    // draw path computed from TextureDrawer.PaintBox(node). Called once per full Apply (BlockScale precedent). A flame
    // quad always has a paint box; _flameHasBox mirrors the old draw-time `PaintBox(node) is { }` guard so the fold
    // is a strict no-op (identity) whenever the draw path would have skipped.
    private void ResolveFlamePivot(MirrorNode node)
    {
        if (TextureDrawer.PaintBox(node) is { } box)
        {
            _flamePivot = new Vector2(box.Position.X + (box.Size.X * 0.5f), box.Position.Y + box.Size.Y);
            _flameHasBox = true;
        }
        else
        {
            _flameHasBox = false;
        }
    }

    // WS-flameperf: the flame matrix M = T(c)·L·T(−c) about the bottom-center pivot c = _flamePivot, with the linear
    // basis L = xAxis (1,0), yAxis (−sin(skew)·sy, cos(skew)·sy) — Godot's Transform2D(rot=0, scale=(1,sy), skew) — so
    // M is BYTE-IDENTICAL to the old draw-time DrawSetTransformMatrix. POST-multiplied onto `local` (leaf flame quad,
    // no children), which reproduces the draw path's `parentGlobal · Transform · M` exactly (FlameMathTests pins it).
    private Transform2D FlameAboutPivot()
    {
        Vector2 c = _flamePivot;
        var xAxis = new Vector2(1f, 0f);
        var yAxis = new Vector2(-Mathf.Sin(_cosmeticSkew) * _cosmeticScaleY, Mathf.Cos(_cosmeticSkew) * _cosmeticScaleY);
        Vector2 origin = c - ((xAxis * c.X) + (yAxis * c.Y));
        return new Transform2D(xAxis, yAxis, origin);
    }

    // Fold the HoverTip scale + cosmetic offset + input lift + wide-screen spread shift into a local transform
    // (parent-frame). No-op when the scale is 1 AND all three offsets are zero (the M1c/M1d/16:9 default → identical
    // pixels; the switch-OFF hover path leaves _hoverScale at 1, so this early-out is byte-identical to pre-Feature-A).
    //
    // Order is load-bearing: the scale S(k) about pivot P is applied FIRST (pre-multiplied onto `local`, so the whole
    // subtree — art + text — renders k× bigger about P), THEN the un-scaled additive offsets are added to the origin
    // (lift/spread stay expressed in un-scaled parent px, matching the other channels). The clamp translation rides
    // with the scale (it exists only to pull the SCALED box back on-screen), so it is added inside the scale branch.
    private Transform2D FoldCosmetic(Transform2D local)
    {
        EnsureViewScale();
        bool foldFlame = _flameHasBox && (_cosmeticScaleY != 1f || _cosmeticSkew != 0f);
        if (_hoverScale == 1f
            && _blockScale == 1f
            && _viewScale == 1f
            && _viewScaleClamp == Vector2.Zero
            && _hoverClampOffset == Vector2.Zero
            && _cosmeticOffset == Vector2.Zero
            && _liftOffset == Vector2.Zero
            && _spreadOffset == Vector2.Zero
            && !foldFlame)
        {
            return local;
        }

        var t = local;
        if (_blockScale != 1f)
        {
            t *= BlockScaleAboutPivot();
        }

        if (foldFlame)
        {
            t *= FlameAboutPivot();
        }

        t.Origin += _spreadOffset;
        if (_hoverScale != 1f)
        {
            var scaleAboutPivot = new Transform2D(
                _hoverScale, 0, 0, _hoverScale, _hoverScalePivot.X * (1f - _hoverScale), _hoverScalePivot.Y * (1f - _hoverScale));
            t = scaleAboutPivot * t;
        }
        t.Origin += _hoverClampOffset;

        if (_viewScale != 1f)
        {
            var viewAboutPivot = new Transform2D(
                _viewScale, 0, 0, _viewScale, _viewScalePivot.X * (1f - _viewScale), _viewScalePivot.Y * (1f - _viewScale));
            t = viewAboutPivot * t;
        }

        t.Origin += _viewScaleClamp + _cosmeticOffset + _liftOffset;
        return t;
    }

    // R8 (WS-2): resolve this view's VIEW-SCALE channel from the pure per-drain ViewScaleStampIndex, memoized against
    // the index generation. Called at the top of EVERY fold, which is precisely why the channel can never be stale,
    // never be "carried", and never need un-stamping: the index is rebuilt from the wire state each drain and a node
    // with no entry resolves to neutral. A bake clone / recycled view / RefreshEffects re-apply hits this same path
    // because it keys on the wire NodeId, not on which Godot object is asking.
    private void EnsureViewScale()
    {
        int gen = ViewScaler.Generation;
        if (_viewScaleGen == gen)
        {
            return;
        }

        _viewScaleGen = gen;
        if (!ViewScaler.TryGetParentStamp(NodeId, out float scale, out var pivot, out var clamp))
        {
            _viewScale = 1f;
            _viewScalePivot = Vector2.Zero;
            _viewScaleClamp = Vector2.Zero;
            return;
        }

        _viewScale = scale;
        _viewScalePivot = pivot;
        _viewScaleClamp = clamp;
    }

    // R8 (WS-2): re-fold this view because its view-scale stamp may have changed while nothing else re-applied it
    // (an idle view-scale screen whose ancestor moved, or a bare spread-factor change). Sole caller: ViewScaler.Refold.
    // A pure TRIGGER — the value still comes from the index inside EnsureViewScale — and a no-op when the resolved
    // channel is unchanged, so a steady screen re-triggers for free.
    public void RefreshViewScale()
    {
        float scale = _viewScale;
        Vector2 pivot = _viewScalePivot, clamp = _viewScaleClamp;
        _viewScaleGen = -1;
        EnsureViewScale();
        if (scale == _viewScale && pivot == _viewScalePivot && clamp == _viewScaleClamp)
        {
            return;
        }

        RenderActivity.Mark(); // the item grew/shrank/moved — the stage must render this grace window
        if (!TweenOwnsTransform)
        {
            Transform = FoldCosmetic(StreamedLocal);
        }
    }

    private static Color ColorOf(MirrorColor? color, double alpha) =>
        color is { } c
            ? new Color((float)c.R, (float)c.G, (float)c.B, (float)alpha)
            : new Color(1, 1, 1, (float)alpha);
}
