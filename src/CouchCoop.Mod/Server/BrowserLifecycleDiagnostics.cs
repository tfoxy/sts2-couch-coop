using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CouchCoop.Mod.Server;

/// <summary>Opt-in, schema-bound lifecycle evidence for the synthetic browser harness.</summary>
/// <remarks>
/// The route and page metadata exist only when the harness supplies a diagnostics directory. The accepted
/// schema deliberately has no field for a URL, query value, name, payload, stack, user agent, token, or free-form
/// message. A rejected value is never partially persisted.
/// </remarks>
public sealed class BrowserLifecycleDiagnostics
{
    public const string Route = "/__couchcoop/lifecycle";
    public const string WebSocketVisitSelector = "diagnosticVisit";
    public const int MaximumRequestBytes = 16 * 1024;
    public const int MaximumEventsPerBatch = 32;
    public const int MaximumBatchesPerVisit = 16;
    public const int MaximumVisits = 256;
    public const long MaximumFileBytes = 1024 * 1024;
    private const int MaximumRelativeTimeMs = 30 * 60 * 1000;
    private static readonly TimeSpan VisitLifetime = TimeSpan.FromMinutes(30);
    private static readonly ConcurrentDictionary<string, object> ProcessFileLocks = new(StringComparer.Ordinal);

    private readonly string _path;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<long> _monotonicMilliseconds;
    private readonly object _writeGate;
    private readonly BrowserLifecycleWorkloadSnapshot? _workload;
    private readonly object _visitGate = new();
    private readonly ConcurrentDictionary<string, Visit> _visits = new(StringComparer.Ordinal);
    private int _nextVisit;

    public BrowserLifecycleDiagnostics(
        string artifactDirectory,
        Func<DateTimeOffset>? utcNow = null,
        Func<long>? monotonicMilliseconds = null,
        BrowserLifecycleWorkloadSnapshot? workload = null)
    {
        if (string.IsNullOrWhiteSpace(artifactDirectory))
            throw new ArgumentException("An artifact directory is required.", nameof(artifactDirectory));

        var fullDirectory = Path.GetFullPath(artifactDirectory);
        Directory.CreateDirectory(fullDirectory);
        _path = Path.Combine(fullDirectory, "browser-lifecycle.jsonl");
        _writeGate = ProcessFileLocks.GetOrAdd(_path, static _ => new object());
        _now = utcNow ?? (() => DateTimeOffset.UtcNow);
        _monotonicMilliseconds = monotonicMilliseconds ?? (() => Environment.TickCount64);
        _workload = workload;
    }

    /// <summary>A same-origin config tag. The filesystem directory and visit ordinal never reach the page.</summary>
    public string BeginVisitMeta()
    {
        string nonce;
        lock (_visitGate)
        {
            Prune();
            if (_visits.Count >= MaximumVisits) return string.Empty;

            do nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            while (_visits.ContainsKey(nonce));
            var visit = new Visit(
                Interlocked.Increment(ref _nextVisit),
                _now(),
                _monotonicMilliseconds());
            if (!_visits.TryAdd(nonce, visit)) return string.Empty;
        }

        var json = JsonSerializer.Serialize(new { endpoint = Route, nonce });
        return $"<meta name=\"couchcoop-lifecycle\" content=\"{Convert.ToBase64String(Encoding.UTF8.GetBytes(json))}\" />";
    }

