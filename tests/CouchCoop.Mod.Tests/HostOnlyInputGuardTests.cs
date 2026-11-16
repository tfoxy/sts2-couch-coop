using System.Runtime.CompilerServices;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Protocol;
using Godot;
using Spirectl.Sts2.Embedding;

internal static class HostOnlyInputGuardTests
{
    public static void Run()
    {
        ModalLeasesBlockUntilTheLastClose();
        ModalOpeningCancelsInputBeforeReturning();
        RegistrationsUnregisterIndependently();
        RegistrationsDoNotKeepControlsAlive();
        HotkeysDoNotBlockThePanelsWholeRect();
        VisibilityAndFocusHaveSeparateRules();
        KeyboardHotkeysFollowBothBindingSets();
        ControllerHotkeysFollowTheCurrentBindingAndActionLane();
        PointerChecksUseTheInjectedPixel();
        UnresolvedPointerCoordinatesFailClosed();
        RefusedInputNeverReachesInjection();
        GuardRunsAfterTargetPlacement();
        Console.WriteLine("HostOnlyInputGuardTests: 12 tests passed");
    }

    private static void ModalLeasesBlockUntilTheLastClose()
    {
        var registry = new HostOnlyInputRegistry<object>();
        using var first = registry.OpenModal();
        using var second = registry.OpenModal();
        bool Blocked() => registry.Refuses(_ => throw new Exception("modal needs no control reads"),
            (_, _) => throw new Exception("modal needs no hotkey reads"));
        Expect(Blocked(), "an open modal blocks without consulting controls");
        first.Dispose();
        first.Dispose();
        Expect(Blocked(), "closing or freeing one dialog cannot reopen input through another");
        second.Dispose();
        Expect(!Blocked(), "the last close restores admission, including after duplicate teardown");
    }

    private static void RegistrationsUnregisterIndependently()
    {
        var registry = new HostOnlyInputRegistry<object>();
        var control = new object();
        using var first = registry.Register(control);
        using var second = registry.Register(control);
        Expect(registry.Refuses(_ => true, (_, _) => false), "a registered control can refuse input");
        first.Dispose();
        Expect(registry.Refuses(_ => true, (_, _) => false), "a duplicate registration retains its own lease");
        second.Dispose();
        Expect(!registry.Refuses(_ => true, (_, _) => false), "unregister removes the control immediately");
        GC.KeepAlive(control);
    }

    private static void ModalOpeningCancelsInputBeforeReturning()
    {
        var registry = new HostOnlyInputRegistry<object>();
        var cancellations = 0;
        using (registry.OpenModal(() =>
        {
            cancellations++;
            Expect(registry.Refuses(_ => false, (_, _) => false), "input is already blocked during cancellation");
        }))
            Expect(cancellations == 1, "opening cancels held and buffered input synchronously, once");
        Expect(!registry.Refuses(_ => false, (_, _) => false), "closing releases the modal after cancellation");
        try
        {
            using var failed = registry.OpenModal(() => throw new InvalidOperationException("cancel failed"));
            throw new Exception("cancellation errors must propagate");
        }
        catch (InvalidOperationException) { }
        Expect(!registry.Refuses(_ => false, (_, _) => false), "failed opens do not leak modal leases");
    }

