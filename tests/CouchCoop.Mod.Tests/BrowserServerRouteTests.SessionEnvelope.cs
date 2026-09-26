using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Embedding;

// The session envelope's read path (WP3 path 3), over the real browser server and a real WebSocket.
//
// What must hold, and where it is pinned:
//   * an envelope is built from ONE roster read (the roster and the lobby cap in a single hop to the game's main thread)
//     and never from a full state snapshot: connect, the join reply and `watch` each cost one read and zero snapshots;
//   * the seat table is sized from the cap that read carried: the manager's own cap probe, which used to be a second hop
//     per envelope through DescribeSeats, is never asked;
//   * a fan-out (a roster change, a screen change, a static-background change) reads ONCE for every connection, and reads
//     nothing at all when there is no connection;
//   * an unreadable roster is "unavailable" (an unsupported screen, and the notice that says so), never "nobody is here";
//   * the controls: the same counters DO move when a snapshot is pulled or a read is repeated, so a zero means something.
//
// The game is the seam that stands where it would be: a fake IGameFacts behind the real CouchCoopGameFacts front, and a
// main-thread stand-in that is a real thread, so a hop is a real marshal and is counted only when the caller is not
// already on it.
internal sealed partial class BrowserServerRouteTests
{
    internal static async Task RunSessionEnvelopeReadRoutesAsync()
    {
        using var root = new TempStaticRoot();
        await AssertEachEnvelopeIsOneRosterReadAndNoSnapshotAsync(root.Path);
        await AssertFanOutsShareOneReadAsync(root.Path);
        await AssertAJoinReplyReadsNoSnapshotAsync(root.Path);
        await AssertAnUnreadableRosterIsUnavailableNotEmptyAsync(root.Path);
        Console.WriteLine("session envelope reads: ok");
    }

    private const string GatedQuery = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";
    private const string StaticBgQuery = "watch=0&staticBg=1&cardFlight=1&handTween=1&trailDrive=0";
    private const string StreamingQuery = "watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";

    // A main thread that is a real thread: a call from anywhere else is one counted hop, a call from it runs inline.
    private sealed class HopCountingMainThread : IGameMainThread, IDisposable
    {
        private readonly BlockingCollection<Action> _queue = new();
        private readonly Thread _thread;
        private int _hops;

        public HopCountingMainThread()
        {
            _thread = new Thread(() =>
            {
                foreach (var work in _queue.GetConsumingEnumerable())
                {
                    work();
                }
            })
            { IsBackground = true, Name = "test-game-main" };
            _thread.Start();
        }

        public int Hops => Volatile.Read(ref _hops);

        public T Invoke<T>(Func<T> action)
        {
            if (Thread.CurrentThread == _thread)
            {
                return action();
            }

            Interlocked.Increment(ref _hops);
            var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(() =>
            {
                try { done.SetResult(action()); }
                catch (Exception exception) { done.SetException(exception); }
            });
            return done.Task.GetAwaiter().GetResult();
        }

        public Task<T> InvokeAsync<T>(Func<Task<T>> action)
        {
            if (Thread.CurrentThread == _thread)
            {
                return action();
            }

            Interlocked.Increment(ref _hops);
            var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            _queue.Add(async () =>
            {
                try { done.SetResult(await action().ConfigureAwait(false)); }
                catch (Exception exception) { done.SetException(exception); }
            });
            return done.Task;
        }

        public void Dispose() => _queue.CompleteAdding();
    }

    // One server over one fake game: the roster and cap it reports are settable, every read and hop is counted, and the
    // seat manager's own cap probe is counted too, because it is the second pull an envelope used to hide.
    private sealed class SessionReadRig : IAsyncDisposable
    {
        private readonly IGameMainThread _previousMainThread;
        private readonly IGameFacts _previousFacts;
        private int _capProbes;

        private SessionReadRig(string rootPath, bool headlessClient)
        {
            Runtime = new RecordingSpirectlRuntime();
            Host = new CouchCoopRuntimeHost(new CouchCoopRuntimeDependencies(Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime, Runtime));
            MainThread = new HopCountingMainThread();
            _previousMainThread = GameMainThread.Source;
            _previousFacts = CouchCoopGameFacts.Source;
            ZeroClientGuard.ResetForTests(armed: false);
            GameMainThread.Source = MainThread;
            CouchCoopGameFacts.Source = Facts;
            Manager = headlessClient
                ? null
                : new HeadlessClientManager(
                    launcher: _ => null,
                    readinessProbe: (_, _) => Task.FromResult(true),
                    maxSeatsProbe: () =>
                    {
                        Interlocked.Increment(ref _capProbes);
                        return 3;
                    });
            Server = new CouchCoopBrowserServer(
                new StaticSpaFileProvider(rootPath),
                new CapturingAssetAdapter(),
                new BrowserStateEnvelopeFactory(Host),
                headlessManager: Manager,
                isHeadlessClient: headlessClient,
                preferredPort: ReserveEphemeralPort(),
                subscribeRoster: Feed.Subscribe);
        }