    /// <summary>Accept one browser batch after validating the complete batch and its checkpoint sequence.</summary>
    public bool TryAccept(string? body)
    {
        if (body is null || Encoding.UTF8.GetByteCount(body) > MaximumRequestBytes) return false;

        try
        {
            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !Only(root, "nonce", "events")) return false;
            if (!root.TryGetProperty("nonce", out var nonceValue)
                || nonceValue.ValueKind != JsonValueKind.String
                || !IsNonce(nonceValue.GetString(), out var nonce)
                || !_visits.TryGetValue(nonce, out var visit)) return false;
            if (_now() - visit.Created > VisitLifetime) return false;
            if (!root.TryGetProperty("events", out var events)
                || events.ValueKind != JsonValueKind.Array
                || events.GetArrayLength() > MaximumEventsPerBatch) return false;

            var accepted = new List<LifecycleEvent>(events.GetArrayLength());
            foreach (var item in events.EnumerateArray())
            {
                if (!TryParseEvent(item, out var parsed)) return false;
                accepted.Add(parsed);
            }

            lock (visit.Gate)
            {
                if (_now() - visit.Created > VisitLifetime
                    || visit.Batches >= MaximumBatchesPerVisit
                    || !visit.HasBatchToken(_monotonicMilliseconds())) return false;
                if (!visit.TryPlan(accepted, out var plan)) return false;
                if (!AppendBatch(visit, accepted)) return false;
                visit.Commit(plan, _monotonicMilliseconds());
                return true;
            }
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// Record a server-observed socket transition for the visit nonce carried only in the WebSocket query.
    /// The query value is resolved to the non-sensitive ordinal and is never written.
    /// </summary>
    public void RecordSocketEvent(string? nonce, string role, string state, int? closeCode = null, bool? clean = null)
    {
        if (!IsNonce(nonce, out var normalized)
            || !_visits.TryGetValue(normalized, out var visit)
            || _now() - visit.Created > VisitLifetime
            || role is not ("host" or "seat")
            || state is not ("open" or "error" or "close")) return;

        var elapsed = (int)Math.Clamp(
            _monotonicMilliseconds() - visit.CreatedMonotonicMilliseconds,
            0,
            MaximumRelativeTimeMs);
        var item = state switch
        {
            "open" => new LifecycleEvent(elapsed, "ws-open", Role: role),
            "error" => new LifecycleEvent(elapsed, "ws-error", Role: role, Category: "transport"),
            _ => new LifecycleEvent(elapsed, "ws-close", Role: role,
                Code: closeCode is >= 1000 and <= 4999 ? closeCode : null,
                Clean: clean),
        };
        lock (visit.Gate)
            AppendBatch(visit, [item]);
    }

    /// <summary>
    /// Payload-free counters/booleans for one browser visit. A nonce is deliberately required here: combining
    /// arrivals makes a later reload look like the journey that presented the first frame.
    /// </summary>
    public object Summary(string? nonce)
    {
        if (!IsNonce(nonce, out var normalized) || !_visits.TryGetValue(normalized, out var visit))
            return SummarySnapshot.Empty;
        lock (visit.Gate) return visit.Summary(_workload);
    }

    private bool AppendBatch(Visit visit, IReadOnlyList<LifecycleEvent> events)
    {
        if (events.Count == 0) return true;

        var batch = new StringBuilder();
        foreach (var item in events)
            batch.Append(JsonSerializer.Serialize(PersistedEvent(visit.Ordinal, item))).Append('\n');
        var bytes = Encoding.UTF8.GetBytes(batch.ToString());

        // One process-local lock and one FileStream.Write call per accepted batch. A reader can see either the
        // old file or the complete batch, never records interleaved by simultaneous HTTP/socket observations.
        lock (_writeGate)
        {
            using var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read);
            if (stream.Length + bytes.Length > MaximumFileBytes) return false;
            stream.Write(bytes);
            foreach (var item in events) visit.UpdateSummary(item);
            return true;
        }
    }

