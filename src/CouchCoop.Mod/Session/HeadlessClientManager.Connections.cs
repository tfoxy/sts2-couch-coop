using System.Diagnostics;
using System.Security.Cryptography;
using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

public sealed partial class HeadlessClientManager
{
    /// <summary>
    /// The connection issue a seat that loaded a different CouchCoop build than its host is reported as.
    /// Public because the report copy, the host panel's issue mapping and the registry's confirmed-cause rule
    /// all key on the literal, and three spellings of it would drift.
    /// </summary>
    public const string SeatBuildMismatchCode = "seat-build-mismatch";

    /// <summary>
    /// The host-service issue a session runs under when its seats get no isolated Godot user directory — a
    /// WARNING, not a failure: co-op works, but every player on this machine shares one <c>godot.log</c> and one
    /// settings/save profile. Public for the same reason as the code above: the panel's copy keys on the literal.
    /// </summary>
    public const string SharedUserDirCode = "host-seat-profile-shared";

    private readonly Dictionary<int, OwnedConnection> _ownedConnections = [];
    private readonly Dictionary<Guid, BrowserAttempt> _browserAttempts = [];
    private readonly Dictionary<int, Task> _connectionCleanup = [];
    private Func<ulong, bool>? _membershipProbe;
    private Func<int>? _controlPort;
    private long _processGeneration;

    internal void ConfigureConnectionMonitoring(Func<ulong, bool> membershipProbe, Func<int> controlPort)
    {
        HeadlessConnectionControl.Shared.StatusChanged -= OnChildStatus;
        HeadlessConnectionControl.Shared.StatusChanged += OnChildStatus;
        _membershipProbe = membershipProbe;
        _controlPort = controlPort;
    }

