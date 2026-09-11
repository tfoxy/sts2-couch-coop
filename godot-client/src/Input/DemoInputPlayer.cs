// OWNER: WS-M (native input shim). M1e. Track Q extends it into the shared QA-channel interpreter.
//
// Drives REAL Godot input events through Godot.Input.ParseInputEvent from a text script, so the FULL InputRouter path is
// exercised — including the emulate_mouse_from_touch dedupe (ParseInputEvent applies the project's pointer emulation
// remapping, unlike Viewport.PushInput). Design→window conversion uses the viewport's own GetFinalTransform (the exact
// inverse the root viewport pre-applies to every incoming event), so an injected design coord round-trips through the
// router's mapping.
//
// TWO SOURCES, ONE GRAMMAR (Track Q). The command interpreter accepts lines from EITHER source without forking the
// grammar:
//   * `--demo-input <script>` (InputRouter): the whole file is loaded via LoadScript; each line runs fire-and-forget
//     (logged via GD.Print, no reply). This is the original M1e one-shot behaviour.
//   * The QA TCP channel (QaServer): each socket line is EnqueueRemote'd with a responder; exactly ONE response line is
//     delivered per command — "ok [payload]" or "err <reason>" — when the command completes (after any wait/shot yield).
// Both feed the SAME queue, drained on the MAIN thread in _Process (frame-paced: `wait`/`shot` yield across frames, the
// same one-per-frame cadence the coalesced hover path relies on). The player resolves the live AppShell + MirrorStore
// LAZILY each command (GetTree().CurrentScene), so a single persistent QA player survives connect/disconnect cycles.
//
// SCRIPT / COMMAND GRAMMAR (one command per line; blank lines + lines starting with '#' are comments):
//   touch down  <id> <x> <y>      # a finger presses at design (x,y)
//   touch move  <id> <x> <y>      # a finger drags to design (x,y)
//   touch up    <id> <x> <y>      # a finger lifts at design (x,y)
//   touch cancel <id>             # a finger's capture is stolen (position replayed from the machine's last-known)
//   mouse down  <left|right|middle> <x> <y>
//   mouse up    <left|right|middle> <x> <y>
//   mouse move  <x> <y>
//   mouse wheel <up|down> <x> <y>
//   key <GodotKeyName> [mod,mod]  # GodotKeyName = a Godot.Key enum name (A, Key1, Enter, Escape, ...); mods of ctrl,shift,alt,meta
//   wait <ms>                     # yield for ~<ms> of real time (frame-driven); reply is deferred until it elapses
//   dump <x> <y>                  # every HITTABLE node at design (x,y): id/name/leaf/scene/kind/isCard/isHandCard/chain — JSON
//   dumptap <x> <y>               # read-only twin of a REAL tap: applies ViewScaler.InverseRemap first, then {raw,remapped,moved,targets,hittable}
//   dumptypes [filter]            # sorted distinct visible node-type leaves (optional substring filter) — JSON payload
//   dumpcards                     # every NCard id + its design-space center — JSON payload on the socket
//   dumpcrisp                     # WS-CRISP capture: per-card-root + per-text-candidate reject + occlusion/black-hole detail — JSON
//   dumptips                      # R5 capture: per visible NHoverTipSet — owner/visual-owner boxes, spread Dx chain, stamp — JSON
//   dumpspread [name-substring]   # R10 capture: per matching node its scene/anchors/rect/origin + spread record — JSON
//   dumpalign [filter]            # R5 capture: per visible text node box vs glyph advance box + dyCentre (placement) — JSON
//   shot <path>                   # capture the current frame to <path>; replies `ok <path>` only after the PNG is written
//   renderscale <Full|Half|Quarter>  # (debug/test) set the client render scale — drives ApplyStageHosting transitions
//   backtomenu                    # tear the live stack down + rebuild the Connect screen (AppShell.ReturnToMenu)
//   quit                          # quit the app (ends the run)
//   -- Track Q lifecycle/QA verbs (work from BOTH the file script and the socket) --
//   connect <host[:port]>         # drive the join flow (same path the ConnectScreen "tap connect" takes; default :13337)
//   disconnect                    # tear the live stack down back to the Connect screen (err when not connected)
//   reload                        # coordinator.Resync() — re-sync a fresh keyframe (err when not connected)
//   setting <key> <value>         # renderScale=Full|Half|Quarter, shader/particle=Dynamic|Static|Off, crispText/directfull/staticbake=on|off
//   state                         # one-line JSON snapshot: connected/revision/nodeCount/renderScale/hosting/... (see AppShell.QaStateJson)
//   hide <selector>               # force-hide matching nodes (QA GPU experiments): type:<suffix>|name:<name>|id:<wireId>|stage|bake
//   show <selector> | show all    # remove one forced-hide selector / clear them all
//   hidelist                      # the active forced-hide selectors + their current wire-node match counts (JSON)
//
// IDs are injected once per _Process; a `wait` between events gives each a frame to dispatch (and coalesced hover is
// one-per-frame, so streamed drag hovers need small waits between moves).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene;
using CouchCoop.GodotClient.Scene.Drawers;
using CouchCoop.GodotClient.Ui;
using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Input;

public sealed partial class DemoInputPlayer : Node
{
    // A queued command + optional responder. Respond == null → a fire-and-forget FILE-script line (logs via GD.Print,
    // no reply). Respond != null → a QA-socket line: exactly one response line is delivered when the command completes
    // (after any wait/shot yield).
    private sealed class Pending
    {
        public string Line = "";
        public Action<string>? Respond;
    }

    // The command outcome: Yielded (wait/shot — response deferred to completion) or a ready response string.
    private readonly record struct Outcome(bool Yielded, string Response);

    private readonly object _lock = new();      // guards _queue (QaServer enqueues from its serve thread)
    private readonly Queue<Pending> _queue = new();
    private Pending? _active;                    // the command currently yielding (wait/shot) awaiting completion
    private double _waitMs;
    private bool _shotPending;
    private bool _done;                          // set by `quit` — stops all further processing

    // File-script bookkeeping (the one-shot "script complete" log): count of loaded fire-and-forget lines still to
    // finish. Only file lines are counted (socket lines always carry a responder), so it never fires for the QA channel.
    private bool _sawFileScript;
    private int _fileLinesLeft;
    private bool _fileScriptCompleteLogged;

    // Load a `--demo-input <script>` file: enqueue each non-comment line as a fire-and-forget command.
    public void LoadScript(string path)
    {
        var text = ReadText(path);
        if (text is null)
        {
            GD.PrintErr($"M1E_DEMO: could not read script '{path}'");
            return;
        }

        int n = 0;
        foreach (var raw in text.Replace("\r", "").Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }

            lock (_lock)
            {
                _queue.Enqueue(new Pending { Line = line });
            }

            n++;
        }

