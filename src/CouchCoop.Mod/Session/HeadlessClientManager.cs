using CouchCoop.Mod.Connections;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Abstraction over a spawned headless game process. Exists so the slot-allocation / dedup / reuse /
/// release bookkeeping in <see cref="HeadlessClientManager"/> can be unit-tested with fakes instead of
/// spawning real game processes. <see cref="HeadlessClientManager.TryCreate"/> uses the real
/// <see cref="OsHeadlessProcess"/> implementation.
/// </summary>
public interface IHeadlessProcess
{
    int Id { get; }
    bool HasExited { get; }
    int ExitCode { get; }

    /// <summary>
    /// Ask the process to shut down cleanly (Linux: SIGTERM). This lets the headless run its normal
    /// teardown — crucially an ENet disconnect/leave — so the host's netcode drops the peer and no
    /// phantom lobby player is left behind. Returns true if the signal was delivered.
    /// </summary>
    bool RequestGracefulStop();

    /// <summary>Forcibly terminate the process and its children (Linux: SIGKILL). Used as a fallback.</summary>
    void Kill();

    void Dispose();
}

/// <summary>
/// Manages per-browser-player headless game instances. When a non-host browser player joins,
/// the host mod spawns a headless Godot process for them (slot 2→port 13357, slot 3→13367, …).
/// Each headless runs the full CouchCoop mod stack and streams its own scene tree to that
/// player's browser. The browser is redirected to the headless port after the instance is ready.
///
/// Headless launch: <c>COUCHCOOP_HEADLESS_WRAPPER</c> env var (e.g.
/// <c>"gamescope --backend headless -W 1280 -H 720 -w 1280 -h 720 -r 16 --"</c>) prefixes the
/// game exe. If unset, the game exe is invoked directly (works without a display for testing).
///
/// Join: NO game CLI args — a seat is launched with <c>--headless</c> alone and is told everything through the
/// environment (<c>COUCHCOOP_CLIENT_ID</c>, <c>COUCHCOOP_HOST_NETID</c>, <c>COUCHCOOP_JOIN_HOST</c>). Inside the
/// seat, <c>CommandLineOverridePatch</c> re-materializes <c>fastmp=join</c> + <c>clientId</c> so the game's own
/// <c>NJoinFriendScreen</c> auto-join runs unchanged and dials the host's ENet listener on
/// <c>127.0.0.1:33771</c>. See <see cref="SeatLaunchEnvironment"/>.
///
/// NetId: slot 2 → 1002, slot 3 → 1003, slot 4 → 1004 (matches v1 RemotePlayerRegistry). How FAR the slots run
/// is not fixed: the top slot follows the live lobby's player cap (see <see cref="MaxSlot"/>), which the stock
/// game sets to four players — host + three seats — and the multiplayer limit mods raise.
/// </summary>
public sealed partial class HeadlessClientManager : IDisposable
{
    private const int MinSlot = 2;

    /// <summary>
    /// Seats available when NO probe is wired at all (a standalone browser server, a test). Three — the stock
    /// game's four-player lobby minus the host's own seat — so an un-probed manager behaves exactly as it did
    /// before the cap became dynamic. A wired probe that reports an unknown cap is a different case; see
    /// <see cref="MaxSlot"/>.
    /// </summary>
    private const int DefaultSeats = 3;

    /// <summary>
    /// The highest slot a seat can ever occupy, whatever the lobby says. Slot → netId is <c>1000 + slot</c> and
    /// <see cref="MirrorSeatNetIds"/> reserves 1001..1099 for couch seats, so slot 99 is where the seat identity
    /// space itself runs out — past it a "seat" would collide with a genuine remote player and the pickers would
    /// stop classifying it. Nothing in the product is expected to reach this; it exists so a garbage lobby value
    /// (or a future limit mod with no ceiling of its own) cannot walk the allocator out of the guard band.
    /// </summary>
    private const int SlotCeiling = (int)(MirrorSeatNetIds.MaxNetId - BaseNetId);

    public const int HostPort = 13337;
    private const int PortStep = 10;
    private const ulong BaseNetId = 1000UL;

    // How long to wait for a SIGTERM'd headless to exit on its own (ENet leave + teardown) before
    // escalating to SIGKILL. Generous enough to let an ENet disconnect packet flush to the host,
    // short enough that slot reuse on reconnect isn't noticeably delayed.
    private static readonly TimeSpan GracefulStopTimeout = TimeSpan.FromSeconds(3);

    /// <summary>
    /// TUNING knob for <see cref="SeatReadyTimeout"/>, in seconds. Same polarity as
    /// <see cref="SeatMemoryTuningEnvironment"/>: an operator value WINS over ours — the default is a guess about
    /// somebody else's PC, and the person running the host is the only one who can see how slow it actually is.
    /// Not contract: a seat spawned under any of these values joins and plays identically.
    /// </summary>
    internal const string SeatReadyTimeoutEnvironmentVariable = "COUCHCOOP_SEAT_READY_TIMEOUT_SECONDS";

    /// <summary>
    /// How long a freshly spawned seat gets to start serving its browser port before the host gives up and kills
    /// it (see <see cref="WaitForReadyAsync"/>).
    /// <para>
    /// 75s, and the number is chosen against the BROWSER's budget, not against a stopwatch on a developer's PC.
    /// The page gives up on a silent host after 90s (<c>JOIN_TIMEOUT_MS</c> in <c>MirrorApp.vue</c>), so anything
    /// at or past 90 here means the host kills a seat the phone has ALREADY abandoned, and anything well short of
    /// it — the old 60 — kills seats the phone would still have accepted, which is the bug this replaced: a cold
    /// seat routinely takes 20-30s on a desktop, and a Steam Deck (4 cores / 8 threads at a 15W TDP shared with
    /// the GPU, already running the host game) is exactly the machine that runs past it while starting normally.
    /// The 15s of headroom that is left is not spare: the phone's clock starts at its join message, ahead of ours
    /// (slot bookkeeping, the roster write, the process spawn), and the S11 timeout line then has to reach the
    /// panel and the rejection reach the phone while it is still listening. Failing visibly beats failing silently,
    /// so the host must always lose the race to the browser rather than tie it.
    /// </para>
    /// </summary>
    internal const double DefaultSeatReadyTimeoutSeconds = 75.0;

    /// <summary>
    /// Clamp band for <see cref="SeatReadyTimeoutEnvironmentVariable"/>. The floor exists so a typo (or a zero)
    /// cannot turn every join into an instant kill; the ceiling so a fat-fingered value cannot park a viewer on
    /// "Joining…" for a quarter of an hour. Between them we do as we are told, INCLUDING past the browser's own
    /// 90s ceiling — an operator debugging a very slow machine with a patched page is a real case, and second-
    /// guessing them here would just move the argument into the code.
    /// </summary>
    internal const double MinSeatReadyTimeoutSeconds = 1.0;

    /// <inheritdoc cref="MinSeatReadyTimeoutSeconds"/>
    internal const double MaxSeatReadyTimeoutSeconds = 900.0;


    // Guards the slot bookkeeping below. ORDERING RULE: nothing may block on the game's main thread while holding
    // this — the main thread takes it too (DescribeSeats on every screen change, Dispose at shutdown), so doing so
    // deadlocks the game. The two known temptations are MaxSlot (its probe marshals to the main thread; snapshot it
    // before locking — see its doc) and slot-bound callbacks (see ReportSlotBound's re-entrancy contract).
    private readonly object _lock = new();
    private readonly Dictionary<int, IHeadlessProcess> _processBySlot = [];
    private readonly Dictionary<Guid, int> _sessionToSlot = [];
    // Maps display name → slot so a reconnect with the same name reuses the live headless instance
    // instead of consuming another slot and duplicating the lobby player. Keyed case-insensitively /
    // trimmed (NormalizeName) so "Bob" and " bob " resolve to the same instance.
    private readonly Dictionary<string, int> _nameToSlot = new(StringComparer.OrdinalIgnoreCase);
    // netId → display name as the HOST resolves it (its own Steam persona, remote Steam friends, and the couch
    // seats), pushed in by PublishRosterNames and republished to the seats through mp_names.json. Separate from
    // _nameToSlot because it is not a slot allocation: these netIds are mostly NOT ours to spawn.
    private readonly Dictionary<ulong, string> _publishedNames = [];
    // Slots whose browser disconnected DURING A RUN: the headless is intentionally KEPT ALIVE (still ENet-joined
    // to the host's run as its netId) so the browser reconnects instantly to the live run instead of re-spawning
    // and rejoining. Reaped (killed) when the host quits the run (ReapDetachedSlots, driven by the host state
    // observer) or the game (Dispose); cleared when the browser reconnects and re-claims the slot.
    private readonly HashSet<int> _detachedSlots = [];
    private readonly Func<int, IHeadlessProcess?> _launcher;
    // Probe used by WaitForReadyAsync to decide when a freshly spawned headless is serving on its port.
    // Defaults to the real HTTP poll; the test ctor injects an instant probe so the slot bookkeeping
    // (dedup / reuse / reap / release) can be exercised without a real HTTP server.
    private readonly Func<int, CancellationToken, Task<SeatListenerProbeResult>> _readinessProbe;
    // Asks whether a seat's computed browser port is genuinely free on this machine BEFORE we spawn into it,
    // returning an English description of the owner (or null). Defaults to the real loopback connect + test bind;
    // the test ctor injects a decided answer so the allocator's slot-skip can be exercised without sockets — and
    // one test deliberately uses the REAL probe against a live blackhole listener. See SeatPortAvailability.
    private readonly Func<int, CancellationToken, Task<string?>> _seatPortProbe;
    // Invoked when we RESPAWN a headless on a claimed-but-dead slot (a mid-run reconnect): force-evicts any
    // stale ENet peer still holding that netId on the host so the respawned headless's same-netId handshake
    // isn't rejected (IdCollision → timeout). Null in tests / when no host net server is available. Idempotent
    // on the host side (no peer → no-op), so it's safe to call even when the peer was already evicted on Release.
    private readonly Action<ulong>? _evictStalePeer;
    // How many couch seats the LIVE lobby has room for (its player cap minus the host's own seat). A probe, not a
    // constant, because the cap is not ours to choose: the stock game allows four players, and the multiplayer
    // limit mods raise that — see CouchCoopLobbyParticipation.MaxCouchSeats, which is what the host wires in here.
    // Null in tests / on a headless client instance, which then get DefaultSeats.
    private readonly Func<int?>? _maxSeatsProbe;
    private readonly string? _gameExe;
    private readonly string? _headlessWrapper;
    private bool _disposed;

    public static int SlotToPort(int slot) => HostPort + slot * PortStep;
    public static ulong SlotToNetId(int slot) => BaseNetId + (ulong)slot;

    /// <summary>
    /// How many slots the pre-spawn port survey looks at. Bounded because <see cref="MaxSlot"/> is not: a probed
    /// lobby that reports no cap opens the whole 1002..1099 guard band, and surveying all of it on every join
    /// would trade a real cost for information about seats nobody is about to take. The pinned slots (a
    /// netId-bound rejoin, a name's existing claim) are ALWAYS surveyed on top of this, because those are the two
    /// cases that cannot route around an occupied port.
    /// </summary>
    private const int MaxSurveyedSeatPorts = 8;

