using System.Collections.Concurrent;

namespace CouchCoop.Mod.Server;

internal sealed class RateLimitedDiagnosticLog(Action<string> write, TimeSpan? interval = null)
{
    private readonly ConcurrentDictionary<string, long> _last = new(StringComparer.Ordinal);
    private readonly long _intervalMs = (long)(interval ?? TimeSpan.FromSeconds(30)).TotalMilliseconds;

    public void Write(string code, string message)
    {
        var now = Environment.TickCount64;
        while (true)
        {
            var previous = _last.GetValueOrDefault(code, long.MinValue);
            if (previous != long.MinValue && now - previous < _intervalMs) return;
            if (previous == long.MinValue
                ? _last.TryAdd(code, now)
                : _last.TryUpdate(code, now, previous))
            {
                write(message);
                return;
            }
        }
    }
}
