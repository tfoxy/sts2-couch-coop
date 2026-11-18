using System.Buffers.Binary;
using System.Xml;
using System.Xml.Linq;

namespace CouchCoop.Mod.Session;

/// <summary>Reads the executing architecture's UUID and signing policy without loading the image.</summary>
internal static class MachOImage
{
    internal readonly record struct Identity(string Uuid, bool Hardened, bool DisableLibraryValidation,
        string? SignatureDetail = null)
    {
        internal string Id8 => Uuid[..8];
    }

    internal static Identity? Read(Stream stream, string arch)
    {
        try
        {
            uint cpu = arch switch { "arm64" => 0x0100000c, "x86_64" => 0x01000007, _ => 0 };
            if (cpu == 0) return null;
            using var reader = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
            void At(long offset, long size)
            {
                if (offset < 0 || size < 0 || offset > stream.Length - size) throw new InvalidDataException();
                stream.Position = offset;
            }
            uint Be32() => BinaryPrimitives.ReverseEndianness(reader.ReadUInt32());
            ulong Be64() => BinaryPrimitives.ReverseEndianness(reader.ReadUInt64());
            At(0, 4);
            var magic = Be32();
            long start = 0, length = stream.Length;
            if (magic is 0xcafebabe or 0xcafebabf)
            {
                At(4, 4);
                var count = Be32();
                var entrySize = magic == 0xcafebabf ? 32 : 20;
                At(8, count * (long)entrySize);
                var found = false;
                for (var i = 0L; i < count; i++)
                {
                    At(8 + i * entrySize, entrySize);
                    var sliceCpu = Be32();
                    _ = Be32();
                    var offset = checked((long)(entrySize == 32 ? Be64() : Be32()));
                    var size = checked((long)(entrySize == 32 ? Be64() : Be32()));
                    if (offset < 8 + count * (long)entrySize || size == 0) return null;
                    At(offset, size);
                    if (sliceCpu != cpu) continue;
                    if (found) return null;
                    found = true;
                    start = offset; length = size;
                }
                if (!found) return null;
            }
            void InSlice(long offset, long size)
            {
                if (offset < 0 || size < 0 || offset > length - size) throw new InvalidDataException();
                At(start + offset, size);
            }
            InSlice(0, 32);
            if (reader.ReadUInt32() != 0xfeedfacf || reader.ReadUInt32() != cpu) return null;
            stream.Position += 8;
            var commands = reader.ReadUInt32();
            var commandBytes = reader.ReadUInt32();
            InSlice(32, commandBytes);
            long position = 32, end = 32L + commandBytes;
            string? uuid = null;
            (uint Offset, uint Size)? signature = null;
            for (var i = 0L; i < commands; i++)
            {
                if (end - position < 8) return null;
                InSlice(position, 8);
                var command = reader.ReadUInt32();
                var size = reader.ReadUInt32();
                if (size < 8 || size % 8 != 0 || size > end - position) return null;
                if (command == 0x1b) // LC_UUID
                {
                    if (size != 24 || uuid is not null) return null;
                    uuid = Convert.ToHexString(reader.ReadBytes(16)).ToLowerInvariant();
                }
                else if (command == 0x1d) // LC_CODE_SIGNATURE
                {
                    if (size != 16 || signature is not null) return null;
                    signature = (reader.ReadUInt32(), reader.ReadUInt32());
                }
                position += size;
            }
            if (position != end || uuid is null) return null;
            if (signature is not { } sig) return new(uuid, false, false, "no code signature");
            try
            {
                InSlice(sig.Offset, sig.Size);
                // Signing metadata is small; refuse unbounded allocations from malformed files.
                if (sig.Size > 16 * 1024 * 1024) throw new InvalidDataException();
                return ReadSignature(reader.ReadBytes(checked((int)sig.Size)), uuid);
            }
            catch (Exception exception)
            {
                return new(uuid, false, false, $"unreadable code signature ({exception.GetType().Name})");
            }
        }
        catch (Exception) { return null; }
    }

    private static Identity ReadSignature(byte[] data, string uuid)
    {
        uint Be(long offset)
        {
            if (offset < 0 || offset > data.Length - 4) throw new InvalidDataException();
            return BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan((int)offset, 4));
        }
        if (Be(0) != 0xfade0cc0) throw new InvalidDataException(); // EmbeddedSignature SuperBlob
        var length = Be(4);
        var count = Be(8);
        if (length > data.Length || length < 12 || count > (length - 12) / 8) throw new InvalidDataException();
        uint? flags = null;
        bool? disabled = null;
        for (var i = 0L; i < count; i++)
        {
            var offset = Be(16 + i * 8);
            if (offset < 12L + count * 8L || offset > length - 8) throw new InvalidDataException();
            var magic = Be(offset);
            var blobLength = Be(offset + 4L);
            if (blobLength < 8 || blobLength > length - offset) throw new InvalidDataException();
            if (magic == 0xfade0c02) // CodeDirectory
            {
                if (blobLength < 16) throw new InvalidDataException();
                flags = (flags ?? 0) | Be(offset + 12L);
            }
            else if (magic == 0xfade7171) // XML entitlements
            {
                if (disabled is not null) throw new InvalidDataException();
                using var xml = XmlReader.Create(new MemoryStream(data, (int)offset + 8, (int)blobLength - 8),
                    new XmlReaderSettings { DtdProcessing = DtdProcessing.Ignore, XmlResolver = null });
                var plist = XDocument.Load(xml);
                var entries = plist.Root?.Name == "plist" ? plist.Root.Element("dict")?.Elements().ToArray() : null;
                if (entries is null || entries.Length % 2 != 0) throw new InvalidDataException();
                disabled = false;
                var seen = false;
                for (var j = 0; j < entries.Length; j += 2)
                {
                    if (entries[j].Name != "key") throw new InvalidDataException();
                    if (entries[j].Value != "com.apple.security.cs.disable-library-validation") continue;
                    if (seen) throw new InvalidDataException();
                    seen = true;
                    disabled = entries[j + 1].Name == "true";
                }
            }
        }
        if (flags is null) throw new InvalidDataException();
        return new(uuid, (flags.Value & 0x10000) != 0, disabled == true);
    }
}
