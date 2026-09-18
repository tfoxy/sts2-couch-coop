using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace CouchCoop.Mod.Connections;

/// <summary>Host-owned authenticated status records for spawned headless clients.</summary>
public sealed class HeadlessConnectionControl
{
    public static HeadlessConnectionControl Shared { get; } = new();

    private readonly object _gate = new();
    private readonly List<Entry> _entries = [];
    private long _refusedTotal;
    private HeadlessConnectionRejection _lastRefusal;
    public event Action<HeadlessConnectionControlSnapshot>? StatusChanged;

    /// <summary>
    /// Every status this process has REFUSED, and why the last one was refused — across all slots and
    /// generations, including the ones no entry could be found for.
    /// </summary>
    /// <remarks>
    /// <para>
    /// WHY PROCESS-WIDE AND NOT ONLY PER ENTRY. Two of the five refusals happen before any entry is known: a
    /// request with no bearer token, and one whose token matches nothing this host registered. Counted per entry
    /// those two would be counted nowhere, and they are exactly the shapes that leave a seat POSTing once a
    /// second into a host that answers 200-less silence. A seat's own counters live on its
    /// <see cref="HeadlessConnectionControlSnapshot"/>; this pair is what the host needs to tell "nothing ever
    /// reached me" from "something reached me and I turned it away", which are opposite diagnoses with opposite
    /// fixes and were previously the same observation.
    /// </para>
    /// <para>
    /// Read as a PAIR under one lock, so the count and the reason can never describe two different requests.
    /// </para>
    /// </remarks>
    public HeadlessConnectionRefusals Refusals
    {
        get { lock (_gate) return new(_refusedTotal, _lastRefusal); }
    }

    public void Register(int slot, long generation, Guid sourceSessionId, string bearerToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(bearerToken);
        ArgumentOutOfRangeException.ThrowIfNegative(slot);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(generation);
        if (bearerToken.Length > 512) throw new ArgumentOutOfRangeException(nameof(bearerToken));
        lock (_gate)
        {
            _entries.RemoveAll(entry => entry.Slot == slot);
            _entries.Add(new Entry(slot, generation, sourceSessionId, HashToken(bearerToken)));
        }
    }

    public HeadlessConnectionObserveResult Observe(string? bearerToken, long generation, HeadlessConnectionStatus status)
    {
        if (string.IsNullOrWhiteSpace(bearerToken) || !IsValid(status))
        {
            // No entry to count these on, by definition: neither check has looked a token up yet.
            return Refuse(string.IsNullOrWhiteSpace(bearerToken)
                ? HeadlessConnectionRejection.NoBearerToken
                : HeadlessConnectionRejection.InvalidPayload);
        }

        HeadlessConnectionControlSnapshot snapshot;
        lock (_gate)
        {
            var tokenHash = HashToken(bearerToken);
            var entry = _entries.FirstOrDefault(candidate =>
                CryptographicOperations.FixedTimeEquals(candidate.TokenHash, tokenHash));
            if (entry is null)
            {
                return RefuseLocked(null, HeadlessConnectionRejection.UnknownToken);
            }

            if (entry.Generation != generation)
            {
                return RefuseLocked(entry, HeadlessConnectionRejection.GenerationMismatch);
            }

            if (status.Sequence <= entry.LastSequence)
            {
                return RefuseLocked(entry, HeadlessConnectionRejection.StaleSequence);
            }

            entry.Accepted++;
            entry.LastSequence = status.Sequence;
            entry.LastStatus = status;
            entry.ObservedAtUtc = DateTimeOffset.UtcNow;
            entry.ObservedMonotonicTick = Stopwatch.GetTimestamp();
            snapshot = entry.ToSnapshot();
        }
        // Deliver before answering the child: its next action may be to close the browser and exit.
        foreach (var observer in StatusChanged?.GetInvocationList() ?? [])
        {
            try { ((Action<HeadlessConnectionControlSnapshot>)observer)(snapshot); }
            catch { /* An observer cannot make an authenticated heartbeat fail. */ }
        }
        return new HeadlessConnectionObserveResult(true, snapshot.ShutdownRequested);
    }

    /// <summary>Record an entry-less refusal from OUTSIDE <see cref="_gate"/> and answer <c>Rejected</c>.</summary>
    private HeadlessConnectionObserveResult Refuse(HeadlessConnectionRejection reason)
    {
        lock (_gate) return RefuseLocked(null, reason);
    }