    /// <summary>
    /// Which seat ports are already owned by something else on this computer, measured BEFORE <c>_lock</c> is
    /// taken and handed to the locked allocation as a plain lookup.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The pre-lock timing is the same rule <see cref="MaxSlot"/> documents, for a different reason: this probe
    /// does not marshal to the game's main thread, but it CAN block for
    /// <see cref="SeatPortAvailability.ProbeTimeout"/> per port when a local firewall rule drops the packet
    /// instead of refusing it — and the main thread takes <c>_lock</c> on every screen change. Probes run
    /// concurrently so a pathological port costs one timeout for the whole survey, not one each.
    /// </para>
    /// <para>
    /// A slot already running one of OUR seats surveys as occupied (its own listener answers). That is harmless:
    /// every branch that could act on the result returns earlier for a live process.
    /// </para>
    /// </remarks>
    private async Task<Dictionary<int, string>> SurveySeatPortsAsync(
        int maxSlot,
        string? displayName,
        ulong? targetNetId,
        CancellationToken cancellationToken)
    {
        var slots = new List<int>();
        void Consider(int slot)
        {
            if (slot >= MinSlot && slot <= maxSlot && !slots.Contains(slot)) slots.Add(slot);
        }

        if (targetNetId is ulong netId && TryNetIdToSlot(netId, maxSlot, out var boundSlot)) Consider(boundSlot);
        if (NormalizeName(displayName) is { } name)
        {
            lock (_lock)
            {
                if (_nameToSlot.TryGetValue(name, out var claimed)) Consider(claimed);
            }
        }

        for (var slot = MinSlot; slot <= maxSlot && slots.Count < MaxSurveyedSeatPorts; slot++) Consider(slot);

        var probed = await Task.WhenAll(slots.Select(async slot =>
            (Slot: slot, Owner: await _seatPortProbe(SlotToPort(slot), cancellationToken).ConfigureAwait(false))))
            .ConfigureAwait(false);

        var occupied = new Dictionary<int, string>();
        foreach (var (slot, owner) in probed)
        {
            if (!string.IsNullOrWhiteSpace(owner)) occupied[slot] = owner;
        }

        return occupied;
    }


    /// <summary>
    /// The highest slot currently allocatable: <see cref="MinSlot"/> plus however many seats the live lobby has
    /// room for, clamped to <see cref="SlotCeiling"/>.
    /// <para>
    /// Read FRESH on every use rather than cached at construction, deliberately. The two multiplayer limit mods
    /// raise the lobby cap at different moments — "Unlimited" rewrites the argument the lobby is built with (right
    /// from the start), while "Multiplayer Limit Break" writes the field from its own join/connect hooks (so an
    /// early read still sees the stock 4) — and the host mod is constructed long before either has run. A cached
    /// cap would pin us to whatever happened to be true at startup.
    /// </para>
    /// <para>
    /// NEVER evaluate this while holding <c>_lock</c>. The probe (CouchCoopLobbyParticipation.MaxCouchSeats) is a
    /// state pull that BLOCKS on a marshal to the game's main thread, and the main thread itself takes <c>_lock</c>
    /// (<see cref="DescribeSeats"/> via the screen-change session resend, <see cref="Dispose"/> at shutdown) — so a
    /// probe under the lock is an ABBA deadlock that freezes the whole game. That was the room-load freeze: a room
    /// change fires the session resend on BOTH the scene-watcher thread and the main thread; the watcher won the
    /// lock, evaluated this inside it, and parked forever on a main thread that was parked on the lock. Public
    /// entry points snapshot this once, before locking, and hand the value to their locked helpers.
    /// </para>
    /// </summary>
    private int MaxSlot
    {
        get
        {
            // UNPROBED (a standalone server, a test) is a different answer from PROBED-AND-UNKNOWN. With no probe
            // nothing here has ever known the lobby and the stock three seats are the historical behaviour. A
            // probe that reports null means there is a host but no lobby to ask RIGHT NOW — mid-run, or on the
            // main menu — and the stock three would then be a cap we invented: the netId-BOUND respawn path is
            // live exactly then, so assuming three is how a mid-run rejoin by seat 1005 of an eight-player game
            // used to be refused as "not a seat". With no cap to apply, the guard band is the only real limit,
            // which is what it is for. Nothing widens the NEW-peer window, which CouchCoopLobbyParticipation
            // .MayLaunchNewHeadless still shuts whenever there is no lobby.
            int? seats = null;
            var probed = false;
            if (_maxSeatsProbe is not null)
            {
                try
                {
                    seats = _maxSeatsProbe();
                    probed = true;
                }
                catch (Exception ex)
                {
                    // A cap we cannot read must never cost anyone their seat: fall back to the stock three.
                    Console.Error.WriteLine($"[couch-coop] max-seats probe failed ({ex.GetType().Name}: {ex.Message}) — assuming {DefaultSeats}.");
                }
            }

            var ceiling = SlotCeiling - MinSlot + 1;
            var effective = seats ?? (probed ? ceiling : DefaultSeats);
            return MinSlot - 1 + Math.Clamp(effective, 1, ceiling);
        }
    }

    /// <summary>
    /// Inverse of <see cref="SlotToNetId"/>, with a range check: true only when <paramref name="netId"/> names a
    /// slot this manager can actually run (<see cref="MinSlot"/>..<see cref="MaxSlot"/>). Used by the netId-BOUND
    /// spawn path, where the target seat comes from the game's run/save rather than from our own allocator, so it
    /// has to be validated before it is trusted as a slot index.
    /// </summary>
    public bool TryNetIdToSlot(ulong netId, out int slot) => TryNetIdToSlot(netId, MaxSlot, out slot);

    // The lock-safe form: takes the caller's pre-lock snapshot of MaxSlot instead of evaluating the probe itself,
    // so paths that already hold _lock (EnsureHeadlessAsync) can range-check without touching MaxSlot — see its doc.
    private static bool TryNetIdToSlot(ulong netId, int maxSlot, out int slot)
    {
        slot = 0;
        if (netId < BaseNetId + MinSlot || netId > BaseNetId + (ulong)maxSlot)
        {
            return false;
        }

        slot = (int)(netId - BaseNetId);
        return true;
    }
    // Inverse of SlotToPort∘SlotToNetId: recover a headless client's ENet netId from its browser-server port,
    // so the join handler can name the real ENet player (SetClientName) using only the port EnsureHeadlessAsync
    // returned. (port − 13337) / 10 = slot; netId = 1000 + slot.
    public static ulong NetIdForPort(int port) => SlotToNetId((port - HostPort) / PortStep);

    // The game's NullPlatformUtilStrategy reads "./mp_names.json" (netId→display name) ONCE at construction and
    // otherwise renders a remote player's nameplate as its raw netId ("1002"). We write the active co-op roster to
    // this file before spawning each headless so the freshly-launched instance (and thus its browser mirror) shows
    // every player's chosen name. Read relative to the process working directory, which the spawned headless
    // inherits from the host. See memory: headless naming via mp_names.json.
    //
    // DURABLE BY DESIGN — do NOT "clean up" / blank this file at startup. It is the ONLY persistent netId→name
    // store: the game's save carries a run's NetIds but no player names at all, so labelling the seats of a
    // RELOADED saved multiplayer run (letting a returning player recognise and reclaim "Bob" instead of
    // "Player 1003") depends on this file surviving the host quitting. Its entries going stale is not a hazard to
    // erase but the intended fallback: a live joiner's name comes from the SetClientName override registered at
    // slot-bind time (see EnsureHeadlessAsync), which takes precedence, and the file is only consulted where no
    // override exists — exactly the saved-seat case we want it for. WriteMultiplayerNamesFileLocked keeps it
    // accurate by republishing the roster before every spawn.
    // Internal so the seat-side HeadlessClientNameSync can stat the same path it reads.
    internal const string MultiplayerNamesFile = "mp_names.json";

    // Internal so the test project (which references this assembly) can inject a fake launcher + probe.
    internal HeadlessClientManager(
        Func<int, IHeadlessProcess?> launcher,
        Func<int, CancellationToken, Task<bool>>? readinessProbe = null,
        Action<ulong>? evictStalePeer = null,
        Func<int?>? maxSeatsProbe = null,
        Func<int, CancellationToken, Task<string?>>? seatPortProbe = null)
    {
        _launcher = launcher ?? throw new ArgumentNullException(nameof(launcher));
        _readinessProbe = readinessProbe is null
            ? DefaultHttpReadinessAsync
            : async (port, token) =>
            {
                var responding = await readinessProbe(port, token).ConfigureAwait(false);
                // NotProbed, deliberately: an injected bool carries no reachability, and inventing one here
                // would let a unit harness produce a host-local-block verdict it never measured.
                return new SeatListenerProbeResult(
                    responding,
                    responding ? null : "the injected readiness probe reported no failure detail",
                    SeatPortReachability.NotProbed);
            };
        _evictStalePeer = evictStalePeer;
        _maxSeatsProbe = maxSeatsProbe;
        // A unit harness that says nothing about ports gets "every port is free", which is the behaviour every
        // pre-existing seat test was written against.
        _seatPortProbe = seatPortProbe ?? ((_, _) => Task.FromResult<string?>(null));
    }

    private HeadlessClientManager(
        string gameExe,
        string? headlessWrapper,
        Action<ulong>? evictStalePeer,
        Func<int?>? maxSeatsProbe)
    {
        _gameExe = gameExe;
        _headlessWrapper = string.IsNullOrWhiteSpace(headlessWrapper) ? null : headlessWrapper.Trim();
        _launcher = LaunchReal;
        _readinessProbe = DefaultHttpReadinessAsync;
        _evictStalePeer = evictStalePeer;
        _maxSeatsProbe = maxSeatsProbe;
        _seatPortProbe = SeatPortAvailability.DescribeOwnerAsync;
    }

    /// <summary>
    /// Creates a manager if the game executable path can be resolved.
    /// Returns null if the current process exe cannot be determined (tests, unusual launchers).
    /// <paramref name="evictStalePeer"/> force-disconnects a stale ENet peer by netId before a reconnect respawn
    /// reuses it (see <see cref="_evictStalePeer"/>); pass null to disable (no host net server).
    /// <paramref name="maxSeatsProbe"/> reports how many couch seats the live lobby has room for, or null when
    /// there is no lobby to ask (see <see cref="MaxSlot"/>); pass no probe at all to keep the stock three.
    /// </summary>
    public static HeadlessClientManager? TryCreate(
        Action<ulong>? evictStalePeer = null,
        Func<int?>? maxSeatsProbe = null)
    {
        var exe = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
        if (string.IsNullOrEmpty(exe)) return null;
        var wrapper = Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_WRAPPER");
        return new HeadlessClientManager(exe, wrapper, evictStalePeer, maxSeatsProbe);
    }

