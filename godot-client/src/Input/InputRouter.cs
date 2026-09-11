// OWNER: WS-M (native input shim). M1e.
//
// AppShell (a frozen shared file) mounts this Node2D in --connect mode and calls Bind(...) once with the live handles,
// so the ENTIRE native input path lives inside this file (+ KeyMap / HeldCardLift / DemoInputPlayer) against WS-L's
// gesture engine — without touching any shared file.
//
// The flow, per raw OS event, is: classify (touch / mouse / key) → invert the letterbox/anchor mapping to design space
// (1920x1080) via MakeInputLocal → drive WS-L's GestureMachine (edge events) → a per-frame PumpFrame in _Process (same
// Time.GetTicksMsec clock as the events). The machine's Send is wrapped to (a) audit every emitted InputMessage and (b)
// forward to _coordinator.SendInput (which stamps the real requestId). OnHeldCard drives the cosmetic HeldCardLift.
//
// DEDUPE (top M1e risk): the project keeps emulate_mouse_from_touch ON (Godot default) so its Controls work, which means
// every touch ALSO arrives as an emulated InputEventMouse (Device == DeviceIdEmulation). We DROP those so the gesture
// path sees each touch exactly once. emulate_touch_from_mouse is OFF (default), so a real mouse never doubles as a touch.

using System.Collections.Generic;
using System.Globalization;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene;
using CouchCoop.GodotClient.Ui;
using CouchCoop.MirrorProtocol.Envelopes;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Input;

public sealed partial class InputRouter : Node2D
{
    // The synthetic pointer id every mouse event shares (touch ids are the real finger indices, always >= 0).
    private const long MouseId = -1;

    // Master gate WS-M can flip to suspend all gesture handling (e.g. while a modal UI screen owns input).
    public bool GesturesEnabled { get; set; } = true;

    // --input-probe / --demo-input <script> hooks, set by AppShell before AddChild (WS-M consumes them).
    public bool InputProbe { get; set; }
    public string? DemoInputScript { get; set; }

    // Live handles AppShell wires at mount: the upstream input channel, the view tree (hit testing + LiftOffset via
    // TryGetView), the node model, and the chrome/settings surface.
    private ConnectionCoordinator? _coordinator;
    private SceneReconciler? _reconciler;
    private MirrorStore? _store;
    private UiRoot? _uiRoot;

    private GestureMachine? _machine;
    private PointerResolver? _resolver; // M2: the widened-stage coordinate resolver the GestureCallbacks seam plugs into
    private DemoInputPlayer? _demoPlayer;
    private int _seq;           // audit: a monotonically increasing local sequence for every sent InputMessage
    private bool _gateWasOpen;  // detect the gate flipping closed → Reset the machine

    // Chrome-swallow bookkeeping (2026-07-19): a release must only forward when ITS press was forwarded. The press
    // handlers swallow a down over UI chrome (IsPointOverChrome), but chrome can DISMISS ITSELF on that very press
    // (the join gate's "Watch only" button closes the panel on activation) — the matching release then hit-tested
    // clear of any chrome and leaked upstream as a bare mouse-up, and the game commits clicks on release: dismissing
    // the gate over the card-reward screen silently PICKED the card under the button in a live run. Track the
    // forwarded state per mouse button / touch index and swallow any release whose press never went upstream.
    private readonly bool[] _mouseForwarded = new bool[3];
    private readonly HashSet<int> _touchForwarded = new();

    // Called once by AppShell right after construction (before AddChild). The four handles are the full set a
    // coordinate-only gesture router needs.
    public void Bind(ConnectionCoordinator coordinator, SceneReconciler reconciler, MirrorStore store, UiRoot uiRoot)
    {
        _coordinator = coordinator;
        _reconciler = reconciler;
        _store = store;
        _uiRoot = uiRoot;
    }

