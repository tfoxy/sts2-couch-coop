using Godot;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Headless-only: permanently disables FMOD audio on a spawned co-op mirror client to reclaim the native FMOD
/// software mixer/DSP thread. That thread mixes the (silent) master bus every audio buffer regardless of whether
/// any sound plays — it is frame-rate INDEPENDENT, so the idle-fps throttle and <see cref="HeadlessAudioMutePatch"/>
/// (which only skip the play calls) cannot touch it; only tearing the FMOD system down does. A headless client
/// never outputs audio (the human hears the host), so the system is pure waste here.
///
/// FMOD in STS2 is the <c>utopia-rise/fmod-gdextension</c> exposed as the engine singleton <c>FmodServer</c>,
/// bootstrapped by a GDScript AUTOLOAD <c>FmodManager</c> (node <c>/root/FmodManager</c>): its <c>_ready</c> inits
/// the system + loads startup banks, and its <c>_process</c> calls <c>FmodServer.update()</c> EVERY FRAME. The
/// only exposed lever that removes the mixer thread is <c>FmodServer.shutdown()</c> (mute/pause and the underlying
/// NRT/mixer-suspend calls are not surfaced by this GDExtension).
///
/// CRASH HISTORY / SAFETY INVARIANT: an earlier attempt that called <c>shutdown()</c> alone SIGSEGV'd the process
/// (fault at +0x50 in <c>libGodotFmod...so</c>) because the <c>FmodManager</c> autoload kept calling
/// <c>FmodServer.update()</c> on the freed system every frame. The fix here is ORDER: first stop that autoload's
/// per-frame processing, THEN shut the system down. This class NEVER calls <c>shutdown()</c> unless it has found
/// <c>/root/FmodManager</c> and disabled its processing first — if the autoload is absent (a future game/addon
/// change), it aborts without shutting down, so it can't re-trigger the crash. Pair with
/// <see cref="HeadlessAudioMutePatch"/>, which no-ops every <c>NAudioManager</c>/<c>NRunMusicController</c> forward
/// so no VANILLA game code re-enters the torn-down system (notably per-act bank load/unload on act transitions).
///
/// THAT MUTE PATCH IS NOT A GUARANTEE — it is a list, and a list only covers callers we compiled against.
/// This class doc used to claim the pair made it impossible for anything to re-enter the released system. That
/// was false the moment a third-party mod was installed. A MOD's own audio helper is on nobody's list, and a
/// well-written one resolves the singleton per call behind exactly the guards that all still pass after
/// <c>shutdown()</c> — <c>has_singleton</c> true, <c>is_instance_valid</c> true — because <c>shutdown()</c>
/// frees the NATIVE system while leaving the GODOT object registered and alive. Measured, 2026-09-16: with
/// Downfall installed, a viewer tapping a modded character in the browser mirror killed the seat with a native
/// SIGSEGV inside <c>libGodotFmod…so</c> (faults at +0x50 / +0x90), nothing in <c>godot.log</c>, no managed
/// exception for the mod's own try/catch to catch. The hole is the DOORWAY, not the caller list, so
/// <see cref="Teardown"/> now closes the doorway (<see cref="FmodSingletonStub.CloseDoorways"/>) BEFORE
/// releasing the system, leaving no window in between. Read that class for the ladder and for the residual
/// risk we knowingly keep.
///
/// A second, quieter ordering hazard: the addon's <c>FmodListener2D</c>/<c>FmodListener3D</c> nodes call
/// <c>FmodServer.remove_listener()</c> from their own <c>_exit_tree</c>. Left attached, that only fires when the
/// whole <see cref="SceneTree"/> tears down at process exit — long after <c>shutdown()</c> already ran — and
/// <c>remove_listener()</c> against the released system push_errors (<c>"Cannot set listener 0 weight to 0"</c>).
/// So <see cref="Teardown"/> detaches every listener node it can find (by class, not by one hardcoded path) with an
/// explicit, synchronous <c>RemoveChild</c> BEFORE calling <c>shutdown()</c> — that is what actually fires
/// <c>_exit_tree</c> immediately, while the system is still alive — then frees the now-detached node afterwards.
///
/// Implementation mirrors <see cref="CouchCoopHeadlessVisualSuspender"/> / <see cref="CouchCoopHeadlessCpuProfiler"/>:
/// the mod has no Godot source generator so a custom <c>Node._Process</c> never fires; a background <see cref="Task"/>
/// waits for the SceneTree root, then a built-in <see cref="Godot.Timer"/> drives an on-main-thread PROBE that waits
/// until <c>FmodServer</c> + <c>FmodManager</c> are both ready (plus a short settle for startup banks) and performs
/// the one-shot teardown. All tree/singleton access happens on the game main thread. Output via
/// <see cref="CouchCoopLog"/> lands (tagged <c>[INFO]</c>) in the per-slot <c>user://logs/godot.log</c>.
///
/// Installed from <see cref="CouchCoopMod"/>.Init's headless branch, after
/// <see cref="HeadlessAudioMutePatch.Apply"/>.
/// </summary>
public static class HeadlessFmodShutdown
{
    public const string NodeName = "CouchCoopHeadlessFmodShutdown";

