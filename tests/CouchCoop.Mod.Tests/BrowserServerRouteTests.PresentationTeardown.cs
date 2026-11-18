using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Reflection;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;

internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunPresentationTeardownAsync()
    {
        var assertions = 0;
        void Check(bool condition, string message) { Expect(condition, message); assertions++; }
        var previous = GameMainThread.Source;
        using var main = new HopCountingMainThread();
        GameMainThread.Source = main;
        try
        {
            foreach (var queuedReplacement in new[] { false, true })
            {
                using var root = new TempStaticRoot();
                var runtime = new RecordingSpirectlRuntime();
                var host = new TeardownPresentationHost();
                await using var server = new CouchCoopBrowserServer(new StaticSpaFileProvider(root.Path),
                    new CapturingAssetAdapter(), runtime.NewEnvelopeFactory(), preferredPort: 0,
                    isHeadlessClient: true, rendererSwapHost: host);
                var uri = await server.StartAsync();
                var connections = (ConcurrentDictionary<Guid, CouchCoopWebSocketConnection>)typeof(CouchCoopBrowserServer)
                    .GetField("_connections", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(server)!;
                var socketUri = new UriBuilder(uri) { Scheme = "ws", Path = "/ws",
                    Query = StaticBgQuery + "&rendererPage=" + new string('a', 32) }.Uri;
                using var old = new ClientWebSocket();
                using var replacement = new ClientWebSocket();
                await old.ConnectAsync(socketUri, CancellationToken.None);
                _ = await ReadWsMessageAsync(old);
                Check(connections.Count == 1, "initial socket owns the stable page");
                if (queuedReplacement)
                {
                    using var entered = new ManualResetEventSlim();
                    using var release = new ManualResetEventSlim();
                    var blocked = Task.Run(() => main.Invoke(() => { entered.Set(); release.Wait(); return true; }));
                    try
                    {
                        Check(entered.Wait(TimeSpan.FromSeconds(5)), "test holds the game thread before replacement and teardown");
                        var hops = main.Hops;
                        await replacement.ConnectAsync(socketUri, CancellationToken.None);
                        Check(await WaitForAsync(() => main.Hops > hops), "replacement claim queues first on the game thread");
                        hops = main.Hops;
                        await CloseWebSocketSilentlyAsync(old);
                        Check(await WaitForAsync(() => main.Hops > hops), "current owner's teardown queues before replacement claim executes");
                        Check(connections.Count == 1 && runtime.InputCancellations == 0,
                            "ownership and held input remain unchanged while game-thread operations wait");
                    }
                    finally { release.Set(); await blocked; }
                    _ = await ReadWsMessageAsync(replacement);
                }
                else
                {
                    await replacement.ConnectAsync(socketUri, CancellationToken.None);
                    _ = await ReadWsMessageAsync(replacement);
                    await SendAccessJsonAsync(replacement,
                        "{\"type\":\"input\",\"requestId\":\"replacement-held\",\"kind\":\"key\",\"key\":\"KeyA\",\"pressed\":true}");
                    _ = await ReadCorrelatedReplyAsync(replacement, "replacement-held");
                    Check(runtime.LastActionRequest?.RequestId == "replacement-held", "replacement holds input before stale socket closes");
                    await CloseWebSocketSilentlyAsync(old);
                }
                Check(await WaitForAsync(() => connections.Count == 1 && host.Releases == 1), "stale socket completes teardown");
                Check(runtime.InputCancellations == 0, "retired owner cannot cancel replacement input, including after a queued claim");
                Check(host.Owner is not null, "stale release leaves the replacement lease intact");
                await SendAccessJsonAsync(replacement,
                    "{\"type\":\"input\",\"requestId\":\"active-held\",\"kind\":\"key\",\"key\":\"KeyB\",\"pressed\":true}");
                _ = await ReadCorrelatedReplyAsync(replacement, "active-held");
                Check(runtime.LastActionRequest?.RequestId == "active-held", "replacement controls remain usable");
                await CloseWebSocketSilentlyAsync(replacement);
                Check(await WaitForAsync(() => connections.IsEmpty), "active owner finishes teardown");
                Check(runtime.InputCancellations == 1 && host.Owner is null && host.Releases == 2,
                    "active owner's disconnect still cancels held input and releases its lease");
            }
        }
        finally { GameMainThread.Source = previous; }
        Console.WriteLine($"Presentation teardown: {assertions} assertions passed (stale, active and queued replacement closes).");
    }

    private sealed class TeardownPresentationHost : IHotRendererSwapHost, IHotPresentationHost
    {
        internal string? Owner;
        internal int Releases;
        public (long Epoch, bool Ready, int Width, int Height) PresentationStatus => (0, true, 1920, 1080);
        public (string State, string? Reason, (string Listen, string Token, string CertificateHash, string RootSize, int StreamVersion)? Snapshot) RendererStatus
            => ("armed", null, ("127.0.0.1:13366", "test", "test", "1920x1080", 16));
        public bool WantsRenderStream(string pageId) => true;
        public void RequestRenderer(string pageId, bool stream, double? aspect) { }
        public void ReleaseRenderer(string pageId) { }
        public IDisposable SubscribeRendererChanged(Action handler) => new NoopCancellation();
        public void ClaimPresentationPage(string pageId, string owner)
            => GameMainThread.Invoke(() => { Owner = owner; return true; });
        public bool IsPresentationPageOwner(string pageId, string owner) => Owner == owner;
        public void UpdatePresentationPage(string pageId, string owner, bool watch, bool? stream, double? aspect) { }
        public void ReleasePresentationPage(string pageId, string owner)
            => GameMainThread.Invoke(() =>
            {
                if (Owner == owner) Owner = null;
                Interlocked.Increment(ref Releases);
                return true;
            });
    }
}