    // Trim + case-fold display names so reconnects/dedup are stable regardless of incidental
    // whitespace or capitalization differences from the browser.
    private static string? NormalizeName(string? name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    /// <summary>
    /// Ensures a headless instance exists for <paramref name="sessionId"/> and returns its
    /// browser-server port once it responds to HTTP. Returns null if all slots are occupied
    /// or if the headless process fails to become ready within <see cref="DefaultSeatReadyTimeoutSeconds"/>
    /// (overridable — see <see cref="SeatReadyTimeoutEnvironmentVariable"/>).
    /// <para>
    /// A player's <paramref name="displayName"/> CLAIMS a slot (→ a fixed netId) for the host's lifetime. A
    /// same-name return reuses that slot: if its headless is still live it's shared as-is; if it died (browser
    /// closed) a fresh headless is re-spawned on the SAME slot/netId. This is what enables a mid-run RECONNECT:
    /// the host holds the player's seat in the running RunState keyed by their lobby netId, and only accepts a
    /// reconnecting peer whose netId matches it (a fresh netId is rejected as "run in progress"). Pinning the
    /// name→netId binding across disconnects makes a returning player present that original identity.
    /// </para>
    /// <para>
    /// When <paramref name="allowNewSlot"/> is false (a run is active), only REUSE of an existing name claim is
    /// permitted — a brand-new name returns null instead of launching, so no NEW mirror client is instanced
    /// mid-run. Reconnect/reuse of an already-claimed slot is unaffected.
    /// </para>
    /// <para>
    /// <paramref name="onSlotBound"/> reports <c>(netId, name)</c> the moment this player's slot is bound —
    /// BEFORE the headless process is launched, and therefore ~20-60s before this method returns (readiness).
    /// It exists so the caller can register the display-name override for that netId early enough to beat the
    /// HOST's nameplate: the host writes <c>NRemoteLobbyPlayer</c>'s label ONCE in <c>_Ready()</c> from
    /// <c>PlatformUtil.GetPlayerNameRaw</c>, whose fallback is the durable <c>mp_names.json</c> roster as the host
    /// process parsed it at ITS start — i.e. whoever last held this netId, possibly in an earlier session.
    /// Registering only after readiness (the old behavior) always lost that race, so a NEW joiner's widget kept
    /// the fallback name. The cure is this early override, not erasing the roster (it is deliberately durable —
    /// see <see cref="MultiplayerNamesFile"/>): an override always wins where one exists.
    /// See <see cref="ReportSlotBound"/> for the callback's re-entrancy contract.
    /// </para>
    /// <para>
    /// <paramref name="targetNetId"/> switches slot selection from "by name" to "by SEAT": the slot is
    /// <c>netId - 1000</c> (<see cref="TryNetIdToSlot"/>) instead of whatever <see cref="AllocateSlotForNewNameLocked"/>
    /// happens to pick. This is what makes a REJOIN work at all. The game gates rejoining on netId — the load-run
    /// lobby disconnects any client whose netId is not in the loaded save (<c>NetError.NotInSaveGame</c>) and a
    /// running <c>RunLobby</c> rejects any peer not already in the run (<c>NetError.RunInProgress</c>) — so a
    /// headless spawned on a name-chosen slot almost never carries the seat's netId and is bounced on arrival, no
    /// matter how the picker labelled it. Passing the seat's netId here is the whole cure. Everything else on this
    /// method is unchanged and applies equally: the slot is still name-CLAIMED (so a later same-name return reuses
    /// it), a live instance on that slot is still shared rather than respawned, a detach is still cleared, and
    /// <paramref name="onSlotBound"/> still fires before the launch.
    /// </para>
    /// </summary>
    /// <param name="maxSlot">
    /// The caller's PRE-LOCK snapshot of <see cref="MaxSlot"/>. Taken by the caller, not here, because the same
    /// value is needed to decide which seat ports to survey — and both must be settled before <c>_lock</c>.
    /// </param>
    /// <param name="occupiedSeatPorts">
    /// Seat slots whose browser port already has a foreign owner (see <see cref="SurveySeatPortsAsync"/>). A
    /// brand-new player is routed around them; a PINNED seat — a netId-bound rejoin, or a returning name whose
    /// claim is its identity in the host's run — cannot move, so an owner on its port fails the join immediately
    /// with <see cref="SeatReadinessVerdict.PortTakenCode"/> rather than spawning a seat the browser could never
    /// reach.
    /// </param>
    private HeadlessAllocation? AllocateHeadless(
        Guid sessionId,
        string? displayName,
        CancellationToken ct,
        int maxSlot,
        IReadOnlyDictionary<int, string> occupiedSeatPorts,
        bool allowNewSlot = true,
        Action<ulong, string?>? onSlotBound = null,
        ulong? targetNetId = null)
    {
        var name = NormalizeName(displayName);
        int slot;
        // Set when we respawn on a claimed-but-dead slot (a reconnect): after releasing the lock we force-evict
        // any stale ENet peer still holding this netId so the respawned headless's same-netId handshake isn't
        // rejected (IdCollision). Done off the lock — the eviction marshals to the game thread.
        var evictNetIdAfterSpawn = (ulong?)null;
        lock (_lock)
        {
            if (_disposed) return null;
            ReapDeadSlotsLocked();

            // Already assigned to this session (e.g. caller re-entered). A netId-BOUND request short-circuits only
            // when the session is already on THAT seat — otherwise the viewer picked a different seat on the same
            // connection and must actually be re-bound, not silently handed their previous instance.
            if (_sessionToSlot.TryGetValue(sessionId, out slot)
                && (targetNetId is null || SlotToNetId(slot) == targetNetId.Value))
                return new(SlotToPort(slot), NewProcess: false);

            // Drop dead PROCESS handles for orphaned/crashed headless (Release never ran). KEEPS each slot's
            // name claim so a same-name reconnect re-spawns on the same slot/netId (see ReapDeadSlotsLocked).
            ReapDeadSlotsLocked();

            // A netId-BOUND request names its slot outright; a plain request resolves one from the display name.
            int? boundSlot = null;
            if (targetNetId is ulong wantedNetId)
            {
                if (!TryNetIdToSlot(wantedNetId, maxSlot, out var seatSlot))
                {
                    // The caller handed us a netId that is not one of our seats (the host itself, a genuine remote
                    // player, a garbled id). Refusing here — rather than clamping into range — keeps us from ever
                    // spawning an instance that impersonates somebody else's peer.
                    Console.Error.WriteLine($"[couch-coop] headless netId-bound join rejected: netId={wantedNetId} is not a couch-coop seat");
                    return null;
                }

                boundSlot = seatSlot;
            }

            // Same display name → reuse that player's claimed slot (→ same netId). Take over this session.
            var reusingClaim = false;
            if (boundSlot is int seatBoundSlot)
            {
                // ---- netId-BOUND path ------------------------------------------------------------------------
                // The seat, not the name, decides the slot. Everything below mirrors the name-reuse branch (session
                // takeover, detach clear, live-instance sharing, respawn + stale-peer eviction) — only the SELECTION
                // differs. The name claim is then (re)pointed at this slot so a later plain same-name return lands
                // back on the same seat.
                slot = seatBoundSlot;
                foreach (var sk in _sessionToSlot.Where(p => p.Value == slot && p.Key != sessionId).Select(p => p.Key).ToList())
                    _sessionToSlot.Remove(sk);
                _sessionToSlot[sessionId] = slot;
                _detachedSlots.Remove(slot);

                // Whether this counts as consuming a NEW slot: an already-claimed seat is a reconnect (always
                // allowed, exactly as the name-reuse branch is), an unclaimed one is a fresh instance and obeys
                // allowNewSlot. The caller widens that window for a seat that already exists in the live run or the
                // loaded save (CouchCoopLobbyParticipation.DescribeMirrorJoinContext) — that is a RESPAWN of an
                // existing peer, which the game accepts, not a new peer joining mid-run.
                var seatAlreadyClaimed = _nameToSlot.ContainsValue(slot);
                if (!seatAlreadyClaimed && !allowNewSlot)
                {
                    _sessionToSlot.Remove(sessionId);
                    return null;
                }

                reusingClaim = seatAlreadyClaimed;
                if (name is not null)
                {
                    // Re-point the claim: drop any OTHER slot this name held, and any OTHER name holding this slot,
                    // so the name↔slot map stays a bijection (RemoveNameForSlotLocked / the dictionary do one each).
                    _nameToSlot.Remove(name);
                    RemoveNameForSlotLocked(slot);
                    _nameToSlot[name] = slot;
                }

                if (_processBySlot.ContainsKey(slot))
                {
                    Console.Error.WriteLine($"[couch-coop] headless reuse (netId-bound) slot={slot} netId={SlotToNetId(slot)} name={name} newSession={sessionId:N}");
                    ReportSlotBound(onSlotBound, slot, name);
                    return new(SlotToPort(slot), NewProcess: false);
                }

                evictNetIdAfterSpawn = SlotToNetId(slot);
                Console.Error.WriteLine($"[couch-coop] headless netId-bound spawn slot={slot} netId={SlotToNetId(slot)} name={name} session={sessionId:N}");
            }
            else if (name is not null && _nameToSlot.TryGetValue(name, out var claimedSlot))
            {
                slot = claimedSlot;
                // Detach any OTHER session bound to this slot so its WS-close doesn't kill our (re)used process.
                foreach (var sk in _sessionToSlot.Where(p => p.Value == slot && p.Key != sessionId).Select(p => p.Key).ToList())
                    _sessionToSlot.Remove(sk);
                _sessionToSlot[sessionId] = slot;
                // The browser is back: this slot is no longer "browser-gone, kept alive mid-run".
                _detachedSlots.Remove(slot);

                if (_processBySlot.ContainsKey(slot))
                {
                    // Headless still live → share it (e.g. a second browser tab with the same name).
                    Console.Error.WriteLine($"[couch-coop] headless reuse slot={slot} name={name} newSession={sessionId:N}");
                    // Still a BINDING (this session now owns the slot), so report it: the live instance's netId
                    // may have lost its name override in the meantime (e.g. a lobby disconnect cleared it), and
                    // re-asserting costs one idempotent action.
                    ReportSlotBound(onSlotBound, slot, name);
                    return new(SlotToPort(slot), NewProcess: false);
                }

                // Claimed but the headless died → re-spawn on the SAME slot (same netId) below so the host's
                // run-in-progress rejoin accepts this returning player. Evict any stale peer on this netId after
                // the lock (see evictNetIdAfterSpawn) in case the dead headless's Release never ran (ungraceful
                // drop / no clean WS close).
                reusingClaim = true;
                evictNetIdAfterSpawn = SlotToNetId(slot);
                Console.Error.WriteLine($"[couch-coop] headless reconnect slot={slot} netId={SlotToNetId(slot)} name={name} session={sessionId:N}");
            }
            else
            {
                // No existing claim for this name → serving it would LAUNCH a new headless. Forbidden mid-run
                // (allowNewSlot:false): the host's run no longer accepts a newly joining peer. The reuse branch
                // above (an existing claim) is unaffected, so a mid-run RECONNECT still works.
                if (!allowNewSlot) return null;
                // New (or anonymous) player → a fully-free slot, else reclaim a claimed-but-dead one. A brand-new
                // player has no netId to keep, so a slot whose port is already owned by something else is simply
                // skipped: they join on the next one instead of failing at all.
                slot = AllocateSlotForNewNameLocked(maxSlot, occupiedSeatPorts);
                if (slot == 0)
                {
                    // Every slot has a LIVE process. The one refusal a host can actually do something
                    // about: close a window, or raise the lobby cap.
                    return null;
                }
                _sessionToSlot[sessionId] = slot;
                if (name is not null) _nameToSlot[name] = slot;
            }

            // The slot is settled and we are about to SPAWN on it (every reuse branch above has already returned).
            // If its browser port has a foreign owner, this join cannot work: the host hands the browser
            // SlotToPort(slot) and probes that same port, and the seat is no longer allowed to walk away from it.
            // Failing here costs about a second; the alternative is the 75-second deadline and a message that
            // blames the seat's listener. The brand-new-name branch above has already preferred a free port, so
            // reaching this line means the slot could not move — a netId-bound rejoin, a returning name whose
            // claim IS its identity in the host's run, or a lobby in which every seat port is taken.
            if (occupiedSeatPorts.TryGetValue(slot, out var portOwner))
            {
                var verdict = SeatReadinessVerdict.Describe(new SeatReadinessFacts(
                    ExpectedPort: SlotToPort(slot),
                    ReportedPort: 0,
                    PortOwner: portOwner,
                    HostMember: false,
                    NativePhase: null,
                    HeartbeatFresh: false,
                    ListenerResponding: null,
                    ProbeFailure: null,
                    TcpReachability: SeatPortReachability.NotProbed,
                    ConnectedBrowserCount: 0,
                    ElapsedMs: 0,
                    DeadlineMs: (long)SeatReadyTimeout.TotalMilliseconds));
                var issue = verdict.Issue;
                Console.Error.WriteLine(
                    $"[couch-coop] headless spawn refused slot={slot} port={SlotToPort(slot)}: {portOwner}");
                ConnectionRegistry.Shared.Fail(sessionId, issue.Code, issue.Summary, issue.Action, issue.Detail);
                // Unwind exactly as the launch-refused path does: drop this session, and only forget the claim if
                // WE just created it — a reconnect's pre-existing claim stays so the player can retry on the same
                // netId once the port is freed.
                _sessionToSlot.Remove(sessionId);
                if (!reusingClaim) RemoveNameForSlotLocked(slot);
                return null;
            }

            // The slot (→ netId) is now bound to this player, on BOTH paths above (a reconnect respawn on an
            // existing claim, and a brand-new claim). Report it BEFORE the spawn below so the caller's display-name
            // override is in place while the headless is still loading — the host only builds that player's
            // NRemoteLobbyPlayer nameplate when the instance completes its ENet handshake, ~10-15s from here.
            ReportSlotBound(onSlotBound, slot, name);

            // Publish the active roster (this joiner, every other named slot, and the host's published view of
            // everyone else — see PublishRosterNames) so the headless we're about to launch resolves real display
            // names instead of raw netIds. Written before the process starts so its NullPlatformUtilStrategy reads
            // the fresh file at construction.
            WriteMultiplayerNamesFileLocked(slot, name);

            // The launch is wrapped HERE rather than inside LaunchReal, deliberately: LaunchReal is only
            // reachable with a real game executable, so failure handling written inside it would be
            // unreachable from the unit suite. Wrapping `_launcher(slot)` means the FakeProcess harness
            // exercises both failure shapes — a null return and a throw — which is where the interesting
            // behaviour is.
            IHeadlessProcess? proc;
            try
            {
                PrepareConnectionLocked(slot, sessionId);
                proc = _launcher(slot);
            }
            catch (Exception launchError)
            {
                CouchCoop.Mod.Connections.ConnectionRegistry.Shared.Fail(sessionId, "launch-exception",
                    "The game process could not be launched.", "Check the game installation and retry. Copy this report if it fails again.", launchError.ToString());
                ForgetConnectionLocked(slot);
                // A launcher that THROWS must unwind exactly like one that returns null. Without this the binding
                // made above survives the failure, and the viewer's very next attempt short-circuits at the top of
                // this method to `return SlotToPort(slot)` — handing the browser a port that nothing is listening
                // on, which is a WORSE outcome than the failure it is retrying. Found by the retry leg of
                // BrowserServerRouteTests.AssertJoinFaultReachesTheViewerAsync; the shipped
                // KeyNotFoundException (see ApplyMemoryTuning) was exactly such a throw.
                _sessionToSlot.Remove(sessionId);
                if (!reusingClaim) RemoveNameForSlotLocked(slot);
                throw; // the join handler converts this into a visible `joinRejection: "join-failed"`
            }

            if (proc is null)
            {
                CouchCoop.Mod.Connections.ConnectionRegistry.Shared.Fail(sessionId, "launch-refused",
                    "The game process did not start.", "Make sure the host lobby is accepting couch players, then retry.",
                    "The process launcher returned no process handle. No further cause is available.");
                ForgetConnectionLocked(slot);
                // Spawn failed: drop this session. Only forget the claim if WE just created it (a new name) —
                // a reconnect's pre-existing claim is left intact so the player can retry on the same netId.
                _sessionToSlot.Remove(sessionId);
                if (!reusingClaim) RemoveNameForSlotLocked(slot);
                return null;
            }
            _processBySlot[slot] = proc;
            if (_ownedConnections.TryGetValue(slot, out var owned))
            {
                owned.Process = proc;
                CouchCoop.Mod.Connections.ConnectionRegistry.Shared.BindProcess(sessionId, proc.Id, owned.Generation);
            }
        }

        // Reconnect respawn: clear any stale ENet peer on this netId now (off the lock), well before the freshly
        // spawned headless finishes loading assets and attempts its handshake (~10-15s) — so the host accepts the
        // same-netId rejoin instead of rejecting it as an IdCollision. No-op if the peer was already evicted.
        if (evictNetIdAfterSpawn is ulong staleNetId)
        {
            try { _evictStalePeer?.Invoke(staleNetId); }
            catch (Exception ex) { Console.Error.WriteLine($"[couch-coop] evict stale peer netId={staleNetId} failed: {ex.GetType().Name}: {ex.Message}"); }
        }

        return new(SlotToPort(slot), NewProcess: true);
    }

    /// <summary>
    /// Hand the caller the netId this player just bound, plus the name they bound it with, so a display-name
    /// override can be registered before the headless exists (see <see cref="EnsureHeadlessAsync"/>).
    /// <para>
    /// RE-ENTRANCY CONTRACT — read before wiring a callback: this runs INSIDE <c>_lock</c>, deliberately, because
    /// the whole point is to fire before <c>_launcher(slot)</c>. A callback therefore MUST NOT (a) re-enter this
    /// manager (self-deadlock) or (b) block waiting on another thread that can take <c>_lock</c> — notably the
    /// Godot main thread, which enters <see cref="Dispose"/> at game shutdown. The in-repo caller
    /// (CouchCoopWebSocketConnection) satisfies (b) by handing its <c>SetClientName</c> action to the thread pool
    /// instead of blocking on the main-thread marshal. Exceptions are swallowed: a naming callback must never
    /// abort a join.
    /// </para>
    /// </summary>
    private static void ReportSlotBound(Action<ulong, string?>? onSlotBound, int slot, string? name)
    {
        if (onSlotBound is null) return;
        try
        {
            onSlotBound(SlotToNetId(slot), name);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[couch-coop] slot-bound callback netId={SlotToNetId(slot)} failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// True when some display name still CLAIMS the slot that owns <paramref name="netId"/> — i.e. that seat is
    /// reserved for a returning player rather than genuinely gone. <see cref="Release"/> intentionally keeps the
    /// claim after killing the process (reconnect identity), and <see cref="MarkDetached"/> keeps both; only
    /// <see cref="ReapDetachedSlots"/> / a slot steal drop it. Lets the disconnect path decide whether clearing
    /// that netId's display-name override is safe (see the caller's comment: clearing early falls the nameplate
    /// back to the durable <c>mp_names.json</c> roster, which may still name an earlier holder of this netId).
    /// </summary>
    public bool HasClaimForNetId(ulong netId)
    {
        lock (_lock)
        {
            foreach (var claimedSlot in _nameToSlot.Values)
            {
                if (SlotToNetId(claimedSlot) == netId) return true;
            }
            return false;
        }
    }

    /// <summary>
    /// Describe every couch-coop seat this manager owns, so the session envelope can tell the clients WHICH seats
    /// exist and whether each one's instance is up. Purely a read of the bookkeeping that already exists
    /// (<c>_processBySlot</c> + <see cref="IHeadlessProcess.HasExited"/>, <c>_nameToSlot</c>, <c>_detachedSlots</c>)
    /// — no new state is tracked for it — taken under <c>_lock</c> so a caller never observes a half-applied
    /// slot transition. Returned in slot order, one entry per slot in <see cref="MinSlot"/>..<see cref="MaxSlot"/>,
    /// INCLUDING slots that have never been used (they describe as "no claim, no process"), because a seat that has
    /// nothing running is still a joinable seat — tapping it spawns a headless bound to its netId.
    /// </summary>
    public IReadOnlyList<MirrorSeatDescription> DescribeSeats()
    {
        // Snapshot BEFORE taking _lock — the main thread calls in here on every screen change, so a probe under
        // the lock is the room-load deadlock (see MaxSlot's doc).
        var maxSlot = MaxSlot;
        lock (_lock)
        {
            var seats = new List<MirrorSeatDescription>(maxSlot - MinSlot + 1);
            for (var slot = MinSlot; slot <= maxSlot; slot++)
            {
                string? claimedName = null;
                foreach (var kv in _nameToSlot)
                {
                    if (kv.Value == slot) { claimedName = kv.Key; break; }
                }

                var processLive = false;
                if (_processBySlot.TryGetValue(slot, out var proc))
                {
                    // A handle we still hold for an EXITED process is not a live instance (Release/reap may not have
                    // run yet — an orphaned/crashed headless). Treat a throwing handle as dead, like ReapDeadSlotsLocked.
                    try { processLive = !proc.HasExited; }
                    catch { processLive = false; }
                }

                seats.Add(new MirrorSeatDescription(
                    SlotToNetId(slot),
                    claimedName,
                    processLive,
                    _detachedSlots.Contains(slot)));
            }

            return seats;
        }
    }

    /// <summary>
    /// Kill the headless instance owning <paramref name="netId"/> and drop that slot's name claim, returning true
    /// when a live process was actually killed. This is the ZOMBIE REAP: an instance that is up but has no live ENet
    /// connection to the host's game can neither play nor be rejoined, and it squats on the slot so that even a
    /// correctly netId-bound respawn would be short-circuited into sharing the zombie (see the reuse branch of
    /// <see cref="EnsureHeadlessAsync"/>). Clearing it is what makes the next spawn on this seat clean.
    /// <para>
    /// Unlike <see cref="Release"/> — which deliberately KEEPS the name claim so a departing player's netId stays
    /// reserved for their reconnect — this drops the claim, because the point is to leave nothing of the broken
    /// instance behind. Sessions still pointing at the slot are dropped so their later <see cref="Release"/> is a
    /// no-op. No-op (false) for a netId outside <see cref="TryNetIdToSlot"/>'s range or a slot with no process.
    /// </para>
    /// </summary>
    public bool ReapSeat(ulong netId)
    {
        if (!TryNetIdToSlot(netId, out var slot))
        {
            return false;
        }

        lock (_lock)
        {
            if (_disposed || !_processBySlot.ContainsKey(slot))
            {
                return false;
            }

            Console.Error.WriteLine($"[couch-coop] reaping stuck headless (up but not connected) slot={slot} netId={netId}");
            // A reap DROPS the claim, unlike Release.
            foreach (var sk in _sessionToSlot.Where(p => p.Value == slot).Select(p => p.Key).ToList())
                _sessionToSlot.Remove(sk);
            _detachedSlots.Remove(slot);
            RemoveNameForSlotLocked(slot);
            // The game IGNORES SIGTERM (see Release), so a graceful stop would only cost the caller three seconds
            // under the lock before the same SIGKILL. A zombie has no ENet leave to flush anyway.
            return ShutdownSlotLocked(slot, graceful: false);
        }
    }

    /// <summary>
    /// Pick a slot for a brand-new (or anonymous) player. Prefers a slot with no live process AND no name claim;
    /// failing that, reclaims a claimed-but-dead slot (evicting that stale claim — the evicted name loses its
    /// reconnect identity). Returns 0 when every slot has a LIVE process. Caller holds <c>_lock</c>.
    /// </summary>
    /// <summary>
    /// True when <paramref name="displayName"/> already CLAIMS a slot (live or reconnect-eligible dead). Lets the
    /// join handler tell a reuse-eligible name (existing session player, e.g. mid-run reconnect) from an unknown
    /// name that would need a brand-new instance — so the latter can be rejected with "not a session player"
    /// instead of silently spawning. Case-insensitive / trimmed, matching the dedup key.
    /// </summary>
    public bool HasNameClaim(string? displayName)
    {
        var name = NormalizeName(displayName);
        if (name is null) return false;
        lock (_lock)
        {
            return _nameToSlot.ContainsKey(name);
        }
    }

    /// <param name="occupiedPortSlots">
    /// Slots whose browser port already has a foreign owner. Preferred AGAINST, not forbidden: a new player who
    /// can take another seat should just take it, but when every candidate's port is occupied the honest outcome
    /// is the named <see cref="SeatReadinessVerdict.PortTakenCode"/> failure the caller raises — not "no seat
    /// available", which would send the host looking for a window to close.
    /// </param>
    private int AllocateSlotForNewNameLocked(int maxSlot, IReadOnlyDictionary<int, string>? occupiedPortSlots = null)
    {
        if (occupiedPortSlots is { Count: > 0 })
        {
            var free = PickSlotForNewNameLocked(maxSlot, slot => !occupiedPortSlots.ContainsKey(slot));
            if (free != 0) return free;
        }

        return PickSlotForNewNameLocked(maxSlot, _ => true);
    }

    private int PickSlotForNewNameLocked(int maxSlot, Func<int, bool> acceptable)
    {
        var claimed = _nameToSlot.Values.ToHashSet();
        for (var s = MinSlot; s <= maxSlot; s++)
            if (!_processBySlot.ContainsKey(s) && !claimed.Contains(s) && acceptable(s)) return s;
        for (var s = MinSlot; s <= maxSlot; s++)
            if (!_processBySlot.ContainsKey(s) && acceptable(s)) { RemoveNameForSlotLocked(s); return s; }
        return 0;
    }

    /// <summary>
    /// Kills the headless process for <paramref name="sessionId"/> and frees its slot. Returns the freed
    /// netId (<see cref="SlotToNetId"/>) when it actually kills/frees the slot's process, so the caller can
    /// evict that now-dead peer from the host's ENet server (the host keeps the peer registered after a
    /// SIGKILL, so the next headless reusing the netId would fail its ENet join). Returns null when this is
    /// a no-op: the session has no headless instance, or another session has since taken over the slot
    /// (same-name reconnect / reuse-transfer — that live instance must NOT be evicted).
    /// </summary>
    public ulong? Release(Guid sessionId)
    {
        lock (_lock)
        {
            _browserAttempts.Remove(sessionId);
            if (!_sessionToSlot.TryGetValue(sessionId, out var slot)) return null;
            _sessionToSlot.Remove(sessionId);
            // Only kill the process if no other session has taken over this slot.
            if (_sessionToSlot.ContainsValue(slot))
            {
                ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "cleanup", "Healthy game retained for another browser using the same seat.");
                return null;
            }
            // KEEP the name→slot claim so the player can reconnect to the SAME netId and land the game's native
            // mid-run rejoin (the host holds their RunState seat keyed by that netId). The claim is reclaimed for
            // a different player only if every slot fills up. We still SIGKILL the process (the game IGNORES
            // SIGTERM) and return the netId so the caller evicts the now-dead ENet peer, freeing the netId for
            // the reconnecting headless to reuse.
            var stopped = ShutdownSlotLocked(slot, graceful: false);
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "cleanup", stopped
                ? "Owned game terminated after its last lobby browser disconnected."
                : "Owned game could not be terminated; its seat remains reserved.");
            return stopped ? SlotToNetId(slot) : null;
        }
    }

    /// <summary>
    /// Mark the slot owning <paramref name="sessionId"/> as DETACHED — its browser disconnected DURING A RUN, but
    /// the headless is intentionally KEPT ALIVE (still ENet-joined to the host's run as its netId) so the browser
    /// reconnects instantly to the live run. The session is dropped (so a later Release for it is a no-op) but the
    /// process and name→slot claim are preserved. No-op if another session still owns the slot (e.g. a second tab)
    /// or the slot has no live process. Called instead of <see cref="Release"/> on a mid-run disconnect.
    /// </summary>
    public void MarkDetached(Guid sessionId)
    {
        lock (_lock)
        {
            _browserAttempts.Remove(sessionId);
            if (!_sessionToSlot.TryGetValue(sessionId, out var slot)) return;
            _sessionToSlot.Remove(sessionId);
            ConnectionRegistry.Shared.RecordDiagnostic(sessionId, "cleanup", "Healthy game retained during the run so this browser can reconnect.");
            // Another live session still owns this slot → it's not detached; leave it owned.
            if (_sessionToSlot.ContainsValue(slot)) return;
            // Keep the process + name claim alive; remember to reap it when the run ends.
            if (_processBySlot.ContainsKey(slot))
            {
                _detachedSlots.Add(slot);
                Console.Error.WriteLine($"[couch-coop] headless detached (kept alive mid-run) slot={slot} netId={SlotToNetId(slot)}");
            }
        }
    }

    /// <summary>
    /// Reap every DETACHED slot — kill its kept-alive headless and drop its name claim — and return the freed
    /// netIds so the caller can evict the (already game-disconnected) ENet peers. Called when the host quits the
    /// run (the host state observer sees the run end), so kept-alive headless from departed browsers don't linger
    /// as phantom players into the next lobby. Detached slots whose browser already reconnected were removed from
    /// the set by <see cref="EnsureHeadlessAsync"/>, so they're untouched.
    /// </summary>
    public IReadOnlyList<ulong> ReapDetachedSlots()
    {
        lock (_lock)
        {
            if (_detachedSlots.Count == 0) return [];
            var freed = new List<ulong>();
            foreach (var slot in _detachedSlots.ToList())
            {
                Console.Error.WriteLine($"[couch-coop] reaping detached headless on run-end slot={slot} netId={SlotToNetId(slot)}");
                RemoveNameForSlotLocked(slot);
                if (ShutdownSlotLocked(slot, graceful: false))
                {
                    freed.Add(SlotToNetId(slot));
                }
            }
            _detachedSlots.Clear();
            return freed;
        }
    }

    public void Dispose()
    {
        CouchCoop.Mod.Connections.HeadlessConnectionControl.Shared.StatusChanged -= OnChildStatus;
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;

            _nameToSlot.Clear();
            _sessionToSlot.Clear();
            _detachedSlots.Clear();
            // Host is going away: hard-kill is fine (and faster than waiting on each graceful stop).
            foreach (var slot in _processBySlot.Keys.ToList())
                ShutdownSlotLocked(slot, graceful: false);
        }
    }