    /// <summary>
    /// Record a refusal on the process-wide pair and, where one is known, on the seat's own entry, then answer
    /// <c>Rejected</c>. Every <c>return Rejected</c> in <see cref="Observe"/> goes through here or through
    /// <see cref="Refuse"/>, so a refusal cannot be added later without being counted.
    /// </summary>
    private HeadlessConnectionObserveResult RefuseLocked(Entry? entry, HeadlessConnectionRejection reason)
    {
        _refusedTotal++;
        _lastRefusal = reason;
        if (entry is not null)
        {
            entry.Refused++;
            entry.LastRefusal = reason;
        }

        return HeadlessConnectionObserveResult.Rejected;
    }

    public bool RequestShutdown(int slot, long generation)
    {
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(candidate => candidate.Slot == slot && candidate.Generation == generation);
            if (entry is null) return false;
            entry.ShutdownRequested = true;
            return true;
        }
    }

    public HeadlessConnectionControlSnapshot? Snapshot(int slot, long generation)
    {
        lock (_gate)
        {
            var entry = _entries.FirstOrDefault(candidate => candidate.Slot == slot && candidate.Generation == generation);
            return entry is null ? null : entry.ToSnapshot();
        }
    }

    public IReadOnlyList<HeadlessConnectionControlSnapshot> Snapshot()
    {
        lock (_gate) return _entries.Select(entry => entry.ToSnapshot()).ToArray();
    }

    public void Unregister(int slot, long generation)
    {
        lock (_gate)
        {
            _entries.RemoveAll(entry => entry.Slot == slot && entry.Generation == generation);
        }
    }

    private static bool IsValid(HeadlessConnectionStatus status)
        => status.Sequence > 0
            && !string.IsNullOrWhiteSpace(status.NativePhase)
            && status.NativePhase.Length <= 32
            && (status.ErrorCode is null || status.ErrorCode.Length <= 128)
            && (status.ErrorDetail is null || status.ErrorDetail.Length <= 2048)
            && status.ConnectedChildBrowserCount >= 0
            // 0 is "not bound yet"; anything outside the port space is a payload the host must not act on, and it
            // WOULD act on it — a reported port that disagrees with the assigned one fails the join.
            && status.BrowserPort is >= 0 and <= ushort.MaxValue
            // A count is either absent or a count. A negative one is neither, and the verdict downstream
            // compares it against zero.
            && status.ViewerArrivalCount is null or >= 0;

    private static byte[] HashToken(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    private sealed class Entry(int slot, long generation, Guid sourceSessionId, byte[] tokenHash)
    {
        public int Slot { get; } = slot;
        public long Generation { get; } = generation;
        public Guid SourceSessionId { get; } = sourceSessionId;
        public byte[] TokenHash { get; } = tokenHash;
        public long LastSequence { get; set; }
        public HeadlessConnectionStatus? LastStatus { get; set; }
        public DateTimeOffset? ObservedAtUtc { get; set; }
        public long? ObservedMonotonicTick { get; set; }
        public bool ShutdownRequested { get; set; }
        /// <summary>How many statuses this seat has had accepted, and how many refused, and why the last one was.</summary>
        public long Accepted { get; set; }
        public long Refused { get; set; }
        public HeadlessConnectionRejection LastRefusal { get; set; }

        public HeadlessConnectionControlSnapshot ToSnapshot()
            => new(
                Slot, Generation, SourceSessionId, LastStatus, ObservedAtUtc, ObservedMonotonicTick,
                ShutdownRequested, Accepted, Refused, LastRefusal);
    }
}

