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
        HeadlessAllocation? allocation;
        try { allocation = AllocateHeadless(sessionId, displayName, ct, allowNewSlot, onSlotBound, targetNetId); }
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
        string listenerProof = "not yet probed";
        string readinessProof = "No readiness observation was captured.";
        while (Stopwatch.GetElapsedTime(started) < SeatReadyTimeout)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsCurrent(owned)) return null;
            if (owned.Failure is not null || owned.Quarantined) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return null; }
            var status = HeadlessConnectionControl.Shared.Snapshot(slot, owned.Generation);
            var member = _membershipProbe(SlotToNetId(slot));
            var fresh = status is not null && Fresh(status);
            readinessProof = $"Host lobby membership: {member}; child phase: {status?.Status?.NativePhase ?? "not reported"}; authenticated heartbeat fresh: {fresh}; child HTTP listener: {listenerProof}.";
            ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", readinessProof));
            if (status?.Status?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                ApplyToAttempt(sessionId, owned, registry => registry.Advance(sessionId, ConnectionStage.Joining));
            if (member && status?.Status is { NativePhase: "Connecting" or "starting" } && fresh)
            {
                var listenerResponding = await _readinessProbe(port.Value, ct).ConfigureAwait(false);
                listenerProof = listenerResponding ? "responding" : "not responding";
                readinessProof = $"Host lobby membership: {member}; child phase: {status.Status.NativePhase}; authenticated heartbeat fresh: {fresh}; child HTTP listener: {listenerProof}.";
                ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness", readinessProof));
                if (!listenerResponding)
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
        owned.Failure ??= new("startup-timeout", "The game did not join the host before the connection deadline.",
            "Retry after the host finishes loading. If this repeats, copy the report and check that game and mod versions match.",
            $"Deadline: {SeatReadyTimeout.TotalSeconds:0} seconds. {readinessProof}");
        await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        return null;
    }

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

    private void CaptureConnectionLogsLocked(int slot, string? hostUserDir, string? clientUserDir)
    {
        if (_ownedConnections.TryGetValue(slot, out var owned))
            owned.Logs = ConnectionAttemptLogs.CaptureStart(hostUserDir is null ? ConnectionRegistry.HostLogPath : Path.Combine(hostUserDir, "logs", "godot.log"),
                clientUserDir is null ? null : Path.Combine(clientUserDir, "logs", "godot.log"));
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
                if (owned.Process!.HasExited)
                    owned.Failure ??= ProcessExitedIssue(owned.Process);
                if (owned.HasJoined && status is not null && !Fresh(status))
                    owned.Failure ??= new("child-status-lost", "The client game stopped responding to the host.",
                        "Retry the connection. Copy this report if the client becomes unresponsive again.", "No authenticated child heartbeat arrived for 10 seconds.");
                if (owned.Failure is not null) { await StopFailedConnectionAsync(owned).ConfigureAwait(false); return; }
                var member = _membershipProbe!(SlotToNetId(owned.Slot));
                Guid[] clients;
                lock (_lock) clients = _browserAttempts.Where(p => p.Value.Slot == owned.Slot && p.Value.Generation == owned.Generation).Select(p => p.Key).ToArray();
                foreach (var id in clients)
                {
                    ApplyToAttempt(id, owned, registry =>
                    {
                        if (native?.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase) == true)
                            registry.Advance(id, ConnectionStage.Joining);
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
        public IHeadlessProcess? Process;
        public bool MonitorStarted, HasJoined, Quarantined;
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

    private static bool SetTerminalFailure(OwnedConnection owned, HeadlessConnectionStatus? status)
    {
        if (status?.NativePhase.Equals("Failed", StringComparison.OrdinalIgnoreCase) == true)
            // A build mismatch is a terminal failure like any other, but it is NOT a native rejection: the seat
            // never reached the network, and "check that game and mod versions match" is the one next action a
            // player cannot act on. It has a remedy — remove one of the two installed copies of this mod — so it
            // gets its own code and says so. The detail comes from the seat and names the file it loaded.
            owned.Failure ??= string.Equals(status.ErrorCode, HeadlessSeatBuildGuard.MismatchErrorCode, StringComparison.Ordinal)
                ? new(SeatBuildMismatchCode, "This player's game is running a different version of CouchCoop than the host.",
                    "Both copies of the mod are installed. Unsubscribe the CouchCoop item in the Steam Workshop, or redeploy the mod, so only one remains — then retry.",
                    status.ErrorDetail ?? "The client game did not report which build it loaded.")
                : new("native-join-rejected", "The game rejected the connection to the host.",
                    "Check that game and mod versions match, then retry. Copy this report if it continues.",
                    $"{status.ErrorCode ?? "Unknown native error"}: {status.ErrorDetail ?? "No native error detail was supplied."}");
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
