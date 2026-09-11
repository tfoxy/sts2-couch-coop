// WS-EMITTER: decode-once HTTP cache for material `.tres` SAMPLER sub-resources — the sampler analog of ShaderStore.
// A particle/shader emitter's ShaderMaterial reads `uniform sampler2D` textures (an erosion CurveTexture, a color
// GradientTexture) that live as `[sub_resource]` blocks INSIDE the material `.tres`; those stream as NULL on the wire
// (ShaderResourceParser.ParseDefaultValue skips SubResource refs). This store fetches each distinct material `.tres`
// FULL TEXT once (raw `/res` route, disk-cache backed like the sibling stores), parses its sampler sub-resources via
// the pure ShaderResourceParser.ParseMaterialSamplers, and lazily bakes the CurveTexture/GradientTexture the shader
// reads (ParticleTextureBuilders). ParticleLayer binds them onto the emitter's ShaderMaterial by SubResource id.
//
// Self-mounting singleton (mirrors ShaderStore, cannot edit AppShell): on first use it finds the mounted TextureStore,
// copies its BaseUrl, parents under it, and registers in AssetStores (Label "material-samplers") so the --shot settle
// gate waits until every requested material is parsed-or-failed.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class MaterialSamplerStore : Node, IAssetIdleSource
{
    // Per-materialRef parse state. Absent = never requested; Pending = fetching; Ready = parsed (samplers available);
    // Failed = fetch/parse produced nothing (the emitter keeps the shader's own sampler defaults — today's rendering).
    private enum MatState
    {
        Pending,
        Ready,
        Failed,
    }

    private const int MaxInFlight = 4;

    private static MaterialSamplerStore? _instance;

    public string BaseUrl { get; private set; } = "";

    private readonly Dictionary<string, MatState> _state = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ParsedMaterialSamplers> _parsed = new(StringComparer.Ordinal);
    // Built sampler textures, keyed "materialRef::subId" so distinct emitter materials referencing the same sampler
    // share ONE baked CurveTexture/GradientTexture (bounded; disposed with the store node on back-to-menu).
    private readonly Dictionary<string, Texture2D> _textures = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action>> _waiters = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);
    private readonly Queue<FetchJob> _queue = new();
    private int _inFlight;
    private int _pendingCount;

    public long ParsedCount { get; private set; }
    public long FailedCount { get; private set; }

    public int PendingCount => _pendingCount;
    public bool Idle => _pendingCount == 0 && _inFlight == 0 && _queue.Count == 0;
    public string Label => "material-samplers";

    // Get-or-create the process singleton, hosted under the mounted TextureStore (BaseUrl copied, no AppShell edit).
    public static MaterialSamplerStore For(Node context)
    {
        if (_instance is not null && GodotObject.IsInstanceValid(_instance))
        {
            return _instance;
        }

        var store = new MaterialSamplerStore { Name = "__materialSamplerStore" };

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
            GD.PrintErr("MATSAMPLER: no TextureStore found in tree — using COUCHCOOP_ASSETS_BASE fallback " +
                        $"base='{store.BaseUrl}' (material samplers will fail if empty).");
            (tree?.Root ?? context).AddChild(store);
        }

        _instance = store;
        AssetStores.Register(store);
        return store;
    }

    // Drop the process singleton (AppShell.ReturnToMenu). The node frees with the render stage (it parents under
    // TextureStore); nulling the static ref stops the static peeks serving the OLD stage's caches. The next stage's
    // first For() rebuilds a fresh instance.
    public static void ResetInstance() => _instance = null;

    // Pure read: has this material's `.tres` parsed successfully (its samplers are buildable)? The emitter-shader
    // mount gate ANDs this with the shader being Mounted so the shared ShaderMaterial is only built once ALL its
    // sampler inputs are resolvable (keeping the shared material truly immutable — never mutated as samplers arrive).
    public static bool PeekReady(string materialRef) =>
        _instance is not null && _instance._state.TryGetValue(materialRef, out var s) && s == MatState.Ready;

    public static MaterialSamplerStore? Instance => _instance;

    // Ensure the material `.tres` for `materialRef` (a raw `res://…tres` path) is being (or has been) fetched+parsed.
    // `onReady` fires ONCE if/when it becomes Ready; not for an already-Ready/Failed material (caller consults
    // PeekReady). Idempotent per materialRef.
    public void Request(string materialRef, Action onReady)
    {
        if (_state.TryGetValue(materialRef, out var st))
        {
            if (st == MatState.Pending)
            {
                AddWaiter(materialRef, onReady);
            }

            return; // Ready / Failed are terminal
        }

        _state[materialRef] = MatState.Pending;
        _pendingCount++;
        AddWaiter(materialRef, onReady);

        if (materialRef.StartsWith("uid://", StringComparison.Ordinal))
        {
            Fail(materialRef, "uid:// unresolvable (no client uid→path table)");
            return;
        }

        EnqueueFetch(SceneDeltaReader.MirrorResourceUrl(materialRef), body => OnBody(materialRef, body));
    }

    // Get (building + caching on first use) the baked sampler Texture2D for `materialRef::subId`, or null when the
    // material is not parsed, the sub-resource is absent, or it is an Image kind (resolved via TextureStore by the
    // caller). Main-thread only (news a Godot Resource).
    public Texture2D? GetSamplerTexture(string materialRef, string subId)
    {
        string key = materialRef + "::" + subId;
        if (_textures.TryGetValue(key, out var cached) && GodotObject.IsInstanceValid(cached))
        {
            return cached;
        }

        if (!_parsed.TryGetValue(materialRef, out var parsed) || !parsed.BySubId.TryGetValue(subId, out var sampler))
        {
            return null;
        }

        var tex = ParticleTextureBuilders.BuildSamplerTexture(sampler);
        if (tex is not null)
        {
            _textures[key] = tex;
        }

        return tex;
    }

    private void AddWaiter(string materialRef, Action onReady)
    {
        if (!_waiters.TryGetValue(materialRef, out var list))
        {
            list = new List<Action>();
            _waiters[materialRef] = list;
        }

        list.Add(onReady);
    }

    private void OnBody(string materialRef, string? body)
    {
        if (body is null)
        {
            Fail(materialRef, "fetch failed");
            return;
        }

        ParsedMaterialSamplers parsed;
        try
        {
            parsed = ShaderResourceParser.ParseMaterialSamplers(body);
        }
        catch (Exception e)
        {
            Fail(materialRef, $"parse threw: {e.Message}");
            return;
        }

        if (parsed.BySubId.Count == 0)
        {
            // No materializable samplers (not a `.tres`, or none of the recognized families) — terminal FAIL so the
            // emitter falls back to the shader's own sampler defaults (exactly today's rendering) and never re-fetches.
            Fail(materialRef, "no materializable samplers");
            return;
        }

        _parsed[materialRef] = parsed;
        Transition(materialRef, MatState.Ready);
        ParsedCount++;
        GD.Print($"MATSAMPLER: parsed {materialRef} ({parsed.BySubId.Count} sampler(s): {string.Join(",", parsed.BySubId.Keys)})");
        FireWaiters(materialRef);
    }

    private void Fail(string materialRef, string reason)
    {
        Transition(materialRef, MatState.Failed);
        FailedCount++;
        _parsed.Remove(materialRef);
        _waiters.Remove(materialRef); // Failed never becomes Ready — drop the re-apply waiters
        GD.PrintErr($"MATSAMPLER: failed {materialRef} ({reason})");
    }

    private void Transition(string materialRef, MatState next)
    {
        if (_state.TryGetValue(materialRef, out var prev) && prev == MatState.Pending &&
            (next == MatState.Ready || next == MatState.Failed))
        {
            _pendingCount--;
        }

        _state[materialRef] = next;
    }

    private void FireWaiters(string materialRef)
    {
        if (_waiters.Remove(materialRef, out var list))
        {
            foreach (var cb in list)
            {
                cb();
            }
        }
    }

    // ---- fetch pipeline (disk-cache backed, mirrors ShaderStore.Fetch) -----------------------------------------

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
                    GD.PrintErr($"MATSAMPLER: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
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
            GD.PrintErr($"MATSAMPLER: request start failed {url}: {err}");
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