/// <param name="BrowserPort">
/// The port this seat's browser server ACTUALLY bound, or <c>0</c> before it has one. Additive, and safe to be so:
/// the build guard already enforces that a seat and its host are the same build, so there is no older seat to read
/// this from. It exists because the host otherwise has no authority on the question — it assumed
/// <c>HeadlessClientManager.SlotToPort(slot)</c> at every decision point while the seat's real port went only to a
/// file nothing in the mod opens. <c>0</c> means "has not said yet" and must never be read as a disagreement.
/// </param>
/// <param name="ViewerArrivalCount">
/// How many HTTP requests from something other than this machine have reached THIS seat's own browser server over
/// the seat process's lifetime — <see cref="ConnectionArrivalLog.ViewerArrivalCount"/>, which excludes loopback so
/// the host's own readiness probe can never be counted as a device. The host cannot observe this for itself: the
/// request that proves a phone got through lands on the seat's listener, in another process, and leaves no trace
/// on the host. Additive on the same grounds as <see cref="BrowserPort"/> — the build guard makes a seat and its
/// host the same build, so there is no older seat to read this from.
/// </param>
/// <param name="CloudSaveIsolated">
/// The seat's POSITIVE declaration that it has closed every path by which it could write into the Steam Cloud
/// save storage of the account running the host (<c>HeadlessSeatCloudIsolationGuard.Installed</c>). A heartbeat
/// without it fails the seat — see <c>HeadlessClientManager.SeatCloudIsolationCode</c>.
/// <para>
/// NOT nullable, and defaulting to <see langword="false"/> on purpose: absent must mean "not declared", because
/// the payloads that would omit it are exactly the dangerous ones — an older or foreign CouchCoop that heartbeats
/// without the field, and JSON that simply does not carry it. Every other additive field on this record defaults
/// to the answer that is safe to act on; this one defaults to the answer that is safe to REFUSE on.
/// </para>
/// </param>
/// <remarks>
/// <para>
/// <b>Why this one is nullable and <see cref="BrowserPort"/> is not.</b> Both are additive and both default, but
/// the danger of a defaulted value is not symmetric. 0 is not a legal port, so a <see cref="BrowserPort"/> of 0
/// cannot be mistaken for a real answer. 0 arrivals, by contrast, IS the load-bearing value — it is the whole
/// evidence for the host's <c>seat-network-path</c> verdict, which tells a player their router or Wi-Fi is at
/// fault. A status that simply never carried the field would then read as "the seat says nothing ever reached
/// it", and a missing field would become an accusation. <see langword="null"/> keeps "has not said" unforgeable,
/// and the verdict requires an affirmative zero before it will blame the network.
/// </para>
/// </remarks>
public sealed record HeadlessConnectionStatus(
    long Sequence,
    string NativePhase,
    string? ErrorCode,
    string? ErrorDetail,
    int ConnectedChildBrowserCount,
    int BrowserPort = 0,
    long? ViewerArrivalCount = null,
    bool CloudSaveIsolated = false);

public sealed record HeadlessConnectionObserveResult(bool Accepted, bool ShutdownRequested)
{
    public static HeadlessConnectionObserveResult Rejected { get; } = new(false, false);
}

/// <summary>Why one status was refused. <see cref="None"/> only ever means "none has been".</summary>
/// <remarks>
/// A closed set of short tokens because the name is quoted into the copyable report and into
/// <c>godot.log</c>, exactly like <c>ConnectionArrivalOutcome</c>: a refusal reason must never be able to
/// carry text a caller chose.
/// </remarks>
public enum HeadlessConnectionRejection
{
    None,

    /// <summary>No bearer token at all — not something a CouchCoop seat of this build ever sends.</summary>
    NoBearerToken,

    /// <summary>The payload failed <c>IsValid</c>: a bad sequence, phase, port or count.</summary>
    InvalidPayload,

    /// <summary>A well-formed status whose token matches no seat this host registered.</summary>
    UnknownToken,

    /// <summary>The right seat, the wrong generation — a status from a process this host has replaced.</summary>
    GenerationMismatch,

    /// <summary>A sequence this host has already seen; the seat is repeating itself.</summary>
    StaleSequence,
}

/// <summary>Every status refused by this host, and why the last one was. See <c>Refusals</c>.</summary>
public readonly record struct HeadlessConnectionRefusals(long Count, HeadlessConnectionRejection Last);

/// <param name="AcceptedCount">
/// How many statuses this host has ACCEPTED for this seat and generation. Load-bearing at zero: a seat whose
/// count is zero has never once been heard, which is a different fact from a seat that spoke and went quiet.
/// </param>
/// <param name="RefusedCount">
/// How many of this seat's statuses were refused, and <paramref name="LastRefusal"/> why the last one was.
/// Counted only where the token identified an entry, so the process-wide pair
/// (<c>HeadlessConnectionControl.Refusals</c>) is the one that also covers a token this host does not know.
/// </param>
public sealed record HeadlessConnectionControlSnapshot(
    int Slot,
    long Generation,
    Guid SourceSessionId,
    HeadlessConnectionStatus? Status,
    DateTimeOffset? ObservedAtUtc,
    long? ObservedMonotonicTick,
    bool ShutdownRequested,
    long AcceptedCount = 0,
    long RefusedCount = 0,
    HeadlessConnectionRejection LastRefusal = HeadlessConnectionRejection.None);
