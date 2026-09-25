namespace CouchCoop.Mod.Connections;

/// <summary>Combines socket counts from overlapping hot-reload generations without sharing their counters.</summary>
internal sealed class BrowserDemandLedger(Action<int, long> publish)
{
    private readonly object _gate = new();
    private int _total;
    private long _generation;

    public Action<int, long> CreateReporter()
    {
        var previousCount = 0;
        var previousGeneration = -1L;
        return (count, generation) =>
        {
            int total;
            long combinedGeneration;
            lock (_gate)
            {
                if (generation <= previousGeneration) return;
                previousGeneration = generation;
                count = Math.Max(0, count);
                _total += count - previousCount;
                previousCount = count;
                total = _total;
                combinedGeneration = ++_generation;
            }
            // Callbacks may re-enter the host. Its version check handles out-of-order delivery after this lock.
            publish(total, combinedGeneration);
        };
    }
}
