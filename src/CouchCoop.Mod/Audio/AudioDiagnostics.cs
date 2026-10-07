using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Audio;

/// <summary>Opt-in, event-driven counters for the audio live-QA leg.</summary>
public static class AudioDiagnostics
{
    public static readonly bool Enabled = Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO_DIAG") == "1";
    private static long takeHttpRequests;
    private static long takeRenders;

    public static long TakeHttpRequests => Interlocked.Read(ref takeHttpRequests);
    public static long TakeRenders => Interlocked.Read(ref takeRenders);

    public static void TakeHttp()
    {
        Interlocked.Increment(ref takeHttpRequests);
        Emit("take-http");
    }

    public static void TakeRendered(int frames, int firstBlockUs)
    {
        Interlocked.Increment(ref takeRenders);
        Emit($"take-render frames={frames} firstBlockUs={firstBlockUs}");
    }

    public static void Emit(string detail)
    {
        if (Enabled) CouchCoopLog.Info("[audio-diag] " + detail);
    }
}
