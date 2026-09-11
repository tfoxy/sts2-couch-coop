// The off-main-thread scene-delta parse worker. Raw UTF-8 packet bytes go IN (Enqueue), fully-parsed MirrorDeltas
// come OUT in FIFO order (TryRead / DrainAllBlocking). A single background Task consumes the raw channel, runs
// CouchCoop.MirrorProtocol.SceneDeltaReader.Parse (the cost — a multi-MB keyframe — must not stall the render
// loop), and pushes results onto a bounded channel so the main thread applies them at its own pace. A parse that
// returns null (non-scene-delta / malformed) is logged and skipped, preserving order for everything else.

using System;
using System.Threading.Channels;
using System.Threading.Tasks;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Net;

public sealed class SceneDeltaParsePipeline : IDisposable
{
    private readonly Channel<byte[]> _raw;
    private readonly Channel<MirrorDelta> _parsed;
    private readonly Task _worker;
    private long _skipped;

    public SceneDeltaParsePipeline(int parsedCapacity = 256)
    {
        // Unbounded IN: the main thread enqueues one array per scene-delta packet and must never block on it.
        _raw = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
        {
            SingleReader = true,  // only the worker reads
            SingleWriter = true,  // only the main thread enqueues
        });
        // Bounded OUT: backpressure — if the main thread stalls, the worker stops parsing ahead (memory bound).
        _parsed = Channel.CreateBounded<MirrorDelta>(new BoundedChannelOptions(parsedCapacity)
        {
            SingleReader = true,  // only the main thread drains
            SingleWriter = true,  // only the worker writes
            FullMode = BoundedChannelFullMode.Wait,
        });
        _worker = Task.Run(WorkerLoopAsync);
    }

    // Number of raw packets the worker parsed to null and dropped (diagnostic).
    public long Skipped => System.Threading.Interlocked.Read(ref _skipped);

    // Parsed deltas waiting in the OUT channel (gauge for the drain-budget telemetry; bounded channels are countable).
    public int PendingParsed => _parsed.Reader.CanCount ? _parsed.Reader.Count : 0;

    // Hand a raw scene-delta packet to the worker (main thread only).
    public void Enqueue(byte[] utf8Packet) => _raw.Writer.TryWrite(utf8Packet);

    // Non-blocking drain of one parsed delta (the live per-frame path).
    public bool TryRead(out MirrorDelta delta) => _parsed.Reader.TryRead(out delta!);

    // Signal that no more packets will be enqueued (replay teardown).
    public void CompleteInput() => _raw.Writer.TryComplete();

    // Blocking drain used by the file-fed replay path: applies everything the worker produces, blocking the
    // calling thread until the parsed channel is completed AND empty. Reads concurrently with the worker so the
    // bounded channel never deadlocks (unlike await-then-drain, which would wedge past `parsedCapacity` items).
    public void DrainAllBlocking(Action<MirrorDelta> apply)
    {
        while (_parsed.Reader.WaitToReadAsync().AsTask().GetAwaiter().GetResult())
        {
            while (_parsed.Reader.TryRead(out var delta))
            {
                apply(delta);
            }
        }
    }

    private async Task WorkerLoopAsync()
    {
        try
        {
            await foreach (var bytes in _raw.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                MirrorDelta? delta;
                try
                {
                    delta = SceneDeltaReader.Parse(bytes);
                }
                catch (Exception e)
                {
                    System.Threading.Interlocked.Increment(ref _skipped);
                    GD.PrintErr($"SceneDeltaParsePipeline: parse threw, skipping packet: {e.Message}");
                    continue;
                }

                if (delta is null)
                {
                    // Non-scene-delta or unparseable — log+skip, preserving order for the rest.
                    System.Threading.Interlocked.Increment(ref _skipped);
                    continue;
                }

                await _parsed.Writer.WriteAsync(delta).ConfigureAwait(false);
            }
        }
        finally
        {
            _parsed.Writer.TryComplete();
        }
    }

    public void Dispose()
    {
        _raw.Writer.TryComplete();
    }
}
