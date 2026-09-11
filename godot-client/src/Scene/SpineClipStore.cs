// Decode-once, live-host-POLITE Spine-clip cache for the M1d native mirror (WS-I) — the spine analog of
// TextureStore/FontStore. A SpineSprite mirror node has no texture; its sole visual is a baked animation clip
// streamed from `GET /spines/<scene>?node=&anim=` (SPCL v1). This store builds that URL exactly like the web's
// spineAttributes.ts, fetches the blob, PARSES + IMAGE-DECODES it OFF the main thread, then PUMPS the per-frame
// ImageTexture creation (GPU upload) onto the MAIN thread and hands the decoded clip to waiters.
//
// THREADING: SpineClip.Parse (pure managed) + per-frame Image decode run OFF the main thread (Task.Run) — Image
// CPU decode is thread-safe in Godot (verified: off-thread decode raises no thread-guard, only codec errors when
// mis-sniffed). ImageTexture.CreateFromImage (GPU upload) MUST run on the main thread, so it's drained in
// _Process, INCREMENTALLY (a few frames per tick) to bound the per-clip upload hitch.
//
// CODEC: the SPCL wire is codec-agnostic — a frame's image blob is PNG or WEBP (the host may flip either). Each
// frame is sniffed by magic (RIFF…WEBP vs PNG) and decoded with the matching loader — the same contract as
// TextureStore.Decode. (Missing this sniff = ERR_FILE_CORRUPT on WEBP frames = blank.)
//
// LIVE-HOST PROTECTION (load-bearing): a /spines fetch triggers a real offscreen render INSIDE the game, and a
// known crash exists under hammered renders. So this store fetches at MOST ONE clip at a time (MaxInFlight = 1)
// with a >=250ms floor between fetch STARTS — deliberately slower than TextureStore's 6-wide pump.
//
// FAILURE POLICY: a failed fetch/decode is NOT cached and NOT permanently blacklisted — its waiters are dropped,
// so a LATER Request for the same url retries. No tight loop because SpineAttachment only (re)requests on an
// anim-NAME change, never every Sync. Mirrors the web's loadSpineClip dropping the cache entry on failure.
//
// Self-mounting singleton (FontStore pattern): finds the mounted TextureStore in the tree for BaseUrl and parents
// itself under it; registered with AssetStores (Label "spine") so the --shot settle gate waits for clips to BUILD.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class SpineClipStore : Node, IAssetIdleSource
{
    private const int MaxCachedClips = 24;
    private const int MaxInFlight = 1;
    private const double MinSpacingMs = 250;

    // Per-tick main-thread ImageTexture-upload budget: bounds the GPU-upload hitch when a multi-frame clip arrives.
    private const int MaxFramesPerTick = 8;

    private static SpineClipStore? _instance;

    // "http://host:port" (no trailing slash) — the `/spines/...` relUrl is appended verbatim.
    public string BaseUrl { get; private set; } = "";

    // A decoded clip: the parsed metadata + one ImageTexture per frame (null for a frame whose blob failed decode).
    public sealed class LoadedClip
    {
        public required SpineClip Clip;
        public required ImageTexture?[] Frames;

        // #14: the host answered with a SINGLE-FRAME stand-in because the machine was oversubscribed
        // (X-Spine-Degraded), not with the clip we asked for. Such a clip is painted (better than nothing) but
        // never persisted — not in this store's LRU and not in AssetDiskCache — so the next request for the same
        // identity re-asks the host and gets the real bake once the pressure drops. It also must never trigger the
        // #4 &retry=1 escalation (SpineClipEscalation).
        public bool Temporary;
    }

    private readonly Dictionary<string, LoadedClip> _cache = new(StringComparer.Ordinal);
    private readonly List<string> _lru = new(); // recency: [0] = least-recently-used, [^1] = most-recent
    private readonly HashSet<string> _loading = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action<LoadedClip>>> _waiters = new(StringComparer.Ordinal);
    // WS-spine #8: per-url FAILURE callbacks (default none). A permanent fetch/decode failure fires these so the
    // SpineLayer can run its one-shot `&skel=` skeleton-fallback retry; success clears them alongside _waiters.
    private readonly Dictionary<string, List<Action>> _failWaiters = new(StringComparer.Ordinal);
    private readonly Queue<string> _queue = new();
    // Transient-retry bookkeeping (missing-textures fix 2026-07-19) — see TextureStore._attempts. Especially
    // load-bearing here: this store has ONE in-flight slot, so a single wedged request used to starve every clip.
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);

    // Off-thread decode outputs (parsed clip + per-frame CPU Images) awaiting main-thread texture upload.
    private readonly ConcurrentQueue<DecodeResult> _decoded = new();

    // Clips whose textures are being incrementally uploaded on the main thread.
    private readonly List<BuildJob> _building = new();

    private int _inFlight;   // HTTP fetches in flight (0 or 1)
    private int _decoding;   // off-thread decode tasks started but not yet drained (main-thread mutated only)
    private double _lastFetchStartMs = double.NegativeInfinity;
    private bool _loggedReal;
    private bool _loggedFail;

    public long Fetched { get; private set; }

    // IAssetIdleSource. PendingCount stays > 0 until every requested clip's ImageTextures are fully BUILT — the
    // --shot settle gate blocks on this (queued OR in-flight OR decoding OR still-uploading all count as pending).
    public string Label => "spine";
    public int PendingCount => _queue.Count + _inFlight + _decoding + _building.Count;
    public bool Idle => PendingCount == 0;

    private sealed class DecodeResult
    {
        public required string RelUrl;
        public SpineClip? Clip;
        public Image?[]? Images;
        public bool Failed;
        public string? Error;
        public bool Temporary; // host-declared single-frame stand-in — never persisted
    }

    private sealed class BuildJob
    {
        public required string RelUrl;
        public required SpineClip Clip;
        public required Image?[] Images;
        public required ImageTexture?[] Frames;
        public int Next; // next frame index to upload
        public bool Temporary; // carried through from the fetch so FinalizeJob can skip the cache
    }

    // Get-or-create the process singleton, mounted under the tree's TextureStore for BaseUrl + processing.
    public static SpineClipStore For(Node context)
    {
        if (_instance is not null && GodotObject.IsInstanceValid(_instance))
        {
            return _instance;
        }

        var store = new SpineClipStore { Name = "__spineClipStore" };

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
            GD.PrintErr("SPINE: no TextureStore in tree — using COUCHCOOP_ASSETS_BASE fallback " +
                        $"base='{store.BaseUrl}' (clips will fail if empty).");
            (tree?.Root ?? context).AddChild(store);
        }

        _instance = store;
        AssetStores.Register(store); // --shot settle gate now waits on spine clips too
        return store;
    }

    // Drop the process singleton (AppShell.ReturnToMenu teardown). The node is freed with the render stage; nulling
    // the static ref stops it pinning the old stage's decoded clip cache until the next stage's first For() call.
    public static void ResetInstance() => _instance = null;

    // #13 SKEL-REQUIRED MEMO. Scene addresses (scene|nodePath) whose scene-addressed clip render is known to fail
    // offline because the game injects the skeleton at RUNTIME — the treasure chest, the boss map point (their
    // .tscn carries no `skeleton_data_res`, so the extractor finds no skeleton to drive). Learned the first time a
    // `&skel=` retry succeeds for that address, then reused so every LATER request for it (including the cheap
    // still-first placeholder) goes straight to the working url instead of burning two failed round-trips through
    // the host's single extraction slot first. Process-wide + never cleared: the answer is a property of the .tscn.
    private static readonly HashSet<string> SkelRequiredAddresses = new(StringComparer.Ordinal);

    private static string AddressKey(string? scene, string? nodePath) => $"{scene}|{nodePath}";

    public static void MarkSkelRequired(string? scene, string? nodePath)
    {
        if (!string.IsNullOrEmpty(scene))
        {
            SkelRequiredAddresses.Add(AddressKey(scene, nodePath));
        }
    }

    public static bool IsSkelRequired(string? scene, string? nodePath)
        => !string.IsNullOrEmpty(scene) && SkelRequiredAddresses.Contains(AddressKey(scene, nodePath));

    // The `/spines/<scene-no-res>?node=<rel>&anim=<name>` relUrl for a node's CURRENT anim, or null when the node
    // isn't a playable spine node. Port of spineAttributes.ts spineClipUrl (NO fps/still params). Note:
    // Uri.EscapeDataString (RFC 3986) vs JS encodeURIComponent differ only on !*'() — none occur in scene/node/
    // anim identifiers, so the minted url is byte-identical to the web's (the host keys the same canonical clip).
    public static string? BuildClipUrl(MirrorNode node) =>
        BuildClipUrl(node.SpineSceneResPath, node.SpineNodePath, node.SpineCurrentAnim, node.SpineSkin, null, retry: false, mat: node.SpineMat);

    // The clip relUrl from explicit identity fields, with the OPTIONAL WS-spine selectors. Selector order matches the
    // host's BuildSpineKey (node → anim → skin → mat → skel → retry); the host appends the size policy + still
    // server-side. `skin` (#3) folds the runtime skin into the identity; `mat` (#8) folds the shader material the
    // bake applies to a standalone-skeleton render (the boss map point's channel-remap mask, re-tinted per act +
    // travel state); `skel` is the one-shot skeleton retry; `retry=1` requests a fresh extraction after a temporary
    // degraded response. FIX 2b: `still` forces the trailing `&still=1` so the layer can fetch a still-first
    // placeholder ahead of the full animated clip.
    public static string? BuildClipUrl(string? scene, string? nodePath, string? anim, string? skin, string? skel, bool retry, bool still = false, string? mat = null)
    {
        if (string.IsNullOrEmpty(scene) || string.IsNullOrEmpty(anim) || !scene.StartsWith("res://", StringComparison.Ordinal))
        {
            return null;
        }

        var scenePath = string.Join("/", scene.Substring("res://".Length).Split('/').Select(Uri.EscapeDataString));
        var selectors = new List<string>(5);
        if (!string.IsNullOrEmpty(nodePath))
        {
            selectors.Add($"node={Uri.EscapeDataString(nodePath)}");
        }

        selectors.Add($"anim={Uri.EscapeDataString(anim)}");
        if (!string.IsNullOrEmpty(skin))
        {
            selectors.Add($"skin={Uri.EscapeDataString(skin)}");
        }

        if (!string.IsNullOrEmpty(mat))
        {
            selectors.Add($"mat={Uri.EscapeDataString(mat)}");
        }

        if (!string.IsNullOrEmpty(skel))
        {
            selectors.Add($"skel={Uri.EscapeDataString(skel)}");
        }

        if (retry)
        {
            selectors.Add("retry=1");
        }

        var query = string.Join("&", selectors);
        // The still marker is appended AFTER the selectors (byte-identical to the web's spineClipUrl `${still}` tail).
        return still ? $"/spines/{scenePath}?{query}&still=1" : $"/spines/{scenePath}?{query}";
    }

    // Request the decoded clip at `relUrl`. Returns it synchronously when cached (LRU-touched); otherwise returns
    // null and fires `onReady` once the fetch+decode+upload settles. `onFailed` (optional) fires ONCE if the url
    // permanently fails to fetch/decode (never on success). Coalesces duplicate concurrent requests for one url onto
    // a single fetch.
    public LoadedClip? Request(string relUrl, Action<LoadedClip> onReady, Action? onFailed = null)
    {
        if (_cache.TryGetValue(relUrl, out var clip))
        {
            Touch(relUrl);
            return clip;
        }

        if (!_waiters.TryGetValue(relUrl, out var list))
        {
            list = new List<Action<LoadedClip>>();
            _waiters[relUrl] = list;
        }

        list.Add(onReady);

        if (onFailed is not null)
        {
            if (!_failWaiters.TryGetValue(relUrl, out var failList))
            {
                failList = new List<Action>();
                _failWaiters[relUrl] = failList;
            }

            failList.Add(onFailed);
        }

        if (_loading.Add(relUrl))
        {
            _queue.Enqueue(relUrl); // PumpFetch (in _Process) starts it, honoring MaxInFlight + spacing
        }

        return null;
    }

    // Fire + clear the per-url failure callbacks (a permanent fetch/decode failure). Removes the list before invoking
    // so a callback that re-Requests a DIFFERENT url (the &skel= retry) can't recurse into this url's list.
    private void FireFailed(string relUrl)
    {
        if (_failWaiters.Remove(relUrl, out var list))
        {
            foreach (var cb in list)
            {
                cb();
            }
        }
    }

    public override void _Process(double delta)
    {
        // Phase 1: drain finished off-thread DECODES into main-thread upload jobs (or record a failure).
        while (_decoded.TryDequeue(out var r))
        {
            _decoding--;

            if (r.Failed || r.Clip is null || r.Images is null)
            {
                if (!_loggedFail)
                {
                    _loggedFail = true;
                    GD.PrintErr($"SPINE: clip decode failed {r.RelUrl}: {r.Error} — node stays blank (a later anim retries).");
                }

                AssetDiskCache.Shared?.DeleteEntry(r.RelUrl); // WS-U self-heal: a cache-sourced blob that failed to
                                                              // decode is poisoned (no-op for a network-sourced fail).
                _waiters.Remove(r.RelUrl); // not cached → a later Request re-fetches (no tight loop: only anim change re-requests)
                FireFailed(r.RelUrl); // WS-spine #8: a permanent decode failure arms the SpineLayer's skel-fallback retry
                continue;
            }

            _building.Add(new BuildJob
            {
                RelUrl = r.RelUrl,
                Clip = r.Clip,
                Images = r.Images,
                Frames = new ImageTexture?[r.Images.Length],
                Temporary = r.Temporary,
            });
        }

        // Phase 2: incrementally UPLOAD the decoded Images to ImageTextures on the MAIN thread (bounded per tick).
        BuildTextures();

        // Phase 3: start the next fetch (honors MaxInFlight + spacing).
        PumpFetch();
    }

    private void BuildTextures()
    {
        int budget = MaxFramesPerTick;
        for (int j = 0; j < _building.Count && budget > 0;)
        {
            var job = _building[j];
            while (job.Next < job.Frames.Length && budget > 0)
            {
                job.Frames[job.Next] = job.Images[job.Next] is { } img ? ImageTexture.CreateFromImage(img) : null;
                job.Next++;
                budget--;
            }

            if (job.Next >= job.Frames.Length)
            {
                FinalizeJob(job);
                _building.RemoveAt(j); // completed — don't advance j (the next job shifted into this slot)
            }
            else
            {
                j++;
            }
        }
    }

    private void FinalizeJob(BuildJob job)
    {
        var loaded = new LoadedClip { Clip = job.Clip, Frames = job.Frames, Temporary = job.Temporary };
        if (job.Temporary)
        {
            // #14: a degraded clip is the host's "not right now" answer, not this identity's content. Handing it to
            // the waiters is right (paint SOMETHING), caching it is not: the LRU would keep answering with the
            // stand-in long after the host recovered. Leaving it out makes the next Request re-ask the host.
            _cache.Remove(job.RelUrl);
            _lru.Remove(job.RelUrl);
        }
        else
        {
            CachePut(job.RelUrl, loaded);
        }

        Fetched++;

        if (!_loggedReal)
        {
            _loggedReal = true;
            GD.Print($"SPINE: clip loaded {job.RelUrl} frames={job.Clip.Frames.Count} " +
                     $"canvas={job.Clip.CanvasWidth}x{job.Clip.CanvasHeight} " +
                     $"local=({job.Clip.LocalX:F0},{job.Clip.LocalY:F0},{job.Clip.LocalWidth:F0},{job.Clip.LocalHeight:F0}) " +
                     $"fps~{job.Clip.ApproxFps():F1}");
        }

        _failWaiters.Remove(job.RelUrl); // resolved successfully → drop the failure callbacks (they never fire)
        if (_waiters.Remove(job.RelUrl, out var list))
        {
            foreach (var cb in list)
            {
                cb(loaded);
            }
        }
    }

    private void PumpFetch()
    {
        if (_inFlight >= MaxInFlight || _queue.Count == 0)
        {
            return;
        }

        // WS-U disk cache: a cache hit needs NO live-host render, so serve it immediately (bypassing the fetch-spacing
        // floor) through the SAME off-thread decode path. A cache-sourced decode failure self-heals in _Process phase 1
        // (DeleteEntry + a later Request re-fetches). An EMPTY entry is corrupt → delete + fall through to a real fetch.
        var peek = _queue.Peek();
        var cached = AssetDiskCache.Read(peek);
        if (cached is not null)
        {
            if (cached.Length > 0)
            {
                _queue.Dequeue();
                _loading.Remove(peek);
                AssetDiskCache.CountHit();
                _decoding++;
                Task.Run(() => _decoded.Enqueue(DecodeOffThread(peek, cached)));
                return;
            }

            AssetDiskCache.Shared?.DeleteEntry(peek); // empty/poisoned entry — re-fetch over HTTP
        }

        double now = Time.GetTicksMsec();
        if (now - _lastFetchStartMs < MinSpacingMs)
        {
            return; // politeness floor between fetch STARTS (live-host protection)
        }

        _lastFetchStartMs = now;
        _inFlight++;
        Fetch(_queue.Dequeue());
    }

    private void Fetch(string relUrl)
    {
        // Timeout + transient retry (missing-textures fix 2026-07-19) — see TextureStore.Fetch. 60s (not 30):
        // clips are multi-MB and this is the single-slot store where a wedge is fatal.
        var req = new HttpRequest { UseThreads = true, Timeout = AssetFetchPolicy.TimeoutSeconds(60) };
        AddChild(req);
        string url = BaseUrl + relUrl;
        req.RequestCompleted += (result, code, headers, body) =>
        {
            req.QueueFree();
            _inFlight--;

            if (result == (long)HttpRequest.Result.Success && code >= 200 && code < 300 && body.Length > 0)
            {
                _loading.Remove(relUrl);
                _attempts.Remove(relUrl);
                // #14: X-Spine-Degraded marks a single-frame stand-in the host served INSTEAD of baking, because the
                // machine was oversubscribed. It answers this url only for right now, so it must never reach the
                // durable disk cache (which is keyed by url and would pin the stand-in across restarts).
                var temporary = HasTemporaryHeader(headers);
                if (!temporary)
                {
                    AssetDiskCache.Write(relUrl, body); // WS-U write-through the fetched clip bytes (counts miss+write)
                }

                _decoding++;
                var bytes = body; // captured for the off-thread decode task
                Task.Run(() => _decoded.Enqueue(DecodeOffThread(relUrl, bytes, temporary)));
            }
            else
            {
                int attempt = (_attempts.TryGetValue(relUrl, out int prior) ? prior : 0) + 1;
                if (AssetFetchPolicy.ShouldRetry(result, code, attempt))
                {
                    _attempts[relUrl] = attempt;
                    _queue.Enqueue(relUrl); // keep _loading + waiters; the spacing floor paces the re-attempt
                    GD.PrintErr($"SPINE: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
                }
                else
                {
                    _loading.Remove(relUrl);
                    _attempts.Remove(relUrl);
                    if (!_loggedFail)
                    {
                        _loggedFail = true;
                        GD.PrintErr($"SPINE: clip fetch failed {url} result={result} code={code} len={body.Length}");
                    }

                    _waiters.Remove(relUrl); // failed url never resolves; a later request retries
                    FireFailed(relUrl); // WS-spine #8: arm the SpineLayer's skel-fallback retry
                }
            }

            // Next fetch starts on the following _Process (honors spacing).
        };

        Error err = req.Request(url);
        if (err != Error.Ok)
        {
            GD.PrintErr($"SPINE: request start failed {url}: {err}");
            req.QueueFree();
            _inFlight--;
            _loading.Remove(relUrl);
            _waiters.Remove(relUrl);
            FireFailed(relUrl); // WS-spine #8: arm the SpineLayer's skel-fallback retry
        }
    }

    // #14: does this response carry the host's degraded (single-frame stand-in) marker? Godot hands raw
    // "Name: value" header lines, so match the name case-insensitively up to the colon.
    internal static bool HasTemporaryHeader(string[]? headers)
    {
        if (headers is null)
        {
            return false;
        }

        foreach (var header in headers)
        {
            int colon = header.IndexOf(':');
            if (colon <= 0)
            {
                continue;
            }

            if (header.AsSpan(0, colon).Trim().Equals("X-Spine-Degraded", StringComparison.OrdinalIgnoreCase))
            {
                var value = header.AsSpan(colon + 1).Trim();
                return !value.IsEmpty && !value.Equals("0", StringComparison.Ordinal);
            }
        }

        return false;
    }

    // OFF-THREAD: SPCL parse + per-frame CPU Image decode (codec-sniffed). GPU upload (ImageTexture) is deferred to
    // the main-thread BuildTextures.
    private static DecodeResult DecodeOffThread(string relUrl, byte[] bytes, bool temporary = false)
    {
        try
        {
            var clip = SpineClip.Parse(bytes);
            var images = new Image?[clip.Frames.Count];
            for (int i = 0; i < clip.Frames.Count; i++)
            {
                images[i] = DecodeImage(clip.Frames[i].EncodedImage);
            }

            return new DecodeResult { RelUrl = relUrl, Clip = clip, Images = images, Temporary = temporary };
        }
        catch (Exception ex)
        {
            return new DecodeResult { RelUrl = relUrl, Failed = true, Error = ex.Message };
        }
    }

    // Sniff RIFF/WEBP vs PNG (the wire is codec-agnostic) and decode with the matching loader; null on failure.
    private static Image? DecodeImage(byte[] body)
    {
        var img = new Image();
        Error e;
        if (body.Length >= 12 && body[0] == 'R' && body[1] == 'I' && body[2] == 'F' && body[3] == 'F' &&
            body[8] == 'W' && body[9] == 'E' && body[10] == 'B' && body[11] == 'P')
        {
            e = img.LoadWebpFromBuffer(body);
        }
        else if (body.Length >= 8 && body[0] == 0x89 && body[1] == 'P' && body[2] == 'N' && body[3] == 'G')
        {
            e = img.LoadPngFromBuffer(body);
        }
        else
        {
            // Unknown magic — try PNG then WEBP (tolerant, like the codec-agnostic wire).
            e = img.LoadPngFromBuffer(body);
            if (e != Error.Ok)
            {
                e = img.LoadWebpFromBuffer(body);
            }
        }

        if (e != Error.Ok)
        {
            return null;
        }

        // T5b: mip the baked clip frame here, OFF the main thread (this whole method runs inside DecodeOffThread's
        // Task.Run alongside the per-frame Image decode) — mipgen is a pure-CPU downsample of the frame's own buffer,
        // the same class of self-contained Image op as the LoadWebp/Png decode already proven thread-safe here, so it
        // adds ZERO main-thread cost (the deferred CreateFromImage upload in BuildTextures just carries the mips it
        // already has). Best-effort: a non-Ok result leaves the frame un-mipped and it uploads its base level.
        img.GenerateMipmaps();

        // Track F1: pack the baked spine frame RGBA8 → 16-bit (RGB565 / RGBA4444, ordered-dithered) here on the
        // decode worker, after mipgen so the Convert carries the mip chain (see Tex16Convert). Same off-thread,
        // self-contained Image / byte work as the LoadWebp/Png + GenerateMipmaps above; the deferred main-thread
        // CreateFromImage (BuildTextures) just uploads the finished 16-bit frame.
        Tex16Convert.ToPacked16(img);

        return img;
    }

    private void Touch(string relUrl)
    {
        _lru.Remove(relUrl);
        _lru.Add(relUrl);
    }

    private void CachePut(string relUrl, LoadedClip clip)
    {
        _cache[relUrl] = clip;
        Touch(relUrl);
        while (_cache.Count > MaxCachedClips && _lru.Count > 0)
        {
            var oldest = _lru[0];
            _lru.RemoveAt(0);
            _cache.Remove(oldest); // ImageTextures are RefCounted — dropping the ref frees them
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
