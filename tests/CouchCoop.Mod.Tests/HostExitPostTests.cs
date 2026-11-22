using CouchCoop.Mod;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using System.Diagnostics;
using Spirectl.Sts2.Live;

internal static class HostExitPostTests
{
    private static int _assertions;

    internal static async Task RunAsync()
    {
        await NestedDispatchAsync();
        foreach (var entry in new[] { "enqueue-race", "capture-enqueue-race", "quit-enqueue-race", "manager", "window-close", "headless-disarm", "pending-dispatch", "socket-close" })
        {
            await RunInFreshProcessAsync(entry);
            Assert(!CouchCoopMod.HostExiting, entry + " child leaves parent admission open");
        }
        var logs = new List<string>();
        var gate = new HostExitGate(logs.Add);
        var posts = new Queue<Action>();
        Assert(gate.TryEnqueue(() => posts.Enqueue(() => { })), "work admitted before exit");
        gate.BeginExit();
        gate.BeginExit();
        for (var i = 0; i < 3; i++) Assert(!gate.TryEnqueue(() => throw new Exception("late post")), "late work dropped");
        Assert(gate.Dropped == 3 && logs.Count == 1 && logs[0].Contains("count=1"), "drops counted with one log line");
        Assert(gate.TryEnqueue(() => posts.Enqueue(() => { }), quitReplay: true) && posts.Count == 2,
            "only explicit quit replay can post after exit");

        // Only dispatcher callbacks may remain in flight when exit returns; queue insertions may not.
        var active = new HostExitGate(_ => { });
        Assert(active.TryPost(() =>
        {
            Assert(active.InFlight == 1, "admitted dispatch counted while callback runs");
            Task.Run(active.BeginExit).WaitAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult();
            Assert(active.IsExiting, "exit seals admission without waiting for in-flight dispatcher callbacks");
            Assert(!active.TryPost(() => { }), "nested new admission rejected after exit");
        }), "already admitted dispatch completes");
        Assert(active.InFlight == 0, "in-flight count released after dispatch");
        var throwing = new HostExitGate(_ => { });
        try { throwing.TryPost(() => throw new IOException("dispatch failed")); }
        catch (IOException) { }
        Assert(throwing.InFlight == 0, "in-flight count released after a failed dispatch");

        var termGate = new HostExitGate(_ => { });
        var quit = 0;
        var term = new HostTermQuitSequence(
            action => { Assert(termGate.IsExiting, "TERM latches before posting quit"); termGate.TryEnqueue(() => posts.Enqueue(action), quitReplay: true); },
            () => quit++, schedule: (_, _) => { }, log: _ => { }, beginExit: termGate.BeginExit);
        posts.Clear();
        Assert(term.TryStart(), "TERM accepted");
        posts.Dequeue()();
        Assert(quit == 1, "TERM quit replay runs");

        await BrowserServerRouteTests.RunHostExitMessagesAsync();
        Assert(CouchCoopMod.HostExiting, "quit prefix latches process exit");
        var enqueue = GameDeferred.Enqueue;
        GameDeferred.Enqueue = action => posts.Enqueue(action);
        posts.Clear();
        var source = GameMainThread.Source;
        var fake = new CountingMainThread();
        GameMainThread.Source = fake;
        try
        {
            Assert(!GameDeferred.Post(() => throw new Exception("deferred")), "direct deferred post dropped");
            Assert(!GameDeferred.Register(() => throw new Exception("frame")), "frame registration dropped");
            Assert(!GameDeferred.PostCaptureDisarm(() => { }), "late disarm post dropped too");
            GameDeferred.PostQuitReplay(() => quit++);
            Assert(posts.Count == 1, "production quit replay helper posts after latch");
            posts.Dequeue()();
            Assert(quit == 2, "production quit replay executes");
            GameDeferred.Delay(null!, 0, () => throw new Exception("timer")).Dispose();
            GameNextFrame.Schedule(() => throw new Exception("next frame"));
            GameMainThread.Invoke(() => true);
            await GameMainThread.InvokeAsync(() => Task.FromResult(true));
            Assert(fake.Posts == 0, "sync and async dispatcher never reached after exit");
        }
        finally { GameMainThread.Source = source; GameDeferred.Enqueue = enqueue; }
        Console.WriteLine($"HostExitPostTests: {_assertions} assertions passed.");
    }

    private static async Task NestedDispatchAsync()
    {
        var source = GameMainThread.Source;
        GameMainThread.Source = new HoppingMainThread();
        try
        {
            var nested = Task.Run(() => GameMainThread.Invoke(() => GameMainThread.Invoke(() => 42)));
            Assert(await nested.WaitAsync(TimeSpan.FromSeconds(3)) == 42,
                "synchronous dispatcher can re-enter admission from another thread");
            var asynchronous = Task.Run(() => GameMainThread.InvokeAsync(() =>
                Task.FromResult(GameMainThread.Invoke(() => 43))));
            Assert(await asynchronous.WaitAsync(TimeSpan.FromSeconds(3)) == 43,
                "async dispatch admission does not hold a lock across callbacks");

            Sts2MainThreadDispatcher.Capture(new HoppingContext());
            GameMainThread.Source = SpirectlGameMainThread.Instance;
            var real = Task.Run(() => GameMainThread.InvokeAsync(() =>
                Task.FromResult(GameMainThread.Invoke(() => 44))));
            Assert(await real.WaitAsync(TimeSpan.FromSeconds(3)) == 44,
                "real async dispatcher can re-enter admission through its captured context");
        }
        finally { Sts2MainThreadDispatcher.ResetForTests(); GameMainThread.Source = source; }
    }