    private const string FmodServerSingleton = "FmodServer";
    private const string FmodManagerAutoloadPath = "FmodManager"; // autoloads are direct children of /root
    private const string ShutdownMethod = "shutdown";

    // Probe cadence + bounds (all counted in probe ticks). Poll for readiness up to ~60s, then settle ~2s so the
    // autoload's startup bank load has finished before we tear the system down.
    private const double ProbeIntervalSeconds = 0.5;
    private const int MaxReadinessProbes = 120; // 120 * 0.5s = 60s
    private const int SettleProbes = 4;         // 4 * 0.5s = 2s after everything is ready

    // Unverified sibling audio-driver nodes some builds may have; disabled defensively if present, NOT load-bearing.
    // FmodManager is the only CONFIRMED per-frame update() driver — these are best-effort extras.
    private static readonly string[] SiblingAudioNodePaths =
    [
        "Game/FmodBankLoader",
    ];

    // fmod-gdextension's registered listener classes (res://addons/fmod/fmod.gdextension's [icons] section lists
    // both). Discovered BY TYPE via a tree walk rather than trusting one hardcoded path — the scene may have a 3D
    // listener, more than one, or move it, and a path miss would silently leave the shutdown-ordering hazard live.
    private static readonly string[] FmodListenerClassNames = ["FmodListener2D", "FmodListener3D"];

    private static readonly object Gate = new();
    private static bool _started;

    // Main-thread-only state (mutated inside the Timer-driven Probe, which runs on the game main thread).
    private static bool _done;
    private static int _readinessProbes;
    private static int _settleProbes;

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

