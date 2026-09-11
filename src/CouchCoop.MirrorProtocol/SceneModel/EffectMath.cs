namespace CouchCoop.MirrorProtocol.SceneModel;

// Pure math for the WS-J native cosmetic effects — intent-glyph frame cycling, the enemy-intent bob wave, and the
// energy/star-orb spin angle. NO Godot types, so it lives in the protocol lib: the Exe test runner (which references
// only this lib) covers it, and the Godot ticking children (IntentPlayer/CosmeticAnimator) call the SAME functions
// the tests pin. Each is the native twin of a web replay, and the two must agree:
//   - IntentFrameIndex : frontend/src/mirror/mirrorRenderer.ts `intentFrameIndex` — a flip-book at a fixed frame
//     rate, floor(elapsed*fps)%count.
//   - BobPhaseMs/BobOffsetY : mirrorRenderer.ts + presentation animations.ts INTENT_BOB — the enemy-intent badge
//     drifting up and down (period 2000ms, amp 10px, baseline 8px up), with a per-node left-to-right phase so the
//     row of intents ripples instead of pumping as one block.
//   - SpinRadians : presentation animations.ts ROTATE (rotate(0deg)→rotate(360deg) linear, infinite) — a full 2π
//     turn every `periodMs`, clockwise (positive in Godot 2D, +Y down).
public static class EffectMath
{
    // Mirror design width (frontend/src/mirror/sceneTree.ts MIRROR_DESIGN_WIDTH). The bob phase seed divides the
    // node's game-space global X by this so intents laid out left-to-right bob as a WAVE, not in lockstep.
    public const double MirrorDesignWidth = 1920.0;

    // Which frame of a multi-frame intent glyph shows at `elapsedMs` into the cycle: floor(elapsedMs/1000 * fps)
    // modulo the frame count. Degenerate inputs (≤1 frame, non-positive fps/elapsed, non-finite) → frame 0. The
    // modulo is the always-non-negative form so a (never-expected) negative elapsed still lands in range.
    public static int IntentFrameIndex(double elapsedMs, double fps, int count)
    {
        if (count <= 1 || fps <= 0 || double.IsNaN(elapsedMs) || double.IsInfinity(elapsedMs) || elapsedMs <= 0)
        {
            return 0;
        }

        long raw = (long)System.Math.Floor((elapsedMs / 1000.0) * fps);
        long m = ((raw % count) + count) % count;
        return (int)m;
    }

    // Per-node bob phase (ms): −(globalX/1920)·period. The web arm seeds this as a NEGATIVE
    // animation-delay; here it is an additive phase inside the sine, which is equivalent up to the (arbitrary)
    // wall-clock origin — both stagger adjacent icons by ~their pixel spacing over the 2000ms period.
    public static double BobPhaseMs(double globalX, double periodMs) =>
        -(globalX / MirrorDesignWidth) * periodMs;

    // Enemy-intent bob vertical offset (parent-frame px, +Y down): baseline + amp·sin(2π·(t+phase)/period). The
    // badge rides UPWARD off its rest pose, and in Godot screen space up is −Y, so `baseline` is negative (−8px)
    // and the leaf oscillates in [baseline−amp, baseline+amp]. The cycle count is reduced mod 1 before ×2π so a large
    // wall-clock `t` keeps sine precision.
    public static double BobOffsetY(double tMs, double phaseMs, double periodMs, double ampPx, double baselinePx)
    {
        if (periodMs <= 0)
        {
            return baselinePx;
        }

        double cycles = (tMs + phaseMs) / periodMs;
        double frac = cycles - System.Math.Floor(cycles); // [0,1)
        return baselinePx + (ampPx * System.Math.Sin(2.0 * System.Math.PI * frac));
    }

    // Orb rotation-layer spin angle (radians): one full 2π turn every `periodMs`, clockwise = positive in Godot 2D
    // (+Y down, so a positive angle sweeps X→Y = clockwise on screen, matching the web's rotate(0deg)→rotate(360deg)).
    // Reduced mod period so a large wall-clock `t` keeps precision.
    public static double SpinRadians(double tMs, double periodMs)
    {
        if (periodMs <= 0)
        {
            return 0;
        }

        double frac = (tMs % periodMs) / periodMs;
        if (frac < 0)
        {
            frac += 1.0;
        }

        return 2.0 * System.Math.PI * frac;
    }

