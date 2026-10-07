using System.Buffers;
using System.Diagnostics;
using System.Runtime.InteropServices;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Audio.Native;
using CouchCoop.MirrorProtocol.Audio;

namespace CouchCoop.Mod.Audio.Render;

public sealed unsafe class FmodRenderSystem : IFmodRenderBackend
{
    private const int Rate = 48000;
    private const int BlockFrames = 1024;
    private const int MaxFrames = Rate * 10;
    private readonly nint studio;
    private readonly nint core;
    private readonly PckBankSource banks;
    private readonly Capture master;
    private readonly Capture sfx;
    private readonly Capture music;
    private readonly Capture ambience;
    private readonly int ownerThread;
    private readonly List<Capture> attached = [];
    private bool disposed;
    private static readonly object DspCreationGate = new();
    private static nint pendingCapture;

    private sealed class Capture : IDisposable
    {
        internal float* Samples;
        internal float* Scratch;
        internal int ScratchStart, ScratchFrames;
        internal readonly bool StoreSamples;
        internal int Frames;
        internal int Reported;
        internal nint Dsp, Group, Bus;
        internal GCHandle Handle;
        internal double Energy;
        internal long CallbackAllocatedBytes;
        internal bool Overflow;
        internal Capture(bool storeSamples)
        {
            StoreSamples = storeSamples;
            if (storeSamples)
            {
                Samples = (float*)NativeMemory.AllocZeroed((nuint)(MaxFrames * 2), sizeof(float));
                if (Samples == null) throw new OutOfMemoryException();
            }
            else
            {
                Scratch = (float*)NativeMemory.AllocZeroed((nuint)(BlockFrames * 2), sizeof(float));
                if (Scratch == null) throw new OutOfMemoryException();
            }
        }
        internal void Reset() { Frames = 0; Reported = 0; ScratchStart = 0; ScratchFrames = 0; Energy = 0; Overflow = false; }
        public void Dispose() { if (Handle.IsAllocated) Handle.Free(); NativeMemory.Free(Samples); NativeMemory.Free(Scratch); Samples = null; Scratch = null; }
    }

    public string BankSetId => banks.BankSetId;
    public uint FmodVersion { get; }
    public long CallbackAllocatedBytes => master.CallbackAllocatedBytes + sfx.CallbackAllocatedBytes +
        music.CallbackAllocatedBytes + ambience.CallbackAllocatedBytes;
    // Least-squares bus gain removes FMOD's static bus/master gain before the lane-sum check.
    public double LastLaneResidualDb { get; private set; }

    public FmodRenderSystem(string packagePath, uint workerSeed, Action<string>? log = null)
        : this(null, packagePath, workerSeed, log) { }

