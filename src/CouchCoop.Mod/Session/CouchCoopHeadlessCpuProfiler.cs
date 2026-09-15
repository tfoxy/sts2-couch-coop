using Godot;
using System;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Headless-only CPU attribution logger. Once per interval, on the game main thread, it reads Godot's built-in
/// <see cref="Performance"/> monitors and logs a single line to the per-slot <c>godot.log</c> — so we can see
/// where the frame budget goes (script <c>_process</c> vs <c>_physics_process</c> vs the render+engine
/// remainder, plus draw-call / object / node counts) WITHOUT an external profiler or a version-matched Godot
/// editor (the shipped game is Godot 4.5.1; only a 4.6.2 editor is installed here, which won't remote-attach).
///
/// Implementation note: the mod builds against a plain <c>GodotSharp.dll</c> reference (no Godot.NET.Sdk), so
/// the source generator that routes native lifecycle calls into a custom Node's <c>_Process</c> override is NOT
/// active — a hand-rolled <c>Node._Process</c> is simply never invoked. So we drive sampling off a built-in
/// <see cref="Timer"/>'s <c>Timeout</c> signal instead (the same pattern spirectl's main-thread pump uses),
/// which fires natively regardless of the generator. Output goes through <see cref="CouchCoopLog"/> (not
/// <c>Console.Error</c>, whose stream a detached game discards) so it lands, tagged <c>[INFO]</c>, in
/// <c>user://logs/godot.log</c>.
///
/// Gated behind env <c>COUCHCOOP_HEADLESS_PROFILE=1</c> (silent in production; a profiling run exports it and
/// the headless children inherit it). Installed from <see cref="CouchCoopMod"/>.Init's headless branch.
/// </summary>
public static class CouchCoopHeadlessCpuProfiler
{
    public const string NodeName = "CouchCoopHeadlessCpuProfiler";
    private const double IntervalSeconds = 1.0;

    private static readonly object Gate = new();
    private static bool _started;

    // Track process CPU time + wall time across samples to derive real CPU% (100% = one core), which — unlike the
    // per-frame render_ms remainder — is decoupled from the game's frame pacing (at the menu the loop sleeps to a
    // ~24fps cap, so render_ms is mostly idle, not CPU). cpu% is the number that actually answers "how loaded".
    private static long _lastProcMs;
    private static long _lastWallMs;

    /// <summary>Idempotent. No-op unless COUCHCOOP_HEADLESS_PROFILE=1.</summary>
    public static void Install()
    {
        if (System.Environment.GetEnvironmentVariable("COUCHCOOP_HEADLESS_PROFILE") != "1")
        {
            return;
        }

        lock (Gate)
        {
            if (_started)
            {
                return;
            }

            _started = true;
        }

        Console.Error.WriteLine("[couchcoop][profile] headless CPU profiler enabling (COUCHCOOP_HEADLESS_PROFILE=1)");
        _ = Task.Run(InstallLoopAsync);
    }

