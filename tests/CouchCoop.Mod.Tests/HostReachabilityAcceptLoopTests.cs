using System.Net;
using System.Net.Sockets;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.Artifacts;
using Spirectl.Sts2.Core.Protocol;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Tests;

// The guard the two working call sites never had.
//
// HostReachabilityWatch is fed by NoteInboundConnection() from an accept loop, and there are THREE accept
// loops in this repo: CouchCoopBrowserServer's (the standalone/test path a shipped host never runs),
// SecureBrowserListener's, and HotReloadableBrowserServerHost's — which is the listener a real host owns
// (CouchCoopHostUiServices builds it). The third one was added without the call, so on a shipped host every
// plain-HTTP arrival was invisible to the watch and the 90-second "no phone or browser has connected to this
// PC yet" row fired behind a phone that had already been here. Measured live, twice.
//
// HostReachabilityWatchTests covers the watch's own decisions with a fake clock and no sockets. This suite
// covers the wiring instead, and it can only do that from OUTSIDE: start the host a player actually gets,
// open one raw TCP connection to the port it bound, and read the process-wide latch. Nothing here asserts on
// the accept loop's source, because the bug was that reading the source is exactly what nobody did.
internal static class HostReachabilityAcceptLoopTests
{
    public static async Task RunAsync()
    {
        await ARawConnectionToTheHotReloadableHostIsSeenByTheWatchAsync();
        Console.WriteLine("HostReachabilityAcceptLoopTests: ok");
    }

    private static async Task ARawConnectionToTheHotReloadableHostIsSeenByTheWatchAsync()
    {
        // Process-wide latch: reset going in so an earlier suite's socket cannot pass this, and reset going
        // out so this one's cannot silence a later suite's watch.
        HostReachabilityWatch.Shared.ResetForTests();
        try
        {
            Expect(!HostReachabilityWatch.Shared.SawInboundConnection,
                "the latch starts clear, so what it reads below is this test's own connection");

            using var root = new TempSpaRoot();
            // The host's built-in generation builds a SpirectlAssetBinaryCache, whose default root resolution
            // calls Godot.ProjectSettings.GlobalizePath — and GodotSharp.dll is copied next to this runner, so
            // the managed call binds and then dies in native interop (SIGSEGV; the try/catch around it only
            // covers a runner where GodotSharp fails to LOAD). COUCHCOOP_CACHE_ROOT short-circuits that
            // resolution before the engine is touched, which is what every harness and bench uses it for.
            using var cacheRoot = new ScopedCacheRoot(root.Path);
            var runtime = new StubRuntimeSource();
            await using var host = new HotReloadableBrowserServerHost(
                new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(
                    runtime, runtime, runtime, null!, null!, null!, null!, null!, null!, null!),
                    _ => { }),
                root.Path,
                IPAddress.Loopback,
                preferredPort: 0,
                log: _ => { });

            var baseUri = await host.StartAsync();

            // Raw TCP, not an HTTP request: the claim is that reaching accept() is enough, which is what makes
            // the watch able to see a connection our own admission limiter would turn away.
            using (var probe = new TcpClient())
            {
                await probe.ConnectAsync(IPAddress.Loopback, baseUri.Port).WaitAsync(TimeSpan.FromSeconds(5));
                Expect(probe.Connected, "the raw probe reached the host's listener");

                // The accept loop runs on its own task, so the latch is set shortly after connect() returns
                // rather than synchronously with it.
                var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
                while (!HostReachabilityWatch.Shared.SawInboundConnection && DateTime.UtcNow < deadline)
                {
                    await Task.Delay(10);
                }
            }

            Expect(HostReachabilityWatch.Shared.SawInboundConnection,
                "the listener a real host runs reports its inbound connections to HostReachabilityWatch");
        }
        finally
        {
            HostReachabilityWatch.Shared.ResetForTests();
        }
    }

    private sealed class ScopedCacheRoot : IDisposable
    {
        private readonly string? _previous;

        public ScopedCacheRoot(string path)
        {
            _previous = Environment.GetEnvironmentVariable(CouchCoopCacheRoot.RootEnvironmentVariable);
            Environment.SetEnvironmentVariable(
                CouchCoopCacheRoot.RootEnvironmentVariable, System.IO.Path.Combine(path, "cache"));
        }

        public void Dispose()
            => Environment.SetEnvironmentVariable(CouchCoopCacheRoot.RootEnvironmentVariable, _previous);
    }

    private sealed class TempSpaRoot : IDisposable
    {
        public TempSpaRoot()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "couchcoop-reachability-" + Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(Path);
            File.WriteAllText(System.IO.Path.Combine(Path, "index.html"), "<!doctype html><title>spa-index</title>");
        }

        public string Path { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch
            {
            }
        }
    }

    // The smallest runtime the host will construct against: capabilities (its hosting tracker asks for the
    // state one), an asset provider, and a state subscription that never emits. Nothing in this test drives
    // gameplay, so everything else stays unimplemented rather than faked.
    private sealed class StubRuntimeSource
        : IRuntimeCapabilitySource, IRuntimeAssetSource, IRuntimeStateSource, ISpirectlAssetProvider
    {
        public ISpirectlAssetProvider Assets => this;

        public EmbeddableRuntimeCapabilities GetCapabilities() => new(
            "test", "test-game", "test-mod", "embedded", RuntimeAttachmentState.Attached, DataSourceKind.Stub, false,
            [new(CouchCoopRuntimeHost.StateCapability, "state", true, false, null)], []);

        public EmbeddableAssetResult GetAsset(EmbeddableAssetRequest request) => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetAssets(EmbeddableAssetBatchRequest request) => throw new NotSupportedException();

        public EmbeddableAssetBatchResult GetPresentationAssets(PresentationAssetBatchRequest request)
            => throw new NotSupportedException();

        public CurrentStateResult GetCurrentState(CurrentStateRequest request) => throw new NotSupportedException();

        public IDisposable SubscribeCurrentState(
            CurrentStateSubscriptionRequest request,
            Action<CurrentStateWatchEvent> onEvent,
            Action<EmbeddableRuntimeError>? onError = null) => new NoSubscription();

        public IAsyncEnumerable<CurrentStateWatchEvent> WatchCurrentStateAsync(
            CurrentStateSubscriptionRequest request,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        private sealed class NoSubscription : IDisposable
        {
            public void Dispose()
            {
            }
        }
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
}
