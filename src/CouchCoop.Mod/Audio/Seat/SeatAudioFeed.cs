using System.Diagnostics;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.MirrorProtocol.Envelopes;
using Godot;
using MegaCrit.Sts2.Core.Saves;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Audio.Seat;

/// <summary>Process-owned seat audio state; a socket subscription is the only work trigger.</summary>
public static class SeatAudioFeed
{
    private const int Capacity = 256;
    private static readonly long MaxAgeTicks = Stopwatch.Frequency / 4;
    private static readonly object Gate = new();
    private static readonly List<Subscription> Subscribers = [];
    private static int _subscriberCount;
    private static float? _master, _bgm, _sfx, _ambience, _godotMasterDb, _godotSfxDb;


    public static async Task<Subscription> OpenAsync()
        => Subscribe(await ReadInitialVolumesAsync().ConfigureAwait(false));

    // One on-demand read on lane open, marshalled off the socket thread. The save singleton can enter Godot.
    private static async Task<SeatAudioVolumes> ReadInitialVolumesAsync()
    {
        if (!CouchCoopMod.EngineAvailable) return new SeatAudioVolumes();
        var result = new TaskCompletionSource<SeatAudioVolumes>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            Callable.From(() =>
            {
                try
                {
                    var prefs = SaveManager.Instance?.SettingsSave;
                    var audio = AudioServer.Singleton;
                    var master = audio.GetBusIndex("Master");
                    var sfx = audio.GetBusIndex("SFX");
                    result.TrySetResult(new SeatAudioVolumes(
                        prefs?.VolumeMaster, prefs?.VolumeBgm, prefs?.VolumeSfx, prefs?.VolumeAmbience,
                        master >= 0 ? audio.GetBusVolumeDb(master) : null,
                        sfx >= 0 ? audio.GetBusVolumeDb(sfx) : null));
                }
                catch (Exception ex)
                {
                    CouchCoopLog.Error($"Seat audio volume snapshot unavailable ({ex.GetType().Name}).");
                    result.TrySetResult(new SeatAudioVolumes());
                }
            }).CallDeferred();
        }
        catch { result.TrySetResult(new SeatAudioVolumes()); }
        try { return await result.Task.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
        catch { return new SeatAudioVolumes(); }
    }

    internal static bool HasSubscribers => Volatile.Read(ref _subscriberCount) != 0;
    internal static long NowUs()
    {
        var ticks = Stopwatch.GetTimestamp();
        return ticks / Stopwatch.Frequency * 1_000_000
            + ticks % Stopwatch.Frequency * 1_000_000 / Stopwatch.Frequency;
    }

    public static Subscription Subscribe(SeatAudioVolumes initial)
    {
        lock (Gate)
        {
            _master = initial.Master;
            _bgm = initial.Bgm;
            _sfx = initial.Sfx;
            _ambience = initial.Ambience;
            _godotMasterDb = initial.GodotMasterDb;
            _godotSfxDb = initial.GodotSfxDb;
            var subscription = new Subscription(new SeatAudioVolumes(_master, _bgm, _sfx, _ambience,
                _godotMasterDb, _godotSfxDb, Snapshot: true));
            Subscribers.Add(subscription);
            Volatile.Write(ref _subscriberCount, Subscribers.Count);
            return subscription;
        }
    }

    internal static void SetMaster(float value) => SetVolume(value, 0);
    internal static void SetBgm(float value) => SetVolume(value, 1);
    internal static void SetSfx(float value) => SetVolume(value, 2);
    internal static void SetAmbience(float value) => SetVolume(value, 3);
    internal static void SetGodotMasterDb(float value) => SetVolume(value, 4);
    internal static void SetGodotSfxDb(float value) => SetVolume(value, 5);

    private static void SetVolume(float value, int field)
    {
        if (!HasSubscribers || (field < 4 && !float.IsFinite(value)) || float.IsNaN(value)
            || value == float.PositiveInfinity) return;
        lock (Gate)
        {
            switch (field)
            {
                case 0: _master = value; break;
                case 1: _bgm = value; break;
                case 2: _sfx = value; break;
                case 3: _ambience = value; break;
                case 4: _godotMasterDb = value; break;
                case 5: _godotSfxDb = value; break;
            }
            var delta = field switch
            {
                0 => new SeatAudioVolumes(Master: value),
                1 => new SeatAudioVolumes(Bgm: value),
                2 => new SeatAudioVolumes(Sfx: value),
                3 => new SeatAudioVolumes(Ambience: value),
                4 => new SeatAudioVolumes(GodotMasterDb: value),
                _ => new SeatAudioVolumes(GodotSfxDb: value),
            };
            PublishLocked(delta);
        }
    }

    internal static void Sfx(string path, Dictionary<string, float>? parameters, float volume)
    {
        if (!HasSubscribers) return;
        if (string.IsNullOrEmpty(path) || !float.IsFinite(volume) || volume <= 0) return;
        lock (Gate)
        {
            if (!SfxEnabled()) return;
            try
            {
                var key = SoundKey.Canonical(path, parameters);
                var sound = new SeatAudioSfx(SoundKey.Id(key), key, NowUs(), Volume: volume);
                TraceCall(sound);
                PublishLocked(sound);
            }
            catch (ArgumentException) { }
        }
    }

