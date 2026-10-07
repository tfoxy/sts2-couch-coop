namespace CouchCoop.Mod.Audio.Render;

public readonly record struct TakeParameter(string Name, float Value);
public sealed record TakeRequest(string KeyId, string CanonicalKey, string EventPath, IReadOnlyList<TakeParameter> Parameters);
public readonly record struct TakeResult(string KeyId, int Frames, int FirstBlockMicroseconds, double SfxEnergy, double MusicEnergy, double AmbienceEnergy, bool Capped);

// The buffer belongs to the caller only until OnBlock returns.
public interface IAudioBlockSink
{
    void OnBlock(ReadOnlyMemory<byte> interleavedPcm16, int blockIndex, bool last);
}

public interface IFmodRenderBackend : IDisposable
{
    TakeResult Render(TakeRequest request, IAudioBlockSink sink);
}