        public RecordingSpirectlRuntime Runtime { get; }
        public CouchCoopRuntimeHost Host { get; }
        public HopCountingMainThread MainThread { get; }
        public CouchCoopGameFactsTests.FakeFacts Facts { get; } = new();
        public CouchCoopRosterObserverTests.FakeRosterFeed Feed { get; } = new();
        public HeadlessClientManager? Manager { get; }
        public CouchCoopBrowserServer Server { get; }
        public Uri BaseUri { get; private set; } = null!;

        /// <summary>
        /// What the fake game reports as the lobby's cap. Read the way the production reader reads it: through the main
        /// thread (inline when the caller is already on it), so a cap read from a listener thread is a hop and a cap read
        /// inside the session read is not.
        /// </summary>
        public void SetCap(int? cap) => Facts.CapRead = () => MainThread.Invoke(() => cap);

        /// <summary>How many times the seat manager was asked the live lobby's cap through its own probe.</summary>
        public int CapProbes => Volatile.Read(ref _capProbes);

        public static async Task<SessionReadRig> StartAsync(string rootPath, bool headlessClient = false)
        {
            var rig = new SessionReadRig(rootPath, headlessClient);
            rig.BaseUri = await rig.Server.StartAsync();
            return rig;
        }

        /// <summary>The counters an assertion measures a step by.</summary>
        public (int Rosters, int Caps, int Hops, int Probes) Mark()
            => (Facts.RosterReads, Facts.CapReads, MainThread.Hops, CapProbes);

        public (int Rosters, int Caps, int Hops, int Probes) Since((int Rosters, int Caps, int Hops, int Probes) mark)
        {
            var now = Mark();
            return (now.Rosters - mark.Rosters, now.Caps - mark.Caps, now.Hops - mark.Hops, now.Probes - mark.Probes);
        }

        public async Task<ClientWebSocket> ConnectAsync(string query, bool readSession = true)
        {
            var socket = new ClientWebSocket();
            await socket.ConnectAsync(new UriBuilder(BaseUri) { Scheme = "ws", Path = "/ws", Query = query }.Uri, CancellationToken.None);
            if (readSession)
            {
                _ = await ReadNextWsMessageOfTypeAsync(socket, "session");
            }

            return socket;
        }

        public async ValueTask DisposeAsync()
        {
            try { await Server.StopAsync(); } catch { }
            await Server.DisposeAsync();
            Manager?.Dispose();
            CouchCoopGameFacts.Source = _previousFacts;
            GameMainThread.Source = _previousMainThread;
            ZeroClientGuard.ResetForTests();
            MainThread.Dispose();
        }
    }

    // The roster of a run in progress: the host, a seat inside a stock four-player lobby's range (1002) and one outside it
    // (1005). Nobody runs a headless process for either, so mid-run both are OFFLINE seats: unless the seat table is too
    // short to describe the seat, in which case it keeps the default status. That difference is how the cap shows on the wire.
    private static RosterFacts RunWithSeatsAtTheEdgeOfTheCap()
        => new(
            RosterRootScenes.Run,
            null,
            new RosterRun(
                NetTypeNames.Host,
                "p:1",
                [
                    new RosterRunSeat("p:1", "Host", "IRONCLAD", true, true),
                    new RosterRunSeat("p:1002", "Ann", "SILENT", false, true),
                    new RosterRunSeat("p:1005", "Eve", "DEFECT", false, true),
                ]));

    private static string? SeatStatusOn(string sessionJson, string playerId)
    {
        using var document = JsonDocument.Parse(sessionJson);
        foreach (var player in document.RootElement.GetProperty("players").EnumerateArray())
        {
            if (player.GetProperty("playerId").GetString() == playerId)
            {
                return player.TryGetProperty("seatStatus", out var status) ? status.GetString() : null;
            }
        }

        return null;
    }

    // ---- one envelope: one roster read, no snapshot, no second pull ---------------------------------------------------