    /// <summary>
    /// Drop the dead PROCESS handle for any slot whose headless has exited (orphaned/crashed, or its WS torn
    /// down without reaching <see cref="Release"/>). KEEPS the slot's name→slot claim so a same-name reconnect
    /// re-spawns on the same slot/netId (the reconnect-identity contract). Caller holds _lock.
    /// </summary>
    private void ReapDeadSlotsLocked()
    {
        List<int>? dead = null;
        foreach (var kv in _processBySlot)
        {
            bool exited;
            try { exited = kv.Value.HasExited; }
            catch { exited = true; } // process handle gone → treat as dead
            if (exited) (dead ??= []).Add(kv.Key);
        }
        if (dead is null) return;
        foreach (var slot in dead)
        {
            Console.Error.WriteLine($"[couch-coop] headless reaping dead slot={slot}");
            // Drop any sessions still pointing at this dead slot so their later Release is a no-op. The name
            // claim is intentionally retained so the player keeps the same netId on reconnect.
            foreach (var sk in _sessionToSlot.Where(p => p.Value == slot).Select(p => p.Key).ToList())
                _sessionToSlot.Remove(sk);
            ShutdownSlotLocked(slot, graceful: false); // already exited; just dispose the handle
        }
    }

    /// <summary>
    /// Hand this manager the host's view of who is in the session (netId → resolved display name), so the roster
    /// it publishes to the seats names EVERYONE the host can name — not just the couch slots it allocated.
    /// <para>
    /// A seat resolves names through <c>NullPlatformUtilStrategy</c>, which knows only
    /// <see cref="MultiplayerNamesFile"/>. So the host itself (netId = its SteamID64 on a Steam-hosted session)
    /// and any genuine remote Steam friend are un-nameable on a seat unless they are in that file — which is why
    /// a seat used to render the host as a 17-digit number. See
    /// <see cref="CouchCoopLobbyParticipation.RosterNames()"/> for where the names come from.
    /// </para>
    /// <para>
    /// Rewrites the file only when the roster actually changes something, so this is cheap enough to call on every
    /// browser join message and on every host-side roster change.
    /// </para>
    /// </summary>
    public void PublishRosterNames(IReadOnlyList<(ulong NetId, string Name)> roster)
    {
        if (roster.Count == 0)
        {
            return;
        }

        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            var changed = false;
            foreach (var (netId, rawName) in roster)
            {
                var name = NormalizeName(rawName);
                if (name is null)
                {
                    continue;
                }

                if (!_publishedNames.TryGetValue(netId, out var known) || !string.Equals(known, name, StringComparison.Ordinal))
                {
                    _publishedNames[netId] = name;
                    changed = true;
                }
            }

            if (changed)
            {
                WriteMultiplayerNamesFileLocked(newSlot: 0, newName: null);
            }
        }
    }

    /// <summary>
    /// Write the active co-op name roster to <see cref="MultiplayerNamesFile"/> in the working directory, in the
    /// game's <c>mp_names.json</c> format (<c>[{"net_id":1002,"name":"tess"}]</c>). Real-launcher only (skipped
    /// under the test launcher, which leaves <c>_gameExe</c> null, so unit tests never touch the filesystem;
    /// <see cref="BuildMultiplayerNameEntries"/> is where the content itself is tested). Caller holds
    /// <c>_lock</c>. Best-effort: a write failure only means a headless falls back to showing raw netIds.
    /// Anonymous joins (no name) are omitted and render as their netId.
    /// <para>
    /// This is also the write side of the mod's DURABLE netId→name roster, and it must stay accurate: the file
    /// outlives the host process and is the only place a player's chosen name is persisted (the game's save has
    /// NetIds but no names), so it is what lets a RELOADED saved multiplayer run label its seats instead of showing
    /// "Player 1003". Republishing the whole roster before every spawn — not just the joiner — is what keeps that
    /// map complete. Never blank the file to "clean up" stale entries; see <see cref="MultiplayerNamesFile"/>.
    /// </para>
    /// </summary>
    private void WriteMultiplayerNamesFileLocked(int newSlot, string? newName)
    {
        if (_gameExe is null)
        {
            return;
        }

        var path = Path.Combine(Directory.GetCurrentDirectory(), MultiplayerNamesFile);
        try
        {
            var entries = BuildMultiplayerNameEntries(
                joiningNetId: newSlot >= MinSlot ? SlotToNetId(newSlot) : null,
                joiningName: newName,
                claimedSlotNames: _nameToSlot.Select(kv => (SlotToNetId(kv.Value), kv.Key)).ToList(),
                publishedNames: _publishedNames,
                existingEntries: ReadMultiplayerNames());

            // Write + RENAME rather than writing in place: every live seat reads this file (the game once at
            // startup, our name sync on every change), and a truncate-then-write is observable half-done. A seat
            // whose ONE startup read lands mid-write would show raw netIds for its whole life. Rename is atomic on
            // the same filesystem, so a reader sees either the old file or the new one.
            var temp = path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(entries));
            File.Move(temp, path, overwrite: true);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[couch-coop] failed writing {MultiplayerNamesFile}: {ex.GetType().Name}: {ex.Message}");
        }
    }

    /// <summary>
    /// The content of <see cref="MultiplayerNamesFile"/>, in descending order of authority. Pure so the merge order
    /// is testable without a game install.
    /// <list type="number">
    /// <item>the seat being bound right now (<paramref name="joiningNetId"/>), which is not in the claim map yet;</item>
    /// <item>every live name→slot CLAIM — the browser-chosen names this host allocated;</item>
    /// <item>the host's published roster (itself + remote players; see <see cref="PublishRosterNames"/>) — BELOW
    /// the claims, because a claim is the name that player typed for this seat, while the roster is the host's
    /// resolution of the same seat and may lag it by a state tick;</item>
    /// <item>whatever the file already said, so entries this session knows nothing about SURVIVE. The file is the
    /// only persistent netId→name memory (the save stores NetIds only), so a rewrite that dropped them would erase
    /// the labels a reloaded saved run is relabelled from — see <see cref="MultiplayerNamesFile"/> on why staleness
    /// here is the intended fallback rather than a hazard.</item>
    /// </list>
    /// </summary>
    internal static List<MultiplayerNameEntry> BuildMultiplayerNameEntries(
        ulong? joiningNetId,
        string? joiningName,
        IReadOnlyList<(ulong NetId, string Name)> claimedSlotNames,
        IReadOnlyDictionary<ulong, string> publishedNames,
        IReadOnlyDictionary<ulong, string> existingEntries)
    {
        var entries = new List<MultiplayerNameEntry>();
        var seen = new HashSet<ulong>();

        void Add(ulong netId, string? rawName)
        {
            var name = NormalizeName(rawName);
            if (name is null || !seen.Add(netId))
            {
                return;
            }

            entries.Add(new MultiplayerNameEntry { net_id = netId, name = name });
        }

        if (joiningNetId is ulong joining)
        {
            Add(joining, joiningName);
        }

        foreach (var (netId, name) in claimedSlotNames)
        {
            Add(netId, name);
        }

        foreach (var (netId, name) in publishedNames)
        {
            Add(netId, name);
        }

        foreach (var (netId, name) in existingEntries)
        {
            Add(netId, name);
        }

        return entries;
    }

    // Matches the game's NullMultiplayerName record shape (snake_case net_id) so NullPlatformUtilStrategy parses it.
    internal sealed class MultiplayerNameEntry
    {
        [JsonPropertyName("net_id")] public ulong net_id { get; set; }
        [JsonPropertyName("name")] public string name { get; set; } = "";
    }

    private static readonly IReadOnlyDictionary<ulong, string> EmptyNames = new Dictionary<ulong, string>();

    /// <summary>
    /// Read the shared <c>mp_names.json</c> roster (host-written before spawning each headless) into a
    /// netId→display-name map. Empty on a missing/unreadable/malformed file. Static + side-effect-free: a running
    /// headless instance (which has no <see cref="HeadlessClientManager"/> of its own) calls this to re-apply a
    /// LATER joiner's name as a local <c>SetClientName</c> override — the game itself only reads the file once at
    /// startup, so an already-running headless would otherwise render a newcomer as their raw netId.
    /// </summary>
    public static IReadOnlyDictionary<ulong, string> ReadMultiplayerNames()
    {
        try
        {
            var path = Path.Combine(Directory.GetCurrentDirectory(), MultiplayerNamesFile);
            if (!File.Exists(path))
            {
                return EmptyNames;
            }

            var entries = JsonSerializer.Deserialize<List<MultiplayerNameEntry>>(File.ReadAllText(path));
            if (entries is null || entries.Count == 0)
            {
                return EmptyNames;
            }

            var map = new Dictionary<ulong, string>();
            foreach (var entry in entries)
            {
                var name = entry.name?.Trim();
                if (!string.IsNullOrEmpty(name))
                {
                    map[entry.net_id] = name;
                }
            }

            return map;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return EmptyNames;
        }
    }

    /// <summary>
    /// The display name currently CLAIMING <paramref name="slot"/>, or null when it is unclaimed. Caller
    /// holds <c>_lock</c>.
    /// </summary>
    /// <remarks>
    /// Extracted from <see cref="RemoveNameForSlotLocked"/> (which now calls it) because the host
    /// connectivity log needs the same scan without the removal — and because several of its call sites sit
    /// immediately BEFORE a claim-clearing line, where reading the name afterwards silently degrades every
    /// message to "A player".
    /// </remarks>
    private string? ClaimedNameForSlotLocked(int slot)
    {
        foreach (var kv in _nameToSlot)
        {
            if (kv.Value == slot)
            {
                return kv.Key;
            }
        }

        return null;
    }

    /// <summary>Lock-taking form of <see cref="ClaimedNameForSlotLocked"/>, for callers outside the lock.</summary>
    private string? ClaimedNameForSlot(int slot)
    {
        lock (_lock)
        {
            return ClaimedNameForSlotLocked(slot);
        }
    }

    private void RemoveNameForSlotLocked(int slot)
    {
        var name = ClaimedNameForSlotLocked(slot);
        if (name is not null) _nameToSlot.Remove(name);
    }

    /// <summary>
    /// Stop the process for <paramref name="slot"/> and remove its bookkeeping. When
    /// <paramref name="graceful"/> is set, first asks the process to leave ENet cleanly (SIGTERM) so
    /// the host drops its peer (no phantom lobby player) and only escalates to SIGKILL if it doesn't
    /// exit within <see cref="GracefulStopTimeout"/>. Caller holds _lock; the brief blocking wait runs
    /// under the lock, which is acceptable on the rare teardown path. Returns false if no such slot.
    /// </summary>
    private bool ShutdownSlotLocked(int slot, bool graceful)
    {
        if (!_processBySlot.TryGetValue(slot, out var proc)) return false;
        if (_ownedConnections.TryGetValue(slot, out var owned) && owned.Quarantined)
        {
            // A failed termination or peer eviction leaves this slot unsafe to reuse. Keep its process handle and
            // identity until a later cleanup proves both sides have been released.
            return false;
        }
        try
        {
            bool alreadyExited;
            try { alreadyExited = proc.HasExited; }
            catch
            {
                if (owned is not null) QuarantineLocked(owned, "The client process could not be inspected during shutdown.");
                return false;
            }

            if (!alreadyExited && graceful && proc.RequestGracefulStop())
            {
                // Poll for a clean exit (the headless flushing its ENet leave to the host). If it
                // doesn't exit in time, fall through to a hard kill below.
                var deadline = DateTime.UtcNow + GracefulStopTimeout;
                while (DateTime.UtcNow < deadline)
                {
                    try { if (proc.HasExited) { alreadyExited = true; break; } }
                    catch { alreadyExited = true; break; }
                    Thread.Sleep(50);
                }
            }

            if (!alreadyExited)
            {
                try
                {
                    if (!proc.HasExited) proc.Kill();
                    if (!proc.HasExited)
                    {
                        if (owned is not null) QuarantineLocked(owned, "The forced shutdown request did not terminate the client process.");
                        return false;
                    }
                }
                catch (Exception exception)
                {
                    if (owned is not null) QuarantineLocked(owned, $"The forced shutdown request failed: {exception.Message}");
                    return false;
                }
            }
        }
        catch
        {
            if (owned is not null) QuarantineLocked(owned, "The client shutdown did not complete.");
            return false;
        }
        _processBySlot.Remove(slot);
        ForgetConnectionLocked(slot);
        proc.Dispose();
        return true;
    }

    /// <summary>
    /// The game argument every couch seat is launched with. Everything that used to travel on the command line
    /// (<c>-fastmp join</c>, <c>--clientId N</c>) is now environment-driven and re-materialized inside the seat by
    /// <see cref="Patches.CommandLineOverridePatch"/>. A visible <c>-fastmp</c> is exactly what made a normally
    /// hosted session look like the local-multiplayer test path, and argv is unreliable in the embedded host.
    /// </summary>
    internal const string SeatHeadlessArgument = "--headless";

    /// <summary>
    /// Where a seat writes its log when it was launched with NO user-dir isolation, relative to the HOST's user
    /// directory — which, in exactly that case, is also the seat's.
    /// </summary>
    /// <param name="hostLogPath">
    /// <see cref="Connections.ConnectionRegistry.HostLogPath"/>, i.e. <c>&lt;userDir&gt;/logs/godot.log</c>.
    /// The user dir is taken from it rather than resolved again so there is ONE answer to "where does this
    /// process keep its files", and so this stays pure. <see langword="null"/> (a host that never resolved a
    /// log path) yields null and the seat launches exactly as it did before.
    /// </param>
    /// <remarks>
    /// Under <c>couch-coop/</c> because everything this mod creates in the user profile lives there, and beside
    /// rather than inside <c>headless-slots/</c> because that directory holds isolated USER DIRS — this is one
    /// file, and a reader who finds it there must not think isolation happened.
    /// </remarks>
    internal static string? SeatLogPath(string? hostLogPath, int slot)
    {
        if (string.IsNullOrWhiteSpace(hostLogPath)) return null;
        var logsDirectory = Path.GetDirectoryName(hostLogPath);
        var userDirectory = string.IsNullOrEmpty(logsDirectory) ? null : Path.GetDirectoryName(logsDirectory);
        if (string.IsNullOrEmpty(userDirectory)) return null;
        return Path.Combine(
            userDirectory, "couch-coop", "seat-logs", $"slot-{slot.ToString(CultureInfo.InvariantCulture)}.log");
    }

    /// <summary>
    /// The game arguments for one seat: <see cref="SeatHeadlessArgument"/>, plus <c>--log-file</c> when this
    /// seat has to be told where to write.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY THIS IS NOT A CONSTANT ANY MORE. Godot's file logger TRUNCATES its log file on every process start
    /// (<c>RotatedFileLogger::rotate_file</c>, called from its constructor, reopens the path with
    /// <c>FileAccess::WRITE</c>). With an isolated <c>user://</c> per seat that only ever affects the seat's own
    /// file. WITHOUT isolation — macOS, where Godot derives <c>user://</c> from <c>$HOME</c> alone — every seat
    /// spawn reopens and truncates the HOST's live <c>user://logs/godot.log</c>, which is why the macOS bug
    /// report that started this work arrived with no log to attach: by the time the player went looking, three
    /// seats had erased it.
    /// </para>
    /// <para>
    /// <c>--log-file</c> REPLACES the default logger rather than adding to it (Godot 4.5
    /// <c>main/main.cpp</c>: the project's <c>debug/file_logging</c> logger is only installed when no
    /// <c>--log-file</c> was given), so a seat pointed at its own file never opens the host's at all. The path
    /// is opened with filesystem access, so an absolute path outside <c>user://</c> is allowed; rotation is
    /// disabled for an overridden path, so the seat's file is the only one that appears.
    /// </para>
    /// <para>
    /// QUOTED, because the macOS user dir contains a space (<c>~/Library/Application Support/…</c>) and
    /// <see cref="ProcessStartInfo.Arguments"/> is a command line, not an argv. A path containing a double
    /// quote cannot be quoted this way and is refused outright — a seat with no <c>--log-file</c> is the
    /// behaviour we already had, while a mis-split command line would be a seat that does not launch.
    /// </para>
    /// </remarks>
    internal static string SeatGameArguments(string? seatLogPath)
        => string.IsNullOrWhiteSpace(seatLogPath) || seatLogPath.Contains('"', StringComparison.Ordinal)
            ? SeatHeadlessArgument
            : $"{SeatHeadlessArgument} --log-file \"{seatLogPath}\"";

    /// <summary>
    /// True once any seat on this host has been launched WITHOUT user-dir isolation, i.e. into the host's own
    /// Godot profile.
    /// </summary>
    /// <remarks>
    /// Process-wide and one-way, because the condition is a property of the platform rather than of a seat.
    /// Read where a failure has to explain itself: without isolation the host cannot pin which copy of this mod
    /// a seat loads (<see cref="HeadlessSeatModSelection"/> only runs over a seat's OWN settings file), so a
    /// machine with two installed copies can produce <c>seat-build-mismatch</c> for a reason the generic detail
    /// does not name.
    /// </remarks>
    internal static bool SeatsShareTheHostProfile => Volatile.Read(ref _seatsShareTheHostProfile) != 0;

    private static int _seatsShareTheHostProfile;

    /// <summary>
    /// <see cref="SeatLogPath"/> for this host, with its directory created so the seat has somewhere to write
    /// and the host something to read back.
    /// </summary>
    /// <remarks>
    /// Godot would create the directory itself, but the host is the one that records this path as the seat's
    /// log SOURCE before the process exists — so it creates it, and answers null if it cannot. Null means the
    /// seat launches with no <c>--log-file</c>, which is exactly the behaviour that shipped; a thrown launch
    /// would be a seat nobody gets.
    /// </remarks>
    private static string? PrepareSeatLogPath(int slot)
    {
        var path = SeatLogPath(Connections.ConnectionRegistry.HostLogPath, slot);
        if (path is null) return null;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            return path;
        }
        catch (Exception exception)
            when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Console.Error.WriteLine($"[couch-coop] headless seat log dir unavailable slot={slot} path={path}: "
                + $"{exception.GetType().Name}: {exception.Message}");
            return null;
        }
    }

    /// <summary>
    /// The couch-coop environment a seat process is launched with. Pure (no process/Godot state beyond the host
    /// PID) so the launch contract is unit-testable.
    /// </summary>
    /// <param name="slot">Seat slot (2 upwards; see <see cref="MaxSlot"/> for where the range ends).</param>
    /// <param name="port">The seat's browser-server port.</param>
    /// <param name="netId">The seat's netId — becomes the faked <c>clientId</c> arg inside the seat.</param>
    /// <param name="hostNetId">
    /// The netId the HOST answers to. 1 for an ENet-only host; the host's SteamID64 when the session is
    /// Steam-hosted, in which case the seat must be told, because <c>ENetClient.HostNetId</c> is hardcoded to 1
    /// and every heartbeat echo would otherwise throw (see <see cref="Patches.HostNetIdPatch"/>).
    /// </param>
    /// <param name="hostPid">The host process id, for the seat's crash-proof self-reaper.</param>
    /// <param name="hostModBuild">
    /// The HOST's own CouchCoop build (<see cref="Connections.CouchCoopModBuildIdentity.Current"/>), which the
    /// seat compares against its own before it does anything else. A developer machine can have two copies of
    /// this mod installed — the local deploy and a Steam Workshop subscription — and the game picks between them
    /// per process, so "the host and its seats are the same build" is not something either side can assume.
    /// Passed in rather than read here so the launch contract stays pure and testable.
    /// </param>
    internal static IReadOnlyDictionary<string, string> SeatLaunchEnvironment(
        int slot,
        int port,
        ulong netId,
        ulong hostNetId,
        int hostPid,
        string hostModBuild)
        => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["COUCHCOOP_PREFERRED_PORT"] = port.ToString(CultureInfo.InvariantCulture),
            ["COUCHCOOP_HEADLESS_CLIENT"] = "1",
            ["COUCHCOOP_HEADLESS_SLOT"] = slot.ToString(CultureInfo.InvariantCulture),
            // Stamp our (host) PID so the headless's HeadlessHostWatchdog can self-terminate if the host dies
            // without reaping it (notably a host crash, which bypasses Dispose/Release) — no orphaned instances.
            ["COUCHCOOP_HOST_PID"] = hostPid.ToString(CultureInfo.InvariantCulture),
            // Replaces "--clientId <N>" on the command line.
            ["COUCHCOOP_CLIENT_ID"] = netId.ToString(CultureInfo.InvariantCulture),
            ["COUCHCOOP_HOST_NETID"] = hostNetId.ToString(CultureInfo.InvariantCulture),
            // The host's mod build, so the seat can refuse to be a different one. See HeadlessSeatBuildGuard.
            [Connections.CouchCoopModBuildIdentity.HostBuildEnvironmentVariable] = hostModBuild,
            // Explicit rather than implied: the game's FastMpJoin hardcodes 127.0.0.1:33771, and so do we, but
            // stating it means the seat's join target is visible in the process environment and can be redirected
            // without a rebuild (COUCHCOOP_JOIN_HOST is honored by every modded client).
            ["COUCHCOOP_JOIN_HOST"] = $"127.0.0.1:{CouchCoopHostTransport.EnetPort.ToString(CultureInfo.InvariantCulture)}",
        };

    /// <summary>
    /// Allocator / GC settings a seat is launched with. Separate from <see cref="SeatLaunchEnvironment"/> because
    /// these are TUNING, not contract: the seat joins and plays identically without them, and a profiling run
    /// overrides any of them by exporting its own value on the host (see the apply rule in <c>LaunchReal</c>).
    ///
    /// <para><b>Why these two.</b> A measured live seat (1374MB RSS) had spread its native heap across 42 glibc
    /// thread arenas holding 283MB, of which 62MB was free-but-retained slack — arenas are per-thread and the
    /// game runs 32 threads, so the default cap (8 * ncores) buys throughput we do not need in a process whose
    /// hot path is one main thread plus a few IO threads. Capping arenas collapses that slack. The CLR side was
    /// 182MB committed; GCConserveMemory trades a little collection throughput for a tighter heap, which is the
    /// right side of the trade for a seat that exists to mirror state, not to render.</para>
    ///
    /// Pure, so the launch contract stays unit-testable.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> SeatMemoryTuningEnvironment()
        => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["MALLOC_ARENA_MAX"] = "2",
            ["DOTNET_GCConserveMemory"] = "5",
        };

    /// <summary>
    /// Fill <see cref="SeatMemoryTuningEnvironment"/> into a seat's launch environment, but ONLY for keys the
    /// launching environment left unset — <c>psi.EnvironmentVariables</c> starts as a copy of this process's
    /// environment, so an operator-provided allocator or GC setting remains authoritative.
    ///
    /// <para>MUST use <c>ContainsKey</c>, never a read-and-test. On .NET, `ProcessStartInfo.EnvironmentVariables`
    /// is a `StringDictionaryWrapper` whose indexer GETTER forwards to a `Dictionary&lt;string, string&gt;`
    /// indexer — so reading an absent key THROWS `KeyNotFoundException` instead of returning null, unlike the
    /// classic `StringDictionary` it is typed as. Getting that wrong threw out of `LaunchReal` for the normal
    /// case (the variable is not set) and broke seat spawning outright, surfacing at the browser as
    /// `invalid-action-message: The given key 'MALLOC_ARENA_MAX' was not present in the dictionary`.</para>
    /// </summary>
    internal static void ApplyMemoryTuning(ProcessStartInfo psi)
    {
        ArgumentNullException.ThrowIfNull(psi);
        foreach (var kv in SeatMemoryTuningEnvironment())
        {
            if (!psi.EnvironmentVariables.ContainsKey(kv.Key))
            {
                psi.EnvironmentVariables[kv.Key] = kv.Value;
            }
        }
    }

    private IHeadlessProcess? LaunchReal(int slot)
    {
        var netId = SlotToNetId(slot);
        var port = SlotToPort(slot);
        // A seat joins over ENet. If this host has no ENet listener (Steam-only session: dual hosting disabled, or
        // its side failed to bind) the seat would boot, dial 127.0.0.1:33771 and hang until its readiness timeout.
        // Refuse loudly instead — the viewer gets the "no seat available" path immediately.
        if (!CouchCoopHostTransport.MaySpawnCouchSeat)
        {
            Console.Error.WriteLine(
                $"[couch-coop] headless launch refused slot={slot}: this host has no ENet listener for couch seats "
                + $"(dual={CouchCoopHostTransport.IsDual}). A seat can only join a host that is running the ENet side "
                + $"on port {CouchCoopHostTransport.EnetPort}.");
            // The name is read under the caller's lock: _launcher is only ever invoked from inside _lock.
            return null;
        }

        var hostNetId = CouchCoopHostTransport.HostNetId;

        // Isolate the Godot user dir per slot so instances don't interleave into one godot.log or overwrite each
        // other's files. Godot's STS2 custom user dir resolves via XDG_DATA_HOME on Linux and APPDATA on Windows;
        // the seeder (under user://couch-coop/headless-slots/) links the shared caches and RE-SEEDS the profile
        // from the host on every spawn, so this NEW instance inherits the host's current language / fps / fast
        // mode. This is the only call site, which is why re-seeding here can never disturb a reused live
        // instance. Best-effort: if the slot dir can't be prepared we launch without isolation (shared user dir).
        //
        // RESOLVED BEFORE THE COMMAND LINE IS BUILT, because the answer decides it: a seat with no isolation of
        // its own must be handed an explicit --log-file, or starting it truncates the host's live log.
        var preparedUserDir = HeadlessUserDirSeeder.Prepare(slot);
        var seatLogPath = preparedUserDir is null
            ? PrepareSeatLogPath(slot)
            : Path.Combine(preparedUserDir.SlotUserDir, "logs", "godot.log");
        var gameArgs = SeatGameArguments(preparedUserDir is null ? seatLogPath : null);
        Console.Error.WriteLine($"[couch-coop] headless launching slot={slot} port={port} netId={netId} hostNetId={hostNetId} exe={_gameExe}");

        ProcessStartInfo psi;
        if (_headlessWrapper is not null)
        {
            // Wrapper is e.g. "gamescope --backend headless -W 1280 -H 720 -w 1280 -h 720 -r 16 --"
            var spaceIdx = _headlessWrapper.IndexOf(' ');
            var wrapperExe = spaceIdx > 0 ? _headlessWrapper[..spaceIdx] : _headlessWrapper;
            var wrapperArgs = spaceIdx > 0 ? _headlessWrapper[(spaceIdx + 1)..] : string.Empty;
            psi = new ProcessStartInfo
            {
                FileName = wrapperExe,
                Arguments = $"{wrapperArgs} \"{_gameExe}\" {gameArgs}",
                UseShellExecute = false,
            };
        }
        else
        {
            psi = new ProcessStartInfo
            {
                FileName = _gameExe,
                Arguments = gameArgs,
                UseShellExecute = false,
            };
        }

        foreach (var kv in SeatLaunchEnvironment(
            slot, port, netId, hostNetId, Environment.ProcessId, Connections.CouchCoopModBuildIdentity.Current))
        {
            psi.EnvironmentVariables[kv.Key] = kv.Value;
        }
        ApplyConnectionEnvironmentLocked(slot, psi);
        ApplyMemoryTuning(psi);
        // Give each headless its OWN spirectl bridge endpoint so it doesn't steal the host's default endpoint.
        // Unix-like hosts use a Unix socket; Windows uses spirectl's named-pipe transport.
        foreach (var kv in SpirectlBridgeEndpointEnvironment(slot, RuntimeInformation.IsOSPlatform(OSPlatform.Windows)))
        {
            if (kv.Value is null)
            {
                psi.EnvironmentVariables.Remove(kv.Key);
            }
            else
            {
                psi.EnvironmentVariables[kv.Key] = kv.Value;
            }
        }
        if (preparedUserDir is not null)
        {
            foreach (var kv in preparedUserDir.EnvironmentVariables)
            {
                psi.EnvironmentVariables[kv.Key] = kv.Value;
            }
        }
        else
        {
            // "Best-effort" used to mean "silently". A seat launched with no isolation runs fine, but every
            // player on this machine then writes into ONE settings/save profile — which is both a support
            // problem and a real one (the last writer wins on settings). macOS reaches this on every spawn:
            // Godot resolves user:// from $HOME there and has no --user-dir flag, so there is nothing to
            // repoint. Say it in the log AND in the panel, as a warning: co-op works, with a limitation the
            // player should know about before they report a bug.
            //
            // The shared godot.log is NO LONGER part of it: gameArgs above hands this seat its own --log-file,
            // so the host's log survives the spawn. The row still says the profile is shared, because that half
            // is unfixed until macOS gets real isolation.
            Volatile.Write(ref _seatsShareTheHostProfile, 1);
            var platform = RuntimeInformation.OSDescription;
            HeadlessLog.Write(
                $"[couch-coop] headless launching WITHOUT user-dir isolation slot={slot} platform={platform} — "
                + $"this seat shares the host's Godot user directory; its log goes to {seatLogPath ?? "the shared user directory"}.");
            CouchCoop.Mod.Connections.ConnectionRegistry.Shared.ReportHostIssue(
                SharedUserDirCode,
                "Players on this computer share one game profile.",
                "Co-op still works. Avoid changing game settings while other players are connected, and mention this line if you report a problem.",
                $"No per-slot Godot user directory is available on this platform ({platform}); seat slot {slot} was launched into the host's user directory."
                    + $" Its log is kept separate at: {seatLogPath ?? "unavailable — this seat shares the host's godot.log"}.",
                isWarning: true);
        }
        // Explicit paths, not user dirs: without isolation the seat's log is NOT `<userDir>/logs/godot.log`
        // (that one belongs to the host) but the per-slot file --log-file points at. Passing the user dir here
        // is what made every macOS seat failure report its client log as "unavailable".
        CaptureConnectionLogsLocked(
            slot,
            preparedUserDir?.HostUserDir is { } hostUserDir
                ? Path.Combine(hostUserDir, "logs", "godot.log")
                : Connections.ConnectionRegistry.HostLogPath,
            seatLogPath);
        // SHARE THE HOST'S SECURE-ORIGIN CERTIFICATE CACHE. This must come AFTER the user-dir isolation above,
        // because that isolation is exactly what breaks the cache: the seeder repoints XDG_DATA_HOME (Linux) /
        // LOCALAPPDATA (Windows) at a per-slot directory, and the certificate cache defaults to
        // LocalApplicationData — so without this line every seat resolves a DIFFERENT, always-empty cache and
        // performs its own WAN fetch of the same published bundle.
        //
        // That costs one network round-trip per seat (up to the fetch timeout each) on a path where the seat's
        // secure port must be published quickly: a viewer's join waits on it and fails closed if it does not
        // arrive. Pointing every seat at the host's cache makes it a local file read instead — the host has
        // already fetched at startup, long before any seat is spawned.
        //
        // Writes can in principle interleave if two seats both find the cache stale at once; a torn bundle is
        // re-validated on load and simply misses, costing a re-fetch rather than a bad certificate.
        var secureCertCache = CouchCoop.Mod.Server.SecureOriginCertificates.DefaultCacheRoot();
        if (!string.IsNullOrWhiteSpace(secureCertCache))
        {
            psi.EnvironmentVariables[CouchCoop.Mod.Server.SecureOriginCertificates.CacheRootEnvironmentVariable] =
                secureCertCache;
        }

        // Prevent the headless child from inheriting the host's port so if it tried to spawn
        // sub-headless instances (it won't, but defensive) they'd start at the right base.
        psi.EnvironmentVariables.Remove("COUCHCOOP_HEADLESS_WRAPPER");

        try
        {
            var proc = Process.Start(psi);
            if (proc != null)
            {
                Console.Error.WriteLine($"[couch-coop] headless spawned slot={slot} pid={proc.Id}");
                return new OsHeadlessProcess(proc);
            }
            return null;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[couch-coop] headless launch failed slot={slot}: {ex.GetType().Name}: {ex.Message}");
            throw;
        }
    }

    internal static IReadOnlyDictionary<string, string?> SpirectlBridgeEndpointEnvironment(int slot, bool isWindows)
    {
        return isWindows
            ? new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["SPIRECTL_BRIDGE_SOCKET_PATH"] = null,
                ["SPIRECTL_BRIDGE_PIPE_NAME"] = $"spirectl-bridge-slot-{slot}",
                ["SPIRECTL_BRIDGE_TCP_ADDRESS"] = null,
            }
            : new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["SPIRECTL_BRIDGE_SOCKET_PATH"] = $"/tmp/spirectl-bridge-slot-{slot}.sock",
                ["SPIRECTL_BRIDGE_PIPE_NAME"] = null,
                ["SPIRECTL_BRIDGE_TCP_ADDRESS"] = null,
            };
    }

    /// <summary>
    /// <see cref="SeatReadyTimeoutEnvironmentVariable"/> resolved to a timeout: unset / blank / unparseable ⇒
    /// <see cref="DefaultSeatReadyTimeoutSeconds"/>; anything else ⇒ that many seconds, clamped into
    /// <see cref="MinSeatReadyTimeoutSeconds"/>..<see cref="MaxSeatReadyTimeoutSeconds"/>. Anything that does not
    /// parse as a plain number of seconds — <c>"sixty"</c>, but also <c>"60s"</c> — falls back to the default
    /// rather than being guessed at: honouring half of a malformed value would silently give the operator a
    /// deadline they did not ask for. Pure, so the band is testable without a game install.
    /// </summary>
    internal static TimeSpan ParseSeatReadyTimeout(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)
            || !double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
            || !double.IsFinite(seconds))
        {
            return TimeSpan.FromSeconds(DefaultSeatReadyTimeoutSeconds);
        }

        return TimeSpan.FromSeconds(
            Math.Clamp(seconds, MinSeatReadyTimeoutSeconds, MaxSeatReadyTimeoutSeconds));
    }


    // Read per wait rather than cached: it costs one environment lookup per join, and a cached copy would be one
    // more thing to reason about on the hot-reload path for no gain.
    private static TimeSpan SeatReadyTimeout
        => ParseSeatReadyTimeout(Environment.GetEnvironmentVariable(SeatReadyTimeoutEnvironmentVariable));

    private async Task<int?> WaitForReadyAsync(int slot, Guid sessionId, CancellationToken ct)
    {
        var port = SlotToPort(slot);
        // The headless ENet-joins, preloads ~770 'Common' assets, builds the lobby scene, and only THEN starts its
        // browser HTTP server. Cold starts (first launch into a freshly isolated user dir, dummy-renderer texture
        // churn) routinely take 20-30s, and a low-power host (a Steam Deck's 15W, shared with the GPU, while it is
        // also running the host game) can run well past that while starting perfectly normally — so the deadline is
        // set against what the phone will wait for, not against a desktop stopwatch. See
        // DefaultSeatReadyTimeoutSeconds for the number, and SeatReadyTimeoutEnvironmentVariable to override it.
        var started = DateTimeOffset.UtcNow;
        var deadline = started + SeatReadyTimeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            lock (_lock)
            {
                // Process died or was released while we were waiting. NOTE: a same-name reconnect may
                // have transferred this slot to another session; only treat it as gone if the SLOT has
                // no live process — not if this specific session lost ownership (still a valid port).
                if (_disposed || !_processBySlot.TryGetValue(slot, out var proc)) return null;
                bool exited;
                int exitCode = 0;
                try { exited = proc.HasExited; if (exited) exitCode = proc.ExitCode; }
                catch { exited = true; }
                if (exited)
                {
                    Console.Error.WriteLine($"[couch-coop] headless exited early slot={slot} exitCode={exitCode}");
                    RemoveNameForSlotLocked(slot);
                    ShutdownSlotLocked(slot, graceful: false);
                    _sessionToSlot.Remove(sessionId);
                    return null;
                }
            }
            if ((await _readinessProbe(port, ct).ConfigureAwait(false)).Responding)
            {
                Console.Error.WriteLine($"[couch-coop] headless ready slot={slot} port={port}");
                return port;
            }

            await Task.Delay(250, ct).ConfigureAwait(false);
        }

        // Timeout: kill the process
        Console.Error.WriteLine($"[couch-coop] headless startup timeout slot={slot} port={port} — killing.");
        lock (_lock)
        {
            _sessionToSlot.Remove(sessionId);
            RemoveNameForSlotLocked(slot);
            ShutdownSlotLocked(slot, graceful: false);
        }
        return null;
    }

    /// <summary>
    /// Ask the headless instance serving <paramref name="httpPort"/> for the TLS port it actually bound, or
    /// <see langword="null"/> when it has none within <paramref name="timeout"/>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY WE ASK INSTEAD OF DERIVING. Each headless instance is a separate process that port-walks its own
    /// listeners, so <c>httpPort + PreferredPortOffset</c> is a guess that is wrong exactly when a port was
    /// taken — and a redirect to a port nothing is listening on hangs the phone with no error. The instance
    /// is the only authority on the port it bound.
    /// </para>
    /// <para>
    /// WHY IT NEEDS A WINDOW RATHER THAN A SINGLE GET. A headless instance's secure listener comes up AFTER
    /// its HTTP listener: certificate acquisition is deliberately detached so it can never delay startup.
    /// Readiness therefore fires while the TLS port may still be seconds away. In practice the host has
    /// already populated the shared certificate cache long before any seat is spawned, so this usually
    /// succeeds on the first poll; the window covers the cold case rather than defining it.
    /// </para>
    /// <para>
    /// Only ever called for a TLS viewer. A plain-HTTP join never reaches here, which is what keeps that path
    /// byte-for-byte unchanged.
    /// </para>
    /// </remarks>
    public static async Task<int?> TryResolveSecurePortAsync(
        int httpPort,
        TimeSpan timeout,
        CancellationToken ct)
    {
        if (httpPort <= 0)
        {
            return null;
        }

        var deadline = DateTimeOffset.UtcNow + timeout;
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            try
            {
                using var response = await http
                    .GetAsync($"http://127.0.0.1:{httpPort.ToString(CultureInfo.InvariantCulture)}{CouchCoop.Mod.Server.SecureOriginEndpoint.Route}", ct)
                    .ConfigureAwait(false);

                if (response.IsSuccessStatusCode)
                {
                    var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    using var document = JsonDocument.Parse(body);
                    if (document.RootElement.TryGetProperty("securePort", out var value)
                        && value.ValueKind == JsonValueKind.Number
                        && value.TryGetInt32(out var securePort)
                        && securePort > 0)
                    {
                        return securePort;
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Not up yet, or an older instance with no such route. Both are "keep waiting".
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                return null;
            }

            await Task.Delay(250, ct).ConfigureAwait(false);
        }
    }

    // Real readiness probe: any HTTP response (2xx/4xx/5xx) means the headless's browser server is
    // listening; only a connection-refused/timeout means it isn't up yet.
    internal static async Task<SeatListenerProbeResult> DefaultHttpReadinessAsync(int port, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
        var started = Stopwatch.GetTimestamp();
        try
        {
            using var r = await http.GetAsync($"http://127.0.0.1:{port}/", ct).ConfigureAwait(false);
            return new SeatListenerProbeResult(true, null, SeatPortReachability.NotProbed);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception exception)
        {
            // WHY it failed, not only that it did. "Not responding" on its own fitted three unrelated causes
            // (see SeatReadinessVerdict), and the difference between a REFUSED connection (nothing is listening
            // yet) and a DROPPED one (a local firewall rule ate the host's own loopback packet) is exactly the
            // evidence that tells two of them apart.
            var elapsed = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            var socketError = (exception as HttpRequestException)?.InnerException as System.Net.Sockets.SocketException;
            var cause = socketError is null
                ? exception.GetType().Name
                : $"{exception.GetType().Name}/{socketError.SocketErrorCode}";
            var failure = $"{cause} after {elapsed.ToString(CultureInfo.InvariantCulture)} ms";

            // …and then ONE raw TCP connect, on the failure path only, because the HTTP timeout alone still
            // fits two very different states. A DROPPED packet never completes the handshake. A listener that is
            // BOUND BUT WEDGED — accept loop stuck, HTTP server mid-init — completes it from the kernel backlog
            // and only the read times out. Both print the same TaskCanceledException, so without this the second
            // one would be reported as a firewall problem on a machine whose firewall is fine. A healthy join
            // never reaches here, and the connect carries the caller's token so a shutdown is not delayed.
            var reachability = ct.IsCancellationRequested
                ? new SeatPortProbe(SeatPortReachability.NotProbed, "not probed: the attempt was cancelled")
                : await SeatPortAvailability
                    .ProbeLoopbackAsync(port, SeatPortAvailability.ProbeTimeout, ct)
                    .ConfigureAwait(false);

            return new SeatListenerProbeResult(
                false, $"{failure}; {reachability.Detail}", reachability.Reachability);
        }
    }
}

