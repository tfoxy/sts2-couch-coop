using System.Runtime.InteropServices;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Runtime;
using MegaCrit.Sts2.Core.Saves;

namespace CouchCoop.Mod.Audio.Seat;

/// <summary>Process-owned binding to the streaming seat's already-loaded capture; no FMOD enters this ABI.</summary>
public static unsafe class GrcAudioCue
{
    public const string EnvironmentVariable = "COUCHCOOP_STREAM_AUDIO";
    internal const string TokenFileName = "live-track-audio-token";
    private static GrcAudioCueBinding? _binding;
    private static Credential? _credential;
    private static int _arm;
    private sealed record Credential(string View, string Audio)
    {
        public override string ToString() => nameof(Credential);
    }

    internal static bool Requested(string? value, string? audio) => value == "gsw" && audio != "off";
    internal static GrcAudioCueBinding? Binding => Volatile.Read(ref _binding);
    internal static bool Enabled => Volatile.Read(ref _binding) is not null;
    internal static bool Active => Volatile.Read(ref _binding)?.Active == true;

    // Called only after GDExtensionManager has loaded this streaming seat's capture. Retain its handle for life.
    internal static void Load(string extension)
    {
        if (!Requested(Environment.GetEnvironmentVariable(EnvironmentVariable),
                Environment.GetEnvironmentVariable("COUCHCOOP_AUDIO"))) return;
        var path = RenderCaptureAvailability.LibraryPath(extension, StreamingSeatLaunch.HostOs,
            StreamingSeatLaunch.HostArch, File.ReadAllText, out _)
            ?? throw new InvalidOperationException("Cannot resolve the loaded capture library for audio");
        var handle = NativeLibrary.Load(path);
        var get = (delegate* unmanaged[Cdecl]<GrcAudioCueBinding.Table*, int>)NativeLibrary.GetExport(handle, "grc_audio_cue_get_v1");
        GrcAudioCueBinding.Table table;
        if (get(&table) != 1) throw new InvalidOperationException("Capture refused the audio cue ABI");
        var attach = (delegate* unmanaged[Cdecl]<GrcAudioCueBinding.Link*, int>)NativeLibrary.GetExport(handle, "grc_audio_link_attach_v1");
        var input = (delegate* unmanaged[Cdecl]<byte*, nuint, int>)NativeLibrary.GetExport(handle, "grc_audio_link_in");
        Volatile.Write(ref _binding, new(table, attach, input));
    }

    /// <summary>Only the current arm's streaming seat descriptor may carry its separate audio credential.</summary>
    public static string? CredentialFor(string? viewToken)
    {
        var value = Volatile.Read(ref _credential);
        return value is not null && value.View == viewToken ? value.Audio : null;
    }

