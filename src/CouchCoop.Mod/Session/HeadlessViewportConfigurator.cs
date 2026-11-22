using CouchCoop.Mod.Runtime;
using Godot;
using MegaCrit.Sts2.Core.Saves;
using MegaCrit.Sts2.Core.Settings;
using System;
using System.Threading;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Keeps a windowless seat's mirror at Keep/1920x1080 and a windowed capture letterboxed.
/// Display applies, menu mounts and root size changes can reset that policy, so their hooks schedule a
/// coalesced deferred reassertion. A stream owns presentation until capture teardown completes.
/// </summary>
public static class HeadlessViewportConfigurator
{
    private static readonly object Gate = new();
    private static bool _started;

    private static readonly Vector2I TargetSize = new(1920, 1080);
    private static Presentation PresentationOwner = new(ApplyPresentation, OnOwnershipChanged);
    private static bool _presentationInitialized;
    internal static event Action? PresentationInvalidated;
    internal static event Action<bool>? PresentationReasserted;
    internal static Reassertion Updates { get; set; } = new(PresentationOwner, Defer, AttachRoot,
        () => PresentationInvalidated?.Invoke(), ok => PresentationReasserted?.Invoke(ok));

    private static void OnOwnershipChanged(bool wide)
    {
        StreamMapDrawingToolsPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamHandPlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamCardRewardPlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamCreaturePlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
        StreamEnergyPlacementPatch.SetWidth(wide ? PresentationOwner.StreamWidth : 1920);
    }

    // Main-thread only, shared with the swap so the existing mirror re-assert cannot fight capture sizing.
    internal static void SetStreamPresentationWidth(int width) => PresentationOwner.SetStreamWidth(width);
    internal static bool TrySetStreamPresentationWidth(int width) => PresentationOwner.TrySetStreamWidth(width);
    internal static bool TryRestoreMirrorPresentation() => PresentationOwner.TryRestoreMirror();
    internal static bool StreamOwnsPresentation => PresentationOwner.StreamOwnsPresentation;
    internal static bool WindowedHostPresentation => PresentationOwner.IsWindowed;

    // Choose once, after capture loading, before a browser can acquire presentation.
    internal static void InitializePresentation(bool windowedHostCapture)
    {
        if (_presentationInitialized) return;
        _presentationInitialized = true;
        if (windowedHostCapture)
            PresentationOwner = new(ApplyPresentation, OnOwnershipChanged, GetRootPresentationWindow,
                UsesAutoAspect, () => HeadlessViewportPatch.AutoHandlersPatched, Defer);
        Updates = new(PresentationOwner, Defer, AttachRoot,
            () => PresentationInvalidated?.Invoke(), ok => PresentationReasserted?.Invoke(ok));
    }

    internal static bool UsesAutoAspect()
        => SaveManager.Instance?.SettingsSave.AspectRatioSetting == AspectRatioSetting.Auto;

    internal static Vector2 ResolveStreamPlacement(Vector2 target, float anchorLeft)
        => PresentationOwner.ResolvePlacement(target, anchorLeft);

