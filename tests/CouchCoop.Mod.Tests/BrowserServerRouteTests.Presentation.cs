using System.Collections.Concurrent;
using System.Reflection;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.SceneInspection;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunPresentationFencesAsync()
    {
        var runtime = new RecordingSpirectlRuntime();
        var host = new PresentationTestHost();
        var connection = (CouchCoopWebSocketConnection)typeof(CouchCoopWebSocketConnection)
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single().Invoke(
            [runtime.NewEnvelopeFactory(), new ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>(),
                (Func<CouchCoopSceneObserver?>)(() => null), (Action)(() => { }), (Action)(() => { }),
                (Action<bool>)(_ => { }), null, null, true, true, false, false,
                new ConnectionArrivalLog(), null, null, null, null, host]);
        void Set(string name, object value) => typeof(CouchCoopWebSocketConnection)
            .GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(connection, value);
        bool Allows(long? epoch) => (bool)typeof(CouchCoopWebSocketConnection)
            .GetMethod("AllowsPresentationInput", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [epoch])!;
        Set("_rendererProtocol2", true);
        Expect(!Allows(1), "ready presentation still requires the mirror's matching full scene");
        Set("_fullPresentationEpoch", 1L);
        Expect(!Allows(null), "protocol 2 requires an explicit displayed epoch even at the socket's initial epoch");
        Expect(Allows(1) && !Allows(0), "only displayed current epoch is admitted");
        host.OwnsPage = false;
        Expect(!Allows(1), "a replaced page owner cannot inject input from its old connection");
        host.OwnsPage = true;
        host.Ready = false;
        Expect(!Allows(1), "unready layout refuses input");
        host.Ready = true;
        host.Width = 2520;
        Expect(!Allows(1), "wide geometry is never admitted for a mirror");
        host.Stream = true;
        Expect(Allows(1), "stream input uses settled presentation independently of mirror watch");
        Set("_watchRequested", false);
        Expect(Allows(1), "gating mirror bytes does not gate the stream controller");
        Set("_rendererProtocol2", false);
        Set("_legacyPresentationEpoch", 0L);
        Expect(!Allows(null), "legacy input cannot implicitly adopt a changed presentation");
        Set("_legacyPresentationEpoch", 1L);
        Expect(Allows(null), "legacy input may use only its original settled epoch");
        host.Stream = false;
        host.Width = 1920;
        Set("_watchRequested", true);
        host.Epoch = 2;
        Expect(!Allows(null), "legacy sockets cannot adopt a later base-sized presentation");
        Set("_legacyPresentationEpoch", 2L);
        Expect(!Allows(null), "a reconnected legacy viewer still requires a full scene for its new epoch");
        Set("_fullPresentationEpoch", 2L);
        Expect(Allows(null), "a fresh legacy connection can recover after a matching full scene");
        Set("_rendererProtocol2", true);
        host.Epoch = 1;
        Set("_fullPresentationEpoch", 1L);
        await AssertPresentationSendOrderingAsync(connection, host);

        var prior = GameMainThread.Source;
        using var main = new HopCountingMainThread();
        GameMainThread.Source = main;
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        try
        {
            var blocked = Task.Run(() => main.Invoke(() => { entered.Set(); release.Wait(); return true; }));
            Expect(entered.Wait(TimeSpan.FromSeconds(5)), "test owns the game thread before input arrives");
            var calls = runtime.Calls.Count;
            var enqueue = (Task)typeof(CouchCoopWebSocketConnection)
                .GetMethod("QueueInputAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection,
                    [new BrowserInputRequestEnvelope("input", "delayed", "key", Key: "KeyA", PresentationEpoch: 1), CancellationToken.None])!;
            await enqueue;
            host.Epoch = 2;
            release.Set();
            await blocked;
            Task drain;
            // The receipt has started its worker before it returns.
            drain = (Task)typeof(CouchCoopWebSocketConnection).GetField("_inputPumpTask",
                BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(connection)!;
            await drain.WaitAsync(TimeSpan.FromSeconds(5));
            Expect(runtime.Calls.Count == calls, "an accepted input cannot execute after layout changes while queued for the game thread");
        }
        finally { release.Set(); GameMainThread.Source = prior; }

        foreach (var full in new[] { true, false })
        {
            var delta = new RuntimeSceneDelta(full, "test", "test", [], [], []);
            var bytes = SceneDeltaSafeSerializer.Serialize(delta, presentationEpoch: 17).Bytes!;
            using var wire = JsonDocument.Parse(bytes);
            Expect(wire.RootElement.GetProperty("presentationEpoch").GetInt64() == 17,
                "full and incremental scene packets preserve the producer epoch");
        }
        await AssertHostPresentationFencesAsync();
        InputCoalescerTests.Run();
        Console.WriteLine("Presentation fences: 23 assertions plus input coalescer cases passed.");
    }

    private static async Task AssertPresentationSendOrderingAsync(CouchCoopWebSocketConnection connection, PresentationTestHost host)
    {
        var type = typeof(CouchCoopWebSocketConnection);
        void Set(string name, object value) => type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(connection, value);
        bool Allows(long epoch) => (bool)type.GetMethod("AllowsPresentationInput", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [epoch])!;
        var send = type.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(m => m.Name == "SendBytesAsync" && m.GetParameters().Length == 8);
        var gate = (SemaphoreSlim)type.GetField("_sendGate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(connection)!;
        using var socket = new PresentationSocket();
        Set("_socket", socket);
        Set("_sceneStreaming", true);
        Set("_streamAccessGeneration", 1L);
        Set("_streamWatchEpoch", 0L);
        Set("_watchEpoch", 0L);
        Set("_fullPresentationEpoch", -1L);
        Task Send(long epoch, bool full) => (Task)send.Invoke(connection,
            [Encoding.UTF8.GetBytes("scene"), CancellationToken.None, epoch, 0L, null, false, full, null])!;
        await gate.WaitAsync();
        Task oldFull;
        try
        {
            oldFull = Send(1, true);
            Expect(!oldFull.IsCompleted, "serialized old full waits behind the actual socket send gate");
            host.Epoch = 2;
            Set("_streamAccessGeneration", 2L);
        }
        finally { gate.Release(); }
        await oldFull;
        Expect(socket.Sends == 0 && !Allows(2), "queued old full is discarded and cannot open current input");
        await Send(2, false);
        Expect(socket.Sends == 1 && !Allows(2), "current partial cannot unlock input without a matching full");
        socket.AfterSend = () => host.Epoch = 3;
        await Send(2, true);
        Expect(!Allows(3), "full completing across a transition cannot unlock the new epoch");
        socket.AfterSend = null;
        Set("_streamAccessGeneration", 3L);
        await Send(3, true);
        Expect(Allows(3), "matching full opens input only after successful delivery");
        type.GetMethod("SetWatchRequested", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [false]);
        type.GetMethod("SetWatchRequested", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [true]);
        Expect(!Allows(3), "watch off/on invalidates full-scene admission even without a global epoch change");
        Set("_socket", null!);
        Set("_sceneStreaming", false);
        Set("_fullPresentationEpoch", 1L);
        host.Epoch = 1;
    }

    private static async Task AssertHostPresentationFencesAsync()
    {
        var runtime = new RecordingSpirectlRuntime();
        var host = new PresentationTestHost { Epoch = 17, Stream = true };
        var access = new TestHostBrowserAccess();
        access.Set(true);
        var type = typeof(CouchCoopWebSocketConnection);
        var connection = (CouchCoopWebSocketConnection)type.GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single().Invoke(
            [runtime.NewEnvelopeFactory(), new ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>(),
                (Func<CouchCoopSceneObserver?>)(() => null), (Action)(() => { }), (Action)(() => { }),
                (Action<bool>)(_ => { }), null, null, false, true, false, false,
                new ConnectionArrivalLog(), null, access, null, null, host]);
        void Set(string name, object value) => type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(connection, value);
        void Sync() => type.GetMethod("SyncPresentationPage", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, []);
        bool Allows(long epoch) => (bool)type.GetMethod("AllowsPresentationInput", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [epoch])!;
        Task Queue(long epoch, string id) => (Task)type.GetMethod("QueueInputAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection,
            [new BrowserInputRequestEnvelope("input", id, "key", Key: "KeyA", PresentationEpoch: epoch), CancellationToken.None])!;
        Task Drain() => (Task)type.GetField("_inputPumpTask", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(connection)!;
        Set("_rendererProtocol2", true);
        using var socket = new PresentationSocket();
        Set("_socket", socket);
        Sync();
        Expect(host.Claims == 1 && host.Watching, "an allowed host viewer claims and updates its presentation page");
        var calls = runtime.Calls.Count;
        await Queue(16, "stale-host-epoch");
        using (var rejected = JsonDocument.Parse(socket.LastBytes!))
            Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied" && runtime.Calls.Count == calls,
                "a host rejects stale presentation input even with current access permission");
        await Queue(17, "current-host-epoch");
        await Drain().WaitAsync(TimeSpan.FromSeconds(5));
        Expect(runtime.LastActionRequest?.RequestId == "current-host-epoch", "matching host epoch executes with independent access generation");

        var prior = GameMainThread.Source;
        using var main = new HopCountingMainThread();
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        GameMainThread.Source = main;
        try
        {
            var blocked = Task.Run(() => main.Invoke(() => { entered.Set(); release.Wait(); return true; }));
            Expect(entered.Wait(TimeSpan.FromSeconds(5)), "host input test holds the game thread");
            calls = runtime.Calls.Count;
            await Queue(17, "queued-host-epoch");
            host.Epoch = 18;
            release.Set();
            await blocked;
            await Drain().WaitAsync(TimeSpan.FromSeconds(5));
            Expect(runtime.Calls.Count == calls, "host input rechecks presentation after waiting for the game thread");
        }
        finally { release.Set(); GameMainThread.Source = prior; }

        host.Stream = false;
        Set("_sceneStreaming", true);
        Set("_streamAccessGeneration", access.State.Generation);
        Set("_streamWatchEpoch", 0L);
        Set("_streamPresentationEpoch", 18L);
        var keyframe = new RuntimeSceneDelta(true, "test", "test", [], [], []);
        await (Task)type.GetMethod("SendSceneKeyframeAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection,
            [keyframe, access.State.Generation, 0L, 18L])!;
        using (var scene = JsonDocument.Parse(socket.LastBytes!))
            Expect(scene.RootElement.GetProperty("presentationEpoch").GetInt64() == 18,
                "host scenes carry the presentation epoch rather than the access generation");
        Expect(Allows(18), "a matching host full scene opens mirror input");
        var send = type.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(m => m.Name == "SendBytesAsync" && m.GetParameters().Length == 8);
        var gate = (SemaphoreSlim)type.GetField("_sendGate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(connection)!;
        await gate.WaitAsync();
        var sends = socket.Sends;
        var old = (Task)send.Invoke(connection, [Encoding.UTF8.GetBytes("old-host-full"), CancellationToken.None,
            access.State.Generation, 0L, null, false, true, 18L])!;
        host.Epoch = 19;
        Set("_streamPresentationEpoch", 19L);
        gate.Release();
        await old;
        Expect(socket.Sends == sends && !Allows(19), "a host full serialized before resize cannot unlock the next epoch at the send gate");
        host.Stream = true;
        var pending = new BrowserEnvelope("session", "pending-host-view", DirectView: true,
            RenderStream: StreamingSeatDescriptor.BuildRelayed(("127.0.0.1:13346", new string('d', 64), "", "1920x1080", StreamingSeatLaunch.StreamVersion), new string('c', 32)),
            RendererState: new("armed", null, true, 19, true, 1920, 1080));
        await gate.WaitAsync();
        var pendingSend = (Task)send.Invoke(connection, [Array.Empty<byte>(), CancellationToken.None,
            null, null, pending, false, false, null])!;
        access.Set(false);
        gate.Release();
        await pendingSend;
        using (var session = JsonDocument.Parse(socket.LastBytes!))
            Expect(!session.RootElement.TryGetProperty("renderStream", out _) && !session.RootElement.TryGetProperty("rendererState", out _),
                "host access revoked behind the send gate removes previously decorated capture credentials and state");
        await Queue(19, "revoked-host-access");
        using (var rejected = JsonDocument.Parse(socket.LastBytes!))
            Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied" && runtime.Calls.Count == calls,
                "matching presentation cannot bypass revoked host access");
        Sync();
        Expect(host.Releases == 1, "revoked host access releases its presentation page");
        Console.WriteLine("Host presentation fences: 11 assertions passed.");
    }

    private sealed class PresentationSocket : WebSocket
    {
        internal int Sends;
        internal Action? AfterSend;
        internal byte[]? LastBytes;
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;
        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus status, string? description, CancellationToken token) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus status, string? description, CancellationToken token) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken token) => throw new NotSupportedException();
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType type, bool end, CancellationToken token)
        {
            Sends++;
            LastBytes = buffer.ToArray();
            AfterSend?.Invoke();
            return Task.CompletedTask;
        }
    }

    private sealed class PresentationTestHost : IHotRendererSwapHost, IHotPresentationHost, IHotSelfRenderStreamHost
    {
        internal long Epoch = 1;
        internal int Claims, Releases;
        internal bool Watching;
        public bool SupportsSelfRenderStream => true;
        internal bool Ready = true, Stream, OwnsPage = true;
        internal int Width = 1920;
        public (long Epoch, bool Ready, int Width, int Height) PresentationStatus => (Epoch, Ready, Width, 1080);
        public (string State, string? Reason, (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => ("armed", null, ("127.0.0.1:13366", "test", "test", "1920x1080", 16));
        public bool WantsRenderStream(string pageId) => Stream;
        public void RequestRenderer(string pageId, bool stream, double? aspect) { }
        public void ReleaseRenderer(string pageId) { }
        public void ClaimPresentationPage(string pageId, string owner) => Claims++;
        public void UpdatePresentationPage(string pageId, string owner, bool watch, bool? stream, double? aspect) => Watching = watch;
        public void ReleasePresentationPage(string pageId, string owner) => Releases++;
        public bool IsPresentationPageOwner(string pageId, string owner) => OwnsPage;
        public IDisposable SubscribeRendererChanged(Action handler) => new NoopCancellation();
    }
}
