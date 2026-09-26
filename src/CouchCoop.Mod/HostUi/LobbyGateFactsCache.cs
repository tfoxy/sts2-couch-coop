using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.HostUi;

/// <summary>
/// Remembers the last gate facts read for the current lobby screen, so the panel's heartbeat tick reuses the
/// decision instead of reading the game again.
/// </summary>
/// <remarks>
/// <para>
/// PUSH, NOT POLL. The facts are read when something PUSHED says they may have changed: the game's screen event, a
/// screen mount, a screen's visibility change, or the hook on a lobby assignment. Each of those calls
/// <see cref="MarkDirty"/>; the next evaluation reads once and clears it. An evaluation with nothing pushed since
/// (the 0.25 s heartbeat tick) gets the remembered facts back and touches nothing in the game.
/// </para>
/// <para>
/// A wake that lands while a chain is already running is dropped by the controller's coalescing latch, so it must
/// still leave its mark here: that is what makes the chain's next evaluation read. Without the mark a dropped wake
/// would be a lost signal.
/// </para>
/// <para>
/// THREE CASES READ EVEN WITHOUT A MARK. A different screen than the remembered one; nothing remembered yet; and a
/// remembered read that FAILED (<see langword="null"/>, "unavailable"), which is retried by the next evaluation
/// rather than pinned for the whole visit. <paramref name="alwaysRead"/> is the existing safety valve for a game
/// whose screen event cannot be subscribed: with no push signal there is nothing to mark, so it reads every time,
/// exactly as that valve always polled.
/// </para>
/// <para>Main-thread only, like the evaluation that owns it; <see cref="MarkDirty"/> is safe from any thread.</para>
/// </remarks>
internal sealed class LobbyGateFactsCache
{
    private int _dirty = 1;
    private bool _has;
    private ulong _screenId;
    private GateFacts? _facts;

    /// <summary>How many times <c>read</c> was actually called: the read counter the tests and QA compare.</summary>
    internal long Reads { get; private set; }

    /// <summary>Something pushed says the facts may have changed. Safe from any thread.</summary>
    internal void MarkDirty() => Volatile.Write(ref _dirty, 1);

    /// <summary>
    /// No lobby screen is current any more, so the remembered facts describe nothing. The next lobby the player
    /// reaches reads afresh.
    /// </summary>
    internal void Invalidate()
    {
        _has = false;
        _facts = null;
    }

    /// <summary>The facts for the lobby screen <paramref name="screenId"/>: remembered, or read now.</summary>
    /// <param name="read">The game read. Called only when the answer is not already remembered.</param>
    internal GateFacts? Resolve(ulong screenId, bool alwaysRead, Func<GateFacts?> read)
    {
        ArgumentNullException.ThrowIfNull(read);

        // Clear the mark BEFORE reading: a push that lands during the read must survive it.
        var dirty = Interlocked.Exchange(ref _dirty, 0) != 0;
        if (!alwaysRead && !dirty && _has && _screenId == screenId && _facts is not null)
        {
            return _facts;
        }

        Reads++;
        var facts = read();
        _has = true;
        _screenId = screenId;
        _facts = facts;
        return facts;
    }
}