    internal sealed class Presentation(Func<bool, int, bool> apply, Action<bool>? onOwnershipChanged = null,
        Func<IPresentationWindow?>? windowedRoot = null, Func<bool>? usesAutoAspect = null,
        Func<bool>? canPauseAuto = null, Action<Action>? deferAutoFit = null)
    {
        private bool _streamOwnsPresentation;
        private int _streamWidth = 1920;
        private sealed record DisplaySettings(Vector2I Size, Window.ContentScaleAspectEnum Aspect,
            Window.ContentScaleModeEnum Mode);
        private DisplaySettings? _restoreSettings;
        private bool _adoptDisplaySettings;
        private Action? _pendingAutoFit;

        // Auto re-fits the picture to the window; retain the latest active screen until release.
        internal bool BeforeAutoWindowChanged(Action refit)
        {
            if (!IsWindowed || !_streamOwnsPresentation) return true;
            _pendingAutoFit = refit;
            return false;
        }

        private void ReplayAutoFit()
        {
            if (_streamOwnsPresentation || _pendingAutoFit is not { } refit) return;
            _pendingAutoFit = null;
            refit();
        }

        internal bool StreamOwnsPresentation => _streamOwnsPresentation;
        internal int StreamWidth => _streamWidth;
        internal bool IsWindowed => windowedRoot is not null;

        internal bool ReassertMirror() => Apply(_streamOwnsPresentation, _streamOwnsPresentation ? _streamWidth : 1920);

        // Mark only; read the player's settings outside the display callback, before our next write.
        internal void DisplaySettingsApplied()
        {
            if (IsWindowed && _streamOwnsPresentation) _adoptDisplaySettings = true;
        }

        private bool Apply(bool stream, int width)
        {
            if (windowedRoot is null) return apply(stream, width);
            if (!stream && _restoreSettings is null) return true;
            if (windowedRoot() is not { } root) return false;

            if (_adoptDisplaySettings)
            {
                var current = new DisplaySettings(root.ContentScaleSize, root.ContentScaleAspect, root.ContentScaleMode);
                if (usesAutoAspect?.Invoke() != true)
                    _restoreSettings = current;
                _adoptDisplaySettings = false;
            }

            if (stream)
            {
                _restoreSettings ??= new(root.ContentScaleSize, root.ContentScaleAspect, root.ContentScaleMode);
                var size = new Vector2I(width, TargetSize.Y);
                if (root.ContentScaleSize != size) root.ContentScaleSize = size;
                if (root.ContentScaleAspect != Window.ContentScaleAspectEnum.Keep)
                    root.ContentScaleAspect = Window.ContentScaleAspectEnum.Keep;
            }
            else if (_restoreSettings is { } restore)
            {
                if (root.ContentScaleSize != restore.Size) root.ContentScaleSize = restore.Size;
                if (root.ContentScaleAspect != restore.Aspect) root.ContentScaleAspect = restore.Aspect;
                if (root.ContentScaleMode != restore.Mode) root.ContentScaleMode = restore.Mode;
                _restoreSettings = null;
            }
            return true;
        }

        // Preserve the design-space placement, carried across the extra width by the control's anchor.
        // A mirror or 16:9 stream returns the original target exactly, including throughout swap-back.
        internal Vector2 ResolvePlacement(Vector2 target, float anchorLeft)
            => _streamOwnsPresentation && _streamWidth > 1920
                ? new Vector2(target.X * 1920 / _streamWidth + anchorLeft * (_streamWidth - 1920), target.Y)
                : target;

        internal void SetStreamWidth(int width) => TrySetStreamWidth(width);

        internal bool TrySetStreamWidth(int width)
        {
            if (width > 1920 || IsWindowed)
            {
                if (IsWindowed && canPauseAuto?.Invoke() == false) return false;
                _streamWidth = width;
                _streamOwnsPresentation = true;
                var success = Apply(true, width);
                onOwnershipChanged?.Invoke(true);
                return success;
            }
            return TryRestoreMirror();
        }

        internal bool TryRestoreMirror()
        {
            var success = true;
            if (_streamOwnsPresentation)
            {
                onOwnershipChanged?.Invoke(false);
                success = Apply(false, 1920);
                _streamOwnsPresentation = false;
                _streamWidth = 1920;
                if (IsWindowed && _pendingAutoFit is not null)
                    (deferAutoFit ?? (callback => callback()))(ReplayAutoFit);
            }
            else success = Apply(false, 1920);
            return success;
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
            GameDeferred.Post(action);
            return true;
        });
    }

    private static bool AttachRoot()
    {
        if (Engine.GetMainLoop() is not SceneTree { Root: { } root } || !GodotObject.IsInstanceValid(root))
            return false;
        root.SizeChanged += HeadlessViewportPatch.AfterWindowSizeChanged;
        return true;
    }

    // Callbacks only mark or enqueue work; root reads happen after synchronous handlers finish.
    internal sealed class Reassertion(Presentation presentation, Action<Action> defer, Func<bool> attachRoot,
        Action? invalidated = null, Action<bool>? reasserted = null)
    {
        private int _pending;
        private bool _attached;

        internal void Startup()
        {
            if (!_attached) Schedule();
        }

        internal bool BeforeAutoWindowChanged(Action refit) => presentation.BeforeAutoWindowChanged(refit);

        internal void WindowSizeChanged()
        {
            // Keep already fits a windowed stream inside the resized window.
            if (!presentation.IsWindowed) Request();
        }

        internal void Request(bool adoptDisplaySettings = false)
        {
            if (presentation.IsWindowed && !presentation.StreamOwnsPresentation) return;
            if (adoptDisplaySettings) presentation.DisplaySettingsApplied();
            Schedule();
        }

        private void Schedule()
        {
            if (Interlocked.Exchange(ref _pending, 1) != 0) return;
            if (!presentation.IsWindowed || presentation.StreamOwnsPresentation) invalidated?.Invoke();
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
                if (presentation.IsWindowed && !presentation.StreamOwnsPresentation) return;
                using var permit = ZeroClientGuard.Permit(ZeroClientAllowances.WindowlessViewport);
                var success = presentation.ReassertMirror();
                reasserted?.Invoke(success);
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
        return GetRootPresentationWindow() is { } root && ApplyPresentation(root, expand, width);
    }

    private static IPresentationWindow? GetRootPresentationWindow()
        => Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root)
            ? new RootPresentationWindow(root) : null;

    internal interface IPresentationWindow
    {
        Window.ContentScaleAspectEnum ContentScaleAspect { get; set; }
        Window.ContentScaleModeEnum ContentScaleMode { get; set; }
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
        public Window.ContentScaleModeEnum ContentScaleMode { get => root.ContentScaleMode; set => root.ContentScaleMode = value; }
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