    // Poll from a background task until the SceneTree root exists, then marshal the timer create + attach onto the
    // GAME MAIN THREAD via Callable.From(...).CallDeferred() (creating a Godot node / touching the tree off-thread
    // is unsafe; the mod's Init runs before the pump is marshaling, so this is the reliable path).
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
                    $"[couchcoop][profile] profiler install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        Console.Error.WriteLine("[couchcoop][profile] profiler install gave up (SceneTree never became ready)");
    }

    // Runs on the game main thread (deferred). Attaches a repeating Timer whose Timeout drives sampling.
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
            ProcessMode = Node.ProcessModeEnum.Always, // keep sampling even if the tree pauses
        };
        timer.Timeout += Sample;
        root.AddChild(timer);
        CouchCoopLog.Info($"[couchcoop][profile] headless CPU profiler ready (interval={IntervalSeconds:0.#}s)");
    }

    // Runs on the game main thread (Timer.Timeout). Reads the monitors and logs one line.
    private static void Sample()
    {
        // TimeProcess / TimePhysicsProcess are seconds spent in the script _process / _physics_process steps
        // last frame; the rest of the frame budget (1/fps − those) is the render+engine slice. Draw-call /
        // object / primitive counts confirm rasterization load; node count + static memory track tree size.
        var fps = Performance.GetMonitor(Performance.Monitor.TimeFps);
        var processMs = Performance.GetMonitor(Performance.Monitor.TimeProcess) * 1000.0;
        var physicsMs = Performance.GetMonitor(Performance.Monitor.TimePhysicsProcess) * 1000.0;
        var frameMs = fps > 0 ? 1000.0 / fps : 0.0;
        var renderMs = Math.Max(0.0, frameMs - processMs - physicsMs);
        var drawCalls = Performance.GetMonitor(Performance.Monitor.RenderTotalDrawCallsInFrame);
        var objects = Performance.GetMonitor(Performance.Monitor.RenderTotalObjectsInFrame);
        var primitives = Performance.GetMonitor(Performance.Monitor.RenderTotalPrimitivesInFrame);
        var nodes = Performance.GetMonitor(Performance.Monitor.ObjectNodeCount);
        var memMb = Performance.GetMonitor(Performance.Monitor.MemoryStatic) / (1024.0 * 1024.0);

        // Real process CPU% since the last sample (100% = one full core), independent of frame pacing.
        var nowWallMs = System.Environment.TickCount64;
        var nowProcMs = (long)System.Diagnostics.Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds;
        var cpuPct = double.NaN;
        if (_lastWallMs != 0 && nowWallMs > _lastWallMs)
        {
            cpuPct = 100.0 * (nowProcMs - _lastProcMs) / (nowWallMs - _lastWallMs);
        }
        _lastWallMs = nowWallMs;
        _lastProcMs = nowProcMs;

        CouchCoopLog.Info(
            $"[couchcoop][profile] cpu%={cpuPct:0.0} fps={fps:0.0} frame_ms={frameMs:0.00} process_ms={processMs:0.00} "
            + $"physics_ms={physicsMs:0.00} render_ms~={renderMs:0.00} drawcalls={drawCalls:0} "
            + $"objs={objects:0} prims={primitives:0} nodes={nodes:0} mem_mb={memMb:0.0}");

        SampleMemory();
    }

    // Second line, memory attribution. Split from the cpu line because the two answer different questions and
    // are read separately (a memory round greps `[couchcoop][memory]`, a cpu round greps `[couchcoop][profile]`).
    //
    // rss_mb is the number that actually matters — Godot's MemoryStatic counts only what went through Godot's
    // own `Memory::alloc_static`, which misses the CLR entirely (GC heap + JIT code + loader heaps were ~300MB
    // of a measured 1374MB seat) and, more importantly, misses nothing about the dummy renderer's retained
    // texture images but gives no way to separate them. For the per-image breakdown use
    // `scripts/headless-memory-census.py --images <pid>`, which reads this process from the outside; these
    // counters are the cheap in-process trend line that says WHEN to go run it.
    private static void SampleMemory()
    {
        var staticMb = Performance.GetMonitor(Performance.Monitor.MemoryStatic) / (1024.0 * 1024.0);
        var staticMaxMb = Performance.GetMonitor(Performance.Monitor.MemoryStaticMax) / (1024.0 * 1024.0);
        var objectCount = Performance.GetMonitor(Performance.Monitor.ObjectCount);
        var resourceCount = Performance.GetMonitor(Performance.Monitor.ObjectResourceCount);
        var managedMb = GC.GetTotalMemory(forceFullCollection: false) / (1024.0 * 1024.0);

        CouchCoopLog.Info(
            $"[couchcoop][memory] rss_mb={ReadResidentMb():0.0} godot_static_mb={staticMb:0.0} "
            + $"godot_static_max_mb={staticMaxMb:0.0} clr_managed_mb={managedMb:0.0} "
            + $"objects={objectCount:0} resources={resourceCount:0} "
            + $"tex_images_evicted={HeadlessTextureImageEvictor.EvictedCount} "
            + $"tex_mb_reclaimed={HeadlessTextureImageEvictor.ReclaimedBytes / (1024.0 * 1024.0):0.0}");
    }

    // Resident set size from /proc/self/statm field 2 (pages). Linux-only, which is the only platform a couch
    // seat runs on; anything unreadable reports -1 rather than throwing inside the sampler.
    private static double ReadResidentMb()
    {
        try
        {
            var fields = System.IO.File.ReadAllText("/proc/self/statm").Split(' ');
            if (fields.Length >= 2 && long.TryParse(fields[1], out var pages))
            {
                return pages * 4096.0 / (1024.0 * 1024.0);
            }
        }
        catch (Exception exception) when (exception is System.IO.IOException or UnauthorizedAccessException)
        {
            // Fall through to the sentinel.
        }

        return -1.0;
    }
}
