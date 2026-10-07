using System.Buffers.Binary;
using System.Collections.Concurrent;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Audio.Delivery;
using CouchCoop.Mod.Audio.Render;
using CouchCoop.Mod.Audio.Takes;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Server;
using CouchCoop.MirrorProtocol.Audio;

namespace CouchCoop.Mod.Audio;

/// <summary>Owns private audio systems strictly for the lifetime of render-lane subscribers.</summary>
public sealed class AudioService : IDisposable
{
    private readonly object gate = new();
    private readonly string packagePath;
    private readonly Func<IFmodRenderBackend> backendFactory;
    private readonly bool nativeBackend;
    private readonly TakeCache cache;
    private readonly ConcurrentDictionary<string, InflightTake> pending = new(StringComparer.Ordinal);
    private TakeRenderer[]? renderers;
    private StreamRenderer? streamRenderer;
    private bool streamUnavailable;
    private int laneSubscribers;
    private int subscribers;
    private int outstandingRenders;
    private int generation;
    private bool disposed;
    public string Bankset { get; }
    internal int SubscriberCount { get { lock (gate) return subscribers; } }
    internal bool HasRenderer { get { lock (gate) return renderers is not null; } }
    public event Action<string>? StreamFailed;

    public AudioService(string packagePath)
        : this(packagePath, null, CouchCoopCacheRoot.VersionRoot, CouchCoopCacheRoot.Quota) { }

    internal AudioService(string packagePath, Func<IFmodRenderBackend>? backendFactory = null,
        string? versionRoot = null, ManagedCacheQuota? quota = null, string? banksetOverride = null)
    {
        this.packagePath = packagePath;
        if (banksetOverride is null)
        {
            using var banks = new PckBankSource(packagePath);
            Bankset = banks.BankSetId;
        }
        else Bankset = banksetOverride;
        nativeBackend = backendFactory is null;
        this.backendFactory = backendFactory ?? (() => new FmodRenderSystem(packagePath, 1));
        cache = new TakeCache(versionRoot, quota);
    }

