using System.Diagnostics;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.Runtime;

namespace CouchCoop.Mod.Session;

public sealed partial class HeadlessClientManager
{
    /// <summary>
    /// The injected-launcher harness, routed the way the real manager routes every seat: through the host's
    /// shared browser relay. The other test constructor leaves the relay off, which is what the direct-port
    /// suites are written against.
    /// </summary>
    internal HeadlessClientManager(
        Func<int, IHeadlessProcess?> launcher,
        Func<int, CancellationToken, Task<bool>>? readinessProbe,
        bool sharedRelay)
        : this(launcher, readinessProbe)
    {
        _supportsSharedRelay = sharedRelay;
    }

    private async Task<int?> WaitForSharedReadyAsync(
        OwnedConnection owned, Guid sessionId, int logicalPort, CancellationToken cancellationToken)
    {
        using var signals = new SharedSeatSignals(owned, roster =>
            CouchCoopLobbyParticipation.IsPlayerConnected(roster, SlotToNetId(owned.Slot)));
        var started = Stopwatch.GetTimestamp();
        var contact = SeatContactTimeout;
        var ready = SeatReadyTimeout;
        while (IsCurrent(owned))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var status = ObserveSeatStatusFile(
                owned, HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation));
            LogFirstContact(owned, status);
            SetTerminalFailure(owned, status?.Status);
            if (owned.Process is not null && ProcessExited(owned.Process))
                owned.Failure ??= ProcessExitedIssue(owned.Process);
            if (owned.Failure is not null || owned.Quarantined)
            {
                await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                return null;
            }

