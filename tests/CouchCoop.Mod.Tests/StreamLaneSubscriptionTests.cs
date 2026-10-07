using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.Audio.Render;

namespace CouchCoop.Mod.Tests;

internal static class StreamLaneSubscriptionTests
{
    internal static void Run()
    {
        // An absent subscriber must never open a package, library, thread or audio device.
        using var renderer = new StreamRenderer(null, "nonexistent.pck",
            () => throw new InvalidOperationException("No snapshot without demand"));
        if (renderer.Active || renderer.SubscriberCount != 0)
            throw new Exception("Stream renderer started before lane demand");
        renderer.Apply(new HostAudioOp(HostAudioOpKind.Start, HostAudioLane.Music,
            "music", "event:/music/test", "", 0));
        if (renderer.Active || renderer.SubscriberCount != 0)
            throw new Exception("Host proxy op started a dormant renderer");
        renderer.Dispose();
        try
        {
            renderer.Subscribe(HostAudioLane.Music, _ => { });
            throw new Exception("Disposed stream renderer accepted a subscriber");
        }
        catch (ObjectDisposedException) { }

        using var failed = new ManualResetEventSlim();
        using var broken = new StreamRenderer(null, "nonexistent.pck",
            () => throw new InvalidOperationException("Snapshot must not run"));
        int notices = 0;
        broken.Failed += _ => { Interlocked.Increment(ref notices); failed.Set(); };
        using (broken.Subscribe(HostAudioLane.Music, _ => { }))
        {
            if (!failed.Wait(TimeSpan.FromSeconds(5)))
                throw new Exception("Native renderer failure was not reported");
        }
        if (broken.Available || broken.LastError is null || notices != 1 || broken.Active)
            throw new Exception("Native renderer failure did not latch for the session");
        try
        {
            broken.Subscribe(HostAudioLane.Music, _ => { });
            throw new Exception("Failed stream renderer accepted a retry");
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("Stream renderer unavailable:", StringComparison.Ordinal)) { }
    }
}