        CouchCoopLog.Stderr("[fmod] headless FMOD disable enabling");
        _ = Task.Run(InstallLoopAsync);
    }

    // Background poll only for the SceneTree root (exactly like the profiler/suspender). Everything that touches the
    // tree or the singleton is deferred onto the main thread; nothing races off-thread.
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
                CouchCoopLog.Stderr(
                    $"[fmod] install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(250).ConfigureAwait(false);
        }

        CouchCoopLog.Stderr("[fmod] install gave up (SceneTree never became ready)");
    }

    // Runs on the game main thread (deferred). Attaches a repeating Timer whose Timeout drives the readiness Probe.
    private static void AttachOnMainThread(Node root)
    {
        if (!GodotObject.IsInstanceValid(root) || root.GetNodeOrNull(NodeName) is not null)
        {
            return;
        }

        var timer = new Godot.Timer
        {
            Name = NodeName,
            WaitTime = ProbeIntervalSeconds,
            OneShot = false,
            Autostart = true,
            ProcessMode = Node.ProcessModeEnum.Always, // keep probing even if the tree pauses
        };
        timer.Timeout += () => Probe(root, timer);
        root.AddChild(timer);
        CouchCoopLog.Info("[fmod] headless FMOD-disable armed; waiting for FmodServer + FmodManager to be ready.");
    }

    // Runs on the game main thread (Timer.Timeout). Waits until the FmodServer singleton AND the FmodManager autoload
    // both exist (+ a short settle for startup banks), then performs the one-shot teardown and removes the timer.
    private static void Probe(Node root, Godot.Timer timer)
    {
        if (_done || !GodotObject.IsInstanceValid(root))
        {
            CleanupTimer(timer);
            return;
        }

        var fmodManager = root.GetNodeOrNull(FmodManagerAutoloadPath);
        var ready = Engine.HasSingleton(FmodServerSingleton)
            && fmodManager is not null
            && GodotObject.IsInstanceValid(fmodManager);

        if (!ready)
        {
            if (++_readinessProbes > MaxReadinessProbes)
            {
                CouchCoopLog.Info(
                    "[fmod] gave up waiting for FmodServer/FmodManager — FMOD left running (nothing disabled).");
                _done = true;
                CleanupTimer(timer);
            }

            return;
        }

        // Ready. Let a couple of probes pass so the autoload's startup bank load finishes before we tear down.
        if (++_settleProbes < SettleProbes)
        {
            return;
        }

        Teardown(root, fmodManager!);
        _done = true;
        CleanupTimer(timer);
    }

    // Runs on the game main thread. ORDER IS THE SAFETY CONTRACT: stop the per-frame FmodServer.update() driver
    // BEFORE releasing the system, so nothing calls update() on freed state (the prior SIGSEGV cause). Reached only
    // when fmodManager is a valid node — the invariant "never shutdown() unless the update() driver was neutralized".
    private static void Teardown(Node root, Node fmodManager)
    {
        // 1) Kill the update() driver: the FmodManager autoload's per-frame _process.
        fmodManager.SetProcess(false);
        fmodManager.SetPhysicsProcess(false);
        fmodManager.ProcessMode = Node.ProcessModeEnum.Disabled;
        CouchCoopLog.Info("[fmod] disabled /root/FmodManager processing (stops per-frame FmodServer.update()).");

        // Defensive extras (unverified node paths; harmless if absent, not required for correctness).
        foreach (var path in SiblingAudioNodePaths)
        {
            var node = root.GetNodeOrNull(path);
            if (node is not null && GodotObject.IsInstanceValid(node))
            {
                node.ProcessMode = Node.ProcessModeEnum.Disabled;
                CouchCoopLog.Info($"[fmod] disabled '{path}' processing (defensive).");
            }
        }

        // 2) Detach any FMOD listener node(s) BEFORE releasing the system: each one's _exit_tree calls
        // FmodServer.remove_listener(), which must run while FmodServer is still alive (see class doc). RemoveChild
        // fires _exit_tree synchronously, right here — QueueFree alone would only defer it to the SceneTree's final
        // teardown at process exit, long after shutdown() below has already run.
        var detachedListeners = DetachFmodListeners(root);

        // 3) Close the DOORWAY before releasing the system, so there is never a window in which the engine
        // singleton resolves to an object whose native system is gone. This is what protects callers we did
        // not compile against — any third-party mod's audio helper — and it captures the REAL singleton object
        // on the way through, which is what step 4 shuts down. See FmodSingletonStub for the fallback ladder.
        var doorways = FmodSingletonStub.CloseDoorways();

        // 4) Now safe: release the FMOD system and its mixer/DSP thread. Called on the RETAINED real object —
        // the name may now point at the no-op stub, and registration is irrelevant to a direct Call().
        // Resolve through the doorway result when there is one, and only fall back to the live registry when the
        // swap never saw this name — asking the registry AFTER a successful swap would hand back the no-op stub
        // and 'shutdown()' on the stub would return null while the real mixer thread kept running, logged as a
        // success. The fallback exists for the case where CloseDoorways found nothing at all.
        var doorway = doorways.FirstOrDefault(d => d.Name == FmodServerSingleton);
        var server = doorway is not null
            ? doorway.Real
            : Engine.HasSingleton(FmodServerSingleton) ? Engine.GetSingleton(FmodServerSingleton) : null;
        if (server is not null && GodotObject.IsInstanceValid(server) && server.HasMethod(ShutdownMethod))
        {
            server.Call(ShutdownMethod);
            CouchCoopLog.Info(
                "[fmod] FmodServer.shutdown() called — mixer/DSP thread released; headless audio fully off.");
        }
        else
        {
            CouchCoopLog.Info(
                "[fmod] FmodServer singleton/shutdown() unavailable at teardown — left running (update() already disabled).");
        }

        // 5) Free the detached listener node(s) now that they're safely outside the tree. Their _exit_tree already
        // ran in step 2 while FmodServer was alive; freeing an out-of-tree node does not re-dispatch _exit_tree, so
        // this cannot re-run remove_listener() against the now-released system.
        foreach (var listener in detachedListeners)
        {
            if (GodotObject.IsInstanceValid(listener))
            {
                listener.QueueFree();
            }
        }
    }

    // Runs on the game main thread, called from Teardown before shutdown(). Walks the tree looking for FMOD
    // listener nodes BY TYPE (GetClass() against the fmod-gdextension's registered class names) rather than
    // trusting one hardcoded path, and detaches each one it finds so its _exit_tree fires now, while the system is
    // still alive. Returns the detached nodes so the caller can free them only once shutdown() has run.
    private static List<Node> DetachFmodListeners(Node root)
    {
        var detached = new List<Node>();

        if (!GodotObject.IsInstanceValid(root))
        {
            return detached;
        }

        var stack = new Stack<Node>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (!GodotObject.IsInstanceValid(current))
            {
                continue;
            }

            if (Array.IndexOf(FmodListenerClassNames, current.GetClass()) >= 0)
            {
                var path = current.GetPath();
                var parent = current.GetParentOrNull<Node>();
                if (parent is not null && GodotObject.IsInstanceValid(parent))
                {
                    parent.RemoveChild(current);
                    detached.Add(current);
                    CouchCoopLog.Info(
                        $"[fmod] detached '{current.GetClass()}' at '{path}' from the tree before shutdown (its _exit_tree calls FmodServer.remove_listener).");
                }
                else
                {
                    CouchCoopLog.Info(
                        $"[fmod] found '{current.GetClass()}' at '{path}' with no parent to detach from — left as-is.");
                }

                // Listener nodes are leaves in practice; no need to descend into them.
                continue;
            }

            foreach (var child in current.GetChildren())
            {
                if (GodotObject.IsInstanceValid(child))
                {
                    stack.Push(child);
                }
            }
        }

        if (detached.Count == 0)
        {
            CouchCoopLog.Info(
                "[fmod] no FMOD listener node found in the tree — nothing to detach before shutdown.");
        }

        return detached;
    }

    private static void CleanupTimer(Godot.Timer timer)
    {
        if (GodotObject.IsInstanceValid(timer))
        {
            timer.Stop();
            timer.QueueFree();
        }
    }
}
