using System.Net;
using System.Security.Cryptography;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Connections;

/// <summary>What this process did with one HTTP request that reached it.</summary>
/// <remarks>
/// Deliberately a small closed set of short ASCII tokens: an outcome is quoted into the copyable report and
/// into <c>godot.log</c>, so it must never be able to carry anything a caller chose.
/// </remarks>
public static class ConnectionArrivalOutcome
{
    /// <summary>The SPA document was served — the response that carries a freshly minted visit id.</summary>
    public const string Shell = "shell";
    /// <summary>A <c>/ws</c> upgrade was accepted. On a seat this is the viewer's arrival at the seat.</summary>
    public const string WebSocket = "websocket";
    public const string NotFound = "not-found";
    public const string OriginRefused = "origin-refused";
    public const string InvalidUpgrade = "invalid-upgrade";
    public const string WebSocketCapacity = "websocket-capacity";
    public const string RuntimeUnavailable = "runtime-unavailable";
}

/// <summary>
/// One recorded HTTP arrival. <paramref name="FromViewer"/> is false only for a request this machine made to
/// itself (the host's own loopback readiness probe), which is what lets a caller ask "did any *device* ever
/// reach this process" without counting the host's own traffic.
/// </summary>
public sealed record ConnectionArrival(
    DateTimeOffset AtUtc,
    string RemoteAddress,
    string Path,
    string Outcome,
    string? VisitId,
    string? DeviceLabel,
    bool FromViewer,
    int Repeats = 1,
    Guid? PromotedClientId = null);

/// <summary>An aggregate answer about arrivals, for callers that need a verdict rather than a list.</summary>
public sealed record ConnectionArrivalSummary(
    int Count,
    DateTimeOffset? FirstAtUtc,
    DateTimeOffset? LastAtUtc,
    string? DeviceLabel,
    bool Promoted)
{
    public static readonly ConnectionArrivalSummary None = new(0, null, null, null, false);
    public bool Any => Count > 0;
}

/// <summary>
/// The pre-WebSocket half of connection diagnostics: a bounded ring of the HTTP requests that reached THIS
/// process, so a device that fetched the join page and never opened <c>/ws</c> stops being invisible.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why a visit id at all.</b> Until the WebSocket upgrade there is no connection identity —
/// <see cref="ConnectionRegistry.Connected"/> is called at the upgrade, so a TCP connect, a <c>GET /</c> and a
/// bundle fetch left no row and no log line, and every pre-socket failure looked identical from the host's
/// chair. The SPA document is served with a per-response nonce embedded in it (a <c>meta</c> tag — see
/// <see cref="VisitIdTag"/>); the browser reads it back out of its own DOM and sends it on <c>join</c>, which
/// is what merges the visit into the WebSocket row instead of leaving a second, ghost row beside it.
/// </para>
/// <para>
/// <b>Why not a cookie.</b> Cookies are not port-scoped (RFC 6265 §8.5): one set by <c>&lt;ip&gt;:13337</c> is
/// sent to <c>&lt;ip&gt;:13357</c> — and to every other service on every other port of that machine. Embedding
/// the id in the document means nothing is ever transmitted ambiently; the value travels only when our own
/// same-origin script chooses to send it.
/// </para>
/// <para>
/// <b>Bounds.</b> This sits on the request path of an unauthenticated LAN service, so every dimension is
/// capped: the ring is <see cref="MaximumRetainedArrivals"/> entries of fixed shape (no growth per caller),
/// a repeat of the newest entry coalesces into it rather than adding a row, user-agent parsing is memoised
/// and budgeted (see <c>DeviceLabelCache</c>), and <c>godot.log</c> emission is a token bucket, not a line
/// per request. Nothing here is keyed by remote address, because an IPv6 caller has an effectively unlimited
/// supply of those and a per-address dictionary would be the memory amplifier this class must not become.
/// </para>
/// <para>
/// <b>Privacy.</b> A player name is never recorded. Only the request PATH is kept (never the query string,
/// which is where <c>?name=</c> rides — <c>OfflineQrCode</c> strips it for the same reason), plus the remote
/// address and a coarse device label derived from the User-Agent.
/// </para>
/// </remarks>
public sealed class ConnectionArrivalLog
{
    /// <summary>The process-owned log. A seat is a separate process and therefore has its own.</summary>
    public static ConnectionArrivalLog Shared { get; } = new();

