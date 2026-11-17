namespace CouchCoop.Mod.Session;

/// <summary>Quits a windowed host on the game's main thread so its normal save and shutdown paths run.</summary>
internal sealed class HostTermQuitSequence
{
    // Covers the game's own quit sequence, which can take several seconds, plus the seat stop it starts (3 s + 0.5 s
    // for kills), with margin: firing early would cut the game's saves short.
    internal static readonly TimeSpan ForceExitDelay = TimeSpan.FromSeconds(20);

    private readonly Action<Action> _post;
    private readonly Action _quit;
    private readonly Action _forceExit;
    private readonly Action<TimeSpan, Action> _schedule;
    private readonly Action<string> _log;
    private int _started;

    internal HostTermQuitSequence(
        Action<Action> post,
        Action quit,
        Action? forceExit = null,
        Action<TimeSpan, Action>? schedule = null,
        Action<string>? log = null)
    {
        _post = post;
        _quit = quit;
        _forceExit = forceExit ?? HeadlessForceExit.Now;
        _schedule = schedule ?? ScheduleOnBackgroundThread;
        _log = log ?? CouchCoopLog.Info;
    }

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

        Log("windowed host received SIGTERM — queueing game quit.");
        try { _post(QuitOnMainThread); }
        catch (Exception exception)
        {
            Log($"windowed host SIGTERM quit dispatch failed: {exception.GetType().Name}: {exception.Message} — waiting for the force-exit backstop.");
        }
        // Once armed, keep TERM cancelled even if dispatch fails: default exit races live engine threads.
        return true;
    }

    private void QuitOnMainThread()
    {
        Log("windowed host SIGTERM: requesting game quit on the main thread.");
        try { _quit(); }
        catch (Exception exception)
        {
            Log($"windowed host SIGTERM game quit failed: {exception.GetType().Name}: {exception.Message} — waiting for the force-exit backstop.");
        }
    }

    private void Log(string message)
    {
        try { _log(message); }
        catch { /* Logging must not prevent the bounded exit. */ }
    }

    // Arm on the signal thread; pool starvation must not delay the independent backstop.
    private static void ScheduleOnBackgroundThread(TimeSpan delay, Action action)
    {
        new Thread(() =>
        {
            Thread.Sleep(delay);
            action();
        })
        {
            IsBackground = true,
            Name = "couchcoop-host-term-quit",
        }.Start();
    }
}
