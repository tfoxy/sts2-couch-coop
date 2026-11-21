using System.Collections.Concurrent;
using System.Net.Http;
using System.Runtime.CompilerServices;
using Godot;

namespace CouchCoop.Mod.Server;

// Requests and retirement run on the main thread. Only byte fetching and image decoding run on the pool.
internal sealed class CouchCoopSeatStillSource(Func<CouchCoopStaticBackgroundState, Task<CouchCoopStaticBackgroundResult>> localRender)
{
    internal const string HostOriginEnvironmentVariable = "COUCHCOOP_HOST_BROWSER_ORIGIN";
    private static readonly System.Net.Http.HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly ConcurrentDictionary<string, Lazy<Task<CouchCoopStaticBackgroundResult?>>> _inFlight = new(StringComparer.Ordinal);
    private readonly SeatStillCache<ImageTexture> _cache = new(texture => texture.Dispose());

    internal static string? ValidSourcePath(string? path)
        => path is { Length: <= 1024 } && path.StartsWith("/bg/", StringComparison.Ordinal)
            && !path.Contains('\\') && !path.Contains('#') ? path : null;

    internal static string? ValidSourceFor(string? id) => id is { Length: > 0 and <= 1024 } ? id : null;

    internal static string? RequestPath(bool headless, string localPath, string? sourcePath)
        => headless ? ValidSourcePath(sourcePath) : localPath;

