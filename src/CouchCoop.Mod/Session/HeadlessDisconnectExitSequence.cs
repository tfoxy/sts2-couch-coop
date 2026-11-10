namespace CouchCoop.Mod.Session;

/// <summary>
/// The ordered shutdown a HEADLESS mirror instance runs when its connection to the host game is permanently gone
/// (see <see cref="Patches.HeadlessDisconnectExitPatch"/> for the trigger). Pure orchestration with every effect
/// injected, so the ordering/idempotence rules below are unit-tested without a game, a socket or a real process.
///
/// <para>THE ORDER IS THE CONTRACT:</para>
/// <list type="number">
///   <item><description>
///   ARM THE BACKSTOP FIRST. Everything after this point can hang — capture disarm needs the main loop, notify
///   awaits sockets, and exit logging can block. The force-exit timer is therefore armed BEFORE any of it, so a
///   hang can only delay the exit by <see cref="ForceExitDelay"/>, never prevent it. A headless nobody can see
///   must not be able to survive its own shutdown.
///   </description></item>
///   <item><description>
///   DISARM CAPTURE AND NOTIFY VIEWERS in parallel (best-effort, time-boxed). The browsers attached to THIS instance are about to lose their
///   socket; the last-gasp envelope is the only chance to tell them WHY, so they show the "the host must reload
///   the saved run" guidance and reconnect to the host instead of retrying this dead port. Bounded by
///   <see cref="NotifyTimeout"/> and never allowed to throw — a viewer that misses the message still sees the
///   socket close, which is the same outcome minus the copy.
///   </description></item>
///   <item><description>
///   LEAVE THE PROCESS after both disarm and notify finish or reach their bounds. Capture disarms first
///   (see <see cref="RenderStreamCaptureQuit"/>) to preserve its evidence. A refined-reason report already
///   started is bounded from its own start, overlapping notify and disarm, then the seat exits immediately
///   without <c>SceneTree.Quit()</c>, because the game's shutdown path faults on seats. The backstop remains
///   armed through the exit.
///   </description></item>
/// </list>
///
/// <para>
/// ONE-SHOT. The game can report several disconnects in a row (transport event, then a game-level handler's own
/// <c>Disconnect()</c> call), and the sequence must not re-enter: a second trigger logs and returns false without
/// re-arming a second force-exit timer or re-sending the last gasp.
/// </para>
///
/// <para>
/// ONE-SHOT IS NOT THE SAME AS ONE REASON, and conflating the two threw away the only useful diagnosis this seat
/// had. The two notifications do not carry equally good information and they do not arrive in a helpful order:
/// the TRANSPORT publishes a generic "the socket is gone" first and wins the race below, and the GAME's own
/// disconnect handler follows a beat later with the reason the host actually gave (observed on a seat the host
/// refused mid-run: <c>native-network-error</c> started the shutdown, then <c>RunInProgress</c> arrived and was
/// discarded with "already running — ignoring"). The host then had nothing to show the player but the generic
/// join copy — "check that game and mod versions match" — for a run the seat simply was not in. So a LATER
/// SPECIFIC reason now REFINES an earlier generic one (see <see cref="HeadlessDisconnectReason.IsSpecific"/>):
/// the shutdown itself does not restart, but the refined reason is logged and handed to the caller's
/// <c>refineReason</c> hook, which is what reports it upstream. Refinement happens at most once, and a second
/// generic reason never displaces a specific one.
/// </para>
/// </summary>
internal sealed class HeadlessDisconnectExitSequence
{
    /// <summary>
    /// Covers the parallel notify/disarm bounds, the bounded refinement report and margin for process exit.
    /// It remains a backstop: the healthy path exits before it elapses.
    /// </summary>
    public static readonly TimeSpan ForceExitDelay = TimeSpan.FromSeconds(7.5);

    public static readonly TimeSpan DisarmGuard = RenderStreamCaptureQuit.DisarmTimeout + TimeSpan.FromSeconds(0.5);

    /// <summary>Ceiling on last-gasp and refined-reason sends, so a stuck socket can't eat the force-exit budget.</summary>
    public static readonly TimeSpan NotifyTimeout = TimeSpan.FromSeconds(1);

