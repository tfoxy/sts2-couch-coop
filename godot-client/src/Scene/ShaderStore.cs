// Decode-once HTTP shader cache for the M1d native mirror (WS-H) — the shader analog of TextureStore/FontStore.
// The mirror wire ships each shader node's shader path (MirrorNode.ShaderId, a `res://…gdshader` or a `.tres`
// material) and its streamed uniforms; this store fetches each DISTINCT shaderId once, resolves it to shader SOURCE
// from the current raw `.gdshader` text or `[gd_resource]` `.tres` forms (see ShaderResourceParser), compiles ONE
// Godot Shader per id, and stashes the material's
// authored uniform defaults. ShaderAttachment builds a per-VIEW ShaderMaterial off the shared compiled Shader and
// applies the streamed uniforms; PaintGates reads the per-id mount state to gate the node's base paint.
//
// A `.tres` material that references an ExtResource `.gdshader` needs a
// SECOND fetch of that shader path (chained below); an inline `sub_resource type="Shader"` / JSON SubResource ships
// its `code` inline (no second fetch).
//
// Self-mounting singleton (WS-H cannot edit AppShell): on first use it finds the already-mounted TextureStore by
// walking the tree, copies its BaseUrl, and parents itself under it — the FontStore shape. Registered in AssetStores
// (Label "shaders") so the --shot settle gate waits until every requested shader is compiled-or-failed.

using System;
using System.Collections.Generic;
using CouchCoop.MirrorProtocol.Assets;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

// Per-shaderId mount state. Absent = never requested; Pending = fetching/compiling; Mounted = compiled Shader ready;
// Failed = fetch/compile/uid-unresolvable (base paint suppressed, one-time notice emitted).
public enum ShaderState
{
    Absent,
    Pending,
    Mounted,
    Failed,
}

// Track-P: the shader's canvas blend class, parsed from its `render_mode blend_*` declaration (absent ⇒ Mix). The
// static-bake controller only clears a shader for Static-mode baking when its blend class is Mix or Add — those two
// composite associatively as premultiplied "over" onto the transparent bake buffer at the BOTTOM of the paint order
// (nothing under them), so the pre-composite is bit-exact. Sub / Mul / PremulAlpha / Disabled do not, so a shader
// declaring them is left live (never baked).
public enum ShaderBlendClass
{
    Mix,
    Add,
    Sub,
    Mul,
    PremulAlpha,
    Disabled,
}

public sealed partial class ShaderStore : Node, IAssetIdleSource
{
    // Bounded concurrent HTTP fetches (task says ~4). The distinct-shader set is tiny (≈18 in a combat), so this
    // never saturates; chained ext-shader fetches ride the same queue.
    private const int MaxInFlight = 4;

    // WS-SHINC: gdshader `#include` inlining depth cap (real game shaders nest 1 level: a `.gdshader` includes a
    // `.gdshaderinc` util). A generous cap guards a pathological chain / diamond; beyond it the expander stops and the
    // leftover `#include` lines trip the compile-failure check → Failed (never a runaway recursion).
    private const int MaxIncludeDepth = 8;

    private static ShaderStore? _instance;

    // "http://host:port" (no trailing slash); the `/res/...` shader url is appended verbatim.
    public string BaseUrl { get; private set; } = "";