    // ---- Orb spin period, resolved from a scene-relative path ------------------------------------------------------
    // Twin of frontend/src/mirror/animAttributes.ts `spinDurationMs`.
    //
    // Both the energy and the star counter spin the CHILDREN of their `%RotationLayers` container, each layer
    // turning faster than the one before it in proportion to its child INDEX, so the stack reads as concentric
    // rings at staggered speeds: the i-th child completes one turn in SpinBaseTurnMs/(i+1). The two counter
    // families NAME those children
    // differently, which makes the LEAF NUMBER ALONE AMBIGUOUS:
    //   * energy counters (ironclad/silent/defect/regent/necrobinder): `Layers/RotationLayers/{Layer2[,Layer3]}`
    //   * star counter (star_counter.tscn):                            `Icon/RotationLayers/{Layer1,Layer2}`
    // `Layer2` is child index 0 in an energy counter but index 1 in the star counter, so the old
    // "ends with RotationLayers/Layer2" rule spun the star counter's SECOND layer at the FIRST layer's rate and
    // never animated its `Layer1` at all. We key off the container that OWNS RotationLayers instead.
    //
    // Necrobinder's `Layers/Layer3` is a plain SIBLING of RotationLayers (not a child), so it correctly resolves to
    // null — that counter has a single spinning layer.

    /// <summary>One full 2π turn for the FIRST (<c>i == 0</c>) rotation layer, in ms.</summary>
    public const double SpinBaseTurnMs = 12566.0;

    private const string RotationLayerMarker = "/RotationLayers/Layer";

    // Leaf number of the FIRST (i == 0) RotationLayers child, per owning container name.
    private static readonly System.Collections.Generic.Dictionary<string, int> SpinFirstLayerNumber = new(System.StringComparer.Ordinal)
    {
        ["Layers"] = 2,
        ["Icon"] = 1,
    };

    /// <summary>
    /// One-turn period (ms) for an orb rotation layer at <paramref name="sceneRelPath"/>, or null when the path is
    /// not a <c>%RotationLayers</c> child of a known counter container. Allocation-light (no regex) — this runs per
    /// node in the native reconcile path.
    /// </summary>
    public static double? SpinPeriodMs(string? sceneRelPath)
    {
        if (sceneRelPath is null)
        {
            return null;
        }

        int markerAt = sceneRelPath.LastIndexOf(RotationLayerMarker, System.StringComparison.Ordinal);
        if (markerAt <= 0)
        {
            return null; // absent, or no owning container segment before it
        }

        // Trailing digits only — "Layer2/Sprite" and "Layer2x" must not match.
        string leafNumberText = sceneRelPath[(markerAt + RotationLayerMarker.Length)..];
        if (leafNumberText.Length == 0 || !int.TryParse(leafNumberText, out int leafNumber))
        {
            return null;
        }

        int ownerStart = sceneRelPath.LastIndexOf('/', markerAt - 1) + 1;
        string owner = sceneRelPath[ownerStart..markerAt];
        if (!SpinFirstLayerNumber.TryGetValue(owner, out int firstLayerNumber))
        {
            return null;
        }

        int ordinal = leafNumber - firstLayerNumber + 1; // 1-based child index (i + 1)
        return ordinal >= 1 ? SpinBaseTurnMs / ordinal : null;
    }

    // ---- Tezcatara candle-fire loop (NRestSiteFireVfx) ------------------------------------------------------------
    // On screen each candle flame pulses vertically (scale.Y in [0.85,1.05] of its rest height) while it leans from
    // side to side (skew ±0.1rad) — motion the headless suspender freezes. Replayed as two independent sine LOOPS
    // on each painted QUAD, twins of the web presentation `flameFlicker` kind (scaleY ±8% ~1.7s + skew ±0.1rad
    // ~2.6s) and the animAttributes `flamePhaseMs`. Draw-time only (never on the wire), so a tiny drift vs the web
    // is fine.

    // The larger of the two loop periods (skew) — the per-flame phase seed lives in [0, this) (see FlamePhaseMs).
    public const double FlamePhaseModMs = 2600.0;

