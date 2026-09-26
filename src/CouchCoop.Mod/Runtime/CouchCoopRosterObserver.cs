using System.Runtime.CompilerServices;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Runtime;

/// <summary>
/// Reads the roster once per burst of game signals and hands it on. It exists only while somebody needs to be told the
/// roster changed (a viewer parked on the join picker); it owns no timer, no recurring read and no backstop.
/// </summary>
/// <remarks>
/// <para>
/// PUSH ONLY. Every signal (see <see cref="GameRosterSignals"/>) does the same thing: it marks the roster dirty and, if
/// no read is already pending, asks for one on the game's next frame. Any number of signals before that frame, from any
/// thread, cost one read; a signal that lands during the read arms the next one. The read itself is deferred because the
/// signals arrive inside game callbacks, where reading the game faults the process (see <see cref="GameNextFrame"/>).
/// </para>
/// <para>
/// A read that fails (<see langword="null"/>: unavailable) is delivered as such and is NOT retried: the next signal is what
/// tries again. "Unavailable" is not "nobody is in the lobby", and the consumer must not act on it.
/// </para>
/// <para>
/// <see cref="Start"/> arms one read, which is the baseline. The delivery callback runs on whichever thread made the read
/// (the game main thread in production): it must not block, and hands any real work to another thread.
/// </para>
/// <para>
/// Main-thread-only members are the read and the deferral seam; everything else is safe from any thread. The type is
/// public so the browser server, which is compiled into every hot-reload generation, can reach the production factory
/// <see cref="Subscribe"/> through the project reference; the seams are the test surface.
/// </para>
/// </remarks>
public sealed class CouchCoopRosterObserver : IDisposable
{
    private static int _live;
    private static long _startedTotal;

    /// <summary>
    /// <c>COUCHCOOP_ROSTER_TRACE=1</c> logs each read's change signature to <c>godot.log</c>, so a live session can compare the
    /// last signature with the game's real roster at a settled checkpoint: a mismatch is a missed signal.
    /// </summary>
    private static readonly bool TraceReads = Environment.GetEnvironmentVariable("COUCHCOOP_ROSTER_TRACE") == "1";

    private readonly Func<Action, IDisposable?> _subscribeSignals;
    private readonly Func<RosterFacts?> _read;
    private readonly Action<Action> _scheduleNextFrame;
    private readonly Action<RosterFacts?> _onRoster;
    private IDisposable? _signals;
    private int _dirty;
    private int _started;
    private int _disposed;
    private long _reads;

    internal CouchCoopRosterObserver(
        Func<Action, IDisposable?> subscribeSignals,
        Func<RosterFacts?> read,
        Action<Action> scheduleNextFrame,
        Action<RosterFacts?> onRoster)
    {
        _subscribeSignals = subscribeSignals ?? throw new ArgumentNullException(nameof(subscribeSignals));
        _read = read ?? throw new ArgumentNullException(nameof(read));
        _scheduleNextFrame = scheduleNextFrame ?? throw new ArgumentNullException(nameof(scheduleNextFrame));
        _onRoster = onRoster ?? throw new ArgumentNullException(nameof(onRoster));
    }

    /// <summary>How many observers exist right now. The zero-client contract asserts this is 0 with nobody served.</summary>
    public static int LiveCount => Volatile.Read(ref _live);

    /// <summary>How many observers have ever started: the cumulative twin of <see cref="LiveCount"/>, for windows that compare deltas.</summary>
    public static long StartedCount => Interlocked.Read(ref _startedTotal);

    /// <summary>How many roster reads this observer has made: the count QA and the tests compare against the signals.</summary>
    internal long Reads => Interlocked.Read(ref _reads);

    /// <summary>
    /// Start observing the game, delivering each roster read to <paramref name="onRoster"/>. Dispose the result to stop.
    /// A use at zero demand is idle work and is reported by the zero-client tripwire.
    /// </summary>
    public static IDisposable Subscribe(
        Action<RosterFacts?> onRoster,
        [CallerMemberName] string? caller = null,
        [CallerFilePath] string? file = null)
    {
        ArgumentNullException.ThrowIfNull(onRoster);
        ZeroClientGuard.Enter(ZeroClientEntries.RosterSubscribe, caller, file);

        GameRosterSignals? signals = null;
        var observer = new CouchCoopRosterObserver(
            subscribeSignals: wake => signals = GameRosterSignals.Create(wake),
            read: () =>
            {
                signals?.BeforeRead();
                return CouchCoopGameFacts.ReadRoster();
            },
            scheduleNextFrame: GameNextFrame.Schedule,
            onRoster);
        observer.Start();
        return observer;
    }

    /// <summary>Attach the signals and arm the baseline read. Idempotent.</summary>
    internal void Start()
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            return;
        }

        Interlocked.Increment(ref _live);
        Interlocked.Increment(ref _startedTotal);
        try
        {
            _signals = _subscribeSignals(Wake);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster observer signals failed: {exception.GetType().Name}: {exception.Message}");
        }

        // Disposed while the signals were attaching: let go of them now.
        if (Volatile.Read(ref _disposed) != 0)
        {
            Interlocked.Exchange(ref _signals, null)?.Dispose();
            return;
        }

        Wake(); // the baseline: the first read compares against nothing
    }

    /// <summary>A signal: the roster may have changed. Safe from any thread, including a game callback.</summary>
    internal void Wake()
    {
        if (Volatile.Read(ref _disposed) != 0 || Interlocked.Exchange(ref _dirty, 1) != 0)
        {
            return; // stopped, or a read is already pending and will see whatever this signal saw
        }

        try
        {
            _scheduleNextFrame(Evaluate);
        }
        catch (Exception exception)
        {
            // The next signal must be able to arm a read, so give the mark back.
            Interlocked.Exchange(ref _dirty, 0);
            CouchCoopLog.Stderr($"roster observer scheduling failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void Evaluate()
    {
        // Clear the mark BEFORE reading: a signal that lands during the read must arm the next one.
        Interlocked.Exchange(ref _dirty, 0);
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        RosterFacts? roster;
        try
        {
            Interlocked.Increment(ref _reads);
            roster = _read();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster observer read failed: {exception.GetType().Name}: {exception.Message}");
            roster = null;
        }

        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        if (TraceReads)
        {
            CouchCoopLog.Info($"roster read #{Interlocked.Read(ref _reads)} {(roster is null ? "unavailable" : CouchCoopRosterChange.Signature(roster))}");
        }

        try
        {
            _onRoster(roster);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"roster observer delivery failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>Detach every signal. A read already scheduled finds the observer stopped and does nothing.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        Interlocked.Exchange(ref _signals, null)?.Dispose();
        if (Volatile.Read(ref _started) != 0)
        {
            Interlocked.Decrement(ref _live);
        }
    }
}
