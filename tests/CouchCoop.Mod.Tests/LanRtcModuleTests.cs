using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Server.LanRtc;

internal static unsafe class LanRtcModuleTests
{
    public static Task RunAsync()
    {
        using var fixture = new Fixture();
        MissingLibrary(fixture);
        MissingExport(fixture);
        Layout();
        Lifetime(fixture);
        SerializedDestroy(fixture);
        FailedCreate(fixture);
        InboundQueues(fixture);
        var path = Environment.GetEnvironmentVariable(LanRtcModule.LibraryEnvironmentVariable);
        if (string.IsNullOrEmpty(path)) Console.WriteLine("LanRtcModuleTests: native smoke skipped (COUCHCOOP_LAN_RTC_LIB unset)");
        else
        {
            using var module = LanRtcModule.TryCreate(fixture.Identity, fixture.Candidate, fixture.Socket,
                Console.WriteLine, libraryPath: path);
            Expect(module is not null, "real library creates with the persistent identity");
            module!.ReceiveDatagram(new(IPAddress.Parse("192.0.2.2"), 45000), fixture.Candidate.Address, [0, 0, 0]);
            Expect(module.Buffered(1, 1) == 0 && module.Send(1, 1, true, [1]) == -2, "real library tolerates unknown channels");
        }
        Console.WriteLine($"LanRtcModuleTests: {(!string.IsNullOrEmpty(path) ? 8 : 7)} cases passed");
        return Task.CompletedTask;
    }

    private static void MissingLibrary(Fixture f)
    {
        var logs = new List<string>();
        Expect(LanRtcModule.TryCreate(f.Identity, f.Candidate, f.Socket, logs.Add,
            libraryPath: Path.Combine(f.Root, "missing.so")) is null && logs.Count == 1, "missing library is off with one log");
    }

    private static void MissingExport(Fixture f)
    {
        var logs = new List<string>();
        var systemLibrary = OperatingSystem.IsWindows() ? "kernel32.dll" : OperatingSystem.IsMacOS()
            ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
        Expect(NativeLibrary.TryLoad(systemLibrary, out var handle), "system library available for missing-export test");
        NativeLibrary.Free(handle);
        Expect(LanRtcModule.TryCreate(f.Identity, f.Candidate, f.Socket, logs.Add,
            libraryPath: systemLibrary) is null && logs.Count == 1, "missing RTC export is off with one log");
    }

    private static void Layout()
    {
        Expect(sizeof(LanRtcAddress) == 20 && Marshal.OffsetOf<LanRtcConfig>(nameof(LanRtcConfig.SendBudget)).ToInt32() ==
            (IntPtr.Size == 8 ? 80 : 56), "config includes the trailing budget with native alignment");
        var endpoint = new IPEndPoint(IPAddress.Parse("192.0.2.33"), 43210);
        Expect(LanRtcAddress.From(endpoint).ToEndpoint().Equals(endpoint), "IPv4 octets and host-order port round trip");
        endpoint = new(IPAddress.Parse("2001:db8::1234"), 12345);
        Expect(LanRtcAddress.From(endpoint).ToEndpoint().Equals(endpoint), "IPv6 round trip");
    }