    private readonly Dictionary<string, ShaderState> _state = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Shader> _shaders = new(StringComparer.Ordinal);
    // WS-EFFECTS-NATIVE: the TIME-frozen "Static" variant per shaderId, compiled once alongside the dynamic shader.
    // Present ONLY when the source references whole-word TIME (ShaderStaticRewrite.ReferencedTime); absent means the
    // shader has no live TIME → static ≡ dynamic, so PeekShader(Static) transparently serves the dynamic shader.
    private readonly Dictionary<string, Shader> _staticShaders = new(StringComparer.Ordinal);
    // WS-ADDBAKE: the "bake-add" premul variant per Add-blend shaderId, compiled once alongside the static shader
    // (ShaderBakeRewrite composed ON TOP of the Static TIME-pin rewrite). Present ONLY when the shader declares
    // blend_add AND the fragment rewrite succeeded (Ok=true); absent ⇒ the carrier is UN-rewritable and stays LIVE
    // (never baked raw). ShaderAttachment swaps a static-bake Add clone's material to this variant.
    private readonly Dictionary<string, Shader> _bakeAddShaders = new(StringComparer.Ordinal);
    // On-demand rendering (RenderActivity): shaderIds whose Dynamic source ANIMATES with no per-frame C# signal —
    // it references whole-word TIME (a live built-in that re-evaluates every frame) OR reads the screen
    // (SCREEN_TEXTURE / hint_screen_texture, which changes as anything behind it moves). ShaderAttachment force-keeps
    // the stage alive while such a shader is mounted in Dynamic mode; the Static variant is TIME-frozen so it is NOT
    // animate (absent here means "no live TIME / screen read" → static ≡ dynamic for liveness).
    private readonly HashSet<string> _animates = new(StringComparer.Ordinal);
    // Track-P static-bake metadata: per-shaderId "reads the screen" flag (a shader sampling SCREEN_TEXTURE composites
    // whatever is UNDER it, so a bottom-of-order bake that removes those under-pixels can change its output — the
    // controller gates such shaders behind COUCHCOOP_MIRROR_STATICBAKE_SCREENREAD) and the parsed blend class.
    private readonly HashSet<string> _screenReads = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ShaderBlendClass> _blendClass = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IReadOnlyList<MirrorShaderParam>> _defaults = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action>> _waiters = new(StringComparer.Ordinal);
    // WS-SHINC include-body cache: the RAW `.gdshaderinc` text per include res:// path (a null entry = terminal fetch
    // failure). Raw (un-expanded) bodies are context-independent, so caching avoids re-fetching a util include shared
    // by several shaders; the per-ancestry splice is re-done fresh by ShaderIncludeExpander.Expand. `_includeWaiters`
    // coalesces concurrent fetches of the SAME include path (multiple shaders requested it before the first landed).
    private readonly Dictionary<string, string?> _includeRaw = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<Action<string?>>> _includeWaiters = new(StringComparer.Ordinal);
    private readonly Queue<FetchJob> _queue = new();
    // Transient-retry bookkeeping (missing-textures fix 2026-07-19) — see TextureStore._attempts.
    private readonly Dictionary<string, int> _attempts = new(StringComparer.Ordinal);
    private int _inFlight;
    private int _pendingCount; // shaderIds requested but not yet Mounted/Failed

    // Diagnostics.
    public long Compiled { get; private set; }
    public long FailedCount { get; private set; }

    // IAssetIdleSource: the --shot settle gate waits until every requested shader is terminal.
    public int PendingCount => _pendingCount;
    public bool Idle => _pendingCount == 0 && _inFlight == 0 && _queue.Count == 0;
    public string Label => "shaders";

    // Get-or-create the process singleton, hosted under the mounted TextureStore (BaseUrl copied, no AppShell edit).
    // `context` is any in-tree node (a MirrorNodeView). Idempotent + cheap after the first call.
    public static ShaderStore For(Node context)
    {
        if (_instance is not null && GodotObject.IsInstanceValid(_instance))
        {
            return _instance;
        }

        var store = new ShaderStore { Name = "__shaderStore" };

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
            GD.PrintErr("SHADER: no TextureStore found in tree — using COUCHCOOP_ASSETS_BASE fallback " +
                        $"base='{store.BaseUrl}' (shaders will fail if empty).");
            (tree?.Root ?? context).AddChild(store);
        }

