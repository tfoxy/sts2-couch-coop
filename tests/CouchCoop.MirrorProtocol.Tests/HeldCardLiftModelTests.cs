using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.Tests;

// Truth-table checks for HeldCardLiftModel (port of mirrorRenderer.ts applyHeldLift): peek lifts unconditionally,
// a visible targeting arrow drops a DRAG lift (but not a peek), and the drag lift latches on play-zone entry and
// drops on return-to-hand. Design height 1080 ⇒ play-zone base line 810.
internal static class HeldCardLiftModelTests
{
    public static void Run()
    {
        LiftConstants();
        PeekLiftsUnconditionallyEvenWithArrow();
        TargetingArrowDropsDragLift();
        DragLiftsOffPickupBeforeEntry();
        DragLatchesOnEntryAndDropsOnReturn();
        ResetClearsLatch();
    }

    private const double H = 1080; // design height (MIRROR_DESIGN_HEIGHT)

    private static void LiftConstants()
    {
        Check.Close(HeldCardLiftModel.DragLiftPx, 300, "drag lift px");
        Check.Close(HeldCardLiftModel.PeekLiftPx, 120, "peek lift px");
        Check.Close(HeldCardLiftModel.LiftPx(HeldMode.Drag), 300, "LiftPx(drag)");
        Check.Close(HeldCardLiftModel.LiftPx(HeldMode.Peek), 120, "LiftPx(peek)");
    }

    // Peek is checked FIRST in applyHeldLift → lifts even while a targeting arrow is visible and regardless of Y.
    private static void PeekLiftsUnconditionallyEvenWithArrow()
    {
        var m = new HeldCardLiftModel();
        Check.That(m.Update(HeldMode.Peek, dragStartY: 900, currentY: 1000, H, hasVisibleTargetingArrow: false), "peek lifts (below line)");
        Check.That(m.Update(HeldMode.Peek, dragStartY: 900, currentY: 100, H, hasVisibleTargetingArrow: true), "peek lifts even with arrow");
    }

    // A visible NTargetingArrow drops a DRAG lift (card static, arrow tip reads at the finger).
    private static void TargetingArrowDropsDragLift()
    {
        var m = new HeldCardLiftModel();
        // Finger well up in the play zone (would normally lift), but the arrow is visible → dropped.
        Check.That(!m.Update(HeldMode.Drag, dragStartY: 900, currentY: 100, H, hasVisibleTargetingArrow: true), "arrow drops drag lift");
    }

    // Before the finger has entered the play zone (latch false), a drag lifts straight off the pickup.
    private static void DragLiftsOffPickupBeforeEntry()
    {
        var m = new HeldCardLiftModel();
        // Grab at 900 (> base 810) → threshold = max(810, 800) = 810. Finger still at 900 (below the line, not yet
        // in the zone): !entered(true) || above(false) → lifted (lifts off the pickup).
        Check.That(m.Update(HeldMode.Drag, dragStartY: 900, currentY: 900, H, hasVisibleTargetingArrow: false), "lifts off pickup before entry");
    }

    // Latch on entry, then track the line so a drag back to the hand DROPS the lift.
    private static void DragLatchesOnEntryAndDropsOnReturn()
    {
        var m = new HeldCardLiftModel();
        // Grab at 900 → threshold 810.
        // 1) At pickup (900, below line): lifted (off the pickup).
        Check.That(m.Update(HeldMode.Drag, 900, 900, H, false), "step1: lifted off pickup");
        // 2) Cross UP into the zone (700 < 810): latches entered, above → lifted.
        Check.That(m.Update(HeldMode.Drag, 900, 700, H, false), "step2: in zone → lifted (latched)");
        // 3) Drag back DOWN below the line (900 > 810): entered latched, above false → NOT lifted (returns to hand).
        Check.That(!m.Update(HeldMode.Drag, 900, 900, H, false), "step3: back to hand after entry → dropped");
        // 4) Cross up again (700): above true → lifted again.
        Check.That(m.Update(HeldMode.Drag, 900, 700, H, false), "step4: re-enter zone → lifted");
    }

    // Reset clears the latch so a fresh grab lifts off the pickup again.
    private static void ResetClearsLatch()
    {
        var m = new HeldCardLiftModel();
        // Enter the zone to latch, then drop below the line (not lifted).
        m.Update(HeldMode.Drag, 900, 700, H, false); // latch
        Check.That(!m.Update(HeldMode.Drag, 900, 900, H, false), "dropped after entry+return");
        // Fresh grab: reset the latch → below-line pickup lifts again.
        m.Reset();
        Check.That(m.Update(HeldMode.Drag, 900, 900, H, false), "after Reset, below-line pickup lifts again");
    }
}