    /// <summary>Ring capacity, in the shape of <see cref="ConnectionRegistry.MaximumRetainedFailures"/>.</summary>
    public const int MaximumRetainedArrivals = 128;

    /// <summary>How many arrival lines one copyable report carries.</summary>
    public const int MaximumReportedArrivals = 12;

    /// <summary>Longest recorded path, in characters.</summary>
    public const int MaximumPathLength = 128;

    /// <summary>Visit ids are 16 random bytes, lower-case hex.</summary>
    public const int VisitIdLength = 32;

    /// <summary>
    /// How long an arrival stays eligible to be matched by visit id. A page older than this still joins
    /// normally — only the pre-socket correlation is lost, which is strictly better than keeping an
    /// unbounded set of un-promoted visits alive so that every reload, LAN scanner and prefetch can be
    /// resurrected as a row later.
    /// </summary>
    public static readonly TimeSpan VisitRetention = TimeSpan.FromMinutes(30);

    /// <summary>Repeats of the newest entry inside this window fold into it instead of adding a row.</summary>
    private static readonly TimeSpan CoalesceWindow = TimeSpan.FromSeconds(2);

    private const int LogBudgetPerWindow = 12;
    private static readonly TimeSpan LogWindow = TimeSpan.FromMinutes(1);

    private readonly object _gate = new();
    private readonly TimeProvider _time;
    private readonly Action<string> _log;
    // The layer BELOW this one. HostReachabilityWatch counts raw accepted TCP connections in the accept loops,
    // which is strictly earlier and broader than a completed HTTP request: a connection that completes TLS
    // badly, or connects and sends nothing, proves reachability while leaving no arrival here. Read (never
    // notified) so an empty ring can say which of the two silences it is.
    private readonly Func<bool> _sawInboundConnection;
    private readonly Server.RateLimitedDiagnosticLog _throttleNotice;
    private readonly DeviceLabelCache _labels = new();
    private readonly ConnectionArrival?[] _ring = new ConnectionArrival?[MaximumRetainedArrivals];
    private int _count;
    private int _next;
    private long _total;
    private long _viewerTotal;
    private DateTimeOffset? _firstViewerAtUtc;
    private DateTimeOffset? _lastViewerAtUtc;
    private long _logWindowStartMs;
    private int _logged;
    private int _suppressed;

    public ConnectionArrivalLog(
        TimeProvider? time = null,
        Action<string>? log = null,
        Func<bool>? sawInboundConnection = null)
    {
        _time = time ?? TimeProvider.System;
        _log = log ?? DefaultLog;
        _sawInboundConnection = sawInboundConnection ?? (() => HostReachabilityWatch.Shared.SawInboundConnection);
        _throttleNotice = new Server.RateLimitedDiagnosticLog(_log);
        _logWindowStartMs = (long)_time.GetUtcNow().ToUnixTimeMilliseconds();
    }

    /// <summary>
    /// Mint a visit id for a SPA document about to be served, and record its arrival. The returned id is what
    /// <see cref="VisitIdTag.Inject"/> embeds in that one response.
    /// </summary>
    public string BeginVisit(IPAddress? remoteAddress, string? userAgent, string path)
    {
        var visitId = MintVisitId();
        Record(remoteAddress, path, ConnectionArrivalOutcome.Shell, visitId, userAgent);
        return visitId;
    }

    /// <summary>Record one HTTP request that reached this process. Safe to call from any thread.</summary>
    /// <param name="visitId">
    /// The visit this request belongs to, when known: minted for a shell response, or read back off the
    /// <c>?visit=</c> selector a seat's WebSocket URL carries. Untrusted values are normalised away.
    /// </param>
    public void Record(
        IPAddress? remoteAddress,
        string path,
        string outcome,
        string? visitId = null,
        string? userAgent = null)
    {
        // Parsing a user agent is the one expensive thing on this path, so it happens OUTSIDE the ring lock
        // and behind a memo with a per-minute budget.
        var label = _labels.Resolve(userAgent);
        var now = _time.GetUtcNow();
        var address = DescribeAddress(remoteAddress);
        // "Not a viewer" means "this machine talking to itself" — the host's own loopback readiness probe.
        // An address we could not observe counts AS a viewer: the verdict this feeds ("nothing from that
        // device ever reached the seat") accuses the network, and it must not be reached by guessing.
        var fromViewer = remoteAddress is null || !IPAddress.IsLoopback(remoteAddress);
        var entry = new ConnectionArrival(now, address, CleanPath(path), CleanOutcome(outcome),
            NormalizeVisitId(visitId), label, fromViewer);

        bool coalesced;
        lock (_gate)
        {
            PruneLocked(now);
            _total++;
            if (fromViewer)
            {
                _viewerTotal++;
                _firstViewerAtUtc ??= now;
                _lastViewerAtUtc = now;
            }

            coalesced = TryCoalesceLocked(entry, now);
            if (!coalesced)
            {
                _ring[_next] = entry;
                _next = (_next + 1) % MaximumRetainedArrivals;
                if (_count < MaximumRetainedArrivals) _count++;
            }
        }

        if (!coalesced) Emit(entry);
    }

