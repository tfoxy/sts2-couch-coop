using Godot;
using CouchCoop.Mod.Connections;
using Spirectl.Sts2.Live;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace CouchCoop.Mod.Session;

/// <summary>
/// Keeps the root window embedding its subwindows — the game's shipped setting, and one browser input cannot work
/// without — when another mod turns it off to open a window of its own.
/// </summary>
/// <remarks>
/// <para>
/// Browser input reaches the game as injected Godot events. While the root embeds, Godot works out hover from the
/// event's own position. With embedding off, it works hover out from the real OS pointer and whichever window
/// that pointer is over, so an injected hover lands nowhere; and a press only focuses a control that is hovered,
/// while the game's buttons ignore a press they do not have focus for. Every tap does nothing. BaseLib's log window
/// (<c>OpenLogWindowOnStartup</c>, <c>OpenLogWindowOnError</c>) turns embedding off to show itself as a separate
/// OS window, and any mod that does the same does the same damage.
/// </para>
/// <para>
/// On a desktop the guard turns embedding back on and marks each such window <see cref="Window.ForceNative"/>,
/// Godot's own way to keep one window native under an embedding root, so the mod's window stays a separate OS
/// window. A headless seat can show no window at all, and its display server hands a "native" subwindow the main
/// window's id together with its single input-callback slot: a seat that opened the log window lost ALL input,
/// keys and pad included. There the guard keeps such windows hidden and, if one already took the slot, gives it
/// back to the root. Seats copy the host's <c>mod_configs/</c>, so a seat opens the log window whenever the host
/// does.
/// </para>
/// <para>
/// Two triggers. The root's <c>child_entered_tree</c> fires while a window added the usual way is still hidden,
/// so the repair lands before that window is first shown: no flicker, and no taken input slot on a seat. A
/// one-second backstop covers every other route while browsers are connected, and throughout a headless seat's
/// lifetime. An empty host has no backstop ticking. A repair mutates engine-global state, so it logs a begin/end
/// pair, and five repairs inside a minute trip a breaker instead of fighting a mod forever.
/// </para>
/// <para>
/// Known limit: if an EMBEDDED window is open in the game view at the moment a mod asks for embedding off, Godot
/// refuses the request; the mod's window then embeds in the game view and embedding never goes off, so there is
/// nothing here to repair. That happens with the mod alone.
/// </para>
/// </remarks>
public static class RootWindowEmbeddingGuard
{
    internal const string BackstopTimerName = "CouchCoopRootWindowEmbeddingGuard";
    internal const int BreakerMaxRepairs = 5;
    internal const long BreakerWindowMs = 60_000;

    private const double BackstopIntervalSeconds = 1.0;
    private const int AttachPollIntervalMs = 100;
    private const int AttachPollAttempts = 600; // one minute for the scene tree to exist

    // InputEvent::DEVICE_ID_INTERNAL. GodotSharp names only DeviceIdEmulation.
    private const int InternalDeviceId = -2;

    private static readonly object Gate = new();
    private static readonly RepairBreaker Breaker = new(BreakerMaxRepairs, BreakerWindowMs);
    private static readonly HashSet<ulong> KeptHiddenIds = [];
    private static readonly BrowserDemandLedger BrowserDemand = new(PublishBrowserDemand);
    private static long _browserDemandGeneration = -1;
    private static bool _hasBrowserDemand;
    private static bool _started;
    private static bool _repairing;
    private static bool _gaveUpLogged;
    private static Window? _root;
    private static Callable? _rootInputForwarder;
    private static Godot.Timer? _backstopTimer;
    private static Callable? _reconcileBackstopDemand;

    internal static bool HasBrowserDemand => Volatile.Read(ref _hasBrowserDemand);

    // Each server lifetime owns a reporter, so a new server or hot-reload generation cannot be mistaken for a
    // stale notification from a previous one. Retire a server's reporter with (0, long.MaxValue) on disposal.
    internal static Action<int, long> CreateBrowserDemandReporter() => BrowserDemand.CreateReporter();

    private static void PublishBrowserDemand(int count, long generation)
    {
        Callable? reconcile;
        lock (Gate)
        {
            if (generation <= _browserDemandGeneration) return;
            _browserDemandGeneration = generation;
            var demanded = count > 0;
            if (_hasBrowserDemand == demanded) return;
            Volatile.Write(ref _hasBrowserDemand, demanded);
            reconcile = _reconcileBackstopDemand;
        }
        if (reconcile is { } callback)
        {
            // Share the input FIFO: an already-scheduled dispatcher drain can consume newly arrived input
            // before a separate Godot deferred call. InvokeAsync enqueues before registration returns, so
            // even the first input after idle runs after repair without waiting for another frame or timer.
            _ = Sts2MainThreadDispatcher.InvokeAsync(() =>
            {
                callback.Call();
                return Task.FromResult(true);
            });
        }
    }

