using System.Buffers;
using System.Collections.Concurrent;

namespace CouchCoop.Mod.Audio.Render;

public sealed record RenderedTake(TakeResult Result, byte[] Pcm16);

// A demand-owned worker. Construct it on the first subscriber and dispose it after the last.
public sealed class TakeRenderer : IDisposable
{
    private readonly BlockingCollection<Job> queue = new(new ConcurrentQueue<Job>());
    private readonly Dictionary<string, TaskCompletionSource<RenderedTake>> pending = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly Thread thread;
    private readonly Func<IFmodRenderBackend> backendFactory;
    private Exception? fatal;
    private bool disposed;

    private readonly record struct Job(TakeRequest Request, TaskCompletionSource<RenderedTake> Completion,
        Action<ReadOnlyMemory<byte>, int, bool>? OnBlock);

    public TakeRenderer(Func<IFmodRenderBackend> backendFactory)
    {
        this.backendFactory = backendFactory;
        thread = new Thread(Run) { Name = "CouchCoop audio takes", IsBackground = true };
        thread.Start();
    }

    // Every caller for a cold key receives the same immutable completed take.
    public Task<RenderedTake> RenderAsync(TakeRequest request,
        Action<ReadOnlyMemory<byte>, int, bool>? onBlock = null)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (fatal is not null) return Task.FromException<RenderedTake>(fatal);
            if (pending.TryGetValue(request.KeyId, out var existing)) return existing.Task;
            var completion = new TaskCompletionSource<RenderedTake>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(request.KeyId, completion);
            queue.Add(new Job(request, completion, onBlock));
            return completion.Task;
        }
    }

    private void Run()
    {
        IFmodRenderBackend? backend = null;
        try
        {
            backend = backendFactory();
            foreach (Job job in queue.GetConsumingEnumerable())
            {
                if (disposed) { job.Completion.TrySetCanceled(); continue; }
                try
                {
                    var sink = new CollectingSink(job.OnBlock);
                    TakeResult result = backend.Render(job.Request, sink);
                    job.Completion.TrySetResult(new RenderedTake(result, sink.Written));
                }
                catch (Exception ex) { job.Completion.TrySetException(ex); }
                finally { lock (gate) pending.Remove(job.Request.KeyId); }
            }
        }
        catch (Exception ex)
        {
            lock (gate)
            {
                fatal = ex;
                foreach (var completion in pending.Values) completion.TrySetException(ex);
                pending.Clear();
            }
        }
        finally { backend?.Dispose(); }
    }

    private sealed class CollectingSink(Action<ReadOnlyMemory<byte>, int, bool>? onBlock) : IAudioBlockSink
    {
        private readonly ArrayBufferWriter<byte> writer = new();
        public byte[] Written => writer.WrittenSpan.ToArray();
        public void OnBlock(ReadOnlyMemory<byte> pcm, int blockIndex, bool last)
        {
            writer.Write(pcm.Span);
            onBlock?.Invoke(pcm, blockIndex, last);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            queue.CompleteAdding();
            while (queue.TryTake(out Job job)) job.Completion.TrySetCanceled();
        }
        thread.Join();
        queue.Dispose();
    }
}