        _sawFileScript = true;
        _fileLinesLeft += n;
        GD.Print($"M1E_DEMO: loaded {n} commands from '{path}'");
    }

    // Track Q: enqueue one QA-socket command line. Thread-safe (the QA serve thread calls this); the line executes on
    // the MAIN thread in _Process, and `respond` is invoked there exactly once with the single response line.
    public void EnqueueRemote(string line, Action<string> respond)
    {
        lock (_lock)
        {
            _queue.Enqueue(new Pending { Line = line, Respond = respond });
        }
    }

    public override void _Process(double delta)
    {
        if (_done)
        {
            return;
        }

        // A yielding command (wait/shot) is mid-flight.
        if (_active is not null)
        {
            if (_shotPending)
            {
                return; // CaptureShot completes + responds asynchronously
            }

            if (_waitMs > 0)
            {
                _waitMs -= delta * 1000.0;
                if (_waitMs > 0)
                {
                    return;
                }
            }

            Complete(_active, "ok"); // `wait` finished
            _active = null;
        }

        while (!_done)
        {
            Pending? next;
            lock (_lock)
            {
                next = _queue.Count > 0 ? _queue.Dequeue() : null;
            }

            if (next is null)
            {
                break;
            }

            _active = next;
            var outcome = Exec(next.Line);
            if (outcome.Yielded)
            {
                return; // wait/shot — resume next frame; response deferred to completion
            }

            Complete(next, outcome.Response);
            _active = null;
        }

        MaybeLogScriptComplete();
    }

    // Deliver a command's single response (socket) or account a fire-and-forget file line (script).
    private void Complete(Pending cmd, string response)
    {
        if (cmd.Respond is not null)
        {
            try
            {
                cmd.Respond(response);
            }
            catch (Exception e)
            {
                GD.PrintErr($"QA: response delivery failed: {e.Message}");
            }
        }
        else if (_fileLinesLeft > 0)
        {
            _fileLinesLeft--;
        }
    }

    private void MaybeLogScriptComplete()
    {
        if (_fileScriptCompleteLogged || !_sawFileScript || _fileLinesLeft != 0 || _active is not null)
        {
            return;
        }

        bool queued;
        lock (_lock)
        {
            queued = _queue.Count > 0;
        }

        if (!queued)
        {
            _fileScriptCompleteLogged = true;
            GD.Print("M1E_DEMO: script complete");
        }
    }

    // Returns Yield for a command that spans frames (wait/shot); otherwise the ready "ok [payload]" / "err <reason>".
    private Outcome Exec(string line)
    {
        var p = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (p.Length == 0)
        {
            return Ok();
        }

        switch (p[0].ToLowerInvariant())
        {
            case "wait":
                _waitMs = ParseD(p, 1);
                return Yield;
            case "quit":
                GD.Print("M1E_DEMO: quit");
                _done = true;
                GetTree().Quit();
                return Ok();
            case "shot":
                return DoShot(p.Length > 1 ? p[1] : "shot.png");
            case "dump":
                return DoDump(ParseD(p, 1), ParseD(p, 2));
            case "dumptap":
                return DoDumpTap(ParseD(p, 1), ParseD(p, 2));
            case "dumptypes":
                return DoDumpTypes(p);
            case "dumpcards":
                return DoDumpCards();
            case "dumpcrisp":
                return DoDumpCrisp();
            case "dumptips":
                return DoDumpTips();
            case "dumpspread":
                return DoDumpSpread(p);
            case "dumpalign":
                return DoDumpAlign(p);
            case "renderscale":
                return DoRenderScale(p);
            case "backtomenu":
                return DoBackToMenu();
            case "touch":
                return DoTouch(p);
            case "mouse":
                return DoMouse(p);
            case "key":
                return DoKey(p);
            // Track Q lifecycle / QA verbs.
            case "connect":
                return DoConnect(p);
            case "disconnect":
                return DoDisconnect();
            case "reload":
                return DoReload();
            case "setting":
                return DoSetting(p);
            case "state":
                return DoState();
            case "hide":
                return DoHide(p);
            case "show":
                return DoShow(p);
            case "hidelist":
                return DoHideList();
            default:
                GD.PrintErr($"M1E_DEMO: unknown command '{line}'");
                return Err($"unknown-command {p[0]}");
        }
    }

    // ==============================================================================================
    // event injection (design coords → window coords via the viewport's final-transform inverse)
    // ==============================================================================================

    // Under canvas_items stretch the ROOT VIEWPORT applies its final (stretch) transform's inverse to every incoming
    // event, so a node observes design space directly. Input.ParseInputEvent injects a position the viewport maps back
    // through finalTransform.inverse(), so to make a node observe design point `d` we inject finalTransform * d.
    private Vector2 DesignToWindow(Vector2 design) => GetViewport().GetFinalTransform() * design;

    private Outcome DoTouch(string[] p)
    {
        IdleSuspend.NotifyInput(); // Track I: QA/demo input bypasses _UnhandledInput's stamp — wake the idle stage here
        var action = p.Length > 1 ? p[1] : "";
        int id = (int)ParseD(p, 2);

        if (action == "cancel")
        {
            Godot.Input.ParseInputEvent(new InputEventScreenTouch { Index = id, Pressed = false, Canceled = true });
            GD.Print($"M1E_DEMO: touch cancel id={id}");
            return Ok($"touch cancel id={id}");
        }

        var design = new Vector2((float)ParseD(p, 3), (float)ParseD(p, 4));
        var win = DesignToWindow(design);

        if (action is "down" or "up")
        {
            Godot.Input.ParseInputEvent(new InputEventScreenTouch { Index = id, Position = win, Pressed = action == "down" });
        }
        else // move
        {
            Godot.Input.ParseInputEvent(new InputEventScreenDrag { Index = id, Position = win });
        }

        GD.Print($"M1E_DEMO: touch {action} id={id} design=({design.X:0.#},{design.Y:0.#}) win=({win.X:0.#},{win.Y:0.#})");
        return Ok($"touch {action} id={id} design=({design.X:0.#},{design.Y:0.#})");
    }

    private Outcome DoMouse(string[] p)
    {
        IdleSuspend.NotifyInput(); // Track I: QA/demo input bypasses _UnhandledInput's stamp — wake the idle stage here
        var action = p.Length > 1 ? p[1] : "";

        if (action == "move")
        {
            var design = new Vector2((float)ParseD(p, 2), (float)ParseD(p, 3));
            Godot.Input.ParseInputEvent(new InputEventMouseMotion { Position = DesignToWindow(design) });
            GD.Print($"M1E_DEMO: mouse move design=({design.X:0.#},{design.Y:0.#})");
            return Ok($"mouse move design=({design.X:0.#},{design.Y:0.#})");
        }

        if (action == "wheel")
        {
            bool up = p.Length > 2 && p[2] == "up";
            var design = new Vector2((float)ParseD(p, 3), (float)ParseD(p, 4));
            var win = DesignToWindow(design);
            var btn = up ? MouseButton.WheelUp : MouseButton.WheelDown;
            Godot.Input.ParseInputEvent(new InputEventMouseButton { ButtonIndex = btn, Position = win, Pressed = true });
            Godot.Input.ParseInputEvent(new InputEventMouseButton { ButtonIndex = btn, Position = win, Pressed = false });
            GD.Print($"M1E_DEMO: mouse wheel {(up ? "up" : "down")} design=({design.X:0.#},{design.Y:0.#})");
            return Ok($"mouse wheel {(up ? "up" : "down")}");
        }

        // down / up
        var button = p.Length > 2 ? p[2] : "left";
        var d2 = new Vector2((float)ParseD(p, 3), (float)ParseD(p, 4));
        var mbtn = button switch
        {
            "right" => MouseButton.Right,
            "middle" => MouseButton.Middle,
            _ => MouseButton.Left,
        };
        Godot.Input.ParseInputEvent(new InputEventMouseButton { ButtonIndex = mbtn, Position = DesignToWindow(d2), Pressed = action == "down" });
        GD.Print($"M1E_DEMO: mouse {action} {button} design=({d2.X:0.#},{d2.Y:0.#})");
        return Ok($"mouse {action} {button} design=({d2.X:0.#},{d2.Y:0.#})");
    }

    private Outcome DoKey(string[] p)
    {
        IdleSuspend.NotifyInput(); // Track I: QA/demo input bypasses _UnhandledInput's stamp — wake the idle stage here
        if (p.Length < 2 || !Enum.TryParse<Key>(p[1], true, out var key))
        {
            GD.PrintErr($"M1E_DEMO: unknown key '{(p.Length > 1 ? p[1] : "")}'");
            return Err($"unknown-key {(p.Length > 1 ? p[1] : "")}");
        }

        var e = new InputEventKey { PhysicalKeycode = key, Keycode = key, Pressed = true };
        if (p.Length > 2)
        {
            foreach (var m in p[2].Split(','))
            {
                switch (m.Trim().ToLowerInvariant())
                {
                    case "ctrl":
                        e.CtrlPressed = true;
                        break;
                    case "shift":
                        e.ShiftPressed = true;
                        break;
                    case "alt":
                        e.AltPressed = true;
                        break;
                    case "meta":
                        e.MetaPressed = true;
                        break;
                }
            }
        }

        Godot.Input.ParseInputEvent(e);
        GD.Print($"M1E_DEMO: key {p[1]} mods={(p.Length > 2 ? p[2] : "-")}");
        return Ok($"key {p[1]}");
    }

    // ==============================================================================================
    // diagnostics (JSON payloads on the socket; the human-readable M1E_DUMP/M1E_CARDS logs are preserved)
    // ==============================================================================================

    // `dump <x> <y>`: the full hit-eligibility walk at a design/game point — EVERY hittable node under it (topmost
    // first), each with its name, type leaf, scene file, ComputeTouchInfo verdict, isCard/isHandCard, and its ancestor
    // chain (`id:typeLeaf` upward). This is the #9/#12 capture surface: a shop/relic/dialog item that classifies None
    // (an unlisted leaf) or Block never reaches TargetsAt output, so the plain `targets` list hides exactly the leaves
    // we need to add to the allowlist. The resolved TargetsAt list is still reported for convenience. The spread lookup
    // is threaded so the #10 widened clip loop matches the live client (null-equivalent on 16:9).
    private Outcome DoDump(double x, double y)
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        var state = store.State;
        Func<string, SpreadRecord?> spread = id => store.Spread.TryGet(id, out var r) ? r : null;

        var targets = TouchTargetScan.TargetsAt(state, store.Transforms, x, y, spread);
        var hittable = TouchTargetScan.HittableIdsAt(state, store.Transforms, x, y, spread);
        GD.Print($"M1E_DUMP: at ({x:0.#},{y:0.#}) targets=[{string.Join(",", targets)}] hittable={hittable.Count}");

        var arr = new JsonArray();
        foreach (var id in hittable)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            var info = TouchTargetScan.ComputeTouchInfo(state, id);
            bool isCard = TouchTargetScan.IsCard(state, id);
            bool isHandCard = TouchTargetScan.IsHandCard(state, id);
            var (file, _) = SceneIdentity.Resolve(id, state);
            string leaf = NodeTypeLeaf(node.NodeType);
            string chain = AncestorChain(state, id);
            GD.Print($"M1E_DUMP:   {id} name={node.Name} leaf={leaf} scene={file ?? "-"} kind={info.Kind} " +
                     $"isCard={isCard} isHandCard={isHandCard} chain={chain}");
            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = node.Name,
                ["leaf"] = leaf,
                ["scene"] = file,
                ["kind"] = info.Kind.ToString(),
                ["isCard"] = isCard,
                ["isHandCard"] = isHandCard,
                ["chain"] = chain,
            });
        }

        var targetArr = new JsonArray();
        foreach (var t in targets)
        {
            targetArr.Add(t);
        }

        return Ok(new JsonObject
        {
            ["x"] = Math.Round(x, 1),
            ["y"] = Math.Round(y, 1),
            ["targets"] = targetArr,
            ["hittable"] = arr,
        }.ToJsonString());
    }

    // `dumptap <x> <y>`: the READ-ONLY twin of a real tap at design point (x,y). Unlike `dump` (which hit-tests the
    // raw point directly, bypassing the router), this first applies ViewScaler.InverseRemap — the SAME view-scale
    // inverse InputRouter.ToDesign runs before the gesture pipeline — so it reports where a tap on an ENLARGED
    // view-scale item (card-reward Skip / side cards, shop / event items) actually lands. Reports the raw point, the
    // remapped point (+ whether it moved), and the TargetsAt / HittableIdsAt walk at the REMAPPED point. Round-4's tap
    // verification missed the R5 bug because `dump` probed TRUE positions; a tap check MUST probe the VISUAL position
    // of an OFF-PIVOT element (a side card / the Skip button — a centre point is a fixed point of the scale and can't
    // discriminate). The spread lookup is threaded so the #10 widened clip loop matches the live client (16:9 = null).
    private Outcome DoDumpTap(double x, double y)
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        var (rx, ry) = ViewScaler.InverseRemap(x, y);
        bool moved = rx != x || ry != y;

        var state = store.State;
        Func<string, SpreadRecord?> spread = id => store.Spread.TryGet(id, out var r) ? r : null;
        var targets = TouchTargetScan.TargetsAt(state, store.Transforms, rx, ry, spread);
        var hittable = TouchTargetScan.HittableIdsAt(state, store.Transforms, rx, ry, spread);
        GD.Print($"M1E_DUMPTAP: raw=({x:0.#},{y:0.#}) remapped=({rx:0.#},{ry:0.#}) moved={moved} " +
                 $"targets=[{string.Join(",", targets)}] hittable={hittable.Count}");

        var arr = new JsonArray();
        foreach (var id in hittable)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            var info = TouchTargetScan.ComputeTouchInfo(state, id);
            var (file, _) = SceneIdentity.Resolve(id, state);
            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = node.Name,
                ["leaf"] = NodeTypeLeaf(node.NodeType),
                ["scene"] = file,
                ["kind"] = info.Kind.ToString(),
                ["isCard"] = TouchTargetScan.IsCard(state, id),
            });
        }

        var targetArr = new JsonArray();
        foreach (var t in targets)
        {
            targetArr.Add(t);
        }

        return Ok(new JsonObject
        {
            ["raw"] = new JsonObject { ["x"] = Math.Round(x, 1), ["y"] = Math.Round(y, 1) },
            ["remapped"] = new JsonObject { ["x"] = Math.Round(rx, 1), ["y"] = Math.Round(ry, 1) },
            ["moved"] = moved,
            ["targets"] = targetArr,
            ["hittable"] = arr,
        }.ToJsonString());
    }

    // `dumptypes`: the sorted DISTINCT set of node-type leaves that are effectively visible on screen right now (a
    // diff of two captures — before vs during a dialog — surfaces the new type-leaf a hand-choice dialog introduces,
    // the #12 signal). Optionally filtered by a case-insensitive substring so `dumptypes card` narrows the haystack.
    private Outcome DoDumpTypes(string[] p)
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        string? filter = p.Length > 1 ? p[1].ToLowerInvariant() : null;
        var state = store.State;
        var leaves = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node) || !EffectivelyVisible(state, node))
            {
                continue;
            }

            string leaf = NodeTypeLeaf(node.NodeType);
            if (filter is null || leaf.ToLowerInvariant().Contains(filter))
            {
                leaves.Add(leaf);
            }
        }

        GD.Print($"M1E_TYPES: count={leaves.Count} [{string.Join(",", leaves)}]");
        var arr = new JsonArray();
        foreach (var leaf in leaves)
        {
            arr.Add(leaf);
        }

        return Ok(new JsonObject { ["count"] = leaves.Count, ["types"] = arr }.ToJsonString());
    }

    // The parent chain from `id` up to the root as `id:typeLeaf` segments (bounded; guards against a cyclic chain).
    private static string AncestorChain(MirrorState state, string id)
    {
        var parts = new List<string>();
        var cur = state.Nodes.TryGetValue(id, out var start) ? start : null;
        int guard = 0;
        while (cur is not null && guard++ < 256)
        {
            parts.Add($"{cur.Id}:{NodeTypeLeaf(cur.NodeType)}");
            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return string.Join(">", parts);
    }

    private Outcome DoDumpCards()
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        var state = store.State;
        var arr = new JsonArray();
        int n = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node) || NodeTypeLeaf(node.NodeType) != "NCard")
            {
                continue;
            }

            if (node.LocalRect is not { } rect || !store.Transforms.TryGetGlobal(id, out var g))
            {
                continue;
            }

            double cx = rect.X + (rect.Width / 2), cy = rect.Y + (rect.Height / 2);
            double gx = (g[0] * cx) + (g[2] * cy) + g[4];
            double gy = (g[1] * cx) + (g[3] * cy) + g[5];
            bool vis = EffectivelyVisible(state, node);
            GD.Print($"M1E_CARDS: {id} vis={vis} center=({gx:0.#},{gy:0.#}) size=({rect.Width:0.#}x{rect.Height:0.#})");
            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["visible"] = vis,
                ["cx"] = Math.Round(gx, 1),
                ["cy"] = Math.Round(gy, 1),
                ["w"] = Math.Round(rect.Width, 1),
                ["h"] = Math.Round(rect.Height, 1),
            });
            n++;
        }

        GD.Print($"M1E_CARDS: total NCard nodes={n}");
        return Ok(new JsonObject { ["count"] = n, ["cards"] = arr }.ToJsonString());
    }

    // `dumpcrisp`: the WS-CRISP capture surface — per card ROOT its CardLayer reject + every unsettled/failed card
    // member url (the R18 black-hole surface), and per TEXT candidate its TextOverlay reject + occlusion culprit (the
    // R18 sort-button Clip-vs-Effect + R19-relic measured-Occluded-vs-unmeasured verdicts). Each controller runs a
    // fresh per-id-capture Plan over the CURRENT state, so this reads what the labels ACTUALLY hit right now. Best run
    // at Half on the deck/draw/discard/exhaust grid after it settles (a couple of `wait`s). Inert controllers report
    // {"active":false}. `adb logcat | grep M1C_TEX` alongside surfaces the underlying fetch/decode failures.
    private Outcome DoDumpCrisp()
    {
        if (Shell() is not { } shell)
        {
            return Err("no-appshell");
        }

        if (shell.CurrentStore is null)
        {
            return Err("not-connected");
        }

        var cards = shell.CurrentCardLayer?.DumpCrispJson() ?? new JsonObject { ["active"] = false, ["reason"] = "no-cardlayer" };
        var text = shell.CurrentTextOverlay?.DumpCrispJson() ?? new JsonObject { ["active"] = false, ["reason"] = "no-textoverlay" };
        GD.Print($"M1E_CRISP: renderScale={ClientEffectSettings.RenderScale} cards={cards["hist"]?.ToString() ?? "-"} " +
                 $"text={text["hist"]?.ToString() ?? "-"}");
        return Ok(new JsonObject
        {
            ["renderScale"] = ClientEffectSettings.RenderScale.ToString(),
            ["cards"] = cards,
            ["text"] = text,
        }.ToJsonString());
    }

    // R5 `dumptips`: ground-truth dump of every visible NHoverTipSet — root id + spread Dx + AnchorOwnerId; owner
    // leaf/scene/raw box + resolved VISUAL owner (H2) + its box/Dx + any view-scale-mapped box (item 6); the direct-
    // child column AABBs; the computed stamp (kind/scale/pivot/clamp, design space); and the ViewScaler stamp covering
    // the owner. One capture per widescreen state turns the remaining tip contexts into ground truth, not guesses.
    private Outcome DoDumpTips()
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        var state = store.State;
        double designWidth = store.SpreadFactor * StageStretch.BaseDesignWidth;
        var arr = new JsonArray();
        int n = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var root) || NodeTypeLeaf(root.NodeType) != "NHoverTipSet"
                || !EffectivelyVisible(state, root))
            {
                continue;
            }

            n++;
            double tipDx = store.Spread.TryGet(id, out var tr) ? tr.Dx : 0;

            // Direct-child column AABBs (each the union of its paint-bearing descendants).
            var columns = new List<DesignAabb>();
            var childArr = new JsonArray();
            foreach (var cid in state.OrderedIds)
            {
                if (state.Nodes.TryGetValue(cid, out var cn) && cn.ParentId == id
                    && MeasureColumnState(store, cid) is { } col)
                {
                    columns.Add(col);
                    childArr.Add(BoxJson(col));
                }
            }

            // Owner + resolved visual owner + view-scale map.
            string? ownerId = root.AnchorOwnerId;
            var ownerObj = new JsonObject { ["anchorOwnerId"] = ownerId };
            DesignAabb? ownerBox = null;
            var kind = HoverTipScaleMath.TipOwnerKind.None;
            double followX = 0, followY = 0;
            if (ownerId is not null && state.Nodes.TryGetValue(ownerId, out var owner))
            {
                var (ofile, _) = SceneIdentity.Resolve(ownerId, state);
                kind = HoverTipScaleMath.ResolveOwnerKind(NodeTypeLeaf(owner.NodeType), ofile);
                string visualId = TipOwnerResolve.ResolveVisualOwnerId(state, store.Transforms, store.Spread, ownerId);
                ownerObj["ownerLeaf"] = NodeTypeLeaf(owner.NodeType);
                ownerObj["ownerScene"] = ofile;
                ownerObj["kind"] = kind.ToString();
                ownerObj["visualOwnerId"] = visualId;
                if (DesignBoxOfNode(store, visualId) is { } raw)
                {
                    ownerBox = raw;
                    ownerObj["visualBox"] = BoxJson(raw);
                    ownerObj["visualDx"] = Math.Round(store.Spread.TryGet(visualId, out var vr) ? vr.Dx : 0, 1);
                    if (ViewScaler.MapThroughContainingStamps(state, visualId, raw, out var mapped))
                    {
                        ownerBox = mapped;
                        followX = ((mapped.MinX + mapped.MaxX) - (raw.MinX + raw.MaxX)) / 2.0;
                        followY = ((mapped.MinY + mapped.MaxY) - (raw.MinY + raw.MaxY)) / 2.0;
                        ownerObj["viewScaleMappedBox"] = BoxJson(mapped);
                    }
                }
            }

            var stamp = HoverTipScaleMath.ComputeStamp(
                columns, designWidth, StageStretch.DesignHeight, 1.2f, ownerBox, kind,
                followX, followY);
            var stampObj = new JsonObject();
            if (stamp is { } s)
            {
                stampObj["scale"] = Math.Round(s.Scale, 3);
                stampObj["pivotX"] = Math.Round(s.PivotX, 1);
                stampObj["pivotY"] = Math.Round(s.PivotY, 1);
                stampObj["clampX"] = Math.Round(s.ClampX, 1);
                stampObj["clampY"] = Math.Round(s.ClampY, 1);
            }

            GD.Print($"M1E_TIPS: {id} dx={tipDx:0.#} owner={ownerId ?? "-"} kind={kind} cols={columns.Count} " +
                     $"stamp={(stamp is { } st ? $"k={st.Scale:0.##} p=({st.PivotX:0.#},{st.PivotY:0.#}) c=({st.ClampX:0.#},{st.ClampY:0.#})" : "-")}");
            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["dx"] = Math.Round(tipDx, 1),
                ["owner"] = ownerObj,
                ["columns"] = childArr,
                ["stamp"] = stampObj,
                ["chain"] = SpreadChain(store, id),
            });
        }

        GD.Print($"M1E_TIPS: total NHoverTipSet nodes={n}");
        return Ok(new JsonObject { ["count"] = n, ["tips"] = arr }.ToJsonString());
    }

    // The union of a subtree's paint-bearing design AABBs (STORE globals + spread Dx), or null when nothing paints —
    // the same measurement HoverTipScaler columns use, reproduced from state for the dump.
    private static DesignAabb? MeasureColumnState(MirrorStore store, string rootId)
    {
        DesignAabb union = default;
        bool any = false;
        AccumColumn(store, rootId, ref union, ref any);
        return any ? union : null;
    }

    private static void AccumColumn(MirrorStore store, string id, ref DesignAabb union, ref bool any)
    {
        if (DesignBoxOfNode(store, id) is { } box)
        {
            union = any ? union.Union(box) : box;
            any = true;
        }

        foreach (var cid in store.State.OrderedIds)
        {
            if (store.State.Nodes.TryGetValue(cid, out var cn) && cn.ParentId == id)
            {
                AccumColumn(store, cid, ref union, ref any);
            }
        }
    }

    // A node's paint-bearing design AABB (PaintBox under STORE global + spread Dx), or null when it paints nothing.
    private static DesignAabb? DesignBoxOfNode(MirrorStore store, string id)
    {
        if (!store.State.Nodes.TryGetValue(id, out var node) || !node.Visible
            || TextureDrawer.PaintBox(node) is not { } box || box.Size.X <= 0 || box.Size.Y <= 0
            || !store.Transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        double dx = store.Spread.TryGet(id, out var rec) ? rec.Dx : 0;
        var gt = new Transform2D((float)g[0], (float)g[1], (float)g[2], (float)g[3], (float)g[4], (float)g[5]);
        Vector2 p = box.Position, sz = box.Size;
        Vector2 c0 = gt * p, c1 = gt * (p + new Vector2(sz.X, 0)), c2 = gt * (p + new Vector2(0, sz.Y)), c3 = gt * (p + sz);
        float minX = Mathf.Min(Mathf.Min(c0.X, c1.X), Mathf.Min(c2.X, c3.X));
        float minY = Mathf.Min(Mathf.Min(c0.Y, c1.Y), Mathf.Min(c2.Y, c3.Y));
        float maxX = Mathf.Max(Mathf.Max(c0.X, c1.X), Mathf.Max(c2.X, c3.X));
        float maxY = Mathf.Max(Mathf.Max(c0.Y, c1.Y), Mathf.Max(c2.Y, c3.Y));
        return new DesignAabb(minX, minY, maxX, maxY).ShiftX(dx);
    }

    private static JsonObject BoxJson(DesignAabb b) => new()
    {
        ["minX"] = Math.Round(b.MinX, 1),
        ["minY"] = Math.Round(b.MinY, 1),
        ["maxX"] = Math.Round(b.MaxX, 1),
        ["maxY"] = Math.Round(b.MaxY, 1),
    };

    // The tip's ancestor chain as `id:Dx` segments (the spread Dx telescoping the walk applied), bounded.
    private static string SpreadChain(MirrorStore store, string id)
    {
        var parts = new List<string>();
        var cur = store.State.Nodes.TryGetValue(id, out var start) ? start : null;
        int guard = 0;
        while (cur is not null && guard++ < 256)
        {
            double dx = store.Spread.TryGet(cur.Id, out var r) ? r.Dx : 0;
            parts.Add($"{cur.Id}:{dx:0.#}");
            cur = cur.ParentId is { } pid && store.State.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return string.Join(">", parts);

    }

    // `dumpspread [name-substring]`: per matching node, its id/name/type/sceneFile/anchors/localRect/origin + its
    // wide-screen spread record (Dx / RenderedWidth / Prop / Paints). The R10 blocking capture — run it at the
    // Tezcatara event on a WIDENED stage to read the event background scene's SceneFilePath (so SpreadIndex's
    // IsBackgroundSceneRoot pattern is captured, not guessed) and to see which spread branch each bg/flame node took
    // (Dx, and Prop = the positional-field flavor). Filter is a case-insensitive substring over name OR sceneFile.
    private Outcome DoDumpSpread(string[] p)
    {
        if (Store() is not { } store)
        {
            return Err("not-connected");
        }

        string? filter = p.Length > 1 ? p[1].ToLowerInvariant() : null;
        var state = store.State;
        var arr = new JsonArray();
        int n = 0;
        foreach (var id in state.OrderedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            string name = node.Name;
            string sceneFile = node.SceneFilePath ?? "";
            if (filter is not null
                && !name.ToLowerInvariant().Contains(filter)
                && !sceneFile.ToLowerInvariant().Contains(filter))
            {
                continue;
            }

            store.Transforms.TryGetGlobal(id, out var g);
            double ox = g is { Count: >= 6 } ? g[4] : double.NaN;
            double oy = g is { Count: >= 6 } ? g[5] : double.NaN;
            var lr = node.LocalRect;
            bool hasSpread = store.Spread.TryGet(id, out var rec);
            string leaf = NodeTypeLeaf(node.NodeType);
            GD.Print($"M1E_SPREAD: {id} name={name} leaf={leaf} scene={(sceneFile.Length > 0 ? sceneFile : "-")} " +
                     $"anchors=[{node.AnchorLeft?.ToString("0.###") ?? "-"},{node.AnchorRight?.ToString("0.###") ?? "-"}] " +
                     $"rect={(lr is { } r ? $"[{r.X:0},{r.Y:0} {r.Width:0}x{r.Height:0}]" : "-")} origin=({ox:0.#},{oy:0.#}) " +
                     $"spread={(hasSpread ? $"dx={rec.Dx:0.##} w={rec.RenderedWidth:0.##} prop={rec.Prop} paints={rec.Paints}" : "none")}");
            arr.Add(new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["leaf"] = leaf,
                ["scene"] = sceneFile.Length > 0 ? sceneFile : null,
                ["anchorLeft"] = node.AnchorLeft,
                ["anchorRight"] = node.AnchorRight,
                ["rectX"] = lr is { } rx ? Math.Round(rx.X, 1) : (double?)null,
                ["rectY"] = lr is { } ry ? Math.Round(ry.Y, 1) : (double?)null,
                ["rectW"] = lr is { } rw ? Math.Round(rw.Width, 1) : (double?)null,
                ["rectH"] = lr is { } rh ? Math.Round(rh.Height, 1) : (double?)null,
                ["originX"] = double.IsNaN(ox) ? (double?)null : Math.Round(ox, 1),
                ["originY"] = double.IsNaN(oy) ? (double?)null : Math.Round(oy, 1),
                ["spreadDx"] = hasSpread ? Math.Round(rec.Dx, 2) : (double?)null,
                ["spreadWidth"] = hasSpread ? Math.Round(rec.RenderedWidth, 2) : (double?)null,
                ["spreadProp"] = hasSpread ? rec.Prop : (bool?)null,
                ["spreadPaints"] = hasSpread ? rec.Paints : (bool?)null,
            });
            n++;
        }

        GD.Print($"M1E_SPREAD: total matched={n} factor={store.Spread.Factor:0.####}");
        return Ok(new JsonObject { ["count"] = n, ["factor"] = Math.Round(store.Spread.Factor, 4), ["nodes"] = arr }.ToJsonString());
    }

    // `dumpalign [filter]` (R5 text-centering capture): per visible text node its streamed box vs the laid-out glyph
    // advance box (design space) + dyCentre = glyphCentreY − boxCentreY — the NUMERIC placement check paired with
    // scripts/verify-text-align.sh's ink gate. On-device over adb forward, no screenshot. Optional case-insensitive
    // filter (name/type/scene/relPath). CAVEAT (see TextAlignDump): dyCentre ≈ 0 == centred only for a LOOSE-box label;
    // a TIGHT-box overflow label (HP) reads dyCentre ≈ −overflow/2 by design. Env twin: COUCHCOOP_MIRROR_TEXTALIGN_DUMP.
    private Outcome DoDumpAlign(string[] p)
    {
        if (Shell() is not { } shell || shell.CurrentReconciler is not { } reconciler || shell.CurrentStore is not { } store)
        {
            return Err("not-connected");
        }

        var json = TextAlignDump.Collect(reconciler, store, p.Length > 1 ? p[1] : null);
        GD.Print($"M1E_ALIGN: count={json["count"]} stats={json["stats"]}");
        return Ok(json.ToJsonString());
    }

    // (debug/test) Flip the client render scale — the same mutation the SettingsPanel OptionButton performs (bumps
    // ClientEffectSettings.Generation, so AppShell.ApplyRenderScaleIfChanged picks it up next frame and calls
    // ApplyStageHosting, exercising the Full(direct)↔Half/Quarter(subviewport) transitions). `setting renderScale` is
    // the alias of this verb.
    private Outcome DoRenderScale(string[] p)
    {
        if (p.Length < 2 || !Enum.TryParse<RenderScale>(p[1], true, out var scale) || !Enum.IsDefined(typeof(RenderScale), scale))
        {
            GD.PrintErr($"M1E_DEMO: unknown renderscale '{(p.Length > 1 ? p[1] : "")}' (want Full|Half|Quarter)");
            return Err($"bad-renderscale {(p.Length > 1 ? p[1] : "")} (Full|Half|Quarter)");
        }

        ClientEffectSettings.RenderScale = scale;
        GD.Print($"M1E_DEMO: renderscale {scale}");
        return Ok($"renderScale={scale}");
    }

    // Trigger AppShell.ReturnToMenu — the full live-stack teardown + Connect-screen rebuild.
    private Outcome DoBackToMenu()
    {
        if (Shell() is { } shell)
        {
            GD.Print("M1E_DEMO: backtomenu");
            shell.ReturnToMenu();
            return Ok();
        }

        GD.PrintErr("M1E_DEMO: backtomenu — AppShell not the current scene");
        return Err("no-appshell");
    }

    // ==============================================================================================
    // Track Q lifecycle / QA verbs (delegate to AppShell's public QA surface)
    // ==============================================================================================

    private Outcome DoConnect(string[] p)
    {
        if (Shell() is not { } shell)
        {
            return Err("no-appshell");
        }

        string hostPort = p.Length > 1 ? p[1] : "";
        var error = shell.QaConnect(hostPort);
        return error is null ? Ok($"connect {(hostPort.Length == 0 ? "<default>" : hostPort)}") : Err(error);
    }

    private Outcome DoDisconnect()
    {
        if (Shell() is not { } shell)
        {
            return Err("no-appshell");
        }

        var error = shell.QaDisconnect();
        return error is null ? Ok() : Err(error);
    }

    private Outcome DoReload()
    {
        if (Shell() is not { } shell)
        {
            return Err("no-appshell");
        }

        var error = shell.QaReload();
        return error is null ? Ok() : Err(error);
    }

    private Outcome DoState()
    {
        if (Shell() is not { } shell)
        {
            return Err("no-appshell");
        }

        return Ok(shell.QaStateJson());
    }

    // Whitelist-mapped client-setting mutation (same live statics the SettingsPanel writes; RAM-only, no disk persist).
    // Only real knobs are accepted; anything else is `err unknown-setting <key>`.
    private Outcome DoSetting(string[] p)
    {
        if (p.Length < 3)
        {
            return Err("usage: setting <key> <value>");
        }

        string val = p[2];
        switch (p[1].ToLowerInvariant())
        {
            case "renderscale":
                if (!Enum.TryParse<RenderScale>(val, true, out var rs) || !Enum.IsDefined(typeof(RenderScale), rs))
                {
                    return Err($"bad-value {val} (Full|Half|Quarter)");
                }

                ClientEffectSettings.RenderScale = rs;
                GD.Print($"QA_SETTING: renderScale={rs}");
                return Ok($"renderScale={rs}");
            case "shader":
            case "shadermode":
                if (!TryEffectMode(val, out var sm))
                {
                    return Err($"bad-value {val} (Dynamic|Static|Off)");
                }

                ClientEffectSettings.ShaderMode = sm;
                GD.Print($"QA_SETTING: shaderMode={sm}");
                return Ok($"shaderMode={sm}");
            case "particle":
            case "particlemode":
                if (!TryEffectMode(val, out var pm))
                {
                    return Err($"bad-value {val} (Dynamic|Static|Off)");
                }

                ClientEffectSettings.ParticleMode = pm;
                GD.Print($"QA_SETTING: particleMode={pm}");
                return Ok($"particleMode={pm}");
            case "spine":
            case "spinemode":
                // R9 item 10: the manual spine override (its OWN 4-value enum — Auto is the default, and the shared
                // EffectMode has no such value). RAM-only like its siblings: the SettingsPanel row persists via Save(),
                // a QA session deliberately does not pollute settings.cfg. The Generation bump makes the reconciler
                // re-Apply every view, so the flip lands live (Off detaches the layers, Static re-requests stills).
                if (!Enum.TryParse<SpineMode>(val, true, out var spm) || !Enum.IsDefined(typeof(SpineMode), spm))
                {
                    return Err($"bad-value {val} (Auto|Dynamic|Static|Off)");
                }

                ClientEffectSettings.SpineMode = spm;
                GD.Print($"QA_SETTING: spineMode={spm}");
                return Ok($"spineMode={spm}");
            case "crisptext":
                if (!TryOnOff(val, out var on))
                {
                    return Err($"bad-value {val} (on|off)");
                }

                ClientSettingsStore.SetCrispTextRuntime(on);
                GD.Print($"QA_SETTING: crispText={on}");
                return Ok($"crispText={on}");
            case "directfull":
                // WS-FULLRES: RAM-only flip of the "Native full-scale rendering" opt-in (the mobile checkbox's static).
                // AppShell.ApplyContentScaleModeIfChanged polls it live, so this flips the window content-scale mode at
                // runtime (canvas_items native ↔ Viewport collapse) — no disk persist (parity with crisptext above).
                if (!TryOnOff(val, out var df))
                {
                    return Err($"bad-value {val} (on|off)");
                }

                ClientSettingsStore.SetDirectFullRuntime(df);
                GD.Print($"QA_SETTING: directFull={df}");
                return Ok($"directFull={df}");
            case "staticbake":
                // WS-MISC item 3: RAM-only flip of the "Static bake" pref (parity with crisptext/directfull above).
                // AppShell.ApplyStaticBakeEnableIfChanged polls it live, so this arms/disarms the bake at RUNTIME — no
                // reconnect (no disk persist; a QA session must not pollute the user's settings.cfg).
                if (!TryOnOff(val, out var sb))
                {
                    return Err($"bad-value {val} (on|off)");
                }

                ClientSettingsStore.SetStaticBakeRuntime(sb);
                GD.Print($"QA_SETTING: staticBake={sb}");
                return Ok($"staticBake={sb}");
            default:
                return Err($"unknown-setting {p[1]}");
        }
    }

    // ==============================================================================================
    // QA forced-hide verbs (GPU-experiment measurement tooling; enforcement lives in QaForcedHide +
    // the three Visible write sites — MirrorNodeView.Apply/ApplyLight, SceneReconciler.ApplyCull)
    // ==============================================================================================

    // `hide <selector>`: add a selector to the active force-hide set and apply it to every existing view NOW (the
    // per-drain enforcement covers everything the stream touches later). The reply reports how many wire nodes
    // CURRENTLY match — 0 is legal (matches may appear on later drains) but always reported.
    private Outcome DoHide(string[] p)
    {
        if (p.Length < 2)
        {
            return Err("usage: hide <selector>");
        }

        string text = string.Join(" ", p, 1, p.Length - 1); // host node names may contain spaces
        switch (text.ToLowerInvariant())
        {
            case "stage":
            {
                // The SceneReconciler root — the whole-mirror kill. Nothing else writes its Visible (a rebuilt
                // stack re-asserts the flag in its Bind).
                QaForcedHide.StageHidden = true;
                var stage = Shell()?.CurrentReconciler;
                if (stage is not null)
                {
                    stage.Visible = false;
                }

                GD.Print("QA_HIDE: stage");
                return Ok(HideReply("stage", stage is null ? 0 : 1));
            }

            case "bake":
            {
                // The StaticBake root — the composite quads' PARENT, so current and future quads blank while the
                // bake pipeline (viewports, originals' suppression, live-z) runs unperturbed. Matches = live quads.
                QaForcedHide.BakeHidden = true;
                var bake = Shell()?.CurrentStaticBake;
                if (bake is not null)
                {
                    bake.Visible = false;
                }

                GD.Print("QA_HIDE: bake");
                return Ok(HideReply("bake", bake?.RegionCount ?? 0));
            }
        }

        if (!QaHideSelector.TryParse(text, out var selector))
        {
            return Err($"bad-selector {text} (type:<suffix>|name:<name>|id:<wireId>|stage|bake)");
        }

        QaForcedHide.Add(selector);
        Shell()?.CurrentReconciler?.QaApplyForcedHide(); // land NOW — a static scene may not drain for seconds
        int matches = CountMatches(selector);
        GD.Print($"QA_HIDE: {selector} matches={matches}");
        return Ok(HideReply(selector.ToString(), matches));
    }

    // `show <selector>` / `show all`: remove one forced-hide selector / clear them all (stage/bake included).
    private Outcome DoShow(string[] p)
    {
        if (p.Length < 2)
        {
            return Err("usage: show <selector>|all");
        }

        string text = string.Join(" ", p, 1, p.Length - 1);
        var shell = Shell();
        switch (text.ToLowerInvariant())
        {
            case "all":
                QaForcedHide.Clear();
                if (shell?.CurrentReconciler is { } stageAll)
                {
                    stageAll.Visible = true;
                    stageAll.QaApplyForcedHide(); // restore NOW (blanket re-stamp + cull re-derive)
                }

                if (shell?.CurrentStaticBake is { } bakeAll)
                {
                    bakeAll.Visible = true;
                }

                GD.Print("QA_HIDE: show all");
                return Ok();
            case "stage":
                QaForcedHide.StageHidden = false;
                if (shell?.CurrentReconciler is { } stage)
                {
                    stage.Visible = true;
                }

                return Ok();
            case "bake":
                QaForcedHide.BakeHidden = false;
                if (shell?.CurrentStaticBake is { } bake)
                {
                    bake.Visible = true;
                }

                return Ok();
        }

        if (!QaHideSelector.TryParse(text, out var selector))
        {
            return Err($"bad-selector {text} (type:<suffix>|name:<name>|id:<wireId>|stage|bake|all)");
        }

        if (!QaForcedHide.Remove(selector))
        {
            return Err($"not-hidden {selector}");
        }

        shell?.CurrentReconciler?.QaApplyForcedHide(); // restore NOW (blanket re-stamp + cull re-derive)
        GD.Print($"QA_HIDE: show {selector}");
        return Ok();
    }

    // `hidelist`: the active selectors + their CURRENT wire-node match counts (stage/bake report their client target).
    private Outcome DoHideList()
    {
        var arr = new JsonArray();
        foreach (var selector in QaForcedHide.Selectors)
        {
            arr.Add(new JsonObject { ["selector"] = selector.ToString(), ["matches"] = CountMatches(selector) });
        }

        if (QaForcedHide.StageHidden)
        {
            arr.Add(new JsonObject { ["selector"] = "stage", ["matches"] = Shell()?.CurrentReconciler is null ? 0 : 1 });
        }

        if (QaForcedHide.BakeHidden)
        {
            arr.Add(new JsonObject { ["selector"] = "bake", ["matches"] = Shell()?.CurrentStaticBake?.RegionCount ?? 0 });
        }

        return Ok(new JsonObject { ["count"] = QaForcedHide.Count, ["selectors"] = arr }.ToJsonString());
    }

    private static string HideReply(string selector, int matches) =>
        new JsonObject { ["selector"] = selector, ["matches"] = matches }.ToJsonString();

    // Wire nodes currently matching `selector` (0 when not connected — a 0-match hide is legal; later drains may match).
    private int CountMatches(QaHideSelector selector)
    {
        if (Store() is not { } store)
        {
            return 0;
        }

        int n = 0;
        foreach (var node in store.State.Nodes.Values)
        {
            if (selector.Matches(node))
            {
                n++;
            }
        }

        return n;
    }

    // ==============================================================================================
    // shot capture (yields until the PNG is written, then replies `ok <path>`)
    // ==============================================================================================

    private Outcome DoShot(string path)
    {
        _shotPending = true;
        CaptureShot(_active!, path);
        return Yield;
    }

    private async void CaptureShot(Pending cmd, string path)
    {
        // Grab the fully-drawn frame (the state at the `shot` command — nothing after it has run yet).
        await ToSignal(RenderingServer.Singleton, RenderingServer.SignalName.FramePostDraw);
        var image = GetViewport().GetTexture().GetImage();
        Error err = image.SavePng(path);
        GD.Print($"M1E_SHOT: saved='{path}' err={err} size={image.GetWidth()}x{image.GetHeight()}");
        _shotPending = false;
        _active = null;
        Complete(cmd, err == Error.Ok ? $"ok {path}" : $"err savepng-{err}");
    }

    // ==============================================================================================
    // helpers
    // ==============================================================================================

    private static readonly Outcome Yield = new(true, "");

    private static Outcome Ok(string payload = "") => new(false, payload.Length == 0 ? "ok" : "ok " + payload);

    private static Outcome Err(string reason) => new(false, "err " + reason);

    // Resolve the live AppShell + store lazily so a persistent QA player tracks connect/disconnect cycles.
    private AppShell? Shell() => GetTree()?.CurrentScene as AppShell;

    private MirrorStore? Store() => Shell()?.CurrentStore;

    private static bool TryEffectMode(string v, out EffectMode mode) =>
        Enum.TryParse(v, true, out mode) && Enum.IsDefined(typeof(EffectMode), mode);

    private static bool TryOnOff(string v, out bool on)
    {
        switch (v.ToLowerInvariant())
        {
            case "on":
            case "true":
            case "1":
                on = true;
                return true;
            case "off":
            case "false":
            case "0":
                on = false;
                return true;
            default:
                on = false;
                return false;
        }
    }

    private static double ParseD(string[] p, int i) =>
        i < p.Length && double.TryParse(p[i], NumberStyles.Any, CultureInfo.InvariantCulture, out var v) ? v : 0;

    private static string? ReadText(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                return File.ReadAllText(path);
            }
        }
        catch (IOException)
        {
            // fall through to Godot FileAccess (res:// / user://)
        }

        if (Godot.FileAccess.FileExists(path))
        {
            using var f = Godot.FileAccess.Open(path, Godot.FileAccess.ModeFlags.Read);
            return f?.GetAsText();
        }

        return null;
    }

    private static bool EffectivelyVisible(MirrorState state, MirrorNode node)
    {
        var cur = node;
        while (cur is not null)
        {
            if (!cur.Visible)
            {
                return false;
            }

            cur = cur.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var parent) ? parent : null;
        }

        return true;
    }

    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }
}
