namespace CouchCoop.Mod.Session;

/// <summary>
/// What a browser's disconnect does to the seat process that browser was driving, decided from whether the host's
/// game is in a run. It lives here, apart from the WebSocket connection that calls it, so the decision can be
/// exercised with a fake seat manager and a fake run-presence read.
/// </summary>
public static class BrowserDisconnectSeat
{
    /// <summary>
    /// Applies the disconnect of <paramref name="sessionId"/> to its seat.
    /// <list type="bullet">
    /// <item>
    /// <description>
    /// DURING A RUN: KEEP the seat process alive (mark it detached). It stays ENet-joined to the host's run as its
    /// netId, so when the browser reconnects it re-claims the SAME live seat and instantly sees the live run: no
    /// respawn, no ENet rejoin. A detached seat is reaped when the game leaves both the run and any lobby (the roster
    /// observer's reap) or when the game quits (<see cref="HeadlessClientManager.Dispose"/>).
    /// </description>
    /// </item>
    /// <item>
    /// <description>
    /// IN THE LOBBY (or at the main menu, or when run presence cannot be read): kill it now and evict its ENet peer,
    /// which frees the netId and removes the phantom lobby player.
    /// </description>
    /// </item>
    /// </list>
    /// </summary>
    /// <param name="manager">The seat manager that owns the session's seat, if it has one.</param>
    /// <param name="sessionId">The browser session that just disconnected.</param>
    /// <param name="runInProgress">
    /// Whether the game is in a run right now (<see cref="CouchCoopLobbyParticipation.IsRunInProgress"/>), read
    /// exactly once, before anything is changed. It is a plain typed read with no state snapshot, so it costs a
    /// disconnect nothing measurable and is safe on the socket's own thread.
    /// </param>
    /// <param name="evictPeer">Force-disconnects the seat's ENet peer by netId from the host's net server.</param>
    /// <param name="clearClientName">Drops the display-name override registered for a netId.</param>
    public static void Apply(
        HeadlessClientManager manager,
        Guid sessionId,
        Func<bool> runInProgress,
        Action<ulong> evictPeer,
        Action<ulong> clearClientName)
    {
        ArgumentNullException.ThrowIfNull(manager);
        ArgumentNullException.ThrowIfNull(runInProgress);
        ArgumentNullException.ThrowIfNull(evictPeer);
        ArgumentNullException.ThrowIfNull(clearClientName);

        if (runInProgress())
        {
            manager.MarkDetached(sessionId);
            return;
        }

        var freedNetId = manager.Release(sessionId);
        if (freedNetId is not ulong evictNetId)
        {
            return;
        }

        // The SIGKILL'd headless leaves its peer registered in the host's ENet server holding this netId until
        // ENet's ~20-40s timeout; evicting frees it immediately so a same-name rejoin isn't rejected at the
        // handshake (IdCollision -> timeout).
        evictPeer(evictNetId);

        // Drop the display-name override ONLY when this seat is genuinely gone, i.e. no name still CLAIMS the slot
        // behind this netId.
        //
        // The rule, and why it isn't just "always clear on disconnect": clearing hands the nameplate back to the
        // game's fallback source, PlatformUtil.GetPlayerNameRaw -> the durable mp_names.json roster as this host
        // process parsed it at ITS start, which may still name an EARLIER holder of this netId. So a premature
        // clear doesn't blank the name, it resurrects an older one. (The roster itself is intentionally persistent
        // — it is the only netId->name memory a saved run can be relabelled from — so the fix is to keep the
        // override, never to erase the file.) Release() above deliberately keeps the departing player's
        // name->slot claim (their netId stays reserved for a reconnect), and the mid-run branch (MarkDetached)
        // keeps the claim AND the process, so in both cases the seat is "vacant, still theirs" and the override
        // must stay. A netId that is genuinely taken over by a DIFFERENT player needs no clear either:
        // EnsureHeadlessAsync reports the new binding (onSlotBound) and the connection SetClientNames it before
        // that headless starts. What remains — a claim that was actually dropped (run-end reap, slot steal) — is
        // the only case that clears, and CouchCoopBrowserServer's run-end reap already covers the reap half.
        if (!manager.HasClaimForNetId(evictNetId))
        {
            clearClientName(evictNetId);
        }
    }
}
