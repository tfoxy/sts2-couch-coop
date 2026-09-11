using Godot;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Reclaim the CPU-side texture pixel data that Godot's <c>--headless</c> dummy renderer keeps forever.
///
/// <para><b>The problem.</b> Under <c>--headless</c> Godot swaps in <c>RendererDummy::TextureStorage</c>, whose
/// <c>texture_2d_initialize</c> is literally <c>t-&gt;image = p_image-&gt;duplicate();</c> — every texture the
/// game creates leaves a full CPU copy of its pixels behind, held until the texture RID is freed. A real
/// renderer uploads to the GPU and drops the CPU image, which is why the same textures cost the host nothing.
/// Measured on a live 1374MB seat: <b>1,491 live Image objects holding 456MB of pixel data</b> — a third of the
/// process — against 262 images / 227MB in the windowed host that was actually drawing them. Of that, ~104MB
/// was in VRAM-compressed formats (DXT1/DXT5/BPTC) that the host retained essentially none of, because those
/// exist only to be handed to a GPU.</para>
///
/// <para><b>The mechanism.</b> In headless, <c>Texture2D.GetImage()</c> routes to the dummy storage's
/// <c>texture_2d_get</c>, which returns <c>t-&gt;image</c> BY REFERENCE — i.e. it hands back the dummy
/// renderer's own private duplicate, not a game-owned object and not a copy. Calling <c>SetData</c> on it with
/// a 1x1 payload drops that <c>Vector&lt;uint8_t&gt;</c>'s reference to the pixel buffer, and glibc frees the
/// buffer once the last reference goes (the game's original <c>Image</c>, where one still exists, shares the
/// same copy-on-write buffer and is untouched). Nothing in a non-rendering process reads those pixels back:
/// the dummy canvas renderer draws nothing, and the mirror ships scene structure plus asset URLs, never pixels.
/// The browser fetches every asset from the HOST origin, which renders for real.</para>
///
/// <para><b>How the textures are found.</b> Retained images outlive the nodes that referenced them — a texture
/// stays alive as long as anything holds it, including caches and preloads that were never in the tree — so a
/// scene-tree walk would leave most of the 456MB behind. The enumeration is instead
/// <c>ResourceLoader.ListDirectory</c> over <c>res://</c> to collect texture-source paths once, then
/// <c>ResourceLoader.GetCachedRef</c> per path, which returns a resource ONLY if it is already loaded and
/// never triggers a load. That is exactly the set the dummy renderer holds images for, since every one of them
/// got there through a <c>.ctex</c> load.
///
/// <para>Not an ObjectDB id sweep, which looks like the obvious approach and does not work: a Godot instance id
/// is <c>slot | validator &lt;&lt; 24 | is_ref_counted &lt;&lt; 63</c> (core/object/object.h), not a dense
/// counter, so ids are enormous and sparse — and every Resource is RefCounted, so every texture id has bit 63
/// set. Walking ids upward from 1 finds nothing.</para></para>
///
/// <para><b>Scope, deliberately narrow for now.</b> Only VRAM-compressed formats are evicted
/// (<see cref="EvictableFormats"/>) — the ones the host proves are dead weight. The much larger RGBA8 tier
/// (~332MB, mostly 512x512 sprite art) is left alone until this has a clean live run behind it; widening is a
/// one-line change to that set. <see cref="ImageTexture"/> is NEVER evicted regardless of format: the dummy
/// renderer's <c>texture_2d_update</c> is a no-op, so a runtime texture the game later re-uploads could not be
/// restored, whereas a <c>CompressedTexture2D</c> is backed by a <c>.ctex</c> on disk.</para>
///
/// <para>Headless clients only. Installed from <see cref="CouchCoopMod"/>.Init's headless branch.</para>
///
/// <para>Implementation note, same as <see cref="CouchCoopHeadlessCpuProfiler"/>: the mod builds against a plain
/// <c>GodotSharp.dll</c> reference with no Godot.NET.Sdk, so the source generator that routes native lifecycle
/// calls into a custom Node's <c>_Process</c> is absent and a hand-rolled override never fires. Sampling is
/// driven off a built-in <see cref="Timer"/>'s <c>Timeout</c> signal, which fires natively regardless.</para>
/// </summary>
public static class HeadlessTextureImageEvictor
{
    public const string NodeName = "CouchCoopHeadlessTextureEvictor";

    /// <summary>How often a slice runs. Slow on purpose — this is a background reclaim, not a hot path.</summary>
    private const double IntervalSeconds = 2.0;

    /// <summary>
    /// Paths examined per tick, for both the discovery walk and the eviction sweep. Each one is a hash lookup
    /// (<c>GetCachedRef</c>) or a directory listing, so a slice this size stays far below a frame while a full
    /// pass over the pack completes in seconds.
    /// </summary>
    private const int PathsPerSlice = 512;

