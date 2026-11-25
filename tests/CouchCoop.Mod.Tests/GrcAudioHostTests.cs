using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.Audio.Seat;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;

internal static class GrcAudioHostTests
{
    private static int _checks;
    private static readonly List<(uint Op, ulong Id, string Text, float Value)> Observed = [];
    private sealed class Module : IGrcFmodModule
    {
        internal int Opens, Closes;
        internal readonly TaskCompletionSource<byte[]> Received = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public void SeatOpen(uint seat) { Opens++; GrcStreamAudio.Output(seat, [9, 8, 7]); }
        public void SeatClose(uint seat) => Closes++;
        public void LinkIn(uint seat, ReadOnlySpan<byte> message) => Received.TrySetResult(message.ToArray());
        public void Observe(uint op, ulong id, string text, float value = 0) => Observed.Add((op, id, text, value));
    }
    private static void Check(bool value, string name)
    {
        if (!value) throw new Exception("[GrcAudioHostTests] " + name);
        _checks++;
    }

    internal static async Task RunAsync()
    {
        Mapping();
        Binding();
        await RelayAsync();
        Console.WriteLine($"GSW audio host: {_checks} checks passed");
    }

    internal static void NoDemandDoesNoWork()
    {
        var before = Observed.Count;
        HostAudioHooks.Publish(new(HostAudioOpKind.Global, default, "", "gsw-idle-test", "1", 0));
        Check(Observed.Count == before && ZeroClientEntries.GrcAudioModuleLoad.Hits == 0
            && ZeroClientEntries.GrcAudioObserve.Hits == 0, "no subscribers means no module load or observe");
    }

    private static void Mapping()
    {
        ZeroClientGuard.ClientOpened();
        try
        {
            Observed.Clear();
            var observer = new GrcAudioObserve(new Module());
            void Apply(HostAudioOpKind kind, string name = "", string value = "")
                => observer.Apply(new(kind, HostAudioLane.Music, "music", name, value, 0));
            Apply(HostAudioOpKind.Start, "event:/music/test");
            Apply(HostAudioOpKind.Parameter, "Intensity", "0.5");
            Apply(HostAudioOpKind.Label, "State", "Menu");
            Apply(HostAudioOpKind.Global, "Level", "2");
            Apply(HostAudioOpKind.Global, "GlobalState", "Battle");
            Apply(HostAudioOpKind.LoadBank, "res://test.bank");
            Apply(HostAudioOpKind.UnloadBank, "res://test.bank");
            Apply(HostAudioOpKind.Stop);
            Check(Observed.Select(o => o.Op).SequenceEqual(new uint[] {3,4,7,10,8,11,1,2,5,6}), "maps host ops including label 10/11 and bank evidence");
            Check(Observed[2].Value == .5f && Observed[3].Text == "State\0Menu" && Observed[5].Text == "GlobalState\0Battle", "label payload preserves the separator and numeric gain");
            Check(Observed[0].Id != 0 && Observed[0].Id == Observed[^1].Id, "stable identity until release");
            Check(Observed[^2].Op == 5 && Observed[^2].Value == 0f, "stop allows fadeout before release");
            var count = Observed.Count;
            Apply(HostAudioOpKind.Stop);
            Apply(HostAudioOpKind.Label, "State", "Ended");
            Check(Observed.Count == count, "no release or parameter for an absent instance");
            Apply(HostAudioOpKind.Start, "event:/music/a");
            Apply(HostAudioOpKind.Start, "event:/music/b");
            Check(Observed.TakeLast(4).Select(o => o.Op).SequenceEqual(new uint[]{5,6,3,4}), "replacement stops and releases before creating");
            Check(Observed[^4].Value == 0f, "replacement allows fadeout before release");
            Check(Observed[^1].Id > Observed[0].Id, "observer identities are never reused");
            var snapshot = new HostMusicState();
            snapshot.Apply(new(HostAudioOpKind.Start, HostAudioLane.Music, "menu", "event:/music/menu", "", 0));
            snapshot.Apply(new(HostAudioOpKind.Label, HostAudioLane.Music, "menu", "State", "Menu", 0));
            count = Observed.Count;
            observer.Reset(snapshot.Snapshot());
            Check(Observed[count].Op == 5 && Observed[count].Value == 1f && Observed[count + 1].Op == 6,
                "reset immediately stops and releases stale instances before replay");
            Check(Observed[^1].Op == 10 && Observed[^1].Text == "State\0Menu", "join replays string label state");
            var state = new HostMusicState();
            int calls = 0;
            using (state.Subscribe(_ => calls++, _ => calls++)) state.Apply(new(HostAudioOpKind.Global, default, "", "Level", "1", 0));
            state.Apply(new(HostAudioOpKind.Global, default, "", "Level", "2", 0));
            Check(calls == 2, "observation is dormant after the last subscription");
        }
        finally { ZeroClientGuard.ClientClosed(); }
    }

