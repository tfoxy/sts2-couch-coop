using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunHostRenderSceneDemandAsync()
    {
        using var root = new TempStaticRoot();
        var runtime = new RecordingSpirectlRuntime();
        var access = new TestHostBrowserAccess();
        var roster = new CouchCoopRosterObserverTests.FakeRosterFeed();
        var host = new SceneDemandPresentationHost();
        await using var server = new CouchCoopBrowserServer(
            new StaticSpaFileProvider(root.Path), new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(),
            preferredPort: 0, isHeadlessClient: false, hostBrowserAccess: access,
            rendererSwapHost: host, subscribeRoster: roster.Subscribe);
        var uri = await server.StartAsync();
        var checks = 0;
        void Check(bool value, string message) { Expect(value, message); checks++; }

        async Task<ClientWebSocket> Connect(bool watch)
        {
            var socket = new ClientWebSocket();
            await socket.ConnectAsync(new UriBuilder(uri)
            {
                Scheme = "ws", Path = "/ws",
                Query = StreamingQuery.Replace("watch=1", watch ? "watch=1" : "watch=0"),
            }.Uri, CancellationToken.None);
            using var session = await ReadSessionAsync(socket);
            return socket;
        }
        async Task Barrier(ClientWebSocket socket, string id)
        {
            await SendControlAsync(socket, JsonSerializer.Serialize(new { type = "session-refresh", requestId = id }));
            using var session = await ReadSessionAsync(socket, id);
        }

        using var stream = await Connect(watch: false);
        await SendControlAsync(stream, "{\"type\":\"watch\",\"on\":true,\"renderer\":\"stream\",\"rendererProtocol\":2}");
        await Barrier(stream, "stream-watch");
        Check(runtime.SceneSubscribeCount == 0, "stream watch intent never starts even a transient whole-scene subscription");
        Check(roster.Active && access.Started, "stream watch keeps roster signals and host-access demand alive");
        Check(host.Requests == 0, "watch intent does not arm capture");

        await SendRendererAsync(stream, "stream");
        await Barrier(stream, "stream-arming");
        Check(host.Requests == 1 && runtime.SceneSubscribeCount == 0, "renderer attach also starts no mirror producer");
        host.Arm();
        await Barrier(stream, "stream-armed");
        Check(!runtime.SceneSubscriptionActive && runtime.SceneSubscribeCount == 0,
            "an armed 1920-wide stream does not resume the whole-scene watcher");
        await SendControlAsync(stream, "{\"type\":\"input\",\"requestId\":\"stream-input\",\"kind\":\"key\",\"key\":\"KeyA\",\"presentationEpoch\":7}");
        _ = await ReadCorrelatedReplyAsync(stream, "stream-input");
        Check(runtime.LastActionRequest?.RequestId == "stream-input", "capture input works without a node-mirror keyframe");
        await SendWatchAsync(stream, false);
        await Barrier(stream, "stream-watch-off");
        await SendControlAsync(stream, "{\"type\":\"watch\",\"on\":true,\"renderer\":\"stream\",\"rendererProtocol\":2}");
        await SendWatchAsync(stream, true);
        await Barrier(stream, "stream-watch-resumed");
        Check(runtime.SceneSubscribeCount == 0,
            "a hinted page never subscribes across watch off/on or duplicate ordinary watch messages");
        access.Set(false);
        await ReadAccessStatusAsync(stream, false);
        access.Set(true);
        await ReadAccessStatusAsync(stream, true);
        await Barrier(stream, "hinted-stream-regrant");
        Check(runtime.SceneSubscribeCount == 0,
            "a hinted page never subscribes across access revoke/regrant before any mirror demand");
        // Watch/access teardown retires the page claim; restore stream ownership for the mixed-viewer checks.
        await SendRendererAsync(stream, "stream");
        await Barrier(stream, "hinted-stream-reregister");

        var priorScreen = runtime.Mode;
        runtime.Mode = RuntimeStateMode.Lobby;
        roster.Push(CouchCoopRosterObserverTests.Roster(2));
        using (var session = JsonDocument.Parse(await ReadNextSessionWithScreenKindAsync(stream, "lobby")))
            Check(session.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "lobby",
                "roster signals keep the stream page's session facts current without scene deltas");
        runtime.Mode = priorScreen;

        // An independent old-renderer viewer still owns the original full/delta/hint path.
        using var mirror = await Connect(watch: true);
        await Barrier(mirror, "mirror-watch");
        Check(runtime.SceneSubscriptionActive && runtime.SceneSubscribeCount == 1,
            "old-renderer watch starts the producer even while a stream page is present");
        runtime.PushSceneDelta(BuildSampleSceneDelta("mirror-full", 123, true, ["mirror-full"]));
        using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(mirror,
            node => TryReadFirstUpsertOriginX(node) == 123)))
            Check(scene.RootElement.GetProperty("full").GetBoolean(), "old renderer receives its full scene");
        await SendControlAsync(mirror, "{\"type\":\"scene-ack\"}");
        runtime.PushSceneDelta(BuildSampleSceneDelta("mirror-full", 124, false, ["mirror-full"]));
        using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(mirror,
            node => TryReadFirstUpsertOriginX(node) == 124)))
            Check(!scene.RootElement.GetProperty("full").GetBoolean(), "old renderer still receives incremental scene deltas");
        await AssertNoSceneDeltaAsync(stream, "a stream page receives no mirror deltas from another viewer's producer");
        Check(runtime.SceneSubscribeCount == 1, "mixed viewers share only the old renderer's producer");

        await SendWatchAsync(mirror, false);
        await Barrier(mirror, "mirror-off");
        Check(!runtime.SceneSubscriptionActive && roster.Active, "last mirror watch off stops producer while stream session facts stay live");
        await SendRendererAsync(stream, "mirror");
        await Barrier(stream, "return-mirror");
        Check(await WaitForAsync(() => runtime.SceneSubscriptionActive && runtime.SceneSubscribeCount == 2),
            "explicit mirror fallback resumes the original producer");
        runtime.PushSceneDelta(BuildSampleSceneDelta("fallback-full", 125, true, ["fallback-full"]));
        using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(stream,
            node => TryReadFirstUpsertOriginX(node) == 125)))
            Check(scene.RootElement.GetProperty("full").GetBoolean(), "fallback re-seeds the node mirror with a full scene");
        await SendRendererAsync(stream, "stream");
        await Barrier(stream, "stream-again");
        Check(!runtime.SceneSubscriptionActive, "a stream request without an early hint stops an existing mirror subscription");

        access.Set(false);
        await ReadAccessStatusAsync(stream, false);
        await SendControlAsync(stream, "{\"type\":\"input\",\"requestId\":\"denied-stream-input\",\"kind\":\"key\",\"key\":\"KeyA\",\"presentationEpoch\":7}");
        using (var rejected = JsonDocument.Parse(await ReadCorrelatedReplyAsync(stream, "denied-stream-input")))
            Check(rejected.RootElement.GetProperty("code").GetString() == "host-access-denied",
                "stream intent cannot bypass revoked host access");
        access.Set(true);
        await ReadAccessStatusAsync(stream, true);
        await Barrier(stream, "stream-regrant");
        Check(!runtime.SceneSubscriptionActive, "permission regrant does not restart the stream page's mirror watcher");

        access.Set(false);
        await ReadAccessStatusAsync(stream, false);
        var requestsBeforeDeniedMirror = host.Requests;
        var subscriptionsBeforeDeniedMirror = runtime.SceneSubscribeCount;
        await SendRendererAsync(stream, "mirror");
        await Barrier(stream, "denied-mirror");
        Check(host.Requests == requestsBeforeDeniedMirror && !runtime.SceneSubscriptionActive,
            "a mirror withdrawal while denied is ignored without changing presentation demand");
        access.Set(true);
        await ReadAccessStatusAsync(stream, true);
        await Barrier(stream, "denied-mirror-regrant");
        Check(!runtime.SceneSubscriptionActive && runtime.SceneSubscribeCount == subscriptionsBeforeDeniedMirror,
            "regrant retains stream intent until an admitted mirror withdrawal arrives");
        await SendRendererAsync(stream, "mirror");
        await Barrier(stream, "admitted-mirror");
        Check(await WaitForAsync(() => runtime.SceneSubscriptionActive
            && runtime.SceneSubscribeCount == subscriptionsBeforeDeniedMirror + 1),
            "resending mirror after grant resumes exactly one scene subscription");
        runtime.PushSceneDelta(BuildSampleSceneDelta("regrant-full", 126, true, ["regrant-full"]));
        using (var scene = JsonDocument.Parse(await ReadNextSceneDeltaMatchingAsync(stream,
            node => TryReadFirstUpsertOriginX(node) == 126)))
            Check(scene.RootElement.GetProperty("full").GetBoolean(), "admitted mirror withdrawal delivers a fresh full keyframe");

        await CloseWebSocketSilentlyAsync(mirror);
        await CloseWebSocketSilentlyAsync(stream);
        Check(await WaitForAsync(() => !roster.Active && !access.Started), "disconnect releases roster and host-access demand");
        foreach (var (supported, protocol) in new[] { (false, "2"), (true, "1"), (true, "\"2\""), (true, "null"), (true, "{}") })
        {
            var ignoredRuntime = new RecordingSpirectlRuntime();
            var ignoredHost = new SceneDemandPresentationHost { SupportsSelfRenderStream = supported };
            await using var ignoredServer = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(root.Path), new CapturingAssetAdapter(), ignoredRuntime.NewEnvelopeFactory(),
                preferredPort: 0, isHeadlessClient: false, hostBrowserAccess: new TestHostBrowserAccess(), rendererSwapHost: ignoredHost);
            var ignoredUri = await ignoredServer.StartAsync();
            using var ignoredSocket = new ClientWebSocket();
            await ignoredSocket.ConnectAsync(new UriBuilder(ignoredUri)
            {
                Scheme = "ws", Path = "/ws", Query = StreamingQuery.Replace("watch=1", "watch=0"),
            }.Uri, CancellationToken.None);
            using (var initial = await ReadSessionAsync(ignoredSocket)) { }
            await SendControlAsync(ignoredSocket, "{\"type\":\"watch\",\"on\":true,\"renderer\":\"stream\",\"rendererProtocol\":" + protocol + "}");
            await Barrier(ignoredSocket, "ignored-hint");
            Check(ignoredRuntime.SceneSubscriptionActive && ignoredHost.Requests == 0,
                "unsupported capture or malformed/old protocol hints retain ordinary mirror watch behavior");
            await CloseWebSocketSilentlyAsync(ignoredSocket);
        }
        Console.WriteLine($"host render scene demand: {checks} checks passed.");
    }

    private sealed class SceneDemandPresentationHost : IHotRendererSwapHost, IHotPresentationHost, IHotSelfRenderStreamHost
    {
        private readonly ConcurrentDictionary<string, (string Owner, bool Watch, bool Stream)> _pages = new();
        private event Action? Changed;
        private bool _armed;
        internal int Requests;
        public bool SupportsSelfRenderStream { get; init; } = true;
        public (long Epoch, bool Ready, int Width, int Height) PresentationStatus => (7, true, 1920, 1080);
        public (string State, string? Reason, (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => _armed ? ("armed", null, ("127.0.0.1:13366", "test", "test", "1920x1080", StreamingSeatLaunch.StreamVersion))
                : (_pages.Values.Any(page => page.Stream) ? "arming" : "mirror", null, null);
        public bool WantsRenderStream(string pageId) => _pages.TryGetValue(pageId, out var page) && page.Stream;
        public void RequestRenderer(string pageId, bool stream, double? aspect) => throw new NotSupportedException();
        public void ReleaseRenderer(string pageId) => _pages.TryRemove(pageId, out _);
        public void ClaimPresentationPage(string pageId, string owner) => _pages[pageId] = (owner, false, false);
        public void UpdatePresentationPage(string pageId, string owner, bool watch, bool? stream, double? aspect)
        {
            if (!_pages.TryGetValue(pageId, out var prior) || prior.Owner != owner) return;
            _pages[pageId] = (owner, watch, stream ?? prior.Stream);
            if (stream is not null) Requests++;
            Changed?.Invoke();
        }
        public void ReleasePresentationPage(string pageId, string owner)
        {
            if (IsPresentationPageOwner(pageId, owner)) _pages.TryRemove(pageId, out _);
        }
        public bool IsPresentationPageOwner(string pageId, string owner) => _pages.TryGetValue(pageId, out var page) && page.Owner == owner;
        public IDisposable SubscribeRendererChanged(Action handler)
        {
            Changed += handler;
            return new CallbackDisposable(() => Changed -= handler);
        }
        internal void Arm() { _armed = true; Changed?.Invoke(); }
    }
}
