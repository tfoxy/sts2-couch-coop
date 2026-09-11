using CouchCoop.Mod.Protocol;

namespace CouchCoop.Mod.Server;

// Per-connection FIFO of upstream input awaiting off-loop injection, with CONSECUTIVE-hover coalescing. The
// browser emits one hover/drag-motion input per animation frame while the cursor moves (40-80/s), and injecting
// each one blocks the game thread for up to a frame — so without coalescing a continuous cursor movement would
// build a backlog and delay the next click by seconds (the residual client→server lag). Hover/drag-motion is a
// snapshot stream (only the LATEST cursor position matters), so a hover replaces a trailing hover; discrete
// events (press/release/click/key) always append and are never dropped, preserving order relative to hovers
// (e.g. press → latest-drag-hover → release stays intact). Not thread-safe; the caller guards it with its lock.
internal sealed class InputCoalescer
{
    private readonly LinkedList<BrowserInputRequestEnvelope> _queue = new();

    public bool HasPending => _queue.First is not null;
    public int Count => _queue.Count;

    // The largest merged `count` this will build. Matches spirectl's own ReadWheelCount clamp, so the host never
    // hands the game thread a message it would only truncate anyway.
    internal const int MaxWheelCount = 20;

    public bool Enqueue(BrowserInputRequestEnvelope input)
    {
        if (IsHover(input) && _queue.Last is { } tail && IsHover(tail.Value))
        {
            tail.Value = input;
            return false;
        }
        else if (_queue.Last is { } wheelTail && TryMergeWheel(wheelTail.Value, input, out var merged))
        {
            wheelTail.Value = merged;
            return false;
        }
        else
        {
            _queue.AddLast(input);
            return true;
        }
    }

    public bool WouldCoalesce(BrowserInputRequestEnvelope input)
        => (IsHover(input) && _queue.Last is { } tail && IsHover(tail.Value))
            || (_queue.Last is { } wheelTail && TryMergeWheel(wheelTail.Value, input, out _));

    // R10 WS-E — WHEEL RUN MERGE. A wheel notch is a QUANTITY, not an edge: N consecutive same-direction ticks at the
    // same point are exactly one tick repeated N times, and the host injects strictly one queued message per
    // game-thread turn — so a fast scroll used to arrive as a visible trickle. Two ADJACENT wheel clicks fold into one
    // carrying their summed `count`.
    //
    // Adjacency is the whole safety argument: anything else in the stream (a hover, a press, a release, a key) is
    // appended as its own node, so a run can only form out of ticks with NOTHING between them — which means the cursor
    // provably did not move between them (a move would have enqueued a hover) and both ticks would have hit the same
    // control. Direction must match (opposite ticks cancel in the game but not in a count), and both must be FULL
    // clicks: a press/release is an edge whose repetition would desync the host's held-button state.
    private static bool TryMergeWheel(
        BrowserInputRequestEnvelope tail,
        BrowserInputRequestEnvelope next,
        out BrowserInputRequestEnvelope merged)
    {
        merged = next;
        if (!IsFullWheelClick(tail) || !IsFullWheelClick(next))
        {
            return false;
        }

        if (!string.Equals(tail.Button, next.Button, StringComparison.Ordinal))
        {
            return false;
        }

        var total = Math.Max(1, tail.Count ?? 1) + Math.Max(1, next.Count ?? 1);
        if (total > MaxWheelCount)
        {
            return false; // leave the full tail in place and start a new run — never silently drop ticks
        }

        // Keep the NEWEST message (its requestId/coordinates), carrying the run's total.
        merged = next with { Count = total };
        return true;
    }

    private static bool IsFullWheelClick(BrowserInputRequestEnvelope input)
        => string.Equals(input.Kind, BrowserInputKinds.Click, StringComparison.Ordinal)
            && input.Pressed is null
            && (string.Equals(input.Button, "wheel-up", StringComparison.OrdinalIgnoreCase)
                || string.Equals(input.Button, "wheel-down", StringComparison.OrdinalIgnoreCase));

    // Remove and return the next input to inject, or null when the queue is empty.
    public BrowserInputRequestEnvelope? Take()
    {
        if (_queue.First is not { } head)
        {
            return null;
        }

        _queue.RemoveFirst();
        return head.Value;
    }

    private static bool IsHover(BrowserInputRequestEnvelope input)
        => string.Equals(input.Kind, BrowserInputKinds.Hover, StringComparison.Ordinal);
}

internal sealed class BoundedInputQueue(int capacity = 256)
{
    private readonly object _gate = new();
    private readonly InputCoalescer _queue = new();
    private readonly SemaphoreSlim _capacity = new(capacity, capacity);

    public async Task EnqueueAsync(BrowserInputRequestEnvelope input, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_queue.WouldCoalesce(input))
            {
                _queue.Enqueue(input);
                return;
            }
        }

        await _capacity.WaitAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            if (!_queue.Enqueue(input)) _capacity.Release();
        }
    }

    public BrowserInputRequestEnvelope? Take()
    {
        lock (_gate)
        {
            var input = _queue.Take();
            if (input is not null) _capacity.Release();
            return input;
        }
    }
}
