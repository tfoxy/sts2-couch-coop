using System.Reflection;
using CouchCoop.Mod.Patches;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Nodes;
using MegaCrit.Sts2.Core.Nodes.CommonUi;
using MegaCrit.Sts2.Core.Nodes.Screens.MainMenu;

namespace CouchCoop.Mod.Session;

/// <summary>Reassert owned stream or windowless mirror presentation after display changes and screen mounts.</summary>
internal static class HeadlessViewportPatch
{
    private static bool _applied;

    internal readonly record struct Binding(Type Type, string Method, string Postfix);

    internal static IReadOnlyList<Binding> Bindings { get; } =
    [
        new(typeof(NGame), nameof(NGame.ApplyDisplaySettings), nameof(AfterDisplaySettingsApplied)),
        new(typeof(NMainMenu), nameof(NMainMenu._Ready), nameof(AfterPresentationChanged)),
        new(typeof(NGame), nameof(NGame._Ready), nameof(AfterGameReady)),
    ];

    internal readonly record struct AutoBinding(Type Type, string Method, Type[] Parameters, string Prefix);

    internal static IReadOnlyList<AutoBinding> AutoBindings { get; } =
    [
        new(typeof(NGlobalUi), "OnWindowChange", Type.EmptyTypes, nameof(BeforeRunWindowChanged)),
        new(typeof(NMainMenu), "OnWindowChange", [typeof(bool)], nameof(BeforeMenuWindowChanged)),
    ];

    internal static bool AutoHandlersPatched { get; private set; }

    internal static MethodInfo? Resolve(AutoBinding binding)
        => binding.Type.GetMethod(binding.Method,
            BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly, binding.Parameters);

    internal static MethodInfo? Resolve(Binding binding)
        => binding.Type.GetMethod(binding.Method,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly, Type.EmptyTypes);

    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        var harmony = new Harmony("com.couchcoop.headless-viewport");
        if (HeadlessViewportConfigurator.WindowedHostPresentation)
        {
            AutoHandlersPatched = true;
            foreach (var binding in AutoBindings)
            {
                try
                {
                    var target = Resolve(binding) ?? throw new MissingMethodException(binding.Type.FullName, binding.Method);
                    harmony.Patch(target, prefix: new HarmonyMethod(typeof(HeadlessViewportPatch), binding.Prefix));
                }
                catch (Exception exception)
                {
                    AutoHandlersPatched = false;
                    CouchCoopPatchDiagnostics.PatchFailed(nameof(HeadlessViewportPatch),
                        $"{binding.Type.Name}.{binding.Method}: {exception.GetType().Name}: {exception.Message}",
                        costsCoop: false);
                }
            }
        }
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

    private static bool BeforeRunWindowChanged(NGlobalUi __instance, MethodBase __originalMethod)
        => BeforeAutoWindowChanged(Refit(__instance, __originalMethod, menu: false));

    private static bool BeforeMenuWindowChanged(NMainMenu __instance, MethodBase __originalMethod)
        => BeforeAutoWindowChanged(Refit(__instance, __originalMethod, menu: true));

    internal static bool BeforeAutoWindowChanged(Action refit)
        => HeadlessViewportConfigurator.Updates.BeforeAutoWindowChanged(refit);

    private static Action Refit(Node instance, MethodBase method, bool menu)
    {
        var weak = new WeakReference<Node>(instance);
        return () =>
        {
            if (!weak.TryGetTarget(out var node) || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree()) return;
            try { method.Invoke(node, menu ? [HeadlessViewportConfigurator.UsesAutoAspect()] : null); }
            catch (Exception exception)
            {
                CouchCoopLog.Stderr($"windowed presentation refit failed: {exception.GetType().Name}: {exception.Message}");
            }
        };
    }

    internal static void AfterPresentationChanged() => HeadlessViewportConfigurator.Updates.Request();
    internal static void AfterDisplaySettingsApplied() => HeadlessViewportConfigurator.Updates.Request(adoptDisplaySettings: true);
    internal static void AfterWindowSizeChanged() => HeadlessViewportConfigurator.Updates.WindowSizeChanged();
    internal static void AfterGameReady() => HeadlessViewportConfigurator.Updates.Startup();
}
