namespace CouchCoop.Mod.Session;

/// <summary>
/// Stops a headless host without running exit handlers while the engine's threads are still live.
/// The default TERM path calls exit() off the main thread. Arm an independent backstop before any
/// shutdown work, then stop seats and disarm capture in parallel before leaving the process directly.
/// </summary>
internal sealed class HostTermExitSequence
{
    internal static readonly TimeSpan SeatStopGuard = HeadlessClientManager.GracefulStopTimeout + TimeSpan.FromSeconds(0.5);
    // Covers the parallel seat stop (3 s + 0.5 s for kills) and capture disarm (5 s), plus 2.5 s to leave.
    internal static readonly TimeSpan ForceExitDelay = TimeSpan.FromSeconds(7.5);

    private readonly Func<Task> _stopSeats;
    private readonly Func<Task> _disarm;
    private readonly Func<bool> _captureEnabled;
    private readonly Func<int> _seatCount;
    private readonly Action<string> _leave;
    private readonly Action _forceExit;
    private readonly Action<TimeSpan, Action> _schedule;
    private readonly Action<string> _log;
    private readonly TimeProvider _timeProvider;
    private readonly Func<Func<Task>, Task> _start;
    private int _started;

    internal HostTermExitSequence(
        Func<Task> stopSeats,
        Func<Task> disarm,
        Func<bool> captureEnabled,
        Func<int> seatCount,
        Action<string> leave,
        Action? forceExit = null,
        Action<TimeSpan, Action>? schedule = null,
        Action<string>? log = null,
        TimeProvider? timeProvider = null,
        Func<Func<Task>, Task>? start = null)
    {
        _stopSeats = stopSeats;
        _disarm = disarm;
        _captureEnabled = captureEnabled;
        _seatCount = seatCount;
        _leave = leave;
        _forceExit = forceExit ?? HeadlessForceExit.Now;
        _schedule = schedule ?? ScheduleOnBackgroundThread;
        _log = log ?? CouchCoopLog.Info;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _start = start ?? (work => Task.Run(work));
    }

    internal Task Completion { get; private set; } = Task.CompletedTask;

    // Arm on the signal thread before queueing work: pool starvation must not delay the backstop.
    // Starting its background thread never waits on shutdown work or dispatches to the game's main thread.
    internal bool TryStart()
    {
        if (Interlocked.CompareExchange(ref _started, 1, 0) != 0) return true;
        try
        {
            _schedule(ForceExitDelay, _forceExit);
        }
        catch
        {
            Volatile.Write(ref _started, 0);
            return false;
        }
        try
        {
            Completion = _start(RunAsync);
            return true;
        }
        catch
        {
            // Keep default TERM handling and the already-armed backstop if dispatch fails.
            return false;
        }
    }

    private async Task RunAsync()
    {
        var started = _timeProvider.GetTimestamp();
        var captureEnabled = _captureEnabled();
        Log($"host received SIGTERM — signalling {_seatCount()} seat(s), disarming capture: {(captureEnabled ? "yes" : "no")}");
        var seats = RunBoundedAsync(_stopSeats, SeatStopGuard, "seat stop");
        var capture = captureEnabled
            ? RunBoundedAsync(_disarm, HeadlessDisconnectExitSequence.DisarmGuard, "capture disarm")
            : Task.CompletedTask;
        await Task.WhenAll(seats, capture).ConfigureAwait(false);

        Log($"headless host SIGTERM: leaving after {_timeProvider.GetElapsedTime(started).TotalMilliseconds:0} ms.");
        try { _leave("sigterm"); }
        catch (Exception exception)
        {
            Log($"headless host process exit failed: {exception.GetType().Name}: {exception.Message} — waiting for the force-exit backstop.");
        }
    }

    private async Task RunBoundedAsync(Func<Task> step, TimeSpan bound, string label)
    {
        try
        {
            // Bound synchronous blocking as well as asynchronous waits, independently for each step.
            await Task.Run(step).WaitAsync(bound, _timeProvider).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            Log($"headless host {label} did not finish: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void Log(string message)
    {
        try { _log(message); }
        catch { /* Logging must not prevent the bounded exit. */ }
    }

    private static void ScheduleOnBackgroundThread(TimeSpan delay, Action action)
    {
        new Thread(() =>
        {
            Thread.Sleep(delay);
            action();
        })
        {
            IsBackground = true,
            Name = "couchcoop-host-term-exit",
        }.Start();
    }
}
