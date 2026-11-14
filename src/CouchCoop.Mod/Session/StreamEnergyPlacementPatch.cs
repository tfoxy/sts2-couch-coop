using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Combat;
using MegaCrit.Sts2.Core.Nodes.Rooms;

namespace CouchCoop.Mod.Session;

/// <summary>Spread the energy counter's shared origin only while a wide stream owns the seat.</summary>
internal static class StreamEnergyPlacementPatch
{
    private static bool _applied;
    private static readonly Placement<Control> Counter = new(
        node => GodotObject.IsInstanceValid(node) && !node.IsQueuedForDeletion(),
        node => node.Position.X,
        (node, x) => node.Position = new Vector2(x, node.Position.Y));

    internal static MethodInfo? Resolve()
        => typeof(NCombatUi).GetMethod(nameof(NCombatUi._Ready),
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly, Type.EmptyTypes);

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        try
        {
            var target = Resolve() ?? throw new MissingMethodException(typeof(NCombatUi).FullName, nameof(NCombatUi._Ready));
            new Harmony("com.couchcoop.stream-energy-placement").Patch(target,
                postfix: new HarmonyMethod(typeof(StreamEnergyPlacementPatch), nameof(AfterReady)));
        }
        catch (Exception exception)
        {
            CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamEnergyPlacementPatch),
                $"{exception.GetType().Name}: {exception.Message}", costsCoop: false);
        }
    }

    // Ownership transitions run on the main thread, before capture or mirror work resumes.
    internal static void SetWidth(int width)
    {
        Counter.SetWidth(width);
        if (Counter.Wide && NCombatRoom.Instance is { } room && GodotObject.IsInstanceValid(room)
            && !room.IsQueuedForDeletion()) Register(room.Ui);
    }

    private static void AfterReady(NCombatUi __instance)
    {
        if (!Counter.Wide) return;
        if (Engine.GetMainLoop() is SceneTree tree)
            tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(() => Register(__instance)),
                (uint)GodotObject.ConnectFlags.OneShot);
    }

    private static void Register(NCombatUi? ui)
    {
        if (!Counter.Wide || ui is null || !GodotObject.IsInstanceValid(ui) || ui.IsQueuedForDeletion()) return;
        if (ui.EnergyCounterContainer is { } container) Counter.Register(container);
    }

    internal static float Spread(float x, int width)
        => width > 1920 ? x + Math.Clamp(x, 0, 1920) * (width / 1920f - 1) : x;

    internal sealed class Placement<T>(Func<T, bool> valid, Func<T, float> read, Action<T, float> write)
        where T : class
    {
        private readonly Dictionary<T, float> _saved = new();
        private int _width = 1920;
        internal bool Wide => _width > 1920;

        internal void SetWidth(int width)
        {
            width = Math.Max(1920, width);
            if (_width == width) return;
            _width = width;
            foreach (var (node, x) in _saved.ToArray())
                if (valid(node)) write(node, Spread(x, _width));
                else _saved.Remove(node);
            if (!Wide) _saved.Clear();
        }

        internal void Register(T node)
        {
            if (!Wide || !valid(node)) return;
            foreach (var stale in _saved.Keys.Where(node => !valid(node)).ToArray()) _saved.Remove(stale);
            if (_saved.ContainsKey(node)) return;
            var x = read(node);
            _saved.Add(node, x);
            write(node, Spread(x, _width));
        }
    }
}
