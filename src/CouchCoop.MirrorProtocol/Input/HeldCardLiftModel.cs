namespace CouchCoop.MirrorProtocol.Input;

// Pure truth-table for the cosmetic touch-held-card LIFT — the native twin of mirrorRenderer.ts `applyHeldLift`,
// which the browser client runs. WS-M holds ONE of these per gesture (a value type — zero per-frame allocation), calls
// <see cref="Reset"/> on a fresh grab (setHeldCard id-change) and <see cref="Update"/> on every finger move,
// and applies <see cref="LiftPx"/> to the held node's CSS/scene translate.
//
// The rules (mirrorRenderer order is normative):
//   * PEEK  ⇒ lifted UNCONDITIONALLY (a focused card pops up on its own, so the still finger no longer covers it);
//             a visible targeting arrow does NOT drop a peek (peek is checked first).
//   * else a visible NTargetingArrow ⇒ lift dropped (card static, arrow tip reads at the finger).
//   * else DRAG ⇒ lifted = !enteredPlayZone || aboveLine, where `aboveLine = currentY < playZoneThreshold(...)`
//             and enteredPlayZone LATCHES true the first time the finger crosses up into the zone. So the card
//             lifts straight off the pickup (before entry), latches on entry, then tracks the line — dragging
//             back down to the hand DROPS the lift (the card settles back to rest).
public struct HeldCardLiftModel
{
    /// <summary>Design px a DRAG-held card is raised (the bigger lift — a drag isn't focused, so it must clear the fingertip).</summary>
    public const double DragLiftPx = 300;

    /// <summary>Design px a PEEK-held card is raised (smaller — the focus itself has already moved it up).</summary>
    public const double PeekLiftPx = 120;

    // The one piece of retained state: has this drag's finger ever crossed up into the play zone?
    private bool _enteredPlayZone;

    /// <summary>Reset the play-zone latch for a FRESH grab (a new setHeldCard id / mode).</summary>
    public void Reset() => _enteredPlayZone = false;

    /// <summary>
    /// Whether the held card is CURRENTLY lifted, updating the play-zone latch in place. See the rules above.
    /// <paramref name="viewportHeight"/> is the design height (mirrorRenderer passes MIRROR_DESIGN_HEIGHT = 1080).
    /// </summary>
    public bool Update(HeldMode mode, double? dragStartY, double currentY, double viewportHeight, bool hasVisibleTargetingArrow)
    {
        // Peek wins even over a visible arrow — mirrorRenderer checks the mode first.
        if (mode == HeldMode.Peek)
        {
            return true;
        }

        // Drag + targeting active ⇒ drop the lift so the arrow tip reads at the finger.
        if (hasVisibleTargetingArrow)
        {
            return false;
        }

        var above = currentY < PlayZone.Threshold(viewportHeight, dragStartY);
        if (above)
        {
            _enteredPlayZone = true;
        }

        return !_enteredPlayZone || above;
    }

    /// <summary>The lift height (design px) for a mode — WS-M multiplies this into the translate when lifted.</summary>
    public static double LiftPx(HeldMode mode) => mode == HeldMode.Peek ? PeekLiftPx : DragLiftPx;
}
