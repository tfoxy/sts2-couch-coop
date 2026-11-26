namespace CouchCoop.Mod.Runtime;

/// <summary>Optional features fail independently and leave one process-wide compatibility record.</summary>
internal sealed class CouchCoopFeatureCompatibility(Action<string> log)
{
    // Set by the loader when it attempts a payload on a newer game build.
    internal const string UntestedGameVersionKey = "CouchCoop.UntestedGameVersion";

    private readonly object _gate = new();
    private readonly List<string> _disabled = [];

    internal bool TryFeature(string name, Action feature)
    {
        try
        {
            feature();
            return true;
        }
        catch (Exception exception)
        {
            DisableFeature(name, exception);
            return false;
        }
    }

    internal void DisableFeature(string name, Exception exception)
        => DisableFeature(name, $"{exception.GetType().Name}: {exception.Message}");

    internal void DisableFeature(string name, string reason)
    {
        lock (_gate)
        {
            if (_disabled.Contains(name, StringComparer.Ordinal)) return;
            _disabled.Add(name);
        }
        Write($"feature-disabled name={name} reason={reason}");
    }

    internal string Summary(string? game, string payload, bool untested)
    {
        lock (_gate)
            return $"compat-summary game={(string.IsNullOrWhiteSpace(game) ? "<undetected>" : game)} payload={payload} "
                + $"untested={untested.ToString().ToLowerInvariant()} disabled=[{string.Join(",", _disabled)}]";
    }

    internal void ReportSummary(string? game, string payload, bool untested)
        => Write(Summary(game, payload, untested));

    private void Write(string message)
    {
        try { log(message); }
        catch (Exception) { } // Diagnostics cannot prevent the next feature from starting.
    }
}
