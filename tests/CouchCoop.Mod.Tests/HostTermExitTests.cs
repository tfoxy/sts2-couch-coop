using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Session;

internal static class HostTermExitTests
{
    internal const string Verb = "host-term-exit";

    internal static async Task RunAsync()
    {
        RegistrationDependsOnRoleDisplayAndPlatform();
        CancelsOnlyAWiredSuccessfulStart();
        BackstopIsArmedBeforeDispatch();
        AFailedDispatchKeepsDefaultTermination();
        await BackstopIsArmedBeforeAnyStep();
        await BothStepsMustCompleteBeforeLeave();
        await HungStepsHaveIndependentBounds();
        await CaptureIsSkippedWhenNotLoaded();
        await RepeatedTermsDoNotRestartTheSequence();
        await SignalHandlingDoesNotWaitForSeatStop();
        await ThrowingLeaveKeepsTheBackstopArmed();
        await FailedStepsStillLeave();
        await ThrowingLogsCannotPreventExit();
        FailedBackstopArmKeepsDefaultTermination();
        WindowedBackstopIsArmedBeforeMainThreadQuit();
        RepeatedWindowedTermsDoNotRestartTheSequence();
        FailedWindowedPostKeepsTermCancelled();
        FailedWindowedBackstopArmCanRetry();
        ThrowingWindowedQuitKeepsTheBackstopArmed();
        ThrowingWindowedLogsCannotPreventQuitOrBackstop();
        await WindowedCaptureDisarmsBeforeQuit();
        WindowedQuitWithoutCaptureDoesNoWork();
        WindowedQuitWhileDetachedFencesWithoutWaiting();
        await WindowedCaptureTimeoutStillQuits();
        await ThrowingWindowedDisarmStillQuits();
        await BlockingWindowedDisarmIsBounded();
        Console.WriteLine("HostTermExitTests: 26 passed.");
    }

    private static void RegistrationDependsOnRoleDisplayAndPlatform()
    {
        foreach (var os in new[] { OSPlatform.Linux, OSPlatform.OSX, OSPlatform.Windows, OSPlatform.FreeBSD, OSPlatform.Create("other") })
        foreach (var seat in new[] { false, true })
        foreach (var headless in new[] { false, true })
        {
            var posix = os == OSPlatform.Linux || os == OSPlatform.OSX;
            var expected = seat && (posix || os == OSPlatform.Windows) ? HostTermSignal.Registration.Seat
                : seat || !posix ? HostTermSignal.Registration.None
                : headless ? HostTermSignal.Registration.HostCancel : HostTermSignal.Registration.HostQuit;
            Assert(HostTermSignal.Select(seat, headless, candidate => candidate == os) == expected,
                $"seat={seat}, headless={headless}, os={os} selects {expected}");
        }
    }

    private static void CancelsOnlyAWiredSuccessfulStart()
    {
        var calls = 0;
        Assert(HostTermSignal.Decide(() => { calls++; return true; }), "a queued sequence cancels default TERM");
        Assert(calls == 1, "the signal requests the sequence once");
        Assert(!HostTermSignal.Decide(null), "an unwired sequence retains default TERM");
        Assert(!HostTermSignal.Decide(() => false), "an unavailable sequence retains default TERM");
        Assert(!HostTermSignal.Decide(() => throw new IOException("unavailable")), "a throwing start retains default TERM");
    }

    private static void BackstopIsArmedBeforeDispatch()
    {
        var fixture = new Fixture();
        Func<Task>? queued = null;
        var armedAtDispatch = false;
        var sequence = fixture.Create(start: work =>
        {
            armedAtDispatch = fixture.Backstop is not null;
            queued = work;
            return Pending().Task;
        });
        Assert(sequence.TryStart(), "deferred dispatch starts the sequence");
        Assert(armedAtDispatch && fixture.Events.SequenceEqual(new[] { "arm" }),
            "the backstop is armed before dispatch even when queued work never starts");
        Assert(queued is not null && !sequence.Completion.IsCompleted, "shutdown work remains queued without running");
        Assert(fixture.Delay == HostTermExitSequence.ForceExitDelay, "the deferred work already has the force-exit deadline");
        fixture.Backstop!();
        Assert(fixture.Forced == 1, "the backstop force-exits without queued work ever running");
    }

