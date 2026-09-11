using System.Buffers.Binary;

namespace CouchCoop.Mod.Server;

// Binary wire format for a streamed Spine animation clip (the body of a `/spines/...` response).
//
// A clip is a sequence of independently tight-cropped PNG frames plus the placement metadata needed to
// composite them aligned inside a shared canvas. The frontend reads `response.body` and decodes each
// frame as its length-prefixed bytes arrive, so a long clip starts painting before the whole body lands.
//
// Layout (little-endian):
//   Header (40 bytes):
//     [0..4)   magic "SPCL"
//     [4]      version (1)
//     [5]      flags   (reserved, 0)
//     [6..8)   reserved (0)
//     [8..12)  frameCount        u32
//     [12..16) canvasWidth       u32   (shared across frames; 0 = the frame IS the canvas)
//     [16..20) canvasHeight      u32
//     [20..24) totalDurationMs   u32
//     [24..28) localX            f32   the node-LOCAL rect the canvas covers (a SpineSprite has no
//     [28..32) localY            f32   localRect, so the browser draws this rect under the node's transform
//     [32..36) localWidth        f32   to align the clip; each frame's offset/canvas then places it within)
//     [36..40) localHeight       f32
//   Per frame (frameCount records, in ascending index order):
//     index      u32
//     offsetX    i32   (signed — placement of this frame's top-left within the canvas)
//     offsetY    i32
//     width      u32   (this frame's own cropped pixel width)
//     height     u32
//     durationMs u32
//     pngLength  u32
//     png        byte[pngLength]
//
// Frames are PNG today; a webp/format flag would use the reserved byte. Keep this format and the frontend
// reader (mirror/spineClip.ts) in lockstep. The 40-byte header includes placement metadata.
internal static class SpineClipWire
{
    public const string ContentType = "application/vnd.couchcoop.spine-clip";
    public const byte Version = 1;
    public const int HeaderSize = 40;
    public const int FrameHeaderSize = 28;

    private static ReadOnlySpan<byte> Magic => "SPCL"u8;

