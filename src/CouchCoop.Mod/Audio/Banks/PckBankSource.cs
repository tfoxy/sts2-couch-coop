using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Audio.Native;

namespace CouchCoop.Mod.Audio.Banks;

internal sealed record PckBankEntry(string Path, long Offset, uint Length, byte[] Md5);

internal sealed class PckBankSource : IDisposable
{
    private const uint Magic = 0x43504447; // GDPC
    private readonly FileStream stream;
    private readonly List<BankContext> contexts = [];
    internal IReadOnlyList<PckBankEntry> Banks { get; }
    internal string BankSetId { get; }

    internal PckBankSource(string path)
    {
        stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            Banks = Parse(stream);
            BankSetId = BankSet.Compute(Banks);
        }
        catch { stream.Dispose(); throw; }
    }

    internal static IReadOnlyList<PckBankEntry> Parse(Stream source)
    {
        if (!source.CanSeek || source.Length < 0x70) throw new InvalidDataException("Invalid game package");
        using var reader = new BinaryReader(source, System.Text.Encoding.UTF8, leaveOpen: true);
        source.Position = 0;
        if (reader.ReadUInt32() != Magic) throw new InvalidDataException("Not a Godot package");
        uint format = reader.ReadUInt32();
        if (format is < 2 or > 3) throw new InvalidDataException("Unsupported package format");
        source.Position = 20;
        uint flags = reader.ReadUInt32();
        ulong fileBase = reader.ReadUInt64();
        ulong directory = reader.ReadUInt64();
        if ((flags & 1) != 0 || (flags & ~3u) != 0 || directory > (ulong)source.Length - 4)
            throw new InvalidDataException("Encrypted or invalid package directory");
        source.Position = (long)directory;
        uint count = reader.ReadUInt32();
        if (count > 1_000_000) throw new InvalidDataException("Package directory too large");
        var banks = new List<PckBankEntry>();
        for (uint i = 0; i < count; i++)
        {
            uint pathLength = reader.ReadUInt32();
            if (pathLength is 0 or > 4096 || pathLength > source.Length - source.Position)
                throw new InvalidDataException("Invalid package path length");
            byte[] pathBytes = reader.ReadBytes((int)pathLength);
            string path = System.Text.Encoding.UTF8.GetString(pathBytes).TrimEnd('\0');
            ulong offset = reader.ReadUInt64();
            ulong size = reader.ReadUInt64();
            byte[] md5 = reader.ReadBytes(16);
            uint entryFlags = reader.ReadUInt32();
            if (!path.EndsWith(".bank", StringComparison.OrdinalIgnoreCase)) continue;
            if (entryFlags != 0 || size > uint.MaxValue || fileBase > long.MaxValue ||
                offset > long.MaxValue || fileBase + offset > (ulong)source.Length ||
                size > (ulong)source.Length - fileBase - offset)
                throw new InvalidDataException("Encrypted, compressed, or invalid bank entry");
            banks.Add(new PckBankEntry(path, checked((long)(fileBase + offset)), (uint)size, md5));
        }
        if (banks.Count == 0) throw new InvalidDataException("Game package has no FMOD banks");
        return banks.OrderBy(BankSet.SortRank).ThenBy(e => e.Path, StringComparer.Ordinal).ToArray();
    }

    internal void VerifyDigests()
    {
        byte[] buffer = new byte[64 * 1024];
        foreach (PckBankEntry entry in Banks)
        {
            using var md5 = MD5.Create();
            long offset = entry.Offset;
            uint left = entry.Length;
            while (left > 0)
            {
                int wanted = (int)Math.Min(left, (uint)buffer.Length);
                int read = RandomAccess.Read(stream.SafeFileHandle, buffer.AsSpan(0, wanted), offset);
                if (read != wanted) throw new InvalidDataException("Truncated FMOD bank");
                md5.TransformBlock(buffer, 0, read, buffer, 0);
                offset += read;
                left -= (uint)read;
            }
            md5.TransformFinalBlock([], 0, 0);
            if (!CryptographicOperations.FixedTimeEquals(md5.Hash!, entry.Md5))
                throw new InvalidDataException("FMOD bank digest mismatch");
        }
    }

    internal unsafe void Load(nint studio)
    {
        foreach (PckBankEntry entry in Banks)
        {
            var context = new BankContext(stream.SafeFileHandle, entry);
            context.Bind();
            contexts.Add(context);
            FmodApi.BankInfo info = new()
            {
                Size = Marshal.SizeOf<FmodApi.BankInfo>(), Userdata = GCHandle.ToIntPtr(context.Handle),
                Open = &Open, Close = &Close, Read = &Read, Seek = &Seek
            };
            FmodApi.Check(FmodApi.FMOD_Studio_System_LoadBankCustom(studio, in info, 0, out nint bank), "load bank");
            context.Bank = bank;
        }
        foreach (BankContext context in contexts)
            FmodApi.Check(FmodApi.FMOD_Studio_Bank_LoadSampleData(context.Bank), "load sample data");
        FmodApi.Check(FmodApi.FMOD_Studio_System_FlushSampleLoading(studio), "flush samples");
    }

    private sealed class BankContext(SafeFileHandle handle, PckBankEntry entry)
    {
        internal readonly SafeFileHandle File = handle;
        internal readonly PckBankEntry Entry = entry;
        internal readonly long[] Cursors = new long[16];
        internal readonly bool[] OpenSlots = new bool[16];
        internal GCHandle Handle = GCHandle.Alloc(null);
        internal nint Bank;
        internal void Bind() => Handle.Target = this;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static unsafe int Open(byte* name, uint* size, nint* handle, nint userdata)
    {
        try
        {
            var context = (BankContext)GCHandle.FromIntPtr(userdata).Target!;
            for (int i = 0; i < context.OpenSlots.Length; i++)
                if (!context.OpenSlots[i])
                {
                    context.OpenSlots[i] = true; context.Cursors[i] = 0;
                    *size = context.Entry.Length; *handle = i + 1;
                    return FmodApi.Ok;
                }
        }
        catch { }
        return 1;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int Close(nint handle, nint userdata)
    {
        try
        {
            var context = (BankContext)GCHandle.FromIntPtr(userdata).Target!;
            int i = checked((int)handle - 1);
            if (!context.OpenSlots[i]) return 1;
            context.OpenSlots[i] = false;
            return FmodApi.Ok;
        }
        catch { return 1; }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static unsafe int Read(nint handle, void* buffer, uint count, uint* bytesRead, nint userdata)
    {
        try
        {
            var context = (BankContext)GCHandle.FromIntPtr(userdata).Target!;
            int i = checked((int)handle - 1);
            if (!context.OpenSlots[i] || count > int.MaxValue) return 1;
            long cursor = context.Cursors[i];
            uint wanted = (uint)Math.Min(count, context.Entry.Length - (uint)cursor);
            int read = RandomAccess.Read(context.File, new Span<byte>(buffer, (int)wanted), context.Entry.Offset + cursor);
            *bytesRead = (uint)read;
            context.Cursors[i] += read;
            return read == count ? FmodApi.Ok : 16; // FMOD_ERR_FILE_EOF
        }
        catch { return 1; }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int Seek(nint handle, uint position, nint userdata)
    {
        try
        {
            var context = (BankContext)GCHandle.FromIntPtr(userdata).Target!;
            int i = checked((int)handle - 1);
            if (!context.OpenSlots[i] || position > context.Entry.Length) return 1;
            context.Cursors[i] = position;
            return FmodApi.Ok;
        }
        catch { return 1; }
    }

    public void Dispose()
    {
        foreach (BankContext context in contexts) if (context.Handle.IsAllocated) context.Handle.Free();
        stream.Dispose();
    }
}
