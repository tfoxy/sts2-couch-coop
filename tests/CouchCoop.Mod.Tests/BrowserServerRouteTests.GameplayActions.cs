using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;

internal sealed partial class BrowserServerRouteTests
{
    internal static void RunGameplayActionDtos()
    {
        var assertions = 0;
        void Check(bool condition, string message) { Expect(condition, message); assertions++; }
        foreach (var kind in new[] { "select-map-node", "set-scroll-offset" })
        foreach (var epoch in new long?[] { null, 0, 17 })
        {
            var args = new Dictionary<string, JsonElement> { ["elementId"] = JsonSerializer.SerializeToElement("42") };
            var message = new ActionMessage("action-dto", kind, args, epoch);
            var json = ProtocolJson.Serialize(message);
            using var document = JsonDocument.Parse(json);
            Check(document.RootElement.TryGetProperty("presentationEpoch", out var field) == (epoch is not null),
                "action wire omits absent epoch and preserves an explicit epoch");
            if (epoch is not null) Check(field.GetInt64() == epoch, "displayed action epoch survives serialization");
            Check(Encoding.UTF8.GetString(ProtocolJson.SerializeToUtf8Bytes(message)) == json,
                "action string and UTF-8 serialization agree");
            var parsed = JsonSerializer.Deserialize<BrowserActionRequestEnvelope>(json, BrowserJson.Options)!;
            Check(parsed.Type == "action" && parsed.RequestId == message.RequestId && parsed.SemanticActionId == kind
                && parsed.PresentationEpoch == epoch && parsed.Args!["elementId"].GetString() == "42",
                "mirror action wire parses as the backend gameplay action DTO");
            var roundtrip = JsonSerializer.Deserialize<BrowserActionRequestEnvelope>(BrowserJson.Serialize(parsed), BrowserJson.Options)!;
            Check(roundtrip.PresentationEpoch == epoch, "backend DTO round-trips the displayed epoch");
        }
        Console.WriteLine($"Gameplay action DTOs: {assertions} assertions passed.");
    }