    private static async Task AssertEachEnvelopeIsOneRosterReadAndNoSnapshotAsync(string rootPath)
    {
        await using var rig = await SessionReadRig.StartAsync(rootPath);
        rig.Facts.RosterRead = RunWithSeatsAtTheEdgeOfTheCap;
        rig.SetCap(4);

        // Controls: the typed read and the seat manager's cap probe each move their own counters.
        var control = rig.Mark();
        _ = new CouchCoopLobbyParticipation(rig.Host).DescribeMirrorJoinContext();
        Expect(rig.Since(control).Rosters == 1, "a direct join-context read moves the roster counter");
        _ = rig.Manager!.DescribeSeats();
        Expect(rig.Since(control).Probes == 1, "control: describing the seats by the manager's own probe is a second cap read");
        var readControl = rig.Mark();
        _ = CouchCoopGameFacts.ReadSessionFacts(withLobbyCap: true);
        Expect(rig.Since(readControl) is { Rosters: 1, Caps: 1, Hops: 1 }, "control: a session read is one roster, one cap, one hop");

        // CONNECT. The envelope is one roster read and one cap read in ONE hop, no snapshot, and the manager's probe is not
        // asked. The upgrade itself asks the lobby's cap once more for browser admission (WP3 path 5: live, per upgrade,
        // from the listener thread), which is the second hop and the second cap read of a connect and is not the envelope's.
        var before = rig.Mark();
        using var gated = await rig.ConnectAsync(GatedQuery, readSession: false);
        var connectSession = await ReadNextWsMessageOfTypeAsync(gated, "session");
        var connect = rig.Since(before);
        Expect(connect is { Rosters: 1, Caps: 2, Hops: 2, Probes: 0 },
            $"connect is one session read plus the upgrade's admission read (rosters {connect.Rosters}, caps {connect.Caps}, hops {connect.Hops}, probes {connect.Probes})");
        using (var document = JsonDocument.Parse(connectSession))
        {
            Expect(document.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "run",
                "the connect session reports the screen the fake game reports");
        }

        // THE CAP RODE THE READ. A four-player lobby has room for three couch seats (1002..1004): 1002 is described and,
        // with no process behind it mid-run, is offline, while 1005 is beyond the table and keeps the default status.
        Expect(SeatStatusOn(connectSession, "p:1002") == MirrorSeatStatuses.Offline, "a seat inside the cap is described");
        Expect(SeatStatusOn(connectSession, "p:1005") == MirrorSeatStatuses.Ready, "a seat beyond the cap is not");
        rig.SetCap(7);
        var raised = rig.Mark();
        using var second = await rig.ConnectAsync(GatedQuery, readSession: false);
        var raisedSession = await ReadNextWsMessageOfTypeAsync(second, "session");
        Expect(rig.Since(raised) is { Rosters: 1, Caps: 2, Hops: 2, Probes: 0 }, "the next connect costs the same again");
        Expect(SeatStatusOn(raisedSession, "p:1005") == MirrorSeatStatuses.Offline,
            "a cap that has since been raised reaches the seat table on the next envelope, live, with no cache in between");

        // WATCH. The reply to `{"type":"watch","on":true}` is an envelope like any other.
        var watchMark = rig.Mark();
        await second.SendAsync(
            Encoding.UTF8.GetBytes("{\"type\":\"watch\",\"on\":true}"),
            WebSocketMessageType.Text,
            WebSocketMessageFlags.EndOfMessage,
            CancellationToken.None);
        var watchSession = await ReadNextWsMessageOfTypeAsync(second, "session");
        using (var document = JsonDocument.Parse(watchSession))
        {
            Expect(document.RootElement.TryGetProperty("directView", out var directView) && directView.GetBoolean(),
                "the watch reply is the direct-view envelope");
        }

        var watch = rig.Since(watchMark);
        Expect(watch is { Rosters: 1, Caps: 1, Hops: 1, Probes: 0 },
            $"watch is one session read in one hop (rosters {watch.Rosters}, hops {watch.Hops})");

        await CloseWebSocketSilentlyAsync(second);
        await CloseWebSocketSilentlyAsync(gated);
    }

    // ---- a fan-out: one read for every connection --------------------------------------------------------------------