            var member = signals.Member;
            var elapsed = Stopwatch.GetElapsedTime(started);
            if (status?.Status is { } report)
            {
                if (report.NativePhase.Equals("Connecting", StringComparison.OrdinalIgnoreCase))
                    ApplyToAttempt(sessionId, owned, registry => registry.Advance(sessionId, ConnectionStage.Joining));
                if (member && Fresh(status) && report.RelayReady && report.CloudSaveIsolated
                    && report.NativePhase is "Connecting" or "starting")
                {
                    owned.HasJoined = true;
                    ApplyToAttempt(sessionId, owned, registry =>
                    {
                        registry.RecordDiagnostic(sessionId, "join readiness",
                            "Host lobby membership, live owned process, authenticated child heartbeat and private browser relay confirmed.");
                        registry.SetReadiness(sessionId, true, report.ConnectedChildBrowserCount > 0);
                    });
                    lock (_lock)
                    {
                        if (IsCurrent(owned) && !owned.MonitorStarted)
                        {
                            owned.MonitorStarted = true;
                            _ = Task.Run(() => MonitorSharedConnectionAsync(owned));
                        }
                    }
                    return logicalPort;
                }
            }
            else if (elapsed >= contact)
            {
                // The same verdict, and the same evidence, as the direct path: a member is a seat CouchCoop ran
                // in; a non-member is cleared only by its own port record; every answer carries the control
                // channel's counts. See ClassifySilentSeatAsync for what is (and is not) asked of a relay seat.
                owned.Failure ??= await ClassifySilentSeatAsync(owned, logicalPort, member, contact, cancellationToken)
                    .ConfigureAwait(false);
            }
            if (elapsed >= ready)
                owned.Failure ??= new ConnectionIssue("seat-relay-not-ready",
                    "This player's game could not open its browser relay.",
                    "Retry the connection and copy this report if it repeats.",
                    "The private browser relay or host lobby membership was not confirmed before the seat readiness deadline.");
            if (owned.Failure is not null)
            {
                await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                return null;
            }
            ApplyToAttempt(sessionId, owned, registry => registry.RecordDiagnostic(sessionId, "join readiness",
                $"Waiting for private browser relay; member={member}; status={status is not null}; relay={status?.Status?.RelayReady == true}."));
            var remaining = ready - elapsed;
            if (status?.Status is null && contact - elapsed < remaining) remaining = contact - elapsed;
            await signals.WaitAsync(remaining, cancellationToken).ConfigureAwait(false);
        }
        return null;
    }

    private async Task MonitorSharedConnectionAsync(OwnedConnection owned)
    {
        try
        {
            using var signals = new SharedSeatSignals(owned, roster =>
                CouchCoopLobbyParticipation.IsPlayerConnected(roster, SlotToNetId(owned.Slot)));
            while (IsCurrent(owned))
            {
                var status = ObserveSeatStatusFile(
                    owned, HeadlessConnectionControl.Shared.Snapshot(owned.Slot, owned.Generation));
                var report = status?.Status;
                SetTerminalFailure(owned, report);
                if (owned.Process is not null && ProcessExited(owned.Process))
                    owned.Failure ??= ProcessExitedIssue(owned.Process);
                if (status is null || !Fresh(status))
                    owned.Failure ??= new ConnectionIssue("child-status-lost",
                        "The client game stopped responding to the host.",
                        "Retry the connection. Copy this report if the client becomes unresponsive again.",
                        "No authenticated child heartbeat arrived for 10 seconds.");
                if (owned.Failure is not null)
                {
                    await StopFailedConnectionAsync(owned).ConfigureAwait(false);
                    return;
                }
                Guid[] clients;
                lock (_lock) clients = _browserAttempts.Where(pair => pair.Value.Slot == owned.Slot
                    && pair.Value.Generation == owned.Generation).Select(pair => pair.Key).ToArray();
                foreach (var id in clients)
                    ApplyToAttempt(id, owned, registry =>
                    {
                        registry.SetReadiness(id, signals.Member, report?.ConnectedChildBrowserCount > 0);
                        registry.NoticeSlowView(id);
                    });
                // A timer enforces the heartbeat expiry; game changes arrive through roster and status signals.
                var untilStale = status?.ObservedMonotonicTick is { } tick
                    ? TimeSpan.FromSeconds(10) - Stopwatch.GetElapsedTime(tick)
                    : TimeSpan.FromSeconds(10);
                await signals.WaitAsync(untilStale).ConfigureAwait(false);
            }
        }
        catch (Exception exception)
        {
            if (!IsCurrent(owned)) return;
            owned.Failure ??= new ConnectionIssue("process-monitor-failed",
                "The host could not monitor the client game.",
                "Retry the connection and copy this report if it repeats.", exception.ToString());
            await StopFailedConnectionAsync(owned).ConfigureAwait(false);
        }
    }

    private sealed class SharedSeatSignals : IDisposable
    {
        private readonly OwnedConnection _owned;
        private readonly Func<RosterFacts?, bool> _isMember;
        private readonly SemaphoreSlim _wake = new(0, 1);
        private readonly CancellationTokenSource _stop = new();
        private readonly Action<HeadlessConnectionControlSnapshot> _onStatus;
        private readonly IDisposable _roster;
        private readonly FileSystemWatcher? _watcher;
        private int _member;

        public SharedSeatSignals(OwnedConnection owned, Func<RosterFacts?, bool> isMember)
        {
            _owned = owned;
            _isMember = isMember;
            _onStatus = snapshot =>
            {
                if (snapshot.Slot == owned.Slot && snapshot.Generation == owned.Generation) Wake();
            };
            HeadlessConnectionControl.Shared.StatusChanged += _onStatus;
            _roster = CouchCoopRosterObserver.Subscribe(OnRoster);
            if (owned.Process is IHeadlessProcessExitSignal process)
                _ = WatchExitAsync(process);
            if (owned.SeatStatusFilePath is { } path && Directory.Exists(Path.GetDirectoryName(path)))
            {
                _watcher = new FileSystemWatcher(Path.GetDirectoryName(path)!, Path.GetFileName(path))
                {
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
                    EnableRaisingEvents = true
                };
                _watcher.Changed += OnFile;
                _watcher.Created += OnFile;
                _watcher.Renamed += OnRename;
            }
        }

        public bool Member => Volatile.Read(ref _member) == 1;

        private void OnRoster(RosterFacts? roster)
        {
            if (roster is null) return;
            Volatile.Write(ref _member, _isMember(roster) ? 1 : 0);
            Wake();
        }

        private void OnFile(object sender, FileSystemEventArgs args) => Wake();
        private void OnRename(object sender, RenamedEventArgs args) => Wake();

        private async Task WatchExitAsync(IHeadlessProcessExitSignal process)
        {
            try { await process.WaitForExitAsync(_stop.Token).ConfigureAwait(false); Wake(); }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
        }

        private void Wake()
        {
            try { _wake.Release(); }
            catch (SemaphoreFullException) { }
            catch (ObjectDisposedException) { }
        }

        public Task WaitAsync(TimeSpan timeout, CancellationToken cancellationToken = default)
            => _wake.WaitAsync(timeout > TimeSpan.Zero ? timeout : TimeSpan.Zero, cancellationToken);

        public void Dispose()
        {
            _stop.Cancel();
            HeadlessConnectionControl.Shared.StatusChanged -= _onStatus;
            _roster.Dispose();
            _watcher?.Dispose();
            _wake.Dispose();
            _stop.Dispose();
        }
    }
}