    public override void _Ready()
    {
        if (_coordinator is null || _reconciler is null || _store is null || _uiRoot is null)
        {
            GD.Print("M1E: InputRouter mounted WITHOUT handles — gestures disabled.");
            return;
        }

        var options = new GestureOptions
        {
            // Live-read the Settings-panel client toggles per gesture (the GestureOptions contract: never cached).
            RaiseHeldCard = () => _uiRoot.ToggleRaiseHeldCard,
            UnfocusOnRelease = () => _uiRoot.ToggleUnfocusOnRelease,
            TapToFocus = () => _uiRoot.ToggleTapToFocus,
        };

        // M2 widened-input seam: one PointerResolver curried over the live store, wired to the frozen GestureCallbacks
        // resolver family. On a 16:9 stage (design width 1920) every resolve is identity, so this is a strict no-op;
        // on a widened stage it inverts the visual-anchor field (+near-miss), freezes it on press, and replays it
        // during a drag. The map + rects read the SAME live design width the resolver uses (DesignWidth).
        _resolver = new PointerResolver(
            map: (x, y) => PointerField.MapPointerToGame(_store.State, _store.Transforms, _store.Spread, x, y, DesignWidth()),
            rects: () => InteractiveRectScan.Collect(_store.State, _store.Transforms, _store.Spread),
            designWidth: DesignWidth,
            nowMs: () => Time.GetTicksMsec());

        var callbacks = new GestureCallbacks
        {
            Send = AuditedSend,
            OnHeldCard = HeldCardLift.OnHeldCard,
            // TargetsAt resolves the DESIGN point to a 1920-space GAME point FIRST (near-miss makes the game-rect
            // hit-test match the rendered hit-test on a widened stage), then hit-tests game space. Identity on 16:9.
            TargetsAt = TargetsAtResolved,
            IsCard = id => TouchTargetScan.IsCard(_store.State, id),
            // Hand-card gate: only cards under an NHandCardHolder/NPlayerHand ancestor get peek/drag-lift/unselect
            // card semantics; a deck-dialog / reward card falls through to a native click.
            IsHandCard = id => TouchTargetScan.IsHandCard(_store.State, id),
            ResolveFresh = (x, y) => _resolver.Fresh(x, y),
            ResolvePress = (x, y) => _resolver.Press(x, y),
            ResolveFrozen = (x, y) => _resolver.Frozen(x, y),
            ResolveHover = (x, y) => _resolver.Hover(x, y),
            ClearFreeze = _resolver.ClearFreeze,
            // Play-zone floor for the below-line drag-drop cancel (change 1): a HAND card dropped below this design-Y
            // right-clicks (de-selects). 1080 is the design height (Y is never widened). Web twin passes MIRROR_DESIGN_HEIGHT.
            PlayZoneThreshold = d => PlayZone.Threshold(1080, d),
            // R4: the live widened design width (same source the resolver/map read above) — the peek-release center
            // un-focus routes (DesignWidth/2, 540) through ResolveFresh so a widened stage parks dead-center.
            DesignWidth = DesignWidth,
            // R4 change 2: end-turn below-button un-hover — resolved release point → the button's game-space box
            // (scene-file match + union AABB over the InteractiveRectScan surface; see EndTurnScan).
            EndTurnBoxAt = (x, y) => EndTurnScan.BoxAt(_store.State, _store.Transforms, _store.Spread, x, y),
            // #12: a from-hand card-choice dialog (Survivor discard / exhaust / enchant) is active → a hand card
            // selects with a single tap (no arm-first) and the below-line unselect right-click is suppressed.
            HandChoiceActive = () => HandChoiceScan.IsActive(_store.State),
        };

        _machine = new GestureMachine(options, callbacks);
        _gateWasOpen = GateOpen();

        // Richer HeldCardLift bind (store → visible-NTargetingArrow detection + re-assert on rebuild). AppShell also
        // calls the single-arg HeldCardLift.Bind(reconciler); this overload additionally captures the store.
        HeldCardLift.Bind(_reconciler, _store);

        GD.Print($"M1E: InputRouter live (input-probe={InputProbe} demo-input={DemoInputScript ?? "<none>"}).");

        if (DemoInputScript is not null)
        {
            // Track Q: DemoInputPlayer is now self-sufficient (it resolves the live AppShell + store lazily and computes
            // its own design→window transform), so no Bind is needed — the file-script and QA-socket players share the
            // same interpreter without this router having to thread handles through.
            _demoPlayer = new DemoInputPlayer();
            _demoPlayer.LoadScript(DemoInputScript);
            AddChild(_demoPlayer);
        }
    }

