using System.Buffers.Binary;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// SPCL v1 decoder + frameIndexAt parity suite for the shared SpineClip (the Godot-free port of
// frontend/src/mirror/spineClip.ts). The fixture is hand-built in code (NO real game clip — artifact policy);
// the frameIndexAt cases mirror the TS loop/clamp/negative behavior 1:1.
internal static class SpineClipTests
{
    public static void Run()
    {
        ParsesSyntheticFixture();
        RejectsMalformed();
        FrameIndexLoops();
        FrameIndexClampsNonLoop();
        FrameIndexNegativeWraps();
        FrameIndexSingleFrame();
        FrameIndexZeroTotalFallback();
        FrameIndexLoopBoundary();
        FrameIndexTwoFrameLoop();
    }

    // A synthetic SPCL: 3 frames (durations 100/100/150 => total 350ms), canvas 64x48, local rect
    // (-10,-20,64,48). Each frame's "png" is a distinct non-PNG marker blob (parse keeps bytes verbatim; decode
    // is the Godot client's job, out of scope for this pure suite).
    private static byte[] BuildSpcl(
        byte version = 1,
        int frameCount = 3,
        int canvasW = 64,
        int canvasH = 48,
        uint totalMs = 350,
        (int off, int width, int height, uint dur, byte[] png)[]? frames = null)
    {
        frames ??= new (int, int, int, uint, byte[])[]
        {
            (0, 32, 40, 100, new byte[] { 1, 1, 1 }),
            (5, 30, 38, 100, new byte[] { 2, 2, 2, 2 }),
            (7, 28, 36, 150, new byte[] { 3, 3 }),
        };

        var buf = new List<byte>();
        void U32(uint v) { Span<byte> s = stackalloc byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(s, v); buf.AddRange(s.ToArray()); }
        void I32(int v) { Span<byte> s = stackalloc byte[4]; BinaryPrimitives.WriteInt32LittleEndian(s, v); buf.AddRange(s.ToArray()); }
        void F32(float v) { Span<byte> s = stackalloc byte[4]; BinaryPrimitives.WriteSingleLittleEndian(s, v); buf.AddRange(s.ToArray()); }

        // Header (40 bytes).
        buf.AddRange("SPCL"u8.ToArray()); // magic
        buf.Add(version);                 // version
        buf.Add(0);                       // flags
        buf.Add(0); buf.Add(0);           // reserved u16
        U32((uint)frameCount);
        U32((uint)canvasW);
        U32((uint)canvasH);
        U32(totalMs);
        F32(-10f); F32(-20f); F32(64f); F32(48f); // localX/Y/W/H

        // Frames.
        for (int i = 0; i < frames.Length; i++)
        {
            var (off, width, height, dur, png) = frames[i];
            U32((uint)i);       // index
            I32(off);           // offsetX
            I32(off + 1);       // offsetY (distinct from X so the read order is verified)
            U32((uint)width);
            U32((uint)height);
            U32(dur);
            U32((uint)png.Length);
            buf.AddRange(png);
        }

        return buf.ToArray();
    }

    private static void ParsesSyntheticFixture()
    {
        var clip = SpineClip.Parse(BuildSpcl());

        Check.Equal(clip.FrameCount, 3, "frameCount");
        Check.Equal(clip.CanvasWidth, 64, "canvasWidth");
        Check.Equal(clip.CanvasHeight, 48, "canvasHeight");
        Check.Equal(clip.TotalDurationMs, 350L, "totalDurationMs");
        Check.Close(clip.LocalX, -10, "localX");
        Check.Close(clip.LocalY, -20, "localY");
        Check.Close(clip.LocalWidth, 64, "localWidth");
        Check.Close(clip.LocalHeight, 48, "localHeight");
        Check.Equal(clip.Frames.Count, 3, "frames parsed");

        // Frame 0.
        Check.Equal(clip.Frames[0].Index, 0, "f0.index");
        Check.Equal(clip.Frames[0].OffsetX, 0, "f0.offsetX");
        Check.Equal(clip.Frames[0].OffsetY, 1, "f0.offsetY");
        Check.Equal(clip.Frames[0].Width, 32, "f0.width");
        Check.Equal(clip.Frames[0].Height, 40, "f0.height");
        Check.Equal(clip.Frames[0].DurationMs, 100L, "f0.durationMs");
        Check.Equal(clip.Frames[0].StartMs, 0L, "f0.startMs");
        Check.Equal(clip.Frames[0].EncodedImage.Length, 3, "f0 image length");
        Check.Equal(clip.Frames[0].EncodedImage[0], (byte)1, "f0 image byte");

        // Cumulative StartMs: 0, 100, 200.
        Check.Equal(clip.Frames[1].StartMs, 100L, "f1.startMs");
        Check.Equal(clip.Frames[2].StartMs, 200L, "f2.startMs");
        Check.Equal(clip.Frames[2].DurationMs, 150L, "f2.durationMs");
        Check.Equal(clip.Frames[1].EncodedImage.Length, 4, "f1 image length");
        Check.Equal(clip.Frames[2].EncodedImage.Length, 2, "f2 image length");

        // ApproxFps = 3 * 1000 / 350.
        Check.Close(clip.ApproxFps(), 3 * 1000.0 / 350.0, "approxFps");
    }

