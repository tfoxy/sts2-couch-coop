using System.Globalization;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Audio;
using CouchCoop.MirrorProtocol.Envelopes;

namespace CouchCoop.MirrorProtocol.Tests;

internal static class AudioWireTests
{
    public static void Run()
    {
        using var keys = JsonDocument.Parse(File.ReadAllText(Path.Combine(TestFixtures.RepoRoot(), "tests/fixtures/audio/keys.json")));
        Check.Equal(keys.RootElement.GetProperty("schema").GetInt32(), 1, "audio schema");
        var entries = keys.RootElement.GetProperty("keys").EnumerateArray().ToArray();
        Check.Equal(entries.Length, 30, "census golden key count");
        Check.Equal(SoundKey.Canonical("event:/sfx/ui/clicks/ui_hover"), entries[1].GetProperty("key").GetString(),
            "parameter-free canonical key is path alone");
        foreach (var entry in entries)
        {
            var key = entry.GetProperty("key").GetString()!;
            var id = entry.GetProperty("keyId").GetString()!;
            Check.Equal(SoundKey.Id(key), id, key);
            Check.That(SoundKey.IsId(id), "valid keyId");
        }
        Check.Equal(entries.Select(e => e.GetProperty("keyId").GetString()).Distinct().Count(), 30, "unique IDs");
        Check.That(!SoundKey.IsId(new string('A', 32)), "uppercase rejected");

        var oldCulture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
            Check.Equal(SoundKey.Canonical("event:/test", [new("z", 1.25f), new("A", 2f)]),
                "event:/test|A=2,z=1.25", "ordinal and invariant R canonical form");
        }
        finally { CultureInfo.CurrentCulture = oldCulture; }

        using var frames = JsonDocument.Parse(File.ReadAllText(Path.Combine(TestFixtures.RepoRoot(), "tests/fixtures/audio/frames.json")));
        var golden = frames.RootElement.GetProperty("frames")[0];
        var bytes = Convert.FromHexString(golden.GetProperty("hex").GetString()!);
        Check.That(AudioFrame.TryDecode(bytes, out var frame), "decode golden frame");
        Check.Equal(frame, new AudioFrame(AudioFrameKind.Take, AudioLane.Take, 17, 0, 2,
            AudioFrameFlags.First | AudioFrameFlags.Last, 123456789, 123450000), "golden header");
        Check.Equal(Convert.ToHexString(frame.Encode(bytes.AsSpan(AudioFrame.HeaderSize))),
            Convert.ToHexString(bytes), "golden re-encode");
        Check.That(!AudioFrame.TryDecode(bytes.AsSpan(0, bytes.Length - 1), out _), "truncation rejected");
        bytes[18] = 1;
        Check.That(!AudioFrame.TryDecode(bytes, out _), "reserved bits rejected");

        var json = JsonSerializer.Serialize(new SeatAudioSfx(entries[0].GetProperty("keyId").GetString()!,
            entries[0].GetProperty("key").GetString()!, 7), ProtocolJsonContext.Default.SeatAudioSfx);
        Check.That(json.Contains("\"kind\":\"sfx\""), "seat discriminator serialized");
        Check.That(json.Contains("\"keyId\":"), "seat keyId serialized");
        Check.That(!json.Contains("\"Kind\":"), "camelCase audio messages");
        var muteJson = JsonSerializer.Serialize(new SeatAudioVolumes(GodotSfxDb: float.NegativeInfinity),
            ProtocolJsonContext.Default.SeatAudioVolumes);
        Check.That(muteJson.Contains("\"godotSfxDb\":\"-Infinity\""),
            "Godot mute dB survives JSON as a named floating-point string");

        string clockJson = JsonSerializer.Serialize(new AudioClock(123, 124, 7, 321.5),
            ProtocolJsonContext.Default.AudioClock);
        using (var clock = JsonDocument.Parse(clockJson))
        {
            Check.Equal(clock.RootElement.GetProperty("kind").GetString(), "clock", "clock discriminator");
            Check.Equal(clock.RootElement.GetProperty("hostUs").GetUInt64(), 123UL, "clock receive stamp");
            Check.Equal(clock.RootElement.GetProperty("sentUs").GetUInt64(), 124UL, "clock send stamp");
            Check.Equal(clock.RootElement.GetProperty("seq").GetInt64(), 7L, "clock sequence echo");
            Check.Equal(clock.RootElement.GetProperty("clientPerfMs").GetDouble(), 321.5, "clock client time echo");
        }
        string unsolicited = JsonSerializer.Serialize(new AudioClock(1, 2), ProtocolJsonContext.Default.AudioClock);
        Check.That(!unsolicited.Contains("seq") && !unsolicited.Contains("clientPerfMs"),
            "unsolicited clock omits echo fields");
    }
}
