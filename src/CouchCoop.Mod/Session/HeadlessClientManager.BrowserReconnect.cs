using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

public sealed partial class HeadlessClientManager
{
    // A screen lock or refresh should not cold-start a new copy of the game. Keep the lobby seat for a short
    // return to the phone; a player who leaves still frees their process and lobby slot within two minutes.
    // Run seats keep the existing, stronger lifetime: until the host leaves the run and lobby.
    internal static readonly TimeSpan BrowserReconnectGrace = TimeSpan.FromMinutes(2);
    private readonly TimeProvider _browserReconnectTime = TimeProvider.System;
    private readonly Dictionary<int, BrowserReconnectPending> _browserReconnectPending = [];
    private long _nextBrowserReconnectTicket;

    private sealed class BrowserReconnectPending(long ticket, Guid sessionId, IHeadlessProcess process, Action<long> expire)
    {
        internal long Ticket { get; } = ticket;
        internal Guid SessionId { get; } = sessionId;
        internal IHeadlessProcess Process { get; } = process;
        internal Action<long> Expire { get; } = expire;
        internal ITimer? Timer { get; set; }
    }

    /// <summary>
    /// Hold the last lobby browser's live seat across a transient disconnect. Keep the session binding until
    /// expiry so the existing release path can retire it, while a reconnect transfers that binding normally.
    /// The detached marker also lets the host's existing menu/run-end reaction reap it without waiting.
    /// </summary>
    internal bool RetainForBrowserReconnect(Guid sessionId, Action<long> expire)
    {
        lock (_lock)
        {
            if (_disposed || !_sessionToSlot.TryGetValue(sessionId, out var slot)
                || !_processBySlot.TryGetValue(slot, out var process)) return false;
            try { if (process.HasExited) return false; }
            catch { return false; }
            // Another browser still owns this seat: normal release already preserves that process.
            if (_sessionToSlot.Any(pair => pair.Value == slot && pair.Key != sessionId)) return false;
            if (_browserReconnectPending.TryGetValue(slot, out var existing)
                && existing.SessionId == sessionId && ReferenceEquals(existing.Process, process)) return true;
            CancelBrowserReconnectGraceLocked(slot);
            var pending = new BrowserReconnectPending(++_nextBrowserReconnectTicket, sessionId, process, expire);
            _browserReconnectPending[slot] = pending;
            _browserAttempts.Remove(sessionId);
            _detachedSlots.Add(slot);
            pending.Timer = _browserReconnectTime.CreateTimer(
                _ => ExpireBrowserReconnectGrace(slot, pending), null,
                BrowserReconnectGrace, Timeout.InfiniteTimeSpan);
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "cleanup",
                "Healthy game retained for two minutes so this browser can reconnect.");
            return true;
        }
    }

    private void ExpireBrowserReconnectGrace(int slot, BrowserReconnectPending pending)
    {
        lock (_lock)
        {
            // A queued callback can outlive cancellation. Compare the reservation and the process object, not
            // only the slot: a later game may already occupy that slot by the time this callback gets a turn.
            if (!_browserReconnectPending.TryGetValue(slot, out var current)
                || !ReferenceEquals(current, pending)) return;
            pending.Timer?.Dispose();
            if (_disposed || !_sessionToSlot.TryGetValue(pending.SessionId, out var currentSlot)
                || currentSlot != slot || !_processBySlot.TryGetValue(slot, out var process)
                || !ReferenceEquals(process, pending.Process))
            {
                CancelBrowserReconnectGraceLocked(slot);
                return;
            }
        }
        // The callback rechecks run presence: starting the run while the phone is locked must promote this
        // seat to run-duration retention. Never read game state or evict a peer while holding the manager lock.
        // The ticket is checked again inside release/detach's lock. Even a reconnect using the SAME session
        // identity can cancel an expiry that is already in flight while its game-state read is running.
        try { pending.Expire(pending.Ticket); }
        catch (Exception exception)
        {
            CouchCoopLog.Stderr($"browser reconnect cleanup failed slot={slot}: {exception.Message}");
        }
        finally
        {
            lock (_lock)
                if (_browserReconnectPending.TryGetValue(slot, out var current) && ReferenceEquals(current, pending))
                    CancelBrowserReconnectGraceLocked(slot);
        }
    }

    private bool IsBrowserReconnectCurrentLocked(Guid sessionId, long ticket)
        => _sessionToSlot.TryGetValue(sessionId, out var slot)
            && _browserReconnectPending.TryGetValue(slot, out var pending)
            && pending.SessionId == sessionId && pending.Ticket == ticket
            && _processBySlot.TryGetValue(slot, out var process) && ReferenceEquals(process, pending.Process);

    private void CancelBrowserReconnectGraceLocked(int slot)
    {
        if (_browserReconnectPending.Remove(slot, out var pending)) pending.Timer?.Dispose();
    }
}
