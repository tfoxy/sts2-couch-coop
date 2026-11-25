using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.Mod.Audio.Seat;
using CouchCoop.Mod.Protocol;
using CouchCoop.Mod.Session;

internal static class GrcAudioCueTests
{
    private static int _checks, _active, _cues, _groups, _snapshot;
    private static uint _kind;
    private static ulong _stamp;
    private static float _pitch, _volume;
    private static readonly byte[] Key = new byte[512], Id = new byte[16];
    private static int _keyLength;
    private static readonly float[] Gains = new float[3];

    internal static async Task RunAsync()
    {
        NoDemandDoesNoWork();
        FlagsAndGrant();
        CredentialIsSeparateAndFailsClosed();
        BindingAndCues();
        await MixedViewersAsync();
        await LegacyFallbackIsUnchangedAsync();
        Console.WriteLine($"GSW seat audio: {_checks} checks passed");
    }

    internal static void NoDemandDoesNoWork()
    {
        Check(!GrcAudioCue.Enabled && !SeatAudioFeed.HasSubscribers && GrcAudioCue.CredentialFor(null) is null,
            "an unused process has no binding, legacy subscriber or credential");
        SeatAudioReporter.Sfx("event:/sfx/test", null, 1);
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 1000; i++)
        {
            SeatAudioReporter.Sfx("event:/sfx/test", null, 1);
            SeatAudioReporter.Loop("*", "stop-all");
            SeatAudioReporter.Volume(1, 0);
        }
        Check(GC.GetAllocatedBytesForCurrentThread() == before && !GrcAudioCue.Enabled,
            "zero demand performs no cue work, allocation or native load");
    }

    private static void FlagsAndGrant()
    {
        Check(!GrcAudioCue.Requested(null, null) && !GrcAudioCue.Requested("1", null)
            && !GrcAudioCue.Requested("GSW", null) && GrcAudioCue.Requested("gsw", null)
            && !GrcAudioCue.Requested("gsw", "off"), "exact opt-in, audio=off wins");
        var config = new StreamingSeatLaunch.Config("/capture/render_stream_capture.gdextension", "/capture/calibration");
        var off = StreamingSeatLaunch.Environment(config, 13366, "/evidence", ["http://localhost:13337"]);
        Check(!off.ContainsKey(GrcAudioCue.EnvironmentVariable) && !off.ContainsKey("GRC_LIVE_TRACKS"),
            "flag off keeps the launch environment unchanged");
        var on = StreamingSeatLaunch.Environment(config, 13366, "/evidence", ["http://localhost:13337"],
            streamAudio: true);
        Check(on[GrcAudioCue.EnvironmentVariable] == "gsw" && on["GRC_LIVE_TRACKS"] == "audio",
            "seat composes the audio grant from its own track usage");
        Check(on.Count == off.Count + 2 && off.All(pair => on[pair.Key] == pair.Value),
            "the opt-in adds only the flag and track grant");
        Check(!on.ContainsKey("GRC_AUDIO_ABI_TABLE"), "missing audio table stays unset with the audio grant");
        var staged = config with { AudioAbiTable = "/capture/abi-table.godot-4.5.1-audio-driver" };
        var stagedOn = StreamingSeatLaunch.Environment(staged, 13366, "/evidence", ["http://localhost:13337"], streamAudio: true);
        Check(stagedOn["GRC_AUDIO_ABI_TABLE"] == staged.AudioAbiTable, "audio grant receives the staged audio table");
        Check(!StreamingSeatLaunch.Environment(staged, 13366, "/evidence", ["http://localhost:13337"])
            .ContainsKey("GRC_AUDIO_ABI_TABLE"), "staged table is omitted without the audio grant");
        var inherited = new ProcessStartInfo("true");
        inherited.Environment[GrcAudioCue.EnvironmentVariable] = "gsw";
        inherited.Environment["GRC_LIVE_TRACKS"] = "input,audio";
        inherited.Environment["GRC_AUDIO_ABI_TABLE"] = "/host/audio-abi";
        StreamingSeatLaunch.ClearInherited(inherited);
        Check(!inherited.Environment.ContainsKey(GrcAudioCue.EnvironmentVariable)
            && !inherited.Environment.ContainsKey("GRC_LIVE_TRACKS")
            && !inherited.Environment.ContainsKey("GRC_AUDIO_ABI_TABLE"), "non-stream seats cannot inherit the grant or table");
        var host = StreamingSeatLaunch.HostEnvironment(staged, "/evidence", ["http://localhost:13337"]);
        Check(!host.ContainsKey(GrcAudioCue.EnvironmentVariable) && !host.ContainsKey("GRC_LIVE_TRACKS")
            && !host.ContainsKey("GRC_AUDIO_ABI_TABLE"),
            "the host view gets no audio grant");
        var path = RenderCaptureAvailability.LibraryPath("/capture/render_stream_capture.gdextension", "linux", "x86_64",
            _ => "[libraries]\nlinux.x86_64 = \"librender_stream_capture.so\"", out var invalid);
        Check(!invalid && path == "/capture/librender_stream_capture.so", "binding resolves the loaded descriptor library");
    }

    private static void CredentialIsSeparateAndFailsClosed()
    {
        var view = new string('a', 64);
        var audio = new string('b', 64);
        var reads = 0;
        string Read(string path)
        {
            reads++;
            Check(path == Path.Combine("/evidence", GrcAudioCue.TokenFileName), "read only the dedicated audio credential");
            return audio + "\n";
        }
        Check(GrcAudioCue.ReadCredential("/evidence", view, Read) == audio && reads == 1,
            "one on-demand credential read");
        Check(GrcAudioCue.ReadCredential("/evidence", view, _ => view) is null, "never reuse the view token");
        Check(GrcAudioCue.ReadCredential("/evidence", view, _ => "not-a-token") is null, "malformed credential omitted");
        Check(GrcAudioCue.ReadCredential("/evidence", view, _ => throw new FileNotFoundException()) is null,
            "missing evidence fails closed");
        var descriptor = new BrowserRenderStreamDto("/render-stream/seat/ws", "/render-stream/seat", view, 19);
        var off = BrowserJson.Serialize(descriptor);
        Check(!off.Contains("audio", StringComparison.Ordinal), "flag-off descriptor omits audio byte-for-byte");
        var on = BrowserJson.Serialize(descriptor with { Audio = new(audio) });
        Check(on.Contains("\"audio\":{\"token\":\"" + audio + "\"}", StringComparison.Ordinal),
            "descriptor carries a distinct audio token on the existing endpoint");
    }

    private static unsafe GrcAudioCueBinding.Table FakeTable() => new()
    {
        AbiVersion = 1, Size = (uint)sizeof(GrcAudioCueBinding.Table), Active = &Active, NowUs = &Now,
        Cue = &Cue, Groups = &Groups, KeyId = &KeyId,
    };

    private static unsafe void BindingAndCues()
    {
        var table = FakeTable();
        var bad = table; bad.AbiVersion++;
        try { _ = new GrcAudioCueBinding(bad); throw new Exception("bad ABI accepted"); }
        catch (ArgumentException) { _checks++; }
        bad = table; bad.Size--;
        try { _ = new GrcAudioCueBinding(bad); throw new Exception("short table accepted"); }
        catch (ArgumentException) { _checks++; }
        var binding = new GrcAudioCueBinding(table);
        var prior = GrcAudioCue.SwapForTest(binding);
        try
        {
            _active = 0; _cues = _groups = 0;
            SeatAudioReporter.Sfx("event:/sfx/test", null, 1);
            Check(_cues == 0 && _groups == 0, "dormant cue does no native work beyond active");
            binding.SetInitialVolumes(.5f, .25f, .75f, 1);
            Check(_groups == 1 && _snapshot == 1 && Gains.SequenceEqual([.140625f, .015625f, .25f]),
                "first groups snapshot uses master squared times bus squared, even dormant");
            SeatAudioReporter.Volume(1, 2);
            Check(_snapshot == 0 && Gains[0] == .25f, "typed SFX delta updates groups");
            Action? initialize = null;
            var reads = 0;
            var snapshots = 0;
            var view = new string('c', 64);
            var audio = new string('d', 64);
            GrcAudioCue.Armed(view, "/evidence", _ => { reads++; return audio; }, action => initialize = action,
                () => { snapshots++; return new(.5f, .25f, .75f, 1); });
            Check(reads == 1 && snapshots == 0 && GrcAudioCue.CredentialFor(view) == audio
                && GrcAudioCue.CredentialFor(new string('e', 64)) is null,
                "arm reads credential once and defers game volumes, fencing the view token");
            initialize!();
            Check(snapshots == 1 && _snapshot == 1, "each arm sends a fresh groups snapshot");
            _active = 1;
            var parameters = new Dictionary<string, float> { ["z"] = float.Epsilon, ["a"] = .25f };
            SeatAudioReporter.Sfx("event:/sfx/test", parameters, .7f);
            var key = SoundKey.Canonical("event:/sfx/test", parameters);
            Check(_kind == 1 && Encoding.UTF8.GetString(Key, 0, _keyLength) == key
                && Convert.ToHexString(Id).ToLowerInvariant() == SoundKey.Id(key)
                && _stamp == 123456789 && _pitch == 1 && _volume == .7f,
                "oneshot preserves identity, pitch, volume and capture clock");
            SeatAudioReporter.Loop("event:/sfx/loop", "start"); Check(_kind == 2, "loop start kind");
            SeatAudioReporter.Loop("event:/sfx/loop", "stop"); Check(_kind == 3, "loop stop kind");
            SeatAudioReporter.Loop("*", "stop-all");
            Check(_kind == 4 && _keyLength == 0 && Convert.ToHexString(Id).ToLowerInvariant()
                == Convert.ToHexString(System.Security.Cryptography.SHA256.HashData([1]).AsSpan(0, 16)).ToLowerInvariant(),
                "stop-all has empty key with schema hash");
            var count = _cues;
            foreach (var path in new[] { "bad.mp3", "event:/music/test", "event:/sfx/ambience/test", "event:/sfx/../test" })
                SeatAudioReporter.Sfx(path, null, 1);
            SeatAudioReporter.Sfx("event:/sfx/test", null, float.NaN);
            SeatAudioReporter.Sfx("event:/sfx/" + new string('x', 512), null, 1);
            Check(_cues == count, "invalid or unrenderable cues are refused");
            for (var i = 0; i < 2000; i++) SeatAudioReporter.Sfx("event:/sfx/test", parameters, 1);
            var before = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < 1000; i++)
            {
                SeatAudioReporter.Sfx("event:/sfx/test", parameters, 1);
                SeatAudioReporter.Loop("event:/sfx/loop", "start");
                SeatAudioReporter.Loop("event:/sfx/loop", "stop");
                SeatAudioReporter.Loop("*", "stop-all");
                SeatAudioReporter.Volume(.5f, 0);
            }
            Check(GC.GetAllocatedBytesForCurrentThread() == before, "active cue, loop and groups paths allocate zero bytes");
            GrcAudioCue.Armed(view, "/evidence", _ => audio, action => initialize = action,
                () => { snapshots++; return new(); });
            GrcAudioCue.Disarmed();
            initialize!();
            Check(snapshots == 1 && GrcAudioCue.CredentialFor(view) is null && !GrcAudioCue.Active,
                "disarm clears credentials and fences a queued snapshot");
        }
        finally { GrcAudioCue.Disarmed(); GrcAudioCue.SwapForTest(prior); _active = 0; }
    }

    private static unsafe GrcAudioCueBinding CreateBinding() => new(FakeTable());

    private static async Task MixedViewersAsync()
    {
        var binding = CreateBinding();
        var prior = GrcAudioCue.SwapForTest(binding);
        try
        {
            _active = 1;
            binding.SetInitialVolumes(1, 1, 1, 1);
            using (var subscription = SeatAudioFeed.Subscribe(new SeatAudioVolumes(1, 1, 1, 1)))
            {
                var before = _cues;
                SeatAudioReporter.Sfx("event:/sfx/mixed", null, .5f);
                Check(_cues == before + 1
                    && await subscription.ReadAsync(CancellationToken.None) is SeatAudioSfx { Key: "event:/sfx/mixed", Volume: .5f },
                    "mixed viewers receive both native and legacy cues");
                SeatAudioReporter.Volume(.25f, 0);
                Check(Gains[0] == .0625f
                    && await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: .25f },
                    "mixed viewers receive squared native gains and raw legacy deltas");
            }
            var count = _cues;
            SeatAudioReporter.Sfx("event:/sfx/native-only", null, 1);
            Check(!SeatAudioFeed.HasSubscribers && _cues == count + 1,
                "native audio continues after the last legacy subscriber leaves");
        }
        finally { GrcAudioCue.Disarmed(); GrcAudioCue.SwapForTest(prior); _active = 0; }
    }

    private static async Task LegacyFallbackIsUnchangedAsync()
    {
        Check(!GrcAudioCue.Enabled, "binding is absent by default");
        using var subscription = SeatAudioFeed.Subscribe(new SeatAudioVolumes(1, 1, 1, 1));
        SeatAudioReporter.Sfx("event:/sfx/test", null, .75f);
        var sound = await subscription.ReadAsync(CancellationToken.None) as SeatAudioSfx;
        Check(sound is { Key: "event:/sfx/test", Volume: .75f }
            && sound.KeyId == SoundKey.Id(sound.Key), "flag off publishes the legacy cue unchanged");
        SeatAudioReporter.Loop("*", "stop-all");
        Check(await subscription.ReadAsync(CancellationToken.None) is SeatAudioLoop { Key: "", KeyId: "", Action: "stop-all" },
            "flag off keeps the empty legacy stop-all identity");
        SeatAudioReporter.Volume(.25f, 0);
        Check(await subscription.ReadAsync(CancellationToken.None) is SeatAudioVolumes { Master: .25f, Snapshot: false },
            "flag off retains raw legacy volume deltas");
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static int Active() => _active;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static ulong Now() => 123456789;
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int Cue(uint kind, byte* id, byte* key, nuint keyLength, byte* group, nuint groupLength,
        ulong stamp, float pitch, float volume)
    {
        _cues++; _kind = kind; _stamp = stamp; _pitch = pitch; _volume = volume; _keyLength = (int)keyLength;
        new ReadOnlySpan<byte>(key, (int)keyLength).CopyTo(Key);
        new ReadOnlySpan<byte>(id, 16).CopyTo(Id);
        return 1;
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int Groups(GrcAudioCueBinding.Gain* gains, nuint n, int snapshot)
    {
        _groups++; _snapshot = snapshot;
        for (var i = 0; i < (int)n; i++) Gains[i] = gains[i].Value;
        return 1;
    }
    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static unsafe int KeyId(byte* key, nuint len, byte* id) => 1;

    private static void Check(bool value, string label)
    {
        _checks++;
        if (!value) throw new Exception("[GrcAudioCueTests] " + label);
    }
}
