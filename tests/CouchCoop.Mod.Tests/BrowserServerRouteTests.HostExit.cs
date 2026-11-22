using System.Net.WebSockets;
using System.Collections.Concurrent;
using System.Reflection;
using System.Text.Json;
using CouchCoop.Mod;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Contracts;
using Spirectl.Sts2.Live;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunHostExitCloseAsync()
    {
        var before = _relayAssertions;
        using var root = new TempStaticRoot();
        var runtime = new RecordingSpirectlRuntime();
        var envelope = runtime.NewEnvelopeFactory();
        var cancellations = 0;
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var monitor = new HostBrowserAccessMonitor(_ => new NoopCancellation(),
            () => new(new GateFacts(true, null, NetTypeNames.Host), true, false, false),
            work => work(), () => { Interlocked.Increment(ref cancellations); envelope.RuntimeHost.CancelInjectedInput(); });
        monitor.Changed += state => { if (!state.Allowed) stopped.TrySetResult(); };
        await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path),
            new CapturingAssetAdapter(), envelope, preferredPort: 0, hostBrowserAccess: monitor);
        var uri = await server.StartAsync();
        var connections = (ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>)typeof(CouchCoopBrowserServer)
            .GetField("_connections", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(server)!;
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(new UriBuilder(uri) { Scheme = "ws", Path = "/ws", Query = StaticBgQuery }.Uri,
            CancellationToken.None);
        using (await ReadSessionAsync(socket)) { }
        await SendWatchAsync(socket, true);
        using (await ReadSessionAsync(socket)) { }
        RelayExpect(monitor.State.Allowed && connections.Count == 1, "connected page holds host watch access before exit");
        var subscription = envelope.RuntimeHost.SubscribeRuntimeSceneDelta(new(), _ => { });
        var previous = GameMainThread.Source;
        var context = new ExitCloseContext();
        runtime.OnInputCancellation = () => Sts2MainThreadDispatcher.Invoke(() => true);
        Sts2MainThreadDispatcher.Capture(context);
        GameMainThread.Source = SpirectlGameMainThread.Instance;
        try
        {
            CouchCoopMod.BeginHostExit();
            await CloseWebSocketSilentlyAsync(socket);
            await stopped.Task.WaitAsync(TimeSpan.FromSeconds(3));
            RelayExpect(cancellations == 1, "socket close reaches watch-off input cancellation after exit");
            RelayExpect(runtime.InputCancellations == 0 && context.Posts == 0,
                "watch-off skips the upstream synchronous dispatcher and posts no main-thread work");
            RelayExpect(await WaitForAsync(() => connections.IsEmpty), "socket thread completes teardown without a main-thread drain");
            await Task.Run(subscription.Dispose).WaitAsync(TimeSpan.FromSeconds(3));
            foreach (var operation in new Action[]
            {
                () => envelope.RuntimeHost.ExecuteAction(null!),
                () => envelope.RuntimeHost.GetModels(null!),
                () => envelope.RuntimeHost.GetSpineCatalog(null!),
                () => envelope.RuntimeHost.BakeSpineGeoClip(null!),
                () => envelope.RuntimeHost.GetPresentationAssets(null!),
                () => envelope.RuntimeHost.Assets.GetAsset(null!),
                () => envelope.RuntimeHost.Assets.GetAssets(null!),
                () => envelope.RuntimeHost.SubscribeRuntimeSceneDelta(new(), _ => { }),
            })
            {
                var rejected = false;
                try { operation(); } catch (OperationCanceledException) { rejected = true; }
                RelayExpect(rejected, "runtime request after exit is rejected before reaching its upstream port");
            }
            RelayExpect(context.Posts == 0, "runtime teardown and late requests do not post to the main thread");
        }
        finally
        {
            context.Drain();
            CouchCoopMod.EngineAvailable = false;
            GameMainThread.Source = previous;
            Sts2MainThreadDispatcher.ResetForTests();
        }
        Console.WriteLine($"Host exit socket close: {_relayAssertions - before} assertions passed.");
    }

    private sealed class ExitCloseContext : SynchronizationContext
    {
        private readonly ConcurrentQueue<Action> _queue = new();
        internal int Posts;
        public override void Post(SendOrPostCallback callback, object? state)
        {
            Interlocked.Increment(ref Posts);
            _queue.Enqueue(() => callback(state));
        }
        internal void Drain() { while (_queue.TryDequeue(out var work)) work(); }
    }

    internal static async Task RunHostExitMessagesAsync()
    {
        var before = _relayAssertions;
        await using var fixture = await RenderRelayFixture.StartAsync();
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Origin", CouchCoopWebOrigin.DefaultOrigin);
        await socket.ConnectAsync(new UriBuilder(new Uri(fixture.PublicUri, "/ws?" + GatedQuery)) { Scheme = "ws" }.Uri, CancellationToken.None);
        using (await ReadSessionAsync(socket)) { }
        await SendWatchAsync(socket, true);
        using (await ReadSessionAsync(socket)) { }
        await SendRendererAsync(socket, "stream");
        using (await ReadRendererAsync(socket, "armed")) { }
        var requests = fixture.SelfHost.Requests;
        var disarmed = false;
        var replay = new Queue<Action>();
        // The real prefix sets the latch even without a seat manager or an enabled capture.
        HostQuitPatch.BeforeQuit(null!);
        var sequence = new HostCaptureQuitSequence(
            () => { disarmed = true; return Task.CompletedTask; },
            action => CouchCoopMod.HostExit.TryEnqueue(() => replay.Enqueue(action), quitReplay: true),
            log: _ => { }, disarmOnMainThread: true);
        RelayExpect(!sequence.BeforeQuit(true, () => { }), "armed quit waits for disarm");
        await sequence.Completion;
        RelayExpect(disarmed && replay.Count == 1, "disarm completes and only quit replay is queued");
        var dropped = CouchCoopMod.HostExit.Dropped;
        foreach (var message in new[]
        {
            "{\"type\":\"session-refresh\"}",
            "{\"type\":\"client-vitals\"}",
            "{\"type\":\"settings\",\"streamClientTweens\":false,\"refreshRate\":30}",
            "{\"type\":\"renderer\",\"renderer\":\"mirror\"}",
            "{\"type\":\"ping\",\"mainThread\":true,\"t0\":1}"
        })
        {
            await SendControlAsync(socket, message);
            var reply = await ReadNextWsMessageOfTypeAsync(socket, "action-result");
            RelayExpect(reply.Contains("host-exiting"), "late page message receives host-exiting");
        }
        RelayExpect(fixture.SelfHost.Requests == requests && CouchCoopMod.HostExit.Dropped == dropped && replay.Count == 1,
            "late browser messages trigger no renderer reaction or main-thread posts after disarm");
        Console.WriteLine($"Host exit browser messages: {_relayAssertions - before} assertions passed.");
        replay.Dequeue()();
        await CloseWebSocketSilentlyAsync(socket);
    }
}
