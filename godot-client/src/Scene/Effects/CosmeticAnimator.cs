// M1d effect seam — COSMETIC animator (WS-J). MirrorNodeView.Apply calls Sync on every node update. It replays the
// two PURE-COSMETIC motions the headless client freezes game-side (so a still combat streams nothing) on the
// browser's own clock, reusing @spirectl/presentation's vocabulary:
//   * Enemy-intent BOB: the intent-holder leaves (IntentHolder/Intent, /Value, /IntentParticle) drift up and down
//     on the spot — period 2000ms, amp 10px, baseline 8px up — with a per-node left-to-right wave phase from the
//     leaf's game-space global X, so a row of intents ripples instead of pumping as one block. Applied via owner.CosmeticOffset (folds into the transform origin), and
//     DEFERRED while a tween owns the transform.
//   * Energy/star orb SPIN (the `%RotationLayers` children: one 2π turn per 12566ms/(child index + 1) — see
//     SpinPeriodMs). Applied via owner.CosmeticSpin (an in-place rotation drawn about the paint-box center — a
//     LEAF-only overlay).
//   * Q1 Tezcatara candle-fire FLICKER (NRestSiteFireVfx quads SteppedFireMix/Add/Add1): scale.Y ±8% (~1.7s) +
//     skew ±0.1rad (~2.6s) per quad. Applied via owner.CosmeticScaleY/CosmeticSkew about the paint-box BOTTOM-CENTER
//     — a leaf-only overlay folded into the node Transform without a per-frame QueueRedraw and ticked at ~30Hz.
//     Phase-seeded per flame root.
//
// Scoping is by SCENE-RELATIVE identity (the native twin of mirrorRenderer.ts's computeSceneInfo +
// animAttributes.ts's nodeAnimBinding): walk ParentIds to the nearest ancestor carrying a SceneFilePath, build the relative path, and
// suffix-match the bob/spin tables. A bare NAME match is not enough (co-op player intents live under a different
// scene path and must NOT bob) — a wire node whose name matches but whose scene scoping rejects it logs ONE notice.
//
// InstantTweens (deterministic --replay single-shot): FROZEN — no ticker, zero offset/spin, so the shot is byte-stable.