    /// <summary>
    /// Skip anything this small. Also what makes the sweep idempotent for free: an already-evicted image is
    /// 1x1 L8, so it fails this gate on every later pass without needing a "seen" set.
    /// </summary>
    private const int MinimumPixelBytes = 4096;

    /// <summary>
    /// Extensions worth asking the resource cache about. Godot keys an imported texture's cache entry by its
    /// SOURCE path (the loader calls <c>set_path(original_path)</c>), so these are the source extensions, not
    /// <c>.ctex</c>. Filtering here is what keeps the retained path list small — a few thousand entries rather
    /// than every file in a 1.9GB pack.
    /// </summary>
    private static readonly HashSet<string> TextureExtensions =
        new(StringComparer.OrdinalIgnoreCase) { ".png", ".jpg", ".jpeg", ".webp", ".svg", ".bmp", ".tga", ".ctex" };

    /// <summary>
    /// VRAM-compressed (block-compressed) formats — the phase-1 eviction set. These are decoded by the GPU, so
    /// a CPU copy has no consumer in a process that never draws. The live host retained ~none of them.
    /// </summary>
    private static readonly HashSet<Image.Format> EvictableFormats =
    [
        Image.Format.Dxt1,
        Image.Format.Dxt3,
        Image.Format.Dxt5,
        Image.Format.Dxt5RaAsRg,
        Image.Format.RgtcR,
        Image.Format.RgtcRg,
        Image.Format.BptcRgba,
        Image.Format.BptcRgbf,
        Image.Format.BptcRgbfu,
        Image.Format.Etc,
        Image.Format.Etc2R11,
        Image.Format.Etc2R11S,
        Image.Format.Etc2Rg11,
        Image.Format.Etc2Rg11S,
        Image.Format.Etc2Rgb8,
        Image.Format.Etc2Rgba8,
        Image.Format.Etc2Rgb8A1,
        Image.Format.Etc2RaAsRg,
        Image.Format.Astc4X4,
        Image.Format.Astc4X4Hdr,
        Image.Format.Astc8X8,
        Image.Format.Astc8X8Hdr,
    ];

    private static readonly object Gate = new();
    private static bool _started;

    // All main-thread state — the timer callback is the sole reader/writer, so none of this needs a lock.

    // Discovery: a BFS frontier over res://, drained once at startup into _texturePaths. Holding the frontier
    // rather than a full file list keeps discovery's own memory to the directories still to visit.
    private static readonly Queue<string> _pendingDirectories = new();
    private static readonly List<string> _texturePaths = [];
    private static bool _discoveryComplete;

    // Eviction: a rolling cursor over _texturePaths. Wrapping re-checks everything, which is how textures
    // loaded after discovery finished get picked up; already-evicted ones fail the size gate in microseconds.
    private static int _cursor;

    /// <summary>Images whose pixel buffer was released, for the profiler line.</summary>
    public static int EvictedCount { get; private set; }

    /// <summary>Total pixel bytes released, for the profiler line.</summary>
    public static long ReclaimedBytes { get; private set; }

    /// <summary>Idempotent.</summary>
    public static void Install()
    {
        lock (Gate)
        {
            if (_started)
            {
                return;
            }

            _started = true;
        }

        _ = Task.Run(InstallLoopAsync);
    }

