namespace CouchCoop.Mod.Server;

/// <summary>
/// The static-background tracker's probe SCHEDULING, with every engine call injected: the fold that keeps at most
/// one deferred main-thread probe queued, and the single bounded follow-up an event-driven request earns.
/// </summary>
/// <remarks>
/// <para>
/// WHY IT IS ITS OWN TYPE. The tracker's probe runs on the Godot main thread behind a <c>CallDeferred</c> hop and
/// its follow-up behind a <c>SceneTreeTimer</c>, and neither exists in the test host (Godot loaded, no engine — a
/// real call segfaults). Everything here is plain bookkeeping over two injected delegates, so the folding and the
/// follow-up discipline are unit-testable; <see cref="CouchCoopStaticBackgroundTracker"/> binds the delegates to
/// the engine.
/// </para>
/// <para>
/// THE FOLD. <see cref="TrySchedule"/> queues the main-thread probe unless one is already queued; every request
/// before it runs folds into it, which is correct because the probe reads the LIVE tree and the LIVE desired-skip
/// flag and therefore answers for the newest state anyway.
/// </para>
/// <para>
/// THE FOLLOW-UP, and why it is bounded. An event-driven <see cref="Request"/> (the game's "the screen on top may
/// have changed" event) can land before the room has finished mounting what the probe looks for — an event
/// backdrop arrives a frame or more after the room announces itself. So the probe that answers a request arms ONE
/// one-shot timer, and its expiry probes once more. A request that arrives while that timer is pending does not
/// arm a second timer; it marks the pending one to re-arm once after it fires. Every timer is therefore paid for
/// by at least one game event: at idle there are no events, so nothing is armed and nothing polls.
/// </para>
/// <para>
/// THREADING. <see cref="TrySchedule"/>, <see cref="Request"/> and <see cref="CancelFollowUps"/> may be called
/// from any thread. <see cref="RunProbe"/> and the timer callback run on the main thread, which is the only
/// thread that touches the armed/re-arm pair.
/// </para>
/// </remarks>
internal sealed class CouchCoopStaticBackgroundProbeScheduler(
    Action scheduleOnMainThread,
    Func<Action, bool> armFollowUpTimer,
    Action<string> log)
{
    // 0/1: a probe is queued for the main thread and has not finished yet.
    private int _probeScheduled;

    // 0/1: a Request arrived since the last probe ran, so the next probe must arm (or re-arm) the follow-up.
    private int _followUpRequested;

    // Bumped by CancelFollowUps; a timer armed under an older epoch expires without probing.
    private int _followUpEpoch;

    // Main thread only: a follow-up timer is pending, and whether a request arrived while it was.
    private bool _followUpArmed;
    private bool _followUpRearm;

    /// <summary>Queue one main-thread probe unless one is already queued (any thread).</summary>
    /// <param name="origin">Names the caller in the one failure line (<c>static-bg {origin} scheduling failed</c>).</param>
    public void TrySchedule(string origin)
    {
        if (Interlocked.Exchange(ref _probeScheduled, 1) == 1)
        {
            return; // the queued probe answers for this request too
        }

        try
        {
            scheduleOnMainThread();
        }
        catch (Exception exception)
        {
            // No live tree to probe (a teardown race, or a host with no engine). Leave the published value alone:
            // only a real probe may set it.
            Volatile.Write(ref _probeScheduled, 0);
            log($"static-bg {origin} scheduling failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>
    /// An EVENT-DRIVEN request: queue a probe (folded like any other) and have that probe arm the follow-up. Any
    /// thread — and, on the live path, from inside the game's own screen transition, so this only ever schedules.
    /// </summary>
    public void Request()
    {
        Volatile.Write(ref _followUpRequested, 1);
        TrySchedule("probe request");
    }

    /// <summary>
    /// Forget any pending follow-up (any thread): its timer still fires, but expires without probing. Called when
    /// the event subscription goes away, so a stopped server generation cannot probe afterwards.
    /// </summary>
    public void CancelFollowUps()
    {
        Interlocked.Increment(ref _followUpEpoch);
        Volatile.Write(ref _followUpRequested, 0);
    }

    /// <summary>
    /// The body of the deferred main-thread hop: run <paramref name="probe"/>, release the fold, then arm the
    /// follow-up if a request asked for one. Main thread only.
    /// </summary>
    public void RunProbe(Action probe)
    {
        try
        {
            probe();
        }
        catch (Exception exception)
        {
            log($"static-bg probe failed: {exception.GetType().Name}: {exception.Message}");
        }
        finally
        {
            Volatile.Write(ref _probeScheduled, 0);
        }

        if (Interlocked.Exchange(ref _followUpRequested, 0) == 1)
        {
            ArmFollowUp();
        }
    }

    /// <summary>Test seam: whether a probe is queued and not yet finished.</summary>
    internal bool ProbeScheduledForTest => Volatile.Read(ref _probeScheduled) == 1;

    /// <summary>Test seam: whether a follow-up timer is pending.</summary>
    internal bool FollowUpArmedForTest => _followUpArmed;

    // Main thread only.
    private void ArmFollowUp()
    {
        if (_followUpArmed)
        {
            _followUpRearm = true; // the pending timer re-arms once after it fires; never a second concurrent timer
            return;
        }

        var epoch = Volatile.Read(ref _followUpEpoch);
        _followUpArmed = true;
        _followUpRearm = false;
        bool armed;
        try
        {
            armed = armFollowUpTimer(() => OnFollowUpElapsed(epoch));
        }
        catch (Exception exception)
        {
            armed = false;
            log($"static-bg follow-up scheduling failed: {exception.GetType().Name}: {exception.Message}");
        }

        if (!armed)
        {
            _followUpArmed = false; // nothing will call back, so nothing may stay marked pending
        }
    }

    // Main thread only (the timer's callback).
    private void OnFollowUpElapsed(int epoch)
    {
        _followUpArmed = false;
        var rearm = _followUpRearm;
        _followUpRearm = false;
        if (epoch != Volatile.Read(ref _followUpEpoch))
        {
            return; // cancelled while pending
        }

        if (rearm)
        {
            // A request landed while this timer was pending: the probe below arms exactly one more.
            Volatile.Write(ref _followUpRequested, 1);
        }

        TrySchedule("follow-up probe");
    }
}
