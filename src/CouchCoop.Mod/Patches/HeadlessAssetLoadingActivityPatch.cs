using System;
using System.Reflection;
using System.Threading.Tasks;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Assets;
using MegaCrit.Sts2.Core.Nodes;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Keeps a headless instance at its normal frame rate while an asset load is pending. Installed only by the
/// headless FPS saver; windowed hosts and their browser-selected visual freezes keep their current behavior.
/// </summary>
internal static class HeadlessAssetLoadingActivityPatch
{
    private static readonly object Sync = new();
    private static bool _applied;

    internal static MethodInfo? ResolveTarget()
        => typeof(NAssetLoader).GetMethod(
            nameof(NAssetLoader.LoadInTheBackground),
            BindingFlags.Public | BindingFlags.Instance,
            binder: null,
            types: [typeof(AssetLoadingSession)],
            modifiers: null);

    internal static void Apply()
    {
        lock (Sync)
        {
            if (_applied) return;
            _applied = true;
            try
            {
                var target = ResolveTarget();
                if (target is null || !typeof(Task).IsAssignableFrom(target.ReturnType))
                    throw new MissingMethodException(nameof(NAssetLoader), nameof(NAssetLoader.LoadInTheBackground));

                var postfix = typeof(HeadlessAssetLoadingActivityPatch).GetMethod(
                    nameof(AfterLoadQueued), BindingFlags.NonPublic | BindingFlags.Static)!;
                var harmony = new Harmony("com.couchcoop.headless-asset-loading-activity");
                harmony.Patch(target, postfix: new HarmonyMethod(postfix));

                CouchCoopLog.Stderr("headless asset loading: idle FPS throttle waits for pending loads");
            }
            catch (Exception ex)
            {
                CouchCoopPatchDiagnostics.PatchFailed(
                    nameof(HeadlessAssetLoadingActivityPatch),
                    $"asset-load activity hook unavailable ({ex.GetType().Name}: {ex.Message}).",
                    costsCoop: false);
            }
        }
    }

    private static void AfterLoadQueued(Task __result)
    {
        try
        {
            CouchCoopHeadlessVisualSuspender.TrackAssetLoading(__result);
        }
        catch (Exception ex)
        {
            // An optional CPU-saving policy must never change an asset load's outcome.
            CouchCoopLog.Stderr($"headless asset loading: activity tracking failed ({ex.GetType().Name})");
        }
    }
}
