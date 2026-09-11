// Decode-once HTTP font cache for the M1c mirror text layer (WS-F) — the font analog of TextureStore. The mirror
// wire ships each text node's font as a `/res/fonts/*.ttf` route (SceneDeltaReader's MirrorResourceUrl on the
// MegaLabel/MegaRichTextLabel font resource); this store fetches each DISTINCT url exactly once (engine-native
// HttpRequest, no System.Net on the phone path), wraps the raw bytes in one FontFile, and caches it by url. Every
// Label/RichTextLabel that references the same font shares the one decoded FontFile (no per-label fetch).
//
// Callers Request(url, onReady): the FontFile is returned synchronously when already cached, else onReady fires
// once the async fetch settles (the label then re-applies the theme font override). A 404/failed url falls back to
// the default theme font and logs a one-time non-silent notice (M1c policy).
//
// Self-mounting singleton: WS-F cannot edit AppShell (which mounts TextureStore), so on first use this store finds
// the already-mounted TextureStore by walking the tree, reads its public BaseUrl, and parents itself under it (so
// its HttpRequest children process and its lifetime tracks the render stage). Env COUCHCOOP_ASSETS_BASE is the
// fallback base URL if no TextureStore is present.

using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Assets;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class FontStore : Node, IAssetIdleSource
{
    // Match TextureStore's proven in-flight bound; the font set is tiny (a handful of families) so this never
    // saturates, but it keeps the shape identical.
    private const int MaxInFlight = 6;

    private static FontStore? _instance;

    // "http://host:port" (no trailing slash) — the node's `/res/...`-prefixed font url is appended verbatim.
    public string BaseUrl { get; private set; } = "";

    private readonly Dictionary<string, FontFile> _cache = new(StringComparer.Ordinal);
    private readonly HashSet<string> _failed = new(StringComparer.Ordinal);
    private readonly HashSet<string> _loading = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action<FontFile>>> _waiters = new(StringComparer.Ordinal);
    private readonly Queue<string> _queue = new();
    // Transient-retry bookkeeping (missing-textures fix 2026-07-19) — see TextureStore._attempts.
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);
    private int _inFlight;
    private bool _loggedFallback;

    // Diagnostics (mirrors TextureStore).
    public long Fetched { get; private set; }
    public int PendingCount => _inFlight + _queue.Count;
    public bool Idle => _inFlight == 0 && _queue.Count == 0;

    // IAssetIdleSource: registered in For() so the --shot settle gate waits for fonts (fixes the latent race where
    // --shot fired before fonts arrived).
    public string Label => "fonts";

    // Get-or-create the process singleton. `context` is any in-tree node (a text Control): its tree is walked once
    // to find the mounted TextureStore (public BaseUrl, no seam edit) and to host this store. Idempotent + cheap
    // after the first call.
    public static FontStore For(Node context)
    {
        if (_instance is not null && GodotObject.IsInstanceValid(_instance))
        {
            return _instance;
        }

        var store = new FontStore { Name = "__fontStore" };

        var tree = context.GetTree();
        TextureStore? textures = tree is not null ? FindTextureStore(tree.Root) : null;

        if (textures is not null)
        {
            store.BaseUrl = textures.BaseUrl.TrimEnd('/');
            textures.AddChild(store); // parent under the render stage so its HttpRequest children process
        }
        else
        {
            store.BaseUrl = (System.Environment.GetEnvironmentVariable("COUCHCOOP_ASSETS_BASE") ?? "").TrimEnd('/');
            GD.PrintErr("M1C_FONT: no TextureStore found in tree — using COUCHCOOP_ASSETS_BASE fallback " +
                        $"base='{store.BaseUrl}' (fonts will fail if empty).");
            (tree?.Root ?? context).AddChild(store);
        }

        _instance = store;
        AssetStores.Register(store); // the --shot settle gate now waits on fonts too
        return store;
    }

    // Request the FontFile at `relUrl` (a `/res/...` path). Returns the cached FontFile immediately when available;
    // otherwise returns null and invokes `onReady` once the fetch settles (never for a permanently-failed url).
    // Idempotent: repeated requests for one url coalesce onto a single fetch.
    public FontFile? Request(string relUrl, Action<FontFile> onReady)
    {
        if (_cache.TryGetValue(relUrl, out var font))
        {
            return font;
        }

        if (_failed.Contains(relUrl))
        {
            return null; // known-bad — keep the default theme font, don't retry or leak a waiter
        }

        if (!_waiters.TryGetValue(relUrl, out var list))
        {
            list = new List<Action<FontFile>>();
            _waiters[relUrl] = list;
        }

        list.Add(onReady);

        if (_loading.Add(relUrl))
        {
            _queue.Enqueue(relUrl);
            Pump();
        }

        // A disk-cache hit resolves synchronously inside Pump→Fetch — return it like the pre-cached case so a
        // caller assigning the return value can't clobber its own callback result (see TextureStore.Request).
        return _cache.TryGetValue(relUrl, out var resolved) ? resolved : null;
    }

    // Drop the process singleton (AppShell.ReturnToMenu teardown). The node is freed with the render stage; nulling
    // the static ref stops it pinning the old stage's decoded FontFile cache until the next stage's first For() call.
    public static void ResetInstance() => _instance = null;

    private static TextureStore? FindTextureStore(Node node)
    {
        if (node is TextureStore ts)
        {
            return ts;
        }

        foreach (var child in node.GetChildren())
        {
            if (FindTextureStore(child) is { } found)
            {
                return found;
            }
        }

        return null;
    }

    private void Pump()
    {
        while (_inFlight < MaxInFlight && _queue.Count > 0)
        {
            _inFlight++;
            Fetch(_queue.Dequeue());
        }
    }

    private void Fetch(string relUrl)
    {
        // WS-U disk cache: serve the .ttf/.otf bytes from disk before HTTP. A cache-sourced decode failure self-heals
        // (delete + real fetch) rather than marking the url failed, so a corrupt file can't permanently blank the font.
        if (AssetDiskCache.Read(relUrl) is { } cached)
        {
            var hit = Decode(cached);
            if (hit is not null)
            {
                AssetDiskCache.CountHit();
                _inFlight--;
                _loading.Remove(relUrl);
                OnFontReady(relUrl, hit);
                Pump();
                return;
            }

            AssetDiskCache.Shared?.DeleteEntry(relUrl); // poisoned entry — re-fetch over HTTP
        }

        // Timeout + transient retry (missing-textures fix 2026-07-19) — see TextureStore.Fetch for the rationale.
        var req = new HttpRequest { UseThreads = true, Timeout = AssetFetchPolicy.TimeoutSeconds(30) };
        AddChild(req);
        string url = BaseUrl + relUrl;
        req.RequestCompleted += (result, code, _, body) =>
        {
            req.QueueFree();
            _inFlight--;

            FontFile? font = null;
            if (result == (long)HttpRequest.Result.Success && code >= 200 && code < 300 && body.Length > 0)
            {
                font = Decode(body);
            }

            if (font is not null)
            {
                _loading.Remove(relUrl);
                _attempts.Remove(relUrl);
                AssetDiskCache.Write(relUrl, body); // write-through the fetched bytes (counts miss+write)
                OnFontReady(relUrl, font);
            }
            else
            {
                int attempt = (_attempts.TryGetValue(relUrl, out int prior) ? prior : 0) + 1;
                if (AssetFetchPolicy.ShouldRetry(result, code, attempt))
                {
                    _attempts[relUrl] = attempt;
                    _queue.Enqueue(relUrl); // keep _loading + waiters; bounded by MaxAttempts x Timeout
                    GD.PrintErr($"M1C_FONT: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
                }
                else
                {
                    _loading.Remove(relUrl);
                    _attempts.Remove(relUrl);
                    _failed.Add(relUrl);
                    _waiters.Remove(relUrl); // a failed url never resolves — drop waiters (default theme font stays)
                    if (!_loggedFallback)
                    {
                        _loggedFallback = true;
                        GD.PrintErr($"M1C_FONT: fetch failed {url} result={result} code={code} len={body.Length} — " +
                                    "text falls back to the default theme font.");
                    }
                }
            }

            Pump();
        };

        Error err = req.Request(url);
        if (err != Error.Ok)
        {
            GD.PrintErr($"M1C_FONT: request start failed {url}: {err}");
            req.QueueFree();
            _inFlight--;
            _loading.Remove(relUrl);
            _failed.Add(relUrl);
            _waiters.Remove(relUrl);
            Pump();
        }
    }

    // Cache the decoded font, settle its waiters. Shared by the cache-hit + HTTP paths.
    private void OnFontReady(string relUrl, FontFile font)
    {
        _cache[relUrl] = font;
        Fetched++;
        if (_waiters.Remove(relUrl, out var list))
        {
            foreach (var cb in list)
            {
                cb(font);
            }
        }
    }

    // Wrap the raw .ttf/.otf bytes in a dynamic FontFile. Setting Data loads the font (equivalent to
    // load_dynamic_font from a buffer); an invalid blob yields a nameless font we treat as a failure so the label
    // keeps the default theme font.
    private static FontFile? Decode(byte[] body)
    {
        try
        {
            var font = new FontFile { Data = body };
            return string.IsNullOrEmpty(font.GetFontName()) ? null : font;
        }
        catch (Exception e)
        {
            GD.PrintErr($"M1C_FONT: font decode failed: {e.Message}");
            return null;
        }
    }
}