    private static void RejectsMalformed()
    {
        Throws(() => SpineClip.Parse(new byte[10]), "short buffer (< header) rejected");
        Throws(() => SpineClip.Parse(BuildSpcl(version: 3)), "wrong version rejected");

        // Bad magic: flip the first byte.
        var badMagic = BuildSpcl();
        badMagic[0] = (byte)'X';
        Throws(() => SpineClip.Parse(badMagic), "bad magic rejected");

        // Truncated frame payload: chop off the tail bytes.
        var full = BuildSpcl();
        var truncated = full[..(full.Length - 2)];
        Throws(() => SpineClip.Parse(truncated), "truncated frame payload rejected");
    }

    private static void FrameIndexLoops()
    {
        var clip = ParseLoopingSpcl();
        Check.Equal(clip.FrameIndexAt(0), 0, "loop t=0 -> f0");
        Check.Equal(clip.FrameIndexAt(50), 0, "loop t=50 -> f0");
        Check.Equal(clip.FrameIndexAt(100), 1, "loop t=100 -> f1");
        Check.Equal(clip.FrameIndexAt(199), 1, "loop t=199 -> f1");
        Check.Equal(clip.FrameIndexAt(200), 2, "loop t=200 -> f2");
        Check.Equal(clip.FrameIndexAt(299), 2, "loop t=299 -> f2");
        Check.Equal(clip.FrameIndexAt(300), 0, "loop t=period wraps -> f0");
        Check.Equal(clip.FrameIndexAt(450), 1, "loop t=450 wraps 150 -> f1");
    }

    // Non-loop clamps into [0, total-1] so a one-shot freezes on its last frame.
    private static void FrameIndexClampsNonLoop()
    {
        var clip = SpineClip.Parse(BuildSpcl());
        Check.Equal(clip.FrameIndexAt(100, loop: false), 1, "clamp t=100 -> f1");
        Check.Equal(clip.FrameIndexAt(349, loop: false), 2, "clamp t=349 -> f2");
        Check.Equal(clip.FrameIndexAt(350, loop: false), 2, "clamp t=total -> freeze f2");
        Check.Equal(clip.FrameIndexAt(100000, loop: false), 2, "clamp t=huge -> freeze last f2");
        Check.Equal(clip.FrameIndexAt(-100, loop: false), 0, "clamp t=neg -> f0");
    }

    // Negative time under loop wraps positive.
    private static void FrameIndexNegativeWraps()
    {
        var clip = ParseLoopingSpcl();
        Check.Equal(clip.FrameIndexAt(-50), 2, "loop t=-50 -> 250 -> f2");
        Check.Equal(clip.FrameIndexAt(-1), 2, "loop t=-1 -> 299 -> f2");
        Check.Equal(clip.FrameIndexAt(-300), 0, "loop t=-period -> 0 -> f0");
        Check.Equal(clip.FrameIndexAt(-200), 1, "loop t=-200 -> 100 -> f1");
    }

