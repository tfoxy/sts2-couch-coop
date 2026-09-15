namespace CouchCoop.Mod.Session;

/// <summary>
/// The ordered shutdown a HEADLESS mirror instance runs when its connection to the host game is permanently gone
/// (see <see cref="Patches.HeadlessDisconnectExitPatch"/> for the trigger). Pure orchestration with every effect
/// injected, so the ordering/idempotence rules below are unit-tested without a game, a socket or a real process.
///
/// <para>THE ORDER IS THE CONTRACT:</para>
/// <list type="number">
///   <item><description>
///   ARM THE BACKSTOP FIRST. Everything after this point can hang — the notify awaits sockets, and
///   <c>SceneTree.Quit()</c> asks a game whose main loop may already be wedged behind the (now suppressed) network
///   error modal, a native FMOD/ENet teardown, or a save flush. The force-exit timer is therefore armed BEFORE any
///   of it, so a hang can only delay the exit by <see cref="ForceExitDelay"/>, never prevent it. This is the whole
///   reason the sequence exists rather than a bare <c>Quit()</c> call: a headless nobody can see must not be able
///   to survive its own shutdown.
///   </description></item>
///   <item><description>
///   NOTIFY VIEWERS (best-effort, time-boxed). The browsers attached to THIS instance are about to lose their
///   socket; the last-gasp envelope is the only chance to tell them WHY, so they show the "the host must reload
///   the saved run" guidance and reconnect to the host instead of retrying this dead port. Bounded by
///   <see cref="NotifyTimeout"/> and never allowed to throw — a viewer that misses the message still sees the
///   socket close, which is the same outcome minus the copy.
///   </description></item>
///   <item><description>
///   QUIT CLEANLY. A deferred <c>SceneTree.Quit()</c> lets Godot unwind on its own main loop (mod shutdown, FMOD,
///   the user profile) instead of being shot in the head. If it lands, the process is gone long before the
///   backstop fires.
///   </description></item>
/// </list>
///
/// <para>
/// ONE-SHOT. The game can report several disconnects in a row (transport event, then a game-level handler's own
/// <c>Disconnect()</c> call), and the sequence must not re-enter: a second trigger logs and returns false without
/// re-arming a second force-exit timer or re-sending the last gasp.
/// </para>
/// </summary>
internal sealed class HeadlessDisconnectExitSequence
{
    /// <summary>
    /// How long a clean quit gets before we SIGKILL. Long enough for Godot's normal teardown (which on this box
    /// takes well under a second for a headless), short enough that a wedged instance doesn't outlive the run it
    /// was serving. It is a BACKSTOP, not a schedule: the healthy path exits long before it elapses.
    /// </summary>
    public static readonly TimeSpan ForceExitDelay = TimeSpan.FromSeconds(5);

    /// <summary>Ceiling on the best-effort last-gasp send, so a stuck socket can't eat the force-exit budget.</summary>
    public static readonly TimeSpan NotifyTimeout = TimeSpan.FromSeconds(1);

    private readonly Func<string, CancellationToken, Task> _notifyViewers;
    private readonly Action _quit;
    private readonly Action _forceExit;
    private readonly Action<TimeSpan, Action> _schedule;
    private readonly Action<string> _log;
    private readonly TimeSpan _forceExitDelay;
    private readonly TimeSpan _notifyTimeout;
    private int _started;

    /// <param name="notifyViewers">Sends the last-gasp envelope + closes viewer sockets (reason, cancellation).</param>
    /// <param name="quit">Requests the clean game shutdown (production: a deferred <c>SceneTree.Quit()</c>).</param>
    /// <param name="forceExit">The untrappable exit used when the clean quit doesn't land in time.</param>
    /// <param name="schedule">Runs an action after a delay off the calling thread (production: a background thread).</param>
    public HeadlessDisconnectExitSequence(
        Func<string, CancellationToken, Task> notifyViewers,
        Action quit,
        Action? forceExit = null,
        Action<TimeSpan, Action>? schedule = null,
        Action<string>? log = null,
        TimeSpan? forceExitDelay = null,
        TimeSpan? notifyTimeout = null)
    {
        _notifyViewers = notifyViewers ?? throw new ArgumentNullException(nameof(notifyViewers));
        _quit = quit ?? throw new ArgumentNullException(nameof(quit));
        _forceExit = forceExit ?? HeadlessForceExit.Now;
        _schedule = schedule ?? ScheduleOnBackgroundThread;
        // Default log goes to stderr and the per-slot godot.log: "why did this instance exit?" must remain
        // answerable from the artifact that outlives both the process and its launcher-side stdio capture.
        _log = log ?? HeadlessLog.Write;
        _forceExitDelay = forceExitDelay ?? ForceExitDelay;
        _notifyTimeout = notifyTimeout ?? NotifyTimeout;
    }

    /// <summary>Whether the sequence has already been started (by any caller).</summary>
    public bool Started => Volatile.Read(ref _started) != 0;

    /// <summary>
    /// Run the shutdown for <paramref name="reason"/> (a human-readable disconnect description that reaches the
    /// log AND the viewers). Returns false when the sequence was already started — the caller may fire this from
    /// several disconnect notifications without guarding.
    /// </summary>
    public async Task<bool> StartAsync(string reason)
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            _log($"[couchcoop] headless disconnect-exit already running — ignoring reason={reason}");
            return false;
        }

        _log($"[couchcoop] headless lost its host connection permanently (reason={reason}) — exiting.");

        // (1) Backstop first — see the class remarks. A throw here would leave us with no guaranteed exit at all,
        // so a failed arm degrades to "quit only" with a loud log rather than aborting the shutdown.
        try
        {
            _schedule(_forceExitDelay, ForceExitNow);
        }
        catch (Exception exception)
        {
            _log($"[couchcoop] headless disconnect-exit could not arm the force-exit backstop: {exception.GetType().Name}: {exception.Message}");
        }

        // (2) Best-effort, time-boxed last gasp to the attached viewers.
        await NotifyViewersAsync(reason).ConfigureAwait(false);

        // (3) Clean quit.
        try
        {
            _quit();
        }
        catch (Exception exception)
        {
            _log($"[couchcoop] headless disconnect-exit clean quit failed: {exception.GetType().Name}: {exception.Message} — waiting for the force-exit backstop.");
        }

        return true;
    }

    private async Task NotifyViewersAsync(string reason)
    {
        using var cancel = new CancellationTokenSource(_notifyTimeout);
        try
        {
            // WaitAsync bounds a notify that ignores its token as well (the token alone is only a request).
            await _notifyViewers(reason, cancel.Token).WaitAsync(_notifyTimeout).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            _log($"[couchcoop] headless disconnect-exit last-gasp notify skipped: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void ForceExitNow()
    {
        _log("[couchcoop] headless disconnect-exit: clean quit did not land — force-exiting.");
        _forceExit();
    }

    // A background thread (not a Timer) so it matches HeadlessHostWatchdog's shape and, being IsBackground, never
    // keeps the process alive on its own: if the clean quit lands, this thread simply dies with the process.
    private static void ScheduleOnBackgroundThread(TimeSpan delay, Action action)
    {
        var thread = new Thread(() =>
        {
            Thread.Sleep(delay);
            action();
        })
        {
            IsBackground = true,
            Name = "couchcoop-disconnect-exit",
        };
        thread.Start();
    }
}
