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
        InputCoalescerTests.Run();
        Console.WriteLine("Presentation fences: 23 assertions plus input coalescer cases passed.");
    }

    private static async Task AssertPresentationSendOrderingAsync(CouchCoopWebSocketConnection connection, PresentationTestHost host)
    {
        var type = typeof(CouchCoopWebSocketConnection);
        void Set(string name, object value) => type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(connection, value);
        bool Allows(long epoch) => (bool)type.GetMethod("AllowsPresentationInput", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(connection, [epoch])!;
        var send = type.GetMethods(BindingFlags.Instance | BindingFlags.NonPublic)
            .Single(m => m.Name == "SendBytesAsync" && m.GetParameters().Length == 7);
        var gate = (SemaphoreSlim)type.GetField("_sendGate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(connection)!;
        using var socket = new PresentationSocket();
        Set("_socket", socket);
        Set("_sceneStreaming", true);
        Set("_streamAccessGeneration", 1L);
        Set("_streamWatchEpoch", 0L);
        Set("_watchEpoch", 0L);
        Set("_fullPresentationEpoch", -1L);
        Task Send(long epoch, bool full) => (Task)send.Invoke(connection,
            [Encoding.UTF8.GetBytes("scene"), CancellationToken.None, epoch, 0L, null, false, full])!;
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

    private sealed class PresentationSocket : WebSocket
    {
        internal int Sends;
        internal Action? AfterSend;
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
            AfterSend?.Invoke();
            return Task.CompletedTask;
        }
    }

    private sealed class PresentationTestHost : IHotRendererSwapHost, IHotPresentationHost
    {
        internal long Epoch = 1;
        internal bool Ready = true, Stream, OwnsPage = true;
        internal int Width = 1920;
        public (long Epoch, bool Ready, int Width, int Height) PresentationStatus => (Epoch, Ready, Width, 1080);
        public (string State, string? Reason, (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => ("armed", null, ("127.0.0.1:13366", "test", "test", "1920x1080", 13));
        public bool WantsRenderStream(string pageId) => Stream;
        public void RequestRenderer(string pageId, bool stream, double? aspect) { }
        public void ReleaseRenderer(string pageId) { }
        public void ClaimPresentationPage(string pageId, string owner) { }
        public void UpdatePresentationPage(string pageId, string owner, bool watch, bool? stream, double? aspect) { }
        public void ReleasePresentationPage(string pageId, string owner) { }
        public bool IsPresentationPageOwner(string pageId, string owner) => OwnsPage;
        public IDisposable SubscribeRendererChanged(Action handler) => new NoopCancellation();
    }
}
