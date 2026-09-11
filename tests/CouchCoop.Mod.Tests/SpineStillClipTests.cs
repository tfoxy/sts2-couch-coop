using CouchCoop.Mod.Server;
using ClientSpineClip = CouchCoop.MirrorProtocol.SceneModel.SpineClip;

// FIX 2b (spine first-frame-immediate streaming) — the client-facing proof for the STILL lane. A `&still=1` request
// serializes ONE frame carrying the same node-local placement rect the animated clip forwards (cell-invariant). This
// asserts the CLIENT decoder (MirrorProtocol SpineClip.Parse — the same path SpineClipStore / spineClip.ts use) reads
// that single-frame still into a PAINTABLE frame (has image bytes, resolves to frame 0 at any playback time) with a
// NON-DEGENERATE Local* placement (localWidth/height > 0 ⇒ a finite, positive draw scale — NOT the old ClipLocal*=0
// that rendered scale(0) = invisible). The blob is built with SpineClipWire.Serialize (the producer's own writer), so
// this is a real writer→reader round-trip, not a hand-rolled fixture.
internal static class SpineStillClipTests
{
    public static void Run()
    {
        SingleFrameStillParsesToPaintableFrameWithNonDegeneratePlacement();
        Console.WriteLine("SpineStillClipTests: ok");
    }

    private static void SingleFrameStillParsesToPaintableFrameWithNonDegeneratePlacement()
    {
        // The neow event-background still: overscan raster 2582x1221 captured at scale 1, expressed node-locally
        // (localWidth = overscanW / 0.58 ≈ 4451.7, etc.). A single frame — the whole point of the still lane.
        const int canvasW = 2582;
        const int canvasH = 1221;
        const double localX = 672.41;
        const double localY = 13.79;
        const double localW = 4451.72;
        const double localH = 2105.17;

        var frames = new List<SpineClipFrame>
        {
            // A non-empty encoded-image marker blob (the decode-to-texture is the Godot client's job; the parse keeps bytes verbatim).
            new(Index: 0, OffsetX: 0, OffsetY: 0, Width: canvasW, Height: canvasH, DurationMs: 0, EncodedImage: [0x89, (byte)'P', (byte)'N', (byte)'G', 0x1]),
        };
        var blob = SpineClipWire.Serialize(frames, canvasW, canvasH, totalDurationMs: 0, localX, localY, localW, localH);

        // Decode through the CLIENT parser (the path the browser + Godot client actually run).
        var clip = ClientSpineClip.Parse(blob);

        Expect(clip.FrameCount == 1, "a still parses to exactly ONE frame");
        Expect(clip.Frames.Count == 1, "the frame table holds the single still frame");

        // Paintable: the frame carries image bytes and covers the WHOLE playback timeline (frame 0 at any time).
        Expect(clip.Frames[0].Index == 0, "the still frame is index 0");
        Expect(clip.Frames[0].EncodedImage.Length > 0, "the still frame is paintable (carries image bytes)");
        Expect(clip.FrameIndexAt(0) == 0, "a still shows frame 0 at t=0");
        Expect(clip.FrameIndexAt(99_999) == 0, "a still shows frame 0 at any positive time (it never advances)");
        Expect(clip.FrameIndexAt(-99_999, loop: false) == 0, "a still clamps a negative time to frame 0");

        // Non-degenerate placement: canvas + local rect are positive, so the client draw scale (localWidth/canvasWidth)
        // is finite and > 0 — the still lands at a real node-local rect, NOT the old scale(0) invisible ClipLocal*=0.
        Expect(clip.CanvasWidth == canvasW && clip.CanvasHeight == canvasH, "the still preserves its shared canvas size");
        Expect(clip.LocalWidth > 1f && clip.LocalHeight > 1f, "the still has a non-degenerate node-local placement size");
        Expect(Math.Abs(clip.LocalX - localX) < 1e-2 && Math.Abs(clip.LocalY - localY) < 1e-2, "the still preserves its node-local origin");
        Expect(Math.Abs(clip.LocalWidth - localW) < 1e-2 && Math.Abs(clip.LocalHeight - localH) < 1e-2, "the still preserves its node-local extent");

        var scale = clip.LocalWidth / clip.CanvasWidth;
        Expect(float.IsFinite(scale) && scale > 0f, "the still's draw scale (localWidth/canvasWidth) is finite and positive");
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"assertion failed: {label}");
        }
    }
}
