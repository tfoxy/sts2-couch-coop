using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.Tests;

// Verbatim-port checks of PlayZone.Threshold (spirectl targeting.ts playZoneThreshold): all four branches
// (shortcut/null, grab below base, grab above base, grab exactly at base) against hand-computed values.
internal static class PlayZoneTests
{
    public static void Run()
    {
        ConstantsMatchSource();
        NullDragStartLoosens();
        GrabAboveBaseTightensDown();
        GrabBelowBaseTightensUp();
        GrabExactlyAtBase();
    }

    // 1080-design-space base = 810.
    private const double H = 1080;
    private const double Base = 810; // 1080 * 0.75

    private static void ConstantsMatchSource()
    {
        Check.Close(PlayZone.PlayZoneBaseRatio, 0.75, "base ratio");
        Check.Close(PlayZone.DragUpTighten, 100, "drag-up tighten");
        Check.Close(PlayZone.DragDownTighten, 50, "drag-down tighten");
        Check.Close(PlayZone.ShortcutLoosen, 100, "shortcut loosen");
    }

    // dragStartY === null → base + SHORTCUT_LOOSEN (loosened, no grab point).
    private static void NullDragStartLoosens()
    {
        Check.Close(PlayZone.Threshold(H, null), Base + 100, "null dragStartY → base + 100");
    }

    // dragStartY <= base → min(base, dragStartY - DRAG_DOWN_TIGHTEN). A grab well above base tightens DOWN toward it.
    private static void GrabBelowBaseTightensUp()
    {
        // Grab at 400 (< base): min(810, 400 - 50) = 350.
        Check.Close(PlayZone.Threshold(H, 400), 350, "grab at 400 → min(810, 350) = 350");
        // Grab at 900 is > base, so it uses the OTHER branch (see GrabAboveBaseTightensDown). Here a grab at 800
        // (< base): min(810, 750) = 750.
        Check.Close(PlayZone.Threshold(H, 800), 750, "grab at 800 → min(810, 750) = 750");
    }

    // dragStartY > base → max(base, dragStartY - DRAG_UP_TIGHTEN). A grab below the base line tightens UP toward it.
    private static void GrabAboveBaseTightensDown()
    {
        // Grab at 1000 (> base): max(810, 1000 - 100) = 900.
        Check.Close(PlayZone.Threshold(H, 1000), 900, "grab at 1000 → max(810, 900) = 900");
        // Grab at 850 (> base but within 100 of it): max(810, 750) = 810 (clamped to base).
        Check.Close(PlayZone.Threshold(H, 850), 810, "grab at 850 → max(810, 750) = 810 (clamped)");
    }

    // dragStartY === base → the else branch (not >): min(base, base - 50) = base - 50.
    private static void GrabExactlyAtBase()
    {
        Check.Close(PlayZone.Threshold(H, Base), Base - 50, "grab exactly at base → min(base, base-50) = base-50");
    }
}
