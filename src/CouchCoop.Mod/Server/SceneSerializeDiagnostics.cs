using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Server;

// The log lines for scene frames that could not be serialized as they were (SceneDeltaSafeSerializer). A bad node
// can fail on every frame for as long as it exists, on every connection, so each node id is rate-limited on its
// own: the first occurrence is written at once, later ones at most once per interval with the count suppressed
// in between. One shared instance per process, so N viewers of the same scene do not write N copies.
internal sealed class SceneSerializeDiagnostics(Action<string> write, TimeSpan? interval = null, Func<long>? clockMs = null)
{
    // Bounds the table if ids churn (each scene node has its own); clearing it costs at most a repeated line.
    private const int MaxTrackedKeys = 512;
    private readonly object _gate = new();
    private readonly Dictionary<string, (long LastMs, int Suppressed)> _entries = new(StringComparer.Ordinal);
    private readonly long _intervalMs = (long)(interval ?? TimeSpan.FromSeconds(10)).TotalMilliseconds;
    private readonly Func<long> _clockMs = clockMs ?? (() => Environment.TickCount64);

    public static SceneSerializeDiagnostics Shared { get; } = new(CouchCoopLog.Warn);

    // Writes `message` (with the count suppressed since the last line for this key) unless this key was written
    // within the interval, in which case it is only counted. The message is built only when it is written.
    public void Write(string key, Func<string> message)
    {
        int suppressed;
        lock (_gate)
        {
            var now = _clockMs();
            if (_entries.TryGetValue(key, out var entry) && now - entry.LastMs < _intervalMs)
            {
                _entries[key] = entry with { Suppressed = entry.Suppressed + 1 };
                return;
            }

            if (_entries.Count >= MaxTrackedKeys && !_entries.ContainsKey(key))
            {
                _entries.Clear();
            }

            suppressed = entry.Suppressed;
            _entries[key] = (now, 0);
        }

        write(suppressed > 0 ? $"{message()} (+{suppressed} suppressed)" : message());
    }

    // One line per quarantined / sanitized node and per dropped hint, plus one for a frame that failed outright.
    // `describePath` names a node from the retained scene for the reader; it may return null.
    public void Report(SceneDeltaSerializeResult result, bool keyframe, Func<string, string?> describePath)
    {
        if (!result.HasFaults)
        {
            return;
        }

        var frame = keyframe ? "keyframe" : "delta";
        foreach (var fault in result.Quarantined)
        {
            var id = fault.Node.Id;
            var held = result.Held.Count;
            Write("quarantine:" + id, () =>
                $"[scene] quarantined node {id} ({describePath(id) ?? fault.Node.Name ?? "?"}) from a {frame}: "
                + $"{fault.Exception.GetType().Name}: {fault.Exception.Message}; re-queued"
                + (held > 0 ? $", holding {held} child node(s) with it" : string.Empty));
        }

        foreach (var id in result.SanitizedIds)
        {
            Write("sanitized:" + id, () =>
                $"[scene] node {id} ({describePath(id) ?? "?"}) carried a non-finite number; sent it as 0 in a {frame}");
        }

        foreach (var hint in result.DroppedHints)
        {
            Write("hint:" + hint.TargetId, () =>
                $"[scene] dropped a {hint.Kind} for node {hint.TargetId} ({describePath(hint.TargetId) ?? "?"}): "
                + $"{hint.Exception.GetType().Name}: {hint.Exception.Message}");
        }

        if (result.Failure is { } failure)
        {
            Write("frame", () =>
                $"[scene] could not serialize a scene {frame} even after quarantining its nodes: "
                + $"{failure.GetType().Name}: {failure.Message}");
        }
    }
}
