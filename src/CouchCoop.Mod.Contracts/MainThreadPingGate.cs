namespace CouchCoop.Mod.Contracts;

/// <summary>
/// Bounds deferred main-thread ping callbacks both per connection and across hot-reload generations.
/// A reservation remains held until the queued callback actually runs (or scheduling throws).
/// </summary>
public sealed class MainThreadPingGate
{
    public const int MaxProcessOutstanding = 128;

    private static int _processOutstanding;
    private int _connectionOutstanding;

    public bool TryBegin()
    {
        if (Interlocked.CompareExchange(ref _connectionOutstanding, 1, 0) != 0)
        {
            return false;
        }

        while (true)
        {
            var outstanding = Volatile.Read(ref _processOutstanding);
            if (outstanding >= MaxProcessOutstanding)
            {
                Volatile.Write(ref _connectionOutstanding, 0);
                return false;
            }

            if (Interlocked.CompareExchange(ref _processOutstanding, outstanding + 1, outstanding) == outstanding)
            {
                return true;
            }
        }
    }

    public void Complete()
    {
        if (Interlocked.Exchange(ref _connectionOutstanding, 0) != 0)
        {
            Interlocked.Decrement(ref _processOutstanding);
        }
    }
}
