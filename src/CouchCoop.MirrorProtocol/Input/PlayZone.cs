namespace CouchCoop.MirrorProtocol.Input;

// The shared play-zone threshold contract, in 1080-design-px space — the same contract the render vocabulary in
// `@spirectl/presentation/render` exposes to the web client (`playZoneThreshold`), restated here so the native
// side and the browser side agree on one line. A dragged card counts as "in the play zone" when the finger's
// design-Y is ABOVE it (numerically strictly below — see mirrorRenderer.applyHeldLift). Reused by
// HeldCardLiftModel (the drag-lift hysteresis) and by WS-M for any "is this card being played?" decision, so it
// is not duplicated per call site.
public static class PlayZone
{
    // The zone's base line, its two tightening margins, and the shortcut loosening — the numbers both clients share.
    public const double PlayZoneBaseRatio = 0.75;
    public const double DragUpTighten = 100;
    public const double DragDownTighten = 50;
    public const double ShortcutLoosen = 100;

    /// <summary>
    /// The design-Y play-zone threshold for a card grabbed at <paramref name="dragStartY"/>. A null
    /// <paramref name="dragStartY"/> is the shortcut start (no grab point — e.g. a fixture-pre-selected card),
    /// which LOOSENS the zone. A grab BELOW the base line tightens up toward it; a grab above tightens down.
    /// </summary>
    public static double Threshold(double viewportHeight, double? dragStartY)
    {
        var baseLine = viewportHeight * PlayZoneBaseRatio;
        if (dragStartY is null)
        {
            return baseLine + ShortcutLoosen;
        }

        if (dragStartY > baseLine)
        {
            return Math.Max(baseLine, dragStartY.Value - DragUpTighten);
        }

        return Math.Min(baseLine, dragStartY.Value - DragDownTighten);
    }
}