    public override void _Process(double delta)
    {
        if (_machine is null)
        {
            return;
        }

        // Reset the machine when the gate flips closed (a modal/settings screen taking over input).
        bool open = GateOpen();
        if (_gateWasOpen && !open)
        {
            _machine.Reset();
        }

        _gateWasOpen = open;

        // Once per frame: fire due peek deadlines + flush the coalesced hover. SAME clock as every event's nowMs.
        _machine.PumpFrame(Time.GetTicksMsec());
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        // Track I: stamp the idle clock on ANY raw input (before the gate/machine guard), so a suspended stage wakes
        // even for input that is gated out (a modal owns input) or swallowed over chrome — the user is interacting.
        IdleSuspend.NotifyInput();

        if (_machine is null || !GateOpen())
        {
            return;
        }

        double now = Time.GetTicksMsec();
        switch (@event)
        {
            case InputEventScreenTouch touch:
                HandleTouch(touch, now);
                break;
            case InputEventScreenDrag drag:
                HandleScreenDrag(drag, now);
                break;
            case InputEventMouseButton button:
                HandleMouseButton(button, now);
                break;
            case InputEventMouseMotion motion:
                HandleMouseMotion(motion, now);
                break;
            case InputEventKey key:
                HandleKey(key, now);
                break;
        }
    }

    // ==============================================================================================
    // touch path
    // ==============================================================================================

    private void HandleTouch(InputEventScreenTouch touch, double now)
    {
        if (InputProbe)
        {
            ProbePointer(touch, "touch");
        }

        var d = ToDesign(touch);
        if (touch.Canceled)
        {
            if (_touchForwarded.Remove(touch.Index))
            {
                _machine!.PointerCancel(touch.Index, now);
            }

            return;
        }

        if (touch.Pressed)
        {
            if (_uiRoot!.IsPointOverChrome(d))
            {
                return; // swallow a press over UI chrome (its release is swallowed too — see _touchForwarded)
            }

            _touchForwarded.Add(touch.Index);
            _machine!.PointerDown(touch.Index, PointerKind.Touch, 0, d.X, d.Y, now);
        }
        else
        {
            if (!_touchForwarded.Remove(touch.Index))
            {
                return; // press was swallowed by chrome (possibly chrome that dismissed itself) — swallow the release
            }

            _machine!.PointerUp(touch.Index, PointerKind.Touch, 0, d.X, d.Y, now);
        }
    }

    private void HandleScreenDrag(InputEventScreenDrag drag, double now)
    {
        if (InputProbe)
        {
            ProbePointer(drag, "screen-drag");
        }

        var d = ToDesign(drag);
        _machine!.PointerMove(drag.Index, PointerKind.Touch, d.X, d.Y, now);
    }

    // ==============================================================================================
    // mouse path (emulated-from-touch events dropped)
    // ==============================================================================================

    private void HandleMouseButton(InputEventMouseButton button, double now)
    {
        if (button.Device == InputEvent.DeviceIdEmulation)
        {
            if (InputProbe)
            {
                var e = EventPosition(button);
                GD.Print($"M1E_PROBE: DROP emulated-mouse-button idx={button.ButtonIndex} pressed={button.Pressed} " +
                         $"pos=({e.X:0.##},{e.Y:0.##})");
            }

            return; // emulate_mouse_from_touch companion — the touch path already saw this
        }

        if (InputProbe)
        {
            ProbePointer(button, "mouse-button");
        }

        var d = ToDesign(button);
        switch (button.ButtonIndex)
        {
            case MouseButton.WheelUp:
                if (button.Pressed)
                {
                    _machine!.Wheel(true, d.X, d.Y, now);
                }

                break;
            case MouseButton.WheelDown:
                if (button.Pressed)
                {
                    _machine!.Wheel(false, d.X, d.Y, now);
                }

                break;
            case MouseButton.Left:
                MouseButtonEdge(0, button.Pressed, d, now);
                break;
            case MouseButton.Right:
                MouseButtonEdge(2, button.Pressed, d, now);
                break;
            case MouseButton.Middle:
                MouseButtonEdge(1, button.Pressed, d, now);
                break;
        }
    }