    internal static async Task RunEntryAsync(string entry)
    {
        Assert(!CouchCoopMod.HostExiting, "entry starts before process exit");
        if (entry == "pending-dispatch")
        {
            await PendingDispatchAsync();
            Console.WriteLine($"Host exit {entry}: {_assertions} assertions passed.");
            return;
        }
        if (entry == "socket-close")
        {
            await BrowserServerRouteTests.RunHostExitCloseAsync();
            return;
        }
        if (entry is "enqueue-race" or "capture-enqueue-race" or "quit-enqueue-race")
        {
            await EnqueueRaceAsync(entry);
            Console.WriteLine($"Host exit {entry}: {_assertions} assertions passed.");
            return;
        }
        var posts = new Queue<Action>();
        GameDeferred.Enqueue = posts.Enqueue;
        switch (entry)
        {
            case "seat-teardown":
                await HostSeatExitTests.BrowserAndHostingTeardownCannotInterruptHostExit();
                break;
            case "manager":
                using (var manager = new HeadlessClientManager(_ => null, registerProcessExit: false))
                {
                    CouchCoopMod.EngineAvailable = true;
                    try { manager.BeginHostExit(); manager.BeginHostExit(); }
                    finally { CouchCoopMod.EngineAvailable = false; }
                }
                break;
            case "window-close":
                CouchCoopMod.OnHostWindowCloseRequested();
                CouchCoopMod.OnHostWindowCloseRequested();
                break;
            case "headless-disarm":
                var done = new TaskCompletionSource();
                var disarm = CouchCoopMod.BeginHostExit(() =>
                {
                    Assert(!CouchCoopMod.HostExiting, "headless disarm admitted before exit seals queue");
                    Assert(GameDeferred.PostCaptureDisarm(() => done.SetResult()), "headless disarm queued");
                    return done.Task;
                });
                Assert(CouchCoopMod.HostExiting && posts.Count == 1 && !disarm!.IsCompleted,
                    "headless exit sealed with its disarm pending");
                posts.Dequeue()();
                await disarm!;
                Assert(done.Task.IsCompletedSuccessfully, "pre-admitted disarm still runs after sealing");
                break;
            default: throw new ArgumentException(entry);
        }
        Assert(CouchCoopMod.HostExiting, entry + " seals process admission");
        Assert(!GameDeferred.Post(() => { }) && !GameDeferred.Register(() => { }), entry + " rejects deferred and frame work");
        Assert(!GameDeferred.PostCaptureDisarm(() => { }), entry + " rejects late capture posts");
        var fake = new CountingMainThread();
        GameMainThread.Source = fake;
        GameMainThread.Invoke(() => true);
        await GameMainThread.InvokeAsync(() => Task.FromResult(true));
        Assert(fake.Posts == 0 && posts.Count == 0, entry + " rejects dispatcher work");
        var replayed = false;
        GameDeferred.PostQuitReplay(() => replayed = true);
        Assert(posts.Count == 1, entry + " admits only quit replay");
        posts.Dequeue()();
        Assert(replayed, entry + " quit replay runs");
        Console.WriteLine($"Host exit {entry}: {_assertions} assertions passed.");
    }

    private static async Task PendingDispatchAsync()
    {
        var context = new PausedContext();
        Sts2MainThreadDispatcher.Capture(context);
        GameMainThread.Source = SpirectlGameMainThread.Instance;
        ZeroClientGuard.LogSink = _ => { };
        CouchCoopMod.EngineAvailable = true;
        var ran = 0;
        Task<int>? sync = null;
        Task<int>? async = null;
        try
        {
            sync = Task.Run(() => GameMainThread.Invoke(() => Interlocked.Increment(ref ran)));
            async = Task.Run(() => GameMainThread.InvokeAsync(() => Task.FromResult(Interlocked.Increment(ref ran))));
            await context.Posted.WaitAsync(TimeSpan.FromSeconds(3));
            CouchCoopMod.EngineAvailable = false;
            CouchCoopMod.BeginHostExit();
            Assert(await sync.WaitAsync(TimeSpan.FromSeconds(3)) == 0 &&
                await async.WaitAsync(TimeSpan.FromSeconds(3)) == 0,
                "exit completes sync and async waits without a game-thread drain");
            Assert(context.Posts == 2 && ran == 0, "only pre-exit work was posted and none executed");
            GameMainThread.Invoke(() => ++ran);
            await GameMainThread.InvokeAsync(() => Task.FromResult(++ran));
            Assert(context.Posts == 2 && ran == 0, "late dispatches return without posting");
            context.Drain();
            Assert(ran == 0, "callbacks drained after exit cannot run abandoned work");
        }
        finally
        {
            context.Drain();
            CouchCoopMod.EngineAvailable = false;
            Sts2MainThreadDispatcher.ResetForTests();
        }
    }

