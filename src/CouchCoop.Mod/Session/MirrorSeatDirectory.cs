using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Session;

/// <summary>
/// One couch-coop seat as the host's <see cref="HeadlessClientManager"/> currently sees it. Produced by
/// <see cref="HeadlessClientManager.DescribeSeats"/>; consumed by <see cref="MirrorSeatDirectory"/> to derive the
/// per-seat status the clients render.
/// </summary>
/// <param name="NetId">The seat's ENet netId (<c>1000 + slot</c>) — the identity the game gates a rejoin on.</param>
/// <param name="ClaimedName">The display name currently holding this slot's reconnect claim, or null when unclaimed.</param>
/// <param name="ProcessLive">Whether a headless process for this slot exists AND has not exited.</param>
/// <param name="Detached">Whether the slot is kept alive mid-run after its browser went away (see MarkDetached).</param>
public readonly record struct MirrorSeatDescription(
    ulong NetId,
    string? ClaimedName,
    bool ProcessLive,
    bool Detached);

/// <summary>The status the clients render for one seat: the wire discriminator plus its human-readable reason.</summary>
public readonly record struct MirrorSeatStatus(string Status, string? Reason)
{
    public static readonly MirrorSeatStatus Ready = new(MirrorSeatStatuses.Ready, null);

    /// <summary>Whether the picker may offer this seat (and the join handler accept it).</summary>
    public bool IsReady => string.Equals(Status, MirrorSeatStatuses.Ready, StringComparison.Ordinal);
}