    public FmodRenderSystem(string? assembliesDirectory, string packagePath, uint workerSeed, Action<string>? log = null)
    {
        ownerThread = Environment.CurrentManagedThreadId;
        FmodLibrary.Install(assembliesDirectory);
        banks = new PckBankSource(packagePath);
        FmodVersion = FmodVersionGate.Create(log ?? (_ => { }), out studio);
        try
        {
            FmodApi.Check(FmodApi.FMOD_Studio_System_GetCoreSystem(studio, out core), "get core");
            FmodApi.Check(FmodApi.FMOD_System_SetOutput(core, FmodApi.NoSoundNrt), "NOSOUND_NRT");
            FmodApi.Check(FmodApi.FMOD_System_SetSoftwareFormat(core, Rate, FmodApi.Stereo, 0), "stereo 48 kHz");
            FmodApi.Check(FmodApi.FMOD_System_SetDSPBufferSize(core, BlockFrames, 4), "DSP buffer");
            FmodApi.AdvancedSettings advanced = new() { CbSize = sizeof(FmodApi.AdvancedSettings) };
            FmodApi.Check(FmodApi.FMOD_System_GetAdvancedSettings(core, ref advanced), "get seed settings");
            advanced.RandomSeed = workerSeed;
            FmodApi.Check(FmodApi.FMOD_System_SetAdvancedSettings(core, ref advanced), "set seed");
            FmodApi.Check(FmodApi.FMOD_Studio_System_Initialize(studio, 256,
                FmodApi.StudioSynchronousUpdate | FmodApi.StudioLoadFromUpdate,
                FmodApi.StreamFromUpdate | FmodApi.MixFromUpdate, 0), "initialize");
            banks.Load(studio);
            FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "prime buses");
            master = AttachMaster();
            sfx = AttachBus("bus:/master/sfx");
            music = AttachBus("bus:/master/music");
            ambience = AttachBus("bus:/master/ambience");
        }
        catch
        {
            ReleaseCaptures();
            FmodApi.FMOD_Studio_System_Release(studio);
            banks.Dispose();
            throw;
        }
    }

    private Capture AttachMaster()
    {
        FmodApi.Check(FmodApi.FMOD_System_GetMasterChannelGroup(core, out nint group), "master group");
        return Attach(group, storeSamples: true, FmodApi.DspHead);
    }

    private Capture AttachBus(string path)
    {
        FmodApi.Check(FmodApi.FMOD_Studio_System_GetBus(studio, path, out nint bus), "get bus");
        FmodApi.Check(FmodApi.FMOD_Studio_Bus_LockChannelGroup(bus), "lock bus group");
        try
        {
            FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "create bus group");
            FmodApi.Check(FmodApi.FMOD_Studio_Bus_GetChannelGroup(bus, out nint group), "bus group");
            Capture capture = Attach(group, storeSamples: false, FmodApi.DspTail);
            capture.Bus = bus;
            return capture;
        }
        catch { FmodApi.FMOD_Studio_Bus_UnlockChannelGroup(bus); throw; }
    }

    private Capture Attach(nint group, bool storeSamples, int index)
    {
        var capture = new Capture(storeSamples) { Group = group };
        var description = new FmodApi.DspDescription
        {
            PluginSdkVersion = FmodApi.PluginSdkVersion, Version = 1,
            InputBuffers = 1, OutputBuffers = 1,
            Create = &CreateDsp, Read = &ReadDsp
        };
        byte[] name = "CouchCoop capture"u8.ToArray();
        byte* destination = description.Name;
        name.CopyTo(new Span<byte>(destination, 32));
        try
        {
            lock (DspCreationGate)
            {
                capture.Handle = GCHandle.Alloc(capture);
                pendingCapture = GCHandle.ToIntPtr(capture.Handle);
                try { FmodApi.Check(FmodApi.FMOD_System_CreateDSP(core, in description, out capture.Dsp), "create DSP"); }
                finally { pendingCapture = 0; }
            }
            FmodApi.Check(FmodApi.FMOD_ChannelGroup_AddDSP(group, index, capture.Dsp), "attach DSP");
            attached.Add(capture);
            return capture;
        }
        catch
        {
            if (capture.Dsp != 0) FmodApi.FMOD_DSP_Release(capture.Dsp);
            capture.Dispose();
            throw;
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int CreateDsp(FmodApi.DspState* state)
    {
        state->PluginData = pendingCapture;
        return FmodApi.Ok;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvCdecl)])]
    private static int ReadDsp(FmodApi.DspState* state, float* input, float* output, uint length, int inputChannels, int* outputChannels)
    {
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
        Capture capture = (Capture)GCHandle.FromIntPtr(state->PluginData).Target!;
        int channels = Math.Clamp(inputChannels, 1, 32);
        Buffer.MemoryCopy(input, output, (long)length * channels * sizeof(float), (long)length * channels * sizeof(float));
        *outputChannels = inputChannels;
        int take = Math.Min((int)length, MaxFrames - capture.Frames);
        if (take < length) capture.Overflow = true;
        float* target = capture.StoreSamples ? capture.Samples + capture.Frames * 2 : capture.Scratch;
        if (!capture.StoreSamples) { capture.ScratchStart = capture.Frames; capture.ScratchFrames = take; }
        double energy = capture.Energy;
        for (int i = 0; i < take; i++)
        {
            float left = input[i * channels];
            float right = input[i * channels + (channels > 1 ? 1 : 0)];
            target[i * 2] = left; target[i * 2 + 1] = right;
            energy += (double)left * left + (double)right * right;
        }
        capture.Energy = energy;
        capture.Frames += take;
        capture.CallbackAllocatedBytes += GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        return FmodApi.Ok;
    }

    public TakeResult Render(TakeRequest request, IAudioBlockSink sink)
    {
        if (disposed || ownerThread != Environment.CurrentManagedThreadId)
            throw new InvalidOperationException("FMOD render system belongs to its worker thread");
        if (!SoundKey.IsId(request.KeyId) || SoundKey.Id(request.CanonicalKey) != request.KeyId ||
            !request.EventPath.StartsWith("event:/sfx/", StringComparison.Ordinal) ||
            request.EventPath.StartsWith("event:/sfx/ambience/", StringComparison.Ordinal) ||
            request.CanonicalKey != SoundKey.Canonical(request.EventPath,
                request.Parameters.Select(p => new KeyValuePair<string, float>(p.Name, p.Value))))
            throw new ArgumentException("Invalid sound key", nameof(request));
        FmodApi.Check(FmodApi.FMOD_Studio_System_GetEvent(studio, request.EventPath, out nint description), "get event");
        FmodApi.Check(FmodApi.FMOD_Studio_EventDescription_IsOneshot(description, out int oneShot), "oneshot test");
        if (oneShot == 0) throw new InvalidOperationException("Live event cannot become a take");
        master.Reset(); sfx.Reset(); music.Reset(); ambience.Reset();
        FmodApi.Check(FmodApi.FMOD_Studio_EventDescription_CreateInstance(description, out nint instance), "create event");
        int firstUs = -1;
        bool capped = false;
        int compared = 0;
        double referenceEnergy = 0, splitEnergy = 0, crossEnergy = 0;
        try
        {
            foreach (TakeParameter parameter in request.Parameters)
                FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_SetParameterByName(instance, parameter.Name, parameter.Value, 0), "set event parameter");
            long started = Stopwatch.GetTimestamp();
            FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Start(instance), "start event");
            bool stopping = false;
            for (int update = 0; update < MaxFrames / BlockFrames + 4; update++)
            {
                sfx.ScratchFrames = music.ScratchFrames = ambience.ScratchFrames = 0;
                FmodApi.Check(FmodApi.FMOD_Studio_System_Update(studio), "render update");
                for (int frame = compared; frame < master.Frames; frame++)
                {
                    for (int channel = 0; channel < 2; channel++)
                    {
                        float value = master.Samples[frame * 2 + channel];
                        int inBlock = frame - compared;
                        float split = At(sfx, inBlock, channel) + At(music, inBlock, channel) + At(ambience, inBlock, channel);
                        referenceEnergy += value * value;
                        splitEnergy += split * split;
                        crossEnergy += value * split;
                    }
                }
                compared = master.Frames;
                if (firstUs < 0 && master.Energy > 0)
                    firstUs = (int)(Stopwatch.GetElapsedTime(started).TotalMilliseconds * 1000);
                if (master.Frames >= MaxFrames && !stopping)
                {
                    capped = true; stopping = true;
                    FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_Stop(instance, FmodApi.StopImmediate), "stop capped event");
                }
                FmodApi.Check(FmodApi.FMOD_Studio_EventInstance_GetPlaybackState(instance, out int playback), "event state");
                if (playback == FmodApi.PlaybackStopped) break;
            }
            double residualEnergy = referenceEnergy - crossEnergy * crossEnergy / Math.Max(splitEnergy, 1e-30);
            LastLaneResidualDb = 10 * Math.Log10(Math.Max(residualEnergy, 1e-30) / Math.Max(referenceEnergy, 1e-30));
            ReleaseValidatedTake(new ReadOnlySpan<float>(master.Samples, master.Frames * 2),
                master.Energy, sfx.Energy, music.Energy, ambience.Energy, capped, sink);
            return new TakeResult(request.KeyId, master.Frames, firstUs, sfx.Energy, music.Energy, ambience.Energy, capped);
        }
        finally
        {
            FmodApi.FMOD_Studio_EventInstance_Stop(instance, FmodApi.StopImmediate);
            FmodApi.FMOD_Studio_EventInstance_Release(instance);
        }
    }

    // Hold the bounded take until every render update has been metered. A late cross-bus
    // contribution must reject the entire take before any block reaches the caller.
    internal static void ReleaseValidatedTake(ReadOnlySpan<float> samples, double masterEnergy,
        double sfxEnergy, double musicEnergy, double ambienceEnergy, bool capped, IAudioBlockSink sink)
    {
        int frames = samples.Length / 2;
        if (frames == 0 || masterEnergy < 1e-9) throw new InvalidOperationException("Silent take");
        if (sfxEnergy < 1e-9 || musicEnergy > sfxEnergy * 0.001 || ambienceEnergy > sfxEnergy * 0.001)
            throw new InvalidOperationException("Take is outside the SFX bus");

        byte[] slab = ArrayPool<byte>.Shared.Rent(BlockFrames * 4);
        try
        {
            for (int start = 0, blockIndex = 0; start < frames; start += BlockFrames, blockIndex++)
            {
                int send = Math.Min(BlockFrames, frames - start);
                for (int i = 0; i < send; i++)
                {
                    int frame = start + i;
                    float fade = capped && frame >= MaxFrames - Rate / 20 ?
                        (MaxFrames - frame) / (float)(Rate / 20) : 1;
                    WritePcm16(slab, i * 4, samples[frame * 2] * fade);
                    WritePcm16(slab, i * 4 + 2, samples[frame * 2 + 1] * fade);
                }
                sink.OnBlock(slab.AsMemory(0, send * 4), blockIndex, start + send == frames);
            }
        }
        finally { ArrayPool<byte>.Shared.Return(slab); }
    }

    private static void WritePcm16(byte[] destination, int index, float value)
    {
        short sample = (short)Math.Clamp((int)MathF.Round(value * 32767), short.MinValue, short.MaxValue);
        destination[index] = (byte)sample;
        destination[index + 1] = (byte)(sample >> 8);
    }

    private static float At(Capture capture, int frame, int channel) =>
        frame < capture.ScratchFrames ? capture.Scratch[frame * 2 + channel] : 0;

    public void Dispose()
    {
        if (disposed) return;
        if (ownerThread != Environment.CurrentManagedThreadId) throw new InvalidOperationException("Dispose FMOD on its worker thread");
        disposed = true;
        ReleaseCaptures();
        FmodApi.Check(FmodApi.FMOD_Studio_System_Release(studio), "release private system");
        banks.Dispose();
    }

    private void ReleaseCaptures()
    {
        for (int i = attached.Count - 1; i >= 0; i--)
        {
            Capture capture = attached[i];
            FmodApi.FMOD_ChannelGroup_RemoveDSP(capture.Group, capture.Dsp);
            FmodApi.FMOD_DSP_Release(capture.Dsp);
            if (capture.Bus != 0) FmodApi.FMOD_Studio_Bus_UnlockChannelGroup(capture.Bus);
            capture.Dispose();
        }
        attached.Clear();
    }
}