    // scale.Y multiplier: 1 + amp·sin(2π·frac). frac = (t+phase)/period mod 1 (mod-1 reduced for large-t precision).
    public static double FlameScaleY(double tMs, double phaseMs, double periodMs, double amp)
    {
        if (periodMs <= 0)
        {
            return 1.0;
        }

        double cycles = (tMs + phaseMs) / periodMs;
        double frac = cycles - System.Math.Floor(cycles);
        return 1.0 + (amp * System.Math.Sin(2.0 * System.Math.PI * frac));
    }

    // skew (radians): amp·sin(2π·frac), centred on 0 — same shape as FlameScaleY but oscillating about 0.
    public static double FlameSkew(double tMs, double phaseMs, double periodMs, double amp)
    {
        if (periodMs <= 0)
        {
            return 0.0;
        }

        double cycles = (tMs + phaseMs) / periodMs;
        double frac = cycles - System.Math.Floor(cycles);
        return amp * System.Math.Sin(2.0 * System.Math.PI * frac);
    }

    // WS-flameperf: the flame draw/fold matrix M = T(c)·L·T(−c) about the bottom-center paint-box pivot (cx,cy),
    // linear basis L: xAxis=(1,0), yAxis=(−sin(skew)·sy, cos(skew)·sy) — Godot's Transform2D(rot=0, scale=(1,sy),
    // skew). Returns the 6 components in Godot's column layout: (Xx,Xy)=xAxis, (Yx,Yy)=yAxis, (Ox,Oy)=origin=c−L·c.
    // This is the pure REFERENCE for the matrix the native fold (MirrorNodeView.FlameAboutPivot) and the legacy draw
    // path both build; FlameMathTests pins it (a formula spec — the native site recomputes the same expression in
    // float, so the fold is byte-identical to the old DrawSetTransformMatrix by construction). By definition the pivot
    // is the fixed point: M·(cx,cy) == (cx,cy).
    public static (double Xx, double Xy, double Yx, double Yy, double Ox, double Oy) FlameMatrix(
        double scaleY, double skew, double cx, double cy)
    {
        double xx = 1.0, xy = 0.0;
        double yx = -System.Math.Sin(skew) * scaleY;
        double yy = System.Math.Cos(skew) * scaleY;
        // origin = c − L·c, where L·c = xAxis·cx + yAxis·cy (column combination).
        double ox = cx - ((xx * cx) + (yx * cy));
        double oy = cy - ((xy * cx) + (yy * cy));
        return (xx, xy, yx, yy, ox, oy);
    }

    // Reduced-rate flame ticker gate (WS-flameperf). The two sine tracks are computed from the WALL CLOCK
    // (FlameScaleY/FlameSkew read `now`), so their phase is exact regardless of HOW OFTEN they are sampled — only
    // the visible cadence changes. This lets the flame ticker recompute at a fixed ~20-30Hz instead of every frame:
    // accumulate `deltaMs`; once it reaches `intervalMs` return true and RESET the accumulator (drop the backlog — at
    // most one tick per interval, no catch-up burst after a frame hitch). A non-positive interval degenerates to
    // "every frame" (no throttle). `accumMs` is the caller's free-running accumulator (passed by ref).
    public static bool FlameTickDue(ref double accumMs, double deltaMs, double intervalMs)
    {
        if (intervalMs <= 0.0)
        {
            return true; // degenerate → no throttle (fire every call)
        }

        accumMs += deltaMs;
        if (accumMs < intervalMs)
        {
            return false;
        }

        accumMs = 0.0; // drop the backlog (one tick per interval; a dropped tick never loses phase — see above)
        return true;
    }

    // Per-flame phase seed (ms) in [0, FlamePhaseModMs): a 32-bit FNV-1a hash of the flame ROOT's scene path, so
    // the 79 flames desync while a flame's three quads (which share a parent path) stay mutually layered. Byte-for-
    // byte twin of the web `flamePhaseMs` (frontend/src/mirror/animAttributes.ts): uint arithmetic wraps mod 2^32
    // exactly like JS `Math.imul` + `>>> 0`, iterating UTF-16 code units.
    public static double FlamePhaseMs(string parentPath)
    {
        uint h = 2166136261u; // FNV offset basis
        foreach (char c in parentPath)
        {
            h ^= c;
            h *= 16777619u; // FNV prime
        }

        return h % (uint)FlamePhaseModMs;
    }
}