/// <summary>
/// Derives the per-seat status that rides every session envelope, and auto-reaps the one seat state that is not
/// self-healing. Computed on the SERVER, deliberately, so the native and web pickers render identical rows from one
/// rule instead of each re-deriving joinability from raw flags.
///
/// <para>
/// The rule is MIRROR-MODE AWARE, because what the game will accept differs between the host's screens. On a lobby
/// screen (<c>mp-character-select</c> / <c>mp-load-game</c>) the host still admits peers, so a seat with no instance
/// is spawn-on-demand. Mid-RUN it does not: <c>NetError.RunInProgress</c> refuses any client that is not already in
/// the run, so a seat without a live, game-connected instance is genuinely unusable and must LOOK unusable rather
/// than accept a tap that silently fails.
/// </para>
///
/// <para>
/// Only ONE mode is named in the code (<see cref="RunMirrorMode"/>); every other value — including the newer
/// <c>sp-character-select</c>, an unknown kind from a newer host, and a null from an older one — takes the lobby
/// column. That is the safe default here: the lobby column is the permissive one, and on a screen nobody can join
/// the statuses it produces are never rendered anyway (the mirror shows no picker there at all).
/// </para>
///
/// <list type="table">
///   <listheader><term>observation</term><description>lobby → / run →</description></listheader>
///   <item>
///     <term>instance UP and ENet-CONNECTED</term>
///     <description><c>ready</c> → <c>ready</c>. The normal case; tapping reuses the instance. Mid-run this is
///     also the DETACHED reconnect path (headless kept alive, browser gone) — the seat is still the run's peer, so
///     taking it back works and it must stay offered.</description>
///   </item>
///   <item>
///     <term>instance DOWN (no live headless process)</term>
///     <description><c>ready</c> → <c>offline</c>. In a lobby this is the REJOIN case: tapping spawns a headless
///     bound to THAT seat's netId, which is how a player who reloaded a saved multiplayer game gets back into their
///     own seat. Mid-run there is no peer left for the run to recognise, so the row is disabled instead. Judged
///     FIRST, ahead of the game's connectedness — see the next paragraph.</description>
///   </item>
///   <item>
///     <term>instance UP but NOT connected</term>
///     <description><c>stuck</c> (reaped) → <c>offline</c>. In a lobby this is a useless zombie: the game refused or
///     dropped its peer, AND it squats on the slot — a correctly netId-bound respawn would be short-circuited into
///     sharing the zombie rather than replacing it — so the host reaps the instance, which frees the slot for a
///     clean spawn. Mid-run the reap would buy nothing (nothing may spawn into the run anyway), so the seat is only
///     reported offline; its grace timer stays armed, so the moment the host lands back on a lobby screen the same
///     seat reads stuck and IS reaped.</description>
///   </item>
/// </list>
///
/// <para>
/// PROCESS LIVENESS IS AUTHORITATIVE over the game's connectedness, which is why "no instance" is the FIRST
/// question <see cref="Evaluate"/> asks. STS2 keeps a dead peer flagged connected indefinitely: after a headless is
/// SIGKILLed the host log spams <c>ERROR: Peer not connected.</c> while the run roster still reports that player
/// <c>IsConnected</c>, so the netId stays in <paramref name="gameConnectedNetIds"/> forever. Asking "is the game
/// connected?" first therefore made the mid-run "no instance" cell UNREACHABLE in practice — the seat reported
/// <c>ready</c> with no process on the box at all, the picker offered it, and the join was accepted and spawned an
/// instance the run then refused. A process we can see is gone is the one signal that cannot be stale, so it wins:
/// no instance means disconnected, whatever the game still believes. (Lobby behaviour is unchanged either way —
/// both orderings report <c>ready</c> there, because spawn-on-demand is the rejoin.)
/// </para>
///
/// <para>
/// THE GRACE WINDOW IS THE LOAD-BEARING PART. A freshly spawned headless is "up but not connected" for its entire
/// cold start: it launches, ENet-joins, preloads ~770 assets and only then serves HTTP — routinely 20-30s, which is
/// why <see cref="HeadlessClientManager"/> waits a full 60s for readiness. Judging a seat on a single observation
/// would therefore kill every slow-starting instance and report a perfectly healthy join as broken. A seat is only
/// called stuck once it has been observed live-and-disconnected CONTINUOUSLY for <see cref="StuckGrace"/>, which is
/// pinned to that same 60s deadline. Any connected observation, or the process going away, clears the timer.
/// </para>
///
/// <para>
/// After a reap the seat's next observation is "instance down" → <c>ready</c> again, so the disabled row is
/// transient by design: the reap is the remediation, and the seat becomes retryable the moment it completes. The
/// reason copy tells the viewer what to do if the retry lands in the same state (the host's game session is the
/// thing refusing the peer, so restarting the game is the real fix).
/// </para>
///
/// <para>Thread-safety: session envelopes are built per-connection off the accept loop, so every access is locked.</para>
/// </summary>
public sealed class MirrorSeatDirectory
{
    /// <summary>
    /// How long a seat must be observed live-but-disconnected before it counts as a zombie. Pinned to
    /// <see cref="HeadlessClientManager"/>'s 60s readiness deadline: anything shorter would reap instances that are
    /// still in a normal cold start (see the class remarks). A LONGER window is harmless — the seat just stays
    /// tappable-but-useless a little longer — so this errs on the side of never killing a healthy instance.
    /// </summary>
    public static readonly TimeSpan StuckGrace = TimeSpan.FromSeconds(60);

    /// <summary>
    /// The mirror mode of the host screen that means "a multiplayer run is in progress" — the one screen where the
    /// game refuses a client that is not already in the run. Same vocabulary the session envelope's
    /// <c>screen.mirrorMode</c> carries (BrowserAssignmentClassifier.MirrorModeFor).
    /// </summary>
    public const string RunMirrorMode = "mp-run";

    // Copy for the disabled row. The seat cannot be fixed from the client side: the host's live game session is what
    // is refusing (or has dropped) this peer, and only a fresh host game session re-opens it.
    private const string StuckReason = "Cannot rejoin — host must restart the game";

