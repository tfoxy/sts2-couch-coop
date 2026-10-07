using System.Diagnostics;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.Mod.Audio;

namespace CouchCoop.Mod.Audio.Delivery;

/// <summary>A demand-owned sender; its only wait is armed by a queued media block.</summary>
public sealed class DeadlineSender : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly List<(AudioFrame Frame, byte[] Pcm)> pending = [];
    private const int MaxQueuedBytes = 2 * 48_000 * 2 * 2 * 2;
    private int queuedBytes;
    private bool disposed;
    private readonly SemaphoreSlim changed = new(0, 1);
    private readonly CancellationTokenSource stop = new();
    private readonly Task worker;
    private readonly Func<ulong> now;
    private readonly Func<byte[], CancellationToken, Task> send;

    public DeadlineSender(Func<byte[], CancellationToken, Task> send, Func<ulong>? clock = null)
    {
        this.send = send;
        now = clock ?? HostMicroseconds;
        worker = Task.Run(RunAsync);
    }

    public static ulong HostMicroseconds()
    {
        ulong ticks = (ulong)Stopwatch.GetTimestamp(), frequency = (ulong)Stopwatch.Frequency;
        return ticks / frequency * 1_000_000 + ticks % frequency * 1_000_000 / frequency;
    }
    internal int Queued { get { lock (gate) return pending.Count; } }

    public void Enqueue(AudioFrame frame, byte[] pcm)
    {
        lock (gate)
        {
            if (disposed || stop.IsCancellationRequested) return;
            pending.Add((frame, pcm));
            queuedBytes += pcm.Length + AudioFrame.HeaderSize;
            pending.Sort((a, b) => a.Frame.DueUs.CompareTo(b.Frame.DueUs));
            // A stalled receiver cannot pin more than two seconds of media. Prefer preserving
            // first-sight takes over the oldest continuous-lane block.
            while (pending.Count > 1 && (queuedBytes > MaxQueuedBytes ||
                pending[^1].Frame.DueUs - pending[0].Frame.DueUs > 2_000_000))
            {
                int victim = pending.FindIndex(x => x.Frame.Kind == AudioFrameKind.Lane);
                queuedBytes -= pending[victim < 0 ? 0 : victim].Pcm.Length + AudioFrame.HeaderSize;
                pending.RemoveAt(victim < 0 ? 0 : victim);
            }
        }
        Wake();
    }

    private async Task RunAsync()
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                (AudioFrame Frame, byte[] Pcm) next;
                lock (gate) next = pending.Count == 0 ? default : pending[0];
                if (next.Pcm is null) { await changed.WaitAsync(stop.Token).ConfigureAwait(false); continue; }
                ulong current = now();
                if (next.Frame.DueUs > current + 100_000)
                {
                    var delay = TimeSpan.FromMicroseconds(Math.Min(next.Frame.DueUs - current - 100_000, 2_000_000));
                    await changed.WaitAsync(delay, stop.Token).ConfigureAwait(false);
                    continue;
                }
                lock (gate)
                {
                    if (pending.Count == 0 || pending[0].Frame != next.Frame) continue;
                    pending.RemoveAt(0);
                    queuedBytes -= next.Pcm.Length + AudioFrame.HeaderSize;
                }
                await send((next.Frame with { SentUs = now() }).Encode(next.Pcm), stop.Token).ConfigureAwait(false);
                if (AudioDiagnostics.Enabled && next.Frame.Kind == AudioFrameKind.Lane)
                    AudioDiagnostics.Emit($"lane-block lane={(int)next.Frame.Lane} index={next.Frame.BlockIndex} dueUs={next.Frame.DueUs} sentUs={now()}");
            }
        }
        catch (OperationCanceledException) { }
    }

    public async ValueTask DisposeAsync()
    {
        lock (gate) disposed = true;
        stop.Cancel();
        Wake();
        try { await worker.ConfigureAwait(false); } catch (Exception) { /* connection teardown */ }
        stop.Dispose();
        changed.Dispose();
    }

    private void Wake()
    {
        try { changed.Release(); }
        catch (SemaphoreFullException) { }
        catch (ObjectDisposedException) { }
    }
}