    /// <summary>
    /// Merge a visit into the WebSocket connection that has just claimed it, so the pre-socket half of that
    /// device's attempt reads as part of the same attempt rather than as a second, ownerless one.
    /// </summary>
    /// <returns><see langword="true"/> when a fresh arrival carried this visit id.</returns>
    public bool Promote(string? visitId, Guid clientId)
    {
        var visit = NormalizeVisitId(visitId);
        if (visit is null) return false;
        var promoted = false;
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            PruneLocked(now);
            for (var index = 0; index < _count; index++)
            {
                var slot = SlotLocked(index);
                if (_ring[slot] is not { } entry || entry.VisitId != visit) continue;
                _ring[slot] = entry with { PromotedClientId = clientId };
                promoted = true;
            }
        }

        return promoted;
    }

    /// <summary>
    /// READ API — "has anything ever arrived carrying this visit id?". The pre-socket half of the
    /// seat-readiness verdict: a seat that is listening, that the host's own probe can reach, and that this
    /// returns <see langword="false"/> for, was never reached by that device.
    /// </summary>
    public bool HasArrivedForVisit(string? visitId) => Summarize(visitId).Any;

    /// <summary>READ API — everything this process knows about one visit id.</summary>
    public ConnectionArrivalSummary Summarize(string? visitId)
    {
        var visit = NormalizeVisitId(visitId);
        if (visit is null) return ConnectionArrivalSummary.None;
        lock (_gate)
        {
            var now = _time.GetUtcNow();
            PruneLocked(now);
            var count = 0;
            DateTimeOffset? first = null, last = null;
            string? label = null;
            var promoted = false;
            for (var index = 0; index < _count; index++)
            {
                if (_ring[SlotLocked(index)] is not { } entry || entry.VisitId != visit) continue;
                count += entry.Repeats;
                first ??= entry.AtUtc;
                last = entry.AtUtc;
                label ??= entry.DeviceLabel;
                promoted |= entry.PromotedClientId is not null;
            }

            return count == 0 ? ConnectionArrivalSummary.None : new(count, first, last, label, promoted);
        }
    }

    /// <summary>
    /// READ API — "has any DEVICE ever reached this process?", counted over the process's whole life rather
    /// than over the ring, and excluding this machine's own loopback traffic. This is the signal a seat
    /// reports upstream: zero here, with the seat listening and its loopback probe answering, is the
    /// difference between "the path from the phone is blocked" and "the seat is not up yet".
    /// </summary>
    public ConnectionArrivalSummary SummarizeViewerArrivals()
    {
        lock (_gate)
        {
            var count = (int)Math.Min(int.MaxValue, _viewerTotal);
            return count == 0
                ? ConnectionArrivalSummary.None
                : new(count, _firstViewerAtUtc, _lastViewerAtUtc, null, false);
        }
    }

    /// <summary>Lifetime count of arrivals from something other than this machine.</summary>
    public long ViewerArrivalCount { get { lock (_gate) return _viewerTotal; } }

    /// <summary>Lifetime count of recorded arrivals, including this machine's own.</summary>
    public long TotalArrivalCount { get { lock (_gate) return _total; } }

    /// <summary>The ring, oldest first.</summary>
    public IReadOnlyList<ConnectionArrival> Snapshot()
    {
        lock (_gate)
        {
            var rows = new List<ConnectionArrival>(_count);
            for (var index = 0; index < _count; index++)
                if (_ring[SlotLocked(index)] is { } entry)
                    rows.Add(entry);
            return rows;
        }
    }

    /// <summary>
    /// The arrival lines folded into a copyable connection report: this attempt's own visit first, then the
    /// most recent others, newest first and capped at <see cref="MaximumReportedArrivals"/>.
    /// </summary>
    public IReadOnlyList<string> DescribeForReport(string? visitId)
    {
        var visit = NormalizeVisitId(visitId);
        List<ConnectionArrival> ordered;
        long total;
        lock (_gate)
        {
            total = _total;
            ordered = new List<ConnectionArrival>(_count);
            for (var index = _count - 1; index >= 0; index--)
                if (_ring[SlotLocked(index)] is { } entry)
                    ordered.Add(entry);
        }

        var selected = visit is null
            ? ordered.Take(MaximumReportedArrivals).ToList()
            : ordered.Where(entry => entry.VisitId == visit)
                .Concat(ordered.Where(entry => entry.VisitId != visit))
                .Take(MaximumReportedArrivals).ToList();
        var lines = selected.Select(Describe).ToList();
        if (total > selected.Count)
            lines.Add($"…and {total - selected.Count} further arrival(s) not shown.");
        if (lines.Count == 0)
        {
            // TWO DIFFERENT SILENCES, and only the lower layer can tell them apart. HostReachabilityWatch
            // counts accepted TCP connections, so "something connected and never asked for anything" (a
            // failed TLS handshake, a scanner, a stalled client) reads differently from "nothing reached this
            // listener at all", which is the condition that watch already raises its own row for.
            lines.Add(_sawInboundConnection()
                ? "Nothing has been requested over HTTP, but this host's listener HAS accepted a connection."
                : "Nothing has reached this host's listener at all — no request, and no inbound connection.");
        }

        return lines;
    }

    /// <summary>Forget every arrival. Used when hosting ends, and by tests.</summary>
    public void Clear()
    {
        lock (_gate)
        {
            Array.Clear(_ring);
            _count = _next = 0;
            _total = _viewerTotal = 0;
            _firstViewerAtUtc = _lastViewerAtUtc = null;
            _logged = _suppressed = 0;
        }
    }

    /// <summary>One report/log line for an arrival. Free of player-identifying data by construction.</summary>
    public static string Describe(ConnectionArrival arrival)
    {
        ArgumentNullException.ThrowIfNull(arrival);
        var text = $"{arrival.AtUtc.ToUniversalTime():O} {arrival.RemoteAddress} GET {arrival.Path} -> {arrival.Outcome}";
        if (arrival.Repeats > 1) text += $" x{arrival.Repeats}";
        if (arrival.VisitId is not null) text += $" visit={arrival.VisitId}";
        if (arrival.PromotedClientId is { } clientId) text += $" client={clientId:N}";
        if (arrival.DeviceLabel is not null) text += $" device=\"{arrival.DeviceLabel}\"";
        return text;
    }

    /// <summary>A fresh 32-character lower-case hex visit id.</summary>
    public static string MintVisitId() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

    /// <summary>
    /// Accept a visit id only in the exact shape we mint. The value arrives from an untrusted browser on the
    /// <c>join</c> message and on a seat's WebSocket query, and it is written into reports and
    /// <c>godot.log</c>: anything but lower-case hex of the right length is dropped rather than sanitised.
    /// </summary>
    public static string? NormalizeVisitId(string? value)
    {
        if (value is null || value.Length != VisitIdLength) return null;
        foreach (var character in value)
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                return null;
        return value;
    }

    private bool TryCoalesceLocked(ConnectionArrival entry, DateTimeOffset now)
    {
        if (_count == 0) return false;
        var slot = SlotLocked(_count - 1);
        if (_ring[slot] is not { } newest) return false;
        if (newest.Outcome != entry.Outcome || newest.Path != entry.Path
            || newest.RemoteAddress != entry.RemoteAddress || newest.VisitId != entry.VisitId
            || now - newest.AtUtc > CoalesceWindow)
            return false;
        _ring[slot] = newest with { AtUtc = now, Repeats = newest.Repeats + 1 };
        return true;
    }

    private void PruneLocked(DateTimeOffset now)
    {
        // Oldest first: the ring is time-ordered, so the first live entry ends the scan.
        while (_count > 0)
        {
            var slot = SlotLocked(0);
            if (_ring[slot] is { } oldest && now - oldest.AtUtc <= VisitRetention) return;
            _ring[slot] = null;
            _count--;
        }
    }

    private int SlotLocked(int indexFromOldest)
        => (_next - _count + indexFromOldest + MaximumRetainedArrivals * 2) % MaximumRetainedArrivals;

    private void Emit(ConnectionArrival arrival)
    {
        int suppressed;
        lock (_gate)
        {
            var nowMs = _time.GetUtcNow().ToUnixTimeMilliseconds();
            if (nowMs - _logWindowStartMs >= (long)LogWindow.TotalMilliseconds)
            {
                _logWindowStartMs = nowMs;
                _logged = 0;
                _suppressed = 0;
            }

            if (_logged >= LogBudgetPerWindow)
            {
                _suppressed++;
                suppressed = _suppressed;
            }
            else
            {
                _logged++;
                suppressed = 0;
            }
        }

        if (suppressed == 0)
        {
            _log("arrival " + Describe(arrival));
            return;
        }

        // One notice per throttle interval, keyed by a CONSTANT: nothing here may be keyed by anything a
        // caller controls.
        _throttleNotice.Write("arrival-log-throttled",
            $"arrival log throttled — {suppressed} further arrival(s) this minute were not logged");
    }

    private static string DescribeAddress(IPAddress? address)
        => address is null || address.Equals(IPAddress.None) || address.Equals(IPAddress.IPv6None)
            ? "unknown"
            : address.ToString();

    /// <summary>
    /// The recorded path: never a query string (that is where <c>?name=</c> rides), never a control
    /// character, never longer than <see cref="MaximumPathLength"/>.
    /// </summary>
    private static string CleanPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "/";
        var question = path.IndexOf('?', StringComparison.Ordinal);
        var withoutQuery = question >= 0 ? path[..question] : path;
        var fragment = withoutQuery.IndexOf('#', StringComparison.Ordinal);
        if (fragment >= 0) withoutQuery = withoutQuery[..fragment];
        if (withoutQuery.Length == 0) return "/";
        if (withoutQuery.Length > MaximumPathLength) withoutQuery = withoutQuery[..MaximumPathLength] + "…";
        return new string(withoutQuery.Select(character => char.IsControl(character) ? ' ' : character).ToArray());
    }

    private static string CleanOutcome(string? outcome)
    {
        if (string.IsNullOrWhiteSpace(outcome)) return "unknown";
        var trimmed = outcome.Trim();
        if (trimmed.Length > 32) trimmed = trimmed[..32];
        return new string(trimmed.Select(character => char.IsLetterOrDigit(character) || character == '-' ? character : '-').ToArray());
    }

    /// <summary>
    /// The shipped sink. Console.Error keeps the line where a terminal-attached run can see it;
    /// <see cref="CouchCoopLog"/> is the half that reaches <c>godot.log</c> in the Steam flow, which is the
    /// artifact a maintainer reads after the fact.
    /// </summary>
    private static void DefaultLog(string message)
    {
        CouchCoopLog.Stderr(message);
        CouchCoopLog.Info(message);
    }

    /// <summary>
    /// Memoised, budgeted user-agent parsing. <see cref="ConnectionDeviceLabel.FromUserAgent"/> runs a full
    /// device-detection pass; once per WebSocket was free, once per HTTP request is not. Capacity-bounded
    /// (cleared wholesale on overflow — crude, but it cannot grow) and capped at
    /// <see cref="ParseBudgetPerWindow"/> parses a minute, after which unseen agents record with no label.
    /// </summary>
    private sealed class DeviceLabelCache
    {
        private const int Capacity = 32;
        private const int ParseBudgetPerWindow = 16;
        private const long WindowMs = 60_000;
        private readonly object _gate = new();
        private readonly Dictionary<string, string?> _labels = new(StringComparer.Ordinal);
        private long _windowStartMs = Environment.TickCount64;
        private int _parses;

        public string? Resolve(string? userAgent)
        {
            if (string.IsNullOrWhiteSpace(userAgent) || userAgent.Length > 2048) return null;
            lock (_gate)
            {
                if (_labels.TryGetValue(userAgent, out var cached)) return cached;
                var now = Environment.TickCount64;
                if (now - _windowStartMs >= WindowMs)
                {
                    _windowStartMs = now;
                    _parses = 0;
                }

                if (_parses >= ParseBudgetPerWindow) return null;
                _parses++;
            }

            var label = ConnectionDeviceLabel.FromUserAgent(userAgent);
            lock (_gate)
            {
                if (_labels.Count >= Capacity) _labels.Clear();
                _labels[userAgent] = label;
            }

            return label;
        }
    }
}