    // Poll from a background task until the SceneTree root exists, then marshal the timer create + attach onto
    // the GAME MAIN THREAD (creating a Godot node / touching the tree off-thread is unsafe). Mirrors
    // CouchCoopHeadlessCpuProfiler.InstallLoopAsync, which runs at the same point in Init for the same reason.
    private static async Task InstallLoopAsync()
    {
        for (var attempt = 0; attempt < 120; attempt++)
        {
            try
            {
                if (Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root))
                {
                    Callable.From(() => AttachOnMainThread(root)).CallDeferred();
                    return;
                }
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    $"[couch-coop][texevict] install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        Console.Error.WriteLine("[couch-coop][texevict] install gave up (SceneTree never became ready)");
    }

    private static void AttachOnMainThread(Node root)
    {
        if (!GodotObject.IsInstanceValid(root) || root.GetNodeOrNull(NodeName) is not null)
        {
            return;
        }

        var timer = new Godot.Timer
        {
            Name = NodeName,
            WaitTime = IntervalSeconds,
            OneShot = false,
            Autostart = true,
            ProcessMode = Node.ProcessModeEnum.Always, // keep reclaiming even if the tree pauses
        };
        timer.Timeout += Tick;
        root.AddChild(timer);
        CouchCoopLog.Info($"[couch-coop][texevict] headless texture image evictor ready (interval={IntervalSeconds:0.#}s)");
    }

    // Runs on the game main thread (Timer.Timeout).
    private static void Tick()
    {
        // Discovery first, so the seat pays the res:// walk once and then only ever does cache lookups.
        if (!_discoveryComplete)
        {
            DiscoverSlice();
            HeadlessMallocTrim.MaybeTrim();
            return;
        }

        var evictedThisSlice = 0;
        long reclaimedThisSlice = 0;

        var examined = 0;
        while (examined < PathsPerSlice && _texturePaths.Count > 0)
        {
            if (_cursor >= _texturePaths.Count)
            {
                _cursor = 0;
            }

            var path = _texturePaths[_cursor++];
            examined++;

            // GetCachedRef, NOT Load: this returns the resource only when it is ALREADY in the cache, so the
            // sweep never pulls a texture off disk that the game had not loaded — which would be the exact
            // opposite of the point.
            if (ResourceLoader.GetCachedRef(path) is not Texture2D texture)
            {
                continue;
            }

            var released = TryEvict(texture);
            if (released > 0)
            {
                evictedThisSlice++;
                reclaimedThisSlice += released;
            }
        }

        if (evictedThisSlice > 0)
        {
            EvictedCount += evictedThisSlice;
            ReclaimedBytes += reclaimedThisSlice;
            CouchCoopLog.Info(
                $"[couch-coop][texevict] released {evictedThisSlice} image(s), "
                + $"{reclaimedThisSlice / (1024.0 * 1024.0):0.0}MB this pass; "
                + $"{EvictedCount} / {ReclaimedBytes / (1024.0 * 1024.0):0.0}MB total");
        }

        // Piggyback the idle-gated heap trim on the same tick: the pages this eviction just freed are exactly
        // what glibc would otherwise hold onto, and both want the same "seat is doing nothing" signal.
        HeadlessMallocTrim.MaybeTrim();
    }

    // One slice of the res:// BFS. ResourceLoader.ListDirectory is the resource-aware listing (it resolves the
    // import remaps and hides the .import sidecars), and it works against the packed .pck exactly as it does
    // against a loose project. Directories come back suffixed with "/".
    private static void DiscoverSlice()
    {
        if (_pendingDirectories.Count == 0 && _texturePaths.Count == 0)
        {
            _pendingDirectories.Enqueue("res://");
        }

        var examined = 0;
        while (examined < PathsPerSlice && _pendingDirectories.Count > 0)
        {
            var directory = _pendingDirectories.Dequeue();
            string[] entries;
            try
            {
                entries = ResourceLoader.ListDirectory(directory);
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(
                    $"[couch-coop][texevict] cannot list {directory}: {exception.GetType().Name}: {exception.Message}");
                continue;
            }

            foreach (var entry in entries)
            {
                examined++;
                var full = directory.EndsWith('/') ? directory + entry : directory + "/" + entry;
                if (entry.EndsWith('/'))
                {
                    _pendingDirectories.Enqueue(full.TrimEnd('/'));
                    continue;
                }

                if (TextureExtensions.Contains(System.IO.Path.GetExtension(entry)))
                {
                    _texturePaths.Add(full);
                }
            }
        }

        if (_pendingDirectories.Count == 0)
        {
            _discoveryComplete = true;
            _texturePaths.TrimExcess();
            CouchCoopLog.Info($"[couch-coop][texevict] discovery complete: {_texturePaths.Count} texture path(s) under res://");
        }
    }

    /// <summary>Returns the number of pixel bytes released, or 0 if the texture was skipped.</summary>
    private static long TryEvict(Texture2D texture)
    {
        // ImageTexture and friends are written from the CPU at runtime and can only be restored by re-uploading
        // — which the dummy renderer's no-op texture_2d_update would silently drop. Only disk-backed compressed
        // textures are safe to strip, because their bytes still exist in the .ctex.
        if (texture is not CompressedTexture2D)
        {
            return 0;
        }

        try
        {
            var image = texture.GetImage();
            if (image is null || !GodotObject.IsInstanceValid(image))
            {
                return 0;
            }

            var format = image.GetFormat();

            // GetDataSize(), NOT GetData().Length — the latter marshals the whole pixel buffer into a managed
            // byte[] just to read its length, which across a full sweep would copy every byte we are trying to
            // get rid of (hundreds of MB of pure garbage) before freeing anything.
            var bytes = image.GetDataSize();
            if (bytes < MinimumPixelBytes)
            {
                return 0;
            }

            if (!EvictableFormats.Contains(format))
            {
                return 0;
            }

            // One opaque pixel in the cheapest layout. SetData replaces the Vector wholesale, so the old pixel
            // buffer's refcount drops here; the allocation is freed when no other Image shares it.
            image.SetData(1, 1, false, Image.Format.L8, [0]);
            return bytes;
        }
        catch (Exception exception)
        {
            // A texture can be freed underneath us between the sweep and the read, and a resource can refuse to
            // produce an image at all. Neither is worth failing the pass over.
            Console.Error.WriteLine(
                $"[couch-coop][texevict] skipped a texture: {exception.GetType().Name}: {exception.Message}");
            return 0;
        }
    }

}