    internal static string? ReadCredential(string? evidence, string viewToken, Func<string, string> readFile)
    {
        if (string.IsNullOrWhiteSpace(evidence)) return null;
        try
        {
            var token = readFile(Path.Combine(evidence, TokenFileName)).Trim();
            return token.Length == 64 && token.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')
                && token != viewToken ? token : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    internal static void Armed(string viewToken)
    {
        if (!Enabled) return;
        Armed(viewToken, Environment.GetEnvironmentVariable("GRC_EVIDENCE_DIR"), File.ReadAllText,
            GameNextFrame.Schedule, () =>
            {
                var prefs = SaveManager.Instance?.SettingsSave;
                return new(prefs?.VolumeMaster, prefs?.VolumeBgm, prefs?.VolumeSfx, prefs?.VolumeAmbience);
            });
    }

    internal static void Armed(string viewToken, string? evidence, Func<string, string> readFile,
        Action<Action> defer, Func<SeatAudioVolumes> initialVolumes)
    {
        var binding = Volatile.Read(ref _binding);
        if (binding is null) return;
        var arm = Interlocked.Increment(ref _arm);
        binding.Reset();
        var token = ReadCredential(evidence, viewToken, readFile);
        Volatile.Write(ref _credential, token is null ? null : new(viewToken, token));
        // The signal callback never reads game state. One deferred snapshot, then typed volume reporters own deltas.
        defer(() =>
        {
            if (Volatile.Read(ref _arm) != arm) return;
            var volumes = initialVolumes();
            binding.SetInitialVolumes(volumes.Master ?? 1, volumes.Bgm ?? 1, volumes.Sfx ?? 1, volumes.Ambience ?? 1);
        });
    }

    internal static void Disarmed()
    {
        Interlocked.Increment(ref _arm);
        Volatile.Write(ref _credential, null);
        Volatile.Read(ref _binding)?.Reset();
    }
    internal static void Sfx(string path, Dictionary<string, float>? parameters, float volume)
        => Volatile.Read(ref _binding)?.Cue(1, path, parameters, volume);
    internal static void Loop(string path, string action)
        => Volatile.Read(ref _binding)?.Cue(action switch { "start" => 2u, "stop" => 3u, _ => 4u }, path, null, 1);
    internal static void Volume(float value, int field) => Volatile.Read(ref _binding)?.SetVolume(value, field);
    internal static GrcAudioCueBinding? SwapForTest(GrcAudioCueBinding? binding)
        => Interlocked.Exchange(ref _binding, binding);
}

internal sealed unsafe class GrcAudioCueBinding
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct Table
    {
        internal uint AbiVersion, Size;
        internal delegate* unmanaged[Cdecl]<int> Active;
        internal delegate* unmanaged[Cdecl]<ulong> NowUs;
        internal delegate* unmanaged[Cdecl]<uint, byte*, byte*, nuint, byte*, nuint, ulong, float, float, int> Cue;
        internal delegate* unmanaged[Cdecl]<Gain*, nuint, int, int> Groups;
        internal delegate* unmanaged[Cdecl]<byte*, nuint, byte*, int> KeyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Gain
    {
        internal byte* Group;
        internal nuint Length;
        internal float Value;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Link
    {
        internal uint AbiVersion, Size;
        internal void* Self;
        internal delegate* unmanaged[Cdecl]<void*, byte*, nuint, int> Out;
    }

    private readonly Table _table;
    internal readonly delegate* unmanaged[Cdecl]<Link*, int> Attach;
    internal readonly delegate* unmanaged[Cdecl]<byte*, nuint, int> LinkIn;
    private readonly object _gate = new();
    private float _master = 1, _music = 1, _sfx = 1, _ambience = 1;
    private bool _snapshot;
    private bool _ready;

    internal GrcAudioCueBinding(Table table, delegate* unmanaged[Cdecl]<Link*, int> attach = null,
        delegate* unmanaged[Cdecl]<byte*, nuint, int> linkIn = null)
    {
        if (table.AbiVersion != 1 || table.Size < sizeof(Table) || table.Active == null || table.NowUs == null
            || table.Cue == null || table.Groups == null || table.KeyId == null)
            throw new ArgumentException("Incompatible capture audio cue ABI");
        _table = table;
        Attach = attach;
        LinkIn = linkIn;
    }

    internal bool Active => Volatile.Read(ref _ready) && _table.Active() != 0;

    internal void Reset()
    {
        lock (_gate) { _snapshot = false; Volatile.Write(ref _ready, false); }
    }

    internal void SetInitialVolumes(float master, float music, float sfx, float ambience)
    {
        lock (_gate)
        {
            _master = Unit(master); _music = Unit(music); _sfx = Unit(sfx); _ambience = Unit(ambience);
            _snapshot = false;
            SendGroups();
            Volatile.Write(ref _ready, true);
        }
    }

    internal void SetVolume(float value, int field)
    {
        if (!float.IsFinite(value)) return;
        lock (_gate)
        {
            switch (field)
            {
                case 0: _master = Unit(value); break;
                case 1: _music = Unit(value); break;
                case 2: _sfx = Unit(value); break;
                case 3: _ambience = Unit(value); break;
                default: return;
            }
            if (_ready) SendGroups();
        }
    }

    private static float Unit(float value) => float.IsFinite(value) ? Math.Clamp(value, 0, 1) : 1;

    private void SendGroups()
    {
        ReadOnlySpan<byte> names = "sfxmusicambience"u8;
        fixed (byte* p = names)
        {
            var master = _master * _master;
            Gain* gains = stackalloc Gain[3];
            gains[0] = new() { Group = p, Length = 3, Value = master * _sfx * _sfx };
            gains[1] = new() { Group = p + 3, Length = 5, Value = master * _music * _music };
            gains[2] = new() { Group = p + 8, Length = 8, Value = master * _ambience * _ambience };
            if (_table.Groups(gains, 3, _snapshot ? 0 : 1) == 1) _snapshot = true;
        }
    }

    internal void Cue(uint kind, string path, Dictionary<string, float>? parameters, float volume)
    {
        if (!Active || (kind != 4 && string.IsNullOrEmpty(path)) || !float.IsFinite(volume) || volume <= 0 || kind is < 1 or > 4) return;
        // Keep the same renderable SFX boundary as the legacy feed, without its allocating parser.
        if (kind == 1 && (!path.StartsWith("event:/sfx/", StringComparison.Ordinal)
            || path.StartsWith("event:/sfx/ambience/", StringComparison.Ordinal) || path.Contains("..", StringComparison.Ordinal)
            || path.Contains('\\') || path.Contains('?') || path.Contains('#'))) return;
        Span<byte> key = stackalloc byte[512];
        var length = 0;
        if (kind != 4 && !SoundKey.TryWriteCueKey(path, parameters, key, out length)) return;
        Span<byte> id = stackalloc byte[16];
        SoundKey.WriteCueId(key[..length], id);
        lock (_gate)
        {
            if (!_snapshot) SendGroups();
            fixed (byte* k = key, i = id, group = "sfx"u8)
                _table.Cue(kind, i, k, (nuint)length, group, 3, _table.NowUs(), 1, volume);
        }
    }
}