    internal static async Task RunGameplayActionFencesAsync()
    {
        var assertions = 0;
        void Check(bool condition, string message) { Expect(condition, message); assertions++; }
        var runtime = new RecordingSpirectlRuntime();
        var host = new PresentationTestHost();
        var access = new TestHostBrowserAccess(false);
        var factory = runtime.NewEnvelopeFactory();
        var connectionType = typeof(CouchCoopWebSocketConnection);
        var connection = (CouchCoopWebSocketConnection)connectionType
            .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).Single().Invoke(
            [factory, new ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>(),
                (Func<CouchCoopSceneObserver?>)(() => null), (Action)(() => { }), (Action)(() => { }),
                (Action<bool>)(_ => { }), null, null, true, true, false, false,
                new ConnectionArrivalLog(), null, access, null, null, host]);
        void Set(string name, object value) => connectionType.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(connection, value);
        void Reset()
        {
            host.Epoch = 1;
            host.Ready = true;
            host.Width = 1920;
            host.Stream = false;
            host.OwnsPage = true;
            Set("_rendererProtocol2", true);
            Set("_legacyPresentationEpoch", 1L);
            Set("_fullPresentationEpoch", 1L);
            Set("_watchRequested", true);
            Set("_watchEpoch", 0L);
            Set("_closing", false);
            runtime.ResetActionProbe();
        }
        async Task<JsonElement[]> Receive(string json)
        {
            using var socket = new GameplayActionSocket(json);
            using var session = factory.CreateSession();
            Set("_socket", socket);
            var task = (Task)connectionType.GetMethod("ReceiveLoopAsync", BindingFlags.Instance | BindingFlags.NonPublic)!
                .Invoke(connection, [socket, session, CancellationToken.None])!;
            await task.WaitAsync(TimeSpan.FromSeconds(5));
            var drain = (Task)connectionType.GetField("_actionPumpTask", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(connection)!;
            await drain.WaitAsync(TimeSpan.FromSeconds(5));
            return socket.Sent.ToArray();
        }
        string ActionJson(string kind, long? epoch) => ProtocolJson.Serialize(new ActionMessage("fenced-action", kind,
            new() { ["elementId"] = JsonSerializer.SerializeToElement("42") }, epoch));
        void Result(JsonElement[] replies, bool allowed, string label)
        {
            Check(replies.Length == 1 && replies[0].GetProperty("type").GetString() == "action-result"
                && replies[0].GetProperty("requestId").GetString() == "fenced-action", label + ": correlated reply");
            Check((runtime.LastActionRequest is not null) == allowed, label + ": runtime admission");
            Check(allowed ? !replies[0].TryGetProperty("code", out _)
                : replies[0].GetProperty("code").GetString() == "host-access-denied", label + ": admission result");
        }
        var prior = GameMainThread.Source;
        using var main = new HopCountingMainThread();
        GameMainThread.Source = main;
        try
        {
            foreach (var kind in new[] { "select-map-node", "set-scroll-offset" })
            {
                foreach (var (label, prepare, epoch, allowed) in new (string, Action, long?, bool)[]
                {
                    ("missing epoch", () => { }, null, false),
                    ("stale epoch", () => { }, 0, false),
                    ("current epoch", () => { }, 1, true),
                    ("before full", () => Set("_fullPresentationEpoch", -1L), 1, false),
                    ("unready", () => host.Ready = false, 1, false),
                    ("incompatible mirror", () => host.Width = 2520, 1, false),
                    ("not watching", () => Set("_watchRequested", false), 1, false),
                    ("replaced owner", () => host.OwnsPage = false, 1, false),
                    ("retired connection", () => Set("_closing", true), 1, false),
                    ("legacy initial epoch", () => Set("_rendererProtocol2", false), null, true),
                    ("legacy changed epoch", () => { Set("_rendererProtocol2", false); host.Epoch = 2; Set("_fullPresentationEpoch", 2L); }, null, false),
                    ("stream ready", () => { host.Stream = true; host.Width = 2520; Set("_watchRequested", false); Set("_fullPresentationEpoch", -1L); }, 1, true),
                })
                {
                    Reset();
                    prepare();
                    var hops = main.Hops;
                    Result(await Receive(ActionJson(kind, epoch)), allowed, kind + " " + label);
                    if (!allowed) Check(main.Hops == hops, label + ": rejected at receipt before a game-thread hop");
                }

                foreach (var (label, transition) in new (string, Action)[]
                {
                    ("epoch changes", () => { host.Epoch = 2; Set("_fullPresentationEpoch", 2L); }),
                    ("becomes unready", () => host.Ready = false),
                    ("full revoked", () => Set("_fullPresentationEpoch", -1L)),
                    // A new FULL at the same global epoch must not revive work from an earlier watch lease.
                    ("watch restarts", () => { Set("_watchEpoch", 2L); Set("_fullPresentationEpoch", 1L); }),
                    ("disconnect", () => Set("_closing", true)),
                    ("owner replaced", () => host.OwnsPage = false),
                    ("legacy generation changes", () => { host.Epoch = 2; Set("_legacyPresentationEpoch", 2L); Set("_fullPresentationEpoch", 2L); }),
                })
                {
                    Reset();
                    var legacy = label == "legacy generation changes";
                    if (legacy) Set("_rendererProtocol2", false);
                    using var entered = new ManualResetEventSlim();
                    using var release = new ManualResetEventSlim();
                    var blocked = Task.Run(() => main.Invoke(() => { entered.Set(); release.Wait(); return true; }));
                    Task<JsonElement[]>? pending = null;
                    try
                    {
                        Check(entered.Wait(TimeSpan.FromSeconds(5)), "test holds the game thread before action receipt");
                        var hops = main.Hops;
                        pending = Task.Run(() => Receive(ActionJson(kind, legacy ? null : 1)));
                        Check(await WaitForAsync(() => main.Hops > hops), label + ": accepted action queues for the game thread");
                        transition();
                    }
                    finally { release.Set(); await blocked; }
                    Result(await pending!.WaitAsync(TimeSpan.FromSeconds(5)), false, kind + " queued " + label);
                }
            }
            Reset();
            host.Ready = false;
            host.OwnsPage = false;
            Set("_fullPresentationEpoch", -1L);
            var settingsHops = main.Hops;
            Check((await Receive("{\"type\":\"settings\",\"refreshRate\":30,\"freezeParticles\":true}")).Length == 0,
                "saved settings retain their no-reply behavior during a presentation hold");
            Check(main.Hops == settingsHops + 1, "saved settings still reach their existing main-thread path without gameplay admission");
            Check(!access.Started && access.ListenerCount == 0, "seat gameplay admission never acquires host privacy demand");
        }
        finally { GameMainThread.Source = prior; }
        Console.WriteLine($"Gameplay action fences: {assertions} assertions passed (24 receipt cases, 14 queued cases, settings and seat independence).");
    }

    private sealed class GameplayActionSocket(string json) : WebSocket
    {
        private bool _received;
        internal List<JsonElement> Sent { get; } = [];
        public override WebSocketCloseStatus? CloseStatus => WebSocketCloseStatus.NormalClosure;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;
        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus status, string? description, CancellationToken token) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus status, string? description, CancellationToken token) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken token)
            => throw new NotSupportedException();
        public override ValueTask<ValueWebSocketReceiveResult> ReceiveAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (_received) return ValueTask.FromResult(new ValueWebSocketReceiveResult(0, WebSocketMessageType.Close, true));
            var bytes = Encoding.UTF8.GetBytes(json);
            bytes.CopyTo(buffer);
            _received = true;
            return ValueTask.FromResult(new ValueWebSocketReceiveResult(bytes.Length, WebSocketMessageType.Text, true));
        }
        public override Task SendAsync(ArraySegment<byte> buffer, WebSocketMessageType type, bool end, CancellationToken token)
        {
            using var document = JsonDocument.Parse(buffer.AsMemory());
            Sent.Add(document.RootElement.Clone());
            return Task.CompletedTask;
        }
    }
}
