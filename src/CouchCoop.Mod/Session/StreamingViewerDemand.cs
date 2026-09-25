using CouchCoop.Mod.Connections;

namespace CouchCoop.Mod.Session;

/// <summary>Combines scene-stream counts from overlapping browser-server generations.</summary>
internal sealed class StreamingViewerDemand
{
    private readonly object _gate = new();
    private readonly BrowserDemandLedger _ledger;
    private readonly Action? _onPresenceChanged;
    private long _acceptedGeneration;
    private volatile int _count;

    public StreamingViewerDemand(Action? onPresenceChanged = null)
    {
        _onPresenceChanged = onPresenceChanged;
        _ledger = new BrowserDemandLedger(Accept);
    }

    public bool HasViewers => _count > 0;

    public Action<int, long> CreateReporter() => _ledger.CreateReporter();

    internal void Accept(int count, long generation)
    {
        // Ledger callbacks run outside its lock and can arrive in reverse order. An older zero must not
        // park a newer viewer's scans (or an older one revive them after the last viewer leaves).
        bool changed;
        lock (_gate)
        {
            if (generation <= _acceptedGeneration) return;
            changed = (_count > 0) != (count > 0);
            _acceptedGeneration = generation;
            _count = count;
        }

        // A browser worker can publish this update. The owner marshals Godot work to the main thread.
        if (changed) _onPresenceChanged?.Invoke();
    }
}