    private static void AFailedDispatchKeepsDefaultTermination()
    {
        var fixture = new Fixture();
        var calls = 0;
        var sequence = fixture.Create(start: _ => { calls++; throw new InvalidOperationException("cannot queue"); });
        Assert(!HostTermSignal.Decide(sequence.TryStart), "a failed Task.Run equivalent keeps default TERM");
        Assert(HostTermSignal.Decide(sequence.TryStart) && calls == 1,
            "another TERM relies on the existing backstop without redispatching");
        Assert(fixture.Events.SequenceEqual(new[] { "arm" }), "failed dispatch leaves exactly one backstop and no shutdown work");
        fixture.Backstop!();
        Assert(fixture.Forced == 1, "the backstop still force-exits after dispatch fails");
    }

    private static async Task BackstopIsArmedBeforeAnyStep()
    {
        var fixture = new Fixture();
        var sequence = fixture.Create();
        Assert(sequence.TryStart(), "the sequence starts");
        await Complete(sequence);
        var trace = fixture.Events.ToArray();
        Assert(trace[0] == "arm" && trace[^1] == "leave:sigterm", "backstop is first and direct exit is last");
        Assert(trace.Contains("seats") && trace.Contains("disarm"), "both shutdown steps run before leaving");
        Assert(fixture.Delay == HostTermExitSequence.ForceExitDelay, "backstop uses the documented bound");
        Assert(fixture.Delay > HostTermExitSequence.SeatStopGuard
            && fixture.Delay > HeadlessDisconnectExitSequence.DisarmGuard, "backstop covers both parallel bounds with margin");
        Assert(fixture.Logs.Any(line => line == "host received SIGTERM — signalling 2 seat(s), disarming capture: yes"),
            "start log names seat count and capture");
        Assert(fixture.Logs.Any(line => line.StartsWith("headless host SIGTERM: leaving after ") && line.EndsWith(" ms.")),
            "leave log includes elapsed milliseconds");
    }

    private static async Task BothStepsMustCompleteBeforeLeave()
    {
        foreach (var seatFirst in new[] { false, true })
        {
            var fixture = new Fixture();
            var seats = Pending();
            var disarm = Pending();
            var seatStarted = Pending();
            var disarmStarted = Pending();
            var sequence = fixture.Create(
                stopSeats: () => { seatStarted.SetResult(); return seats.Task; },
                disarm: () => { disarmStarted.SetResult(); return disarm.Task; });
            Assert(sequence.TryStart(), "shutdown queues");
            await Task.WhenAll(seatStarted.Task, disarmStarted.Task).WaitAsync(TimeSpan.FromSeconds(2));
            Assert(!fixture.Events.Any(item => item.StartsWith("leave")), "both steps start while neither is complete");
            (seatFirst ? seats : disarm).SetResult();
            Assert(!sequence.Completion.IsCompleted, "one completed step cannot release exit");
            (seatFirst ? disarm : seats).SetResult();
            await Complete(sequence);
            Assert(fixture.Events.Count(item => item == "leave:sigterm") == 1, "both completions release one exit");
        }
    }

    private static async Task HungStepsHaveIndependentBounds()
    {
        var clock = new Clock();
        var fixture = new Fixture();
        var seatBound = Pending();
        var sequence = fixture.Create(stopSeats: () => Pending().Task, disarm: () => Pending().Task,
            timeProvider: clock,
            log: line => { if (line.Contains("seat stop did not finish")) seatBound.TrySetResult(); });
        Assert(sequence.TryStart(), "hung work queues without blocking the caller");
        await clock.BothTimers.Task.WaitAsync(TimeSpan.FromSeconds(2));
        clock.Advance(HostTermExitSequence.SeatStopGuard);
        await seatBound.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(!sequence.Completion.IsCompleted, "seat timeout does not skip the capture bound");
        Assert(!fixture.Events.Any(item => item.StartsWith("leave")), "exit still awaits capture");
        clock.Advance(HeadlessDisconnectExitSequence.DisarmGuard - HostTermExitSequence.SeatStopGuard);
        await Complete(sequence);
        Assert(fixture.Events.Contains("leave:sigterm"), "both bounds release exit even if neither task finishes");
        Assert(fixture.Backstop is not null && fixture.Forced == 0, "parallel timeouts leave the independent backstop armed");
    }

