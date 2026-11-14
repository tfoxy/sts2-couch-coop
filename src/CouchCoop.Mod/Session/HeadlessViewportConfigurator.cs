using CouchCoop.Mod.Runtime;
using Godot;
using System;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Forces a headless co-op client's root window to render a fixed 16:9 (1920x1080) design space, so its browser
/// mirror fills the width like the real 16:9 host instead of showing a pillar-boxed square.
/// A wide render-stream arm temporarily owns the presentation until capture teardown completes.
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
    private static readonly Presentation PresentationOwner = new(ApplyPresentation);

    // Main-thread only, shared with the swap so the existing mirror re-assert cannot fight capture sizing.
    internal static void SetStreamPresentationWidth(int width) => PresentationOwner.SetStreamWidth(width);
    internal static bool StreamOwnsPresentation => PresentationOwner.StreamOwnsPresentation;

    internal static Vector2 ResolveStreamPlacement(Vector2 target, float anchorLeft)
        => PresentationOwner.ResolvePlacement(target, anchorLeft);

    internal sealed class Presentation(Func<bool, int, bool> apply)
    {
        private bool _streamOwnsPresentation;
        private int _streamWidth = 1920;

        internal bool StreamOwnsPresentation => _streamOwnsPresentation;

        internal bool ReassertMirror() => _streamOwnsPresentation || apply(false, 1920);

        // Preserve the design-space placement, carried across the extra width by the control's anchor.
        // A mirror or 16:9 stream returns the original target exactly, including throughout swap-back.
        internal Vector2 ResolvePlacement(Vector2 target, float anchorLeft)
            => _streamOwnsPresentation
                ? new Vector2(target.X * 1920 / _streamWidth + anchorLeft * (_streamWidth - 1920), target.Y)
                : target;

        internal void SetStreamWidth(int width)
        {
            if (width > 1920)
            {
                _streamWidth = width;
                _streamOwnsPresentation = true;
                apply(true, width);
            }
            else if (_streamOwnsPresentation)
            {
                apply(false, 1920);
                _streamOwnsPresentation = false;
                _streamWidth = 1920;
            }
        }
    }

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
            // ApplyOnce runs on the game main thread (the dispatcher posts to the captured game context). Only a
            // windowless instance reaches here, which is why the zero-client tripwire excuses it (see the allowance).
            using var permit = ZeroClientGuard.Permit(ZeroClientAllowances.WindowlessViewport);
            return GameMainThread.Invoke(ApplyOnce);
        }
        catch (Exception exception)
        {
            threw = true;
            CouchCoopLog.Stderr($"headless viewport apply failed: {exception.GetType().Name}: {exception.Message}");
            return false;
        }
    }

    // Runs on the main thread. Capture ownership suppresses even the root read in the mirror's existing loop.
    private static bool ApplyOnce() => PresentationOwner.ReassertMirror();

    private static bool ApplyPresentation(bool expand, int width)
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            return false;
        }

        var beforeAspect = root.ContentScaleAspect;
        var beforeContent = root.ContentScaleSize;
        var beforeWindow = root.Size;
        var aspect = expand ? Window.ContentScaleAspectEnum.Expand : Window.ContentScaleAspectEnum.Keep;
        var windowSize = new Vector2I(width, TargetSize.Y);

        var changed = false;
        if (root.ContentScaleAspect != aspect || root.ContentScaleSize != TargetSize)
        {
            root.ContentScaleAspect = aspect;
            root.ContentScaleSize = TargetSize;
            changed = true;
        }

        // Keep the window and content policy in sync: mirror uses 16:9, while a wide capture expands the visible rect.
        if (root.Size != windowSize)
        {
            root.Size = windowSize;
            changed = true;
        }

        if (changed)
        {
            CouchCoopLog.Stderr(
                $"headless viewport: aspect {beforeAspect}->{aspect}, content {beforeContent}->{TargetSize}, "
                + $"window {beforeWindow}->{root.Size}, visible={root.GetVisibleRect().Size}");
        }

        return true;
    }
}