    // A single-frame (or empty) clip is always frame 0, loop or not, at any time.
    private static void FrameIndexSingleFrame()
    {
        var single = SpineClip.Parse(BuildSpcl(
            frameCount: 1,
            totalMs: 200,
            frames: new (int, int, int, uint, byte[])[] { (0, 10, 10, 200, new byte[] { 9 }) }));
        Check.Equal(single.Frames.Count, 1, "single frame parsed");
        Check.Equal(single.FrameIndexAt(0), 0, "single t=0 -> 0");
        Check.Equal(single.FrameIndexAt(99999), 0, "single t=huge -> 0");
        Check.Equal(single.FrameIndexAt(-99999, loop: false), 0, "single neg clamp -> 0");
    }

    // TotalDurationMs == 0 with real frames: total falls back to lastStartMs + 1 (matches the TS guard).
    private static void FrameIndexZeroTotalFallback()
    {
        var clip = new SpineClip
        {
            FrameCount = 2,
            CanvasWidth = 8,
            CanvasHeight = 8,
            TotalDurationMs = 0,
            Frames =
            {
                new SpineClipFrame { Index = 0, DurationMs = 100, StartMs = 0 },
                new SpineClipFrame { Index = 1, DurationMs = 100, StartMs = 100 },
            },
        };
        // A usable final start defines the loop period even when the wire duration is absent.
        Check.Equal(clip.FrameIndexAt(100), 0, "zero-total loop t=100 wraps -> f0");
        Check.Equal(clip.FrameIndexAt(101), 0, "zero-total loop t=101 -> f0");
    }

    // The endpoint sample remains available to a clamped one-shot, but a loop wraps at its start time.
    private static void FrameIndexLoopBoundary()
    {
        var clip = ParseLoopingSpcl();

        Check.Equal(clip.FrameIndexAt(0), 0, "loop t=0 -> f0");
        Check.Equal(clip.FrameIndexAt(100), 1, "loop t=100 -> f1");
        Check.Equal(clip.FrameIndexAt(200), 2, "loop t=200 -> f2");
        Check.Equal(clip.FrameIndexAt(299), 2, "loop t=299 -> f2");
        Check.Equal(clip.FrameIndexAt(300), 0, "loop t=300 wraps -> f0");
        Check.Equal(clip.FrameIndexAt(350), 0, "loop t=350 -> f0");
        Check.Equal(clip.FrameIndexAt(400), 1, "loop t=400 -> f1");
        Check.Equal(clip.FrameIndexAt(-100), 2, "loop t=-100 -> f2");

        // The endpoint sample (index 3) is not reached while looping.
        for (int t = 0; t < 300; t++)
        {
            if (clip.FrameIndexAt(t) == 3)
            {
                throw new Exception($"loop reached the endpoint sample at t={t}");
            }
        }
    }

    // A two-frame endpoint bake loops on its first frame.
    private static void FrameIndexTwoFrameLoop()
    {
        var clip = SpineClip.Parse(BuildSpcl(
            frameCount: 2,
            totalMs: 200,
            frames: new (int, int, int, uint, byte[])[]
            {
                (0, 10, 10, 100, new byte[] { 0 }),
                (0, 10, 10, 100, new byte[] { 1 }), // duplicate tail
            }));
        Check.Equal(clip.FrameIndexAt(0), 0, "2-frame loop t=0 -> f0");
        Check.Equal(clip.FrameIndexAt(50), 0, "2-frame loop t=50 -> f0");
        Check.Equal(clip.FrameIndexAt(100), 0, "2-frame loop t=100 wraps -> f0");
        Check.Equal(clip.FrameIndexAt(150), 0, "2-frame loop t=150 -> f0");
    }

    private static SpineClip ParseLoopingSpcl() => SpineClip.Parse(BuildSpcl(
        frameCount: 4,
        totalMs: 400,
        frames: new (int, int, int, uint, byte[])[]
        {
            (0, 10, 10, 100, new byte[] { 0 }),
            (0, 10, 10, 100, new byte[] { 1 }),
            (0, 10, 10, 100, new byte[] { 2 }),
            (0, 10, 10, 100, new byte[] { 3 }),
        }));

    private static void Throws(Action action, string label)
    {
        try
        {
            action();
        }
        catch (FormatException)
        {
            return;
        }

        throw new Exception($"assertion failed: {label} (expected FormatException, none thrown)");
    }
}