    private readonly Func<string, CancellationToken, Task> _notifyViewers;
    private readonly Func<Task> _disarm;
    private readonly TimeSpan _disarmGuard;
    private readonly Action<string> _quit;
    private readonly Action _forceExit;
    private readonly Action<TimeSpan, Action> _schedule;
    private readonly Action<string> _log;
    private readonly Func<string, Task>? _refineReason;
    private readonly TimeSpan _forceExitDelay;
    private readonly TimeSpan _notifyTimeout;
    private readonly TimeProvider _timeProvider;
    private int _started;
    private readonly object _reasonGate = new();
    private string? _reason;
    private bool _refined;
    private Task? _refinementReport;

    /// <param name="notifyViewers">Sends the last-gasp envelope + closes viewer sockets (reason, cancellation).</param>
    /// <param name="quit">Leaves the process with the current reason (production: immediate process exit).</param>
    /// <param name="forceExit">The untrappable exit used when the process exit doesn't land in time.</param>
    /// <param name="schedule">Runs an action after a delay off the calling thread (production: a background thread).</param>
    /// <param name="refineReason">
    /// Called at most once, with a SPECIFIC reason that arrived after a generic one had already started the
    /// shutdown (see the class remarks). Production reports it upstream so the host can name the real cause;
    /// null simply keeps the refinement in the log. A report started before the quit step is awaited under
    /// the notify bound measured from the report's start; a later one is best-effort. Failures never prevent
    /// the exit.
    /// </param>
    public HeadlessDisconnectExitSequence(
        Func<string, CancellationToken, Task> notifyViewers,
        Action<string> quit,
        Action? forceExit = null,
        Action<TimeSpan, Action>? schedule = null,
        Action<string>? log = null,
        TimeSpan? forceExitDelay = null,
        TimeSpan? notifyTimeout = null,
        Func<string, Task>? refineReason = null,
        Func<Task>? disarm = null,
        TimeSpan? disarmGuard = null,
        TimeProvider? timeProvider = null)
    {
        _disarm = disarm ?? (() => Task.CompletedTask);
        _disarmGuard = disarmGuard ?? DisarmGuard;
        _refineReason = refineReason;
        _notifyViewers = notifyViewers ?? throw new ArgumentNullException(nameof(notifyViewers));
        _quit = quit ?? throw new ArgumentNullException(nameof(quit));
        _forceExit = forceExit ?? HeadlessForceExit.Now;
        _schedule = schedule ?? ScheduleOnBackgroundThread;
        // Default log goes to stderr and the per-slot godot.log: "why did this instance exit?" must remain
        // answerable from the artifact that outlives both the process and its launcher-side stdio capture.
        _log = log ?? HeadlessLog.Write;
        _forceExitDelay = forceExitDelay ?? ForceExitDelay;
        _notifyTimeout = notifyTimeout ?? NotifyTimeout;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    /// <summary>Whether the sequence has already been started (by any caller).</summary>
    public bool Started => Volatile.Read(ref _started) != 0;

    /// <summary>
    /// The best reason recorded so far — the one the shutdown started with, unless a more specific one arrived
    /// afterwards and refined it (see the class remarks). Null before the first trigger.
    /// </summary>
    public string? Reason { get { lock (_reasonGate) return _reason; } }

    /// <summary>
    /// Run the shutdown for <paramref name="reason"/> (a human-readable disconnect description that reaches the
    /// log AND the viewers). Returns false when the sequence was already started — the caller may fire this from
    /// several disconnect notifications without guarding.
    /// </summary>
    public async Task<bool> StartAsync(string reason)
    {
        if (Interlocked.Exchange(ref _started, 1) != 0)
        {
            // Already shutting down — but the reason may still be worth more than the one we started with.
            if (!TryRefineReason(reason))
            {
                _log($"headless disconnect-exit already running — ignoring reason={reason}");
            }

            return false;
        }

        lock (_reasonGate) _reason = reason;
        _log($"headless lost its host connection permanently (reason={reason}) — exiting.");

        // (1) Backstop first — see the class remarks. A throw here would leave us with no guaranteed exit at all,
        // so a failed arm degrades to "quit only" with a loud log rather than aborting the shutdown.
        try
        {
            _schedule(_forceExitDelay, ForceExitNow);
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit could not arm the force-exit backstop: {exception.GetType().Name}: {exception.Message}");
        }

        // (2) Start capture teardown beside the bounded last gasp, then wait for both.
        var disarm = StartDisarm();
        var guardedDisarm = disarm.WaitAsync(_disarmGuard, _timeProvider);
        await NotifyViewersAsync(reason).ConfigureAwait(false);
        try
        {
            await guardedDisarm.ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            _log($"headless disconnect-exit: capture disarm did not finish within {_disarmGuard} — quitting anyway.");
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit disarm failed: {exception.GetType().Name}: {exception.Message}");
        }

        // (3) Wait for a report already started, then leave with the best reason available at this step.
        Task? refinementReport;
        lock (_reasonGate) refinementReport = _refinementReport;
        if (refinementReport is not null)
        {
            await refinementReport.ConfigureAwait(false);
        }

        try
        {
            _quit(Reason ?? reason);
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit process exit failed: {exception.GetType().Name}: {exception.Message} — waiting for the force-exit backstop.");
        }

        return true;
    }

    /// <summary>
    /// Record <paramref name="reason"/> over the one the shutdown started with, when it is specific and that one
    /// was not, and tell the refinement hook. Returns whether it was taken.
    /// </summary>
    /// <remarks>
    /// AT MOST ONCE, and only ever generic→specific. The seat is seconds from exiting, so this must be a bounded
    /// amount of extra work no matter how many disconnect notifications the game produces; and a second specific
    /// reason is not better than the first, it is just later.
    /// </remarks>
    private bool TryRefineReason(string reason)
    {
        string previous;
        TaskCompletionSource<Task> report;
        lock (_reasonGate)
        {
            if (_refined
                || !HeadlessDisconnectReason.IsSpecific(reason)
                || HeadlessDisconnectReason.IsSpecific(_reason))
            {
                return false;
            }

            previous = _reason ?? "none";
            _reason = reason;
            _refined = true;
            // Publish the bounded report with the reason, before calling the hook outside the lock.
            report = new TaskCompletionSource<Task>(TaskCreationOptions.RunContinuationsAsynchronously);
            _refinementReport = ReportWithinNotifyTimeoutAsync(report.Task.Unwrap());
        }

        _log($"headless disconnect-exit reason refined: {previous} -> {reason}");
        try
        {
            report.SetResult(_refineReason?.Invoke(reason) ?? Task.CompletedTask);
        }
        catch (Exception exception)
        {
            report.SetResult(Task.CompletedTask);
            _log($"headless disconnect-exit could not report the refined reason: {exception.GetType().Name}: {exception.Message}");
        }

        return true;
    }

    private async Task ReportWithinNotifyTimeoutAsync(Task report)
    {
        try
        {
            await report.WaitAsync(_notifyTimeout, _timeProvider).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit could not report the refined reason: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private Task StartDisarm()
    {
        try
        {
            return _disarm();
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit disarm failed: {exception.GetType().Name}: {exception.Message}");
            return Task.CompletedTask;
        }
    }

    private async Task NotifyViewersAsync(string reason)
    {
        using var cancel = new CancellationTokenSource(_notifyTimeout, _timeProvider);
        try
        {
            // WaitAsync bounds a notify that ignores its token as well (the token alone is only a request).
            await _notifyViewers(reason, cancel.Token).WaitAsync(_notifyTimeout, _timeProvider).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            _log($"headless disconnect-exit last-gasp notify skipped: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private void ForceExitNow()
    {
        try
        {
            Task.Run(() => _log("headless disconnect-exit: process exit did not land — force-exiting."))
                .Wait(TimeSpan.FromMilliseconds(200));
        }
        catch
        {
            // Logging must never prevent the bounded exit.
        }

        _forceExit();
    }

    // A background thread (not a Timer) so it matches HeadlessHostWatchdog's shape and, being IsBackground, never
    // keeps the process alive on its own: if the process exit lands, this thread simply dies with the process.
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
