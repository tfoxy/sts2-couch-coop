// Pure decision: "this clip came back with a SINGLE frame — do I re-request it?" Shared by the native client
// (SpineAttachment.OnClipArrived) and mirrored 1:1 by the web twin's inline guard in mirrorRenderer.ts, so both
// clients answer a degraded/still response identically.

namespace CouchCoop.MirrorProtocol.SceneModel;

/// <summary>The one-shot <c>&amp;retry=1</c> re-request rule for a single-frame spine clip.</summary>
/// <remarks>
/// <para>
/// A real baked clip always carries at least the duplicate tail frame, so a 1-frame ANIMATED result used to mean
/// exactly one thing: the producer's oversized-budget collapse (or a stale immutable blob). The client answered by
/// re-requesting once under a distinct key (<c>&amp;retry=1</c>) to force a fresh render.
/// </para>
/// <para>
/// Round-8 item 14 added a second, LEGITIMATE source of 1-frame clips: the host DEGRADES a bake to a single frame
/// while the machine is oversubscribed and says so on the response. Escalating that would be the worst possible
/// reaction — it re-asks for the expensive bake precisely when the host just declined to run it, once per spine
/// node, i.e. a request storm exactly when the machine is least able to serve it. A deliberate still (the tier's
/// still-only mode, or the still-first placeholder) is the same story and was already exempt.
/// </para>
/// </remarks>
public static class SpineClipEscalation
{
    /// <summary>
    /// Whether a just-arrived clip should trigger the ONE-SHOT full-bake re-request.
    /// </summary>
    /// <param name="frameCount">Frames in the arrived clip.</param>
    /// <param name="alreadyEscalated">This identity already spent its one-shot escalation.</param>
    /// <param name="stillRequest">The request deliberately asked for a single frame (still-only tier / placeholder).</param>
    /// <param name="degraded">The host marked the response as a degraded single-frame stand-in.</param>
    public static bool ShouldEscalateSingleFrame(
        int frameCount,
        bool alreadyEscalated,
        bool stillRequest,
        bool degraded)
        => frameCount == 1 && !alreadyEscalated && !stillRequest && !degraded;
}