    private static async Task AssertFanOutsShareOneReadAsync(string rootPath)
    {
        await using var rig = await SessionReadRig.StartAsync(rootPath);
        rig.Facts.RosterRead = () => CouchCoopRosterObserverTests.Roster(2);
        rig.SetCap(8);

        // N gated viewers, and one that streams (its scene stream is what reports a screen change).
        const int viewers = 4;
        var sockets = new List<ClientWebSocket>();
        var connect = rig.Mark();
        for (var i = 0; i < viewers; i++)
        {
            sockets.Add(await rig.ConnectAsync(i == 0 ? StaticBgQuery : GatedQuery));
        }

        var streaming = await rig.ConnectAsync(StreamingQuery);
        sockets.Add(streaming);
        var connected = rig.Since(connect);
        Expect(connected.Rosters == viewers + 1 && connected.Hops == 2 * (viewers + 1) && connected.Probes == 0,
            $"control: {viewers + 1} connections cost {viewers + 1} session reads, one each, beside each upgrade's admission read (got {connected.Rosters} reads, {connected.Hops} hops)");
        Expect(await WaitForAsync(() => rig.Feed.Active), "the parked viewers started the roster observer");
        Expect(await WaitForSceneSubscriptionAsync(rig.Runtime, active: true), "the streaming viewer started the scene observer");

        // A ROSTER CHANGE. The observer's own read is not the server's (the feed is the seam standing where the observer's
        // read would be), so what is counted here is what the fan-out reads to build the sessions.
        var roster = rig.Mark();
        rig.Feed.Push(CouchCoopRosterObserverTests.Roster(3));
        foreach (var socket in sockets)
        {
            _ = await ReadNextWsMessageOfTypeAsync(socket, "session");
        }

        var rosterChange = rig.Since(roster);
        Expect(rosterChange is { Rosters: 1, Caps: 1, Hops: 1, Probes: 0 },
            $"a roster change re-sends {sockets.Count} sessions from ONE read (rosters {rosterChange.Rosters}, caps {rosterChange.Caps}, hops {rosterChange.Hops}, probes {rosterChange.Probes})");
        foreach (var socket in sockets)
        {
            Expect(await SessionsUntilPongAsync(socket, settleMs: 0) == 0, "and each connection got exactly that one session");
        }

        // A SCREEN CHANGE, reported by the scene stream: the first delta is the baseline, the second changes screen.
        runtimePush(rig.Runtime, "instance-1");
        await Task.Delay(150);
        var screen = rig.Mark();
        runtimePush(rig.Runtime, "instance-2");
        foreach (var socket in sockets)
        {
            _ = await ReadNextWsMessageOfTypeAsync(socket, "session");
        }

        var screenChange = rig.Since(screen);
        Expect(screenChange is { Rosters: 1, Caps: 1, Hops: 1, Probes: 0 },
            $"a screen change re-sends {sockets.Count} sessions from ONE read (rosters {screenChange.Rosters}, hops {screenChange.Hops}, probes {screenChange.Probes})");

        // A STATIC-BACKGROUND CHANGE, published by the tracker the first viewer's still created.
        var tracker = server(rig).StaticBgTrackerForTest;
        Expect(tracker is not null, "the viewer that shows a still created the static-background tracker");
        var background = rig.Mark();
        tracker!.PublishForTest(new CouchCoopStaticBackgroundState(
            "res://scenes/backgrounds/test/test_background.tscn", [], null, "/bg/test?d=1"));
        foreach (var socket in sockets)
        {
            _ = await ReadNextWsMessageOfTypeAsync(socket, "session");
        }

        var backgroundChange = rig.Since(background);
        Expect(backgroundChange is { Rosters: 1, Caps: 1, Hops: 1, Probes: 0 },
            $"a static-background change re-sends {sockets.Count} sessions from ONE read (rosters {backgroundChange.Rosters}, hops {backgroundChange.Hops}, probes {backgroundChange.Probes})");

        // NOBODY CONNECTED reads nothing: there is no envelope to build, so there is no game to ask.
        foreach (var socket in sockets)
        {
            await CloseWebSocketSilentlyAsync(socket);
            socket.Dispose();
        }

        Expect(await WaitForAsync(() => !rig.Feed.Active), "every gated viewer left, so the roster observer stopped");
        Expect(await WaitForSceneSubscriptionAsync(rig.Runtime, active: false), "and so did the streaming one, so the scene observer stopped");
        var idle = rig.Mark();
        rig.Server.ResendSessions();
        tracker.PublishForTest(new CouchCoopStaticBackgroundState(
            "res://scenes/backgrounds/test/test_background_two.tscn", [], null, "/bg/test-two?d=1"));
        Expect(rig.Since(idle) is { Rosters: 0, Caps: 0, Hops: 0 },
            "with no connection a fan-out reads nothing at all");

        static CouchCoopBrowserServer server(SessionReadRig r) => r.Server;
        static void runtimePush(RecordingSpirectlRuntime runtime, string instance)
            => runtime.PushSceneDelta(BuildSampleSceneDelta() with { ScreenInstanceId = instance });
    }

