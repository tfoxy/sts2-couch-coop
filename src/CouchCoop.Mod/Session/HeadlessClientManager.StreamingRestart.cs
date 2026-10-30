using System.Globalization;
using System.Net.Sockets;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>
/// What a viewer's "Use new renderer (Beta)" request did to their seat, carried on the host connection's
/// <c>session</c> envelope as <c>rendererSeat</c> (null: nothing to say). <see cref="State"/> is one of
/// <see cref="SeatRendererStates"/>; <see cref="Reason"/> a stable code the page maps to its own sentence; and
/// <see cref="Detail"/> English evidence for the host's report.
/// </summary>
public sealed record SeatRendererState(string State, string? Reason = null, string? Detail = null);

/// <summary>The <see cref="SeatRendererState.State"/> values and the refusal/failure codes.</summary>
public static class SeatRendererStates
{
    /// <summary>The seat is being restarted as the streaming seat.</summary>
    public const string Restarting = "restarting";
    /// <summary>A run is in progress: the restart waits for the run to end (MIR-F §8, option a).</summary>
    public const string Pending = "pending";
    /// <summary>A precondition refused the restart; the old seat runs on untouched.</summary>
    public const string Refused = "refused";
    /// <summary>The restart was tried and the seat came back as a normal seat (or not at all).</summary>
    public const string Failed = "failed";

    public const string NoCapture = "no-capture";
    public const string AnotherSeatStreaming = "another-seat-streaming";
    public const string HubPortTaken = "hub-port-taken";
    public const string SeatBusy = "seat-busy";
    public const string CaptureNotStarted = "capture-not-started";
    public const string RoleDropped = "role-dropped";
    public const string LaunchFailed = "launch-failed";
    public const string StopFailed = "stop-failed";
}

/// <summary>
/// "Use new renderer (Beta)" turned on while the viewer's seat already runs as a normal seat (MIR-4; design:
/// docs/agents/handoff-mirror-new-renderer.md §8). The role is fixed at a seat's launch, so the seat is restarted:
/// every precondition is checked BEFORE anything is killed; mid-run the restart is staged until the run ends, because
/// the game refuses any peer that is not already connected once a run has begun; a failed relaunch falls back to a
/// normal seat. The state per slot is what the viewer's page shows under the checkbox.
/// </summary>
public sealed partial class HeadlessClientManager
{
    // Per SLOT, not per browser session: the browser re-opens its host socket (a new session) whenever its seat socket
    // drops, which is exactly what a restart does, and the new session must still see the restart it asked for.
    private readonly Dictionary<int, SeatRendererState> _seatRenderer = [];
    // The aspect (width / height of the viewer's stream box) the slot's viewer last asked for the streaming seat with,
    // in the join or in `set-renderer` (PRES-A). Read when a streaming launch of the slot builds its environment;
    // absent means the 16:9 base. Per slot for the same reason as _seatRenderer. Under _lock.
    private readonly Dictionary<int, double> _streamingAspect = [];
    private Task? _streamingRestart;

    /// <summary>
    /// Raised (off <c>_lock</c>, on the thread pool) when any slot's <see cref="SeatRendererState"/> changes, so the
    /// server can re-send the sessions that carry it.
    /// </summary>
    public event Action? SeatRendererChanged;

    /// <summary>The restart in flight (relaunch and any fallback), for the unit suite to await. Null when none.</summary>
    internal Task? StreamingRestartTask
    {
        get { lock (_lock) return _streamingRestart; }
    }

    /// <summary>What the page of <paramref name="sessionId"/> is told about its seat's renderer request, or null.</summary>
    public SeatRendererState? SeatRendererStateFor(Guid sessionId)
    {
        lock (_lock)
        {
            return _sessionToSlot.TryGetValue(sessionId, out var slot) ? _seatRenderer.GetValueOrDefault(slot) : null;
        }
    }

