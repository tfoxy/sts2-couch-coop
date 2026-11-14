using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes.Combat;

namespace CouchCoop.Mod.Session;

/// <summary>Keep animated combat buttons at their design placement plus the wide presentation's anchor spread.</summary>
internal static class StreamDesignPlacementPatch
{
    private static bool _applied;

    internal readonly record struct Binding(Type Type, string Property);

    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(typeof(NEndTurnButton), "ShowPos"),
        new(typeof(NEndTurnButton), "HidePos"),
        new(typeof(NPingButton), "ShowPos"),
        new(typeof(NPingButton), "HidePos"),
    ];

    internal static MethodInfo? Resolve(Binding binding)
        => binding.Type.GetProperty(binding.Property,
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)?.GetGetMethod(true);

    // Installed only on capture seats, before their first room; presentation ownership gates every invocation.
    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        var harmony = new Harmony("com.couchcoop.stream-design-placement");
        foreach (var binding in Bindings)
        {
            try
            {
                var target = Resolve(binding) ?? throw new MissingMethodException(binding.Type.FullName, binding.Property);
                harmony.Patch(target, postfix: new HarmonyMethod(typeof(StreamDesignPlacementPatch), nameof(AfterPlacement)));
            }
            catch (Exception exception)
            {
                CouchCoopPatchDiagnostics.PatchFailed(nameof(StreamDesignPlacementPatch),
                    $"{binding.Type.Name}.{binding.Property}: {exception.GetType().Name}: {exception.Message}",
                    costsCoop: false);
            }
        }
    }

    private static void AfterPlacement(Control __instance, ref Vector2 __result)
    {
        if (HeadlessViewportConfigurator.StreamOwnsPresentation)
            __result = HeadlessViewportConfigurator.ResolveStreamPlacement(__result, __instance.AnchorLeft);
    }
}