    public IDisposable Subscribe()
    {
        ZeroClientGuard.ClientOpened();
        AudioDiagnostics.Emit("subscriber-open");
        ZeroClientGuard.Enter(ZeroClientEntries.AudioLaneSubscribe);
        try
        {
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (subscribers++ == 0)
                {
                    generation++;
                    ZeroClientGuard.Enter(ZeroClientEntries.AudioTakeRendererStart);
                    int workers = Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO_RENDER_WORKERS") == "2" ? 2 : 1;
                    var created = new List<TakeRenderer>();
                    try
                    {
                        for (int i = 0; i < workers; i++)
                        {
                            uint seed = (uint)(i + 1);
                            created.Add(new TakeRenderer(nativeBackend
                                ? () => new FmodRenderSystem(packagePath, seed) : backendFactory));
                        }
                        renderers = created.ToArray();
                        AudioDiagnostics.Emit($"take-workers-start count={workers}");
                    }
                    catch
                    {
                        subscribers--;
                        foreach (var worker in created) worker.Dispose();
                        throw;
                    }
                }
            }
            return new Subscription(this);
        }
        catch { ZeroClientGuard.ClientClosed(); throw; }
    }

    public byte[]? Cached(string keyId) => cache.Get(Bankset, keyId);
    public IReadOnlyList<string> ReadyIds() => cache.ReadyIds(Bankset);

    public IDisposable SubscribeLane(AudioLane lane, Action<AudioFrame, byte[]> onBlock)
    {
        HostAudioLane nativeLane = lane switch
        {
            AudioLane.Music => HostAudioLane.Music,
            AudioLane.Ambience => HostAudioLane.Ambience,
            AudioLane.Loops => HostAudioLane.Loops,
            _ => throw new ArgumentException("Invalid stream lane", nameof(lane))
        };
        lock (gate)
        {
            if (subscribers == 0) throw new InvalidOperationException("No audio subscriber");
            if (streamUnavailable || !HostAudioHooks.StreamAvailable)
                throw new InvalidOperationException("Audio stream hooks unavailable");
            if (streamRenderer is null)
            {
                ZeroClientGuard.Enter(ZeroClientEntries.AudioStreamRendererStart);
                var created = new StreamRenderer(null, packagePath, HostAudioHooks.MusicState.Snapshot);
                created.Failed += OnStreamFailed;
                streamRenderer = created;
                HostAudioHooks.SetSubscriber(op => created.Apply(op));
                AudioDiagnostics.Emit("stream-worker-start");
            }
            var subscription = streamRenderer.Subscribe(nativeLane, block =>
            {
                var frame = new AudioFrame(AudioFrameKind.Lane, lane, 0, checked((uint)block.Index),
                    AudioFrame.LaneBlockFrames, block.Silent ? AudioFrameFlags.Silent : AudioFrameFlags.None,
                    checked((ulong)block.DueTimeUs), 0);
                onBlock(frame, block.Pcm);
            });
            laneSubscribers++;
            AudioDiagnostics.Emit($"lane-subscribe lane={(int)lane} count={laneSubscribers}");
            return new LaneSubscription(this, subscription);
        }
    }

    private void OnStreamFailed(string reason)
    {
        Volatile.Write(ref streamUnavailable, true);
        HostAudioHooks.SetSubscriber(null);
        StreamFailed?.Invoke(reason);
    }

    private void UnsubscribeLane(IDisposable native)
    {
        StreamRenderer? closing = null;
        lock (gate)
        {
            if (laneSubscribers > 0 && --laneSubscribers == 0)
            {
                HostAudioHooks.SetSubscriber(null);
                closing = streamRenderer;
                streamRenderer = null;
            }
            AudioDiagnostics.Emit($"lane-unsubscribe count={laneSubscribers}");
        }
        native.Dispose();
        closing?.Dispose();
        if (closing is not null) AudioDiagnostics.Emit("stream-worker-stop");
    }

    public Task<byte[]> GetTakeAsync(string keyId, string key, Action<byte[], int, bool>? onBlock = null)
    {
        if (!SoundKey.IsId(keyId) || SoundKey.Id(key) != keyId || !TryParseKey(key, out var path, out var parameters))
            throw new ArgumentException("Invalid sound key");
        if (cache.Get(Bankset, keyId) is { } hit)
        {
            if (onBlock is not null) EmitCachedBlocks(hit, onBlock);
            return Task.FromResult(hit);
        }
        var request = new TakeRequest(keyId, key, path, parameters);
        var flight = pending.GetOrAdd(keyId, _ => new InflightTake(f => RenderAndStoreAsync(request, f)));
        if (onBlock is not null) flight.Add(onBlock);
        return flight.Task;
    }

    private static void EmitCachedBlocks(byte[] wav, Action<byte[], int, bool> onBlock)
    {
        for (int index = 0, offset = 44; offset < wav.Length; index++)
        {
            int count = Math.Min(512 * 4, wav.Length - offset);
            onBlock(wav.AsSpan(offset, count).ToArray(), index, offset + count == wav.Length);
            offset += count;
        }
    }

    private async Task<byte[]> RenderAndStoreAsync(TakeRequest request, InflightTake flight)
    {
        try
        {
            TakeRenderer active;
            int started;
            lock (gate)
            {
                var workers = renderers ?? throw new InvalidOperationException("No audio subscriber");
                uint slot = 2166136261;
                foreach (char c in request.KeyId) slot = (slot ^ c) * 16777619;
                active = workers[(int)(slot % workers.Length)];
                if (outstandingRenders >= 16) throw new InvalidOperationException("Audio render capacity reached");
                outstandingRenders++;
                started = generation;
            }
            try
            {
            var take = await active.RenderAsync(request, (pcm, index, last) => flight.OnBlock(pcm, index, last))
                .ConfigureAwait(false);
            AudioDiagnostics.TakeRendered(take.Result.Frames, take.Result.FirstBlockMicroseconds);
            byte[] wav = Wav(take.Pcm16);
            lock (gate)
            {
                if (started != generation || subscribers == 0)
                    throw new OperationCanceledException("Audio subscriber left");
                cache.Put(Bankset, request.KeyId, wav);
            }
            return wav;
            }
            finally { lock (gate) outstandingRenders--; }
        }
        finally { pending.TryRemove(request.KeyId, out _); }
    }

    private sealed class InflightTake
    {
        private readonly object gate = new();
        private readonly List<(byte[] Pcm, int Index, bool Last)> blocks = [];
        private readonly List<Action<byte[], int, bool>> callbacks = [];
        private readonly Lazy<Task<byte[]>> task;
        internal InflightTake(Func<InflightTake, Task<byte[]>> render)
            => task = new Lazy<Task<byte[]>>(() => render(this), LazyThreadSafetyMode.ExecutionAndPublication);
        internal Task<byte[]> Task => task.Value;

        internal void Add(Action<byte[], int, bool> callback)
        {
            lock (gate)
            {
                foreach (var (pcm, index, last) in blocks) callback(pcm, index, last);
                callbacks.Add(callback);
            }
        }

        internal void OnBlock(ReadOnlyMemory<byte> pcm, int index, bool last)
        {
            byte[] copy = pcm.ToArray();
            lock (gate)
            {
                blocks.Add((copy, index, last));
                for (int i = callbacks.Count - 1; i >= 0; i--)
                {
                    try { callbacks[i](copy, index, last); }
                    catch (Exception)
                    {
                        callbacks.RemoveAt(i);
                        AudioDiagnostics.Emit("take-listener-detached");
                    }
                }
            }
        }
    }

    public static bool TryParseKey(string key, out string path, out TakeParameter[] parameters)
    {
        path = ""; parameters = [];
        if (key.Length is < 11 or > 512 || !key.StartsWith("event:/sfx/", StringComparison.Ordinal)
            || key.StartsWith("event:/sfx/ambience/", StringComparison.Ordinal)) return false;
        string[] parts = key.Split('|');
        if (parts.Length > 2 || parts[0].Contains("..", StringComparison.Ordinal) ||
            parts[0].Contains('\\') || parts[0].Contains('?') || parts[0].Contains('#')) return false;
        path = parts[0];
        if (!path.StartsWith("event:/sfx/", StringComparison.Ordinal)) return false;
        if (parts.Length == 1) return true;
        var values = new List<TakeParameter>();
        foreach (var pair in parts[1].Split(','))
        {
            int equals = pair.IndexOf('=');
            if (equals < 1 || equals == pair.Length - 1 ||
                !float.TryParse(pair[(equals + 1)..], System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out float value) || !float.IsFinite(value)) return false;
            values.Add(new TakeParameter(pair[..equals], value));
        }
        try
        {
            if (SoundKey.Canonical(path, values.Select(v => new KeyValuePair<string, float>(v.Name, v.Value))) != key) return false;
        }
        catch (ArgumentException) { return false; }
        parameters = values.ToArray();
        return true;
    }

    internal static byte[] Wav(byte[] pcm)
    {
        byte[] wav = new byte[44 + pcm.Length];
        var s = wav.AsSpan();
        "RIFF"u8.CopyTo(s); BinaryPrimitives.WriteInt32LittleEndian(s[4..], wav.Length - 8);
        "WAVEfmt "u8.CopyTo(s[8..]); BinaryPrimitives.WriteInt32LittleEndian(s[16..], 16);
        BinaryPrimitives.WriteInt16LittleEndian(s[20..], 1); BinaryPrimitives.WriteInt16LittleEndian(s[22..], 2);
        BinaryPrimitives.WriteInt32LittleEndian(s[24..], 48_000); BinaryPrimitives.WriteInt32LittleEndian(s[28..], 192_000);
        BinaryPrimitives.WriteInt16LittleEndian(s[32..], 4); BinaryPrimitives.WriteInt16LittleEndian(s[34..], 16);
        "data"u8.CopyTo(s[36..]); BinaryPrimitives.WriteInt32LittleEndian(s[40..], pcm.Length);
        pcm.CopyTo(s[44..]); return wav;
    }

    private void Unsubscribe()
    {
        TakeRenderer[]? closing = null;
        StreamRenderer? streamClosing = null;
        bool removed = false;
        lock (gate) if (subscribers > 0)
        {
            removed = true;
            if (--subscribers == 0)
            {
                generation++; closing = renderers; renderers = null;
                HostAudioHooks.SetSubscriber(null); streamClosing = streamRenderer; streamRenderer = null;
                laneSubscribers = 0;
            }
        }
        streamClosing?.Dispose();
        if (streamClosing is not null) AudioDiagnostics.Emit("stream-worker-stop");
        if (closing is not null) foreach (var worker in closing) worker.Dispose();
        if (closing is not null) AudioDiagnostics.Emit($"take-workers-stop count={closing.Length}");
        if (removed) ZeroClientGuard.ClientClosed();
    }

    public void Dispose()
    {
        TakeRenderer[]? closing;
        StreamRenderer? streamClosing;
        int closeDemand;
        lock (gate)
        {
            closeDemand = subscribers;
            disposed = true; subscribers = 0; generation++; closing = renderers; renderers = null;
            HostAudioHooks.SetSubscriber(null); streamClosing = streamRenderer; streamRenderer = null;
            laneSubscribers = 0;
        }
        streamClosing?.Dispose();
        if (closing is not null) foreach (var worker in closing) worker.Dispose();
        for (int i = 0; i < closeDemand; i++) ZeroClientGuard.ClientClosed();
    }

    private sealed class Subscription(AudioService owner) : IDisposable
    {
        private AudioService? owner = owner;
        public void Dispose() => Interlocked.Exchange(ref owner, null)?.Unsubscribe();
    }

    private sealed class LaneSubscription(AudioService owner, IDisposable native) : IDisposable
    {
        private AudioService? owner = owner;
        public void Dispose() => Interlocked.Exchange(ref owner, null)?.UnsubscribeLane(native);
    }
}