    /// <summary>
    /// <see cref="RequestStreamingSeatAsync(Guid, CancellationToken)"/> with the aspect of the viewer's stream box
    /// (null: none was sent, i.e. their Widescreen stretch is off), recorded for the slot first so the restart — or
    /// the staged one, or the slot's next streaming launch — launches the seat at that width
    /// (<see cref="StreamingSeatLaunch.PresentationWidth"/>). A seat that already streams is NOT restarted for a new
    /// aspect: its stream letterboxes until the seat's next start (re-launching on a changed aspect is PRES-R).
    /// </summary>
    public Task<SeatRendererState?> RequestStreamingSeatAsync(Guid sessionId, double? aspect, CancellationToken ct)
    {
        lock (_lock)
        {
            if (!_disposed && _sessionToSlot.TryGetValue(sessionId, out var slot)) RecordStreamingAspectLocked(slot, aspect);
        }

        return RequestStreamingSeatAsync(sessionId, ct);
    }

    /// <summary>The presentation width a streaming launch of <paramref name="slot"/> gets now.</summary>
    internal int StreamingSeatPresentationWidth(int slot)
    {
        lock (_lock) return StreamingSeatPresentationWidthLocked(slot);
    }

    private int StreamingSeatPresentationWidthLocked(int slot)
        => StreamingSeatLaunch.PresentationWidth(
            _streamingAspect.TryGetValue(slot, out var aspect) ? aspect : null,
            _streamingConfig?.MaxPresentationWidth ?? StreamingSeatLaunch.DefaultMaxPresentationWidth);

    // Only a usable aspect is kept; anything else (none, not finite, out of range) is the base width, so it is dropped.
    private void RecordStreamingAspectLocked(int slot, double? aspect)
    {
        if (aspect is double value && double.IsFinite(value)
            && value >= StreamingSeatLaunch.MinAspect && value <= StreamingSeatLaunch.MaxAspect)
        {
            _streamingAspect[slot] = value;
        }
        else
        {
            _streamingAspect.Remove(slot);
        }
    }