    private static void Lifetime(Fixture f)
    {
        using var fake = new Fake();
        var logs = 0;
        var module = LanRtcModule.Create(fake.Api, f.Identity, f.Candidate, f.Socket,
            _ => { logs++; throw new InvalidOperationException("logging can fail"); }, 123456);
        Expect(fake.Config.SendBudget == 123456 && fake.Config.MaxPeers == 16 && fake.Config.ReceiveMaxMessage == 262144 &&
            fake.Config.LowThreshold == 0, "native configuration");
        module.ReceiveDatagram(new(IPAddress.Parse("192.0.2.2"), 45000), f.Candidate.Address, [20, 1, 2]);
        Expect(fake.Inputs == 1 && f.Candidate.Equals(fake.Destination), "socket destination and browser port reach input");
        var callbacks = fake.Callbacks;
        using var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        udp.Client.ReceiveTimeout = 3000;
        var udpAddress = LanRtcAddress.From((IPEndPoint)udp.Client.LocalEndPoint!);
        var address = LanRtcAddress.From(new(IPAddress.Parse("192.0.2.2"), 45000));
        callbacks.Peer(callbacks.User, 4, 1, &address);
        byte[] label = Encoding.UTF8.GetBytes("couch-tunnel/1"), payload = [1, 2, 3];
        fixed (byte* l = label, p = payload)
        {
            callbacks.Open(callbacks.User, 4, 5, l, (nuint)label.Length);
            callbacks.Message(callbacks.User, 4, 5, 1, p, 3);
            callbacks.Log(callbacks.User, 2, p, 3);
            callbacks.Transmit(callbacks.User, &udpAddress, p, 3);
            // An invalid address is contained in the trampoline, even when its logger also throws.
            var invalid = new LanRtcAddress();
            callbacks.Transmit(callbacks.User, &invalid, p, 3);
        }
        IPEndPoint source = new(IPAddress.Any, 0);
        Expect(udp.Receive(ref source).SequenceEqual(payload) && source.Port == f.Socket.Port, "transmit uses the shared UDP socket");
        payload[0] = 99;
        Expect(module.Events.TryRead(out var peer) && peer!.Address!.Equals(address.ToEndpoint().Address), "authenticated peer IP retained");
        Expect(module.Events.TryRead(out var opened) && opened.Label == "couch-tunnel/1", "label copied");
        Expect(module.GetSignals(4, 5)!.ReadAsync(CancellationToken.None).Result.Data![0] == 1 && logs >= 2, "message copied and callback exceptions contained");
        Expect(module.Send(4, 5, true, [9]) == 1 && module.Buffered(4, 5) == 987, "send status and buffering preserved");
        var signals = module.GetSignals(4, 5)!;
        var drained = signals.Drained;
        callbacks.Low(callbacks.User, 4, 5);
        Expect(drained.IsCompleted && !signals.Drained.IsCompleted, "drain signal bypasses the event queue without losing generations");
        fixed (byte* l = label)
        {
            callbacks.Open(callbacks.User, 4, 6, l, (nuint)label.Length);
            callbacks.Open(callbacks.User, 7, 5, l, (nuint)label.Length);
        }
        drained = signals.Drained;
        var otherPeerDrained = module.GetSignals(7, 5)!.Drained;
        callbacks.Low(callbacks.User, 4, 6);
        Expect(drained.IsCompleted && !otherPeerDrained.IsCompleted,
            "association credit wakes a sibling blocked before its first successful send, without waking another peer");
        callbacks.Closed(callbacks.User, 4, 5);
        Expect(signals.Closed.IsCompleted && module.GetSignals(4, 5) is null, "closed signal bypasses the event queue and retires channel state");
        module.CloseChannel(4, 5); module.ClosePeer(4);
        Expect(fake.ClosedChannels == 1 && fake.ClosedPeers == 1, "close entries forwarded");
        module.Dispose(); module.Dispose();
        module.ReceiveDatagram(new(IPAddress.Parse("192.0.2.2"), 45000), f.Candidate.Address, [1]);
        Expect(fake.Destroys == 1 && fake.Inputs == 1 && module.Send(4, 5, true, [1]) == -2,
            "destroy once and no entries after destruction");
    }

