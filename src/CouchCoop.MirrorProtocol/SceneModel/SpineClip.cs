// SPCL v1 binary Spine-clip reader — the pure, Godot-free port of frontend/src/mirror/spineClip.ts (parse +
// frameIndexAt). The host streams a rendered clip as one binary blob from `GET /spines/<scene>?node=&anim=`
// (see CouchCoop.Mod's SpineClipWire): a small header + length-prefixed encoded image frames, each
// carrying its placement within a shared canvas. This module PARSES that blob and answers "the frame index to
// show at playback time t" — decode-to-texture happens in the Godot client (SpineClipStore) on top of this.
//
// Keep this in lockstep with spineClip.ts and CouchCoop.Mod's SpineClipWire; the Godot-client SpineAttachment
//
// Layout (little-endian):
//   Header (40 bytes): magic "SPCL"(4) | version u8 | flags u8 | reserved u16 | frameCount u32 |
//                      canvasWidth u32 | canvasHeight u32 | totalDurationMs u32 |
//                      localX f32 | localY f32 | localWidth f32 | localHeight f32
//     localX/Y/W/H = the node-LOCAL rect the shared canvas covers (a SpineSprite has no localRect, so the
//     client draws this rect under the node's transform to align the clip).
//   Per frame (28-byte header + image): index u32 | offsetX i32 | offsetY i32 | width u32 | height u32 |
//                      durationMs u32 | imageLength u32 | image[imageLength]

using System;
using System.Buffers.Binary;
using System.Collections.Generic;

namespace CouchCoop.MirrorProtocol.SceneModel;

/// <summary>One tight-cropped clip frame + its placement within the shared canvas.</summary>
public sealed class SpineClipFrame
{
    public int Index;
    public int OffsetX;
    public int OffsetY;
    public int Width;
    public int Height;
    public long DurationMs;
    public long StartMs; // cumulative start time (ms) of this frame within the clip: covers [StartMs, StartMs+DurationMs)
    public byte[] EncodedImage = Array.Empty<byte>();
}

/// <summary>A parsed SPCL v1 clip: canvas + node-local placement rect + the frame table.</summary>
public sealed class SpineClip
{
    private const uint Magic = 0x4C435053; // "SPCL" read as a little-endian u32
    private const byte SupportedVersion = 1;
    private const int HeaderSize = 40;
    private const int FrameHeaderSize = 28;

    public int FrameCount;
    public int CanvasWidth;
    public int CanvasHeight;
    public long TotalDurationMs;
    public float LocalX, LocalY, LocalWidth, LocalHeight;
    public List<SpineClipFrame> Frames = new();

    /// <summary>Nominal FPS = frames / total-duration. 0 for an empty / zero-duration clip.</summary>
    public double ApproxFps() => TotalDurationMs > 0 ? Frames.Count * 1000.0 / TotalDurationMs : 0.0;

