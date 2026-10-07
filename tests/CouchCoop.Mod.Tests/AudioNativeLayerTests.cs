using System.Security.Cryptography;
using System.Text;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Audio.Native;
using CouchCoop.Mod.Audio.Render;

internal static class AudioNativeLayerTests
{
    public static void Run()
    {
        PckDirectoryIsBoundedAndHashed();
        VersionGateRetriesOnlyHeaderMismatch();
        ColdRequestsShareOneRender();
    }

    private static void PckDirectoryIsBoundedAndHashed()
    {
        byte[] content = [1, 2, 3, 4, 5];
        using var stream = new MemoryStream(new byte[256]);
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
        {
            stream.Position = 0; writer.Write(0x43504447u); writer.Write(3u);
            stream.Position = 20; writer.Write(0u); writer.Write(0UL); writer.Write(112UL);
            stream.Position = 112; writer.Write(1u);
            byte[] path = Encoding.UTF8.GetBytes("res://audio/Master.bank\0");
            writer.Write((uint)path.Length); writer.Write(path); writer.Write(200UL); writer.Write((ulong)content.Length);
            writer.Write(MD5.HashData(content)); writer.Write(0u);
            stream.Position = 200; writer.Write(content);
        }
        var bank = PckBankSource.Parse(stream).Single();
        Assert(bank.Offset == 200 && bank.Length == 5 && bank.Md5.SequenceEqual(MD5.HashData(content)));
        string bankset = BankSet.Compute([bank]);
        Assert(bankset.Length == 32 && bankset.All(Uri.IsHexDigit));
        stream.Position = 20;
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true)) writer.Write(1u);
        AssertThrows<InvalidDataException>(() => PckBankSource.Parse(stream));
    }

    private static void VersionGateRetriesOnlyHeaderMismatch()
    {
        int calls = 0;
        uint version = FmodVersionGate.CreateVersion(
            candidate => { calls++; return candidate == FmodApi.HeaderVersion ? (FmodApi.HeaderMismatch, 0) : (FmodApi.Ok, 12); },
            candidate => candidate == 0x00020307 ? (FmodApi.Ok, candidate) : (FmodApi.HeaderMismatch, 0u),
            _ => throw new Exception("unexpected disable"), out nint studio);
        Assert(version == 0x00020307 && studio == 12 && calls == 2);
        calls = 0;
        AssertThrows<FmodException>(() => FmodVersionGate.CreateVersion(
            _ => { calls++; return (1, 0); }, _ => throw new Exception("unexpected probe"), _ => { }, out _));
        Assert(calls == 1);
    }

    private static void ColdRequestsShareOneRender()
    {
        var backend = new FakeBackend();
        using var renderer = new TakeRenderer(() => backend);
        var request = new TakeRequest("a", "a", "event:/sfx/a", []);
        Task<RenderedTake> first = renderer.RenderAsync(request);
        Task<RenderedTake> second = renderer.RenderAsync(request);
        Assert(ReferenceEquals(first, second));
        backend.Allow.Set();
        RenderedTake take = first.GetAwaiter().GetResult();
        Assert(backend.Calls == 1 && take.Pcm16.SequenceEqual(new byte[] { 1, 2, 3, 4 }));
    }

    private sealed class FakeBackend : IFmodRenderBackend
    {
        internal readonly ManualResetEventSlim Allow = new(false);
        internal int Calls;
        public TakeResult Render(TakeRequest request, IAudioBlockSink sink)
        {
            Allow.Wait();
            Interlocked.Increment(ref Calls);
            sink.OnBlock(new byte[] { 1, 2, 3, 4 }, 0, true);
            return new TakeResult(request.KeyId, 1, 1, 1, 0, 0, false);
        }
        public void Dispose() => Allow.Dispose();
    }

    private static void Assert(bool condition)
    {
        if (!condition) throw new Exception("AudioNativeLayerTests failed");
    }
    private static void AssertThrows<T>(Action action) where T : Exception
    {
        try { action(); } catch (T) { return; }
        throw new Exception($"Expected {typeof(T).Name}");
    }
}
