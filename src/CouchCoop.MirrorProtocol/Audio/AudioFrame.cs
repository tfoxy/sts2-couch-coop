using System.Buffers.Binary;

namespace CouchCoop.MirrorProtocol.Audio;

public enum AudioFrameKind : byte { Take = 1, Lane = 2 }
public enum AudioLane : byte { Take = 0, Music = 1, Ambience = 2, Loops = 3 }

[Flags]
public enum AudioFrameFlags : byte { None = 0, First = 1, Last = 2, Silent = 4 }

/// <summary>LE 36-byte header followed by 48 kHz interleaved stereo signed PCM16.</summary>
public readonly record struct AudioFrame(
    AudioFrameKind Kind, AudioLane Lane, uint StreamId, uint BlockIndex, ushort Frames,
    AudioFrameFlags Flags, ulong DueUs, ulong SentUs)
{
    public const int HeaderSize = 36;
    public const int SampleRate = 48_000;
    public const int Channels = 2;
    public const int LaneBlockFrames = 512;
    public const byte Version = 1;

    public byte[] Encode(ReadOnlySpan<byte> pcm)
    {
        Validate(pcm.Length);
        var result = new byte[HeaderSize + pcm.Length];
        var span = result.AsSpan();
        "CCAU"u8.CopyTo(span);
        span[4] = Version;
        span[5] = (byte)Kind;
        span[6] = (byte)Flags;
        span[7] = (byte)Lane;
        BinaryPrimitives.WriteUInt32LittleEndian(span[8..], StreamId);
        BinaryPrimitives.WriteUInt32LittleEndian(span[12..], BlockIndex);
        BinaryPrimitives.WriteUInt16LittleEndian(span[16..], Frames);
        BinaryPrimitives.WriteUInt64LittleEndian(span[20..], DueUs);
        BinaryPrimitives.WriteUInt64LittleEndian(span[28..], SentUs);
        pcm.CopyTo(span[HeaderSize..]);
        return result;
    }

    public static bool TryDecode(ReadOnlySpan<byte> bytes, out AudioFrame frame)
    {
        frame = default;
        if (bytes.Length < HeaderSize || !bytes[..4].SequenceEqual("CCAU"u8) || bytes[4] != Version ||
            BinaryPrimitives.ReadUInt16LittleEndian(bytes[18..]) != 0) return false;
        frame = new AudioFrame((AudioFrameKind)bytes[5], (AudioLane)bytes[7],
            BinaryPrimitives.ReadUInt32LittleEndian(bytes[8..]), BinaryPrimitives.ReadUInt32LittleEndian(bytes[12..]),
            BinaryPrimitives.ReadUInt16LittleEndian(bytes[16..]), (AudioFrameFlags)bytes[6],
            BinaryPrimitives.ReadUInt64LittleEndian(bytes[20..]), BinaryPrimitives.ReadUInt64LittleEndian(bytes[28..]));
        try { frame.Validate(bytes.Length - HeaderSize); return true; }
        catch (ArgumentException) { frame = default; return false; }
    }

    private void Validate(int pcmBytes)
    {
        if (Kind is not (AudioFrameKind.Take or AudioFrameKind.Lane) ||
            (Kind == AudioFrameKind.Take && Lane != AudioLane.Take) ||
            (Kind == AudioFrameKind.Lane && Lane is not (AudioLane.Music or AudioLane.Ambience or AudioLane.Loops)) ||
            ((byte)Flags & ~7) != 0 || Frames == 0 ||
            (Kind == AudioFrameKind.Lane && Frames != LaneBlockFrames) || pcmBytes != Frames * Channels * 2)
            throw new ArgumentException("Invalid audio frame");
    }
}
