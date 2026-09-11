// WS-ATLAS: decode-once HTTP cache for standalone AtlasTexture `.tres` NODE textures (relic icons, intent icons) —
// the node-texture analog of MaterialSamplerStore. A Sprite2D/TextureRect whose texture is a standalone AtlasTexture
// `.tres` streams its `res://…tres` path but NO region on the wire. Today MirrorNodeView asks the host to crop it
// per-sprite (`GET <x>.tres?format=png`). This store instead fetches the `.tres` TEXT once (raw `/res` route, disk-
// cache backed like the sibling stores), parses out the atlas PAGE path + region + margin via the pure
// AtlasTextureResourceParser, and hands MirrorNodeView the page url + region/margin so the client downloads the page
// ONCE (TextureStore, decode-once) and crops each sprite locally via TextureDrawer.DrawAtlasRegion.
//
// Parse failure or a NON-atlas `.tres` (some other Texture2D resource, or an embedded sub-resource atlas the /res
// route can't crop independently) → terminal FAIL: MirrorNodeView keeps today's `?format=png` server crop. So a
// poisoned/unexpected body never blanks a texture — it just falls back to the proven raster ask.
//
// Self-mounting singleton (mirrors MaterialSamplerStore, cannot edit AppShell's stage builder): on first use it finds
// the mounted TextureStore, copies its BaseUrl, parents under it, and registers in AssetStores (Label "atlas-tres")
// so the --shot settle gate waits until every requested `.tres` is parsed-or-failed AND its page has decoded.

