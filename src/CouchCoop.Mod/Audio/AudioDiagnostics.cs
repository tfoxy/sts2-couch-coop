using CouchCoop.Mod.Session;
using System.Diagnostics;

namespace CouchCoop.Mod.Audio;

/// <summary>Opt-in, event-driven counters for the audio live-QA leg.</summary>
public static class AudioDiagnostics
{
    public static readonly bool Enabled = Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO_DIAG") == "1";
    private const int Capacity = 8192;
    private const int MaxMarks = 100_000;
    private static readonly object traceGate = new();
    private static readonly object emitGate = new();
    private static readonly Mark[]? marks = Enabled ? new Mark[Capacity] : null;
    private static int markCount;
    private static long accepted, lost, reportedLost, nextLossReport = 1, nextConnection;
    private static int flushQueued;
    public readonly record struct Mark(string Stage, ulong TUs, long Conn = 0, long SeatTUs = 0,
        string? KeyId = null, string? Path = null, uint Stream = 0, int Lane = 0, uint Block = 0,
        ulong DueUs = 0, ulong SentUs = 0, long Order = 0, int Depth = 0);

    public static long ConnectionId() => Enabled ? Interlocked.Increment(ref nextConnection) : 0;
    public static ulong NowUs()
    {
        ulong ticks = (ulong)Stopwatch.GetTimestamp(), frequency = (ulong)Stopwatch.Frequency;
        return ticks / frequency * 1_000_000 + ticks % frequency * 1_000_000 / frequency;
    }

    // A fixed buffer keeps sound prefixes and render callbacks free of diagnostic allocations/log I/O.
    // Socket and worker continuations flush it after leaving those callbacks.
    public static void Trace(in Mark mark)
    {
        if (!Enabled) return;
        lock (traceGate)
        {
            if (accepted >= MaxMarks || markCount == Capacity) { lost++; return; }
            marks![markCount++] = mark;
            accepted++;
        }
    }

    public static void Flush() => FlushCore(final: false);

    // Called during connection teardown and after the deadline worker stops. This reports
    // the exact loss count at that boundary even between exponential thresholds.
    public static void FlushFinal() => FlushCore(final: true);

    private static void FlushCore(bool final)
    {
        if (!Enabled) return;
        lock (emitGate) FlushLocked(final);
    }

    private static void FlushLocked(bool final)
    {
        Mark[] batch;
        long loss, lossTotal, acceptedTotal;
        lock (traceGate)
        {
            bool reportLoss = lost > reportedLost && (final || lost >= nextLossReport);
            if (markCount == 0 && !reportLoss && !final) return;
            batch = new Mark[markCount];
            Array.Copy(marks!, batch, markCount);
            Array.Clear(marks!, 0, markCount);
            markCount = 0;
            loss = reportLoss ? lost - reportedLost : 0;
            lossTotal = lost;
            acceptedTotal = accepted;
            if (loss != 0)
            {
                reportedLost = lost;
                while (nextLossReport <= lost && nextLossReport < long.MaxValue / 2)
                    nextLossReport *= 2;
            }
        }
        foreach (var m in batch)
            Emit($"stage={m.Stage} tUs={m.TUs} conn={m.Conn} seatTUs={m.SeatTUs} keyId={m.KeyId ?? "-"} path={Uri.EscapeDataString(m.Path ?? "-")} stream={m.Stream} lane={m.Lane} block={m.Block} dueUs={m.DueUs} sentUs={m.SentUs} order={m.Order} depth={m.Depth}");
        if (loss != 0) Emit($"stage=loss count={loss} total={lossTotal} accepted={acceptedTotal}");
        if (final) Emit($"stage=seal lost={lossTotal} accepted={acceptedTotal}");
    }

    // Schedule only from socket/worker continuations, never a native sound callback.
    public static void RequestFlush()
    {
        if (!Enabled || Interlocked.CompareExchange(ref flushQueued, 1, 0) != 0) return;
        ThreadPool.UnsafeQueueUserWorkItem(static _ =>
        {
            try
            {
                while (true)
                {
                    Flush();
                    lock (traceGate)
                    {
                        if (markCount != 0 || lost >= nextLossReport) continue;
                        Volatile.Write(ref flushQueued, 0);
                        break;
                    }
                }
            }
            catch
            {
                Volatile.Write(ref flushQueued, 0);
                // Diagnostics must never affect audio delivery.
            }
        }, null);
    }
    private static long takeHttpRequests;
    private static long takeRenders;

    public static long TakeHttpRequests => Interlocked.Read(ref takeHttpRequests);
    public static long TakeRenders => Interlocked.Read(ref takeRenders);

    public static void TakeHttp()
    {
        Interlocked.Increment(ref takeHttpRequests);
        Emit("take-http");
    }

    public static void TakeRendered(int frames, int firstBlockUs)
    {
        Interlocked.Increment(ref takeRenders);
        Emit($"take-render frames={frames} firstBlockUs={firstBlockUs}");
    }

    public static void Emit(string detail)
    {
        if (Enabled) CouchCoopLog.Info("[audio-diag] " + detail);
    }
}
