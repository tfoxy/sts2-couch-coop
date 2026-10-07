using System.Net;
using System.Text.Json;
using CouchCoop.Mod.Audio;
using CouchCoop.MirrorProtocol.Audio;

namespace CouchCoop.Mod.Server;

internal sealed class AudioHttpRoutes(Func<AudioService?> service)
{
    internal async Task<bool> TryHandleAsync(Stream stream, CouchCoopHttpRequest request, CancellationToken token)
    {
        if (!request.RawPath.StartsWith("/audio/take/", StringComparison.Ordinal) && request.RawPath != "/audio/takes") return false;
        AudioService? audio = service();
        if (audio is null) { await Error(stream, HttpStatusCode.ServiceUnavailable, "audio-unavailable", token); return true; }
        if (request.RawPath == "/audio/takes")
        {
            await HttpResponseWriter.WriteBytesAsync(stream, 200, "OK",
                JsonSerializer.SerializeToUtf8Bytes(new { schema = SoundKey.Schema, bankset = audio.Bankset, keys = audio.ReadyIds() }),
                "application/json; charset=utf-8",
                new Dictionary<string, string> { ["Cache-Control"] = "no-store" }, token);
            return true;
        }
        var parts = request.RawPath["/audio/take/".Length..].Split('/');
        AudioDiagnostics.TakeHttp();
        if (parts.Length != 3 || parts[0] != SoundKey.Schema.ToString(System.Globalization.CultureInfo.InvariantCulture)
            || parts[1] != audio.Bankset || !parts[2].EndsWith(".wav", StringComparison.Ordinal))
        {
            await Error(stream, HttpStatusCode.BadRequest, "invalid-take-route", token); return true;
        }
        string keyId = parts[2][..^4];
        if (!SoundKey.IsId(keyId)) { await Error(stream, HttpStatusCode.BadRequest, "invalid-key-id", token); return true; }
        byte[]? wav = audio.Cached(keyId);
        if (wav is null) { await Error(stream, HttpStatusCode.NotFound, "take-not-found", token); return true; }
        await HttpResponseWriter.WriteAudioAsync(stream, wav, token); return true;
    }

    private static Task Error(Stream stream, HttpStatusCode status, string code, CancellationToken token)
        => HttpResponseWriter.WriteJsonErrorAsync(stream, status, code, "Audio take is unavailable.", token);
}
