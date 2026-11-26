using System.Reflection;
using System.Reflection.Emit;
using CouchCoop.Mod;
using CouchCoop.Mod.Audio.Host;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Runtime;
using HarmonyLib;

internal static class CouchCoopFeatureCompatibilityTests
{
    public static void Run()
    {
        SuccessfulFeaturesStayEnabled();
        CompatibilityExceptionsDoNotBlockThePanel();
        StaticInitializationFailuresAreContained();
        DiagnosticsCannotStopLaterFeatures();
        DisabledFeaturesAreRecordedOnce();
        SummaryIncludesCompatibilityContext();
        InitUsesGuardedDelegateBoundaries();
        AudioTargetsFailIndependently();
        AudioTargetsKeepTheirJitBoundaries();
        Console.WriteLine("CouchCoopFeatureCompatibilityTests: 9 cases passed (8 audio target combinations)");
    }

    private static void SuccessfulFeaturesStayEnabled()
    {
        var lines = new List<string>();
        var compatibility = new CouchCoopFeatureCompatibility(lines.Add);
        var ran = false;
        Expect(compatibility.TryFeature("working", () => ran = true) && ran, "successful feature executes");
        Expect(lines.Count == 0 && compatibility.Summary("v0.114.0", "flat", false).EndsWith("disabled=[]"),
            "success neither logs a failure nor disables a feature");
    }

    private static void CompatibilityExceptionsDoNotBlockThePanel()
    {
        Exception[] failures =
        [
            new TypeInitializationException("optional", new MissingMethodException("changed")),
            new MissingMethodException("changed"),
            new MissingFieldException("changed"),
            new TypeLoadException("changed"),
            new InvalidOperationException("changed"),
        ];
        foreach (var failure in failures)
        {
            var lines = new List<string>();
            var compatibility = new CouchCoopFeatureCompatibility(lines.Add);
            Expect(!compatibility.TryFeature("optional", () => throw failure), "failure returns false");
            var button = false;
            var layout = false;
            Expect(compatibility.TryFeature("qr-host-panel", () => CouchCoopHostPanelSetup.Install(
                () => button = true, () => layout = button, () => { }, () => { }, () => { }, () => { })),
                "later panel setup is attempted");
            Expect(button && layout, "an unrelated compatibility failure leaves the button and layout available");
            Expect(lines.SequenceEqual(new[] { $"feature-disabled name=optional reason={failure.GetType().Name}: {failure.Message}" }),
                "failure names the feature and exception in one log line");
        }
    }

    private static void StaticInitializationFailuresAreContained()
    {
        var lines = new List<string>();
        var compatibility = new CouchCoopFeatureCompatibility(lines.Add);
        Expect(!compatibility.TryFeature("static-bindings", () => BrokenBindings.Apply()),
            "a real static initializer failure stays inside the guard");
        Expect(lines.Single().Contains("TypeInitializationException"), "the initialization exception is identified");
        Expect(compatibility.TryFeature("later", () => { }), "later features still run after type poisoning");
    }

    private static class BrokenBindings
    {
        static BrokenBindings() => throw new MissingFieldException("synthetic optional binding");
        internal static void Apply() { }
    }

    private static void DiagnosticsCannotStopLaterFeatures()
    {
        var compatibility = new CouchCoopFeatureCompatibility(_ => throw new IOException("sink unavailable"));
        Expect(!compatibility.TryFeature("broken", () => throw new TypeLoadException()), "a broken logger is contained");
        compatibility.ReportSummary("v0.114.0", "flat", true);
        Expect(compatibility.TryFeature("later", () => { }), "a broken logger cannot stop later features");
    }

