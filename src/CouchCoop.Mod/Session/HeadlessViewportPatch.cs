using System.Reflection;
using CouchCoop.Mod.Patches;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;

namespace CouchCoop.Mod.Session;

/// <summary>Restore windowless mirror presentation after display changes and screen mounts.</summary>
internal static class HeadlessViewportPatch
{
    private static bool _applied;

    internal readonly record struct Binding(Type Type, string Method, string Postfix);

    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(typeof(NGame), nameof(NGame.ApplyDisplaySettings), nameof(AfterPresentationChanged)),
        new(typeof(NMainMenu), nameof(NMainMenu._Ready), nameof(AfterPresentationChanged)),
        new(typeof(NGame), nameof(NGame._Ready), nameof(AfterGameReady)),
    ];

    internal static MethodInfo? Resolve(Binding binding)
        => binding.Type.GetMethod(binding.Method,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly, Type.EmptyTypes);

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        var harmony = new Harmony("com.couchcoop.headless-viewport");
        foreach (var binding in Bindings)
        {
            try
            {
                var target = Resolve(binding) ?? throw new MissingMethodException(binding.Type.FullName, binding.Method);
                harmony.Patch(target, postfix: new HarmonyMethod(typeof(HeadlessViewportPatch), binding.Postfix));
            }
            catch (Exception exception)
            {
                CouchCoopPatchDiagnostics.PatchFailed(nameof(HeadlessViewportPatch),
                    $"{binding.Type.Name}.{binding.Method}: {exception.GetType().Name}: {exception.Message}",
                    costsCoop: false);
            }
        }
    }

    internal static void AfterPresentationChanged() => HeadlessViewportConfigurator.Updates.Request();
    internal static void AfterGameReady() => HeadlessViewportConfigurator.Updates.Startup();
}