    // ---- the join reply ---------------------------------------------------------------------------------------------

    // A viewer joining a process that owns no seat manager (a headless seat, or a host that could not resolve its exe) is
    // answered with a direct-view envelope. Its whole cost is that envelope's read: no snapshot, and no cap, because a
    // process with no seats has nothing to size.
    private static async Task AssertAJoinReplyReadsNoSnapshotAsync(string rootPath)
    {
        await using var rig = await SessionReadRig.StartAsync(rootPath, headlessClient: true);
        rig.Facts.RosterRead = () => CouchCoopRosterObserverTests.InRun();
        rig.SetCap(8);

        var connect = rig.Mark();
        using var socket = await rig.ConnectAsync(GatedQuery, readSession: false);
        _ = await ReadNextWsMessageOfTypeAsync(socket, "session");
        Expect(rig.Since(connect) is { Rosters: 1, Caps: 1 },
            "a process with no seat table reads no cap for its envelope (the one cap read of the connect is the upgrade's admission)");

        var before = rig.Mark();
        await socket.SendAsync(
            Encoding.UTF8.GetBytes("{\"type\":\"join\",\"name\":\"Alice\",\"requestId\":\"join-1\"}"),
            WebSocketMessageType.Text,
            WebSocketMessageFlags.EndOfMessage,
            CancellationToken.None);
        var reply = await ReadNextWsMessageOfTypeAsync(socket, "session");
        using (var document = JsonDocument.Parse(reply))
        {
            Expect(document.RootElement.TryGetProperty("directView", out var directView) && directView.GetBoolean(),
                "the join is answered with a direct-view envelope");
        }

        var join = rig.Since(before);
        Expect(join is { Rosters: 1, Caps: 0, Hops: 1 },
            $"the join reply is one roster read in one hop (rosters {join.Rosters}, caps {join.Caps}, hops {join.Hops})");
        await CloseWebSocketSilentlyAsync(socket);
    }

    // ---- unavailable is not empty ---------------------------------------------------------------------------------

    // An unreadable roster (null, or a read that throws) is the retired unreadable-state answer: an unsupported screen with
    // nobody on it and the notice that says the state is unavailable. It is never "nobody is here" on a real screen, and
    // it never fails the envelope: the join screen is the only way back in, so it has to render.
    private static async Task AssertAnUnreadableRosterIsUnavailableNotEmptyAsync(string rootPath)
    {
        await using var rig = await SessionReadRig.StartAsync(rootPath);
        rig.SetCap(4);

        foreach (var (label, read) in new (string, Func<RosterFacts?>)[]
                 {
                     ("a null roster", () => null),
                     ("a read that throws", () => throw new InvalidOperationException("the game moved")),
                 })
        {
            rig.Facts.RosterRead = read;
            using var socket = await rig.ConnectAsync(GatedQuery, readSession: false);
            var session = await ReadNextWsMessageOfTypeAsync(socket, "session");
            using var document = JsonDocument.Parse(session);
            var screen = document.RootElement.GetProperty("screen");
            Expect(screen.GetProperty("kind").GetString() == "unsupported" && screen.GetProperty("mirrorMode").GetString() == "main-menu",
                $"{label} is an unsupported screen in the main-menu mirror mode");
            Expect(document.RootElement.GetProperty("players").GetArrayLength() == 0, $"{label} lists nobody, because it does not know");
            Expect(document.RootElement.GetProperty("notices").EnumerateArray().Any(notice =>
                    notice.GetProperty("capabilityId").GetString() == CouchCoopRuntimeHost.StateCapability
                    && !notice.GetProperty("supported").GetBoolean()
                    && notice.GetProperty("unsupportedReason").GetString() == "Runtime state is unavailable."),
                $"{label} says the runtime state is unavailable, as a failed snapshot did");
            await CloseWebSocketSilentlyAsync(socket);
        }

        // A roster that reads fine after a failed one is simply the game again: nothing is latched.
        rig.Facts.RosterRead = () => CouchCoopRosterObserverTests.Roster(2);
        using var recovered = await rig.ConnectAsync(GatedQuery, readSession: false);
        using (var document = JsonDocument.Parse(await ReadNextWsMessageOfTypeAsync(recovered, "session")))
        {
            Expect(document.RootElement.GetProperty("screen").GetProperty("kind").GetString() == "lobby", "the next read recovers");
        }

        await CloseWebSocketSilentlyAsync(recovered);
    }
}
