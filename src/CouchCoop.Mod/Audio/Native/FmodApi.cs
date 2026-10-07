using System.Runtime.InteropServices;

namespace CouchCoop.Mod.Audio.Native;

// A hand-declared subset of FMOD's public C ABI. No SDK headers or binaries ship with the mod.
internal static unsafe class FmodApi
{
    internal const uint HeaderVersion = 0x00020306;
    internal const uint PluginSdkVersion = 110;
    internal const int Ok = 0;
    internal const int NoSoundNrt = 4;
    internal const int Stereo = 3;
    internal const uint StreamFromUpdate = 1;
    internal const uint MixFromUpdate = 2;
    internal const uint StudioSynchronousUpdate = 4;
    internal const uint StudioLoadFromUpdate = 16;
    internal const int DspHead = -1;
    internal const int DspTail = -2;
    internal const int StopImmediate = 1;
    internal const int StopAllowFadeout = 0;
    internal const int PlaybackStopped = 2;
    internal const int HeaderMismatch = 20;

    [StructLayout(LayoutKind.Sequential)]
    internal struct BankInfo
    {
        public int Size;
        public nint Userdata;
        public int UserdataLength;
        public delegate* unmanaged[Cdecl]<byte*, uint*, nint*, nint, int> Open;
        public delegate* unmanaged[Cdecl]<nint, nint, int> Close;
        public delegate* unmanaged[Cdecl]<nint, void*, uint, uint*, nint, int> Read;
        public delegate* unmanaged[Cdecl]<nint, uint, nint, int> Seek;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DspDescription
    {
        public uint PluginSdkVersion;
        public fixed byte Name[32];
        public uint Version;
        public int InputBuffers, OutputBuffers;
        public delegate* unmanaged[Cdecl]<DspState*, int> Create;
        public nint Release, Reset;
        public delegate* unmanaged[Cdecl]<DspState*, float*, float*, uint, int, int*, int> Read;
        public nint Process, SetPosition;
        public int NumParameters;
        public nint ParamDescription;
        public nint SetFloat, SetInt, SetBool, SetData;
        public nint GetFloat, GetInt, GetBool, GetData;
        public nint ShouldProcess, UserData, SystemRegister, SystemDeregister, SystemMix;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DspState { public nint Instance; public nint PluginData; }

    // The public advanced-settings ABI in FMOD 2.03 is 104 bytes; randomSeed is at byte 88.
    // Both values are hard-stop layout gates, never opportunistic offsets into the game's system.
    [StructLayout(LayoutKind.Explicit, Size = 104)]
    internal struct AdvancedSettings
    {
        [FieldOffset(0)] public int CbSize;
        [FieldOffset(88)] public uint RandomSeed;
    }

    static FmodApi()
    {
        if (IntPtr.Size != 8 || Marshal.SizeOf<BankInfo>() != 56 ||
            Marshal.SizeOf<AdvancedSettings>() != 104 ||
            Marshal.OffsetOf<DspDescription>(nameof(DspDescription.PluginSdkVersion)).ToInt32() != 0 ||
            Marshal.OffsetOf<DspDescription>(nameof(DspDescription.Read)).ToInt32() != 72)
            throw new PlatformNotSupportedException("FMOD audio ABI layout is not verified on this platform");
    }

    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_Create(out nint system, uint version);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_GetCoreSystem(nint system, out nint core);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_Initialize(nint system, int channels, uint studioFlags, uint coreFlags, nint extra);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_Release(nint system);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_Update(nint system);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_LoadBankCustom(nint system, in BankInfo info, uint flags, out nint bank);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_Bank_LoadSampleData(nint bank);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_FlushSampleLoading(nint system);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_GetEvent(nint system, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out nint description);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventDescription_IsOneshot(nint description, out int oneShot);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventDescription_CreateInstance(nint description, out nint instance);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_SetParameterByName(nint instance, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, float value, int ignoreSeek);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_SetParameterByNameWithLabel(nint instance, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, [MarshalAs(UnmanagedType.LPUTF8Str)] string label, int ignoreSeek);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_SetParameterByName(nint system, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, float value, int ignoreSeek);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_Start(nint instance);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_Stop(nint instance, int mode);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_Release(nint instance);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_EventInstance_GetPlaybackState(nint instance, out int state);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_System_GetBus(nint system, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out nint bus);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_Bus_GetChannelGroup(nint bus, out nint group);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_Bus_SetVolume(nint bus, float volume);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_Bus_LockChannelGroup(nint bus);
    [DllImport("couch-fmodstudio", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_Studio_Bus_UnlockChannelGroup(nint bus);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_SetOutput(nint core, int output);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_Create(out nint core, uint version);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_Release(nint core);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_SetSoftwareFormat(nint core, int rate, int speakerMode, int rawSpeakers);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_SetDSPBufferSize(nint core, uint length, int count);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_GetVersion(nint core, out uint version, out uint build);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_GetAdvancedSettings(nint core, ref AdvancedSettings settings);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_SetAdvancedSettings(nint core, ref AdvancedSettings settings);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_CreateDSP(nint core, in DspDescription description, out nint dsp);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_System_GetMasterChannelGroup(nint core, out nint group);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_ChannelGroup_AddDSP(nint group, int index, nint dsp);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_ChannelGroup_RemoveDSP(nint group, nint dsp);
    [DllImport("couch-fmod", CallingConvention = CallingConvention.Cdecl)] internal static extern int FMOD_DSP_Release(nint dsp);

    internal static void Check(int result, string operation)
    {
        if (result != Ok) throw new FmodException(operation, result);
    }
}

internal sealed class FmodException(string operation, int result) : Exception($"FMOD {operation} failed ({result})")
{
    public int Result { get; } = result;
}
