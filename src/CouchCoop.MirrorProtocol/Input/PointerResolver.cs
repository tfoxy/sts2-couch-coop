using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Input;

// M2 WS-Q (widened input). The stateful port of frontend/src/mirror/inputCapture.ts's coordinate resolve family
// (resolveSent L281-309 / designCoord L313-316 / fieldAffineCoord L322-335 / frozenCoord L339-342 /
// memoizedHoverCoord L348-358 / hoverCoord L367-377 / freezeAt L392-396 / clearFreeze L399-401). The InputRouter
// builds ONE of these from the live store and wires its five methods to the frozen <see cref="GestureCallbacks"/>
// resolver seam; the GestureMachine calls them at every send site. Each maps a DESIGN-space point (the InputRouter
// has already inverted the letterbox) to a resolved 1920-space GAME coordinate the game hit-tests.
//
//   * <see cref="Fresh"/>       — designCoord: a fresh anchor-map probe + near-miss, refreshing the hover memo.
//                                 Wheel, mouse/touch releases, taps, two-finger right-click.
//   * <see cref="Press"/>       — freezeAt: Fresh, then FREEZE the press-time field affine for the held gesture.
//   * <see cref="Frozen"/>      — frozenCoord: replay the frozen affine with pure math (NO near-miss). Cancels + the
//                                 mid-gesture coalesced hover flush (a drag drags the world, not re-hovers it).
//   * <see cref="Hover"/>       — hoverCoord: within 24px/120ms of the last fresh probe replay its affine + near-miss
//                                 (memoizedHoverCoord); else Fresh. Peek + the idle hover flush.
//   * <see cref="ClearFreeze"/> — clearFreeze: release the frozen affine when a held gesture ends.
//
// On a 16:9 stage (designWidth == 1920) the map short-circuits to identity, the memo/near-miss branches are gated off
// (`designWidth > 1920`), and the frozen affine replays `1·x + 0` — so all five methods return the incoming design
// coord VERBATIM (the byte-identical no-op WS-Q's F=1 gate proves). Constructed from delegates so the InputRouter
// injects the live store/rects/width/clock while unit tests inject fakes.
public sealed class PointerResolver
{
    // A WIDENED-stage hover flush within this many design px AND this many ms of the last FRESH probe replays that
    // probe's field affine with pure math instead of re-probing (inputCapture HOVER_REPROBE_PX/MS L98-99).
    private const double HoverReprobePx = 24;
    private const double HoverReprobeMs = 120;

    private const double GameWidth = SceneTreeApplier.MirrorDesignWidth; // 1920
    private const double GameHeight = 1080; // Y is never widened.

    private readonly Func<double, double, PointerField.PointerMapping> _map;
    private readonly Func<IReadOnlyList<InteractiveRectScan.InteractiveRect>> _rects;
    private readonly Func<double> _designWidth;
    private readonly Func<double> _nowMs;

    // The frozen press-time field affine (null = no held gesture); the last fresh widened-stage probe for the hover
    // memo (null = none / invalidated). Both no-ops on 16:9 (the memo branch is gated on designWidth > 1920).
    private PointerField.FieldAffine? _frozenAffine;
    private HoverProbe? _hoverProbe;

    // R19 6a — was the press point SQUEEZE-resolved (no specific painter under it)? Frozen alongside the affine,
    // because the affine alone cannot say: a press on a proportional CARD freezes the whole-world squeeze field too
    // (so the world spreads under the finger) and there the squeeze IS the right answer. Only an UNANCHORED press
    // needs its replayed frames rendered-box gated. Twin of the web inputCapture.frozenSqueezed.
    private bool _frozenSqueezed;

    public PointerResolver(
        Func<double, double, PointerField.PointerMapping> map,
        Func<IReadOnlyList<InteractiveRectScan.InteractiveRect>> rects,
        Func<double> designWidth,
        Func<double> nowMs)
    {
        _map = map;
        _rects = rects;
        _designWidth = designWidth;
        _nowMs = nowMs;
    }

    /// <summary>designCoord: a fresh anchor-map probe + near-miss pass, refreshing the hover memo (resolveSent).</summary>
    public ResolvedCoord Fresh(double x, double y)
    {
        var (coordX, coordY, _, _) = ResolveSent(x, y);
        return new ResolvedCoord(coordX, coordY);
    }

    /// <summary>freezeAt: resolve FRESH at the press point and FREEZE its field affine for drag-motion replay.</summary>
    public ResolvedCoord Press(double x, double y)
    {
        var (coordX, coordY, affine, squeezed) = ResolveSent(x, y);
        _frozenAffine = affine;
        _frozenSqueezed = squeezed; // R19 6a: the press decided "unanchored"; every replayed frame inherits it.
        return new ResolvedCoord(coordX, coordY);
    }