    private void MouseButtonEdge(int button, bool pressed, Vector2 d, double now)
    {
        if (pressed)
        {
            if (_uiRoot!.IsPointOverChrome(d))
            {
                _mouseForwarded[button] = false;
                return; // swallow a press over UI chrome (its release is swallowed too — see _mouseForwarded)
            }

            _mouseForwarded[button] = true;
            _machine!.PointerDown(MouseId, PointerKind.Mouse, button, d.X, d.Y, now);
        }
        else
        {
            if (!_mouseForwarded[button])
            {
                return; // press was swallowed by chrome (possibly chrome that dismissed itself) — swallow the release
            }

            _mouseForwarded[button] = false;
            _machine!.PointerUp(MouseId, PointerKind.Mouse, button, d.X, d.Y, now);
        }
    }

    private void HandleMouseMotion(InputEventMouseMotion motion, double now)
    {
        if (motion.Device == InputEvent.DeviceIdEmulation)
        {
            if (InputProbe)
            {
                var e = EventPosition(motion);
                GD.Print($"M1E_PROBE: DROP emulated-mouse-motion pos=({e.X:0.##},{e.Y:0.##})");
            }

            return; // emulate_mouse_from_touch companion
        }

        if (InputProbe)
        {
            ProbePointer(motion, "mouse-motion");
        }

        var d = ToDesign(motion);
        _machine!.PointerMove(MouseId, PointerKind.Mouse, d.X, d.Y, now);
    }

    // ==============================================================================================
    // key path
    // ==============================================================================================

    private void HandleKey(InputEventKey key, double now)
    {
        if (!key.Pressed || key.Echo)
        {
            return; // press-only; drop OS key-repeat echoes (the machine has no repeat flag)
        }

        if (GetViewport().GuiGetFocusOwner() is not null)
        {
            return; // a focused LineEdit owns typing
        }

        if (!KeyMap.TryMap(key.PhysicalKeycode, out var code))
        {
            return;
        }

        _machine!.Key(code, ModifiersCsv(key));
    }

    // Web-exact composition (inputCapture.ts onKeyDown): [ctrl, shift, alt, meta].filter(Boolean).join(","). The
    // machine omits the field when the csv is empty (matching `modifiers || undefined`).
    private static string ModifiersCsv(InputEventKey key)
    {
        var mods = new List<string>(4);
        if (key.CtrlPressed)
        {
            mods.Add("ctrl");
        }

        if (key.ShiftPressed)
        {
            mods.Add("shift");
        }

        if (key.AltPressed)
        {
            mods.Add("alt");
        }

        if (key.MetaPressed)
        {
            mods.Add("meta");
        }

        return string.Join(",", mods);
    }

    // ==============================================================================================
    // helpers
    // ==============================================================================================

    private bool GateOpen() =>
        GesturesEnabled
        && _uiRoot is not null
        && _uiRoot.State == UiRoot.UiState.Mirror
        // The Settings panel is MODAL for input; the floating latency overlay is not (chrome rect-test covers it).
        && !_uiRoot.ModalOpen;

    // Invert the letterbox/anchor mapping to design space, then clamp to the LIVE widened stage. On a >16:9 stage
    // the viewport's visible rect is the widened design space (ContentScaleSize, up to 2520 wide), so the X clamp
    // tracks it; Y is never widened. == 1920 on a 16:9 stage (strict no-op). The resolvers invert this design point
    // back to 1920-space GAME coords before anything reaches the wire.
    private Vector2 ToDesign(InputEvent @event)
    {
        var p = EventPosition(MakeInputLocal(@event));
        float dx = Mathf.Clamp(p.X, 0f, GetViewport().GetVisibleRect().Size.X);
        float dy = Mathf.Clamp(p.Y, 0f, 1080f);
        // #19 input safety: un-map a pointer that landed on an ENLARGED view-scale item (reward list / card reward /
        // merchant carpet item) back to its TRUE (un-scaled) design coordinate, ONCE, before the gesture machine /
        // target scan / pointer field see it — so a scaled item, including its enlarged halo band, stays tappable.
        // Identity (byte-identical) when no view-scale stamp contains the point (the registry is empty when the pass
        // is off or no view-scale screen is up), so this composes with the widened-clip + hand-choice input wiring.
        var (rx, ry) = ViewScaler.InverseRemap(dx, dy);
        return new Vector2((float)rx, (float)ry);
    }