/// <summary>
/// One result of the host's own loopback HTTP probe of a seat's assigned browser port, WITH the reason it
/// failed. The reason is the point: the probe used to return a bare bool, and the single word "not responding"
/// that produced was the whole evidence behind a message that fitted a port conflict, a local firewall rule and
/// a blocked phone equally well.
/// </summary>
/// <param name="Responding">Whether anything answered HTTP on the port. Any status code counts.</param>
/// <param name="Failure">Exception type (and socket error, where there is one) plus elapsed ms; null on success.</param>
/// <param name="Reachability">
/// What a raw TCP connect found immediately afterwards — measured only when the HTTP probe failed, and the fact
/// that separates "this machine is dropping its own packets" from "the listener is there and not serving yet".
/// <see cref="SeatPortReachability.NotProbed"/> whenever it was not measured, which must never be read as either.
/// </param>
internal readonly record struct SeatListenerProbeResult(
    bool Responding,
    string? Failure,
    SeatPortReachability Reachability);

/// <summary>
/// Real <see cref="IHeadlessProcess"/> over a spawned <see cref="Process"/>. On Linux, graceful stop
/// sends SIGTERM (lets the headless run ENet leave + teardown so the host drops the peer); the hard
/// <see cref="Kill"/> sends SIGKILL to the whole tree.
/// </summary>
internal sealed class OsHeadlessProcess(Process process) : IHeadlessProcess
{
    private const int SIGTERM = 15;

    [DllImport("libc", SetLastError = true)]
    private static extern int kill(int pid, int sig);

    public int Id => process.Id;
    public bool HasExited => process.HasExited;
    public int ExitCode => process.ExitCode;

    public bool RequestGracefulStop()
    {
        // .NET's Process.Kill() always sends SIGKILL on Unix, which gives the headless no chance to
        // disconnect from ENet → the host keeps a stale peer (the phantom lobby player). Send SIGTERM
        // directly so the game runs its normal shutdown (including the ENet leave) instead.
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
            && !RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return false; // non-Unix: no graceful signal available; caller falls back to Kill().
        }
        try
        {
            return kill(process.Id, SIGTERM) == 0;
        }
        catch
        {
            return false;
        }
    }

    public void Kill()
    {
        if (!process.HasExited) process.Kill(entireProcessTree: true);
        // Process.Kill sends the signal asynchronously. Confirm its result before releasing the owned seat.
        process.WaitForExit(1000);
    }

    public void Dispose() => process.Dispose();
}