    // Copy for the mid-run disabled row. Nothing here is BROKEN — the run simply cannot be joined by a client that
    // is not already in it — so the copy names the real (and only) way back in rather than blaming the instance.
    // That way back is the HOST's: STS2 refuses any peer that is not already in the run (NetError.RunInProgress),
    // so the seat can only be re-admitted by the host reloading the saved run, which re-opens the lobby every
    // saved seat rejoins through. The old copy ("cannot rejoin while the run is in progress") stated the refusal
    // without naming the remedy, which left a viewer whose headless had exited with nothing to do but wait.
    private const string OfflineReason = "Disconnected — the host must reload the saved run to let this seat rejoin";

    private readonly object _gate = new();
    // netId → the UTC instant that seat was FIRST observed live-but-disconnected in its current spell. Cleared on any
    // healthy observation, so a seat that flickers connected never accumulates toward the grace window.
    private readonly Dictionary<ulong, DateTimeOffset> _disconnectedSince = [];
    // The last evaluation's verdict per seat, so the JOIN handler can refuse a seat the picker would not have
    // offered (see RefuseJoin). Every join is preceded by the session envelope that built this, on the same screen.
    private Dictionary<ulong, MirrorSeatStatus> _lastStatuses = [];
    private readonly Func<IReadOnlyList<MirrorSeatDescription>>? _describeSeats;
    private readonly Action<ulong>? _reapSeat;
    private readonly Func<DateTimeOffset> _clock;

