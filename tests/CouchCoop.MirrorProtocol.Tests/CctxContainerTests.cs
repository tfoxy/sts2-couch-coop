using System.Buffers.Binary;
using CouchCoop.MirrorProtocol.Assets;

namespace CouchCoop.MirrorProtocol.Tests;

// Track F2a: the CCTX host-precompressed-texture container header parse (pure C#, Godot-free). Mirrors the byte
// layout the transcoder GDScript writes and the phone client reads before Image.CreateFromData.
internal static class CctxContainerTests
{
    public static void Run()
    {
        RoundTrip();
        RejectsGarbage();
        RejectsTruncatedPayload();
        RejectsWrongVersion();
        ExactByteLayout();
    }

    // Build → parse → fields match; payload sits at the fixed offset.
    private static void RoundTrip()
    {
        var payload = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 };
        // format 35 = Godot Image.FORMAT_ASTC_4x4 in 4.5.1 (the shipped encode target).
        var blob = CctxContainer.Build(256, 128, 35, hasMipmaps: true, payload);

        Check.That(CctxContainer.IsCctx(blob), "cctx: magic recognized");
        var header = CctxContainer.TryParseHeader(blob);
        Check.That(header is not null, "cctx: parses");
        var h = header!.Value;
        Check.Equal(h.Version, 1u, "cctx: version");
        Check.Equal(h.Width, 256, "cctx: width");
        Check.Equal(h.Height, 128, "cctx: height");
        Check.Equal(h.Format, 35, "cctx: format enum");
        Check.That(h.HasMipmaps, "cctx: mip flag");
        Check.Equal(h.DataLength, (long)payload.Length, "cctx: dataLen");
        Check.Equal(h.DataOffset, CctxContainer.HeaderSize, "cctx: payload offset");

        // The payload bytes past the header are exactly what went in.
        var recovered = new byte[payload.Length];
        Array.Copy(blob, h.DataOffset, recovered, 0, payload.Length);
        for (int i = 0; i < payload.Length; i++)
        {
            Check.Equal(recovered[i], payload[i], $"cctx: payload[{i}]");
        }
    }

    // A PNG/plain buffer (no CCTX magic) is not mistaken for a container → the client keeps the decode path.
    private static void RejectsGarbage()
    {
        var png = new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 0, 0, 0, 0 };
        Check.That(!CctxContainer.IsCctx(png), "cctx: PNG magic not CCTX");
        Check.That(CctxContainer.TryParseHeader(png) is null, "cctx: PNG does not parse as CCTX");
        Check.That(CctxContainer.TryParseHeader(Array.Empty<byte>()) is null, "cctx: empty does not parse");
        Check.That(!CctxContainer.IsCctx(new byte[] { (byte)'C', (byte)'C' }), "cctx: short buffer not CCTX");
    }

    // A header claiming more payload than is present must be rejected (guards a truncated download).
    private static void RejectsTruncatedPayload()
    {
        var blob = CctxContainer.Build(64, 64, 35, hasMipmaps: false, new byte[] { 9, 9, 9, 9 });
        // Chop off the last 2 payload bytes but leave the header intact.
        var truncated = blob.AsSpan(0, blob.Length - 2).ToArray();
        Check.That(CctxContainer.IsCctx(truncated), "cctx: truncated still has magic");
        Check.That(CctxContainer.TryParseHeader(truncated) is null, "cctx: truncated payload rejected");
    }

    // An unknown version is rejected (forward-compat guard — client falls back rather than misreads).
    private static void RejectsWrongVersion()
    {
        var blob = CctxContainer.Build(8, 8, 35, hasMipmaps: false, new byte[] { 1, 2, 3, 4 });
        BinaryPrimitives.WriteUInt32LittleEndian(blob.AsSpan(4, 4), 999u);
        Check.That(CctxContainer.TryParseHeader(blob) is null, "cctx: unknown version rejected");
    }

    // Pin the exact on-wire header bytes so the GDScript writer and this reader can never silently drift.
    private static void ExactByteLayout()
    {
        var blob = CctxContainer.Build(0x0100, 0x0080, 35, hasMipmaps: true, new byte[] { 0xAA });
        Check.Equal(blob.Length, CctxContainer.HeaderSize + 1, "cctx: total size");
        // magic "CCTX"
        Check.Equal(blob[0], (byte)'C', "cctx: byte0");
        Check.Equal(blob[1], (byte)'C', "cctx: byte1");
        Check.Equal(blob[2], (byte)'T', "cctx: byte2");
        Check.Equal(blob[3], (byte)'X', "cctx: byte3");
        // version=1 LE
        Check.Equal(blob[4], (byte)1, "cctx: version LE b0");
        Check.Equal(blob[5], (byte)0, "cctx: version LE b1");
        // width=0x0100 LE → 00 01 00 00
        Check.Equal(blob[8], (byte)0x00, "cctx: width LE b0");
        Check.Equal(blob[9], (byte)0x01, "cctx: width LE b1");
        // height=0x0080 LE → 80 00 00 00
        Check.Equal(blob[12], (byte)0x80, "cctx: height LE b0");
        Check.Equal(blob[13], (byte)0x00, "cctx: height LE b1");
        // format=35 (0x23)
        Check.Equal(blob[16], (byte)35, "cctx: format LE b0");
        // mip flag=1
        Check.Equal(blob[20], (byte)1, "cctx: mip flag");
        // dataLen=1 (u64 LE)
        Check.Equal(blob[24], (byte)1, "cctx: dataLen LE b0");
        Check.Equal(blob[31], (byte)0, "cctx: dataLen LE b7");
        // payload
        Check.Equal(blob[32], (byte)0xAA, "cctx: payload byte");
    }
}