    private static void DisabledFeaturesAreRecordedOnce()
    {
        var lines = new List<string>();
        var compatibility = new CouchCoopFeatureCompatibility(lines.Add);
        compatibility.TryFeature("retry", () => throw new MissingMethodException());
        compatibility.TryFeature("retry", () => throw new MissingFieldException());
        compatibility.DisableFeature("partial-targets", "a target could not be installed");
        Expect(lines.Count == 2, "retries do not repeat failure diagnostics");
        Expect(compatibility.Summary("v0.114.0", "flat", true).EndsWith("disabled=[retry,partial-targets]"),
            "exceptions and internally reported partial failures share the summary");
    }

    private static void SummaryIncludesCompatibilityContext()
    {
        var lines = new List<string>();
        var compatibility = new CouchCoopFeatureCompatibility(lines.Add);
        compatibility.ReportSummary("v0.114.0", "0.113.0", true);
        Expect(lines.Single() == "compat-summary game=v0.114.0 payload=0.113.0 untested=true disabled=[]",
            "lane and untested context are explicit");
        Expect(compatibility.Summary(null, "flat", false) ==
            "compat-summary game=<undetected> payload=flat untested=false disabled=[]", "flat and unknown game context");
        Expect(compatibility.Summary("", "flat", false) ==
            "compat-summary game=<undetected> payload=flat untested=false disabled=[]", "empty game version reads as undetected");
    }

    private static void InitUsesGuardedDelegateBoundaries()
    {
        var init = typeof(CouchCoopMod).GetMethod(nameof(CouchCoopMod.Init))!;
        var calls = PatchProcessor.GetOriginalInstructions(init)
            .Where(instruction => instruction.opcode == OpCodes.Call || instruction.opcode == OpCodes.Callvirt)
            .Select(instruction => instruction.operand)
            .OfType<MethodInfo>().ToArray();
        Expect(calls.Any(method => method.Name == "TryFeature"), "Init uses the tested feature guard");
        Expect(!calls.Any(method => method.Name == "Apply" &&
            (method.DeclaringType?.Name.EndsWith("Patch", StringComparison.Ordinal) == true || method.DeclaringType == typeof(HostAudioHooks))),
            "patch calls execute in delegates, keeping target JIT and static initialization inside the guard");
        Expect(!calls.Any(method => method.Name is "StartHostUiServices" or "InitializeQrHostPanel"),
            "host services and the panel execute in independent delegates");
        Expect(calls.Any(method => method.Name == "ReportCompatibility"), "Init emits its final summary");
    }

    private static void AudioTargetsFailIndependently()
    {
        for (var failures = 0; failures < 8; failures++)
        {
            var compatibility = new CouchCoopFeatureCompatibility(_ => { });
            var attempted = new List<int>();
            void Target(int bit)
            {
                attempted.Add(bit);
                if ((failures & bit) != 0) throw new MissingMethodException("synthetic audio target");
            }
            var available = HostAudioHookSetup.Install(compatibility.TryFeature,
                () => Target(1), () => Target(2), () => Target(4));
            Expect(attempted.SequenceEqual(new[] { 1, 2, 4 }), "each audio target is attempted after earlier failures");
            Expect(available == ((failures & 4) == 0 && (failures & 3) != 3),
                "one surviving stream remains usable when shared marshalling works");
        }
    }

    private static void AudioTargetsKeepTheirJitBoundaries()
    {
        foreach (var name in new[] { "InstallAudioHook", "InstallMusicHook", "InstallMarshallingHook" })
            Expect(typeof(HostAudioHooks).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static)!
                    .GetMethodImplementationFlags().HasFlag(MethodImplAttributes.NoInlining),
                "optional audio targets have separate JIT boundaries");
        var apply = typeof(HostAudioHooks).GetMethod("Apply", BindingFlags.NonPublic | BindingFlags.Static)!;
        Expect(PatchProcessor.GetOriginalInstructions(apply).Any(instruction =>
            instruction.operand is MethodInfo { DeclaringType: { } type } && type == typeof(HostAudioHookSetup)),
            "the live audio setup uses the tested per-target installer");
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"[CouchCoopFeatureCompatibilityTests] FAILED: {label}");
    }
}
