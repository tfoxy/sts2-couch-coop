namespace CouchCoop.Mod.Runtime;

/// <summary>
/// Serializes the irreversible exit boundary with non-blocking engine queue insertion and registration.
/// Dispatcher admission is separate: callbacks can hop threads and must run outside the lock.
/// </summary>
internal sealed class HostExitGate(Action<string> log)
{
    private readonly object _sync = new();
    private int _exiting;
    private int _inFlight;
    private long _dropped;
    private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    internal bool IsExiting => Volatile.Read(ref _exiting) != 0;
    internal Task Exited => _exited.Task;
    internal long Dropped => Interlocked.Read(ref _dropped);
    internal int InFlight { get { lock (_sync) return _inFlight; } }

    internal void BeginExit()
    {
        lock (_sync)
        {
            Volatile.Write(ref _exiting, 1);
            _exited.TrySetResult();
        }
    }

    // Enqueue must only insert or register work, never dispatch it or wait for another thread.
    internal bool TryEnqueue(Action enqueue, bool quitReplay = false)
    {
        long dropped;
        lock (_sync)
        {
            if (!IsExiting || quitReplay)
            {
                enqueue();
                return true;
            }
            dropped = Interlocked.Increment(ref _dropped);
        }
        LogDrop(dropped);
        return false;
    }

    internal bool TryPost(Action dispatch)
    {
        long dropped = 0;
        lock (_sync)
        {
            if (IsExiting)
                dropped = Interlocked.Increment(ref _dropped);
            else
                _inFlight++;
        }
        if (dropped != 0)
        {
            LogDrop(dropped);
            return false;
        }
        // Dispatch may wait for another thread that re-enters admission. Never hold the gate across it.
        try { dispatch(); return true; }
        finally { lock (_sync) _inFlight--; }
    }

    private void LogDrop(long dropped)
    {
        if (dropped != 1) return;
        try { log($"host exiting: dropped main-thread work (count={dropped}; further drops counted silently)."); }
        catch { /* Exit admission must not depend on logging. */ }
    }
}