        _instance = store;
        AssetStores.Register(store); // the --shot settle gate now waits on shaders too
        return store;
    }

    // Drop the process singleton (AppShell.ReturnToMenu teardown). The node itself is freed with the render stage
    // (it parents under TextureStore); nulling the static ref prevents the static Peek* methods from serving the OLD
    // stage's compiled-shader/mount-state dictionaries — which do NOT self-heal via For() when every needed shader is
    // already "Mounted" in the stale instance (For() is only called for a not-yet-mounted shader). The next stage's
    // first ShaderStore.For rebuilds a fresh instance under the new TextureStore.
    public static void ResetInstance() => _instance = null;

    // ---- static peeks (pure reads for MaterialResolver + PaintGates; never trigger a fetch) --------------------

    public static ShaderState PeekState(string shaderId) =>
        _instance is not null && _instance._state.TryGetValue(shaderId, out var s) ? s : ShaderState.Absent;

    // The compiled Shader for `shaderId` in the requested effect mode. Static → the TIME-frozen variant when one was
    // compiled (source referenced whole-word TIME), else the dynamic shader (static ≡ dynamic — no TIME to freeze).
    // Dynamic/Off both use the original TIME-driven shader (Off suppresses the material upstream, not the compile).
    public static Shader? PeekShader(string shaderId, EffectMode mode = EffectMode.Dynamic)
    {
        if (_instance is null)
        {
            return null;
        }

        if (mode == EffectMode.Static && _instance._staticShaders.TryGetValue(shaderId, out var frozen))
        {
            return frozen;
        }

        return _instance._shaders.TryGetValue(shaderId, out var sh) ? sh : null;
    }

    public static IReadOnlyList<MirrorShaderParam>? PeekDefaults(string shaderId) =>
        _instance is not null && _instance._defaults.TryGetValue(shaderId, out var d) ? d : null;

    // On-demand rendering: true when the compiled shader's SOURCE animates every frame with no C# signal (whole-word
    // TIME or a screen read). ShaderAttachment ANDs this with Dynamic mode to force-keep the stage alive.
    public static bool PeekAnimates(string shaderId) =>
        _instance is not null && _instance._animates.Contains(shaderId);

    // Track-P static-bake gates: whether the shader samples the screen (SCREEN_TEXTURE / hint_screen_texture) and its
    // parsed blend class. Absent shaderId ⇒ conservative defaults (does-not-read-screen false / Mix). Pure reads.
    public static bool PeekScreenReads(string shaderId) =>
        _instance is not null && _instance._screenReads.Contains(shaderId);

    public static ShaderBlendClass PeekBlendClass(string shaderId) =>
        _instance is not null && _instance._blendClass.TryGetValue(shaderId, out var c) ? c : ShaderBlendClass.Mix;

    // WS-ADDBAKE static-bake gates: the bake-add premul variant Shader for an Add-blend shaderId (null when the shader
    // is not Add-blend or its fragment rewrite failed), and whether such a variant exists (⇒ the Add carrier may bake).
    public static Shader? PeekBakeAddShader(string shaderId) =>
        _instance is not null && _instance._bakeAddShaders.TryGetValue(shaderId, out var sh) ? sh : null;

    public static bool PeekBakeAddOk(string shaderId) =>
        _instance is not null && _instance._bakeAddShaders.ContainsKey(shaderId);

    // ---- request -----------------------------------------------------------------------------------------------

    // Ensure the shader for `shaderId` is being (or has been) resolved. `onReady` fires ONCE if/when it MOUNTS (the
    // caller re-applies the node then); it is NOT called for an already-mounted or failed shader (the caller reads
    // PeekState). Idempotent per shaderId — a uid:// id or an unfetchable path fails fast.
    public void Request(string shaderId, Action onReady)
    {
        if (_state.TryGetValue(shaderId, out var st))
        {
            if (st == ShaderState.Pending)
            {
                AddWaiter(shaderId, onReady);
            }

            return; // Mounted / Failed are terminal — caller consults PeekState
        }

        _state[shaderId] = ShaderState.Pending;
        _pendingCount++;
        AddWaiter(shaderId, onReady);

        if (shaderId.StartsWith("uid://", StringComparison.Ordinal))
        {
            Fail(shaderId, "uid:// unresolvable (no client uid→path table)");
            return;
        }

        EnqueueFetch(SceneDeltaReader.MirrorResourceUrl(shaderId), body => OnPrimaryBody(shaderId, body));
    }

    private void AddWaiter(string shaderId, Action onReady)
    {
        if (!_waiters.TryGetValue(shaderId, out var list))
        {
            list = new List<Action>();
            _waiters[shaderId] = list;
        }

        list.Add(onReady);
    }

    // ---- fetch pipeline ----------------------------------------------------------------------------------------

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
        // WS-U disk cache: serve shader SOURCE from disk before HTTP (same OnBody path, no network). A non-empty
        // cached body is trusted (a poisoned-but-nonempty entry Fails downstream exactly like a bad network response,
        // and Godot can't detect GLSL errors anyway); an EMPTY entry is corrupt → delete + real fetch (self-heal).
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

            AssetDiskCache.Shared?.DeleteEntry(job.RelUrl); // empty/poisoned entry — re-fetch over HTTP
        }

        // Timeout + transient retry (missing-textures fix 2026-07-19) — see TextureStore.Fetch for the rationale.
        var req = new HttpRequest { UseThreads = true, Timeout = AssetFetchPolicy.TimeoutSeconds(30) };
        AddChild(req);
        string url = BaseUrl + job.RelUrl;
        req.RequestCompleted += (result, code, _, body) =>
        {
            req.QueueFree();
            _inFlight--;

            string? text = null;
            if (result == (long)HttpRequest.Result.Success && code >= 200 && code < 300 && body.Length > 0)
            {
                text = System.Text.Encoding.UTF8.GetString(body);
                AssetDiskCache.Write(job.RelUrl, body); // write-through the fetched bytes (counts miss+write)
            }

            if (text is null)
            {
                int attempt = (_attempts.TryGetValue(job.RelUrl, out int prior) ? prior : 0) + 1;
                if (AssetFetchPolicy.ShouldRetry(result, code, attempt))
                {
                    _attempts[job.RelUrl] = attempt;
                    _queue.Enqueue(job); // the job keeps its OnBody; bounded by MaxAttempts x Timeout
                    GD.PrintErr($"SHADER: retry {attempt + 1}/{AssetFetchPolicy.MaxAttempts} {url} result={result} code={code}");
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
            GD.PrintErr($"SHADER: request start failed {url}: {err}");
            req.QueueFree();
            _inFlight--;
            job.OnBody(null);
            Pump();
        }
    }

    // The primary shaderId body arrived: sniff+parse, then compile inline, chain a second fetch for an ExtResource
    // `.gdshader`, or fail.
    private void OnPrimaryBody(string shaderId, string? body)
    {
        if (body is null)
        {
            Fail(shaderId, "fetch failed");
            return;
        }

        var parsed = ShaderResourceParser.Parse(body);
        if (parsed.ShaderCode is not null)
        {
            CompileWithIncludes(shaderId, parsed.ShaderCode, parsed.Defaults);
            return;
        }

        if (parsed.ShaderExtPath is not null)
        {
            var defaults = parsed.Defaults;
            EnqueueFetch(SceneDeltaReader.MirrorResourceUrl(parsed.ShaderExtPath), extBody =>
            {
                if (extBody is null)
                {
                    Fail(shaderId, $"ext shader fetch failed ({parsed.ShaderExtPath})");
                    return;
                }

                CompileWithIncludes(shaderId, extBody, defaults);
            });
            return;
        }

        Fail(shaderId, $"no shader source in resource (format={parsed.Format})");
    }

    // WS-SHINC entry point: inline any `#include "res://…"` bodies, THEN compile. The include splice MUST finish before
    // CompileSource's TIME-rewrite / screen-read / animate / blend scans run — an include body (e.g. tiling_and_offset)
    // can itself contain whole-word TIME, and the compiled shader's uniform list is only complete once includes are in.
    // Include-free shaders (every other game shader) and the switch-OFF path compile SYNCHRONOUSLY here, byte-identical
    // to the pre-fix `Compile`, so the parity gate holds.
    private void CompileWithIncludes(string shaderId, string code, IReadOnlyList<MirrorShaderParam> defaults)
    {
        if (!ShaderIncludeExpander.HasIncludes(code))
        {
            CompileSource(shaderId, code, defaults);
            return;
        }

        // BFS-prefetch every transitive include's RAW body, then splice via the pure expander. Any include whose fetch
        // ultimately fails (retry-exhausted / 404 / unsupported) FAILS the whole shader — we never compile (or mount) a
        // body with unresolved `#include` lines. `outstanding` starts at 1 (a discovery sentinel dropped at the end) so
        // a synchronous cache hit mid-discovery can't complete the shader before every first-level include is queued.
        var rawBodies = new Dictionary<string, string>(StringComparer.Ordinal);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        int outstanding = 1;
        bool failed = false;

        void Complete()
        {
            if (--outstanding != 0 || failed)
            {
                return;
            }

            string expanded = ShaderIncludeExpander.Expand(
                code, path => rawBodies.TryGetValue(path, out var b) ? b : null, MaxIncludeDepth);
            CompileSource(shaderId, expanded, defaults);
        }

        void Discover(IReadOnlyList<string> paths)
        {
            foreach (var path in paths)
            {
                if (failed || !visited.Add(path))
                {
                    continue;
                }

                outstanding++;
                FetchIncludeRaw(path, includeBody =>
                {
                    if (failed)
                    {
                        return;
                    }

                    if (includeBody is null)
                    {
                        failed = true;
                        Fail(shaderId, $"include fetch failed ({path})");
                        return;
                    }

                    rawBodies[path] = includeBody;
                    Discover(ShaderIncludeExpander.FindIncludePaths(includeBody));
                    Complete();
                });
            }
        }

        Discover(ShaderIncludeExpander.FindIncludePaths(code));
        Complete(); // drop the discovery sentinel (fires the splice+compile if every include was cache-warm)
    }

    // Fetch (or serve from the include cache) the RAW body of one `.gdshaderinc` path; `onRaw(null)` on terminal
    // failure. Concurrent requests for the same include coalesce onto one fetch; the result (body OR null) is cached so
    // a util include shared by many shaders is fetched at most once per session.
    private void FetchIncludeRaw(string includePath, Action<string?> onRaw)
    {
        if (_includeRaw.TryGetValue(includePath, out var cached))
        {
            onRaw(cached);
            return;
        }

        if (_includeWaiters.TryGetValue(includePath, out var pending))
        {
            pending.Add(onRaw); // an identical fetch is already in flight
            return;
        }

        if (includePath.StartsWith("uid://", StringComparison.Ordinal))
        {
            _includeRaw[includePath] = null; // no client uid→path table (same guard as a uid:// shaderId)
            onRaw(null);
            return;
        }

        _includeWaiters[includePath] = new List<Action<string?>> { onRaw };
        EnqueueFetch(SceneDeltaReader.MirrorResourceUrl(includePath), body =>
        {
            _includeRaw[includePath] = body; // cache success OR terminal failure (null)
            if (_includeWaiters.Remove(includePath, out var list))
            {
                foreach (var cb in list)
                {
                    cb(body);
                }
            }
        });
    }

    // Best-effort compile of a fully-resolved (includes already inlined) shader body: a body lacking a `shader_type`
    // declaration is not a shader (a 404/HTML page or the wrong resource) → fail rather than mount a broken shader.
    // WS-SHINC part C adds an honest compile-failure heuristic below (uniform-list-empty-while-source-declares-uniform)
    // that catches an unresolved-#include / GLSL-error shader Godot would otherwise silently render as nothing.
    private void CompileSource(string shaderId, string code, IReadOnlyList<MirrorShaderParam> defaults)
    {
        if (string.IsNullOrWhiteSpace(code) || !code.Contains("shader_type", StringComparison.Ordinal))
        {
            Fail(shaderId, "no shader_type declaration in source");
            return;
        }

        var shader = new Shader { Code = code };

        // WS-SHINC part C (honest compile state): if the post-inline source textually declares at least one `uniform`
        // but the COMPILED shader exposes none, Godot failed to parse it (it logged `SHADER ERROR:` and would render
        // nothing → the node's raw base fill washes the frame). Treat as a compile failure so PaintGates suppresses the
        // base and the shader NEVER mounts. Checked once, BEFORE any registration below, so a Failed shader leaves no
        // animate/screen-read/blend/static/defaults entries behind. OFF ⇒ pre-fix behavior (mount regardless).
        if (DeclaresUniformButNoneCompiled(shader, code))
        {
            Fail(shaderId, "compile failed: source declares uniform(s) but shader exposed none " +
                           "(unresolved #include or GLSL error)");
            return;
        }

        _shaders[shaderId] = shader;
        _defaults[shaderId] = defaults;

        // WS-EFFECTS-NATIVE: compile the TIME-frozen "Static" variant now (once), keyed by the same shaderId. The pure
        // rewrite word-boundary-swaps built-in TIME for a couch_static_time uniform ShaderAttachment pins; a shader
        // with no whole-word TIME needs no variant (ReferencedTime=false → PeekShader(Static) serves the dynamic one).
        var (staticCode, referencedTime) = ShaderStaticRewrite.RewriteTimeToStaticUniform(code);
        if (referencedTime)
        {
            _staticShaders[shaderId] = new Shader { Code = staticCode };
        }

        // On-demand rendering: tag this shaderId "animates" when the source references live TIME (reuses the rewrite's
        // whole-word detection) OR reads the screen (SCREEN_TEXTURE / hint_screen_texture — none in today's recordings,
        // but the store compiles arbitrary streamed source, so guard it). Such a Dynamic shader force-keeps the stage
        // alive (its fragment output changes every frame with zero C# signal).
        bool screenReads = ScreenReadShaders.ReferencesScreenRead(code);
        bool animates = referencedTime || screenReads;
        if (animates)
        {
            _animates.Add(shaderId);
        }

        // Track-P static-bake metadata (recorded once at compile alongside the animate tag): the screen-read flag and
        // the parsed blend class the controller consults to decide whether this shader may be baked in Static mode.
        if (screenReads)
        {
            _screenReads.Add(shaderId);
        }

        var blendClass = ParseBlendClass(code);
        _blendClass[shaderId] = blendClass;

        // WS-ADDBAKE: an Add-blend shader gets a "bake-add" premul variant so a static-bake clone renders it as an
        // alpha-preserving additive clone. It consumes the STATIC-rewritten source (TIME already frozen), so a baked
        // add shader is both TIME-pinned AND premult-folded. An un-rewritable fragment (Ok=false) leaves no variant →
        // the carrier stays LIVE (CollectEffectStaticOk never clears it), which is safe containment.
        bool bakeAddOk = false;
        if (blendClass == ShaderBlendClass.Add)
        {
            string staticSource = referencedTime ? staticCode : code;
            var (bakeAddCode, ok) = ShaderBakeRewrite.RewriteAddToBakePremul(staticSource);
            if (ok)
            {
                _bakeAddShaders[shaderId] = new Shader { Code = bakeAddCode };
                bakeAddOk = true;
            }
        }

        Transition(shaderId, ShaderState.Mounted);
        Compiled++;
        GD.Print($"SHADER: compiled {shaderId} (staticVariant={referencedTime} animates={animates} " +
                 $"blend={blendClass} bakeAdd={bakeAddOk})");
        FireWaiters(shaderId);
    }

    private void Fail(string shaderId, string reason)
    {
        Transition(shaderId, ShaderState.Failed);
        FailedCount++;
        GD.PrintErr($"SHADER: failed {shaderId} ({reason})");
        _waiters.Remove(shaderId); // a failed shader never mounts — drop reapply waiters (base stays suppressed)

        // WS-SHINC: a Failed shader must leave NO registrations behind — otherwise a shader that registered as
        // continuous/animates or screen-read (e.g. a late compile-check failure) would keep the stage alive or gate
        // base paint despite never mounting. CompileSource fails BEFORE registering, so these are normally no-ops; the
        // purge keeps Fail correct regardless of where it is called from.
        _shaders.Remove(shaderId);
        _staticShaders.Remove(shaderId);
        _bakeAddShaders.Remove(shaderId);
        _defaults.Remove(shaderId);
        _animates.Remove(shaderId);
        _screenReads.Remove(shaderId);
        _blendClass.Remove(shaderId);
    }

    // WS-SHINC part C heuristic: does the (post-inline) source declare a `uniform` while the compiled shader exposes
    // NONE? Godot returns an EMPTY `GetShaderUniformList()` for a body that failed to parse (unresolved `#include`,
    // GLSL syntax error), so "declares a uniform textually but the RenderingServer reports zero uniforms" is a reliable
    // one-shot compile-failure signal. A shader that legitimately declares no uniforms has no textual `uniform` and is
    // NOT flagged (its empty uniform list is expected). Cheap: one regex over the source + one uniform-list read.
    private static bool DeclaresUniformButNoneCompiled(Shader shader, string code)
    {
        if (!DeclaresUniform(code))
        {
            return false;
        }

        return shader.GetShaderUniformList().Count == 0;
    }

    // A gdshader `uniform` DECLARATION: `uniform` as a statement-leading keyword (after an optional `global`/`instance`
    // qualifier) at the start of a line. Anchoring to line-start avoids false positives from the word "uniform" inside
    // a `//`/`*`-prefixed comment (which never begins a line with `uniform`).
    private static readonly System.Text.RegularExpressions.Regex UniformDecl = new(
        "^[ \\t]*(?:global[ \\t]+|instance[ \\t]+)?uniform[ \\t]",
        System.Text.RegularExpressions.RegexOptions.Multiline |
        System.Text.RegularExpressions.RegexOptions.Compiled);

    private static bool DeclaresUniform(string code) =>
        !string.IsNullOrEmpty(code)
        && code.IndexOf("uniform", StringComparison.Ordinal) >= 0
        && UniformDecl.IsMatch(code);

    private void Transition(string shaderId, ShaderState next)
    {
        if (_state.TryGetValue(shaderId, out var prev) && prev == ShaderState.Pending &&
            (next == ShaderState.Mounted || next == ShaderState.Failed))
        {
            _pendingCount--;
        }

        _state[shaderId] = next;
    }

    private void FireWaiters(string shaderId)
    {
        if (_waiters.Remove(shaderId, out var list))
        {
            foreach (var cb in list)
            {
                cb();
            }
        }
    }

    // Screen-read detection is the shared pure ScreenReadShaders.ReferencesScreenRead classifier (protocol library)
    // so ShaderStore.PeekScreenReads, PaintGates, and ShaderAttachment agree on ONE rule with no drift.

    // Track-P: parse the canvas blend class from the gdshader `render_mode blend_*` declaration. A `render_mode` line
    // lists comma-separated modes; only ONE blend_* may appear. Absent ⇒ the Godot default, Mix. A plain substring
    // scan is enough (the tokens are distinct; a false hit could only DEMOTE a shader to a non-bakeable class, which
    // is safe — it just leaves it live). Ordered most-specific-first so blend_premul_alpha isn't caught by blend_ad…
    private static ShaderBlendClass ParseBlendClass(string code)
    {
        if (code.Contains("blend_premul_alpha", StringComparison.Ordinal))
        {
            return ShaderBlendClass.PremulAlpha;
        }

        if (code.Contains("blend_disabled", StringComparison.Ordinal))
        {
            return ShaderBlendClass.Disabled;
        }

        if (code.Contains("blend_add", StringComparison.Ordinal))
        {
            return ShaderBlendClass.Add;
        }

        if (code.Contains("blend_sub", StringComparison.Ordinal))
        {
            return ShaderBlendClass.Sub;
        }

        if (code.Contains("blend_mul", StringComparison.Ordinal))
        {
            return ShaderBlendClass.Mul;
        }

        return ShaderBlendClass.Mix; // blend_mix or unspecified → the Godot default
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
