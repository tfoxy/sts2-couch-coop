using System.Diagnostics;
using CouchCoop.Mod.Audio.Seat;
using CouchCoop.Mod.Patches;
using CouchCoop.MirrorProtocol.Envelopes;
using HarmonyLib;

internal static class SeatAudioFeedTests
{
    public static async Task RunAsync()
    {
        NoSubscriberAllocatesNothing();
        await SnapshotGatingAndStaleDropAsync();
        await BoundedQueueDropsOldestAsync();
        TargetsResolve();
        Console.WriteLine("seat audio feed: ok");
    }

    private static void NoSubscriberAllocatesNothing()
    {
        SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 1000; i++) SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        Require(GC.GetAllocatedBytesForCurrentThread() == before, "dormant SFX path allocates zero bytes");
    }

    private static async Task SnapshotGatingAndStaleDropAsync()
    {
        using var subscription = SeatAudioFeed.Subscribe(new SeatAudioVolumes(1, 1, 0, 1, 0, 0));
        Require(subscription.Snapshot.Snapshot && subscription.Snapshot.Sfx == 0,
            "snapshot is available before queued events");
        SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        using var timeout = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
        try
        {
            await subscription.ReadAsync(timeout.Token);
            throw new Exception("gated SFX was published");
        }
        catch (OperationCanceledException) { }

        SeatAudioFeed.SetSfx(1);
        var delta = await subscription.ReadAsync(CancellationToken.None);
        Require(delta is SeatAudioVolumes { Sfx: 1, Snapshot: false }, "volume delta precedes new sound");
        SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioSfx,
            "enabled SFX is published");
        SeatAudioFeed.Loop("*", "stop-all");
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioLoop { Action: "stop-all" },
            "stop-all loop event is published without an event key");
        subscription.Enqueue(new SeatAudioSfx("old", "old", 0), Stopwatch.GetTimestamp() - Stopwatch.Frequency);
        SeatAudioFeed.SetMaster(0);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: 0 },
            "stale SFX is dropped before current volume change");
        SeatAudioFeed.Sfx("event:/sfx/test", null, 1);
        using (var gated = new CancellationTokenSource(TimeSpan.FromMilliseconds(30)))
        {
            try { await subscription.ReadAsync(gated.Token); throw new Exception("master-zero SFX was published"); }
            catch (OperationCanceledException) { }
        }
        SeatAudioFeed.SetMaster(1);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: 1 },
            "master re-enable is published");
        SeatAudioFeed.SetGodotSfxDb(float.NegativeInfinity);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { GodotSfxDb: float.NegativeInfinity },
            "muted Godot bus delta is published");
        SeatAudioFeed.TmpSfx("res://debug_audio/test.mp3", 1, 1);
        using (var gated = new CancellationTokenSource(TimeSpan.FromMilliseconds(30)))
        {
            try { await subscription.ReadAsync(gated.Token); throw new Exception("muted TmpSfx was published"); }
            catch (OperationCanceledException) { }
        }
        SeatAudioFeed.SetGodotSfxDb(0);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { GodotSfxDb: 0 },
            "Godot bus re-enable is published");
        SeatAudioFeed.SetMaster(0);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: 0 },
            "FMOD master mute is published");
        SeatAudioFeed.TmpSfx("res://debug_audio/test.mp3", 1, 1);
        using (var gated = new CancellationTokenSource(TimeSpan.FromMilliseconds(30)))
        {
            try { await subscription.ReadAsync(gated.Token); throw new Exception("master-zero TmpSfx was published"); }
            catch (OperationCanceledException) { }
        }
        SeatAudioFeed.SetMaster(1);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: 1 },
            "master re-enable is published for TmpSfx");
        SeatAudioFeed.SetSfx(0);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Sfx: 0 },
            "SFX mute is published");
        SeatAudioFeed.TmpSfx("res://debug_audio/test.mp3", 1, 1);
        using (var gated = new CancellationTokenSource(TimeSpan.FromMilliseconds(30)))
        {
            try { await subscription.ReadAsync(gated.Token); throw new Exception("sfx-zero TmpSfx was published"); }
            catch (OperationCanceledException) { }
        }
        SeatAudioFeed.SetSfx(1);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Sfx: 1 },
            "SFX re-enable is published");
        SeatAudioFeed.TmpSfx("res://debug_audio/test.mp3", 1, 1);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioTmpSfx,
            "TmpSfx follows Godot buses with enabled master and SFX settings");
    }

    private static async Task BoundedQueueDropsOldestAsync()
    {
        using var subscription = SeatAudioFeed.Subscribe(new SeatAudioVolumes(1, 1, 1, 1, 0, 0));
        var stamp = Stopwatch.GetTimestamp();
        for (var i = 0; i < 300; i++)
            subscription.Enqueue(new SeatAudioSfx(i.ToString(), "event:/sfx/test", 0), stamp);
        Require(await subscription.ReadAsync(CancellationToken.None) is SeatAudioSfx { KeyId: "44" },
            "bounded queue retains the newest 256 events");
    }

    internal static void TargetsResolve()
    {
        Require(SeatAudioReportPatch.PlayerNodeName("card_deal.mp3") == "StreamPlayer-card_deal_mp3",
            "TmpSfx reporter matches Godot's normalized player node name");
        foreach (var (type, name, args) in SeatAudioReportPatch.Targets)
            Require(AccessTools.DeclaredMethod(type, name, args) is not null, $"{type.Name}.{name} resolves");
        Require(AccessTools.DeclaredMethod(typeof(MegaCrit.Sts2.Core.Nodes.NMuteInBackgroundHandler),
            nameof(MegaCrit.Sts2.Core.Nodes.NMuteInBackgroundHandler.MethodName.SetMasterVolume),
            [typeof(float)]) is not null, "background mute bracket resolves");
    }

    private static void Require(bool value, string label)
    {
        if (!value) throw new Exception("[SeatAudioFeedTests] " + label);
    }
}
