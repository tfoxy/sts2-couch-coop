using Godot;
using Spirectl.Sts2.Live;
using System;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Forces a headless co-op client's root window to render a fixed 16:9 (1920x1080) design space, so its browser
/// mirror fills the width like the real 16:9 host instead of showing a pillar-boxed square.
///
/// Why this is needed: the project uses stretch mode <c>canvas_items</c> with aspect <c>expand</c>, and the game
/// only pins a fixed <c>ContentScaleAspect = Keep</c> + <c>ContentScaleSize</c> once the player has picked a
/// non-Auto aspect ratio in settings. A headless client has no saved settings, so it stays on Auto → Expand. With no real 16:9 window the windowless viewport grows to a ~1920x1920 SQUARE, which lays out
/// bottom-anchored UI (the character-select buttons) below a 16:9 frame and leaves wide pillar-boxes in the
/// mirror. We apply the same 16:9 answer the game would (Keep + 1920x1080) so the headless lays out exactly
/// like a 16:9 host. The mirror renders the scene tree (canvas-space node rects), so the content space — not the
/// square framebuffer — is what it reflects.
///
/// Timing: the mod's Init runs very early (ModInitializer / ExecuteVeryEarly), BEFORE the SceneTree/main loop
/// exists, so we can't touch the root window inline. We retry on the GAME MAIN THREAD via
/// <see cref="Sts2MainThreadDispatcher"/> (whose context is captured during runtime creation in this same Init)
/// until the root window exists, then re-assert a few more times to win any race with the game's own display apply.
/// </summary>
public static class HeadlessViewportConfigurator
{
    private static readonly object Gate = new();
    private static bool _started;

    private static readonly Vector2I TargetSize = new(1920, 1080);

    // Phase 1: poll fast (0.25s) until the tree exists + a handful of successful re-asserts win the startup race
    // with NGame's own display apply. Phase 2: keep re-asserting at a low steady rate FOR THE PROCESS LIFETIME —
    // NGame re-applies its display settings on later screen transitions (a headless on the Auto setting reverts to
    // Expand → the square viewport returns + off-16:9 content leaks back into the mirror), so a one-shot converge
    // isn't enough. The steady check is cheap (3 property reads; a set only on drift). It exits only when the
    // dispatcher throws repeatedly (the game is shutting down).
    private const int FastIntervalMs = 250;
    private const int MaxFastAttempts = 80;          // ~20s of fast polling for the tree
    private const int ReassertCount = 8;             // successful fast re-asserts before settling to steady
    private const int SteadyIntervalMs = 2000;       // low-rate drift re-assert thereafter
    private const int MaxConsecutiveDispatchFailures = 20;  // ~40s of dispatcher errors ⇒ game gone, stop

    /// <summary>Idempotent. Safe to call repeatedly (CouchCoopMod.Init may run more than once).</summary>
    public static void Configure()
    {
        lock (Gate)
        {
            if (_started)
            {
                return;
            }

            _started = true;
        }

        CouchCoopLog.Stderr("headless viewport configurator starting");
        _ = Task.Run(ConfigureLoopAsync);
    }

    private static async Task ConfigureLoopAsync()
    {
        // Phase 1 — converge fast: poll until the tree exists and we've re-asserted a few times.
        var applied = 0;
        for (var attempt = 0; attempt < MaxFastAttempts && applied < ReassertCount; attempt++)
        {
            if (TryApply(out _))
            {
                applied++;
            }

            await Task.Delay(FastIntervalMs).ConfigureAwait(false);
        }

        // Phase 2 — persist: re-assert on drift at a low steady rate until the dispatcher gives up (game gone).
        var consecutiveFailures = 0;
        while (consecutiveFailures < MaxConsecutiveDispatchFailures)
        {
            consecutiveFailures = TryApply(out var threw) ? 0 : (threw ? consecutiveFailures + 1 : 0);
            await Task.Delay(SteadyIntervalMs).ConfigureAwait(false);
        }
    }

    // Run ApplyOnce on the game main thread. Returns true once it could inspect/assert the root window; `threw`
    // is set when the dispatcher itself faulted (distinct from "tree not ready yet", which just returns false).
    private static bool TryApply(out bool threw)
    {
        threw = false;
        try
        {
            // ApplyOnce runs on the game main thread (the dispatcher posts to the captured game context).
            return Sts2MainThreadDispatcher.Invoke(ApplyOnce);
        }
        catch (Exception exception)
        {
            threw = true;
            CouchCoopLog.Stderr($"headless viewport apply failed: {exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    // Runs on the main thread. Returns false until the root window exists (so the caller keeps retrying), true
    // once we've been able to inspect/assert it.
    private static bool ApplyOnce()
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            return false;
        }

        var beforeAspect = root.ContentScaleAspect;
        var beforeContent = root.ContentScaleSize;
        var beforeWindow = root.Size;

        var changed = false;
        if (root.ContentScaleAspect != Window.ContentScaleAspectEnum.Keep || root.ContentScaleSize != TargetSize)
        {
            root.ContentScaleAspect = Window.ContentScaleAspectEnum.Keep;
            root.ContentScaleSize = TargetSize;
            changed = true;
        }

        // Belt-and-suspenders: the mirror reflects canvas-space node rects, which in canvas_items mode follow the
        // 2D size override (content scale). If the headless still lays out square, also pin the window size so the
        // root viewport itself is 16:9.
        if (root.Size != TargetSize)
        {
            root.Size = TargetSize;
            changed = true;
        }

        if (changed)
        {
            CouchCoopLog.Stderr(
                $"headless viewport: aspect {beforeAspect}->Keep, content {beforeContent}->{TargetSize}, "
                + $"window {beforeWindow}->{root.Size}, visible={root.GetVisibleRect().Size}");
        }

        return true;
    }
}
