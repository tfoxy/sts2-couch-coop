using CouchCoop.Mod.Connections;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Server;

/// <summary>
/// Streams <see cref="BrowserJoinProgressEnvelope"/> to one browser for as long as its `join` is in flight.
///
/// <para>
/// WHY: a cold seat spawn legitimately takes 20-60 seconds, and the host waits for it INLINE inside the join
/// handler — so between the `join` message and its reply the browser has nothing to show but a spinner. A join
/// that has already died shows exactly the same spinner for the full 75 s deadline, which is why the field report
/// for a slow-but-healthy join is "it hangs". The host already knows the answer: the connection registry tracks
/// this attempt's stage, step and elapsed time. This just carries it across.
/// </para>
///
/// <para>
/// It is a READER, not a second source of truth: every field comes out of
/// <see cref="ConnectionRegistry.Snapshot"/> for this session id. Nothing here advances a stage, and if the
/// registry says nothing about this session (the row was dropped, the socket is going away) it sends nothing
/// rather than inventing a state.
/// </para>
///
/// <para>
/// Three properties the join depends on, all enforced here rather than at the call site:
/// it never faults the join (every exception is contained — a diagnostic that breaks a join is worse than no
/// diagnostic); it never outlives the attempt (<see cref="StopAsync"/> cancels AND awaits the loop, and the
/// caller's own token cancels it too); and it sends only on CHANGE, so a stage that sits still for 40 seconds
/// costs one message, not forty.
/// </para>
/// </summary>
internal sealed class JoinProgressTicker
{
    /// <summary>
    /// How often the registry is re-read. One second is the resolution the viewer sees (the elapsed time is
    /// rendered in whole seconds), and the read itself is a dictionary walk under a lock — cheaper than the
    /// heartbeat already running beside it.
    /// </summary>
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(1);

    private readonly CancellationTokenSource _stopped;
    private readonly Task _loop;

    private JoinProgressTicker(CancellationTokenSource stopped, Task loop)
    {
        _stopped = stopped;
        _loop = loop;
    }

    /// <summary>
    /// Begin ticking. The returned ticker runs until <see cref="StopAsync"/> is called or
    /// <paramref name="cancellationToken"/> fires, whichever comes first.
    /// </summary>
    /// <param name="registry">The attempt registry to read. Production passes <see cref="ConnectionRegistry.Shared"/>.</param>
    /// <param name="sessionId">The browser connection whose row is being reported.</param>
    /// <param name="requestId">The `join` request this progress is about; echoed on every envelope.</param>
    /// <param name="send">Delivers one envelope. May throw (a closing socket); the loop contains it and stops.</param>
    /// <param name="interval">Test seam; defaults to <see cref="DefaultInterval"/>.</param>
    /// <param name="delay">Test seam for the inter-tick wait; defaults to <see cref="Task.Delay(TimeSpan, CancellationToken)"/>.</param>
    public static JoinProgressTicker Start(
        ConnectionRegistry registry,
        Guid sessionId,
        string requestId,
        Func<BrowserJoinProgressEnvelope, Task> send,
        CancellationToken cancellationToken,
        TimeSpan? interval = null,
        Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        ArgumentNullException.ThrowIfNull(registry);
        ArgumentNullException.ThrowIfNull(send);
        var stopped = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var loop = RunAsync(registry, sessionId, requestId, send, interval ?? DefaultInterval,
            delay ?? ((wait, token) => Task.Delay(wait, token)), stopped.Token);
        return new JoinProgressTicker(stopped, loop);
    }

    /// <summary>
    /// Stop ticking and wait for the loop to finish, so no envelope can arrive after the join's own reply.
    /// Idempotent, never throws, and safe to call from a <c>finally</c>.
    /// </summary>
    public async Task StopAsync()
    {
        try { await _stopped.CancelAsync().ConfigureAwait(false); }
        catch (ObjectDisposedException) { /* already stopped */ }
        try { await _loop.ConfigureAwait(false); }
        catch { /* RunAsync contains its own failures; this is belt and braces. */ }
        _stopped.Dispose();
    }

    private static async Task RunAsync(
        ConnectionRegistry registry,
        Guid sessionId,
        string requestId,
        Func<BrowserJoinProgressEnvelope, Task> send,
        TimeSpan interval,
        Func<TimeSpan, CancellationToken, Task> delay,
        CancellationToken cancellationToken)
    {
        // What the last SENT envelope said, as the comparison key below. Null until the first send.
        (string Stage, int Step, int StepTotal, long ElapsedSeconds)? last = null;
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                if (Describe(registry, sessionId, requestId) is { } progress)
                {
                    // Elapsed is compared in WHOLE SECONDS — the resolution the viewer actually reads — so a tick
                    // that lands inside the same second as the previous one sends nothing, while the envelope
                    // itself still carries the exact millisecond count. Without the rounding "anything changed"
                    // would be true on every single tick, since elapsed always moves.
                    var key = (progress.Stage, progress.Step, progress.StepTotal, progress.ElapsedMs / 1000);
                    if (last != key)
                    {
                        last = key;
                        await send(progress).ConfigureAwait(false);
                    }
                }

                await delay(interval, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // The join resolved, or the socket is going away. Both are the normal end of this loop.
        }
        catch (Exception exception)
        {
            // A diagnostic must never be able to fail the thing it is describing: the join keeps running with no
            // progress line, exactly as it did before this existed.
            Console.Error.WriteLine(
                $"[couchcoop] join progress stopped: {exception.GetType().Name}: {exception.Message}");
        }
    }

    /// <summary>This session's current row as a wire envelope, or null when the registry has nothing to report.</summary>
    private static BrowserJoinProgressEnvelope? Describe(ConnectionRegistry registry, Guid sessionId, string requestId)
    {
        var row = registry.Snapshot().Rows.FirstOrDefault(candidate => candidate.Id == sessionId);
        return row is null
            ? null
            : new BrowserJoinProgressEnvelope("join-progress", requestId, StageToken(row.Stage),
                row.StepCount, row.StepTotal, row.ElapsedMs);
    }

    /// <summary>The wire spelling of a host stage. Unknown values report as failed rather than leaking a name.</summary>
    internal static string StageToken(ConnectionStage stage) => stage switch
    {
        ConnectionStage.Connecting => BrowserJoinProgressStages.Connecting,
        ConnectionStage.Choosing => BrowserJoinProgressStages.Choosing,
        ConnectionStage.Initializing => BrowserJoinProgressStages.Initializing,
        ConnectionStage.Joining => BrowserJoinProgressStages.Joining,
        ConnectionStage.LoadingView => BrowserJoinProgressStages.LoadingView,
        ConnectionStage.Complete => BrowserJoinProgressStages.Complete,
        _ => BrowserJoinProgressStages.Failed
    };
}