using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static partial class CosmeticAnimator
{
    private const string TickerName = "__anim";

    // WS-B: build-once NodePath for the ticker probes (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath TickerPath = TickerName;

    // Bob wave constants (animAttributes.ts nodeAnimBinding bob binding): period 2000ms, amp 10px, baseline 8px UP →
    // −8px in Godot screen space (+Y down).
    private const double BobPeriodMs = 2000.0;
    private const double BobAmpPx = 10.0;
    private const double BobBaselinePx = -8.0;

    // Orb spin periods come from EffectMath.SpinPeriodMs (shared pure math, unit-tested in the Exe runner and the
    // twin of animAttributes.ts `spinDurationMs`): the i-th `%RotationLayers` child turns once per 12566/(i+1) ms,
    // and the ordinal is derived from the container that OWNS RotationLayers because `Layer2` is child 0 in an
    // energy counter but child 1 in the star counter.

    // Q1 Tezcatara candle-fire loop (presentation flameFlicker + EffectMath): scale.Y ±8% over ~1.7s + skew
    // ±0.1rad over ~2.6s, per painted quad, about the paint-box bottom-center.
    private const double FlameScaleYPeriodMs = 1700.0;
    private const double FlameSkewPeriodMs = 2600.0;
    private const double FlameScaleAmp = 0.08;
    private const double FlameSkewAmp = 0.1;

    // WS-flameperf: the flame ticker recomputes at a REDUCED ~30Hz (not per frame). The two sine tracks read the wall
    // clock, so a skipped frame never loses phase — only the visible cadence drops from frame-rate to ~30Hz, which is
    // imperceptible for a slow candle flicker and cuts the per-frame re-fold + RenderActivity.Mark churn. On a device
    // already below 30fps (the awake Tezcatara state) this is a no-op (every frame already exceeds the interval).
    private const double FlameTickIntervalMs = 1000.0 / 30.0;

    // The three painted quad leaves under each NRestSiteFireVfx flame root (stepped-fire shader Sprite2Ds). Keyed
    // on the LAST path segment so the loop rides the QUADS (the web DOM is flat — a root loop wouldn't move them).
    private static readonly string[] FlameQuadLeaves = ["SteppedFireMix", "SteppedFireAdd", "SteppedFireAdd1"];

    private enum AnimKind
    {
        None,
        Bob,
        Rotate,
        Flame,
    }

    // PhaseMs is the per-flame phase seed (flame only; 0 for bob/rotate). Bob derives its phase from the leaf's
    // global X in the ticker; rotate has none.
    private readonly record struct Binding(AnimKind Kind, double PeriodMs, double PhaseMs = 0.0);

    // One-time non-silent notice: a wire node NAME-matches a bob/spin/flame leaf but scene scoping rejected it.
    private static bool _noticedReject;

    public static void Sync(MirrorNodeView owner, MirrorNode node, RenderContext ctx)
    {
        // Deterministic single-shot: freeze (no ticker, zero offset + spin → byte-stable shot).
        if (ctx.Options.InstantTweens)
        {
            Detach(owner);
            return;
        }

        // WS-P2: read the node's scene-relative path from the memoizing identity cache (same result as walking the
        // parent chain fresh; the cache is invalidated on any Static/order/keyframe drain by SceneReconciler).
        string? relPath = ctx.IdentityCache.Resolve(node.Id, ctx.Store.State).RelPath;
        var binding = BindingFor(relPath);

        if (binding.Kind == AnimKind.None)
        {
            NoticeRejectOnce(node, relPath);
            Detach(owner);
            return;
        }

        var ticker = owner.GetNodeOrNull<AnimTicker>(TickerPath);
        if (ticker is null)
        {
            ticker = new AnimTicker { Name = TickerName, ShowBehindParent = true };
            owner.AddChild(ticker); // END-APPENDED per the MirrorNodeView attachment-child ordering rule
            ticker.Bind(owner, ctx.Store);
        }

        ticker.Configure(binding.Kind == AnimKind.Bob, binding.Kind == AnimKind.Flame, binding.PeriodMs, binding.PhaseMs, node.Id);
        owner.HasAnimChild = true; // Track-D: mark this view client-animated so StaticBake never bakes (freezes) it
    }

    // Track I (idle-animation suspend): freeze/unfreeze this view's bob/spin ticker. The ticker drives CosmeticOffset/
    // CosmeticSpin off the WALL CLOCK (EffectMath), so SetProcess(false) just holds the last value (bit-frozen) and its
    // per-frame RenderActivity Marks stop; SetProcess(true) resumes phase-correct automatically (the next _Process
    // recomputes position from the current wall clock — exactly where the animation would be). Returns true iff a live
    // "__anim" ticker was toggled (the controller gates on owner.HasAnimChild; this re-confirms the child).
    public static bool SetSuspended(MirrorNodeView owner, bool suspend)
    {
        var ticker = owner.GetNodeOrNull<AnimTicker>(TickerPath);
        if (ticker is null)
        {
            return false;
        }

        ticker.SetProcess(!suspend);
        return true;
    }

    private static void Detach(MirrorNodeView owner)
    {
        owner.HasAnimChild = false; // Track-D: no cosmetic ticker → eligible for a bake again
        var ticker = owner.GetNodeOrNull<AnimTicker>(TickerPath);
        if (ticker is not null)
        {
            ticker.Free(); // immediate — no extra deferred tick that could re-apply after we zeroed
        }

        if (owner.CosmeticOffset != Vector2.Zero)
        {
            owner.CosmeticOffset = Vector2.Zero;
        }

        if (owner.CosmeticSpin != 0f)
        {
            owner.CosmeticSpin = 0f;
        }

        if (owner.CosmeticScaleY != 1f)
        {
            owner.CosmeticScaleY = 1f;
        }

        if (owner.CosmeticSkew != 0f)
        {
            owner.CosmeticSkew = 0f;
        }
    }

    // Port of nodeAnimBinding (animAttributes.ts): suffix-match the scene-relative path against the spin layers and
    // the three bob leaves. Suffix (not equality) covers every per-character energy/star-counter + enemy scene variant.
    private static Binding BindingFor(string? relPath)
    {
        if (relPath is null)
        {
            return new Binding(AnimKind.None, 0);
        }

        if (EffectMath.SpinPeriodMs(relPath) is { } spinPeriodMs)
        {
            return new Binding(AnimKind.Rotate, spinPeriodMs);
        }

        if (relPath.EndsWith("IntentHolder/Intent", System.StringComparison.Ordinal)
            || relPath.EndsWith("IntentHolder/Value", System.StringComparison.Ordinal)
            || relPath.EndsWith("IntentHolder/IntentParticle", System.StringComparison.Ordinal))
        {
            return new Binding(AnimKind.Bob, BobPeriodMs);
        }

        // Q1 flame quad: match on the LAST path segment (so SteppedFireAdd never swallows SteppedFireAdd1) and seed
        // the phase from the flame ROOT (the parent path) so a flame's three quads share it while the 79 flames desync.
        int lastSlash = relPath.LastIndexOf('/');
        string leaf = lastSlash >= 0 ? relPath[(lastSlash + 1)..] : relPath;
        if (System.Array.IndexOf(FlameQuadLeaves, leaf) >= 0)
        {
            string parentPath = lastSlash >= 0 ? relPath[..lastSlash] : string.Empty;
            return new Binding(AnimKind.Flame, 0, EffectMath.FlamePhaseMs(parentPath));
        }

        return new Binding(AnimKind.None, 0);
    }

    private static void NoticeRejectOnce(MirrorNode node, string? relPath)
    {
        if (_noticedReject)
        {
            return;
        }

        if (node.Name is "IntentHolder" or "Intent" or "Value" or "IntentParticle"
            or "RotationLayers" or "Layer1" or "Layer2" or "Layer3"
            or "SteppedFireMix" or "SteppedFireAdd" or "SteppedFireAdd1")
        {
            _noticedReject = true;
            GD.Print($"M1D_COSMETIC: node '{node.Name}' (id={node.Id}) matches a bob/spin/flame name but scene scoping " +
                     $"rejected it (relPath={relPath ?? "<none>"}) — not animated.");
        }
    }

    // The self-ticking "__anim" child: drives owner.CosmeticOffset (bob) or owner.CosmeticSpin (orb spin) off the
    // wall-clock each frame. Inert draw (a bare Node2D). Reads the leaf's game-space global X from the store's index
    // (READ ONLY) for the bob wave phase.
    public sealed partial class AnimTicker : Node2D
    {
        private MirrorNodeView _owner = null!;
        private MirrorStore _store = null!;
        private bool _isBob;
        private bool _isFlame;
        private double _periodMs;
        private double _phaseMs;
        private string _nodeId = "";

        // WS-flameperf: free-running accumulator for the reduced-rate flame gate (see FlameTickIntervalMs). Independent
        // of Configure/Apply (persists across drains) so it accumulates freely on an idle scene where no Apply runs.
        private double _flameAccumMs;

        public void Bind(MirrorNodeView owner, MirrorStore store)
        {
            _owner = owner;
            _store = store;
        }

        // isBob → drive CosmeticOffset (bob); isFlame → drive CosmeticScaleY/CosmeticSkew (candle fire); neither →
        // drive CosmeticSpin (orb rotate). Bools (not the private AnimKind) keep this public method's signature
        // accessible. phaseMs is the flame's per-quad phase seed (0 for bob/rotate).
        public void Configure(bool isBob, bool isFlame, double periodMs, double phaseMs, string nodeId)
        {
            _isBob = isBob;
            _isFlame = isFlame;
            _periodMs = periodMs;
            _phaseMs = phaseMs;
            _nodeId = nodeId;
        }

        public override void _Process(double delta)
        {
            double now = Time.GetTicksMsec();

            if (_isBob)
            {
                // Defer the bob while a tween owns the transform (the seam's CosmeticOffset setter also declines to
                // re-fold then; skipping avoids churn + keeps the last value for the resume).
                if (_owner.TweenOwnsTransform)
                {
                    return;
                }

                double globalX = _store.Transforms.TryGetGlobal(_nodeId, out var m) ? m[4] : 0.0;
                double phase = EffectMath.BobPhaseMs(globalX, _periodMs);
                double y = EffectMath.BobOffsetY(now, phase, _periodMs, BobAmpPx, BobBaselinePx);
                _owner.CosmeticOffset = new Vector2(0, (float)y);
            }
            else if (_isFlame)
            {
                // Hold the last value while a tween owns the transform (parity with bob; e.g. an Extinguish tween),
                // then resume phase-correct. Flame values fold into the node transform; this ticker only decides when
                // to recompute them.
                if (_owner.TweenOwnsTransform)
                {
                    return;
                }

                // WS-flameperf: recompute at ~30Hz, not per frame. The sines read `now` (wall clock), so a skipped
                // frame is invisible — the value is always phase-correct when we DO write. Cuts the per-frame re-fold.
                if (!EffectMath.FlameTickDue(ref _flameAccumMs, delta * 1000.0, FlameTickIntervalMs))
                {
                    return;
                }

                _owner.CosmeticScaleY = (float)EffectMath.FlameScaleY(now, _phaseMs, FlameScaleYPeriodMs, FlameScaleAmp);
                _owner.CosmeticSkew = (float)EffectMath.FlameSkew(now, _phaseMs, FlameSkewPeriodMs, FlameSkewAmp);
            }
            else
            {
                _owner.CosmeticSpin = (float)EffectMath.SpinRadians(now, _periodMs);
            }
        }
    }
}