    private static async Task CaptureIsSkippedWhenNotLoaded()
    {
        var fixture = new Fixture();
        var reads = 0;
        var sequence = fixture.Create(captureEnabled: () => { reads++; return false; },
            disarm: () => throw new Exception("capture must not be touched"));
        Assert(sequence.TryStart(), "host without capture starts shutdown");
        await Complete(sequence);
        Assert(reads == 1 && !fixture.Events.Contains("disarm"), "capture enablement is read once and disarm is skipped");
        Assert(fixture.Events.Contains("seats") && fixture.Events.Contains("leave:sigterm"), "seat stop and leave still run");
        Assert(fixture.Logs.Any(line => line.EndsWith("disarming capture: no")), "start log reports no capture");
    }

    private static async Task RepeatedTermsDoNotRestartTheSequence()
    {
        var fixture = new Fixture();
        var seats = Pending();
        var sequence = fixture.Create(stopSeats: () => seats.Task);
        Assert(HostTermSignal.Decide(sequence.TryStart), "first TERM cancels default termination");
        Assert(HostTermSignal.Decide(sequence.TryStart), "TERM during shutdown also cancels default termination");
        seats.SetResult();
        await Complete(sequence);
        Assert(HostTermSignal.Decide(sequence.TryStart), "a returning fake leave does not allow default termination on the next TERM");
        Assert(fixture.Events.Count(item => item == "arm") == 1 && fixture.Events.Count(item => item == "leave:sigterm") == 1,
            "repeated TERM cannot re-arm or leave twice");
    }

