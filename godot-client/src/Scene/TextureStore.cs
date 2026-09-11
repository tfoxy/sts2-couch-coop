// Decode-once HTTP texture cache for the native mirror renderer.
//
// The mirror wire ships texture paths already mapped to the host's `/res/...` route (SceneDeltaReader's
// MirrorResourceUrl). This store prepends the configured BaseUrl (the connect host, or --assets in replay), fetches
// each DISTINCT url exactly once (engine-native HttpRequest, no System.Net on the phone path), decodes it to one
// ImageTexture, and caches it. An ATLAS PAGE is therefore decoded ONCE and every atlas-region sprite crops it via
// DrawTextureRectRegion (atlasBaker's decode-once contract) — no per-sprite fetch, no per-frame page re-decode.
//
// Callers Request(url, onReady): the texture is returned synchronously when already cached, else onReady fires once
// the async fetch+decode settles (the node then QueueRedraws). Multiple nodes awaiting the same url share one fetch.
//
// THREADING (Track E): the bytes→Image codec decode + T5b mipgen run OFF the main thread (Task.Run) — the same
// self-contained Image ops SpineClipStore already runs off-thread (Godot Image decode/mipgen is thread-safe; only
// node access + the GPU upload aren't). The finished Image is marshalled back through a ConcurrentQueue drained in
// _Process, where ImageTexture.CreateFromImage (the main-thread-only GPU upload) runs and the page is registered.
// An in-flight decode holds its MaxInFlight pipeline slot (_inFlight counts fetch-OR-decode), so it still counts as
// busy for the --shot settle gate (AssetStores.AllIdle) and the pump stays bounded.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class TextureStore : Node, IAssetIdleSource
{
    // Max concurrent in-flight HTTP fetches. Keeps the phone's socket/most
    // pressure bounded while still saturating the combat texture set.
    private const int MaxInFlight = 6;

    // "http://host:port" (no trailing slash). The node's `/res/...`-prefixed url is appended verbatim.
    public string BaseUrl { get; set; } = "";

    // Track F2a: when true, this store requests `/res/...?fmt=astc` and takes the CCTX fast path (compressed upload,
    // no decode/mipgen). Resolved once in _Ready from the Android platform check and a RenderingDevice ASTC support
    // probe. Desktop uses the normal codec path.
    private bool _astc;

    private readonly Dictionary<string, ImageTexture> _cache = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Vector2I> _pageSizes = new(StringComparer.Ordinal);
    private readonly HashSet<string> _failed = new(StringComparer.Ordinal);
    private readonly HashSet<string> _loading = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action<ImageTexture>>> _waiters = new(StringComparer.Ordinal);
    private readonly Queue<string> _queue = new();
    // Failed-attempt count per in-flight url (missing-textures fix 2026-07-19): transient failures — timeouts,
    // connection errors, 429/5xx — re-enqueue up to AssetFetchPolicy.MaxAttempts instead of permanently blanking
    // the texture for the session. Cleared on success or permanent failure.
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);

    // Track E off-thread decode outputs (decoded CPU Image + provenance) awaiting the main-thread GPU upload. The
    // producer is the Task.Run worker (off-thread enqueue); the consumer is _Process (main-thread dequeue).
    private readonly ConcurrentQueue<DecodeResult> _decoded = new();

    // Decode-time art info per url — the image's alpha USED-RECT (Godot GetUsedRect: the smallest rect
    // containing every non-transparent pixel) + its intrinsic size, captured right after the codec load (BEFORE
    // mipgen and the 16-bit pack, which can drop the alpha channel). The TextOverlay's occluder-tightening sweep maps
    // this through a view's stretch mode into the tight DRAWN-ART box a textured blocker really covers (a TopBar room
    // icon streams no TextureRegion, so the planner cannot letterbox it from wire data alone). STATIC + concurrent:
    // written by the off-thread decode workers and the sync path alike, read on the main thread; url→art is stable
    // for a session, and entries are tiny. The scan is performed only for decodable source pixels.
    // The ASTC/CCTX fast path never records (compressed pixels are not scannable) — such a blocker conservatively
    // keeps its full layout-rect box.
    private static readonly ConcurrentDictionary<string, (Rect2I Used, Vector2I Size, Rect2I? Hole)> ArtInfo =
        new(StringComparer.Ordinal);

    // Skip the managed per-pixel scan above this many pixels (a 2048x2048 page); bigger pages fall back to the native
    // GetUsedRect (still useful) with no hole. Region'd mega-atlases never consume this info anyway.
    private const long ArtScanMaxPixels = 4_194_304;

    // WS-crisp2: a pixel counts as PAINTED only when its alpha byte is >= this threshold — for BOTH the used-rect and
    // the transparent-hole scan. Default 8/255 (~3%): a <=3%-alpha scrim band (a GradientTexture2D scroll-edge fade
    // that only APPROACHES 0 across its middle, never exactly 0) then reads as a transparent HOLE, so a crisp clone
    // rendering above it unchanged is imperceptible; the >=threshold fade near the edges keeps its opaque status so
    // edge cards/labels stay legitimately occluded.
    private const int ArtAlphaThreshold = 8;

    // Record `img`'s art info for `relUrl` (called right after a successful codec load on either path, BEFORE mipgen
    // and the 16-bit pack). Besides the alpha USED-RECT this also derives a transparent HOLE: the largest full-width
    // run of transparent rows (or full-height run of columns) — the shape of a scroll-edge fade gradient (a deck-dialog
    // `BorderGradient` is a 2x256 strip, opaque only at its extreme rows, stretched over the WHOLE dialog). A bounding
    // box cannot express "covers only the edges"; the hole lets the planner clear a label/card that sits entirely
    // inside the transparent middle. The pure ArtAlphaScan (threshold-aware; see ArtAlphaThreshold) does the scan so
    // the Exe suite covers the geometry without a Godot host — the hole never claims a >=threshold-alpha pixel.
    private static void RecordArtInfo(string? relUrl, Image img)
    {
        if (relUrl is null)
        {
            return;
        }

        var size = new Vector2I(img.GetWidth(), img.GetHeight());
        Rect2I used;
        Rect2I? hole = null;

        if (img.GetFormat() == Image.Format.Rgba8 && size.X > 0 && size.Y > 0
            && (long)size.X * size.Y <= ArtScanMaxPixels)
        {
            var (usedPx, holePx) = ArtAlphaScan.Scan(img.GetData(), size.X, size.Y, ArtAlphaThreshold);
            used = new Rect2I(usedPx.X, usedPx.Y, usedPx.Width, usedPx.Height);
            hole = holePx is { } hp ? new Rect2I(hp.X, hp.Y, hp.Width, hp.Height) : null;
        }
        else
        {
            used = img.GetUsedRect(); // native fallback (non-RGBA8 / oversized) — no hole
        }

        ArtInfo[relUrl] = (used, size, hole);
    }

    // The decode-time art info for `relUrl` (false when the url decoded via the compressed path / has not decoded).
    public bool TryGetArtInfo(string relUrl, out Rect2I usedPx, out Vector2I sizePx, out Rect2I? holePx)
    {
        if (ArtInfo.TryGetValue(relUrl, out var v))
        {
            usedPx = v.Used;
            sizePx = v.Size;
            holePx = v.Hole;
            return true;
        }

        usedPx = default;
        sizePx = default;
        holePx = null;
        return false;
    }

    // Track E teardown guard: references to the in-flight decode Tasks so _ExitTree can JOIN them before the engine
    // core is destroyed. A worker is inside a Godot Image native call (LoadWebp/Png / GenerateMipmaps); if the process
    // quits (GetTree().Quit()) or the stage is torn down (ReturnToMenu) while one is mid-call, destroying the core out
    // from under it segfaults. Mutated only on the main thread (DispatchDecode / _Process / _ExitTree run there).
    private readonly List<Task> _decodeTasks = new();

    // Set once _ExitTree begins. A deferred HttpRequest.RequestCompleted can still fire AFTER _ExitTree (Godot flushes
    // its message queue during teardown), so DispatchDecode must refuse to launch a NEW worker once we're shutting
    // down — otherwise that late worker touches Godot Image while the core is being destroyed. Single-threaded (all
    // writers/readers are main-thread), so a plain bool is sufficient.
    private bool _shuttingDown;

    // Pipeline occupancy: a url counts as in-flight from the moment Pump dispatches its Fetch until either its
    // texture uploads, it permanently fails, or it re-enqueues. The slot spans off-thread decode, so MaxInFlight
    // bounds concurrent work and an in-flight decode keeps the store non-idle for the --shot settle gate.
    private int _inFlight;

    // ---- diagnostics / settle detection ----
    public long Fetched { get; private set; }
    public long Failed => _failed.Count;

    // WS-CRISP R18: has `relUrl` PERMANENTLY failed (MaxAttempts exhausted / a 2xx body that won't decode / a GPU-
    // rejected CCTX)? Such a url never resolves — Request returns null with no callback, so a view awaiting it sits
    // `_wantUrl!=null,_texture==null` FOREVER and reads as unsettled every card/text eval. A permanently-failed texture
    // never decodes, so the live view paints the same blank a crisp clone would — the CardLayer/TextOverlay may treat
    // it as settled-or-failed and stop forgoing crispness on its account. Keyed on the SAME relUrl the fetch used.
    public bool IsFailed(string relUrl) => _failed.Contains(relUrl);

    // True when nothing is queued or in flight — the --shot settle gate (all requested textures have arrived). An
    // in-flight off-thread decode is counted by _inFlight (its pipeline slot is held through the decode), so a --shot
    // never captures before every requested page has fully decoded AND uploaded.
    public bool Idle => _inFlight == 0 && _queue.Count == 0;

    public int PendingCount => _inFlight + _queue.Count;

    // An off-thread decode outcome marshalled back for the main-thread GPU upload. Image is null when the codec
    // decode failed; FromCache records whether the bytes came from the disk cache (a failed cache decode self-heals
    // by deleting the poisoned entry and re-fetching, vs. an HTTP-sourced decode failure which is permanent).
    private sealed class DecodeResult
    {
        public required string RelUrl;
        public Image? Image;
        public bool FromCache;
    }

    // IAssetIdleSource: the --shot settle gate waits on this store (registered in _Ready).
    public string Label => "textures";

    public override void _Ready()
    {
        AssetStores.Register(this);
        // Track E: _Process drains finished off-thread decodes into main-thread GPU uploads. Enable it explicitly
        // (belt-and-suspenders alongside Godot's override auto-detection). When async decode is OFF nothing is ever
        // enqueued, so the drain is a cheap empty-queue early-return every frame.
        SetProcess(true);

        // Track F2a: decide ASTC delivery once (OS.HasFeature is a Godot main-thread call). Android uses ASTC only
        // when its RenderingDevice can sample ASTC 4x4; unsupported devices fall back to the normal codec path rather
        // than rendering garbage.
        _astc = OS.HasFeature("android");
        if (_astc && !AstcSamplingSupported())
        {
            _astc = false;
            GD.Print("M1C_TEX: ASTC 4x4 not supported by this RenderingDevice — using PNG/WEBP path");
        }
        if (_astc)
        {
            GD.Print("M1C_TEX: ASTC delivery ON (fmt=astc)");
        }
    }

    // Best-effort RenderingDevice probe: can this GPU SAMPLE an ASTC 4x4 UNORM texture? Format 156 =
    // DATA_FORMAT_ASTC_4x4_UNORM_BLOCK (cast by value to avoid a fragile generated-enum name). Unknown/absent device
    // → assume supported (proceed): Android devices normally expose a RenderingDevice for this capability check.
    private static bool AstcSamplingSupported()
    {
        try
        {
            var rd = RenderingServer.GetRenderingDevice();
            if (rd is null)
            {
                return true; // e.g. the GL compatibility renderer exposes no RD — don't block on the probe
            }

            return rd.TextureIsFormatSupportedForUsage(
                (RenderingDevice.DataFormat)156,
                RenderingDevice.TextureUsageBits.SamplingBit);
        }
        catch (System.Exception e)
        {
            GD.PrintErr($"M1C_TEX: ASTC support probe failed ({e.Message}) — assuming supported");
            return true;
        }
    }

    // The fetch URL for `relUrl`, appending the CouchCoop `fmt=astc` response-format selector when astc is on. The
    // host serves a CCTX blob when it has one (else the original bytes); either way the client sniffs the magic.
    private string AstcUrl(string relUrl) =>
        _astc ? BaseUrl + relUrl + (relUrl.Contains('?') ? "&fmt=astc" : "?fmt=astc") : BaseUrl + relUrl;

    // The disk-cache key for `relUrl`. In astc mode it is fmt-qualified so ON/OFF runs never read each other's blobs
    // (a PNG entry must never be handed to the CCTX path or vice versa).
    private string DiskKey(string relUrl) => _astc ? relUrl + "|astc" : relUrl;

    // Track F2a: parse a CCTX container and upload its ASTC payload straight to the GPU via Image.CreateFromData —
    // NO codec decode, NO mipgen, NO 16-bit convert (early-exit before every decode path). MAIN-THREAD only
    // (CreateFromImage requirement); all callers run on the main thread. Returns null on a malformed container or a
    // GPU upload the device rejects (the _Ready probe normally prevents the latter by not requesting astc).
    private static ImageTexture? BuildCompressedTexture(byte[] body)
    {
        if (CctxContainer.TryParseHeader(body) is not { } h)
        {
            return null;
        }

        try
        {
            var data = new byte[h.DataLength];
            System.Array.Copy(body, h.DataOffset, data, 0, h.DataLength);
            var img = Image.CreateFromData(h.Width, h.Height, h.HasMipmaps, (Image.Format)h.Format, data);
            return img is null ? null : ImageTexture.CreateFromImage(img);
        }
        catch (System.Exception e)
        {
            GD.PrintErr($"M1C_TEX: CCTX upload error: {e.Message}");
            return null;
        }
    }

    // Track E: drain finished off-thread decodes and perform the main-thread GPU upload (ImageTexture.CreateFromImage
    // is a Godot main-thread requirement). Each drained result frees its pipeline slot (_inFlight--); a re-fetch
    // re-acquires one via Pump. When the store is torn down (ReturnToMenu QueueFree or process Quit) _Process stops
    // running, so results still sitting in _decoded are dropped (GC'd) rather than uploaded — correct, the stage is
    // going away; the per-instance _decoded queue also means a rebuilt stage's fresh TextureStore never sees the
    // previous generation's results. The in-flight WORKERS themselves are joined in _ExitTree (see there) — a worker
    // mid-decode when the engine core is destroyed would segfault, so dropping-the-queue alone is NOT sufficient.
    public override void _Process(double delta)
    {
        if (_decoded.IsEmpty)
        {
            return; // fast path — nothing decoded this frame
        }

        while (_decoded.TryDequeue(out var r))
        {
            _inFlight--; // this url leaves the pipeline (upload / permanent-fail / re-fetch all release the slot)

            if (r.Image is { } img)
            {
                // MAIN-THREAD GPU upload. At most MaxInFlight decodes can be in flight at once, so this bursts to at
                // most MaxInFlight uploads per frame — strictly lighter than the pre-Track-E path, where the same
                // frame did decode + mipgen + this upload for each arriving page.
                var tex = ImageTexture.CreateFromImage(img);
                _loading.Remove(r.RelUrl);
                _attempts.Remove(r.RelUrl);
                if (r.FromCache)
                {
                    AssetDiskCache.CountHit(); // count the hit only after a cache-sourced blob DECODED (self-heal contract)
                }

                OnTextureReady(r.RelUrl, tex);
                RenderActivity.Mark(); // async arrival — keep the stage alive so the freshly-uploaded art paints
            }
            else if (r.FromCache)
            {
                // Poisoned disk entry — delete it (under the fmt-qualified key it was written with) and re-fetch over
                // HTTP (keep _loading + waiters; the settle gate stays non-idle because the re-enqueued url re-occupies
                // the pipeline via Pump below).
                AssetDiskCache.Shared?.DeleteEntry(DiskKey(r.RelUrl));
                _queue.Enqueue(r.RelUrl);
            }
            else
            {
                // HTTP returned 2xx bytes that don't decode → permanent (matches the synchronous path, where
                // AssetFetchPolicy.ShouldRetry(Success, 2xx) is false).
                _loading.Remove(r.RelUrl);
                _attempts.Remove(r.RelUrl);
                _failed.Add(r.RelUrl);
                _waiters.Remove(r.RelUrl);
                GD.PrintErr($"M1C_TEX: image decode failed (permanent) {BaseUrl}{r.RelUrl}");
            }
        }

        Pump(); // a freed slot (or a re-enqueued cache miss) may let queued fetches proceed
    }

    // Request the texture at `relUrl` (a `/res/...` path). Returns the cached texture immediately when available;
    // otherwise returns null and invokes `onReady` once the fetch+decode settles (never for a permanently-failed
    // url). Idempotent: repeated requests for one url coalesce onto a single fetch.
    public ImageTexture? Request(string relUrl, Action<ImageTexture> onReady)
    {
        if (_cache.TryGetValue(relUrl, out var tex))
        {
            return tex;
        }

        if (_failed.Contains(relUrl))
        {
            return null; // don't retry a known-bad url (and don't leak a dangling waiter)
        }

        if (!_waiters.TryGetValue(relUrl, out var list))
        {
            list = new List<Action<ImageTexture>>();
            _waiters[relUrl] = list;
        }

        list.Add(onReady);

        if (_loading.Add(relUrl))
        {
            _queue.Enqueue(relUrl);
            Pump();
        }

        // A DISK-CACHE hit resolves SYNCHRONOUSLY inside Pump→Fetch (missing-textures fix 2026-07-19): the waiter
        // above has already fired and _cache is populated. Returning null here made the first requester of every
        // warm asset clobber its own callback result (`_texture = Request(...)` overwrote the texture with null) —
        // the warm-cache blank-art bug. Re-check the cache so the sync-hit case returns like the pre-cached case.
        return _cache.TryGetValue(relUrl, out var resolved) ? resolved : null;
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
        // WS-U disk cache: serve the bytes from disk before issuing any HttpRequest (the SAME success path, no
        // network). A cache-sourced decode failure self-heals — delete the poisoned entry and fall through to a real
        // fetch — rather than marking the url failed, so a corrupt file can't permanently blank the texture.
        if (AssetDiskCache.Read(DiskKey(relUrl)) is { } cached)
        {
            // Track F2a: a cached CCTX blob uploads straight to the GPU — no decode, no worker, no mipgen. (When
            // astc is on but the cached bytes are a cold-miss PNG, IsCctx is false and the normal path runs.)
            if (_astc && CctxContainer.IsCctx(cached))
            {
                var ctex = BuildCompressedTexture(cached);
                if (ctex is not null)
                {
                    AssetDiskCache.CountHit();
                    _inFlight--;
                    _loading.Remove(relUrl);
                    _attempts.Remove(relUrl);
                    OnTextureReady(relUrl, ctex);
                    Pump();
                    return;
                }

                AssetDiskCache.Shared?.DeleteEntry(DiskKey(relUrl)); // poisoned cctx — re-fetch over HTTP
            }
            else
            {
                // Track E: decode the cached bytes OFF the main thread (holding this pipeline slot until _Process
                // uploads the result). An empty/poisoned entry can't decode — drop it and fall through to HTTP.
                if (cached.Length > 0)
                {
                    DispatchDecode(relUrl, cached, fromCache: true);
                    return;
                }

                AssetDiskCache.Shared?.DeleteEntry(DiskKey(relUrl));
            }
        }

        // Timeout is load-bearing (missing-textures fix 2026-07-19): Godot's default 0 waits FOREVER, so a host
        // busy loading a run (asset extraction runs on its main thread) silently wedged the in-flight slots and
        // stalled every later fetch with zero logs. A timed-out/transient request now frees its slot and retries.
        var req = new HttpRequest { UseThreads = true, Timeout = AssetFetchPolicy.TimeoutSeconds(30) };
        AddChild(req);
        string url = AstcUrl(relUrl);
        req.RequestCompleted += (result, code, _, body) =>
        {
            req.QueueFree();

            bool httpOk = result == (long)HttpRequest.Result.Success && code >= 200 && code < 300 && body.Length > 0;

            // Track F2a EARLY EXIT: a CCTX response uploads straight to the GPU (no decode/mipgen/16-bit path, no
            // worker). Cache the compressed blob under the fmt-qualified key so ON/OFF modes stay isolated. Anything
            // else (a cold-miss PNG/WEBP) falls through to the unchanged decode path below.
            if (httpOk && _astc && CctxContainer.IsCctx(body))
            {
                var ctex = BuildCompressedTexture(body);
                _inFlight--;
                if (ctex is not null)
                {
                    _loading.Remove(relUrl);
                    _attempts.Remove(relUrl);
                    AssetDiskCache.Write(DiskKey(relUrl), body);
                    OnTextureReady(relUrl, ctex);
                }
                else
                {
                    // Valid CCTX bytes the GPU won't take (e.g. ASTC unsupported) — permanent for this url; a retry
                    // re-fails identically. The _Ready probe normally prevents requesting astc on such a GPU.
                    _loading.Remove(relUrl);
                    _attempts.Remove(relUrl);
                    _failed.Add(relUrl);
                    _waiters.Remove(relUrl);
                    GD.PrintErr($"M1C_TEX: CCTX upload failed (permanent) {url}");
                }

                Pump();
                return;
            }

            // Track E ASYNC success: write-through the bytes (WriteThrough is already off-thread + atomic, so the
            // render loop never blocks on disk IO — SpineClipStore parity) and hand the codec decode + mipgen to a
            // worker. The pipeline slot is held (no _inFlight--/Pump here) until _Process uploads the finished Image.
            if (httpOk)
            {
                AssetDiskCache.Write(DiskKey(relUrl), body);
                DispatchDecode(relUrl, body, fromCache: false);
                return;
            }

            _inFlight--;

            int attempt = (_attempts.TryGetValue(relUrl, out int prior) ? prior : 0) + 1;
            if (AssetFetchPolicy.ShouldRetry(result, code, attempt))
            {
                // Transient (timeout / connection / 429 / 5xx): keep _loading + waiters and re-enqueue at the
                // back of the queue — the store stays non-idle so the settle gate still waits, bounded by
                // MaxAttempts × Timeout.
                _attempts[relUrl] = attempt;
                _queue.Enqueue(relUrl);
                GD.PrintErr($"M1C_TEX: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
            }
            else
            {
                _loading.Remove(relUrl);
                _attempts.Remove(relUrl);
                _failed.Add(relUrl);
                _waiters.Remove(relUrl); // drop waiters — a failed url never resolves (guards a growing map)
                GD.PrintErr($"M1C_TEX: fetch failed {url} result={result} code={code} len={body.Length}");
            }

            Pump();
        };

        Error err = req.Request(url);
        if (err != Error.Ok)
        {
            GD.PrintErr($"M1C_TEX: request start failed {url}: {err}");
            req.QueueFree();
            _inFlight--;
            _loading.Remove(relUrl);
            _failed.Add(relUrl);
            _waiters.Remove(relUrl);
            Pump();
        }
    }

    // Cache the decoded texture, record its page size, settle its waiters. Shared by the cache-hit + HTTP paths.
    private void OnTextureReady(string relUrl, ImageTexture tex)
    {
        _cache[relUrl] = tex;
        _pageSizes[relUrl] = (Vector2I)tex.GetSize();
        Fetched++;
        if (_waiters.Remove(relUrl, out var list))
        {
            foreach (var cb in list)
            {
                cb(tex);
            }
        }
    }

    // Track E: hand a byte buffer to a worker for codec decode + mipgen, then queue the finished Image for the
    // main-thread GPU upload in _Process. The caller has already accounted this url's pipeline slot (_inFlight); the
    // slot stays held until _Process drains the result. The worker touches ONLY managed bytes + a thread-safe Godot
    // Image — never a scene node or the GPU — so a decode that finishes after the store is torn down is harmless.
    private void DispatchDecode(string relUrl, byte[] bytes, bool fromCache)
    {
        if (_shuttingDown)
        {
            return; // teardown in progress — never launch a worker that would touch Godot Image during core destruction
        }

        _decodeTasks.RemoveAll(t => t.IsCompleted); // keep the tracked-task list bounded to the in-flight set
        _decodeTasks.Add(Task.Run(() => _decoded.Enqueue(new DecodeResult
        {
            RelUrl = relUrl,
            Image = DecodeImageOffThread(bytes, relUrl),
            FromCache = fromCache,
        })));
    }

    // Track E teardown: JOIN any in-flight off-thread decodes before this store leaves the tree. _ExitTree fires on
    // BOTH teardown paths — GetTree().Quit() dismantling the scene tree AND ReturnToMenu's QueueFree — and runs while
    // the engine core is still alive, so blocking here (bounded) guarantees no worker is inside a Godot Image native
    // call when the core is destroyed (the segfault this prevents). Decodes are pure CPU with no main-thread
    // dependency, so the wait cannot deadlock; the 5s cap is belt-and-suspenders against a pathologically slow decode.
    // Results still sitting in _decoded are simply dropped (never uploaded) — correct, the stage is going away.
    public override void _ExitTree()
    {
        _shuttingDown = true; // FIRST: block any later DispatchDecode (a deferred RequestCompleted can still fire below)
        var pending = _decodeTasks.FindAll(t => !t.IsCompleted).ToArray();
        _decodeTasks.Clear();
        if (pending.Length > 0)
        {
            try
            {
                Task.WaitAll(pending, TimeSpan.FromSeconds(5));
            }
            catch (AggregateException)
            {
                // A decode threw — its result is discarded; teardown continues (the worker is no longer running).
            }
        }
    }

    // Sniff RIFF/WEBP magic; otherwise assume PNG (the wire is codec-agnostic — the host may flip PNG<->webp).
    private static Error SniffAndLoad(Image img, byte[] body)
    {
        if (body.Length >= 12 && body[0] == 'R' && body[1] == 'I' && body[2] == 'F' && body[3] == 'F' &&
            body[8] == 'W' && body[9] == 'E' && body[10] == 'B' && body[11] == 'P')
        {
            return img.LoadWebpFromBuffer(body);
        }

        if (body.Length >= 8 && body[0] == 0x89 && body[1] == 'P' && body[2] == 'N' && body[3] == 'G')
        {
            return img.LoadPngFromBuffer(body);
        }

        // Unknown magic — try PNG then WEBP (tolerant, like the codec-agnostic wire).
        Error e = img.LoadPngFromBuffer(body);
        if (e != Error.Ok)
        {
            e = img.LoadWebpFromBuffer(body);
        }

        return e;
    }

    // Off-thread decode + mipgen — codec sniff/load + GenerateMipmaps, minus the
    // GD.Print (Godot logging off the main thread is unsafe) and MINUS the CreateFromImage upload (a Godot
    // main-thread requirement, done by the _Process drain). Returns null on a codec failure, which the drain logs on
    // the main thread. Every op here (new Image + LoadWebp/Png + GenerateMipmaps) is the same self-contained,
    // thread-safe Image work SpineClipStore already runs off-thread.
    private static Image? DecodeImageOffThread(byte[] body, string? relUrl = null)
    {
        var img = new Image();
        if (SniffAndLoad(img, body) != Error.Ok)
        {
            return null;
        }

        RecordArtInfo(relUrl, img); // thread-safe self-contained image scan (like mipgen below)

        img.GenerateMipmaps(); // best-effort — a non-mippable format leaves the base level for the upload

        // Track F1: pack RGBA8 → 16-bit (RGB565 / RGBA4444, ordered-dithered) on THIS worker thread, after mipgen so
        // the Convert carries the whole mip chain (see Tex16Convert). All of it
        // (DetectAlpha, the managed dither loop, GetData/SetData, Convert) is self-contained thread-safe Image / byte
        // work — the deferred main-thread CreateFromImage upload just carries the finished 16-bit image.
        // WS-SHADER: pass the source url so a float `.exr` SDF page is exempted from the 16-bit pack (default ON).
        Tex16Convert.ToPacked16(img, relUrl);

        return img;
    }
}