    private static void InboundQueues(Fixture f)
    {
        using var fake = new Fake();
        using var module = LanRtcModule.Create(fake.Api, f.Identity, f.Candidate, f.Socket, _ => { });
        var callbacks = fake.Callbacks;
        var label = Encoding.UTF8.GetBytes("couch-tunnel/1");
        var data = new byte[262144];
        fixed (byte* l = label, p = data)
        {
            callbacks.Open(callbacks.User, 1, 1, l, (nuint)label.Length);
            for (var index = 0; index < 32; index++) callbacks.Message(callbacks.User, 1, 1, 1, p, (nuint)data.Length);
            callbacks.Open(callbacks.User, 1, 2, l, (nuint)label.Length);
            callbacks.Message(callbacks.User, 1, 2, 1, p, 1);
        }
        Expect(module.GetSignals(1, 1)!.Overflow.IsCompleted, "callback receive queue has an explicit byte cap");
        Expect(!module.GetSignals(1, 2)!.Overflow.IsCompleted && module.GetSignals(1, 2)!.ReadAsync(CancellationToken.None).IsCompletedSuccessfully,
            "another channel continues receiving after overflow");
        var events = new List<LanRtcEvent>();
        while (module.Events.TryRead(out var value)) events.Add(value);
        Expect(events.Count == 2 && events.All(e => e.Kind == LanRtcEventKind.Open),
            "message payloads never accumulate in the shared control-event queue");
        var fetch = new LanRtcChannelSignals();
        fetch.Message(new(LanRtcEventKind.Message, 1, 1, Data: []));
        fetch.ConfigureFetch();
        for (var offset = 0; offset < LanRtcTunnel.FetchBodyLimit; offset += 16384)
        {
            var frame = new byte[16385]; frame[0] = (byte)(offset == 0 ? 2 : 0);
            fetch.Message(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: frame));
        }
        fetch.Message(new(LanRtcEventKind.Message, 1, 1, Binary: true, Data: [0x80, 1]));
        Expect(fetch.Overflow.IsCompleted && !fetch.RequestEnded.IsCompleted,
            "an oversized FIN cannot release a successful HTTP status before the 413 cancellation");
    }

    private static void SerializedDestroy(Fixture f)
    {
        using var fake = new Fake { BlockInput = true };
        var module = LanRtcModule.Create(fake.Api, f.Identity, f.Candidate, f.Socket, _ => { });
        var input = Task.Run(() => module.ReceiveDatagram(new(IPAddress.Parse("192.0.2.2"), 45000), f.Candidate.Address, [1]));
        Expect(fake.Entered.Wait(TimeSpan.FromSeconds(3)), "input entered");
        var disposing = Task.Run(module.Dispose);
        Expect(fake.Destroys == 0, "destroy cannot overlap input");
        fake.Release.Set();
        Expect(Task.WaitAll([input, disposing], TimeSpan.FromSeconds(3)) && fake.Destroys == 1 && !fake.Overlap,
            "destroy serialized with entry calls");
    }

    private static void FailedCreate(Fixture f)
    {
        using var fake = new Fake { FailCreate = true };
        try { using var module = LanRtcModule.Create(fake.Api, f.Identity, f.Candidate, f.Socket, _ => { }); }
        catch (InvalidOperationException) { Expect(fake.Destroys == 0, "failed create owns no handle"); return; }
        throw new Exception("Expected failed create");
    }

    private static void Expect(bool condition, string reason)
    { if (!condition) throw new Exception("LanRtcModuleTests: " + reason); }

    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "couch-rtc-module-" + Guid.NewGuid().ToString("N"));
        public LanRtcIdentity Identity { get; }
        public BrowserPortUdpSocket Socket { get; } = new(0, _ => null, _ => { });
        public IPEndPoint Candidate => new(IPAddress.Parse("192.0.2.1"), Socket.Port);
        public Fixture() { Identity = LanRtcIdentity.LoadOrCreate(Root, _ => { }); }
        public void Dispose() { Identity.Dispose(); Socket.DisposeAsync().AsTask().GetAwaiter().GetResult(); Directory.Delete(Root, true); }
    }

    internal sealed class Fake : IDisposable
    {
        private static Fake? _creating;
        private readonly GCHandle _self;
        public LanRtcCallbacks Callbacks;
        public LanRtcConfig Config;
        public int Inputs, Destroys, ClosedChannels, ClosedPeers;
        public bool BlockInput, FailCreate, InInput, Overlap;
        public Action? OnDestroy;
        public Func<uint, uint, int, int>? OnSend;
        public Action<uint, uint>? OnCloseChannel;
        public IPEndPoint? Destination;
        public ManualResetEventSlim Entered = new(), Release = new();
        public Fake() { _self = GCHandle.Alloc(this); _creating = this; }
        public LanRtcApi Api => new() { Abi = 1, Create = &Create, Input = &Input, Send = &Send,
            Buffered = &Buffered, CloseChannel = &CloseChannel, ClosePeer = &ClosePeer, Destroy = &Destroy };
        private static Fake Get(nint handle) => (Fake)GCHandle.FromIntPtr(handle).Target!;
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static int Create(LanRtcConfig* config, LanRtcCallbacks* callbacks, nint* handle, byte* error, nuint capacity)
        {
            var f = _creating!; f.Config = *config; f.Callbacks = *callbacks;
            *handle = f.FailCreate ? 0 : GCHandle.ToIntPtr(f._self); error[0] = 0;
            return f.FailCreate ? -1 : 0;
        }
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static int Input(nint handle, LanRtcAddress* source, LanRtcAddress* destination, byte* data, nuint length)
        {
            var f = Get(handle); f.Inputs++; f.InInput = true; f.Destination = destination->ToEndpoint(); f.Entered.Set();
            if (f.BlockInput) f.Release.Wait(TimeSpan.FromSeconds(3));
            f.InInput = false; return 0;
        }
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static int Send(nint handle, uint peer, uint channel, int binary, byte* data, nuint length)
            => Get(handle).OnSend?.Invoke(peer, channel, checked((int)length)) ?? 1;
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static ulong Buffered(nint handle, uint peer, uint channel) => 987;
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static void CloseChannel(nint handle, uint peer, uint channel)
        { var f = Get(handle); f.ClosedChannels++; f.OnCloseChannel?.Invoke(peer, channel); }
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static void ClosePeer(nint handle, uint peer) => Get(handle).ClosedPeers++;
        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static void Destroy(nint handle) { var f = Get(handle); f.Overlap = f.InInput; f.Destroys++; f.OnDestroy?.Invoke(); }
        public void Dispose() { _self.Free(); Entered.Dispose(); Release.Dispose(); }
    }
}
