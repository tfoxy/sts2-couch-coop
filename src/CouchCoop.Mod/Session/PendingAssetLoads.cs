using System.Threading;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>Tracks load-task lifetimes without changing their result, cancellation, or scheduling.</summary>
internal sealed class PendingAssetLoads
{
    private int _pending;

    internal bool HasPendingLoads => Volatile.Read(ref _pending) > 0;

    // The returned task only observes the end of this registration; the game keeps its original task.
    internal Task Track(Task task)
    {
        if (task.IsCompleted) return Task.CompletedTask;

        Interlocked.Increment(ref _pending);
        try
        {
            return task.ContinueWith(
                static (_, state) => Interlocked.Decrement(ref ((PendingAssetLoads)state!)._pending),
                this,
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
        catch
        {
            Interlocked.Decrement(ref _pending);
            throw;
        }
    }
}
