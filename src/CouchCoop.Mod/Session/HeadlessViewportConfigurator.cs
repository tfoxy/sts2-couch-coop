using CouchCoop.Mod.Runtime;
using Godot;
using System;
using System.Threading;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Keeps a windowless seat's mirror at Keep/1920x1080 because it has no saved aspect setting.
/// Display applies, menu mounts and root size changes can reset that policy, so their hooks schedule a
/// coalesced deferred reassertion. A wide stream owns presentation until capture teardown completes.
/// </summary>
public static class HeadlessViewportConfigurator
{
    private static readonly object Gate = new();
    private static bool _started;

    private static readonly Vector2I TargetSize = new(1920, 1080);
    private static readonly Presentation PresentationOwner = new(ApplyPresentation, OnOwnershipChanged);
    internal static Reassertion Updates { get; set; } = new(PresentationOwner, Defer, AttachRoot);

    private static void OnOwnershipChanged(bool wide)
    {
        StreamMapDrawingToolsPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamHandPlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamCreaturePlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
    }

    // Main-thread only, shared with the swap so the existing mirror re-assert cannot fight capture sizing.
    internal static void SetStreamPresentationWidth(int width) => PresentationOwner.SetStreamWidth(width);
    internal static bool StreamOwnsPresentation => PresentationOwner.StreamOwnsPresentation;

    internal static Vector2 ResolveStreamPlacement(Vector2 target, float anchorLeft)
        => PresentationOwner.ResolvePlacement(target, anchorLeft);

    internal sealed class Presentation(Func<bool, int, bool> apply, Action<bool>? onOwnershipChanged = null)
    {
        private bool _streamOwnsPresentation;
        private int _streamWidth = 1920;

        internal bool StreamOwnsPresentation => _streamOwnsPresentation;
        internal int StreamWidth => _streamWidth;

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
                onOwnershipChanged?.Invoke(true);
            }
            else if (_streamOwnsPresentation)
            {
                onOwnershipChanged?.Invoke(false);
                apply(false, 1920);
                _streamOwnsPresentation = false;
                _streamWidth = 1920;
            }
        }
    }

    /// <summary>Idempotent. Safe to call repeatedly (CouchCoopMod.Init may run more than once).</summary>
    public static void Configure()
    {
        lock (Gate)
        {
            if (_started) return;
            _started = true;
        }

        HeadlessViewportPatch.Apply();
        // Also handles initialization after the startup signal, including repeated Init on hot reload.
        Updates.Startup();
    }

    private static void Defer(Action action)
    {
        using var permit = ZeroClientGuard.Permit(ZeroClientAllowances.WindowlessViewport);
        GameMainThread.Invoke(() =>
        {
            Callable.From(action).CallDeferred();
            return true;
        });
    }

    private static bool AttachRoot()
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
            return false;
        root.SizeChanged += HeadlessViewportPatch.AfterPresentationChanged;
        return true;
    }

    // The callbacks enqueue only; root reads and the ownership check happen after synchronous handlers finish.
    internal sealed class Reassertion(Presentation presentation, Action<Action> defer, Func<bool> attachRoot)
    {
        private int _pending;
        private bool _attached;

        internal void Startup()
        {
            if (!_attached) Request();
        }

        internal void Request()
        {
            if (Interlocked.Exchange(ref _pending, 1) != 0) return;
            try
            {
                defer(Run);
            }
            catch (Exception exception)
            {
                Interlocked.Exchange(ref _pending, 0);
                LogFailure(exception);
            }
        }

        private void Run()
        {
            // A write may raise SizeChanged synchronously and enqueue a final, drift-free pass.
            Interlocked.Exchange(ref _pending, 0);
            try
            {
                if (!_attached)
                {
                    if (!attachRoot()) return;
                    _attached = true;
                }
                using var permit = ZeroClientGuard.Permit(ZeroClientAllowances.WindowlessViewport);
                presentation.ReassertMirror();
            }
            catch (Exception exception)
            {
                LogFailure(exception);
            }
        }

        private static void LogFailure(Exception exception)
            => CouchCoopLog.Stderr($"headless viewport apply failed: {exception.GetType().Name}: {exception.Message}");
    }

    private static bool ApplyPresentation(bool expand, int width)
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
        {
            return false;
        }

        return ApplyPresentation(new RootPresentationWindow(root), expand, width);
    }

    internal interface IPresentationWindow
    {
        Window.ContentScaleAspectEnum ContentScaleAspect { get; set; }
        Vector2I ContentScaleSize { get; set; }
        Vector2I Size { get; set; }
        Vector2 VisibleSize { get; }
    }

    private sealed class RootPresentationWindow(Window root) : IPresentationWindow
    {
        public Window.ContentScaleAspectEnum ContentScaleAspect
        {
            get => root.ContentScaleAspect;
            set => root.ContentScaleAspect = value;
        }
        public Vector2I ContentScaleSize { get => root.ContentScaleSize; set => root.ContentScaleSize = value; }
        public Vector2I Size { get => root.Size; set => root.Size = value; }
        public Vector2 VisibleSize => root.GetVisibleRect().Size;
    }

    internal static bool ApplyPresentation(IPresentationWindow root, bool expand, int width)
    {
        var beforeAspect = root.ContentScaleAspect;
        var beforeContent = root.ContentScaleSize;
        var beforeWindow = root.Size;
        var aspect = expand ? Window.ContentScaleAspectEnum.Expand : Window.ContentScaleAspectEnum.Keep;
        var windowSize = new Vector2I(width, TargetSize.Y);

        var changed = false;
        // Resize first so synchronous resize handlers cannot overwrite the final content policy.
        if (root.Size != windowSize)
        {
            root.Size = windowSize;
            changed = true;
        }

        if (root.ContentScaleAspect != aspect || root.ContentScaleSize != TargetSize)
        {
            root.ContentScaleAspect = aspect;
            root.ContentScaleSize = TargetSize;
            changed = true;
        }

        if (changed)
        {
            CouchCoopLog.Stderr(
                $"headless viewport: aspect {beforeAspect}->{aspect}, content {beforeContent}->{TargetSize}, "
                + $"window {beforeWindow}->{root.Size}, visible={root.VisibleSize}");
        }

        return true;
    }
}
