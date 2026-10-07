using System.Text;
using CouchCoop.Mod.Server;

internal static class AudioTmpSfxRouteTests
{
    public static async Task RunAsync()
    {
        Expect(AudioTmpSfxRoute.IsAllowedResourcePath("res://debug_audio/card_play.mp3"), "flat debug_audio MP3 accepted");
        Expect(!AudioTmpSfxRoute.IsAllowedResourcePath("res://debug_audio/nested/card_play.mp3"), "nested path refused");
        Expect(!AudioTmpSfxRoute.IsAllowedResourcePath("res://debug_audio/card_play.ogg"), "non-MP3 refused");
        Expect(!AudioTmpSfxRoute.IsAllowedResourcePath("res://debug_audio/../secret.mp3"), "traversal refused");
        Expect(!AudioTmpSfxRoute.IsAllowedResourcePath("res://audio/card_play.mp3"), "outside debug_audio refused");

        var bytes = new byte[] { 0x49, 0x44, 0x33, 1, 2, 3 };
        var source = new FakeSource(_ => bytes);
        var route = new AudioTmpSfxRoute(source);
        var first = await DispatchAsync(route, "/audio/tmpsfx/debug_audio/card_play.mp3?b=" + Uri.EscapeDataString(CouchCoopAssetVersion.Token));
        Expect(first.StatusCode == 200, $"valid MP3 served (status={first.StatusCode}, body={Encoding.UTF8.GetString(first.Body)})");
        Expect(first.Headers.GetValueOrDefault("Content-Type") == "audio/mpeg", "response declares audio/mpeg");
        Expect(first.Headers.GetValueOrDefault("Cache-Control") == "public, max-age=31536000, immutable", "response is immutable");
        Expect(first.Body.SequenceEqual(bytes), "response contains AudioStreamMP3 data bytes");
        bytes[0] = 0;
        var second = await DispatchAsync(route, "/audio/tmpsfx/debug_audio/card_play.mp3?b=" + Uri.EscapeDataString(CouchCoopAssetVersion.Token));
        Expect(second.Body[0] == 0x49 && source.LoadCount == 1, "memoized response is immutable and loaded once");

        var refused = await DispatchAsync(route, "/audio/tmpsfx/debug_audio/../secret.mp3?b=" + Uri.EscapeDataString(CouchCoopAssetVersion.Token));
        Expect(refused.StatusCode == 400 && source.LoadCount == 1, "unsafe key refused before resource loading");
        var otherToken = await DispatchAsync(route, "/audio/tmpsfx/debug_audio/card_play.mp3?b=stale");
        var noToken = await DispatchAsync(route, "/audio/tmpsfx/debug_audio/card_play.mp3");
        Expect(otherToken.StatusCode == 200 && noToken.StatusCode == 200 && source.LoadCount == 1,
            "build qualifier does not select a different resource");

        var tooLarge = new AudioTmpSfxRoute(new FakeSource(_ => new byte[AudioTmpSfxRoute.MaximumAssetBytes + 1]));
        var oversized = await DispatchAsync(tooLarge, "/audio/tmpsfx/debug_audio/large.mp3?b=" + Uri.EscapeDataString(CouchCoopAssetVersion.Token));
        Expect(oversized.StatusCode == 413 && tooLarge.MemoCount == 0, "oversized MP3 is refused and not memoized");

        var bounded = new AudioTmpSfxRoute(new FakeSource(path => Encoding.UTF8.GetBytes(path)));
        for (var index = 0; index < 24; index++)
        {
            var response = await DispatchAsync(bounded, $"/audio/tmpsfx/debug_audio/{index}.mp3?b=" + Uri.EscapeDataString(CouchCoopAssetVersion.Token));
            Expect(response.StatusCode == 200, "small MP3 response succeeds while filling the memo");
        }
        Expect(bounded.MemoCount <= 16 && bounded.MemoBytes <= 8 * 1024 * 1024, "memo count and bytes remain bounded");
    }

    private static async Task<Response> DispatchAsync(AudioTmpSfxRoute route, string target)
    {
        var requestBytes = Encoding.ASCII.GetBytes($"GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        await using var requestStream = new MemoryStream(requestBytes);
        var request = await CouchCoopHttpRequest.TryReadAsync(requestStream);
        if (request is null) throw new Exception("request parser returned null");

        await using var responseStream = new MemoryStream();
        var handled = await route.TryHandleAsync(responseStream, request, CancellationToken.None);
        Expect(handled, "route handles its matching prefix");
        var response = Encoding.ASCII.GetString(responseStream.ToArray());
        var split = response.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var headerText = response[..split];
        var bodyOffset = Encoding.ASCII.GetByteCount(response[..(split + 4)]);
        var status = headerText.Split("\r\n", StringSplitOptions.None)[0].Split(' ')[1];
        var headers = headerText.Split("\r\n", StringSplitOptions.None).Skip(1)
            .Select(line => line.Split(": ", 2, StringSplitOptions.None))
            .ToDictionary(parts => parts[0], parts => parts[1], StringComparer.OrdinalIgnoreCase);
        return new Response(int.Parse(status), headers, responseStream.ToArray()[bodyOffset..]);
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception($"[AudioTmpSfxRouteTests] FAILED: {message}");
    }

    private sealed record Response(int StatusCode, Dictionary<string, string> Headers, byte[] Body);

    private sealed class FakeSource(Func<string, byte[]?> loader) : IAudioTmpSfxSource
    {
        public int LoadCount { get; private set; }
        public byte[]? TryLoadMp3(string resourcePath)
        {
            LoadCount++;
            return loader(resourcePath);
        }
    }
}