    internal static void Loop(string path, string action)
    {
        if (!HasSubscribers) return;
        if (string.IsNullOrEmpty(path)) return;
        lock (Gate)
        {
            if (!SfxEnabled()) return;
            if (action == "stop-all")
            {
                var stop = new SeatAudioLoop("", "", action, NowUs());
                TraceCall(stop);
                PublishLocked(stop);
                return;
            }
            try
            {
                var key = SoundKey.Canonical(path);
                var loop = new SeatAudioLoop(SoundKey.Id(key), key, action, NowUs());
                TraceCall(loop);
                PublishLocked(loop);
            }
            catch (ArgumentException) { }
        }
    }

    internal static void TmpSfx(string path, float pitch, float volume)
    {
        if (!HasSubscribers) return;
        if (string.IsNullOrEmpty(path) || !float.IsFinite(pitch) || !float.IsFinite(volume) || volume <= 0) return;
        lock (Gate)
        {
            if (!SfxEnabled() || _godotMasterDb == float.NegativeInfinity
                || _godotSfxDb == float.NegativeInfinity) return;
            var sound = new SeatAudioTmpSfx(path, NowUs(), pitch, volume);
            TraceCall(sound);
            PublishLocked(sound);
        }
    }

    private static bool SfxEnabled() => _master != 0 && _sfx != 0;

    private static void TraceCall(object message)
    {
        if (!AudioDiagnostics.Enabled) return;
        var (seatTUs, keyId, path) = Identity(message);
        AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-call", AudioDiagnostics.NowUs(),
            SeatTUs: seatTUs, KeyId: keyId, Path: path));
    }

    public static (long SeatTUs, string? KeyId, string? Path) Identity(object message) => message switch
    {
        SeatAudioSfx sfx => (sfx.T, sfx.KeyId, null),
        SeatAudioLoop loop => (loop.T, loop.KeyId, null),
        SeatAudioTmpSfx tmp => (tmp.T, null, tmp.ResPath),
        _ => (0, null, null),
    };

    private static void PublishLocked(object message)
    {
        var stamp = Stopwatch.GetTimestamp();
        foreach (var subscriber in Subscribers) subscriber.Enqueue(message, stamp);
    }

    public sealed class Subscription : IDisposable
    {
        private readonly Queue<(object Message, long Stamp)> _queue = new();
        private readonly SemaphoreSlim _signal = new(0, 1);
        private bool _disposed;
        public long ConnectionId { get; } = AudioDiagnostics.ConnectionId();
        public SeatAudioVolumes Snapshot { get; }
        internal Subscription(SeatAudioVolumes snapshot) => Snapshot = snapshot;

        internal void Enqueue(object message, long stamp)
        {
            if (_disposed) return;
            while (_queue.Count >= Capacity)
            {
                var dropped = _queue.Dequeue().Message;
                if (AudioDiagnostics.Enabled)
                {
                    var (t, key, path) = Identity(dropped);
                    AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-drop-capacity", AudioDiagnostics.NowUs(),
                        ConnectionId, t, key, path, Depth: _queue.Count));
                }
            }
            _queue.Enqueue((message, stamp));
            if (AudioDiagnostics.Enabled)
            {
                var (t, key, path) = Identity(message);
                AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-enqueue", AudioDiagnostics.NowUs(),
                    ConnectionId, t, key, path, Depth: _queue.Count));
            }
            if (_queue.Count == 1) _signal.Release();
        }

        public async ValueTask<object?> ReadAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                await _signal.WaitAsync(cancellationToken).ConfigureAwait(false);
                lock (Gate)
                {
                    if (_disposed) return null;
                    while (_queue.Count > 0)
                    {
                        var (message, stamp) = _queue.Dequeue();
                        if (_queue.Count > 0) _signal.Release();
                        if (Stopwatch.GetTimestamp() - stamp <= MaxAgeTicks || message is SeatAudioVolumes)
                        {
                            if (AudioDiagnostics.Enabled)
                            {
                                var (t, key, path) = Identity(message);
                                AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-dequeue", AudioDiagnostics.NowUs(),
                                    ConnectionId, t, key, path, Depth: _queue.Count));
                            }
                            return message;
                        }
                        if (AudioDiagnostics.Enabled)
                        {
                            var (t, key, path) = Identity(message);
                            AudioDiagnostics.Trace(new AudioDiagnostics.Mark("seat-drop-age", AudioDiagnostics.NowUs(),
                                ConnectionId, t, key, path, Depth: _queue.Count));
                        }
                    }
                }
            }
        }

        public void Dispose()
        {
            lock (Gate)
            {
                if (_disposed) return;
                _disposed = true;
                Subscribers.Remove(this);
                _queue.Clear();
                Volatile.Write(ref _subscriberCount, Subscribers.Count);
                if (_signal.CurrentCount == 0) _signal.Release();
            }
        }
    }
}
