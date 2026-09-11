using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-7 (#14): the shared "should a single-frame clip be re-requested?" rule the native client applies in
// SpineAttachment.OnClipArrived (the web twin runs the identical inline guard in mirrorRenderer.ts). The load-bearing
// case is the new one: a host-DEGRADED clip must NOT escalate — that would re-ask for the expensive bake, once per
// spine node, exactly when the host declined the work because the machine was oversubscribed.
internal static class SpineClipEscalationTests
{
    public static void Run()
    {
        EscalatesAnUnexplainedSingleFrame();
        NeverEscalatesADegradedClip();
        NeverEscalatesADeliberateStill();
        NeverEscalatesTwiceOrAMultiFrameClip();
    }

    private static void EscalatesAnUnexplainedSingleFrame()
    {
        Check.That(
            SpineClipEscalation.ShouldEscalateSingleFrame(1, alreadyEscalated: false, stillRequest: false, degraded: false),
            "#4 preserved: an unexplained 1-frame animated clip escalates once");
    }

    private static void NeverEscalatesADegradedClip()
    {
        Check.That(
            !SpineClipEscalation.ShouldEscalateSingleFrame(1, alreadyEscalated: false, stillRequest: false, degraded: true),
            "a host-degraded single frame never escalates (no re-request storm under pressure)");
    }

    private static void NeverEscalatesADeliberateStill()
    {
        Check.That(
            !SpineClipEscalation.ShouldEscalateSingleFrame(1, alreadyEscalated: false, stillRequest: true, degraded: false),
            "a deliberate still is legitimately 1 frame");
    }

    private static void NeverEscalatesTwiceOrAMultiFrameClip()
    {
        Check.That(
            !SpineClipEscalation.ShouldEscalateSingleFrame(1, alreadyEscalated: true, stillRequest: false, degraded: false),
            "the escalation stays one-shot per identity");
        Check.That(
            !SpineClipEscalation.ShouldEscalateSingleFrame(2, alreadyEscalated: false, stillRequest: false, degraded: false),
            "a real multi-frame clip never escalates");
        Check.That(
            !SpineClipEscalation.ShouldEscalateSingleFrame(0, alreadyEscalated: false, stillRequest: false, degraded: false),
            "an empty clip is a failure, not a collapse — it takes the failure path instead");
    }
}
