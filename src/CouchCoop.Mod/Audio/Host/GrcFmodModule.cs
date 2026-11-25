using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using CouchCoop.Mod.Audio.Banks;
using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Audio.Host;

/// <summary>Process-lifetime binding to GSW's optional host renderer. FMOD and banks never cross this ABI.</summary>
internal sealed unsafe class GrcFmodModule : IGrcFmodModule
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct Table
    {
        internal uint Abi, Size;
        internal void* Self;
        internal delegate* unmanaged[Cdecl]<void*, Host*, void*, byte*, nuint, int> Start;
        internal delegate* unmanaged[Cdecl]<void*, byte*, nuint, int> State;
        internal delegate* unmanaged[Cdecl]<void*, uint, void> SeatOpen, SeatClose;
        internal delegate* unmanaged[Cdecl]<void*, uint, byte*, nuint, void> LinkIn;
        internal delegate* unmanaged[Cdecl]<void*, uint, ulong, byte*, nuint, float, void> Observe;
        internal nint TakeGet, TakeIndex, Release, Stop;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Host
    {
        internal uint Abi, Size;
        internal void* Self;
        internal delegate* unmanaged[Cdecl]<void*, byte*, byte*> Config;
        internal delegate* unmanaged[Cdecl]<void*, uint, byte*, nuint, void> LinkOut;
        internal delegate* unmanaged[Cdecl]<void*, int, byte*, nuint, void> Log;
    }

    private readonly Table _table;
    private readonly Dictionary<string, nint> _config;
    private readonly Action<uint, byte[]> _output;
    // These are retained for process life: native teardown is asynchronous and configuration must remain valid.
    private readonly GCHandle _handle;
    private readonly Host* _host;
    private static GrcFmodModule? _process;
    private static readonly object Gate = new();
    private static Exception? _failure;

    internal static GrcFmodModule Load(Action<uint, byte[]> output)
    {
        lock (Gate)
        {
            if (_process is not null) return _process;
            if (_failure is not null) throw new InvalidOperationException("GSW FMOD unavailable for this process", _failure);
            ZeroClientGuard.Enter(ZeroClientEntries.GrcAudioModuleLoad);
            try
            {
                var executable = Environment.ProcessPath ?? throw new InvalidOperationException("Missing host executable");
                var package = Path.ChangeExtension(executable, ".pck");
                using var banks = new PckBankSource(package);
                var library = OperatingSystem.IsWindows() ? "grc_fmod.dll" : OperatingSystem.IsMacOS() ? "libgrc_fmod.dylib" : "libgrc_fmod.so";
                var os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux";
                var path = Path.Combine(Path.GetDirectoryName(typeof(GrcFmodModule).Assembly.Location)!, "render-capture", os, library);
                var loaded = NativeLibrary.Load(path); // Never unload: the module owns asynchronous workers.
                var get = (delegate* unmanaged[Cdecl]<Table*, int>)NativeLibrary.GetExport(loaded, "grc_fmod_get_v1");
                Table table;
                if (get(&table) != 1) throw new InvalidOperationException("GSW FMOD refused its ABI");
                return _process = new(table, new Dictionary<string, string>
                {
                    ["pck_path"] = package,
                    ["banks"] = string.Join(',', banks.Banks.Select(bank => bank.Path)),
                    ["lanes"] = "1:music:bus:/master/music,2:ambience:bus:/master/ambience,3:loops:bus:/master/sfx:sfx",
                    ["core_lib"] = OperatingSystem.IsWindows() ? "fmod.dll" : OperatingSystem.IsMacOS() ? "libfmod.dylib" : "libfmod.so.14",
                    ["studio_lib"] = OperatingSystem.IsWindows() ? "fmodstudio.dll" : OperatingSystem.IsMacOS() ? "libfmodstudio.dylib" : "libfmodstudio.so.14",
                }, output);
            }
            catch (Exception error) { _failure = error; throw; }
        }
    }

    internal GrcFmodModule(Table table, IReadOnlyDictionary<string, string> config, Action<uint, byte[]> output)
    {
        if (table.Abi != 1 || table.Size < sizeof(Table) || table.Start == null || table.State == null
            || table.SeatOpen == null || table.SeatClose == null || table.LinkIn == null || table.Observe == null)
            throw new ArgumentException("Incompatible GSW FMOD ABI");
        _table = table;
        _output = output;
        _config = config.ToDictionary(pair => pair.Key, pair => Marshal.StringToCoTaskMemUTF8(pair.Value));
        _handle = GCHandle.Alloc(this);
        _host = (Host*)NativeMemory.AllocZeroed((nuint)sizeof(Host));
        *_host = new() { Abi = 1, Size = (uint)sizeof(Host), Self = (void*)GCHandle.ToIntPtr(_handle),
            Config = &Config, LinkOut = &LinkOut, Log = &Log };
        byte* error = stackalloc byte[512];
        error[0] = 0;
        if (_table.Start(_table.Self, _host, null, error, 512) != 1)
            throw new InvalidOperationException("GSW FMOD start refused: " + Marshal.PtrToStringUTF8((nint)error));
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static byte* Config(void* self, byte* key)
    {
        try
        {
            var module = (GrcFmodModule)GCHandle.FromIntPtr((nint)self).Target!;
            return (byte*)module._config.GetValueOrDefault(Marshal.PtrToStringUTF8((nint)key) ?? "");
        }
        catch { return null; }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void LinkOut(void* self, uint seat, byte* bytes, nuint length)
    {
        try
        {
            if (length > 1024 * 1024) return;
            ((GrcFmodModule)GCHandle.FromIntPtr((nint)self).Target!)._output(seat, new ReadOnlySpan<byte>(bytes, (int)length).ToArray());
        }
        catch { /* Never unwind through native workers. */ }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void Log(void* self, int level, byte* bytes, nuint length)
    {
        try { CouchCoopLog.Info("[gsw-audio] " + Encoding.UTF8.GetString(new ReadOnlySpan<byte>(bytes, checked((int)length)))); }
        catch { }
    }

    public void SeatOpen(uint seat) => _table.SeatOpen(_table.Self, seat);
    public void SeatClose(uint seat) => _table.SeatClose(_table.Self, seat);
    public void LinkIn(uint seat, ReadOnlySpan<byte> message)
    {
        fixed (byte* bytes = message) _table.LinkIn(_table.Self, seat, bytes, (nuint)message.Length);
    }
    public void Observe(uint op, ulong instance, string text, float value = 0)
    {
        var count = Encoding.UTF8.GetByteCount(text);
        Span<byte> buffer = count <= 1024 ? stackalloc byte[count] : new byte[count];
        Encoding.UTF8.GetBytes(text, buffer);
        fixed (byte* bytes = buffer) _table.Observe(_table.Self, op, instance, bytes, (nuint)count, value);
    }
}