    private static void RegistrationsDoNotKeepControlsAlive()
    {
        var registry = new HostOnlyInputRegistry<object>();
        var (weak, registration) = RegisterEphemeral(registry);
        using (registration)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            Expect(!weak.TryGetTarget(out _), "even an undisposed registration does not retain its control");
            Expect(!registry.Refuses(_ => true, (_, _) => true), "dead registrations cannot block input");
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (WeakReference<object>, IDisposable) RegisterEphemeral(HostOnlyInputRegistry<object> registry)
    {
        var control = new object();
        return (new WeakReference<object>(control), registry.Register(control));
    }

    private static void HotkeysDoNotBlockThePanelsWholeRect()
    {
        var registry = new HostOnlyInputRegistry<object>();
        var panel = new object();
        using var registration = registry.Register(panel, "qr-action");
        Expect(!registry.Refuses(_ => throw new Exception("a hotkey panel is not a hitbox"), (_, _) => false),
            "unrelated input remains usable while the panel is mounted");
        Expect(registry.Refuses(_ => false, (owner, action) => ReferenceEquals(owner, panel) && action == "qr-action"),
            "the mounted panel's chosen action is protected");
        registration.Dispose();
        Expect(!registry.Refuses(_ => false, (_, _) => true), "unmount releases the hotkey reservation");
    }

    private static void PointerChecksUseTheInjectedPixel()
    {
        var rect = new Rect2(100, 200, 40, 30);
        foreach (var kind in new[] { BrowserInputKinds.Hover, BrowserInputKinds.Click })
        {
            var request = new BrowserInputRequestEnvelope("input", "rect", kind, CoordX: 99.6, CoordY: 200);
            Expect(ReachesPointer(rect, request), "a rounded point on the QR control is refused");
            Expect(!ReachesPointer(rect, request with { CoordX = 99.4 }), "a point outside is allowed");
            Expect(!ReachesPointer(rect, request with { CoordX = 140 }), "the far rect edge is outside");
            Expect(ReachesPointer(rect, request with { CoordX = 139, CoordY = 229 }), "the last inside pixel is refused");
        }
    }

    private static void VisibilityAndFocusHaveSeparateRules()
    {
        var control = new HostOnlyInputGuard.HostOnlyControlState(true, new Rect2(100, 200, 40, 30), false);
        foreach (var kind in new[] { BrowserInputKinds.Hover, BrowserInputKinds.Click })
        {
            Expect(HostOnlyInputGuard.ReachesControl(control, kind, 110, 210), "visible host UI blocks its rectangle");
            Expect(!HostOnlyInputGuard.ReachesControl(control with { Visible = false }, kind, 110, 210),
                "hidden host UI does not reserve its old rectangle");
        }
        foreach (var kind in new[] { BrowserInputKinds.Key, BrowserInputKinds.Pad })
        {
            Expect(!HostOnlyInputGuard.ReachesControl(control, kind), "focus outside host UI permits key and pad input");
            Expect(HostOnlyInputGuard.ReachesControl(control with { FocusWithin = true }, kind),
                "focus on a host control or its descendants refuses key and pad input");
            Expect(HostOnlyInputGuard.ReachesControl(control with { Visible = false, FocusWithin = true }, kind),
                "even a hidden host control retaining focus cannot receive browser key or pad input");
        }
    }

    private static void KeyboardHotkeysFollowBothBindingSets()
    {
        Expect(HostOnlyInputGuard.MatchesKey("KeyW", Key.W, Key.D), "the current keyboard binding is protected");
        Expect(HostOnlyInputGuard.MatchesKey("KeyD", Key.W, Key.D), "the keyboard-only binding is protected too");
        Expect(!HostOnlyInputGuard.MatchesKey("KeyW", Key.Q, Key.D), "rebinding releases the old key");
        Expect(HostOnlyInputGuard.MatchesKey("KeyQ", Key.Q, Key.D), "rebinding protects the new key");
        Expect(!HostOnlyInputGuard.MatchesKey("unknown", Key.W, Key.D), "unmapped keys cannot match a hotkey");
    }

    private static void UnresolvedPointerCoordinatesFailClosed()
    {
        var rect = new Rect2(100, 200, 40, 30);
        var request = new BrowserInputRequestEnvelope("input", "missing", BrowserInputKinds.Click, CoordX: 0, CoordY: 0);
        foreach (var invalid in new[] { request with { CoordX = null }, request with { CoordY = double.NaN },
                     request with { CoordX = double.PositiveInfinity }, request with { ElementId = "123" } })
            Expect(ReachesPointer(rect, invalid), "unresolved pointer paths cannot bypass the guard");
    }

    private static void ControllerHotkeysFollowTheCurrentBindingAndActionLane()
    {
        bool AllActions(string _) => true;
        Expect(HostOnlyInputGuard.MatchesPad("faceNorth", "controller_face_button_north", AllActions),
            "the current QR controller binding is protected");
        Expect(!HostOnlyInputGuard.MatchesPad("faceNorth", "controller_face_button_south", AllActions),
            "rebinding releases the old controller input");
        Expect(HostOnlyInputGuard.MatchesPad("faceSouth", "controller_face_button_south", AllActions),
            "rebinding protects the new controller input");
        Expect(HostOnlyInputGuard.MatchesPad("dpadUp", "controller_d_pad_north", action => action == "controller_d_pad_north"),
            "older input-map names use the same fallback as injection");
        Expect(!HostOnlyInputGuard.MatchesPad("dpadUp", "controller_d_pad_north", AllActions),
            "a registered legacy alias cannot shadow the current injected action");
        Expect(!HostOnlyInputGuard.MatchesPad("unknown", "controller_face_button_south", AllActions),
            "unknown tokens never match");
        Expect(!HostOnlyInputGuard.MatchesPad("faceSouth", "controller_face_button_south", _ => false),
            "unregistered actions cannot be injected");
    }

    private static void RefusedInputNeverReachesInjection()
    {
        foreach (var kind in new[] { BrowserInputKinds.Hover, BrowserInputKinds.Click, BrowserInputKinds.Key, BrowserInputKinds.Pad })
        {
            var actions = new Actions();
            var executor = new BrowserInputExecutor(actions, () => new Finder(), _ => true);
            var request = new BrowserInputRequestEnvelope("input", "refused-" + kind, kind,
                CoordX: 1, CoordY: 2, Key: "Enter", Input: "faceSouth");
            var result = executor.Execute(request);
            Expect(result?.Type == "input-result" && result.RequestId == request.RequestId && result.Code == "host-only-ui",
                "each kind receives a correlated host-only-ui refusal");
            Expect(actions.Count == 0, "a refusal injects no action");
        }
        var allowed = new Actions();
        Expect(new BrowserInputExecutor(allowed, () => new Finder(), _ => false).Execute(
            new BrowserInputRequestEnvelope("input", "allowed", BrowserInputKinds.Key, Key: "Enter")) is null
            && allowed.Count == 1, "unprotected input still reaches injection");
    }

    private static void GuardRunsAfterTargetPlacement()
    {
        var actions = new Actions();
        var rect = new Rect2(100, 200, 40, 30);
        var executor = new BrowserInputExecutor(actions, () => new Finder(), request => ReachesPointer(rect, request));
        var result = executor.Execute(new BrowserInputRequestEnvelope("input", "retargeted", BrowserInputKinds.Click,
            CoordX: 0, CoordY: 0, TargetInstance: "1", LocalX: 10, LocalY: 10));
        Expect(result?.Code == "host-only-ui" && actions.Count == 0,
            "a safe submitted point retargeted onto host UI is refused at its final coordinate");
    }

    private static bool ReachesPointer(Rect2 rect, BrowserInputRequestEnvelope request)
        => HostOnlyInputGuard.ReachesPointer(rect, request.CoordX, request.CoordY, request.ElementId);

    private sealed class Actions : ISemanticActionSource
    {
        public int Count { get; private set; }
        public EmbeddableActionResult ExecuteAction(EmbeddableActionRequest request)
        {
            Count++;
            return new EmbeddableActionResult(true, null, null);
        }
    }

    private sealed class Finder : IPointerTargetFinder
    {
        public IReadOnlyList<IPointerTargetNode> Find(string scene, string path, bool fresh) => [];
        public IPointerTargetNode? FindInstance(ulong id) => id == 1 ? new Target() : null;
    }

    private sealed class Target : IPointerTargetNode
    {
        public bool IsAlive => true;
        public bool IsVisibleCanvasItem => true;
        public Transform2D CanvasTransform => new(0f, new Vector2(100, 200));
        public Vector2? ControlSize => new Vector2(40, 30);
        public bool MatchesIdentity(string scene, string path) => false;
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("HostOnlyInputGuardTests: " + message);
    }
}