    /// <summary>Parse a SPCL blob. Throws <see cref="FormatException"/> on a malformed / truncated / wrong-version stream.</summary>
    public static SpineClip Parse(byte[] bytes)
    {
        if (bytes.Length < HeaderSize)
        {
            throw new FormatException("spine clip: missing SPCL header");
        }

        ReadOnlySpan<byte> span = bytes;
        if (BinaryPrimitives.ReadUInt32LittleEndian(span) != Magic)
        {
            throw new FormatException("spine clip: bad magic (expected SPCL)");
        }

        byte version = span[4];
        if (version != SupportedVersion)
        {
            throw new FormatException($"spine clip: unsupported version {version}");
        }

        var clip = new SpineClip
        {
            FrameCount = (int)BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(8)),
            CanvasWidth = (int)BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(12)),
            CanvasHeight = (int)BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(16)),
            TotalDurationMs = BinaryPrimitives.ReadUInt32LittleEndian(span.Slice(20)),
            LocalX = BinaryPrimitives.ReadSingleLittleEndian(span.Slice(24)),
            LocalY = BinaryPrimitives.ReadSingleLittleEndian(span.Slice(28)),
            LocalWidth = BinaryPrimitives.ReadSingleLittleEndian(span.Slice(32)),
            LocalHeight = BinaryPrimitives.ReadSingleLittleEndian(span.Slice(36)),
        };

        int offset = HeaderSize;
        long startMs = 0;
        for (int i = 0; i < clip.FrameCount; i++)
        {
            if (offset + FrameHeaderSize > bytes.Length)
            {
                throw new FormatException("spine clip: truncated frame header");
            }

            ReadOnlySpan<byte> f = span.Slice(offset);
            var frame = new SpineClipFrame
            {
                Index = (int)BinaryPrimitives.ReadUInt32LittleEndian(f),
                OffsetX = BinaryPrimitives.ReadInt32LittleEndian(f.Slice(4)),
                OffsetY = BinaryPrimitives.ReadInt32LittleEndian(f.Slice(8)),
                Width = (int)BinaryPrimitives.ReadUInt32LittleEndian(f.Slice(12)),
                Height = (int)BinaryPrimitives.ReadUInt32LittleEndian(f.Slice(16)),
                DurationMs = BinaryPrimitives.ReadUInt32LittleEndian(f.Slice(20)),
                StartMs = startMs,
            };
            uint imageLength = BinaryPrimitives.ReadUInt32LittleEndian(f.Slice(24));
            offset += FrameHeaderSize;
            if (offset + (long)imageLength > bytes.Length)
            {
                throw new FormatException("spine clip: truncated frame payload");
            }

            frame.EncodedImage = bytes[offset..(offset + (int)imageLength)];
            clip.Frames.Add(frame);
            offset += (int)imageLength;
            startMs += frame.DurationMs;
        }

        return clip;
    }

    /// <summary>
    /// The index of the frame to show at playback time <paramref name="timeMs"/>. 1:1 port of spineClip.ts
    /// frameIndexAt: when <paramref name="loop"/> (default), WRAPS at the final frame's start time and a negative time
    /// (clock skew) wraps positive; when false, CLAMPS past the end into [0, total-1] so a one-shot anim
    /// (attack/cast/hurt/die) FREEZES on its last frame instead of replaying. Returns 0 for an empty / single-frame
    /// clip. Pure — the client computes the time from the live track-time signal + the loop flag.
    ///
    /// Bakes include an endpoint sample, so looping wraps before that sample while a clamped one-shot can display it.
    /// The loop period falls back to TotalDurationMs when the final StartMs is degenerate (0).
    /// </summary>
    public int FrameIndexAt(double timeMs, bool loop = true)
    {
        var frames = Frames;
        if (frames.Count <= 1)
        {
            return 0;
        }

        double lastStartMs = frames[frames.Count - 1].StartMs;
        double t;
        if (loop)
        {
            // Negative times (clock skew) wrap positive (C# % keeps the dividend's sign, matching JS).
            // frames.Count >= 2 here (guarded above).
            double period = lastStartMs > 0 ? lastStartMs : (TotalDurationMs > 0 ? TotalDurationMs : lastStartMs + 1);
            t = timeMs % period;
            if (t < 0)
            {
                t += period;
            }
        }
        else
        {
            // Freeze at the end: clamp into [0, total) so the binary search lands on the final frame and stays.
            double total = TotalDurationMs > 0 ? TotalDurationMs : lastStartMs + 1;
            t = Math.Max(0, Math.Min(timeMs, total - 1));
        }

        // Frames are ascending by StartMs; find the last frame whose StartMs <= t (binary search).
        int lo = 0;
        int hi = frames.Count - 1;
        while (lo < hi)
        {
            int mid = (lo + hi + 1) >> 1;
            if (frames[mid].StartMs <= t)
            {
                lo = mid;
            }
            else
            {
                hi = mid - 1;
            }
        }

        return lo;
    }
}
