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
    public event Action<HeadlessConnectionControlSnapshot>? StatusChanged;

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
            return HeadlessConnectionObserveResult.Rejected;
        }

        HeadlessConnectionControlSnapshot snapshot;
        lock (_gate)
        {
            var tokenHash = HashToken(bearerToken);
            var entry = _entries.FirstOrDefault(candidate =>
                CryptographicOperations.FixedTimeEquals(candidate.TokenHash, tokenHash));
            if (entry is null || entry.Generation != generation || status.Sequence <= entry.LastSequence)
            {
                return HeadlessConnectionObserveResult.Rejected;
            }

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

        public HeadlessConnectionControlSnapshot ToSnapshot()
            => new(Slot, Generation, SourceSessionId, LastStatus, ObservedAtUtc, ObservedMonotonicTick, ShutdownRequested);
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

public sealed record HeadlessConnectionControlSnapshot(
    int Slot,
    long Generation,
    Guid SourceSessionId,
    HeadlessConnectionStatus? Status,
    DateTimeOffset? ObservedAtUtc,
    long? ObservedMonotonicTick,
    bool ShutdownRequested);