using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class AtlasTresStore : Node, IAssetIdleSource
{
    // Per-resPath parse state. Absent = never requested; Pending = fetching; Ready = parsed atlas doc available;
    // Failed = fetch/parse produced no croppable atlas (caller keeps the server crop — today's rendering).
    private enum TresState
    {
        Pending,
        Ready,
        Failed,
    }

    private const int MaxInFlight = 4;

    private static AtlasTresStore? _instance;

    public string BaseUrl { get; private set; } = "";

    private readonly Dictionary<string, TresState> _state = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ParsedAtlasTexture> _parsed = new(StringComparer.Ordinal);
    // onSettled callbacks fire ONCE when a resPath reaches a TERMINAL state (Ready OR Failed) so MirrorNodeView can
    // either apply the client crop or fall back to the server crop — unlike MaterialSamplerStore, which only fires on
    // Ready (its callers keep the shader default on Failed without re-resolving).
    private readonly Dictionary<string, List<Action>> _waiters = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);
    private readonly Queue<FetchJob> _queue = new();
    private int _inFlight;
    private int _pendingCount;

    public long ParsedCount { get; private set; }
    public long FailedCount { get; private set; }

    public int PendingCount => _pendingCount;
    public bool Idle => _pendingCount == 0 && _inFlight == 0 && _queue.Count == 0;
    public string Label => "atlas-tres";

    // Get-or-create the process singleton, hosted under the mounted TextureStore (BaseUrl copied, no AppShell edit).
    public static AtlasTresStore For(Node context)
    {
        if (_instance is not null && GodotObject.IsInstanceValid(_instance))
        {
            return _instance;
        }

        var store = new AtlasTresStore { Name = "__atlasTresStore" };

        var tree = context.GetTree();
        TextureStore? textures = tree is not null ? FindTextureStore(tree.Root) : null;
        if (textures is not null)
        {
            store.BaseUrl = textures.BaseUrl.TrimEnd('/');
            textures.AddChild(store);
        }
        else
        {
            store.BaseUrl = (System.Environment.GetEnvironmentVariable("COUCHCOOP_ASSETS_BASE") ?? "").TrimEnd('/');
            GD.PrintErr("ATLASTRES: no TextureStore found in tree — using COUCHCOOP_ASSETS_BASE fallback " +
                        $"base='{store.BaseUrl}' (atlas `.tres` crops will fail if empty).");
            (tree?.Root ?? context).AddChild(store);
        }

        _instance = store;
        AssetStores.Register(store);
        return store;
    }

    // Drop the process singleton (AppShell.ReturnToMenu). The node frees with the render stage (it parents under
    // TextureStore); nulling the static ref stops static peeks serving the OLD stage's caches.
    public static void ResetInstance() => _instance = null;

    // The parsed atlas doc for `resPath` when Ready, else null (never requested / pending / failed).
    public ParsedAtlasTexture? Peek(string resPath) =>
        _state.TryGetValue(resPath, out var s) && s == TresState.Ready &&
        _parsed.TryGetValue(resPath, out var doc)
            ? doc
            : null;

    // True when `resPath` reached a TERMINAL failure (parse produced no croppable atlas) — the caller then keeps the
    // server crop and never asks again.
    public bool PeekFailed(string resPath) =>
        _state.TryGetValue(resPath, out var s) && s == TresState.Failed;

    // Ensure the `.tres` at `resPath` (a raw `res://…tres` path) is being (or has been) fetched+parsed. `onSettled`
    // fires ONCE if/when it reaches a terminal state (Ready or Failed); it does NOT fire for an already-terminal
    // resPath (the caller consults Peek/PeekFailed synchronously first). Idempotent per resPath.
    public void Request(string resPath, Action onSettled)
    {
        if (_state.TryGetValue(resPath, out var st))
        {
            if (st == TresState.Pending)
            {
                AddWaiter(resPath, onSettled);
            }

            return; // Ready / Failed are terminal (caller already peeked)
        }

        _state[resPath] = TresState.Pending;
        _pendingCount++;
        AddWaiter(resPath, onSettled);

        // `resPath` is MirrorNodeView's `want` == node.TextureUrl, which SceneDeltaReader ALREADY mapped through
        // MirrorResourceUrl (a `/res/…` route path), so it is the fetch relUrl verbatim — do NOT re-map it (that
        // doubled it to `/res//res/…` → 404). The atlas PAGE path (a raw `res://…png` from the `.tres`) is the one
        // that still needs MirrorResourceUrl, and MirrorNodeView.ApplyAtlasCrop maps that.
        EnqueueFetch(resPath, body => OnBody(resPath, body));
    }

    private void AddWaiter(string resPath, Action onSettled)
    {
        if (!_waiters.TryGetValue(resPath, out var list))
        {
            list = new List<Action>();
            _waiters[resPath] = list;
        }

        list.Add(onSettled);
    }

    private void OnBody(string resPath, string? body)
    {
        if (body is null)
        {
            Fail(resPath, "fetch failed");
            return;
        }

        ParsedAtlasTexture? parsed;
        try
        {
            parsed = AtlasTextureResourceParser.Parse(body);
        }
        catch (Exception e)
        {
            Fail(resPath, $"parse threw: {e.Message}");
            return;
        }

        if (parsed is null)
        {
            // Not a standalone AtlasTexture (some other `.tres`, an embedded sub-resource atlas, or a raster body a
            // poisoned host cached under the raw key) — terminal FAIL so MirrorNodeView keeps the `?format=png`
            // server crop and never re-fetches.
            Fail(resPath, "not a croppable standalone AtlasTexture");
            return;
        }

        _parsed[resPath] = parsed;
        Transition(resPath, TresState.Ready);
        ParsedCount++;
        GD.Print($"ATLASTRES: parsed {resPath} → page={parsed.AtlasPath} region=({parsed.Region.X},{parsed.Region.Y},{parsed.Region.Width},{parsed.Region.Height}) margin=({parsed.Margin.X},{parsed.Margin.Y},{parsed.Margin.Width},{parsed.Margin.Height})");
        FireWaiters(resPath);
    }

    private void Fail(string resPath, string reason)
    {
        Transition(resPath, TresState.Failed);
        FailedCount++;
        _parsed.Remove(resPath);
        GD.PrintErr($"ATLASTRES: failed {resPath} ({reason}) — keeping server crop");
        FireWaiters(resPath); // fire so the caller can fall back to the server crop
    }

    private void Transition(string resPath, TresState next)
    {
        if (_state.TryGetValue(resPath, out var prev) && prev == TresState.Pending &&
            (next == TresState.Ready || next == TresState.Failed))
        {
            _pendingCount--;
        }

        _state[resPath] = next;
    }

    private void FireWaiters(string resPath)
    {
        if (_waiters.Remove(resPath, out var list))
        {
            foreach (var cb in list)
            {
                cb();
            }
        }
    }

    // ---- fetch pipeline (disk-cache backed, mirrors MaterialSamplerStore.Fetch) --------------------------------

    private readonly record struct FetchJob(string RelUrl, Action<string?> OnBody);

    private void EnqueueFetch(string relUrl, Action<string?> onBody)
    {
        _queue.Enqueue(new FetchJob(relUrl, onBody));
        Pump();
    }

    private void Pump()
    {
        while (_inFlight < MaxInFlight && _queue.Count > 0)
        {
            _inFlight++;
            Fetch(_queue.Dequeue());
        }
    }

    private void Fetch(FetchJob job)
    {
        var cached = AssetDiskCache.Read(job.RelUrl);
        if (cached is not null)
        {
            if (cached.Length > 0)
            {
                AssetDiskCache.CountHit();
                _inFlight--;
                job.OnBody(System.Text.Encoding.UTF8.GetString(cached));
                Pump();
                return;
            }

            AssetDiskCache.Shared?.DeleteEntry(job.RelUrl);
        }

        var req = new HttpRequest { UseThreads = true, Timeout = AssetFetchPolicy.TimeoutSeconds(30) };
        AddChild(req);
        string url = BaseUrl + job.RelUrl;
        req.RequestCompleted += (result, code, _, respBody) =>
        {
            req.QueueFree();
            _inFlight--;

            string? text = null;
            if (result == (long)HttpRequest.Result.Success && code >= 200 && code < 300 && respBody.Length > 0)
            {
                text = System.Text.Encoding.UTF8.GetString(respBody);
                AssetDiskCache.Write(job.RelUrl, respBody);
            }

            if (text is null)
            {
                int attempt = (_attempts.TryGetValue(job.RelUrl, out int prior) ? prior : 0) + 1;
                if (AssetFetchPolicy.ShouldRetry(result, code, attempt))
                {
                    _attempts[job.RelUrl] = attempt;
                    _queue.Enqueue(job);
                    GD.PrintErr($"ATLASTRES: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
                    Pump();
                    return;
                }

                _attempts.Remove(job.RelUrl);
            }
            else
            {
                _attempts.Remove(job.RelUrl);
            }

            job.OnBody(text);
            Pump();
        };

        Error err = req.Request(url);
        if (err != Error.Ok)
        {
            GD.PrintErr($"ATLASTRES: request start failed {url}: {err}");
            req.QueueFree();
            _inFlight--;
            job.OnBody(null);
            Pump();
        }
    }

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
}
