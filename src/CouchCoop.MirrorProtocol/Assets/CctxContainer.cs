using System.Buffers.Binary;

namespace CouchCoop.MirrorProtocol.Assets;

// Track F2a: the "CCTX" (CouchCoop TeXture) container — CouchCoop's OWN wire format for host-precompressed GPU
// textures streamed over the `/res/{path}?fmt=astc` route. The host tools-editor encodes a served PNG/WEBP to
// GPU-native ASTC 4x4 once (see scripts/transcode-texture-cache.mjs + scripts/transcode-godot/transcode.gd) and
// wraps the raw Godot Image bytes in this tiny fixed header; the phone client sniffs the magic, parses the header,
// and hands the payload straight to Image.CreateFromData — NO codec decode, NO mipgen, NO GPU-side re-encode. ASTC
// 4x4 is 8bpp vs RGBA8 32bpp, so the Mali texture unit (the measured bottleneck) fetches ~4x fewer bytes. NOTE the
// WIRE goes the other way: source blobs are entropy-coded PNG/WEBP, so a CCTX (raw ASTC + baked mips) is ~2x LARGER
// on the wire — the trade is upload size for GPU fetch bandwidth + zero client decode/mipgen.
//
// This is deliberately NOT KTX2: a bespoke fixed 32-byte header needs zero extra client-side modules (the payload
// is exactly what get_data() produced for that format/size/mip-count, which is exactly what CreateFromData wants
// back), where LoadKtxFromBuffer would add a parse path we don't otherwise need.
//
// Pure + Godot-free so it is Exe-testable AND shared by BOTH sides: the client (godot-client) reads it before the
// Godot upload, and the transcoder GDScript writes the identical byte layout. Little-endian throughout.
//
// LAYOUT (all multi-byte fields little-endian):
//   [0..4)   magic  = ASCII "CCTX"
//   [4..8)   u32 version                     (currently 1)
//   [8..12)  u32 width                        (pixels)
//   [12..16) u32 height                       (pixels)
//   [16..20) u32 godotImageFormat             (Godot Image.Format enum int; ASTC 4x4 = 35 in 4.5.1)
//   [20..24) u32 mipmapFlag                   (1 = payload carries a full mip chain, 0 = base level only)
//   [24..32) u64 dataLen                       (payload byte count that follows the header)
//   [32..)   raw Image.get_data() bytes        (dataLen bytes)
public static class CctxContainer
{
    // "CCTX" as ASCII bytes.
    public static readonly byte[] MagicBytes = { (byte)'C', (byte)'C', (byte)'T', (byte)'X' };

    // Fixed header size in bytes (magic + 4×u32 + u64).
    public const int HeaderSize = 32;

    // Current container version. Bumped only if the header layout changes.
    public const uint Version = 1;

    // The diagnostic content-type the mod/replay server labels a CCTX body with (the client sniffs MAGIC, not this).
    public const string ContentType = "application/x-cctx";

    // True when the buffer begins with the CCTX magic (cheap sniff before a full parse). Byte-based so it matches
    // the phone client's raw-bytes check exactly.
    public static bool IsCctx(byte[] bytes) => IsCctx(bytes.AsSpan());

    public static bool IsCctx(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 4 &&
        bytes[0] == MagicBytes[0] && bytes[1] == MagicBytes[1] &&
        bytes[2] == MagicBytes[2] && bytes[3] == MagicBytes[3];

    // Parse the fixed header. Returns null when the buffer is too short, lacks the magic, has an unknown version, or
    // the declared payload length does not fit the buffer (a truncated/corrupt blob → the caller falls back / fails).
    public static CctxHeader? TryParseHeader(byte[] bytes) => TryParseHeader(bytes.AsSpan());

    public static CctxHeader? TryParseHeader(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < HeaderSize || !IsCctx(bytes))
        {
            return null;
        }

        uint version = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(4, 4));
        if (version != Version)
        {
            return null;
        }

        uint width = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(8, 4));
        uint height = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(12, 4));
        uint format = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(16, 4));
        uint mipmapFlag = BinaryPrimitives.ReadUInt32LittleEndian(bytes.Slice(20, 4));
        ulong dataLen = BinaryPrimitives.ReadUInt64LittleEndian(bytes.Slice(24, 8));

        // The payload must be present in full (guards a truncated body from producing a bogus CreateFromData call).
        if (dataLen > (ulong)(bytes.Length - HeaderSize))
        {
            return null;
        }

        return new CctxHeader(version, (int)width, (int)height, (int)format, mipmapFlag != 0, (long)dataLen);
    }

    // Build a CCTX blob from an already-compressed payload. Used by the pure C# test (and available to any C#-side
    // encoder); the shipped transcoder is GDScript writing this identical layout. `format` is the Godot Image.Format
    // enum int of the payload.
    public static byte[] Build(int width, int height, int format, bool hasMipmaps, byte[] data)
    {
        var buffer = new byte[HeaderSize + data.Length];
        var span = buffer.AsSpan();
        MagicBytes.CopyTo(span);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(4, 4), Version);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(8, 4), (uint)width);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(12, 4), (uint)height);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(16, 4), (uint)format);
        BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(20, 4), hasMipmaps ? 1u : 0u);
        BinaryPrimitives.WriteUInt64LittleEndian(span.Slice(24, 8), (ulong)data.Length);
        data.CopyTo(span.Slice(HeaderSize));
        return buffer;
    }
}

// Parsed CCTX header fields. DataOffset is always HeaderSize (the payload immediately follows the fixed header).
public readonly record struct CctxHeader(
    uint Version,
    int Width,
    int Height,
    int Format,
    bool HasMipmaps,
    long DataLength)
{
    public int DataOffset => CctxContainer.HeaderSize;
}