    private static async Task SignalHandlingDoesNotWaitForSeatStop()
    {
        using var release = new ManualResetEventSlim();
        var entered = Pending();
        var fixture = new Fixture();
        var sequence = fixture.Create(stopSeats: () =>
        {
            entered.SetResult();
            release.Wait();
            return Task.CompletedTask;
        });
        var handle = Task.Run(() => HostTermSignal.Decide(sequence.TryStart));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Assert(await handle.WaitAsync(TimeSpan.FromSeconds(2)), "signal handling returns while seat stop is synchronously blocked");
            Assert(!sequence.Completion.IsCompleted, "the queued sequence is still waiting for seat stop");
        }
        finally { release.Set(); }
        await Complete(sequence);
    }

    private static async Task ThrowingLeaveKeepsTheBackstopArmed()
    {
        var fixture = new Fixture();
        var sequence = fixture.Create(leave: _ => throw new IOException("exit failed"));
        Assert(sequence.TryStart(), "throwing leave is queued");
        await Complete(sequence);
        Assert(fixture.Backstop is not null && fixture.Forced == 0, "failed leave does not cancel or fire the backstop early");
        fixture.Backstop!();
        Assert(fixture.Forced == 1, "the scheduled action still force-exits after a failed leave");
    }

    private static async Task FailedStepsStillLeave()
    {
        foreach (var synchronous in new[] { false, true })
        {
            var fixture = new Fixture();
            Task Fail() => synchronous ? throw new IOException("blocked teardown") : Task.FromException(new IOException("blocked teardown"));
            var sequence = fixture.Create(stopSeats: Fail, disarm: Fail);
            Assert(sequence.TryStart(), "failed steps are queued");
            await Complete(sequence);
            Assert(fixture.Events.Contains("leave:sigterm"), "synchronous and asynchronous step failures still leave");
        }
    }

    private static async Task ThrowingLogsCannotPreventExit()
    {
        var fixture = new Fixture();
        var sequence = fixture.Create(log: _ => throw new IOException("logger failed"));
        Assert(sequence.TryStart(), "shutdown queues despite failed logging");
        await Complete(sequence);
        Assert(fixture.Events.Contains("leave:sigterm"), "logger exceptions cannot prevent leave");
    }

    private static void FailedBackstopArmKeepsDefaultTermination()
    {
        var fixture = new Fixture();
        var dispatches = 0;
        var attempts = 0;
        var sequence = fixture.Create(
            schedule: (_, _) => { attempts++; throw new InvalidOperationException("cannot create thread"); },
            start: _ => { dispatches++; return Task.CompletedTask; });
        Assert(!HostTermSignal.Decide(sequence.TryStart), "a failed backstop arm keeps default TERM");
        Assert(!HostTermSignal.Decide(sequence.TryStart) && attempts == 2, "a failed arm resets the one-shot gate for another attempt");
        Assert(dispatches == 0 && fixture.Events.IsEmpty && fixture.Backstop is null && fixture.Forced == 0,
            "a failed arm never dispatches work, stops seats, disarms capture or leaves directly");
    }

    private static void WindowedBackstopIsArmedBeforeMainThreadQuit()
    {
        var fixture = new Fixture();
        var armedAtPost = false;
        Action? posted = null;
        var sequence = fixture.CreateQuit(post: action =>
        {
            armedAtPost = fixture.Backstop is not null;
            posted = action;
        });
        Assert(HostTermSignal.Decide(sequence.TryStart), "a queued windowed quit cancels default TERM");
        Assert(armedAtPost && fixture.Events.SequenceEqual(new[] { "arm", "post" }),
            "the windowed backstop is armed before posting, without running quit on the signal thread");
        Assert(fixture.Delay == TimeSpan.FromSeconds(20)
            && fixture.Delay > HostTermExitSequence.SeatStopGuard, "windowed backstop covers game quit and seat stop with margin");
        Assert(posted is not null, "the game quit is posted to the main thread");
        posted!();
        Assert(fixture.Events.SequenceEqual(new[] { "arm", "post", "quit" }), "quit runs inside the posted action");
    }

    private static void RepeatedWindowedTermsDoNotRestartTheSequence()
    {
        var fixture = new Fixture();
        var sequence = fixture.CreateQuit();
        Assert(HostTermSignal.Decide(sequence.TryStart), "first windowed TERM is cancelled");
        Assert(HostTermSignal.Decide(sequence.TryStart), "TERM while the main-thread hop is queued is cancelled");
        fixture.Posted!();
        Assert(HostTermSignal.Decide(sequence.TryStart), "TERM after a returning fake quit is cancelled");
        Assert(fixture.Events.SequenceEqual(new[] { "arm", "post", "quit" }), "repeated windowed TERM arms and posts only once");
    }

    private static void FailedWindowedPostKeepsTermCancelled()
    {
        var clock = new Clock();
        var fixture = new Fixture();
        var sequence = fixture.CreateQuit(post: _ => throw new IOException("cannot post"), timeProvider: clock);
        Assert(HostTermSignal.Decide(sequence.TryStart), "failed windowed post still cancels default TERM");
        Assert(HostTermSignal.Decide(sequence.TryStart), "a repeated TERM does not retry a failed post");
        Assert(fixture.Events.SequenceEqual(new[] { "arm", "post" }), "failed post leaves one backstop and never runs quit");
        Assert(fixture.Logs.Any(line => line.Contains("quit dispatch failed: IOException: cannot post")), "post failure is logged");
        FireWindowedBackstop(clock, fixture);
    }

    private static void FailedWindowedBackstopArmCanRetry()
    {
        var fixture = new Fixture();
        var attempts = 0;
        var sequence = fixture.CreateQuit(schedule: (delay, action) =>
        {
            if (++attempts == 1) throw new InvalidOperationException("cannot create thread");
            fixture.Events.Enqueue("arm");
            fixture.Delay = delay;
            fixture.Backstop = action;
        });
        Assert(!HostTermSignal.Decide(sequence.TryStart), "a failed windowed backstop arm keeps default TERM");
        Assert(fixture.Events.IsEmpty && fixture.Posted is null && fixture.Backstop is null,
            "a failed windowed arm never posts or quits");
        Assert(HostTermSignal.Decide(sequence.TryStart) && attempts == 2, "a later windowed TERM retries arming and is cancelled");
        Assert(fixture.Events.SequenceEqual(new[] { "arm", "post" }), "the successful retry posts exactly once after arming");
        fixture.Posted!();
        Assert(fixture.Events.Last() == "quit", "the retry reaches the game quit");
        fixture.Backstop!();
        Assert(fixture.Forced == 1, "the retry leaves its backstop armed");
    }

    private static void ThrowingWindowedQuitKeepsTheBackstopArmed()
    {
        var clock = new Clock();
        var fixture = new Fixture();
        var sequence = fixture.CreateQuit(quit: () => throw new IOException("quit failed"), timeProvider: clock);
        Assert(HostTermSignal.Decide(sequence.TryStart), "a windowed quit with a failing main-thread action is queued");
        fixture.Posted!();
        Assert(fixture.Logs.Any(line => line.Contains("game quit failed: IOException: quit failed")), "quit failure is logged");
        Assert(fixture.Events.SequenceEqual(new[] { "arm", "post", "quit" }), "a failed quit does not force-exit early");
        FireWindowedBackstop(clock, fixture);
    }

    private static void ThrowingWindowedLogsCannotPreventQuitOrBackstop()
    {
        foreach (var failure in new[] { "none", "post", "quit" })
        {
            var clock = new Clock();
            var fixture = new Fixture();
            var sequence = fixture.CreateQuit(
                post: failure == "post" ? _ => throw new IOException("cannot post") : null,
                quit: failure == "quit" ? () => throw new IOException("quit failed") : null,
                log: _ => throw new IOException("logger failed"), timeProvider: clock);
            Assert(HostTermSignal.Decide(sequence.TryStart), "failed signal-path logging cannot enable default TERM");
            if (failure != "post")
            {
                fixture.Posted!();
                Assert(fixture.Events.Contains("quit"), "failed main-thread logging cannot prevent quit");
            }
            Assert(fixture.Logs.Count >= 2, "both start and main-thread/failure log paths were exercised");
            FireWindowedBackstop(clock, fixture);
        }
    }

    private static async Task WindowedCaptureDisarmsBeforeQuit()
    {
        var disarm = Pending();
        var entered = Pending();
        var events = new ConcurrentQueue<string>();
        var mainThread = Environment.CurrentManagedThreadId;
        Action? posted = null;
        var sequence = new HostCaptureQuitSequence(
            () => { events.Enqueue("disarm"); entered.SetResult(); return disarm.Task; },
            action => { events.Enqueue("post"); posted = action; },
            stopRenderer: () =>
            {
                Assert(Environment.CurrentManagedThreadId == mainThread, "renderer demand is fenced on the calling main thread");
                events.Enqueue("fence");
            });
        var quits = 0;
        void Quit()
        {
            Assert(sequence.BeforeQuit(true, () => throw new Exception("unexpected replay")),
                "the main-thread continuation may re-enter the original quit");
            events.Enqueue("quit");
            quits++;
        }
        Assert(!sequence.BeforeQuit(true, Quit), "loaded capture defers the original quit");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(!sequence.BeforeQuit(true, Quit), "another quit while disarming is suppressed");
        Assert(events.SequenceEqual(new[] { "fence", "disarm" }) && quits == 0 && posted is null,
            "quit and its main-thread dispatch wait for disarm");
        disarm.SetResult();
        await sequence.Completion.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(events.SequenceEqual(new[] { "fence", "disarm", "post" }) && quits == 0,
            "disarm completion posts quit without running it off-thread");
        posted!();
        Assert(events.SequenceEqual(new[] { "fence", "disarm", "post", "quit" }) && quits == 1,
            "posted continuation quits once after disarm");
        Assert(!sequence.BeforeQuit(true, Quit) && quits == 1, "later requests cannot restart capture shutdown");
    }

    private static void WindowedQuitWithoutCaptureDoesNoWork()
    {
        var disarms = 0;
        var posts = 0;
        var quits = 0;
        var clock = new Clock();
        var sequence = new HostCaptureQuitSequence(
            () => { disarms++; return Task.CompletedTask; }, _ => posts++, timeProvider: clock,
            stopRenderer: () => throw new Exception("capture-off quit must not fence the renderer"));
        if (sequence.BeforeQuit(false, () => quits++)) quits++;
        Assert(quits == 1 && disarms == 0 && posts == 0 && !clock.FirstTimer.Task.IsCompleted,
            "without capture quit proceeds synchronously without disarm, dispatch or timer");
        Assert(sequence.Completion.IsCompletedSuccessfully, "without capture no asynchronous work is started");
    }

    private static void WindowedQuitWhileDetachedFencesWithoutWaiting()
    {
        var fences = 0;
        var clock = new Clock();
        var sequence = new HostCaptureQuitSequence(
            () => throw new Exception("detached quit must not disarm"),
            _ => throw new Exception("detached quit must not dispatch"), timeProvider: clock,
            stopRenderer: () => fences++);
        Assert(sequence.BeforeQuit(true, () => throw new Exception("quit proceeds synchronously"), captureAttached: false),
            "detached capture allows the original quit");
        Assert(fences == 1 && sequence.Completion.IsCompletedSuccessfully && !clock.FirstTimer.Task.IsCompleted,
            "detached quit fences requests without a disarm wait or timer");
    }

    private static async Task WindowedCaptureTimeoutStillQuits()
    {
        var disarm = Pending();
        var entered = Pending();
        var clock = new Clock();
        var quits = 0;
        var sequence = new HostCaptureQuitSequence(
            () => { entered.SetResult(); return disarm.Task; }, action => action(),
            log: _ => { }, timeProvider: clock);
        Assert(!sequence.BeforeQuit(true, () => quits++), "pending disarm defers quit");
        await Task.WhenAll(clock.FirstTimer.Task, entered.Task).WaitAsync(TimeSpan.FromSeconds(2));
        clock.Advance(RenderStreamCaptureQuit.DisarmTimeout - TimeSpan.FromTicks(1));
        Assert(quits == 0 && !sequence.Completion.IsCompleted, "disarm timeout never quits early");
        clock.Advance(TimeSpan.FromTicks(1));
        await sequence.Completion.WaitAsync(TimeSpan.FromSeconds(2));
        Assert(quits == 1, "missing disarm completion still quits at the existing disarm bound");
        disarm.SetResult();
        Assert(quits == 1, "a late disarm cannot quit twice");
    }

    private static async Task ThrowingWindowedDisarmStillQuits()
    {
        foreach (var synchronous in new[] { false, true })
        foreach (var failingLog in new[] { false, true })
        {
            var quits = 0;
            Task Fail() => synchronous ? throw new IOException("disarm failed")
                : Task.FromException(new IOException("disarm failed"));
            var sequence = new HostCaptureQuitSequence(Fail, action => action(),
                log: _ => { if (failingLog) throw new IOException("logger failed"); });
            Assert(!sequence.BeforeQuit(true, () => quits++), "failing disarm still intercepts quit");
            await sequence.Completion.WaitAsync(TimeSpan.FromSeconds(2));
            Assert(quits == 1, "synchronous/asynchronous disarm failures and failed logging still quit");
        }
    }

    private static async Task BlockingWindowedDisarmIsBounded()
    {
        using var release = new ManualResetEventSlim();
        var entered = Pending();
        var finished = Pending();
        var clock = new Clock();
        var quits = 0;
        var sequence = new HostCaptureQuitSequence(() =>
        {
            entered.SetResult();
            release.Wait();
            finished.SetResult();
            return Task.CompletedTask;
        }, action => action(), log: _ => { }, timeProvider: clock);
        try
        {
            Assert(!sequence.BeforeQuit(true, () => quits++), "blocking disarm never blocks the quit hook");
            await Task.WhenAll(clock.FirstTimer.Task, entered.Task).WaitAsync(TimeSpan.FromSeconds(2));
            clock.Advance(RenderStreamCaptureQuit.DisarmTimeout);
            await sequence.Completion.WaitAsync(TimeSpan.FromSeconds(2));
            Assert(quits == 1 && !finished.Task.IsCompleted, "synchronous blocking is bounded before quit");
        }
        finally { release.Set(); }
        await finished.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private static void FireWindowedBackstop(Clock clock, Fixture fixture)
    {
        clock.Advance(HostTermQuitSequence.ForceExitDelay - TimeSpan.FromTicks(1));
        Assert(fixture.Forced == 0, "windowed backstop does not fire before its deadline");
        clock.Advance(TimeSpan.FromTicks(1));
        Assert(fixture.Forced == 1, "windowed backstop still fires at its deadline");
    }

    private static TaskCompletionSource Pending() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static Task Complete(HostTermExitSequence sequence) => sequence.Completion.WaitAsync(TimeSpan.FromSeconds(2));

    private sealed class Fixture
    {
        internal readonly ConcurrentQueue<string> Events = new();
        internal readonly ConcurrentQueue<string> Logs = new();
        internal Action? Backstop;
        internal Action? Posted;
        internal TimeSpan Delay;
        internal int Forced;

        internal HostTermExitSequence Create(
            Func<Task>? stopSeats = null, Func<Task>? disarm = null, Func<bool>? captureEnabled = null,
            Action<string>? leave = null, Action<TimeSpan, Action>? schedule = null,
            Action<string>? log = null, TimeProvider? timeProvider = null, Func<Func<Task>, Task>? start = null) => new(
                stopSeats: () => { Events.Enqueue("seats"); return stopSeats?.Invoke() ?? Task.CompletedTask; },
                disarm: () => { Events.Enqueue("disarm"); return disarm?.Invoke() ?? Task.CompletedTask; },
                captureEnabled: captureEnabled ?? (() => true), seatCount: () => 2,
                leave: reason => { Events.Enqueue("leave:" + reason); leave?.Invoke(reason); },
                forceExit: () => { Events.Enqueue("force"); Interlocked.Increment(ref Forced); },
                schedule: schedule ?? ((delay, action) => { Events.Enqueue("arm"); Delay = delay; Backstop = action; }),
                log: line => { Logs.Enqueue(line); log?.Invoke(line); }, timeProvider: timeProvider, start: start);

        internal HostTermQuitSequence CreateQuit(
            Action<Action>? post = null, Action? quit = null, Action<TimeSpan, Action>? schedule = null,
            Action<string>? log = null, TimeProvider? timeProvider = null) => new(
                post: action => { Events.Enqueue("post"); if (post is null) Posted = action; else post(action); },
                quit: () => { Events.Enqueue("quit"); quit?.Invoke(); },
                forceExit: () => { Events.Enqueue("force"); Interlocked.Increment(ref Forced); },
                schedule: schedule ?? ((delay, action) =>
                {
                    Events.Enqueue("arm");
                    Delay = delay;
                    Backstop = action;
                    timeProvider?.CreateTimer(_ => action(), null, delay, Timeout.InfiniteTimeSpan);
                }),
                log: line => { Logs.Enqueue(line); log?.Invoke(line); });
    }

    private sealed class Clock : TimeProvider
    {
        private readonly object _gate = new();
        private readonly List<ManualTimer> _timers = [];
        private long _now;
        internal readonly TaskCompletionSource FirstTimer = Pending();
        internal readonly TaskCompletionSource BothTimers = Pending();
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() { lock (_gate) return _now; }

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            lock (_gate)
            {
                var timer = new ManualTimer(this, callback, state);
                timer.Change(dueTime, period);
                _timers.Add(timer);
                FirstTimer.TrySetResult();
                if (_timers.Count == 2) BothTimers.TrySetResult();
                return timer;
            }
        }

        internal void Advance(TimeSpan elapsed)
        {
            ManualTimer[] due;
            lock (_gate)
            {
                _now += elapsed.Ticks;
                due = _timers.Where(timer => timer.Due <= _now).ToArray();
                foreach (var timer in due) timer.Due = long.MaxValue;
            }
            foreach (var timer in due) timer.Fire();
        }

        private sealed class ManualTimer(Clock clock, TimerCallback callback, object? state) : ITimer
        {
            internal long Due = long.MaxValue;
            internal void Fire() => callback(state);
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                Assert(period == Timeout.InfiniteTimeSpan, "exit bounds are one-shot timers");
                lock (clock._gate) Due = dueTime == Timeout.InfiniteTimeSpan ? long.MaxValue : clock._now + dueTime.Ticks;
                return true;
            }
            public void Dispose() { lock (clock._gate) Due = long.MaxValue; }
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("HostTermExitTests: " + message);
    }
}
