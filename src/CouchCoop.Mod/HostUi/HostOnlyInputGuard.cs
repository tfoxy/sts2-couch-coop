using CouchCoop.Mod.Protocol;
using Godot;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Saves;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.HostUi;

/// <summary>Game-thread admission for input that could reach the game machine's CouchCoop controls.</summary>
public static class HostOnlyInputGuard
{
    private static readonly HostOnlyInputRegistry<Control> Controls = new();

    /// <summary>The registration never keeps the control alive; disposing removes it immediately.</summary>
    public static IDisposable Register(Control control) => Controls.Register(control);

    internal static IDisposable RegisterHotkey(Control control, string action) => Controls.Register(control, action);

    internal static IDisposable OpenModal() => Controls.OpenModal(CouchCoopMod.CancelInjectedInput);

    /// <summary>Called after target placement and before any browser input is injected.</summary>
    public static bool Refuses(string kind, double? coordX, double? coordY, string? elementId, string? key, string? input)
        => Refuses(new HostOnlyInput(kind, coordX, coordY, elementId, key, input));

    private readonly record struct HostOnlyInput(string Kind, double? CoordX, double? CoordY,
        string? ElementId, string? Key, string? Input);

    private static bool Refuses(HostOnlyInput request)
        => Controls.Refuses(
            control => ReachesControl(control, request),
            (control, action) => GodotObject.IsInstanceValid(control) && control.IsInsideTree() && MatchesHotkey(request, action));

    private static bool ReachesControl(Control control, HostOnlyInput request)
    {
        if (!GodotObject.IsInstanceValid(control)) return false;
        if (request.Kind is BrowserInputKinds.Hover or BrowserInputKinds.Click)
        {
            var visible = control.IsVisibleInTree();
            return ReachesControl(new HostOnlyControlState(visible, visible ? control.GetGlobalRect() : default, false),
                request.Kind, request.CoordX, request.CoordY, request.ElementId);
        }

        if (request.Kind is not (BrowserInputKinds.Key or BrowserInputKinds.Pad)) return false;
        var focus = control.GetViewport()?.GuiGetFocusOwner();
        return ReachesControl(new HostOnlyControlState(false, default,
                focus is not null && (focus == control || control.IsAncestorOf(focus))), request.Kind);
    }

    internal readonly record struct HostOnlyControlState(bool Visible, Rect2 Rect, bool FocusWithin);

    internal static bool ReachesControl(HostOnlyControlState control, string kind,
        double? coordX = null, double? coordY = null, string? elementId = null)
        => kind switch
        {
            BrowserInputKinds.Hover or BrowserInputKinds.Click => control.Visible
                && ReachesPointer(control.Rect, coordX, coordY, elementId),
            BrowserInputKinds.Key or BrowserInputKinds.Pad => control.FocusWithin,
            _ => false,
        };

    internal static bool ReachesPointer(Rect2 rect, double? coordX, double? coordY, string? elementId = null)
    {
        // Browser pointers use placed design coordinates. Refuse legacy element addressing and
        // missing coordinates here: neither supplies the final point this guard can authorize.
        if (!string.IsNullOrWhiteSpace(elementId)
            || coordX is not { } x || coordY is not { } y
            || !double.IsFinite(x) || !double.IsFinite(y)) return true;
        return rect.HasPoint(new Vector2((float)Math.Round(x), (float)Math.Round(y)));
    }

    private static bool MatchesHotkey(HostOnlyInput request, string action)
    {
        if (request.Kind == BrowserInputKinds.Key)
        {
            if (NInputManager.Instance is not { } inputs) return true;
#if STS2_API_V111_OR_LATER
            return MatchesKey(request.Key, inputs.GetMKbHotkey(action), inputs.GetKbOnlyHotkey(action));
#else
            return MatchesKey(request.Key, inputs.GetShortcutKey(action), Key.None);
#endif
        }

        if (request.Kind != BrowserInputKinds.Pad) return false;
        if (NControllerManager.Instance is not { } controllers) return true;
        var bindings = controllers.GetDefaultControllerInputMap;
        bindings.TryGetValue(action, out var bound);
        var settings = SaveManager.Instance.SettingsSave;
        if (settings.ControllerMappingType == controllers.ControllerMappingType
            && settings.ControllerMapping.TryGetValue(action, out var saved) && InputMap.HasAction(saved))
            bound = saved;
        return MatchesPad(request.Input, bound, candidate => InputMap.HasAction(candidate));
    }

    internal static bool MatchesKey(string? code, Key keyboard, Key keyboardOnly)
        => Sts2BrowserKeyMap.TryMap(code, out var key) && (key == keyboard || key == keyboardOnly);

    internal static bool MatchesPad(string? token, string? binding, Func<string, bool> hasAction)
        => Sts2BrowserPadMap.TryMapCandidates(token, out var candidates)
            && candidates.FirstOrDefault(hasAction) is { } input && input == binding;
}

// Engine-free lifetime and admission rules. Entries and modal leases are owned by native tree-exit signals.
internal sealed class HostOnlyInputRegistry<T> where T : class
{
    private sealed record Entry(WeakReference<T> Control, string? Hotkey);
    private readonly List<Entry> _entries = [];
    private int _openModals;

    internal IDisposable Register(T control, string? hotkey = null)
    {
        ArgumentNullException.ThrowIfNull(control);
        var entry = new Entry(new WeakReference<T>(control), hotkey);
        _entries.Add(entry);
        return new Lease(() => _entries.Remove(entry));
    }

    internal IDisposable OpenModal(Action? cancelInjectedInput = null)
    {
        _openModals++;
        var lease = new Lease(() => _openModals--);
        try { cancelInjectedInput?.Invoke(); }
        catch { lease.Dispose(); throw; }
        return lease;
    }

    internal bool Refuses(Func<T, bool> reachesControl, Func<T, string, bool> matchesHotkey)
    {
        if (_openModals > 0) return true;
        _entries.RemoveAll(entry => !entry.Control.TryGetTarget(out _));
        foreach (var entry in _entries)
        {
            if (entry.Control.TryGetTarget(out var control)
                && (entry.Hotkey is { } action ? matchesHotkey(control, action) : reachesControl(control))) return true;
        }
        return false;
    }

    private sealed class Lease(Action release) : IDisposable
    {
        private Action? _release = release;
        public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
    }
}