    private sealed class PausedContext : SynchronizationContext
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<Action> _queue = new();
        private readonly TaskCompletionSource _posted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal Task Posted => _posted.Task;
        internal int Posts;
        public override void Post(SendOrPostCallback callback, object? state)
        {
            _queue.Enqueue(() => callback(state));
            if (Interlocked.Increment(ref Posts) == 2) _posted.TrySetResult();
        }
        internal void Drain() { while (_queue.TryDequeue(out var work)) work(); }
    }

    private static async Task EnqueueRaceAsync(string entry)
    {
        using var enqueueEntered = new ManualResetEventSlim();
        using var releaseEnqueue = new ManualResetEventSlim();
        using var exitStarted = new ManualResetEventSlim();
        var original = GameDeferred.Enqueue;
        var sequence = 0;
        var insertionOrder = 0;
        var exitOrder = 0;
        var insertions = 0;
        GameDeferred.Enqueue = _ =>
        {
            enqueueEntered.Set();
            if (!releaseEnqueue.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("enqueue not released");
            insertionOrder = Interlocked.Increment(ref sequence);
            Interlocked.Increment(ref insertions);
        };
        Task? posting = null;
        Task? exiting = null;
        try
        {
            posting = Task.Factory.StartNew(() =>
            {
                switch (entry)
                {
                    case "enqueue-race": GameDeferred.Post(() => { }); break;
                    case "capture-enqueue-race": GameDeferred.PostCaptureDisarm(() => { }); break;
                    case "quit-enqueue-race": GameDeferred.PostQuitReplay(() => { }); break;
                }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            Assert(enqueueEntered.Wait(TimeSpan.FromSeconds(3)), "producer pauses before queue insertion");
            exiting = Task.Factory.StartNew(() =>
            {
                exitStarted.Set();
                CouchCoopMod.BeginHostExit();
                exitOrder = Interlocked.Increment(ref sequence);
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            Assert(exitStarted.Wait(TimeSpan.FromSeconds(3)), "second thread starts exit while enqueue is paused");
            var returnedBeforeInsertion = exiting.Wait(TimeSpan.FromMilliseconds(100));
            releaseEnqueue.Set();
            await Task.WhenAll(posting, exiting).WaitAsync(TimeSpan.FromSeconds(3));
            Assert(!returnedBeforeInsertion, "exit cannot return while engine insertion is pending");
            Assert(insertions == 1 && insertionOrder > 0 && insertionOrder < exitOrder,
                "engine insertion is ordered before exit returns");
            Assert(!GameDeferred.Post(() => { }) && !GameDeferred.PostCaptureDisarm(() => { }) &&
                !GameDeferred.Register(() => Interlocked.Increment(ref insertions)) && insertions == 1,
                "work started after exit returns cannot insert or register anything");
        }
        finally
        {
            releaseEnqueue.Set();
            try { await Task.WhenAll(posting ?? Task.CompletedTask, exiting ?? Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(3)); }
            finally { GameDeferred.Enqueue = original; }
        }
    }

    internal static async Task RunInFreshProcessAsync(string entry)
    {
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false };
        start.ArgumentList.Add("exec");
        start.ArgumentList.Add(typeof(HostExitPostTests).Assembly.Location);
        start.ArgumentList.Add("host-exit-entry");
        start.ArgumentList.Add(entry);
        using var child = Process.Start(start)!;
        try { await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15)); }
        catch { child.Kill(entireProcessTree: true); throw; }
        if (child.ExitCode != 0) throw new Exception($"Host exit {entry} child failed ({child.ExitCode}).");
    }

    private sealed class HoppingContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state)
            => Task.Run(() =>
            {
                SetSynchronizationContext(this);
                callback(state);
            }).GetAwaiter().GetResult();
    }

    private sealed class HoppingMainThread : IGameMainThread
    {
        public T Invoke<T>(Func<T> action) => Task.Run(action).GetAwaiter().GetResult();
        public Task<T> InvokeAsync<T>(Func<Task<T>> action)
            => Task.FromResult(Task.Run(action).GetAwaiter().GetResult());
    }

    private sealed class CountingMainThread : IGameMainThread
    {
        internal int Posts;
        public T Invoke<T>(Func<T> action) { Posts++; return default!; }
        public Task<T> InvokeAsync<T>(Func<Task<T>> action) { Posts++; return Task.FromResult(default(T)!); }
    }

    private static void Assert(bool value, string message)
    {
        _assertions++;
        if (!value) throw new Exception("host-exit-posts: " + message);
    }
}
