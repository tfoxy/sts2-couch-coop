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
        Action<ReadOnlyMemory<byte>, int, bool>? OnBlock, long ConnectionId, uint StreamId);

    public TakeRenderer(Func<IFmodRenderBackend> backendFactory)
    {
        this.backendFactory = backendFactory;
        thread = new Thread(Run) { Name = "CouchCoop audio takes", IsBackground = true };
        thread.Start();
    }

    // Every caller for a cold key receives the same immutable completed take.
    public Task<RenderedTake> RenderAsync(TakeRequest request,
        Action<ReadOnlyMemory<byte>, int, bool>? onBlock = null,
        long diagnosticConnectionId = 0, uint diagnosticStreamId = 0)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (fatal is not null) return Task.FromException<RenderedTake>(fatal);
            if (pending.TryGetValue(request.KeyId, out var existing)) return existing.Task;
            var completion = new TaskCompletionSource<RenderedTake>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending.Add(request.KeyId, completion);
            if (AudioDiagnostics.Enabled)
                AudioDiagnostics.Trace(new AudioDiagnostics.Mark("take-enqueue", AudioDiagnostics.NowUs(),
                    Conn: diagnosticConnectionId, KeyId: request.KeyId, Stream: diagnosticStreamId));
            queue.Add(new Job(request, completion, onBlock, diagnosticConnectionId, diagnosticStreamId));
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
                    if (AudioDiagnostics.Enabled)
                        AudioDiagnostics.Trace(new AudioDiagnostics.Mark("take-render-start", AudioDiagnostics.NowUs(),
                            Conn: job.ConnectionId, KeyId: job.Request.KeyId, Stream: job.StreamId));
                    var sink = new CollectingSink(job.OnBlock, job.ConnectionId, job.StreamId, job.Request.KeyId);
                    TakeResult result = backend.Render(job.Request, sink);
                    if (AudioDiagnostics.Enabled)
                        AudioDiagnostics.Trace(new AudioDiagnostics.Mark("take-render-done", AudioDiagnostics.NowUs(),
                            Conn: job.ConnectionId, KeyId: job.Request.KeyId, Stream: job.StreamId));
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

    private sealed class CollectingSink(Action<ReadOnlyMemory<byte>, int, bool>? onBlock,
        long connectionId, uint streamId, string keyId) : IAudioBlockSink
    {
        private readonly ArrayBufferWriter<byte> writer = new();
        public byte[] Written => writer.WrittenSpan.ToArray();
        public void OnBlock(ReadOnlyMemory<byte> pcm, int blockIndex, bool last)
        {
            if (blockIndex == 0 && AudioDiagnostics.Enabled)
                AudioDiagnostics.Trace(new AudioDiagnostics.Mark("take-first-block", AudioDiagnostics.NowUs(),
                    Conn: connectionId, KeyId: keyId, Stream: streamId, Block: 0));
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