    /// <param name="describeSeats">
    /// Reads the host's live seat table (<see cref="HeadlessClientManager.DescribeSeats"/>). Null on a HEADLESS
    /// client instance (it owns no seats) and when the host could not resolve its game exe — the directory then
    /// reports every seat ready, which is the correct degradation: joinability is decided by the game, and we simply
    /// have nothing extra to say about it.
    /// </param>
    /// <param name="reapSeat">
    /// Invoked once per seat that crosses into <c>stuck</c>: kills that seat's headless and cleans up after it (the
    /// server also evicts the stale ENet peer and drops its display-name override). Null disables the reap.
    /// </param>
    /// <param name="clock">Injectable time source for tests; defaults to <see cref="DateTimeOffset.UtcNow"/>.</param>
    public MirrorSeatDirectory(
        Func<IReadOnlyList<MirrorSeatDescription>>? describeSeats = null,
        Action<ulong>? reapSeat = null,
        Func<DateTimeOffset>? clock = null)
    {
        _describeSeats = describeSeats;
        _reapSeat = reapSeat;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// Resolve the status of every mirror seat, given which netIds the GAME currently reports as connected.
    /// <paramref name="gameConnectedNetIds"/> comes from the state snapshot's own connectedness
    /// (<c>StateCharacterSelectPlayerSnapshot.IsConnected</c> in a lobby, <c>StateRunPlayerSnapshot.IsConnected</c>
    /// in a run) — the seats the host's netcode actually has peers for. A netId absent from that set is not
    /// connected as far as the game is concerned. Being PRESENT in it does not by itself make a seat ready: the
    /// game keeps dead peers flagged connected (see "PROCESS LIVENESS IS AUTHORITATIVE" in the class remarks), so a
    /// seat whose headless process is gone is judged on the process, not on this set.
    /// <para>
    /// Reaps are performed as a side effect of the evaluation (the envelope build is the only regular tick the host
    /// has for this), but only ONCE per spell: the reap clears the seat's timer, so the next observation starts over.
    /// </para>
    /// </summary>
    /// <param name="mirrorMode">
    /// The host screen's mirror mode (the same value the session envelope carries as <c>screen.mirrorMode</c>).
    /// <see cref="RunMirrorMode"/> selects the mid-run column of the matrix in the class remarks; ANY other value —
    /// including null, an older/unknown screen, or a lobby — keeps the lobby column, which is the safe default
    /// (spawn-on-demand stays offered rather than a seat being wrongly locked out).
    /// </param>
    public IReadOnlyDictionary<ulong, MirrorSeatStatus> Evaluate(
        IReadOnlySet<ulong> gameConnectedNetIds,
        string? mirrorMode = null)
    {
        ArgumentNullException.ThrowIfNull(gameConnectedNetIds);

        var seats = SafeDescribeSeats();
        if (seats.Count == 0)
        {
            lock (_gate)
            {
                _lastStatuses = [];
            }

            return EmptyStatuses;
        }

        // Mid-run the game refuses any client that is not already in the run, so a seat without a live,
        // game-connected instance cannot be taken however it got that way.
        var runInProgress = string.Equals(mirrorMode, RunMirrorMode, StringComparison.Ordinal);
        var statuses = new Dictionary<ulong, MirrorSeatStatus>(seats.Count);
        List<ulong>? toReap = null;
        var now = _clock();

        lock (_gate)
        {
            foreach (var seat in seats)
            {
                // NO INSTANCE IS THE FIRST QUESTION ASKED, deliberately ahead of the game's connectedness — see
                // "PROCESS LIVENESS IS AUTHORITATIVE" in the class remarks. Nothing to be stuck ON either, so clear
                // any timer: a later spawn starts with a fresh grace window instead of inheriting the previous
                // instance's. In a lobby the row stays tappable (tapping spawns a headless bound to this netId —
                // that IS the rejoin); mid-run there is no peer for the run to recognise, so it is offline.
                if (!seat.ProcessLive)
                {
                    _disconnectedSince.Remove(seat.NetId);
                    statuses[seat.NetId] = runInProgress ? Offline : MirrorSeatStatus.Ready;
                    continue;
                }

                // The seat's instance is up AND is the run's peer: joinable everywhere. Clear any timer — a seat
                // that flickers connected never accumulates toward the grace window.
                if (gameConnectedNetIds.Contains(seat.NetId))
                {
                    _disconnectedSince.Remove(seat.NetId);
                    statuses[seat.NetId] = MirrorSeatStatus.Ready;
                    continue;
                }

                if (!_disconnectedSince.TryGetValue(seat.NetId, out var since))
                {
                    // First observation of this spell — start the clock, report ready. A cold-starting headless
                    // lives here for its whole 20-30s load, and it matters mid-run too: an instance that was still
                    // loading when the host started the run (or one whose peer flickers) is about to be the run's
                    // live peer, so judging it on a single observation would disable a seat that is coming up.
                    _disconnectedSince[seat.NetId] = now;
                    statuses[seat.NetId] = MirrorSeatStatus.Ready;
                    continue;
                }

                if (now - since < StuckGrace)
                {
                    statuses[seat.NetId] = MirrorSeatStatus.Ready;
                    continue;
                }

                if (runInProgress)
                {
                    // Offline, NOT reaped: mid-run nothing may spawn into the seat anyway, so killing the instance
                    // buys nothing. The timer stays armed deliberately — the moment the host lands on a lobby
                    // screen this same observation re-reads as stuck and the reap happens then.
                    statuses[seat.NetId] = Offline;
                    continue;
                }

                statuses[seat.NetId] = new MirrorSeatStatus(MirrorSeatStatuses.Stuck, StuckReason);
                // Reap once per spell: dropping the timer means the (now process-less) seat re-reads as ready next
                // time, and a seat that somehow stays live re-arms the full grace window before we kill it again.
                _disconnectedSince.Remove(seat.NetId);
                (toReap ??= []).Add(seat.NetId);
            }

            LogTransitionsLocked(seats, statuses, gameConnectedNetIds, mirrorMode);
            _lastStatuses = statuses;
        }

        if (toReap is not null && _reapSeat is not null)
        {
            foreach (var netId in toReap)
            {
                // Never let a reap failure abort the envelope: the status is already computed and the row renders
                // correctly disabled either way; the seat is simply retried on the next evaluation.
                try { _reapSeat(netId); }
                catch (Exception ex)
                {
                    CouchCoopLog.Stderr($"reaping stuck seat netId={netId} failed: {ex.GetType().Name}: {ex.Message}");
                }
            }
        }

        return statuses;
    }

    /// <summary>
    /// Log every seat whose status CHANGED since the last evaluation, with the three inputs that decided it. This
    /// runs on the envelope build (many times a second), so it is deliberately transition-only: a steady seat costs
    /// one dictionary lookup and prints nothing.
    /// <para>
    /// It exists because "the picker offered a seat it should not have" was, in the field, completely unfalsifiable:
    /// the wire shows the VERDICT (<c>seatStatus</c>) but none of its inputs, so a stale <c>gameConnected</c> and a
    /// dead <c>processLive</c> produce indistinguishable evidence. Printing the inputs at the moment they flip is
    /// what turns that into a five-second diagnosis. Caller holds <c>_gate</c>.
    /// </para>
    /// </summary>
    private void LogTransitionsLocked(
        IReadOnlyList<MirrorSeatDescription> seats,
        Dictionary<ulong, MirrorSeatStatus> statuses,
        IReadOnlySet<ulong> gameConnectedNetIds,
        string? mirrorMode)
    {
        foreach (var seat in seats)
        {
            if (!statuses.TryGetValue(seat.NetId, out var now))
            {
                continue;
            }

            var had = _lastStatuses.TryGetValue(seat.NetId, out var was);
            if (had && string.Equals(was.Status, now.Status, StringComparison.Ordinal))
            {
                continue;
            }

            // stderr only, deliberately. Unlike address ranking (which runs inside the game), this path is exercised
            // by unit tests, and Godot.GD.Print outside a Godot runtime
            // SEGFAULTS the test host — a native crash `catch` cannot intercept (verified: exit 139). So the seat
            // verdict remains available through the current launcher-side stdio capture or an attached terminal.
            CouchCoopLog.Stderr(
                $"mirror-seat netId={seat.NetId} {(had ? was.Status : "none")}->{now.Status} "
                + $"processLive={seat.ProcessLive} gameConnected={gameConnectedNetIds.Contains(seat.NetId)} "
                + $"detached={seat.Detached} claim={seat.ClaimedName ?? "none"} mode={mirrorMode ?? "none"}");

        }
    }

    private static readonly MirrorSeatStatus Offline = new(MirrorSeatStatuses.Offline, OfflineReason);

    private static readonly IReadOnlyDictionary<ulong, MirrorSeatStatus> EmptyStatuses =
        new Dictionary<ulong, MirrorSeatStatus>();

    /// <summary>
    /// The <c>joinRejection</c> code for a join that targets <paramref name="targetNetId"/>, or null when the join
    /// may proceed. The SAME verdict the picker rendered (the last <see cref="Evaluate"/>, which every session
    /// envelope — including the one that produced the picker being tapped — has just run on this screen), so a
    /// client cannot drive a join the picker would have refused to offer: a stale roster, a retried request, or a
    /// hand-crafted message would otherwise spawn into a seat the game will not take and fail silently.
    /// <para>
    /// Null for a free-text name submit (no seat targeted — nothing seat-shaped to judge) and for a netId this host
    /// has no opinion on (no seat table, or a seat that vanished between the envelope and the tap): joinability is
    /// ultimately the game's call, so an absent opinion never blocks.
    /// </para>
    /// </summary>
    public string? RefuseJoin(ulong? targetNetId)
    {
        if (targetNetId is not ulong netId)
        {
            return null;
        }

        lock (_gate)
        {
            if (!_lastStatuses.TryGetValue(netId, out var status) || status.IsReady)
            {
                return null;
            }
        }

        return MirrorSeatStatuses.UnavailableRejection;
    }

    private IReadOnlyList<MirrorSeatDescription> SafeDescribeSeats()
    {
        if (_describeSeats is null)
        {
            return [];
        }

        try
        {
            return _describeSeats() ?? [];
        }
        catch (Exception ex)
        {
            // Degrade to "no opinion" (every seat ready) rather than failing the session envelope — the join screen
            // is the ONLY way back in, so it must render even when the seat table cannot be read.
            CouchCoopLog.Stderr($"describing mirror seats failed: {ex.GetType().Name}: {ex.Message}");
            return [];
        }
    }
}
