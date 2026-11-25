using System.Globalization;
using System.Text;
using System.Text.Json;
using CouchCoop.MirrorProtocol.Audio;

namespace CouchCoop.MirrorProtocol.Tests;

internal static class SoundKeyCueTests
{
    internal static void Run()
    {
        var checks = 0;
        Span<byte> key = stackalloc byte[512];
        Span<byte> id = stackalloc byte[16];
        using var vectors = JsonDocument.Parse(File.ReadAllText(Path.Combine(TestFixtures.RepoRoot(), "tests/fixtures/audio/keys.json")));
        foreach (var entry in vectors.RootElement.GetProperty("keys").EnumerateArray())
        {
            var canonical = entry.GetProperty("key").GetString()!;
            var parts = canonical.Split('|');
            var parameters = new Dictionary<string, float>();
            if (parts.Length > 1)
                foreach (var pair in parts[1].Split(','))
                {
                    var value = pair.Split('=');
                    parameters[value[0]] = float.Parse(value[1], CultureInfo.InvariantCulture);
                }
            Check.That(SoundKey.TryWriteCueKey(parts[0], parameters, key, out var length), "golden cue key fits");
            Check.Equal(Encoding.UTF8.GetString(key[..length]), canonical, "golden cue spelling");
            SoundKey.WriteCueId(key[..length], id);
            Check.Equal(Convert.ToHexString(id).ToLowerInvariant(), entry.GetProperty("keyId").GetString(), "golden binary cue id");
            checks += 3;
        }
        var oldCulture = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
            foreach (var number in new[] { float.Epsilon, float.MinValue, float.MaxValue, -0f, 1e-5f, 1e9f, .125f })
            {
                var parameters = new Dictionary<string, float> { ["z"] = number, ["A"] = 1.25f };
                Check.That(SoundKey.TryWriteCueKey("event:/sfx/tést", parameters, key, out var length), "UTF-8 cue key fits");
                Check.Equal(Encoding.UTF8.GetString(key[..length]), SoundKey.Canonical("event:/sfx/tést", parameters),
                    "cue uses ordinal parameters and invariant round-trip floats");
                checks += 2;
            }
        }
        finally { CultureInfo.CurrentCulture = oldCulture; }
        Check.That(SoundKey.TryWriteCueKey(new string('é', 256), null, key, out var boundary) && boundary == 512,
            "512 UTF-8 bytes accepted");
        Check.That(!SoundKey.TryWriteCueKey(new string('é', 257), null, key, out _), "UTF-8 byte overflow refused");
        Check.That(!SoundKey.TryWriteCueKey("x|y", null, key, out _), "invalid path refused");
        Check.That(!SoundKey.TryWriteCueKey("x", new() { ["a|b"] = 1 }, key, out _), "ambiguous name refused");
        Check.That(!SoundKey.TryWriteCueKey("x", new() { ["é"] = 1 }, key, out _), "non-ASCII name refused by cue ABI");
        Check.That(!SoundKey.TryWriteCueKey("x", new() { ["x"] = float.NaN }, key, out _), "nonfinite value refused");
        Check.That(!SoundKey.TryWriteCueKey("long", null, key[..2], out _), "short destination refused");
        Console.WriteLine($"SoundKey cue: {checks + 7} checks passed");
    }
}