    private static Dictionary<string, object> PersistedEvent(int visit, LifecycleEvent item)
    {
        var result = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["visit"] = visit,
            ["t"] = item.TimeMs,
            ["kind"] = item.Kind,
        };
        if (item.State is not null) result["state"] = item.State;
        if (item.Role is not null) result["role"] = item.Role;
        if (item.Width is not null) result["width"] = item.Width.Value;
        if (item.Height is not null) result["height"] = item.Height.Value;
        if (item.Active is not null) result["active"] = item.Active.Value;
        if (item.Category is not null) result["category"] = item.Category;
        if (item.Ordinal is not null) result["ordinal"] = item.Ordinal.Value;
        if (item.Code is not null) result["code"] = item.Code.Value;
        if (item.Clean is not null) result["clean"] = item.Clean.Value;
        return result;
    }

    private static bool TryParseEvent(JsonElement item, out LifecycleEvent parsed)
    {
        parsed = default;
        if (item.ValueKind != JsonValueKind.Object
            || !item.TryGetProperty("t", out var t)
            || !t.TryGetInt32(out var time)
            || time < 0
            || time > MaximumRelativeTimeMs
            || !item.TryGetProperty("kind", out var kindValue)
            || kindValue.ValueKind != JsonValueKind.String) return false;

        var kind = kindValue.GetString();
        switch (kind)
        {
            case "lifecycle":
                return StateEvent(item, time, kind, ["load", "pageshow", "pagehide", "navigation"], out parsed);
            case "visibility":
                return StateEvent(item, time, kind, ["visible", "hidden"], out parsed);
            case "orientation":
                return StateEvent(item, time, kind, ["portrait", "landscape"], out parsed);
            case "viewport":
                if (!Only(item, "t", "kind", "width", "height")
                    || !item.TryGetProperty("width", out var width)
                    || !width.TryGetInt32(out var widthValue)
                    || !item.TryGetProperty("height", out var height)
                    || !height.TryGetInt32(out var heightValue)
                    || widthValue is < 1 or > 32768
                    || heightValue is < 1 or > 32768) return false;
                parsed = new LifecycleEvent(time, kind, Width: widthValue, Height: heightValue);
                return true;
            case "fullscreen":
                if (!Only(item, "t", "kind", "active")
                    || !item.TryGetProperty("active", out var active)
                    || active.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
                parsed = new LifecycleEvent(time, kind, Active: active.GetBoolean());
                return true;
            case "ws-open":
                return SocketEvent(item, time, kind, requireCategory: false, allowClose: false, out parsed);
            case "ws-error":
                return SocketEvent(item, time, kind, requireCategory: true, allowClose: false, out parsed);
            case "ws-close":
                return SocketEvent(item, time, kind, requireCategory: false, allowClose: true, out parsed);
            case "error":
                if (!Only(item, "t", "kind", "category")
                    || !TryString(item, "category", ["runtime", "exception", "transport", "render"], out var category)) return false;
                parsed = new LifecycleEvent(time, kind, Category: category);
                return true;
            case "scene-received":
            case "render-begin":
            case "frame-presented":
            case "ack-sent":
                if (!Only(item, "t", "kind", "ordinal")
                    || !item.TryGetProperty("ordinal", out var ordinal)
                    || !ordinal.TryGetInt32(out var ordinalValue)
                    || ordinalValue is < 1 or > 1_000_000) return false;
                parsed = new LifecycleEvent(time, kind, Ordinal: ordinalValue);
                return true;
            default:
                return false;
        }
    }

    private static bool StateEvent(
        JsonElement item,
        int time,
        string kind,
        string[] allowed,
        out LifecycleEvent parsed)
    {
        parsed = default;
        if (!Only(item, "t", "kind", "state") || !TryString(item, "state", allowed, out var state)) return false;
        parsed = new LifecycleEvent(time, kind, State: state);
        return true;
    }

    private static bool SocketEvent(
        JsonElement item,
        int time,
        string kind,
        bool requireCategory,
        bool allowClose,
        out LifecycleEvent parsed)
    {
        parsed = default;
        var allowedFields = allowClose
            ? new[] { "t", "kind", "role", "code", "clean" }
            : requireCategory
                ? new[] { "t", "kind", "role", "category" }
                : new[] { "t", "kind", "role" };
        if (!Only(item, allowedFields) || !TryString(item, "role", ["host", "seat"], out var role)) return false;

        if (requireCategory)
        {
            if (!TryString(item, "category", ["transport"], out var category)) return false;
            parsed = new LifecycleEvent(time, kind, Role: role, Category: category);
            return true;
        }

        int? code = null;
        bool? clean = null;
        if (allowClose)
        {
            if (item.TryGetProperty("code", out var codeValue))
            {
                if (!codeValue.TryGetInt32(out var closeCode) || closeCode is < 1000 or > 4999) return false;
                code = closeCode;
            }
            if (item.TryGetProperty("clean", out var cleanValue))
            {
                if (cleanValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
                clean = cleanValue.GetBoolean();
            }
        }
        parsed = new LifecycleEvent(time, kind, Role: role, Code: code, Clean: clean);
        return true;
    }

    private static bool TryString(
        JsonElement item,
        string name,
        string[] allowed,
        out string value)
    {
        value = string.Empty;
        if (!item.TryGetProperty(name, out var raw) || raw.ValueKind != JsonValueKind.String) return false;
        value = raw.GetString() ?? string.Empty;
        return allowed.Contains(value);
    }

    private void Prune()
    {
        var cutoff = _now() - VisitLifetime;
        foreach (var (nonce, visit) in _visits)
            if (visit.Created < cutoff) _visits.TryRemove(nonce, out _);
    }

    private static bool IsNonce(string? value, out string normalized)
    {
        normalized = value ?? string.Empty;
        return normalized.Length == 32 && normalized.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    private static bool Only(JsonElement element, params string[] names)
    {
        var allowed = names.ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return element.EnumerateObject().All(property => allowed.Contains(property.Name) && seen.Add(property.Name));
    }

    private sealed class Visit(int ordinal, DateTimeOffset created, long createdMonotonicMilliseconds)
    {
        public int Ordinal { get; } = ordinal;
        public DateTimeOffset Created { get; } = created;
        public long CreatedMonotonicMilliseconds { get; } = createdMonotonicMilliseconds;
        public object Gate { get; } = new();
        public int Batches { get; private set; }
        private double _tokens = 8;
        private long _lastTokenMilliseconds = createdMonotonicMilliseconds;
        private int _lastClientTime = -1;
        private int _checkpointOrdinal;
        private int _checkpointStage;
        private int _sceneAcks;
        private int _presentations;
        private bool _viewError;
        private bool _hostSocketOpen;
        private bool _seatSocketOpen;
        private bool _hostSeen;
        private bool _seatSeen;
        private bool _journeyValid = true;
        private bool _pagehide;
        private bool _navigation;

        public bool HasBatchToken(long now)
        {
            _tokens = Math.Min(8, _tokens + Math.Max(0, now - _lastTokenMilliseconds) * 0.004);
            _lastTokenMilliseconds = now;
            return _tokens >= 1;
        }

        public bool TryPlan(IReadOnlyList<LifecycleEvent> events, out VisitPlan plan)
        {
            var lastTime = _lastClientTime;
            var ordinal = _checkpointOrdinal;
            var stage = _checkpointStage;
            foreach (var item in events)
            {
                if (item.TimeMs < lastTime)
                {
                    plan = default;
                    return false;
                }
                lastTime = item.TimeMs;
                if (item.Ordinal is not { } eventOrdinal) continue;
                var eventStage = CheckpointStage(item.Kind);
                if (eventOrdinal == ordinal + 1 && eventStage == 1)
                {
                    ordinal = eventOrdinal;
                    stage = 1;
                }
                else if (eventOrdinal == ordinal && eventStage == stage + 1)
                {
                    stage = eventStage;
                }
                else
                {
                    plan = default;
                    return false;
                }
            }
            plan = new VisitPlan(lastTime, ordinal, stage);
            return true;
        }

        public void Commit(VisitPlan plan, long now)
        {
            _lastClientTime = plan.LastClientTime;
            _checkpointOrdinal = plan.CheckpointOrdinal;
            _checkpointStage = plan.CheckpointStage;
            _tokens -= 1;
            _lastTokenMilliseconds = now;
            Batches++;
        }

        public void UpdateSummary(LifecycleEvent item)
        {
            if (item.Kind == "ack-sent") _sceneAcks++;
            if (item.Kind == "frame-presented") _presentations++;
            if (item.Kind == "error" && item.Category is "render" or "transport") _viewError = true;

            if (item.Kind == "lifecycle" && item.State is "pagehide" or "navigation")
            {
                _pagehide |= item.State == "pagehide";
                _navigation |= item.State == "navigation";
                if (_presentations > 0) _journeyValid = false;
            }

            if (item.Role == "host") UpdateSocket(ref _hostSocketOpen, ref _hostSeen, item);
            if (item.Role == "seat") UpdateSocket(ref _seatSocketOpen, ref _seatSeen, item);
        }

        private void UpdateSocket(ref bool open, ref bool seen, LifecycleEvent item)
        {
            if (item.Kind == "ws-open")
            {
                if (_presentations > 0 && seen) _journeyValid = false;
                open = true;
                seen = true;
            }
            else if (item.Kind is "ws-close" or "ws-error")
            {
                if (_presentations > 0) _journeyValid = false;
                open = false;
            }
        }

        public SummarySnapshot Summary(BrowserLifecycleWorkloadSnapshot? workload) => new(
            Ordinal,
            Ordinal,
            _sceneAcks,
            _presentations,
            _checkpointOrdinal,
            Math.Clamp(_checkpointStage, 0, 4),
            _pagehide,
            _navigation,
            _viewError,
            SocketState(_hostSeen, _hostSocketOpen),
            SocketState(_seatSeen, _seatSocketOpen),
            _journeyValid,
            workload);

        private static string SocketState(bool seen, bool open) => !seen ? "unseen" : open ? "open" : "closed";

        private static int CheckpointStage(string kind) => kind switch
        {
            "scene-received" => 1,
            "render-begin" => 2,
            "frame-presented" => 3,
            "ack-sent" => 4,
            _ => 0,
        };
    }

    private sealed record SummarySnapshot(
        int visitOrdinal,
        int journeyOrdinal,
        int sceneAcks,
        int presentations,
        int lastCheckpointOrdinal,
        int lastCheckpointStage,
        bool pagehide,
        bool navigation,
        bool viewError,
        string hostSocketState,
        string seatSocketState,
        bool journeyValid,
        BrowserLifecycleWorkloadSnapshot? workload)
    {
        public static readonly SummarySnapshot Empty = new(0, 0, 0, 0, 0, 0, false, false, false, "unseen", "unseen", false, null);
    }

    private readonly record struct VisitPlan(int LastClientTime, int CheckpointOrdinal, int CheckpointStage);
    private readonly record struct LifecycleEvent(
        int TimeMs,
        string Kind,
        string? State = null,
        string? Role = null,
        int? Width = null,
        int? Height = null,
        bool? Active = null,
        string? Category = null,
        int? Ordinal = null,
        int? Code = null,
        bool? Clean = null);
}

/// <summary>Exact synthetic-harness limits, supplied by the harness and never by page input.</summary>
public sealed record BrowserLifecycleWorkloadSnapshot(
    string profile,
    int nodes,
    int text,
    int chars,
    int resources,
    int decodedBytes,
    int maxDimension,
    int keyframes,
    int deltas,
    int expectedMessages);
