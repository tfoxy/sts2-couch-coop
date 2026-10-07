using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.Audio.Native;

namespace CouchCoop.Mod.Audio.Render;

internal readonly record struct StreamLaneBlock(HostAudioLane Lane, long Index, long DueTimeUs, byte[] Pcm, bool Silent);

/// <summary>A demand-owned, private FMOD mixer for the three continuous browser audio lanes.</summary>
internal sealed unsafe class StreamRenderer : IDisposable
{
    internal const int SampleRate = 48000;
    internal const int FramesPerBlock = 512;
    internal const int BytesPerBlock = FramesPerBlock * 4;
    private const long LeadUs = 11000;
    private readonly string? _assembliesDirectory;
    private readonly string _packagePath;
    private readonly Func<HostMusicSnapshot> _snapshot;
    private readonly Action<string> _log;
    private readonly object _gate = new();
    private readonly List<Subscription> _subscribers = [];
    private readonly ConcurrentQueue<HostAudioOp> _ops = new();
    private readonly AutoResetEvent _wake = new(false);
    private Thread? _worker;
    private volatile bool _stop;
    private bool _disposed;
    private long _lastAppliedUs;
    private string? _failure;

    /// <summary>Raised once on the worker when native rendering becomes unavailable for this session.</summary>
    internal event Action<string>? Failed;

    private sealed class Subscription(StreamRenderer owner, HostAudioLane lane, Action<StreamLaneBlock> callback) : IDisposable
    {
        internal readonly HostAudioLane Lane = lane;
        internal readonly Action<StreamLaneBlock> Callback = callback;
        private StreamRenderer? _owner = owner;
        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.Remove(this);
    }

    private sealed class Capture : IDisposable
    {
        internal float* Samples = (float*)NativeMemory.AllocZeroed((nuint)(FramesPerBlock * 2), sizeof(float));
        internal nint Bus, Group, Dsp;
        internal GCHandle Handle;
        internal int Frames;
        internal bool Overflow;
        public void Dispose()
        {
            if (Handle.IsAllocated) Handle.Free();
            NativeMemory.Free(Samples); Samples = null;
        }
    }

    // FMOD invokes create synchronously inside CreateDSP. Serialize this handoff across render systems.
    private static readonly object DspGate = new();
    private static nint _pendingCapture;

    internal StreamRenderer(string? assembliesDirectory, string packagePath, Func<HostMusicSnapshot> snapshot,
        Action<string>? log = null)
    {
        _assembliesDirectory = assembliesDirectory;
        _packagePath = packagePath;
        _snapshot = snapshot;
        _log = log ?? (_ => { });
    }

    internal bool Active { get { lock (_gate) return _worker is not null; } }
    internal bool Available => Volatile.Read(ref _failure) is null;
    internal string? LastError => Volatile.Read(ref _failure);
    internal int SubscriberCount { get { lock (_gate) return _subscribers.Count; } }
    internal long LastAppliedTimeUs => Interlocked.Read(ref _lastAppliedUs);