    internal static Uri? BuildHostUrl(string? origin, string path)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var host)
            || host.Scheme != "http" || host.Host != "127.0.0.1" || host.Port <= 0
            || host.AbsolutePath != "/" || host.Query.Length != 0 || host.Fragment.Length != 0
            || host.UserInfo.Length != 0 || ValidSourcePath(path) is null) return null;
        return new Uri(host, path);
    }

    internal static bool Successful(CouchCoopStaticBackgroundResult? result)
        => result is { Error: null, ServiceUnavailable: false, Bytes.Length: > 0 };

    internal static string? ImageFormat(string? contentType, ReadOnlySpan<byte> bytes)
    {
        if (bytes.StartsWith(new byte[] { 0xff, 0xd8, 0xff })) return "jpg";
        if (bytes.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "png";
        if (bytes.Length >= 12 && bytes[..4].SequenceEqual("RIFF"u8) && bytes.Slice(8, 4).SequenceEqual("WEBP"u8)) return "webp";
        return contentType?.Split(';')[0].Trim().ToLowerInvariant() switch
        {
            "image/jpeg" => "jpg", "image/png" => "png", "image/webp" => "webp", _ => null,
        };
    }

    private async Task<CouchCoopStaticBackgroundResult?> FetchAsync(CouchCoopStaticBackgroundState state, string path)
    {
        try
        {
            if (!CouchCoopMod.IsHeadlessClient) return await localRender(state).ConfigureAwait(false);
            var url = BuildHostUrl(System.Environment.GetEnvironmentVariable(HostOriginEnvironmentVariable), path);
            if (url is null) return null;
            using var response = await Http.GetAsync(url).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            return CouchCoopStaticBackgroundResult.Hit(await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false),
                response.Content.Headers.ContentType?.MediaType ?? "");
        }
        catch (Exception) { return null; }
    }

    internal static bool ForgetFlight<T>(ConcurrentDictionary<string, T> flights, string url, T pending) where T : class
        => ((ICollection<KeyValuePair<string, T>>)flights).Remove(new(url, pending));

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal void Request(CouchCoopStaticBackgroundState state, string? sourcePath, Action<ImageTexture?> completed)
    {
        var path = RequestPath(CouchCoopMod.IsHeadlessClient, state.Url, sourcePath);
        var ticket = _cache.Request(path, completed);
        if (ticket is null) return;
        _ = Task.Run(async () =>
        {
            var pending = _inFlight.GetOrAdd(path!, _ => new(() => FetchAsync(state, path!)));
            CouchCoopStaticBackgroundResult? result;
            try { result = await pending.Value.ConfigureAwait(false); }
            finally { ForgetFlight(_inFlight, path!, pending); }
            DecodeAndPost(ticket.Value, result);
        });
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private void DecodeAndPost(long ticket, CouchCoopStaticBackgroundResult? result)
    {
        Image? image = null;
        try
        {
            if (Successful(result))
            {
                image = new Image();
                var error = ImageFormat(result!.ContentType, result.Bytes!) switch
                {
                    "jpg" => image.LoadJpgFromBuffer(result.Bytes!),
                    "png" => image.LoadPngFromBuffer(result.Bytes!),
                    "webp" => image.LoadWebpFromBuffer(result.Bytes!),
                    _ => Error.FileUnrecognized,
                };
                if (error != Error.Ok || image.IsEmpty()) { image.Dispose(); image = null; }
            }
        }
        catch (Exception) { image?.Dispose(); image = null; }
        var decoded = image;
        Callable.From(() =>
        {
            using (decoded)
            {
                // Drop stale bytes before allocating a runtime texture.
                if (!_cache.IsCurrent(ticket)) return;
                ImageTexture? texture = null;
                try { if (decoded is not null) texture = ImageTexture.CreateFromImage(decoded); }
                catch (Exception) { texture?.Dispose(); texture = null; }
                _cache.Complete(ticket, texture);
            }
        }).CallDeferred();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    internal void Retire() => _cache.Retire();
}

// Engine-free single-current-URL state machine. Null completion is terminal until the URL changes or is retired.
internal sealed class SeatStillCache<T>(Action<T> release) where T : class
{
    private long _generation;
    private string? _url;
    private bool _settled;
    private T? _value;
    private readonly List<Action<T?>> _waiters = [];
    internal long? Request(string? url, Action<T?> completed)
    {
        if (url is null)
        {
            if (_url is not null) Retire();
            return null;
        }
        if (_url == url)
        {
            if (_settled) completed(_value); else _waiters.Add(completed);
            return null;
        }
        Retire();
        _url = url;
        _waiters.Add(completed);
        return _generation;
    }
    internal bool IsCurrent(long ticket) => _url is not null && ticket == _generation;
    internal void Complete(long ticket, T? value)
    {
        if (!IsCurrent(ticket)) { if (value is not null) release(value); return; }
        _settled = true;
        _value = value;
        var waiters = _waiters.ToArray();
        _waiters.Clear();
        foreach (var waiter in waiters) waiter(value);
    }
    internal void Retire()
    {
        _generation++;
        _url = null;
        _settled = false;
        _waiters.Clear();
        if (_value is { } previous) release(previous);
        _value = null;
    }
}

// The page admits a host image for one full seat descriptor, even when the hidden root stays mounted.
internal sealed record SeatStillAdmission(string? Path, string? SourceFor)
{
    internal bool Matches(string? descriptorId)
        => Path is not null && !string.IsNullOrEmpty(descriptorId) && SourceFor == descriptorId;

    // Several pages can share a seat: the first admission (in the caller's stable order) for the published
    // descriptor wins, so one page's stale admission cannot mask another page's current one. With no match the
    // first non-empty admission is returned; the tracker rejects it and the placeholder stays (fail closed).
    internal static SeatStillAdmission? Select(IEnumerable<SeatStillAdmission?> admissions, string? publishedId)
    {
        SeatStillAdmission? fallback = null;
        foreach (var admission in admissions)
        {
            if (string.IsNullOrEmpty(admission?.Path)) continue;
            if (admission.Matches(publishedId)) return admission;
            fallback ??= admission;
        }
        return fallback;
    }
}

// Main-thread request fence, independent of the mounted node's longer lifetime (e.g. character picks).
internal sealed class SeatStillSelection
{
    private SeatStillAdmission? _requested;
    private string? _descriptorId;
    internal long Generation { get; private set; }
    internal string? Source => _requested?.Path;

    internal bool Update(string? descriptorId, SeatStillAdmission? admission)
    {
        var next = admission?.Matches(descriptorId) == true ? admission : null;
        if (_descriptorId == descriptorId && _requested == next) return false;
        _descriptorId = descriptorId;
        _requested = next;
        Generation++;
        return true;
    }

    internal bool IsCurrent(long generation, string? descriptorId, SeatStillAdmission? admission)
        => Source is not null && Generation == generation && _descriptorId == descriptorId
            && _requested == admission && admission?.Matches(descriptorId) == true;

    internal void Retire()
    {
        _requested = null;
        _descriptorId = null;
        Generation++;
    }
}