    /// <summary>
    /// The viewer of <paramref name="sessionId"/> turned the new renderer ON: make their own seat the streaming seat.
    /// Returns the state the page should show right away (null: nothing to do — the seat already streams, or this
    /// session holds no seat). Never waits for the relaunch: that runs on <see cref="StreamingRestartTask"/>.
    /// </summary>
    public async Task<SeatRendererState?> RequestStreamingSeatAsync(Guid sessionId, CancellationToken ct)
    {
        // Settled before _lock, like every probe the join reads (see EnsureHeadlessAsync's ordering rule).
        var runInProgress = RunInProgress;
        int slot;
        IHeadlessProcess process;
        lock (_lock)
        {
            if (_disposed || !_sessionToSlot.TryGetValue(sessionId, out slot)) return null;
            if (_seatRenderer.GetValueOrDefault(slot) is { State: SeatRendererStates.Restarting } inFlight) return inFlight;
            if (_streamingSlot == slot && StreamingSeatTakenLocked(exceptSlot: null)) return ClearSeatRendererLocked(slot);
            if (RestartRefusalLocked(slot, out process) is { } refusal) return SetSeatRendererLocked(slot, refusal);
        }

        var hubPort = StreamingSeatLaunch.HubPortForSlot(slot);
        var hubOwner = await _seatPortProbe(hubPort, ct).ConfigureAwait(false);
        lock (_lock)
        {
            if (hubOwner is not null)
            {
                return SetSeatRendererLocked(slot, new(SeatRendererStates.Refused, SeatRendererStates.HubPortTaken,
                    $"The streaming port 127.0.0.1:{hubPort.ToString(CultureInfo.InvariantCulture)} is in use: {hubOwner}"));
            }

            // Everything may have moved while the port was probed: re-check against the same process.
            if (_disposed || !_sessionToSlot.TryGetValue(sessionId, out var again) || again != slot
                || !_processBySlot.TryGetValue(slot, out var current) || !ReferenceEquals(current, process))
            {
                return null;
            }
            if (_seatRenderer.GetValueOrDefault(slot) is { State: SeatRendererStates.Restarting } raced) return raced;
            if (RestartRefusalLocked(slot, out _) is { } late) return SetSeatRendererLocked(slot, late);

            if (runInProgress)
            {
                // Killing the seat now would drop this player out of the run until the host reloads the save. The wish
                // is recorded instead: the roster hook applies it once the run is over (ApplyStagedStreamingSeats), and
                // a launch of this slot in the meantime (a respawn in the load-saved-run lobby) honours it.
                CouchCoopLog.Stderr($"streaming seat restart staged slot={slot} pid={SlotPidLocked(slot)}: a run is in progress");
                ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "renderer", "streaming seat restart staged until the run ends");
                return SetSeatRendererLocked(slot, new(SeatRendererStates.Pending));
            }

            return BeginRestartLocked(slot, sessionId);
        }
    }

    /// <summary>
    /// The viewer of <paramref name="sessionId"/> turned the new renderer OFF. A staged restart is dropped and a
    /// refusal or failure is withdrawn. A running seat is never restarted for this: a streaming seat serves the old
    /// renderer too, and the role lapses at its next start (the join then asks for nothing). A restart already under
    /// way finishes.
    /// </summary>
    public SeatRendererState? CancelStreamingSeatRequest(Guid sessionId)
    {
        lock (_lock)
        {
            if (_disposed || !_sessionToSlot.TryGetValue(sessionId, out var slot)) return null;
            var state = _seatRenderer.GetValueOrDefault(slot);
            if (state is { State: SeatRendererStates.Restarting }) return state;
            if (state is not null) CouchCoopLog.Stderr($"streaming seat request withdrawn slot={slot} (was {state.State})");
            return ClearSeatRendererLocked(slot);
        }
    }

    /// <summary>
    /// The run is over (the roster hook saw no run): start every staged restart whose seat still runs and still has
    /// its viewer. A staged seat whose process already went away (a run's end disconnects the seats) is left to its
    /// next launch, which honours the wish. Cheap when nothing is staged.
    /// </summary>
    public void ApplyStagedStreamingSeats()
    {
        List<Guid> due;
        lock (_lock)
        {
            if (_disposed || !_seatRenderer.Values.Any(state => state.State == SeatRendererStates.Pending)) return;
            due = [];
            foreach (var (slot, state) in _seatRenderer)
            {
                if (state.State != SeatRendererStates.Pending || !_processBySlot.TryGetValue(slot, out var process)
                    || ProcessExited(process)) continue;
                var session = _sessionToSlot.Where(pair => pair.Value == slot).Select(pair => pair.Key).FirstOrDefault();
                if (session != Guid.Empty) due.Add(session);
            }
        }

        foreach (var session in due)
        {
            _ = Task.Run(async () =>
            {
                try
                {
                    await RequestStreamingSeatAsync(session, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    CouchCoopLog.Stderr($"staged streaming seat restart failed: {exception.GetType().Name}: {exception.Message}");
                }
            });
        }
    }

    // Preconditions 1-2 and the seat's own health (MIR-F §8). The hub port (3) and the run (4) are asked by the caller.
    private SeatRendererState? RestartRefusalLocked(int slot, out IHeadlessProcess process)
    {
        process = null!;
        if (_streamingConfig is null)
        {
            return new(SeatRendererStates.Refused, SeatRendererStates.NoCapture, "This host has no render capture configured.");
        }
        if (StreamingSeatTakenLocked(slot))
        {
            return new(SeatRendererStates.Refused, SeatRendererStates.AnotherSeatStreaming,
                $"Slot {_streamingSlot?.ToString(CultureInfo.InvariantCulture)} is this host's streaming seat; only one seat streams per host.");
        }
        if (!_processBySlot.TryGetValue(slot, out var live) || ProcessExited(live)
            || _connectionCleanup.ContainsKey(slot)
            || _ownedConnections.GetValueOrDefault(slot) is { Quarantined: true })
        {
            return new(SeatRendererStates.Refused, SeatRendererStates.SeatBusy,
                "This player's game is not running steadily right now (starting, stopping or being cleaned up).");
        }
        process = live;
        return null;
    }

    private SeatRendererState BeginRestartLocked(int slot, Guid sessionId)
    {
        var name = ClaimedNameForSlotLocked(slot);
        var pid = SlotPidLocked(slot);
        // The old seat goes first, by its own handle: its browser port, hub port and netId must be free for the new
        // one. Retiring its connection with it keeps its monitor from reporting the exit as a failure (which would
        // drop the name claim this restart keeps, and with it the player's netId).
        if (!ShutdownSlotLocked(slot, graceful: false))
        {
            CouchCoopLog.Stderr($"streaming seat restart slot={slot} pid={pid}: the old seat did not stop");
            return SetSeatRendererLocked(slot, new(SeatRendererStates.Failed, SeatRendererStates.StopFailed,
                "The player's running game could not be stopped, so it was not restarted."));
        }

        CouchCoopLog.Stderr($"streaming seat restart slot={slot} oldPid={pid} netId={SlotToNetId(slot)} name={name}");
        ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "renderer", $"restarting the seat as the streaming seat (old pid {pid})");
        var state = SetSeatRendererLocked(slot, new(SeatRendererStates.Restarting));
        _streamingRestart = Task.Run(() => RelaunchStreamingSeatAsync(slot, sessionId, name));
        return state;
    }

    private async Task RelaunchStreamingSeatAsync(int slot, Guid sessionId, string? name)
    {
        string? failureCode = null;
        string? failureDetail = null;
        var needsFallback = false;
        try
        {
            var port = await EnsureHeadlessAsync(sessionId, name, CancellationToken.None, allowNewSlot: true,
                targetNetId: SlotToNetId(slot), wantsStreamingSeat: true, relaunch: true).ConfigureAwait(false);
            bool streaming;
            lock (_lock) streaming = _streamingSlot == slot && StreamingSeatTakenLocked(exceptSlot: null);
            if (port is null)
            {
                failureCode = SeatRendererStates.LaunchFailed;
                failureDetail = ConnectionRegistry.Shared.Snapshot().Rows.FirstOrDefault(row => row.Id == sessionId)?.Issue is { } issue
                    ? issue.Summary : "The restarted game did not become ready.";
                needsFallback = true;
            }
            else if (!streaming)
            {
                // LaunchReal dropped the role (the hub port was taken at launch): the seat is already a normal one.
                failureCode = SeatRendererStates.RoleDropped;
                failureDetail = "The game restarted as a normal seat: the streaming capture could not be set up for it.";
            }
            else if (!await HubListensAsync(StreamingSeatLaunch.HubPortForSlot(slot)).ConfigureAwait(false))
            {
                // The seat runs with the streaming role (no texture evictor) but no capture: it would draw the old
                // renderer at the streaming seat's memory cost and never stream. Relaunch it as a normal seat.
                failureCode = SeatRendererStates.CaptureNotStarted;
                failureDetail = "The restarted game never opened its render stream (the capture did not load).";
                needsFallback = true;
            }
        }
        catch (Exception exception)
        {
            failureCode = SeatRendererStates.LaunchFailed;
            failureDetail = $"{exception.GetType().Name}: {exception.Message}";
            needsFallback = true;
        }

        if (failureCode is null)
        {
            lock (_lock) ClearSeatRendererLocked(slot);
            CouchCoopLog.Stderr($"streaming seat restart slot={slot}: streaming");
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "renderer", "seat restarted as the streaming seat");
            return;
        }

        CouchCoopLog.Stderr($"streaming seat restart slot={slot} failed ({failureCode}): {failureDetail}"
            + (needsFallback ? "; relaunching a normal seat" : string.Empty));
        ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "renderer", $"seat-restart-failed: {failureCode}: {failureDetail}");
        // Recorded BEFORE the fallback launch: a launch honours a pending or restarting wish, and this one must not.
        lock (_lock) SetSeatRendererLocked(slot, new(SeatRendererStates.Failed, failureCode, failureDetail));
        if (!needsFallback) return;

        try
        {
            lock (_lock)
            {
                // A streaming process that came up without its hub is stopped first, as the restart stopped the old one.
                if (_processBySlot.ContainsKey(slot) && !ShutdownSlotLocked(slot, graceful: false))
                {
                    CouchCoopLog.Stderr($"streaming seat fallback slot={slot}: the capture-less seat did not stop");
                    return;
                }
            }
            var port = await EnsureHeadlessAsync(sessionId, name, CancellationToken.None, allowNewSlot: true,
                targetNetId: SlotToNetId(slot), wantsStreamingSeat: false, relaunch: true).ConfigureAwait(false);
            CouchCoopLog.Stderr($"streaming seat fallback slot={slot}: normal seat {(port is null ? "not ready" : "ready")}");
        }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"streaming seat fallback slot={slot} failed: {exception.GetType().Name}: {exception.Message}");
        }
    }

    // Whether the streaming seat's capture opened its hub. Asked once the seat is READY (the capture listens from
    // engine start, long before the seat joins the lobby), with a short bounded grace for a slow machine.
    private async Task<bool> HubListensAsync(int hubPort)
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            if (await _streamingHubProbe(hubPort, CancellationToken.None).ConfigureAwait(false)) return true;
            await Task.Delay(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
        }
        return false;
    }

    // A plain loopback connect: true when something accepts on the port. Closes at once, before any request.
    private static async Task<bool> DefaultStreamingHubProbeAsync(int port, CancellationToken ct)
    {
        try
        {
            using var client = new TcpClient();
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(1));
            await client.ConnectAsync("127.0.0.1", port, deadline.Token).ConfigureAwait(false);
            return true;
        }
        catch
        {
            return false;
        }
    }

    // A launch of `slot` is the streaming seat's when its viewer asked in the join OR asked mid-session (a restart in
    // flight, or a staged one whose seat is being respawned anyway — the load-saved-run lobby).
    private bool SlotWantsStreamingLocked(int slot)
        => _seatRenderer.GetValueOrDefault(slot)?.State is SeatRendererStates.Pending or SeatRendererStates.Restarting;

    // A streaming launch satisfied a staged wish on its own (a respawn): nothing is pending any more.
    private void SettleStagedWishLocked(int slot)
    {
        if (_seatRenderer.GetValueOrDefault(slot) is { State: SeatRendererStates.Pending }) ClearSeatRendererLocked(slot);
    }

    // A different player taking the slot drops its holder's request (and the aspect it came with), unless a restart is
    // under way on it.
    private void ForgetSeatRendererForClaimLocked(int slot)
    {
        if (_seatRenderer.GetValueOrDefault(slot) is { State: SeatRendererStates.Restarting }) return;
        ClearSeatRendererLocked(slot);
        _streamingAspect.Remove(slot);
    }

    private SeatRendererState SetSeatRendererLocked(int slot, SeatRendererState state)
    {
        if (_seatRenderer.GetValueOrDefault(slot) != state)
        {
            _seatRenderer[slot] = state;
            QueueSeatRendererChangedLocked();
        }
        return state;
    }

    private SeatRendererState? ClearSeatRendererLocked(int slot)
    {
        if (_seatRenderer.Remove(slot)) QueueSeatRendererChangedLocked();
        return null;
    }

    private void QueueSeatRendererChangedLocked()
    {
        var handler = SeatRendererChanged;
        if (handler is null) return;
        _ = Task.Run(() =>
        {
            try { handler(); }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"seat renderer change notification failed: {exception.GetType().Name}: {exception.Message}");
            }
        });
    }
}