    internal IDisposable Subscribe(HostAudioLane lane, Action<StreamLaneBlock> callback)
    {
        ArgumentNullException.ThrowIfNull(callback);
        while (true)
        {
            Thread? stopping;
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                if (_failure is not null) throw new InvalidOperationException("Stream renderer unavailable: " + _failure);
                stopping = _stop ? _worker : null;
                if (stopping is null)
                {
                    var subscription = new Subscription(this, lane, callback);
                    _subscribers.Add(subscription);
                    if (_worker is null)
                    {
                        _worker = new Thread(Run) { IsBackground = true, Name = "CouchCoop stream audio" };
                        _worker.Start();
                    }
                    _wake.Set();
                    return subscription;
                }
            }
            if (stopping == Thread.CurrentThread) throw new InvalidOperationException("Cannot resubscribe from a stopping renderer callback");
            stopping.Join();
            lock (_gate) if (_worker == stopping) { _worker = null; _stop = false; }
        }
    }

    internal void Apply(in HostAudioOp operation)
    {
        lock (_gate)
        {
            if (_worker is null || _stop) return;
            _ops.Enqueue(operation);
            _wake.Set();
        }
    }

    private void Remove(Subscription subscription)
    {
        Thread? stopping = null;
        lock (_gate)
        {
            if (_disposed) return;
            _subscribers.Remove(subscription);
            if (_subscribers.Count == 0 && _worker is not null)
            {
                _stop = true;
                stopping = _worker;
                _wake.Set();
            }
        }
        if (stopping is not null && stopping != Thread.CurrentThread)
        {
            stopping.Join();
            lock (_gate) if (_worker == stopping) { _worker = null; _stop = false; }
        }
    }

    private void Run()
    {
        nint studio = 0;
        PckBankSource? banks = null;
        var captures = new Capture?[3];
        var slots = new Dictionary<string, nint>(StringComparer.Ordinal);
        try
        {
            FmodLibrary.Install(_assembliesDirectory);
            banks = new PckBankSource(_packagePath);
            FmodVersionGate.Create(_log, out studio);
            FmodApi.Check(FmodApi.FMOD_Studio_System_GetCoreSystem(studio, out nint core), "stream core");
            FmodApi.Check(FmodApi.FMOD_System_SetOutput(core, FmodApi.NoSoundNrt), "stream NOSOUND_NRT");
            FmodApi.Check(FmodApi.FMOD_System_SetSoftwareFormat(core, SampleRate, FmodApi.Stereo, 0), "stream 48 kHz stereo");
            FmodApi.Check(FmodApi.FMOD_System_SetDSPBufferSize(core, FramesPerBlock, 4), "stream DSP buffer");
            FmodApi.Check(FmodApi.FMOD_Studio_System_Initialize(studio, 256,
                FmodApi.StudioSynchronousUpdate | FmodApi.StudioLoadFromUpdate,
                FmodApi.StreamFromUpdate | FmodApi.MixFromUpdate, 0), "stream initialize");
            banks.Load(studio);
            FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "stream prime");
            FmodApi.Check(FmodApi.FMOD_Studio_System_GetBus(studio, "bus:/master", out nint masterBus), "stream master bus");
            FmodApi.Check(FmodApi.FMOD_Studio_Bus_SetVolume(masterBus, 1), "stream unity master");
            captures[0] = Attach(studio, core, "bus:/master/music");
            captures[1] = Attach(studio, core, "bus:/master/ambience");
            captures[2] = Attach(studio, core, "bus:/master/sfx");

            // Join from current state only. The prior music timeline is deliberately not replayed.
            HostMusicSnapshot snapshot = _snapshot();
            foreach (var global in snapshot.Globals)
                Replay(studio, slots, new(HostAudioOpKind.Global, HostAudioLane.Music, "", global.Key, global.Value, 0));
            foreach (var instance in snapshot.Instances)
            {
                Replay(studio, slots, new(HostAudioOpKind.Start, instance.Value.Lane, instance.Key, instance.Value.EventPath, "", 0));
                foreach (var parameter in instance.Value.Parameters)
                    Replay(studio, slots, new(HostAudioOpKind.Parameter, instance.Value.Lane, instance.Key, parameter.Key, parameter.Value, 0));
                foreach (var label in instance.Value.Labels)
                    Replay(studio, slots, new(HostAudioOpKind.Label, instance.Value.Lane, instance.Key, label.Key, label.Value, 0));
            }

            long startedUs = NowUs();
            long index = 0;
            while (true)
            {
                if (_stop) break;
                while (_ops.TryDequeue(out var op))
                {
                    Replay(studio, slots, op);
                    Interlocked.Exchange(ref _lastAppliedUs, NowUs());
                }
                long dueUs = startedUs + LeadUs + index * FramesPerBlock * 1_000_000L / SampleRate;
                long waitUs = dueUs - LeadUs - NowUs();
                if (waitUs > 0)
                {
                    _wake.WaitOne(Math.Max(1, (int)Math.Min(waitUs / 1000, 10)));
                    continue;
                }
                foreach (Capture? capture in captures) if (capture is not null) { capture.Frames = 0; capture.Overflow = false; }
                FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "stream update");
                Subscription[] subscribers;
                lock (_gate) subscribers = _subscribers.ToArray();
                var laneBlocks = new StreamLaneBlock?[3];
                foreach (Subscription subscriber in subscribers)
                {
                    int laneIndex = (int)subscriber.Lane;
                    if (laneBlocks[laneIndex] is null)
                        laneBlocks[laneIndex] = Pack(captures[laneIndex]!, subscriber.Lane, index, dueUs);
                    try { subscriber.Callback(laneBlocks[laneIndex]!.Value); }
                    catch (Exception error) { _log("stream subscriber failed: " + error.GetType().Name); }
                }
                index++;
                // A delayed worker skips expired blocks instead of building a permanent backlog.
                long elapsedFrames = Math.Max(0, (NowUs() - startedUs) * SampleRate / 1_000_000L);
                index = Math.Max(index, elapsedFrames / FramesPerBlock);
            }
        }
        catch (Exception error)
        {
            string reason = error.GetType().Name + ": " + error.Message;
            Volatile.Write(ref _failure, reason);
            _log("stream renderer stopped: " + reason);
            try { Failed?.Invoke(reason); } catch { }
        }
        finally
        {
            foreach (nint slot in slots.Values)
            {
                FmodApi.FMOD_Studio_EventInstance_Stop(slot, FmodApi.StopImmediate);
                FmodApi.FMOD_Studio_EventInstance_Release(slot);
            }
            foreach (Capture? capture in captures)
            {
                if (capture is null) continue;
                FmodApi.FMOD_ChannelGroup_RemoveDSP(capture.Group, capture.Dsp);
                FmodApi.FMOD_DSP_Release(capture.Dsp);
                FmodApi.FMOD_Studio_Bus_UnlockChannelGroup(capture.Bus);
                capture.Dispose();
            }
            if (studio != 0) FmodApi.FMOD_Studio_System_Release(studio);
            banks?.Dispose();
            while (_ops.TryDequeue(out _)) { }
            lock (_gate) if (_worker == Thread.CurrentThread) { _worker = null; _subscribers.Clear(); _stop = false; }
        }
    }

    private static Capture Attach(nint studio, nint core, string path)
    {
        FmodApi.Check(FmodApi.FMOD_Studio_System_GetBus(studio, path, out nint bus), "stream bus");
        FmodApi.Check(FmodApi.FMOD_Studio_Bus_SetVolume(bus, 1), "stream unity bus");
        FmodApi.Check(FmodApi.FMOD_Studio_Bus_LockChannelGroup(bus), "stream lock bus");
        var capture = new Capture { Bus = bus };
        try
        {
            FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "stream create bus group");
            FmodApi.Check(FmodApi.FMOD_Studio_Bus_GetChannelGroup(bus, out capture.Group), "stream bus group");
            var description = new FmodApi.DspDescription
            {
                PluginSdkVersion = FmodApi.PluginSdkVersion, Version = 1,
                InputBuffers = 1, OutputBuffers = 1, Create = &CreateDsp, Read = &ReadDsp
            };
            "CouchCoop stream"u8.CopyTo(new Span<byte>(description.Name, 32));
            lock (DspGate)
            {
                capture.Handle = GCHandle.Alloc(capture);
                _pendingCapture = GCHandle.ToIntPtr(capture.Handle);
                try { FmodApi.Check(FmodApi.FMOD_System_CreateDSP(core, in description, out capture.Dsp), "stream create DSP"); }
                finally { _pendingCapture = 0; }
            }
            FmodApi.Check(FmodApi.FMOD_ChannelGroup_AddDSP(capture.Group, FmodApi.DspTail, capture.Dsp), "stream attach DSP");
            return capture;
        }
        catch
        {
            if (capture.Dsp != 0) FmodApi.FMOD_DSP_Release(capture.Dsp);
            FmodApi.FMOD_Studio_Bus_UnlockChannelGroup(bus);
            capture.Dispose();
            throw;
        }
    }

    private static StreamLaneBlock Pack(Capture capture, HostAudioLane lane, long index, long dueUs)
    {
        if (capture.Overflow) throw new InvalidOperationException("FMOD stream capture overflow");
        byte[] pcm = new byte[BytesPerBlock];
        bool silent = true;
        for (int frame = 0; frame < Math.Min(capture.Frames, FramesPerBlock); frame++)
            for (int channel = 0; channel < 2; channel++)
            {
                short value = (short)Math.Clamp((int)MathF.Round(capture.Samples[frame * 2 + channel] * 32767), short.MinValue, short.MaxValue);
                int offset = frame * 4 + channel * 2;
                pcm[offset] = (byte)value; pcm[offset + 1] = (byte)(value >> 8);
                silent &= value == 0;
            }
        return new(lane, index, dueUs, pcm, silent);
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int CreateDsp(FmodApi.DspState* state) { state->PluginData = _pendingCapture; return FmodApi.Ok; }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int ReadDsp(FmodApi.DspState* state, float* input, float* output, uint length, int inputChannels, int* outputChannels)
    {
        Buffer.MemoryCopy(input, output, (long)length * inputChannels * sizeof(float), (long)length * inputChannels * sizeof(float));
        *outputChannels = inputChannels;
        Capture capture = (Capture)GCHandle.FromIntPtr(state->PluginData).Target!;
        int take = Math.Min((int)length, FramesPerBlock - capture.Frames);
        if (take < length) capture.Overflow = true;
        for (int i = 0; i < take; i++)
        {
            capture.Samples[(capture.Frames + i) * 2] = input[i * inputChannels];
            capture.Samples[(capture.Frames + i) * 2 + 1] = input[i * inputChannels + (inputChannels > 1 ? 1 : 0)];
        }
        capture.Frames += take;
        return FmodApi.Ok;
    }

    private static void Replay(nint studio, Dictionary<string, nint> slots, in HostAudioOp op)
    {
        switch (op.Kind)
        {
            case HostAudioOpKind.Start:
                if (slots.Remove(op.Slot, out nint previous))
                {
                    FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Stop(previous, FmodApi.StopAllowFadeout), "stream replace stop");
                    FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Release(previous), "stream replace release");
                }
                if (!op.Name.StartsWith("event:/", StringComparison.Ordinal)) return;
                FmodApi.Check(FmodApi.FMOD_Studio_System_GetEvent(studio, op.Name, out nint description), "stream get event");
                FmodApi.Check(FmodApi.FMOD_Studio_EventDescription_CreateInstance(description, out nint instance), "stream create event");
                try { FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Start(instance), "stream start event"); slots[op.Slot] = instance; }
                catch { FmodApi.FMOD_Studio_EventInstance_Release(instance); throw; }
                break;
            case HostAudioOpKind.Stop:
                if (slots.Remove(op.Slot, out nint stopped))
                {
                    FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Stop(stopped, FmodApi.StopAllowFadeout), "stream stop event");
                    FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Release(stopped), "stream release event");
                }
                break;
            case HostAudioOpKind.Parameter when slots.TryGetValue(op.Slot, out nint target):
                FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_SetParameterByName(target, op.Name,
                    float.Parse(op.Value, CultureInfo.InvariantCulture), 0), "stream parameter");
                break;
            case HostAudioOpKind.Label when slots.TryGetValue(op.Slot, out nint target):
                FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_SetParameterByNameWithLabel(target, op.Name, op.Value, 0), "stream label");
                break;
            case HostAudioOpKind.Global:
                FmodApi.Check(FmodApi.FMOD_Studio_System_SetParameterByName(studio, op.Name,
                    float.Parse(op.Value, CultureInfo.InvariantCulture), 0), "stream global");
                break;
            // PckBankSource has already loaded the current bank set in memory. Act-bank proxy
            // operations therefore carry ordering but require no second extraction or disk copy.
            case HostAudioOpKind.LoadBank:
            case HostAudioOpKind.UnloadBank:
                break;
        }
    }

    private static long NowUs()
    {
        long ticks = Stopwatch.GetTimestamp();
        return ticks / Stopwatch.Frequency * 1_000_000 + ticks % Stopwatch.Frequency * 1_000_000 / Stopwatch.Frequency;
    }

    public void Dispose()
    {
        Thread? stopping;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            _stop = true;
            _subscribers.Clear();
            stopping = _worker;
            _wake.Set();
        }
        if (stopping != Thread.CurrentThread) stopping?.Join();
        _wake.Dispose();
    }
}