    /// <summary>
    /// Idempotent. Called from <c>CouchCoopMod.Init</c>, on the main thread: attaches at once when the scene tree
    /// already exists, otherwise as soon as it does.
    /// </summary>
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

        if (TryGetRoot() is { } root)
        {
            // Init can run while the root is still setting up its children, when AddChild is refused.
            Attach(root, addTimerDeferred: true);
            return;
        }

        _ = Task.Run(AttachWhenTreeExistsAsync);
    }

    /// <summary>What the planner needs to know about one window under the root.</summary>
    /// <param name="Embedded">Only meaningful while visible: a hidden window has no embedder.</param>
    /// <param name="HoldsMainWindowId">
    /// A non-root window carrying the main window's id, which only a headless display server hands out — and with
    /// it the root's input callback.
    /// </param>
    /// <param name="IsTrigger">The window whose arrival as a child of the root started this repair.</param>
    internal readonly record struct WindowFacts<TWindow>(
        TWindow Window,
        bool Visible,
        bool Embedded,
        bool IsPopup,
        bool HoldsMainWindowId,
        bool IsTrigger)
    {
        public bool Displayed => Visible && !Embedded;
    }

    /// <param name="Hide">Every natively displayed window, deepest first.</param>
    /// <param name="MakeNative">Desktop only: windows to keep as separate OS windows once the root embeds again.</param>
    /// <param name="Reshow">Desktop only: windows to show again after the flip, in tree order.</param>
    /// <param name="KeepHidden">Headless only: windows that must never be shown, since they would embed in the game.</param>
    /// <param name="RestoreRootInput">A window took the root's input callback and it has to be given back.</param>
    internal sealed record RepairPlan<TWindow>(
        IReadOnlyList<TWindow> Hide,
        IReadOnlyList<TWindow> MakeNative,
        IReadOnlyList<TWindow> Reshow,
        IReadOnlyList<TWindow> KeepHidden,
        bool RestoreRootInput);

    /// <summary>
    /// Decides a repair from the windows under the root, given in tree order (parents before their children).
    /// </summary>
    internal static RepairPlan<TWindow> PlanRepair<TWindow>(
        IReadOnlyList<WindowFacts<TWindow>> windowsInTreeOrder,
        bool nativeSubwindowsSupported)
    {
        // Godot refuses to turn embedding on while any native window under the root is displayed, and hiding a
        // window does not hide the native windows beneath it — so all of them go, deepest first.
        var hide = windowsInTreeOrder.Where(w => w.Displayed).Select(w => w.Window).Reverse().ToList();

        // Popups are hide-only: they are transient, and pinning one native would keep a game popup out of the game
        // view for the rest of the session.
        var reshow = windowsInTreeOrder.Where(w => w.Displayed && !w.IsPopup).Select(w => w.Window).ToList();
        var keepSeparate = windowsInTreeOrder
            .Where(w => !w.IsPopup && (w.Displayed || (w.IsTrigger && !w.Embedded)))
            .Select(w => w.Window)
            .ToList();
        var restoreRootInput = windowsInTreeOrder.Any(w => w.HoldsMainWindowId);

        return nativeSubwindowsSupported
            ? new RepairPlan<TWindow>(hide, keepSeparate, reshow, [], restoreRootInput)
            : new RepairPlan<TWindow>(hide, [], [], keepSeparate, restoreRootInput);
    }

    /// <summary>Admits at most <c>maxRepairs</c> repairs in any <c>windowMs</c>; the first refusal is final.</summary>
    internal sealed class RepairBreaker(int maxRepairs, long windowMs)
    {
        private readonly Queue<long> _recent = new();

        public bool Tripped { get; private set; }

        public bool TryAdmit(long nowMs)
        {
            if (Tripped)
            {
                return false;
            }

            while (_recent.Count > 0 && nowMs - _recent.Peek() >= windowMs)
            {
                _recent.Dequeue();
            }

            if (_recent.Count >= maxRepairs)
            {
                Tripped = true;
                return false;
            }

            _recent.Enqueue(nowMs);
            return true;
        }
    }

    private static Window? TryGetRoot()
    {
        return Engine.GetMainLoop() is SceneTree { Root: { } root } && GodotObject.IsInstanceValid(root) ? root : null;
    }

    // Same shape as CouchCoopHeadlessCpuProfiler: poll off-thread for the tree, then attach on the main thread.
    private static async Task AttachWhenTreeExistsAsync()
    {
        for (var attempt = 0; attempt < AttachPollAttempts; attempt++)
        {
            try
            {
                if (TryGetRoot() is { } root)
                {
                    Callable.From(() => Attach(root, addTimerDeferred: false)).CallDeferred();
                    return;
                }
            }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr(
                    $"root window embedding guard: install attempt failed: {exception.GetType().Name}: {exception.Message}");
            }

            await Task.Delay(AttachPollIntervalMs).ConfigureAwait(false);
        }

        CouchCoopLog.Stderr("root window embedding guard: gave up installing (the scene tree never became ready)");
    }

    private static void Attach(Window root, bool addTimerDeferred)
    {
        if (_root is not null || !GodotObject.IsInstanceValid(root))
        {
            return;
        }

        _root = root;
        root.ChildEnteredTree += OnRootChildEnteredTree;
        lock (Gate) _reconcileBackstopDemand = Callable.From(ReconcileBackstopDemand);

        // The mod has no Godot source generator, so no _Process override would ever run; a Timer's signal does.
        var timer = new Godot.Timer
        {
            Name = BackstopTimerName,
            WaitTime = BackstopIntervalSeconds,
            OneShot = false,
            Autostart = false,
            ProcessMode = Node.ProcessModeEnum.Always,
        };
        _backstopTimer = timer;
        timer.Timeout += OnBackstop;
        if (addTimerDeferred)
        {
            Callable.From(() =>
            {
                root.AddChild(timer);
                ReconcileBackstopDemand();
            }).CallDeferred();
        }
        else
        {
            root.AddChild(timer);
            ReconcileBackstopDemand();
        }

        CouchCoopLog.Info($"root window embedding guard: installed (root embedding={root.GuiEmbedSubwindows})");
        Repair(root, trigger: null, reason: "install");
    }

    private static void ReconcileBackstopDemand()
    {
        if (_backstopTimer is not { } timer || !GodotObject.IsInstanceValid(timer) || !timer.IsInsideTree()) return;
        if (CouchCoopMod.IsHeadlessClient || HasBrowserDemand)
        {
            // Repair on activation; the first browser must not wait for the one-second backstop.
            OnBackstop();
            if (!timer.IsProcessingInternal()) timer.Start();
        }
        else
        {
            timer.Stop();
        }
    }

    private static void OnRootChildEnteredTree(Node node)
    {
        if (node is Window window && _root is { } root && !root.GuiEmbedSubwindows)
        {
            Repair(root, window, reason: "window added");
        }
    }

    private static void OnBackstop()
    {
        if (!CouchCoopMod.IsHeadlessClient && !HasBrowserDemand) return;
        if (_root is { } root && GodotObject.IsInstanceValid(root) && !root.GuiEmbedSubwindows)
        {
            Repair(root, trigger: null, reason: "backstop");
        }
    }

    private static void Repair(Window root, Window? trigger, string reason)
    {
        if (_repairing || !GodotObject.IsInstanceValid(root) || root.GuiEmbedSubwindows)
        {
            return;
        }

        if (!Breaker.TryAdmit(System.Environment.TickCount64))
        {
            if (!_gaveUpLogged)
            {
                _gaveUpLogged = true;
                CouchCoopLog.Warn(
                    $"root window embedding guard: gave_up ({reason}) after {BreakerMaxRepairs} repairs within "
                    + $"{BreakerWindowMs / 1000}s; something keeps turning embedding off, and browser input on this "
                    + $"instance will not work while it stays off. Native windows: {Describe(NativeWindowsUnder(root))}");
            }

            return;
        }

        _repairing = true;
        try
        {
            RepairCore(root, trigger, reason);
        }
        catch (Exception exception)
        {
            CouchCoopLog.Warn(
                $"root window embedding guard: repair failed ({reason}): {exception.GetType().Name}: {exception.Message}");
        }
        finally
        {
            _repairing = false;
        }
    }

    private static void RepairCore(Window root, Window? trigger, string reason)
    {
        var triggerId = trigger?.GetInstanceId();
        var facts = new List<WindowFacts<Window>>();
        // owned:false — a window instanced from its own scene has no owner, and owned:true would skip its subtree.
        foreach (var node in root.FindChildren("*", nameof(Window), recursive: true, owned: false))
        {
            if (node is not Window window || !window.IsInsideTree())
            {
                continue;
            }

            var visible = window.Visible;
            facts.Add(new WindowFacts<Window>(
                window,
                visible,
                Embedded: visible && window.IsEmbedded(),
                IsPopup: window is Popup,
                HoldsMainWindowId: visible && window.GetWindowId() == DisplayServer.MainWindowId,
                IsTrigger: window.GetInstanceId() == triggerId));
        }

        var nativeSupported = DisplayServer.HasFeature(DisplayServer.Feature.Subwindows);
        var plan = PlanRepair(facts, nativeSupported);
        var focused = root.HasFocus() ? root : plan.Reshow.FirstOrDefault(w => w.HasFocus());

        CouchCoopLog.Info(
            $"root window embedding guard: begin repair ({reason}); display={DisplayServer.GetName()}, "
            + $"native windows supported={nativeSupported}, trigger={Describe(trigger)}, hiding=[{Describe(plan.Hide)}]");

        foreach (var window in plan.Hide)
        {
            if (GodotObject.IsInstanceValid(window))
            {
                window.Hide();
            }
        }

        root.GuiEmbedSubwindows = true;
        if (!root.GuiEmbedSubwindows)
        {
            ShowAll(plan.Reshow);
            CouchCoopLog.Warn(
                $"root window embedding guard: end repair ({reason}): Godot refused to turn embedding back on; "
                + $"native windows still open: {Describe(NativeWindowsUnder(root))}");
            return;
        }

        foreach (var window in plan.MakeNative)
        {
            // ForceNative cannot change while a window is shown.
            if (!IsLive(window) || window.Visible)
            {
                continue;
            }

            window.ForceNative = true;
            // Explicit, because ForceNative only turns this on when its value changes: a window that was already
            // force-native would otherwise open its own popups in the game view instead of inside itself.
            window.GuiEmbedSubwindows = true;
        }

        ShowAll(plan.Reshow);
        if (plan.Reshow.Count > 0 && focused is not null && IsLive(focused) && focused.Visible)
        {
            focused.GrabFocus();
        }

        foreach (var window in plan.KeepHidden)
        {
            KeepHidden(window);
        }

        if (plan.RestoreRootInput)
        {
            RestoreRootInput();
        }

        CouchCoopLog.Info(
            $"root window embedding guard: end repair ({reason}): embedding restored; "
            + $"kept native=[{Describe(plan.MakeNative)}], shown again=[{Describe(plan.Reshow)}], "
            + $"kept hidden=[{Describe(plan.KeepHidden)}], root input restored={plan.RestoreRootInput}");
    }

    // Headless only. A shown window would embed in the game view: it would swallow pointer events over its rect
    // and, if it can take focus, every event there is.
    private static void KeepHidden(Window window)
    {
        if (!IsLive(window))
        {
            return;
        }

        window.Unfocusable = true;
        if (window.Visible)
        {
            window.Hide();
        }

        if (!KeptHiddenIds.Add(window.GetInstanceId()))
        {
            return;
        }

        // Deferred, so a hide never runs inside the show that raised it; input is flushed only after it has run.
        window.VisibilityChanged += () =>
        {
            if (GodotObject.IsInstanceValid(window) && window.Visible)
            {
                Callable.From(() =>
                {
                    if (GodotObject.IsInstanceValid(window) && window.Visible)
                    {
                        window.Hide();
                    }
                }).CallDeferred();
            }
        };
    }

    // Headless only. Hiding the window that took the slot does not give it back, so point it at the root again.
    private static void RestoreRootInput()
    {
        _rootInputForwarder ??= Callable.From<InputEvent>(ForwardToRoot);
        DisplayServer.WindowSetInputEventCallback(_rootInputForwarder.Value, (int)DisplayServer.MainWindowId);
        CouchCoopLog.Info("root window embedding guard: input callback given back to the root window");
    }

    // What the root's own callback does once the root embeds again: announce non-internal events on window_input,
    // then push the event into the root viewport.
    private static void ForwardToRoot(InputEvent inputEvent)
    {
        if (_root is not { } root || !GodotObject.IsInstanceValid(root) || !root.IsInsideTree())
        {
            return;
        }

        if (inputEvent.Device != InternalDeviceId)
        {
            root.EmitSignal(Window.SignalName.WindowInput, inputEvent);
        }

        root.PushInput(inputEvent);
    }

    private static void ShowAll(IEnumerable<Window> windows)
    {
        foreach (var window in windows)
        {
            if (IsLive(window) && !window.Visible)
            {
                window.Show();
            }
        }
    }

    private static List<Window> NativeWindowsUnder(Window root)
    {
        var windows = new List<Window>();
        foreach (var id in DisplayServer.GetWindowList())
        {
            if (id == DisplayServer.MainWindowId)
            {
                continue;
            }

            if (GodotObject.InstanceFromId(DisplayServer.WindowGetAttachedInstanceId(id)) is Window window
                && root.IsAncestorOf(window))
            {
                windows.Add(window);
            }
        }

        return windows;
    }

    private static bool IsLive(Window window) => GodotObject.IsInstanceValid(window) && window.IsInsideTree();

    private static string Describe(Window? window)
    {
        return window is null ? "none" : $"{window.GetType().Name} '{window.Name}'";
    }

    private static string Describe(IEnumerable<Window> windows) => string.Join(", ", windows.Select(Describe));
}
