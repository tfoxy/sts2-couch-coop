using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Tests;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunCouchPlayJoinRoutesAsync()
    {
        using var root = new TempStaticRoot();
        var previousModePath = Environment.GetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable);
        Environment.SetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable, Path.Combine(root.Path, "couch-play.json"));
        CouchPlayModeStore.ResetForTests();
        var scenarios = 0;
        try
        {
            foreach (var mode in Enum.GetValues<CouchPlayMode>())
            foreach (var screen in new[] { RuntimeStateMode.SingleplayerAmbiguous, RuntimeStateMode.Lobby, RuntimeStateMode.Unsupported })
            foreach (var hasManager in new[] { true, false })
            {
                Expect(CouchPlayModeStore.TrySet(mode), "test mode persists");
                var runtime = new RecordingSpirectlRuntime { Mode = screen, LobbyNetGameType = NetTypeNames.Singleplayer };
                using var facts = runtime.InstallGameFacts();
                var launches = 0;
                using var manager = hasManager ? new HeadlessClientManager(
                    launcher: _ => { launches++; throw new Exception("a solo join must never launch a seat"); },
                    readinessProbe: (_, _) => Task.FromResult(true),
                    registerProcessExit: false) : null;
                var access = new TestHostBrowserAccess(false);
                await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path),
                    new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(), preferredPort: 0,
                    headlessManager: manager, isHeadlessClient: false, hostBrowserAccess: access,
                    headlessManagerFactory: () => null);
                var uri = await server.StartAsync();
                var allowed = mode == CouchPlayMode.EveryScreen
                    || mode == CouchPlayMode.SoloScreens && screen != RuntimeStateMode.Unsupported;
                foreach (var (name, playerId) in new (string, string?)[]
                         { ("", null), ("Alice", null), ("A new name", null), ("A new name", "p:1002"), ("Alice", "p:1") })
                {
                    using var socket = new ClientWebSocket();
                    await socket.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws",
                        Query = StreamingQuery.Replace("watch=1", "watch=0") }.Uri, CancellationToken.None);
                    _ = await ReadWsMessageAsync(socket);
                    var reply = await SendJoinAsync(socket, "couch-play-join-" + scenarios++, name, playerId);
                    Expect(reply.TryGetProperty("directView", out var direct) && direct.GetBoolean() == allowed,
                        $"{mode}/{screen}/{hasManager}/{name}/{playerId}: direct view follows the host mode: {reply}");
                    Expect(!reply.TryGetProperty("headlessMirrorPort", out _) && !reply.TryGetProperty("headlessMirrorPath", out _),
                        "solo and main-menu joins never redirect to a seat");
                    Expect(!reply.TryGetProperty("joinRejection", out _), "seat joinability is not consulted");
                    Expect(!reply.GetProperty("hostAccess").GetProperty("allowed").GetBoolean(),
                        "direct routing cannot grant host stream or input access");
                    await CloseWebSocketSilentlyAsync(socket);
                }
                Expect(launches == 0 && manager?.HasNameClaim("A new name") != true, "no solo join allocates or spawns a seat");
                Expect(!access.Started, "a join without watch keeps policy demand dormant");
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable(CouchPlayModeStore.PathEnvironmentVariable, previousModePath);
            CouchPlayModeStore.ResetForTests();
        }
        Console.WriteLine($"couch play join routes: {scenarios} cases passed");
    }

    internal static async Task RunHostAccessRoutesAsync()
    {
        using var root = new TempStaticRoot();
        var runtime = new RecordingSpirectlRuntime { Mode = RuntimeStateMode.MultiplayerRun };
        var access = new TestHostBrowserAccess(false);
        var previousThread = GameMainThread.Source;
        using var mainThread = new HopCountingMainThread();
        GameMainThread.Source = mainThread;
        try
        {
            await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path),
                new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(), preferredPort: 0,
                isHeadlessClient: false, hostBrowserAccess: access);
            var uri = await server.StartAsync();
            // The retained host coordination socket (including one belonging to a separate player) is
            // not host-watch demand and cannot mutate the host even if another viewer is allowed.
            using var coordination = new ClientWebSocket();
            await coordination.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws",
                Query = StreamingQuery.Replace("watch=1", "watch=0") + "&isHeadlessClient=true" }.Uri,
                CancellationToken.None);
            _ = await ReadWsMessageAsync(coordination);
            await AssertNoSceneDeltaAsync(coordination, "coordination-only connection receives no scene");
            Expect(!access.Started && access.StartCount == 0 && access.ListenerCount == 0,
                "coordination-only connection starts no policy and subscribes no listener");
            var connections = (System.Collections.Concurrent.ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>)
                typeof(CouchCoopBrowserServer).GetField("_connections", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(server)!;
            // Exercise the otherwise rare host-without-resolved-executable fallback on a real socket.
            typeof(CouchCoopWebSocketConnection).GetField("_headlessManager",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.SetValue(connections.Values.Single(), null);
            var fallbackJoin = await SendJoinAsync(coordination, "fallback-host-join", "Host");
            Expect(fallbackJoin.GetProperty("directView").GetBoolean(), "explicit fallback join can request host view while policy is dormant");
            Expect(!fallbackJoin.GetProperty("hostAccess").GetProperty("allowed").GetBoolean(), "fallback routing grants no host authorization");
            Expect(!access.Started && access.StartCount == 0 && access.ListenerCount == 0,
                "fallback join does not start access monitoring before watch request");
            using var socket = new ClientWebSocket();
            await socket.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws",
                Query = StreamingQuery + "&isHeadlessClient=true&directView=true&viewerId=host" }.Uri,
                CancellationToken.None);
            using (var session = JsonDocument.Parse(await ReadWsMessageAsync(socket)))
                Expect(!session.RootElement.GetProperty("hostAccess").GetProperty("allowed").GetBoolean(), "initial session denies host access");
            Expect(access.Started && access.ListenerPresentAtStart, "blocked watcher attaches listener before starting permission observer");
            Expect(!runtime.SceneSubscriptionActive, "watch=1 cannot start blocked scene capture");
            var asset = await GetAsync(uri, "/res/images/opaque.png");
            Expect(asset.StatusLine.Contains("200 OK", StringComparison.Ordinal), "shared assets remain available while host is blocked");
            await AssertNoSceneDeltaAsync(socket, "no blocked initial keyframe");
            await SendAccessInputAsync(socket, "blocked-input");
            using (var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(socket, "blocked-input")))
                Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied", "raw input rejected by server");
            foreach (var kind in new[] { "SelectMapNode", "SetScrollOffset" })
            {
                var id = "blocked-" + kind;
                await SendAccessJsonAsync(socket, JsonSerializer.Serialize(new { type = "action", requestId = id,
                    semanticActionId = kind, viewerId = "host", viewerPlayerId = "p:1" }));
                using var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(socket, id));
                Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied", "alternate action path blocked");
            }
            Expect(runtime.LastActionRequest is null, "blocked requests never reach runtime");
            await SendWatchAsync(socket, true);
            await AssertNoSceneDeltaAsync(socket, "watch messages cannot override host permission");

            // A screen change made while access was denied (no scene observer runs then) must reach the viewer on
            // the grant, before the access update, so its join logic acts on the current screen.
            runtime.Mode = RuntimeStateMode.Lobby;
            access.Set(true);
            Expect(await ReadSessionBeforeAccessAsync(socket) == "lobby", "a grant re-sends the session with the current screen");
            access.Set(false);
            await ReadAccessStatusAsync(socket, false);
            Expect(await WaitForSceneSubscriptionAsync(runtime, false), "re-blocked before the grant loop");
            runtime.Mode = RuntimeStateMode.MultiplayerRun;

            for (var iteration = 0; iteration < 2; iteration++)
            {
                access.Set(true);
                await ReadAccessStatusAsync(socket, true);
                Expect(access.ListenerCount == 1, "coordination sockets do not subscribe to active policy");
                await SendAccessInputAsync(coordination, "coordination-input-" + iteration);
                using (var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(coordination, "coordination-input-" + iteration)))
                    Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied", "watch=false cannot borrow another viewer's permission");
                Expect(await WaitForSceneSubscriptionAsync(runtime, true), "allow resumes requested stream automatically");
                runtime.PushSceneDelta(BuildSampleSceneDelta());
                using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(socket,
                    node => TryReadFirstUpsertOriginX(node) == 100)))
                    Expect(scene.RootElement.GetProperty("full").GetBoolean(), "resume re-seeds with a full scene");
                await SendAccessInputAsync(socket, "allowed-" + iteration);
                _ = await ReadCorrelatedReplyAsync(socket, "allowed-" + iteration);
                Expect(runtime.LastActionRequest?.RequestId == "allowed-" + iteration, "allowed input executes");
                access.Set(false);
                await ReadAccessStatusAsync(socket, false);
                Expect(await WaitForSceneSubscriptionAsync(runtime, false), "revocation stops producer");
                runtime.PushSceneDelta(BuildSampleSceneDelta());
                await AssertNoSceneDeltaAsync(socket, "no retained or subsequent scene leaks while blocked");
            }
            access.Set(true);
            await ReadAccessStatusAsync(socket, true);
            Expect(await WaitForSceneSubscriptionAsync(runtime, true), "stream ready for send-race test");
            var connection = connections.Values.Single(c => c.WantsSceneStream);
            var sendGate = (SemaphoreSlim)typeof(CouchCoopWebSocketConnection).GetField("_sendGate",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(connection)!;
            await sendGate.WaitAsync();
            try
            {
                runtime.PushSceneDelta(BuildSampleSceneDelta("old-generation", 333, true, ["old-generation"]));
                var creditField = typeof(CouchCoopWebSocketConnection).GetField("_sceneCredit",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
                Expect(await WaitForAsync(() => !(bool)creditField.GetValue(connection)!), "scene resolved while socket send is blocked");
                access.Set(false);
                access.Set(true);
            }
            finally { sendGate.Release(); }
            // Status is stamped under the send lock, including a hard clear that was immediately followed
            // by a grant while delivery was blocked.
            await ReadAccessStatusAsync(socket, true, access.State.SceneResetGeneration);
            // Drain through a transport fence: the prepared old frame must not follow the reopened state.
            await AssertNoSceneDeltaAsync(socket, "a frame prepared before revocation cannot pass the final send gate");
            using (var second = new ClientWebSocket())
            {
                await second.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws", Query = StreamingQuery }.Uri,
                    CancellationToken.None);
                _ = await ReadWsMessageAsync(second);
                await ReadAccessStatusAsync(second, true);
                Expect(await WaitForAsync(() => connections.Values.Count(c => c.WantsSceneStream) == 2),
                    "both viewers share the producer");
                await SendWatchAsync(socket, true);
                await ReadAccessStatusAsync(socket, true);
                var beforeWatchToggle = access.State;
                var startsBeforeWatchToggle = access.StartCount;
                var observerBeforeToggle = typeof(CouchCoopBrowserServer).GetField("_sceneObserver",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(server);
                using (var hold = new ManualResetEventSlim(false))
                {
                    runtime.ExecuteActionGate = hold;
                    await SendAccessInputAsync(socket, "watch-executing");
                    Expect(await WaitForAsync(() => runtime.LastActionRequest?.RequestId == "watch-executing"), "input occupies game thread for watch race");
                    await SendAccessInputAsync(socket, "queued-before-watch-off");
                    await SendWatchAsync(socket, false);
                    await ReadAccessStatusAsync(socket, true);
                    Expect(access.Started && access.ListenerCount == 1, "other viewer retains policy demand");
                    await SendWatchAsync(socket, true);
                    await ReadAccessStatusAsync(socket, true);
                    Expect(ReferenceEquals(access.State, beforeWatchToggle) && access.StartCount == startsBeforeWatchToggle,
                        "watch cycle does not revoke or restart another viewer's policy");
                    Expect(ReferenceEquals(observerBeforeToggle, typeof(CouchCoopBrowserServer).GetField("_sceneObserver",
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(server)),
                        "watch cycle preserves other viewer's shared scene observer");
                    hold.Set();
                    using var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(socket, "queued-before-watch-off"));
                    Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied", "watch reopening cannot revive queued input");
                    Expect(runtime.LastActionRequest?.RequestId == "watch-executing", "watch-revoked input never executes");
                    runtime.ExecuteActionGate = null;
                }
                await AssertNoSceneDeltaAsync(socket, "no unexpected retained scene before watch send race");
                await sendGate.WaitAsync();
                try
                {
                    // Queue a serialized frame behind the actual socket send lock. Toggle watch demand at
                    // receipt while it is delayed; no global policy change participates in this rejection.
                    var oldWatchEpoch = (long)typeof(CouchCoopWebSocketConnection).GetField("_watchEpoch",
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(connection)!;
                    var sendMethod = typeof(CouchCoopWebSocketConnection).GetMethods(System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)
                        .Single(m => m.Name == "SendBytesAsync" && m.GetParameters().Length == 8);
                    var oldSend = (Task)sendMethod.Invoke(connection, [Encoding.UTF8.GetBytes("{\"type\":\"scene-delta\",\"oldWatch\":true}"),
                        CancellationToken.None, access.State.Generation, oldWatchEpoch, null, false, false, null])!;
                    await SendWatchAsync(socket, false);
                    Expect(await WaitForAsync(() => !connection.WantsSceneStream), "watch off immediately fences sends before its status can send");
                    sendGate.Release();
                    await oldSend;
                    await ReadAccessStatusAsync(socket, true);
                    await AssertNoSceneDeltaAsync(socket, "delayed old-watch frame cannot pass send gate");
                    await SendWatchAsync(socket, true);
                    await ReadAccessStatusAsync(socket, true);
                }
                finally { if (sendGate.CurrentCount == 0) sendGate.Release(); }
                var delayedConnection = connections.Values.Single(c => c.WantsSceneStream && !ReferenceEquals(c, connection));
                var refreshGate = (SemaphoreSlim)typeof(CouchCoopWebSocketConnection).GetField("_accessTransitionGate",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(delayedConnection)!;
                var observerField = typeof(CouchCoopBrowserServer).GetField("_sceneObserver",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
                var oldObserver = observerField.GetValue(server);
                var oldCallback = (Action<Spirectl.Sts2.Core.SceneInspection.RuntimeSceneDelta>)typeof(RecordingSpirectlRuntime)
                    .GetField("_sceneObserver", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(runtime)!;
                await refreshGate.WaitAsync();
                try
                {
                    access.Set(false);
                    access.Set(true);
                    Expect(await WaitForAsync(() => connection.WantsSceneStream
                        && observerField.GetValue(server) is { } current && !ReferenceEquals(oldObserver, current)),
                        "permission change retires shared observer even while another viewer still has registered demand");
                    oldCallback(BuildSampleSceneDelta("retired-source", 777, true, ["retired-source"]));
                    await AssertNoSceneDeltaAsync(socket, "a late retired-producer callback cannot enter the reopened scene");
                }
                finally { refreshGate.Release(); }
                await CloseWebSocketSilentlyAsync(second);
            }
            using (var hold = new ManualResetEventSlim(false))
            {
                runtime.ExecuteActionGate = hold;
                await SendAccessInputAsync(socket, "executing");
                Expect(await WaitForAsync(() => runtime.LastActionRequest?.RequestId == "executing"), "first input reached game thread");
                await SendAccessInputAsync(socket, "queued-before-menu");
                // The pong fences receipt without requiring the occupied game thread.
                await SendAccessJsonAsync(socket, "{\"type\":\"ping\",\"t0\":12345}");
                using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                {
                    while (true)
                    {
                        using var frame = JsonDocument.Parse(await ReadWsMessageAsync(socket, deadline.Token));
                        if (frame.RootElement.GetProperty("type").GetString() == "pong") break;
                    }
                }
                access.Set(false);
                access.Set(true);
                hold.Set();
                using var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(socket, "queued-before-menu"));
                Expect(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied", "reopening cannot revive queued old-generation input");
                Expect(runtime.LastActionRequest?.RequestId == "executing", "revoked queued input never executed");
                runtime.ExecuteActionGate = null;
            }
            await CloseWebSocketSilentlyAsync(socket);
            Expect(await WaitForAsync(() => !access.Started), "last watcher disconnect stops permission monitoring despite coordination socket");
            Expect(access.ListenerCount == 0, "last watcher detaches policy listener");
            Expect(access.StartCount == access.StopCount, "watch-demand start and stop balanced");
            await CloseWebSocketSilentlyAsync(coordination);
            access.Set(false);
            using (var reconnect = new ClientWebSocket())
            {
                await reconnect.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws", Query = StreamingQuery }.Uri,
                    CancellationToken.None);
                using var session = JsonDocument.Parse(await ReadWsMessageAsync(reconnect));
                Expect(!session.RootElement.GetProperty("hostAccess").GetProperty("allowed").GetBoolean(),
                    "reconnecting cannot inherit a previous connection's permission");
                await AssertNoSceneDeltaAsync(reconnect, "blocked reconnect receives no retained scene");
                await CloseWebSocketSilentlyAsync(reconnect);
            }

            Expect(await WaitForAsync(() => !access.Started && access.ListenerCount == 0), "blocked reconnect releases watch demand");
            var hostStartsBeforeSeat = access.StartCount;
            // A separate player instance uses server process identity, not a query or supplied viewer id.
            await using var seat = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path),
                new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(), preferredPort: 0,
                isHeadlessClient: true, hostBrowserAccess: access);
            var seatUri = await seat.StartAsync();
            using var player = new ClientWebSocket();
            await player.ConnectAsync(new UriBuilder(seatUri) { Scheme = "ws", Path = "/ws", Query = StreamingQuery }.Uri,
                CancellationToken.None);
            using (var session = JsonDocument.Parse(await ReadWsMessageAsync(player)))
                Expect(session.RootElement.GetProperty("hostAccess").GetProperty("allowed").GetBoolean(), "separate seat remains available");
            Expect(await WaitForSceneSubscriptionAsync(runtime, true), "separate seat starts its own scene producer while host access is blocked");
            runtime.PushSceneDelta(BuildSampleSceneDelta());
            using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(player,
                node => TryReadFirstUpsertOriginX(node) == 100)))
                Expect(scene.RootElement.GetProperty("full").GetBoolean()
                    && scene.RootElement.GetProperty("presentationEpoch").GetInt64() == 0,
                    "legacy separate seat receives its original presentation FULL before input");
            await SendAccessInputAsync(player, "seat-input");
            _ = await ReadCorrelatedReplyAsync(player, "seat-input");
            Expect(runtime.LastActionRequest?.RequestId == "seat-input", "separate player controls unaffected");
            foreach (var kind in new[] { "select-map-node", "set-scroll-offset" })
            {
                await SendAccessJsonAsync(player, JsonSerializer.Serialize(new { type = "action", requestId = "seat-" + kind,
                    semanticActionId = kind, args = new { elementId = "42" } }));
                _ = await ReadCorrelatedReplyAsync(player, "seat-" + kind);
                Expect(runtime.LastActionRequest?.RequestId == "seat-" + kind,
                    "separate seat gameplay action ignores blocked host privacy: " + kind);
            }
            using (var seatHold = new ManualResetEventSlim(false))
            {
                runtime.ExecuteActionGate = seatHold;
                await SendAccessJsonAsync(player, "{\"type\":\"input\",\"requestId\":\"seat-held\",\"kind\":\"key\",\"key\":\"KeyA\",\"pressed\":true}");
                Expect(await WaitForAsync(() => runtime.LastActionRequest?.RequestId == "seat-held"), "seat press reaches executor");
                await SendAccessJsonAsync(player, "{\"type\":\"input\",\"requestId\":\"seat-release\",\"kind\":\"key\",\"key\":\"KeyA\",\"pressed\":false}");
                await SendAccessJsonAsync(player, "{\"type\":\"ping\",\"t0\":67890}");
                using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                {
                    while (true)
                    {
                        using var frame = JsonDocument.Parse(await ReadWsMessageAsync(player, deadline.Token));
                        if (frame.RootElement.GetProperty("type").GetString() == "pong") break;
                    }
                }
                var cancellations = runtime.InputCancellations;
                var seatConnections = (System.Collections.Concurrent.ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>)
                    typeof(CouchCoopBrowserServer).GetField("_connections", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(seat)!;
                var playerConnection = seatConnections.Values.Single();
                await CloseWebSocketSilentlyAsync(player);
                Expect(await WaitForAsync(() => (bool)typeof(CouchCoopWebSocketConnection).GetField("_closing",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(playerConnection)!),
                    "seat disconnect retires input before the game thread resumes");
                seatHold.Set();
                Expect(await WaitForAsync(() => runtime.InputCancellations > cancellations),
                    "separate player disconnect cancels held input instead of replaying retired work");
                Expect(await WaitForAsync(() => seatConnections.IsEmpty), "separate seat finishes draining retired input");
                Expect(runtime.LastActionRequest?.RequestId == "seat-held", "disconnect rejects its queued release after retiring the watch epoch");
                runtime.ExecuteActionGate = null;
            }
            using (var actionPlayer = new ClientWebSocket())
            {
                await actionPlayer.ConnectAsync(new UriBuilder(seatUri) { Scheme = "ws", Path = "/ws", Query = StreamingQuery }.Uri,
                    CancellationToken.None);
                _ = await ReadWsMessageAsync(actionPlayer);
                Expect(await WaitForSceneSubscriptionAsync(runtime, true), "action disconnect viewer starts its own scene subscription");
                runtime.PushSceneDelta(BuildSampleSceneDelta());
                _ = await ReadNextSceneDeltaMatchingAsync(actionPlayer, node => node.GetProperty("full").GetBoolean());
                var seatConnections = (System.Collections.Concurrent.ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>)
                    typeof(CouchCoopBrowserServer).GetField("_connections", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(seat)!;
                var actionConnection = seatConnections.Values.Single();
                var lastAction = runtime.LastActionRequest;
                using var entered = new ManualResetEventSlim();
                using var release = new ManualResetEventSlim();
                var blocked = Task.Run(() => mainThread.Invoke(() => { entered.Set(); release.Wait(); return true; }));
                try
                {
                    Expect(entered.Wait(TimeSpan.FromSeconds(5)), "test holds the game thread before seat actions arrive");
                    var hops = mainThread.Hops;
                    foreach (var kind in new[] { "select-map-node", "set-scroll-offset" })
                        await SendAccessJsonAsync(actionPlayer, JsonSerializer.Serialize(new { type = "action", requestId = "retired-" + kind,
                            semanticActionId = kind, args = new { elementId = "42" } }));
                    await SendAccessJsonAsync(actionPlayer, "{\"type\":\"ping\",\"t0\":123456}");
                    using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5)))
                    {
                        while (true)
                        {
                            using var frame = JsonDocument.Parse(await ReadWsMessageAsync(actionPlayer, deadline.Token));
                            if (frame.RootElement.GetProperty("type").GetString() == "pong") break;
                        }
                    }
                    Expect(await WaitForAsync(() => mainThread.Hops > hops), "accepted action waits for the game thread without blocking socket receive");
                    await CloseWebSocketSilentlyAsync(actionPlayer);
                    Expect(await WaitForAsync(() => (bool)typeof(CouchCoopWebSocketConnection).GetField("_closing",
                        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(actionConnection)!),
                        "real browser closure retires queued gameplay actions before the game thread resumes");
                }
                finally { release.Set(); await blocked; }
                Expect(await WaitForAsync(() => seatConnections.IsEmpty), "seat disconnect drains both pending gameplay actions");
                Expect(ReferenceEquals(runtime.LastActionRequest, lastAction), "neither queued map nor scroll action executes after real disconnect");
            }
            Expect(access.StartCount == hostStartsBeforeSeat && !access.Started && access.ListenerCount == 0,
                "separate player instance creates no host access demand");
        }
        finally { GameMainThread.Source = previousThread; }
        Console.WriteLine("host access routes: ok");
    }

    private static Task SendAccessJsonAsync(ClientWebSocket socket, string json)
        => socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, CancellationToken.None);
    private static Task SendAccessInputAsync(ClientWebSocket socket, string id)
        => SendAccessJsonAsync(socket, JsonSerializer.Serialize(new { type = "input", requestId = id, kind = "key", key = "KeyA" }));
    /// <summary>The screen kind of the session that precedes the next allowed access update, or null if none did.</summary>
    private static async Task<string?> ReadSessionBeforeAccessAsync(ClientWebSocket socket)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        string? kind = null;
        while (true)
        {
            using var doc = JsonDocument.Parse(await ReadWsMessageAsync(socket, timeout.Token));
            var type = doc.RootElement.GetProperty("type").GetString();
            if (type == "session" && doc.RootElement.TryGetProperty("screen", out var screen))
                kind = screen.GetProperty("kind").GetString();
            if (type == "host-access" && doc.RootElement.GetProperty("hostAccess").GetProperty("allowed").GetBoolean())
                return kind;
        }
    }

    private static async Task ReadAccessStatusAsync(ClientWebSocket socket, bool allowed, long minimumResetGeneration = 0)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        while (true)
        {
            using var doc = JsonDocument.Parse(await ReadWsMessageAsync(socket, timeout.Token));
            if (doc.RootElement.GetProperty("type").GetString() == "host-access"
                && doc.RootElement.GetProperty("hostAccess").GetProperty("allowed").GetBoolean() == allowed)
            {
                Expect(doc.RootElement.GetProperty("hostAccess").GetProperty("sceneResetGeneration").GetInt64() >= minimumResetGeneration,
                    "access updates carry the sticky scene reset generation");
                return;
            }
        }
    }
}