    // The live widened design width (== the viewport's visible-rect width == ContentScaleSize width; 1920 on 16:9,
    // up to 2520 on an ultra-wide stage). Feeds the PointerResolver + PointerField so the anchor field spans the
    // same width ToDesign clamps to.
    private double DesignWidth() => GetViewport().GetVisibleRect().Size.X;

    // GestureCallbacks.TargetsAt: resolve the design point to a 1920-space GAME coordinate (map + near-miss, via the
    // resolver's FRESH path) and hit-test game space there. On a widened stage a point over a +dx-shifted card
    // resolves to `designX − dx`, which lands inside that card's game rect — the equivalent of the web's RENDERED-space
    // elementsFromPoint probe. Identity on 16:9 (the resolver short-circuits), so this is byte-identical to before M2.
    private IReadOnlyList<string> TargetsAtResolved(double x, double y)
    {
        var resolved = _resolver!.Fresh(x, y);
        // #10: thread the live spread lookup so a widened ScrollContainer's clip loop uses its anchor-widened
        // RenderedWidth (the rightmost grid column is otherwise falsely clip-rejected at F≠1). Null-equivalent on 16:9.
        return TouchTargetScan.TargetsAt(_store!.State, _store.Transforms, resolved.X, resolved.Y, SpreadLookup);
    }

    // The live SpreadIndex as an id→record lookup (issue #10 widened-clip test in TouchTargetScan / DemoInputPlayer
    // dump). At spreadFactor 1 (16:9) no records exist, so every lookup returns null and the callers are byte-identical.
    private SpreadRecord? SpreadLookup(string id) => _store!.Spread.TryGet(id, out var r) ? r : null;

    private static Vector2 EventPosition(InputEvent @event) => @event switch
    {
        InputEventMouse m => m.Position,
        InputEventScreenTouch t => t.Position,
        InputEventScreenDrag d => d.Position,
        _ => Vector2.Zero,
    };

    // --input-probe: on every raw pointer event log raw + MakeInputLocal position + the viewport final transform, so
    // the day-1 corner probe can confirm the mapping lands design coords at the stage corners/center.
    private void ProbePointer(InputEvent @event, string tag)
    {
        var raw = EventPosition(@event);
        var local = EventPosition(MakeInputLocal(@event));
        var final = GetViewport().GetFinalTransform();
        GD.Print($"M1E_PROBE: {tag} raw=({raw.X:0.##},{raw.Y:0.##}) local=({local.X:0.##},{local.Y:0.##}) " +
                 $"finalXform=[{final.X.X:0.####},{final.X.Y:0.####},{final.Y.X:0.####},{final.Y.Y:0.####}," +
                 $"{final.Origin.X:0.##},{final.Origin.Y:0.##}]");
    }

    // Wrap the machine's Send: assign a local audit seq, log, then forward to the coordinator (which stamps the real
    // per-message requestId via MirrorSocket.SendInput). This is WS-M's primary evidence channel.
    private void AuditedSend(InputMessage message)
    {
        _seq++;
        GD.Print($"M1E_INPUT: seq={_seq} kind={message.Kind} button={message.Button ?? "-"} " +
                 $"x={Fmt(message.CoordX)} y={Fmt(message.CoordY)} pressed={PressedStr(message.Pressed)} " +
                 $"key={message.Key ?? "-"} mods={message.Modifiers ?? "-"}");
        _coordinator!.SendInput(message);
    }

    private static string Fmt(double? v) =>
        v is { } d ? d.ToString("0.##", CultureInfo.InvariantCulture) : "-";

    private static string PressedStr(bool? v) => v is { } b ? (b ? "true" : "false") : "-";
}