    /// <summary>
    /// frozenCoord: replay the frozen press-time affine with pure math — no probe, no near-miss WALK. R19 6a: an
    /// UNANCHORED press (its coordinate came from the uniform squeeze) still gets the single-step rendered-box gate,
    /// or the whole drag replays into the game rect of a widget it is beside (the wide-screen map-legend drag).
    /// </summary>
    public ResolvedCoord Frozen(double x, double y)
    {
        var (coordX, coordY, designX) = FieldAffineCoord(x, y, _frozenAffine ?? new PointerField.FieldAffine(1, 0));
        if (_frozenSqueezed && _designWidth() > GameWidth)
        {
            var rects = _rects();
            if (rects.Count > 0)
            {
                coordX = NearMiss.PushOutOfSqueezeMiss(coordX, coordY, designX, rects);
            }
        }

        return new ResolvedCoord(coordX, coordY);
    }

    /// <summary>
    /// hoverCoord: within HOVER_REPROBE_PX/MS of the last fresh probe (taken at the SAME design width) replay its
    /// affine + near-miss (memoizedHoverCoord); otherwise resolve FRESH (which refreshes the memo).
    /// </summary>
    public ResolvedCoord Hover(double x, double y)
    {
        var dw = _designWidth();
        if (dw > GameWidth && _hoverProbe is { } probe && probe.DesignWidth == dw)
        {
            var ddx = x - probe.X;
            var ddy = y - probe.Y;
            if (Math.Sqrt((ddx * ddx) + (ddy * ddy)) <= HoverReprobePx && _nowMs() - probe.At <= HoverReprobeMs)
            {
                var (coordX, coordY) = MemoizedHoverCoord(x, y, probe.Affine);
                return new ResolvedCoord(coordX, coordY);
            }
        }

        return Fresh(x, y);
    }

    /// <summary>clearFreeze: release the frozen press affine once a held gesture ends.</summary>
    public void ClearFreeze()
    {
        _frozenAffine = null;
        _frozenSqueezed = false;
    }

    // ---- internals (1:1 with the inputCapture helpers) ----

    // resolveSent: map the design point through the anchor field, vet EVERY fresh resolve with the near-miss pass
    // (safe for the painter's own frame — same-frame overlaps are self-exempt; catches a coord landing in a
    // DIFFERENT-frame rect), and memoize the field affine so the next plain hover within bounds replays it. All of it
    // is gated on a widened stage — 16:9 is pure identity, zero cost.
    private (double CoordX, double CoordY, PointerField.FieldAffine Affine, bool Squeezed) ResolveSent(double x, double y)
    {
        var m = _map(x, y);
        var coordX = m.CoordX;
        var dw = _designWidth();
        if (dw > GameWidth)
        {
            var rects = _rects();
            if (rects.Count > 0)
            {
                coordX = NearMiss.PushOutOfNearMiss(m.CoordX, m.CoordY, m.DesignX, rects);
            }

            // Refresh the memo: every fresh resolve reaches here (hover/press/release/wheel/tap/peek), not just a
            // hover's own — so any of them corrects the memo for the next flush.
            _hoverProbe = new HoverProbe(x, y, _nowMs(), m.Affine, dw);
        }

        return (coordX, m.CoordY, m.Affine, m.Squeezed);
    }

    // fieldAffineCoord: replay `coordX = A·designX + B` (clamped) with pure math. In native the point already IS
    // design-space, so designX == x and coordY is the plain 1080-clamped Y.
    private static (double CoordX, double CoordY, double DesignX) FieldAffineCoord(double x, double y, PointerField.FieldAffine affine)
    {
        var designX = x;
        var coordY = Clamp(y, 0, GameHeight);
        var coordX = Clamp((affine.A * designX) + affine.B, 0, GameWidth);
        return (coordX, coordY, designX);
    }

    // memoizedHoverCoord: replay the memo's affine with pure math, then push it out of any near-miss over the CURRENT
    // retained rects (read fresh each call; only the z-stack walk is skipped) — matching what a fresh probe would do.
    private (double CoordX, double CoordY) MemoizedHoverCoord(double x, double y, PointerField.FieldAffine affine)
    {
        var (rawX, coordY, designX) = FieldAffineCoord(x, y, affine);
        var coordX = rawX;
        var rects = _rects();
        if (rects.Count > 0)
        {
            coordX = NearMiss.PushOutOfNearMiss(rawX, coordY, designX, rects);
        }

        return (coordX, coordY);
    }

    private static double Clamp(double value, double lo, double hi) => value < lo ? lo : value > hi ? hi : value;

    // The last FRESH widened-stage probe: a later plain hover within HOVER_REPROBE_PX/MS of it (and at the SAME
    // design width) replays its field affine with pure math instead of re-probing. X/Y are design-space here.
    private readonly record struct HoverProbe(double X, double Y, double At, PointerField.FieldAffine Affine, double DesignWidth);
}