    private static unsafe void Binding()
    {
        var table = new GrcFmodModule.Table { Abi = 1, Size = (uint)sizeof(GrcFmodModule.Table), Start = &Start,
            State = &State, SeatOpen = &Seat, SeatClose = &Seat, LinkIn = &Input, Observe = &Observe };
        Check(sizeof(GrcFmodModule.Table) == 96 && sizeof(GrcFmodModule.Host) == 40, "Q7 x64 struct sizes");
        var bad = table; bad.Size--;
        try { _ = new GrcFmodModule(bad, new Dictionary<string,string>(), (_,_) => {}); throw new Exception("short ABI accepted"); }
        catch (ArgumentException) { _checks++; }
        var module = new GrcFmodModule(table, new Dictionary<string,string> { ["lanes"] = "1:music:bus:/master/music" }, (_,_) => {});
        module.Observe(10, 45, "State\0Menu");
        Check(Observed[^1] == (10u,45ul,"State\0Menu",0f), "native length covers both strings with embedded NUL");
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int Start(void* self, GrcFmodModule.Host* host, void* banks, byte* error, nuint cap)
    {
        fixed (byte* key = "lanes\0"u8)
            return host->Abi == 1 && host->Size == sizeof(GrcFmodModule.Host) && banks == null && host->Config(host->Self, key) != null ? 1 : 0;
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int State(void* self, byte* reason, nuint cap) => 1;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe void Seat(void* self, uint seat) { }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe void Input(void* self, uint seat, byte* bytes, nuint length) { }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe void Observe(void* self, uint op, ulong id, byte* bytes, nuint length, float value)
        => Observed.Add((op,id,Encoding.UTF8.GetString(new ReadOnlySpan<byte>(bytes,(int)length)),value));

    private static readonly TaskCompletionSource<byte[]> CaptureReceived = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static int _attached, _detached;
    private static TaskCompletionSource Detached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static unsafe GrcAudioCueBinding Capture() => new(new GrcAudioCueBinding.Table
    {
        AbiVersion = 1, Size = (uint)sizeof(GrcAudioCueBinding.Table), Active = &Active, NowUs = &Now,
        Cue = &Cue, Groups = &Groups, KeyId = &KeyId
    }, &Attach, &CaptureInput);
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])] private static int Active() => 0;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])] private static ulong Now() => 0;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int Cue(uint kind, byte* id, byte* key, nuint len, byte* group, nuint gl, ulong t, float pitch, float volume) => 1;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])] private static unsafe int Groups(GrcAudioCueBinding.Gain* g, nuint n, int snapshot) => 1;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])] private static unsafe int KeyId(byte* key, nuint n, byte* id) => 1;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int Attach(GrcAudioCueBinding.Link* link)
    {
        if (link == null) { _detached++; Detached.TrySetResult(); return 1; }
        _attached++;
        byte* bytes = stackalloc byte[] {1,2,3};
        return link->Out(link->Self, bytes, 3);
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int CaptureInput(byte* bytes, nuint length)
    {
        CaptureReceived.TrySetResult(new ReadOnlySpan<byte>(bytes,(int)length).ToArray());
        return 1;
    }

    private static async Task RelayAsync()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var name = SeatBrowserPipe.EndpointFor("gswaudio" + Guid.NewGuid().ToString("N"));
        var token = new string('a',64);
        var prior = GrcAudioCue.SwapForTest(Capture());
        var module = new Module();
        GrcStreamAudio.SetModuleForTest(module);
        try
        {
            Check(module.Opens == 0, "constructing the service creates no module demand");
            await using var pipe = SeatBrowserPipe.Start(name, token, async (stream, secure, remote, ct) =>
            {
                var request = await CouchCoopHttpRequest.TryReadAsync(stream, ct) ?? throw new IOException("missing request");
                Check(GrcAudioLinkConnection.Authorized(request, remote, true, token), "pipe token authorizes loopback internal link");
                Check(!GrcAudioLinkConnection.Authorized(request, IPAddress.Parse("192.0.2.1"), true, token), "LAN client refused");
                Check(!GrcAudioLinkConnection.Authorized(request, remote, false, token), "host process refuses seat-only route");
                Check(!GrcAudioLinkConnection.Authorized(request, remote, true, new string('b',64)), "wrong pipe credential refused");
                await GrcAudioLinkConnection.AcceptSeatAsync(stream, request, ct);
            });
            Task<WebSocket> Connect(CancellationToken ct) => SeatBrowserPipe.ConnectAudioLinkAsync(name,token,ct);
            var first = await GrcStreamAudio.SubscribeAsync("route", Connect, stop.Token);
            Check((await module.Received.Task.WaitAsync(stop.Token)).SequenceEqual(new byte[]{1,2,3}), "seat callback reaches fake host as one binary message");
            Check((await CaptureReceived.Task.WaitAsync(stop.Token)).SequenceEqual(new byte[]{9,8,7}), "host callback reaches fake capture intact");
            var second = await GrcStreamAudio.SubscribeAsync("route", Connect, stop.Token);
            Check(module.Opens == 1 && _attached == 1, "two viewers share one seat endpoint");
            await first.DisposeAsync();
            Check(module.Closes == 0 && _detached == 0, "first viewer leaving retains the link");
            await second.DisposeAsync();
            Check(module.Closes == 1, "last viewer closes module seat");
            // The next pipe connection is accepted only after the old capture detach completes.
            await Detached.Task.WaitAsync(stop.Token);
            Check(_detached == 1, "capture detaches on relay close");
            Detached = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var reconnected = await GrcStreamAudio.SubscribeAsync("route", Connect, stop.Token);
            Check(_attached == 2 && module.Opens == 2, "reconnect attaches a fresh capture endpoint");
            await reconnected.DisposeAsync();
            await Detached.Task.WaitAsync(stop.Token);
            Check(module.Closes == 2 && _detached == 2, "reconnected endpoint also detaches");
        }
        finally { GrcAudioCue.SwapForTest(prior); GrcStreamAudio.SetModuleForTest(null); }
    }
}