    public async Task<int?> EnsureHeadlessAsync(Guid sessionId, string? displayName, CancellationToken ct,
        bool allowNewSlot = true, Action<ulong, string?>? onSlotBound = null, ulong? targetNetId = null)
    {
        Task[] cleanup;
        lock (_lock) cleanup = _connectionCleanup.Values.ToArray();
        await Task.WhenAll(cleanup).WaitAsync(ct).ConfigureAwait(false);
        await CleanupExitedConnectionsAsync(ct).ConfigureAwait(false);
        ConnectionRegistry.Shared.ConfigureView(sessionId, requiresChild: true, reused: true);
        var launchLogs = ConnectionAttemptLogs.CaptureStart(ConnectionRegistry.HostLogPath, null);
        // BOTH of these are settled BEFORE _lock is taken, and for the same reason: MaxSlot's probe marshals to
        // the game's main thread, and the port survey can block on a dropped packet. The main thread takes _lock
        // on every screen change, so either one evaluated under it stalls (MaxSlot deadlocks) the game.
        var maxSlot = MaxSlot;
        var occupiedSeatPorts = await SurveySeatPortsAsync(maxSlot, displayName, targetNetId, ct).ConfigureAwait(false);
        foreach (var (occupiedSlot, owner) in occupiedSeatPorts)
        {
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, $"seat port {SlotToPort(occupiedSlot)}", owner);
        }
        HeadlessAllocation? allocation;
        try
        {
            allocation = AllocateHeadless(
                sessionId, displayName, ct, maxSlot, occupiedSeatPorts, allowNewSlot, onSlotBound, targetNetId);
        }
        catch
        {
            foreach (var log in await launchLogs.ReadErrorsAsync().ConfigureAwait(false))
                ConnectionRegistry.Shared.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            throw;
        }
        var port = allocation?.Port;
        if (port is null)
        {
            foreach (var log in await launchLogs.ReadErrorsAsync().ConfigureAwait(false))
                ConnectionRegistry.Shared.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            return null;
        }
        var slot = (port.Value - HostPort) / PortStep;
        if (_membershipProbe is null) return allocation!.NewProcess
            ? await WaitForReadyAsync(slot, sessionId, ct).ConfigureAwait(false) : port;
        OwnedConnection? owned;
        var unusable = false;
        lock (_lock)
        {
            if (!_ownedConnections.TryGetValue(slot, out owned) || !_processBySlot.TryGetValue(slot, out var process)) return null;
            owned.Process = process;
            if (owned.Quarantined)
                unusable = true;
            else if (ProcessExited(process))
            {
                owned.Failure ??= ProcessExitedIssue(process);
                unusable = true;
            }
            else
            {
                _browserAttempts[sessionId] = new(slot, owned.Generation, ConnectionRegistry.Shared.AttemptId(sessionId));
                if (!owned.MonitorStarted) { owned.MonitorStarted = true; _ = Task.Run(() => MonitorConnectionAsync(owned)); }
            }
        }
        if (unusable)
        {
            if (owned!.Quarantined)
            {
                ConnectionRegistry.Shared.Fail(sessionId, "seat-cleanup-pending",
                    "A previous client process still owns this seat.",
                    "Wait for that process to exit, or restart the host before retrying.", owned.QuarantineReason);
            }
            else await StopFailedConnectionAsync(owned).ConfigureAwait(false);
            return null;
        }
        ConnectionRegistry.Shared.BindProcess(sessionId, owned.Process.Id, owned.Generation);
        ConnectionRegistry.Shared.BindLogs(sessionId, owned.Logs);
        ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "process", $"pid={owned.Process.Id}; slot={slot}; generation={owned.Generation}; netId={SlotToNetId(slot)}");
        var started = Stopwatch.GetTimestamp();
        var deadline = SeatReadyTimeout;
        // The verdict is rebuilt from the host's own facts on every pass and replaces the one sentence that used
        // to end in "child HTTP listener: not responding" for three unrelated causes. See SeatReadinessVerdict.
        var verdict = SeatReadinessVerdict.Describe(
            ReadinessFacts(owned, null, member: false, port.Value, started, deadline));
        while (Stopwatch.GetElapsedTime(started) < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsCurrent(owned)) return null;
            if (owned.Failure is not null || owned.Quarantined) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return null; }
            var status = HeadlessConnectionControl.Shared.Snapshot(slot, owned.Generation);
            var member = _membershipProbe(SlotToNetId(slot));
            var fresh = status is not null && Fresh(status);
            verdict = SeatReadinessVerdict.Describe(ReadinessFacts(owned, status, member, port.Value, started, deadline));
            ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", verdict.Detail));
            LogCauseChange(owned, verdict);
            if (verdict.Cause == SeatReadinessCause.PortConflict)
            {
                // The seat says it bound a port that is not the one we hand the browser. Nothing downstream can
                // recover from that, and waiting out the deadline would only turn a one-second answer into a
                // 75-second one — this is the backstop that makes any imprecision in the pre-spawn survey
                // harmless. See SeatReadinessVerdict.PortTakenCode.
                owned.Failure ??= verdict.Issue;
                await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                return null;
            }
            if (status?.Status?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                ApplyToAttempt(sessionId, owned, registry => registry.Advance(sessionId, ConnectionStage.Joining));
            if (member && status?.Status is { NativePhase: "Connecting" or "starting" } && fresh)
            {
                var probe = await _readinessProbe(port.Value, ct).ConfigureAwait(false);
                // Retained on the connection so the monitor below can keep naming the cause after this loop has
                // returned — that is the only place the network-path verdict can be reached.
                owned.ListenerResponding = probe.Responding;
                owned.ListenerProbeFailure = probe.Failure;
                owned.ListenerReachability = probe.Reachability;
                verdict = SeatReadinessVerdict.Describe(ReadinessFacts(owned, status, member, port.Value, started, deadline));
                ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", verdict.Detail));
                LogCauseChange(owned, verdict);
                if (!probe.Responding)
                {
                    await Task.Delay(200, ct).ConfigureAwait(false);
                    continue;
                }
                var afterProbe = HeadlessConnectionControl.Shared.Snapshot(slot, owned.Generation);
                if (!IsCurrent(owned) || owned.Quarantined) return null;
                SetTerminalFailure(owned, afterProbe?.Status);
                if (ProcessExited(owned.Process!)) owned.Failure ??= ProcessExitedIssue(owned.Process!);
                if (owned.Failure is not null)
                {
                    await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                    return null;
                }
                if (afterProbe is null || !Fresh(afterProbe) || !_membershipProbe(SlotToNetId(slot)))
                {
                    // Readiness can change while HTTP is awaited. Keep waiting within the existing deadline;
                    // missing readiness is not a confirmed failure and cannot enter terminal cleanup.
                    await Task.Delay(200, ct).ConfigureAwait(false);
                    continue;
                }
                owned.HasJoined = true;
                ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness",
                    "Host lobby membership, live owned process, authenticated child heartbeat and child HTTP listener confirmed."));
                ApplyToAttempt(sessionId, owned, registry => registry.SetReadiness(sessionId, true, afterProbe!.Status!.ConnectedChildBrowserCount > 0));
                return port;
            }
            await Task.Delay(200, ct).ConfigureAwait(false);
        }
        // The deadline names the cause it actually observed rather than always saying "startup timeout": a
        // blocked loopback and a seat that was merely slow produced byte-identical text before this.
        owned.Failure ??= verdict.Issue;
        await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        return null;
    }

    /// <summary>
    /// Write the readiness cause to the host log the first time it becomes this cause, and not again until it
    /// changes.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One line per TRANSITION, deliberately: the verdict is recomputed five times a second during a join and
    /// four times a second for as long as a seat lives, and a line per evaluation would be the flood the
    /// godot-log-hygiene rule exists to prevent. What this buys is a diagnosis that is visible WHILE a live leg
    /// is running — the copyable report is the durable record, but nobody can watch one.
    /// </para>
    /// <para>
    /// And silent while nothing is wrong. Every healthy join is "still starting" for its whole 20-60 seconds, so
    /// announcing that on each spawn would be noise in the one file a support report is read from. A transition
    /// BACK to still-starting is logged, because that is a named condition clearing rather than a seat dying,
    /// and the difference is not otherwise recoverable from the log.
    /// </para>
    /// </remarks>
    private static void LogCauseChange(OwnedConnection owned, SeatReadinessVerdictResult verdict)
    {
        var previous = owned.LoggedCause;
        if (previous == verdict.Cause) return;
        owned.LoggedCause = verdict.Cause;
        if (verdict.Cause == SeatReadinessCause.StillStarting && previous is null) return;
        Console.Error.WriteLine(
            $"[couchcoop] seat readiness slot={owned.Slot} cause={verdict.Cause}: {verdict.Detail}");
    }

    /// <summary>
    /// Everything the host knows about <paramref name="owned"/>'s readiness right now, in the shape
    /// <see cref="SeatReadinessVerdict"/> reads.
    /// </summary>
    private static SeatReadinessFacts ReadinessFacts(
        OwnedConnection owned,
        HeadlessConnectionControlSnapshot? status,
        bool member,
        int expectedPort,
        long startedTicks,
        TimeSpan deadline)
        => new(
            ExpectedPort: expectedPort,
            // The seat's own word for where it is listening. 0 until it has one, which is "not up yet" and must
            // never read as a disagreement — every heartbeat from before this field existed would say 0.
            ReportedPort: status?.Status?.BrowserPort ?? 0,
            // The pre-spawn survey's finding is not carried here: a slot whose port had an owner never got
            // spawned into (AllocateHeadless fails it outright), so by this point the only port evidence left is
            // what the seat itself reports.
            PortOwner: null,
            HostMember: member,
            NativePhase: status?.Status?.NativePhase,
            HeartbeatFresh: status is not null && Fresh(status),
            ListenerResponding: owned.ListenerResponding,
            ProbeFailure: owned.ListenerProbeFailure,
            TcpReachability: owned.ListenerReachability,
            ConnectedBrowserCount: status?.Status?.ConnectedChildBrowserCount ?? 0,
            // The seat's own arrival evidence, straight off the heartbeat. NOT coalesced to 0 when it is
            // missing: null is "the seat has not said", and the verdict that reads this one accuses the
            // player's network, so it must never be reachable by a defaulted field.
            SeatViewerArrivals: status?.Status?.ViewerArrivalCount,
            ElapsedMs: (long)Stopwatch.GetElapsedTime(startedTicks).TotalMilliseconds,
            DeadlineMs: (long)deadline.TotalMilliseconds);

    private void PrepareConnectionLocked(int slot, Guid sessionId)
    {
        if (_membershipProbe is null) return;
        var owned = new OwnedConnection(slot, ++_processGeneration, Convert.ToHexString(RandomNumberGenerator.GetBytes(32)));
        _ownedConnections[slot] = owned;
        _browserAttempts[sessionId] = new(slot, owned.Generation, ConnectionRegistry.Shared.AttemptId(sessionId));
        HeadlessConnectionControl.Shared.Register(slot, owned.Generation, sessionId, owned.Token);
        ConnectionRegistry.Shared.BindProcess(sessionId, null, owned.Generation);
        ConnectionRegistry.Shared.ConfigureView(sessionId, requiresChild: true);
        ConnectionRegistry.Shared.Advance(sessionId, ConnectionStage.Initializing);
    }

    private void ApplyConnectionEnvironmentLocked(int slot, ProcessStartInfo start)
    {
        if (!_ownedConnections.TryGetValue(slot, out var owned)) return;
        var port = _controlPort?.Invoke() ?? 0;
        if (port <= 0) throw new InvalidOperationException("The host connection-control listener is unavailable.");
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_URL"] = $"http://127.0.0.1:{port}/internal/client-status";
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_TOKEN"] = owned.Token;
        start.Environment["COUCHCOOP_HEADLESS_CONTROL_GENERATION"] = owned.Generation.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Bind this slot's attempt to the two log FILES a failure will be explained from.
    /// </summary>
    /// <remarks>
    /// Paths, not user directories. A seat launched without user-dir isolation has no <c>logs/godot.log</c> of
    /// its own — its log is the per-slot file <c>--log-file</c> points at (see
    /// <c>HeadlessClientManager.SeatLogPath</c>), and deriving one from the shared user dir would either report
    /// the HOST's log as the client's or, as it did, report nothing at all.
    /// </remarks>
    private void CaptureConnectionLogsLocked(int slot, string? hostLogPath, string? clientLogPath)
    {
        if (_ownedConnections.TryGetValue(slot, out var owned))
            owned.Logs = ConnectionAttemptLogs.CaptureStart(hostLogPath, clientLogPath);
    }

    private void ForgetConnectionLocked(int slot)
    {
        if (!_ownedConnections.Remove(slot, out var owned)) return;
        HeadlessConnectionControl.Shared.Unregister(slot, owned.Generation);
        foreach (var id in _browserAttempts.Where(p => p.Value.Slot == slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray())
            _browserAttempts.Remove(id);
    }

    private bool IsCurrent(OwnedConnection owned)
    {
        lock (_lock) return !_disposed && _ownedConnections.GetValueOrDefault(owned.Slot) == owned
            && _processBySlot.GetValueOrDefault(owned.Slot) == owned.Process;
    }

    private static bool Fresh(HeadlessConnectionControlSnapshot snapshot)
        => snapshot.ObservedMonotonicTick is { } at && Stopwatch.GetElapsedTime(at) < TimeSpan.FromSeconds(10);

    private void ApplyToAttempt(Guid sessionId, OwnedConnection expected, Action<ConnectionRegistry> action)
    {
        BrowserAttempt? attempt;
        lock (_lock)
        {
            if (_ownedConnections.GetValueOrDefault(expected.Slot) != expected
                || _processBySlot.GetValueOrDefault(expected.Slot) != expected.Process
                || !_browserAttempts.TryGetValue(sessionId, out attempt)
                || attempt.Slot != expected.Slot
                || attempt.Generation != expected.Generation)
                return;
        }
        ConnectionRegistry.Shared.ForAttempt(sessionId, attempt.AttemptId, action);
    }

    private void OnChildStatus(HeadlessConnectionControlSnapshot snapshot)
    {
        OwnedConnection? owned;
        Guid[] clients;
        lock (_lock)
        {
            owned = _ownedConnections.GetValueOrDefault(snapshot.Slot);
            if (owned is null || owned.Generation != snapshot.Generation) return;
            clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
        }
        var status = snapshot.Status;
        if (SetTerminalFailure(owned, status))
        {
            var failure = owned.Failure!;
            foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Fail(id, failure.Code, failure.Summary, failure.Action, failure.Detail));
        }
        else if (status?.NativePhase == "Connecting")
            foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Advance(id, ConnectionStage.Joining));
    }

    public async Task FinishReportedFailureAsync(Guid sessionId)
    {
        OwnedConnection? owned;
        lock (_lock)
        {
            owned = _browserAttempts.TryGetValue(sessionId, out var attempt) ? _ownedConnections.GetValueOrDefault(attempt.Slot) : null;
        }
        if (owned is not null && IsCurrent(owned))
        {
            SetTerminalFailure(owned, HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation)?.Status);
            if (owned.Process is not null && ProcessExited(owned.Process))
                owned.Failure ??= ProcessExitedIssue(owned.Process);
        }
        if (owned?.Failure is not null) await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        else if (owned?.Logs is not null && ConnectionRegistry.Shared.Snapshot().Rows
                     .Any(row => row.Id == sessionId && row.Issue is not null))
        {
            // Capture the affected process before disconnect releases its slot for reuse. A browser failure
            // must not stop a healthy process that still serves another browser or an active run.
            var logs = await owned.Logs.ReadErrorsAsync().ConfigureAwait(false);
            ApplyToAttempt(sessionId, owned, registry =>
            {
                foreach (var log in logs) registry.AttachLogExcerpt(sessionId, log.Source, log.Text, log.Status);
            });
        }
    }

    private async Task MonitorConnectionAsync(OwnedConnection owned)
    {
        try
        {
            while (IsCurrent(owned))
            {
                var status = HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation);
                var native = status?.Status;
                SetTerminalFailure(owned, native);
                var member = _membershipProbe!(SlotToNetId(owned.Slot));
                // The same four-cause verdict the join wait uses, kept running after the redirect. This is the
                // only place the NETWORK PATH cause can be reached: the join returns as soon as the host itself
                // can reach the seat, so "the seat is up, the host can talk to it, and no viewer ever arrived"
                // is only observable from here. A port disagreement is terminal on this side too — it means the
                // browser is being pointed at an address this seat does not serve.
                var verdict = SeatReadinessVerdict.Describe(ReadinessFacts(
                    owned, status, member, SlotToPort(owned.Slot), owned.StartedTicks, TimeSpan.Zero));
                LogCauseChange(owned, verdict);
                Guid[] clients;
                lock (_lock) clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
                // TELL THE PLAYER, not just the panel. Every other consumer of this verdict stops at the HOST —
                // the log line above, the registry diagnostic below, and the copyable report behind it — and the
                // one person who could act on the cause, the viewer whose seat it is, has only ever seen a
                // spinner. That is worst for the network-path cause, which is reachable only here and describes
                // a device that was handed a port it cannot open. Deliberately ABOVE the failure bail below, so
                // a port conflict (which kills this seat on this very tick) still reaches the browser before its
                // seat goes away. The speaker decides whether this cause is worth saying yet; the hub decides
                // who has not already been told, and can neither block nor fault this loop.
                var notice = owned.Notice.Observe(verdict);
                foreach (var id in clients) SeatNoticeHub.Shared.Publish(id, notice);
                if (verdict.Cause == SeatReadinessCause.PortConflict) owned.Failure ??= verdict.Issue;
                if (owned.Process!.HasExited)
                    owned.Failure ??= ProcessExitedIssue(owned.Process);
                if (owned.HasJoined && status is not null && !Fresh(status))
                    owned.Failure ??= new("child-status-lost", "The client game stopped responding to the host.",
                        "Retry the connection. Copy this report if the client becomes unresponsive again.", "No authenticated child heartbeat arrived for 10 seconds.");
                if (owned.Failure is not null) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return; }
                foreach (var id in clients)
                {
                    ApplyToAttempt(id, owned, registry =>
                    {
                        if (native?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                            registry.Advance(id, ConnectionStage.Joining);
                        // Only while something is actually diagnosable. The verdict's elapsed figure changes every
                        // second, so recording it unconditionally would bump the registry revision (and repaint the
                        // panel) once a second for every connected seat, for the whole session — and say nothing.
                        // A seat with a browser attached always classifies as "still starting", so this is silent
                        // the moment the join succeeds.
                        if (verdict.Cause != SeatReadinessCause.StillStarting)
                            registry.RecordDiagnostic(id, "view readiness", verdict.Detail);
                        registry.SetReadiness(id, member, native?.ConnectedChildBrowserCount > 0);
                        registry.NoticeSlowView(id);
                    });
                }
                await Task.Delay(250).ConfigureAwait(false);
            }
        }
        catch (Exception exception)
        {
            if (!IsCurrent(owned)) return;
            owned.Failure ??= new("process-monitor-failed", "The host could not monitor the client game.",
                "Retry the connection and copy this report if it repeats.", exception.ToString());
            await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        }
    }

    private Task StopFailedConnectionAsync(OwnedConnection owned)
    {
        lock (_lock)
        {
            if (_connectionCleanup.TryGetValue(owned.Slot, out var cleanup)) return cleanup;
            if (!IsCurrent(owned)) return Task.CompletedTask;
            var task = Task.Run(() => CleanupFailedConnectionAsync(owned));
            _connectionCleanup[owned.Slot] = task;
            return task;
        }
    }

    private async Task CleanupFailedConnectionAsync(OwnedConnection owned)
    {
        Guid[] clients;
        lock (_lock) clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
        var issue = owned.Failure!;
        foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.Fail(id, issue.Code, issue.Summary, issue.Action, issue.Detail));
        var started = Stopwatch.GetTimestamp();
        HeadlessConnectionControl.Shared.RequestShutdown(owned.Slot, owned.Generation);
        var forced = false;
        Exception? killFailure = null;
        try
        {
            while (IsCurrent(owned) && !owned.Process!.HasExited && Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(5))
                await Task.Delay(100).ConfigureAwait(false);
            if (IsCurrent(owned) && !owned.Process!.HasExited)
            {
                try
                {
                    owned.Process.Kill();
                    forced = true;
                    var killStarted = Stopwatch.GetTimestamp();
                    while (!owned.Process.HasExited && Stopwatch.GetElapsedTime(killStarted) < TimeSpan.FromSeconds(1))
                        await Task.Delay(25).ConfigureAwait(false);
                    if (!owned.Process.HasExited)
                        killFailure = new InvalidOperationException("The forced shutdown request did not terminate the client process.");
                }
                catch (Exception exception)
                {
                    killFailure = exception;
                }
            }
            var logs = owned.Logs is null
                ? new[] { new ConnectionLogExcerpt("host", "unavailable", "The attempt log path was unavailable."), new ConnectionLogExcerpt("client", "unavailable", "The attempt log path was unavailable.") }
                : await owned.Logs.ReadErrorsAsync().ConfigureAwait(false);
            foreach (var id in clients)
            {
                ApplyToAttempt(id, owned, registry =>
                {
                    registry.RecordDiagnostic(id, "cleanup", forced ? "Forced exit after the five-second graceful shutdown deadline." : "Client exited before the forced shutdown deadline.");
                    foreach (var log in logs) registry.AttachLogExcerpt(id, log.Source, log.Text, log.Status);
                    if (killFailure is not null) registry.RecordDiagnostic(id, "cleanupKillFailed", killFailure.ToString());
                });
            }
            if (killFailure is not null)
            {
                // Retain ownership when termination is indeterminate. Removing the handle would allow another
                // child to launch on this seat while the old process might still own its network peer.
                QuarantineLocked(owned, killFailure.Message);
                return;
            }
            // A concurrent release or hosting teardown can retire this generation while logs are read.
            if (!IsCurrent(owned)) return;
            // Keep the slot reserved until its peer has been removed and log capture has completed.
            try { _evictStalePeer?.Invoke(SlotToNetId(owned.Slot)); }
            catch (Exception exception)
            {
                foreach (var id in clients) ApplyToAttempt(id, owned, registry => registry.RecordDiagnostic(id, "peerCleanup", exception.ToString()));
                QuarantineLocked(owned, $"The host could not remove the prior network peer: {exception.Message}");
                return;
            }
            lock (_lock)
            {
                if (IsCurrent(owned))
                {
                    ClearQuarantineLocked(owned);
                    foreach (var id in _sessionToSlot.Where(p => p.Value == owned.Slot).Select(p => p.Key).ToArray()) _sessionToSlot.Remove(id);
                    RemoveNameForSlotLocked(owned.Slot);
                    ShutdownSlotLocked(owned.Slot, graceful: false);
                }
            }
        }
        finally { lock (_lock) _connectionCleanup.Remove(owned.Slot); }
    }

    internal void EndHosting()
    {
        lock (_lock)
        {
            foreach (var slot in _processBySlot.Keys.ToArray()) ShutdownSlotLocked(slot, graceful: false);
            _sessionToSlot.Clear(); _nameToSlot.Clear(); _detachedSlots.Clear(); _browserAttempts.Clear();
        }
    }

    private sealed class OwnedConnection(int slot, long generation, string token)
    {
        public int Slot { get; } = slot;
        public long Generation { get; } = generation;
        public string Token { get; } = token;
        /// <summary>When this seat was claimed, for the elapsed figure the readiness verdict prints.</summary>
        public long StartedTicks { get; } = Stopwatch.GetTimestamp();
        public IHeadlessProcess? Process;
        public bool MonitorStarted, HasJoined, Quarantined;
        /// <summary>
        /// The last result of the host's own loopback probe of this seat's assigned port, and why it failed.
        /// Null until the join wait has probed at all. Retained past that wait because the monitor keeps naming
        /// the readiness cause and has no probe of its own — re-probing on its 250 ms tick would be a poll.
        /// </summary>
        public bool? ListenerResponding;
        public string? ListenerProbeFailure;
        /// <summary>What a raw TCP connect found when the HTTP probe last failed; see the probe's own doc.</summary>
        public SeatPortReachability ListenerReachability;
        /// <summary>The readiness cause already written to the host log; see <c>LogCauseChange</c>.</summary>
        public SeatReadinessCause? LoggedCause;
        /// <summary>
        /// What this seat should currently be telling its VIEWERS, and since when. Per seat rather than per
        /// viewer because the settling delay measures how long a cause has held for the seat, and a viewer that
        /// drops and reconnects mid-episode must not restart that clock.
        /// </summary>
        public readonly SeatNoticeSpeaker Notice = new();
        public ConnectionIssue? Failure;
        public ConnectionAttemptLogs? Logs;
        public string? QuarantineReason;
    }
    private sealed record HeadlessAllocation(int Port, bool NewProcess);
    private sealed record BrowserAttempt(int Slot, long Generation, string? AttemptId);

    private async Task CleanupExitedConnectionsAsync(CancellationToken ct)
    {
        OwnedConnection[] exited;
        lock (_lock)
        {
            exited = _ownedConnections.Values.Where(owned => owned.Process is not null && ProcessExited(owned.Process)).ToArray();
            foreach (var owned in exited) owned.Failure ??= ProcessExitedIssue(owned.Process!);
        }

        foreach (var owned in exited)
            await StopFailedConnectionAsync(owned).WaitAsync(ct).ConfigureAwait(false);
    }

    private static bool ProcessExited(IHeadlessProcess process)
    {
        try { return process.HasExited; }
        catch { return true; }
    }

    private static ConnectionIssue ProcessExitedIssue(IHeadlessProcess process)
    {
        string exitCode;
        try { exitCode = process.ExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture); } catch { exitCode = "unknown"; }
        return new("process-exited", "The client game process closed unexpectedly.",
            "Retry the connection. If the game closes again, copy this report.", $"Process exit code: {exitCode}.");
    }

    /// <summary>
    /// The technical detail a <see cref="SeatBuildMismatchCode"/> row carries: what the seat reported, plus —
    /// when this host could not isolate its seats — WHY the mismatch was reachable at all.
    /// </summary>
    /// <remarks>
    /// <para>
    /// On a host with per-seat user dirs this failure should be unreachable: the seeder rewrites each seat's own
    /// <c>settings.save</c> so the row for the other installed copy of the mod is disabled
    /// (<see cref="HeadlessSeatModSelection"/>), and the seat then loads what the host loaded. That pin runs
    /// INSIDE the seeder, over a file the seat owns.
    /// </para>
    /// <para>
    /// Without isolation there is no such file — the only <c>settings.save</c> on the machine is the host's own,
    /// and rewriting it is out of the question — so the game chooses per process and can choose differently for
    /// a seat. The remedy the player is given does not change (keep one copy installed), but a support report
    /// that does not say this reads as a random failure on a machine where it is in fact deterministic.
    /// </para>
    /// </remarks>
    internal static string SeatBuildMismatchDetail(string? reportedDetail, bool seatsShareTheHostProfile)
    {
        var detail = string.IsNullOrWhiteSpace(reportedDetail)
            ? "The client game did not report which build it loaded."
            : reportedDetail;
        return seatsShareTheHostProfile
            ? detail + " This platform has no per-player game profile, so the host cannot tell a player's game "
                + "which copy of CouchCoop to load — with two copies installed, the game picks one per process "
                + "and can pick differently for each player."
            : detail;
    }

    private static bool SetTerminalFailure(OwnedConnection owned, HeadlessConnectionStatus? status)
    {
        if (status?.NativePhase.Equals("Failed", StringComparison.OrdinalIgnoreCase) == true)
            // A build mismatch is a terminal failure like any other, but it is NOT a native rejection: the seat
            // never reached the network, and "check that game and mod versions match" is the one next action a
            // player cannot act on. It has a remedy — remove one of the two installed copies of this mod — so it
            // gets its own code and says so. The detail comes from the seat and names the file it loaded.
            //
            // The port guard's refusal is mapped the same way and for the same reason: the seat could not bind
            // the port it was assigned, which is a host-side port conflict with a real remedy (restart the game
            // and free the port), not a game that refused the connection.
            owned.Failure ??= status.ErrorCode switch
            {
                HeadlessSeatBuildGuard.MismatchErrorCode =>
                    new(SeatBuildMismatchCode, "This player's game is running a different version of CouchCoop than the host.",
                        "Both copies of the mod are installed. Unsubscribe the CouchCoop item in the Steam Workshop, or redeploy the mod, so only one remains — then retry.",
                        SeatBuildMismatchDetail(status.ErrorDetail, SeatsShareTheHostProfile)),
                HeadlessSeatPortGuard.UnavailableErrorCode =>
                    SeatReadinessVerdict.IssueFor(
                        SeatReadinessCause.PortConflict,
                        status.ErrorDetail ?? "The client game did not report which port it could not bind."),
                _ => new("native-join-rejected", "The game rejected the connection to the host.",
                    "Check that game and mod versions match, then retry. Copy this report if it continues.",
                    $"{status.ErrorCode ?? "Unknown native error"}: {status.ErrorDetail ?? "No native error detail was supplied."}"),
            };
        else if (status?.NativePhase.Equals("Disconnected", StringComparison.OrdinalIgnoreCase) == true)
            owned.Failure ??= new("native-disconnected", "The client game disconnected from the host.",
                "Reconnect this device. Copy this report if it drops again.", status.ErrorDetail ?? status.ErrorCode);
        return owned.Failure is not null;
    }

    private void QuarantineLocked(OwnedConnection owned, string reason)
    {
        lock (_lock)
        {
            if (_ownedConnections.GetValueOrDefault(owned.Slot) != owned || _processBySlot.GetValueOrDefault(owned.Slot) != owned.Process)
                return;
            owned.Quarantined = true;
            owned.QuarantineReason ??= reason;
        }
    }

    private void ClearQuarantineLocked(OwnedConnection owned)
    {
        if (_ownedConnections.GetValueOrDefault(owned.Slot) != owned || _processBySlot.GetValueOrDefault(owned.Slot) != owned.Process)
            return;
        owned.Quarantined = false;
        owned.QuarantineReason = null;
    }
}