    public static byte[] Serialize(
        IReadOnlyList<SpineClipFrame> frames,
        int canvasWidth,
        int canvasHeight,
        int totalDurationMs,
        double localX = 0,
        double localY = 0,
        double localWidth = 0,
        double localHeight = 0)
    {
        ArgumentNullException.ThrowIfNull(frames);

        var ordered = frames.OrderBy(frame => frame.Index).ToList();
        var total = HeaderSize + ordered.Sum(frame => FrameHeaderSize + frame.EncodedImage.Length);
        var buffer = new byte[total];
        var span = buffer.AsSpan();

        Magic.CopyTo(span);
        span[4] = Version;
        span[5] = 0; // flags
        BinaryPrimitives.WriteUInt16LittleEndian(span[6..], 0); // reserved
        BinaryPrimitives.WriteUInt32LittleEndian(span[8..], (uint)ordered.Count);
        BinaryPrimitives.WriteUInt32LittleEndian(span[12..], (uint)Math.Max(0, canvasWidth));
        BinaryPrimitives.WriteUInt32LittleEndian(span[16..], (uint)Math.Max(0, canvasHeight));
        BinaryPrimitives.WriteUInt32LittleEndian(span[20..], (uint)Math.Max(0, totalDurationMs));
        BinaryPrimitives.WriteSingleLittleEndian(span[24..], (float)localX);
        BinaryPrimitives.WriteSingleLittleEndian(span[28..], (float)localY);
        BinaryPrimitives.WriteSingleLittleEndian(span[32..], (float)localWidth);
        BinaryPrimitives.WriteSingleLittleEndian(span[36..], (float)localHeight);

        var offset = HeaderSize;
        foreach (var frame in ordered)
        {
            var header = span[offset..];
            BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)Math.Max(0, frame.Index));
            BinaryPrimitives.WriteInt32LittleEndian(header[4..], frame.OffsetX);
            BinaryPrimitives.WriteInt32LittleEndian(header[8..], frame.OffsetY);
            BinaryPrimitives.WriteUInt32LittleEndian(header[12..], (uint)Math.Max(0, frame.Width));
            BinaryPrimitives.WriteUInt32LittleEndian(header[16..], (uint)Math.Max(0, frame.Height));
            BinaryPrimitives.WriteUInt32LittleEndian(header[20..], (uint)Math.Max(0, frame.DurationMs));
            BinaryPrimitives.WriteUInt32LittleEndian(header[24..], (uint)frame.EncodedImage.Length);
            offset += FrameHeaderSize;
            frame.EncodedImage.CopyTo(span[offset..]);
            offset += frame.EncodedImage.Length;
        }

        return buffer;
    }

    // Parse a serialized clip back into its manifest + frames. Production never reads its own clips back
    // (the frontend does), but keeping the reader beside the writer pins the format and powers the
    // round-trip test. Throws FormatException on a malformed / truncated stream.
    public static SpineClip Deserialize(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        var span = bytes.AsSpan();
        if (span.Length < HeaderSize || !span[..4].SequenceEqual(Magic))
        {
            throw new FormatException("Spine clip stream is missing its SPCL header.");
        }

        if (span[4] != Version)
        {
            throw new FormatException($"Unsupported spine clip version {span[4]}.");
        }

        var frameCount = (int)BinaryPrimitives.ReadUInt32LittleEndian(span[8..]);
        var canvasWidth = (int)BinaryPrimitives.ReadUInt32LittleEndian(span[12..]);
        var canvasHeight = (int)BinaryPrimitives.ReadUInt32LittleEndian(span[16..]);
        var totalDurationMs = (int)BinaryPrimitives.ReadUInt32LittleEndian(span[20..]);
        var localX = BinaryPrimitives.ReadSingleLittleEndian(span[24..]);
        var localY = BinaryPrimitives.ReadSingleLittleEndian(span[28..]);
        var localWidth = BinaryPrimitives.ReadSingleLittleEndian(span[32..]);
        var localHeight = BinaryPrimitives.ReadSingleLittleEndian(span[36..]);

        var frames = new List<SpineClipFrame>(frameCount);
        var offset = HeaderSize;
        for (var i = 0; i < frameCount; i++)
        {
            if (offset + FrameHeaderSize > span.Length)
            {
                throw new FormatException("Spine clip stream is truncated in a frame header.");
            }

            var header = span[offset..];
            var index = (int)BinaryPrimitives.ReadUInt32LittleEndian(header);
            var offsetX = BinaryPrimitives.ReadInt32LittleEndian(header[4..]);
            var offsetY = BinaryPrimitives.ReadInt32LittleEndian(header[8..]);
            var width = (int)BinaryPrimitives.ReadUInt32LittleEndian(header[12..]);
            var height = (int)BinaryPrimitives.ReadUInt32LittleEndian(header[16..]);
            var durationMs = (int)BinaryPrimitives.ReadUInt32LittleEndian(header[20..]);
            var pngLength = (int)BinaryPrimitives.ReadUInt32LittleEndian(header[24..]);
            offset += FrameHeaderSize;
            if (offset + pngLength > span.Length)
            {
                throw new FormatException("Spine clip stream is truncated in a frame payload.");
            }

            frames.Add(new SpineClipFrame(index, offsetX, offsetY, width, height, durationMs, span.Slice(offset, pngLength).ToArray()));
            offset += pngLength;
        }

        return new SpineClip(canvasWidth, canvasHeight, totalDurationMs, localX, localY, localWidth, localHeight, frames);
    }
}

public sealed record SpineClipFrame(
    int Index,
    int OffsetX,
    int OffsetY,
    int Width,
    int Height,
    int DurationMs,
    byte[] EncodedImage);

public sealed record SpineClip(
    int CanvasWidth,
    int CanvasHeight,
    int TotalDurationMs,
    double LocalX,
    double LocalY,
    double LocalWidth,
    double LocalHeight,
    IReadOnlyList<SpineClipFrame> Frames);
