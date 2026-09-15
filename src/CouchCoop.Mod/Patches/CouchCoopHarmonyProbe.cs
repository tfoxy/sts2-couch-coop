using System.Reflection;
using System.Runtime.CompilerServices;
using HarmonyLib;

namespace CouchCoop.Mod.Patches;

/// <summary>
/// Applies one throwaway Harmony patch to a method of OUR OWN and reports whether it took effect — the cheapest
/// honest answer to "can this process be patched at all", asked BEFORE the patches that matter are attempted.
/// </summary>
/// <remarks>
/// <para>
/// It exists for macOS. Harmony's detours go through MonoMod, whose backend writes a native exec-helper into a
/// temp directory and <c>dlopen</c>s it on the FIRST patch of the process. On Linux that dlopen fails unless
/// libgcc's unwinder is already in the global symbol namespace (<c>Sts2MonoModNativeDependencies</c> handles
/// that, and is proven in production). On macOS the same first-patch load is what the hardened runtime gets to
/// veto — an ad-hoc-signed library loaded from a temp path by a signed, Steam-launched app is exactly the shape
/// a codesigning policy refuses. If it is refused, EVERY patch in <c>Init</c> dies, which costs the lobby QR
/// button and all seat joining: "the mod doesn't work on macOS", with no evidence anywhere.
/// </para>
/// <para>
/// The target is ours and trivial by rule — never a game method. Patching a game method to find out whether
/// patching works would both reach into the game's own code and leave a detour on it if the undo failed.
/// </para>
/// </remarks>
internal static class CouchCoopHarmonyProbe
{
    private const string HarmonyId = "com.couchcoop.patch-probe";

    /// <summary>
    /// The throwaway target. <see cref="MethodImplOptions.NoInlining"/> is load-bearing: an inlined call site
    /// cannot observe a detour, and the probe would report a failure that did not happen.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static bool ProbeTarget() => false;

    /// <summary>Harmony postfix on <see cref="ProbeTarget"/>: flips the result, which is the observable effect.</summary>
    private static void ProbePostfix(ref bool __result) => __result = true;

    /// <summary>Apply, observe, and undo a trial patch. Never throws.</summary>
    internal static CouchCoopHarmonyProbeResult Run() => Run(ApplyObserveAndUndo);

    /// <param name="apply">
    /// The seam the suite drives: returns whether the trial detour took effect, or throws the way a refused
    /// native load does. The production argument is <see cref="ApplyObserveAndUndo"/>.
    /// </param>
    internal static CouchCoopHarmonyProbeResult Run(Func<bool> apply)
    {
        try
        {
            return apply()
                ? new CouchCoopHarmonyProbeResult(true, null)
                : new CouchCoopHarmonyProbeResult(false, "the trial patch applied but did not take effect");
        }
        catch (Exception exception)
        {
            return new CouchCoopHarmonyProbeResult(false, $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private static bool ApplyObserveAndUndo()
    {
        var harmony = new Harmony(HarmonyId);
        try
        {
            const BindingFlags Own = BindingFlags.NonPublic | BindingFlags.Static;
            var target = typeof(CouchCoopHarmonyProbe).GetMethod(nameof(ProbeTarget), Own)
                ?? throw new MissingMethodException(nameof(CouchCoopHarmonyProbe), nameof(ProbeTarget));
            var postfix = typeof(CouchCoopHarmonyProbe).GetMethod(nameof(ProbePostfix), Own)
                ?? throw new MissingMethodException(nameof(CouchCoopHarmonyProbe), nameof(ProbePostfix));
            harmony.Patch(target, postfix: new HarmonyMethod(postfix));
            return ProbeTarget();
        }
        finally
        {
            // Undo immediately and unconditionally. The probe must leave no detour behind it, and a failed
            // unpatch of a patch that never applied must not become the reported failure.
            try
            {
                harmony.UnpatchAll(HarmonyId);
            }
            catch
            {
                // Nothing to report: the probe's answer is about applying, not about cleaning up.
            }
        }
    }
}

/// <param name="Succeeded">Whether a trial detour of our own method applied AND took effect.</param>
/// <param name="Error">Why not — the exception type and message when it threw.</param>
internal readonly record struct CouchCoopHarmonyProbeResult(bool Succeeded, string? Error);
