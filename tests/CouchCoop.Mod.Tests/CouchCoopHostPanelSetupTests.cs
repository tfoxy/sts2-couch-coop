using System.Reflection;
using CouchCoop.Mod.HostUi;

// The production install sequence is exercised without constructing Godot nodes, which need a live engine.
internal static class CouchCoopHostPanelSetupTests
{
    public static void Run()
    {
        MissingHotkeysKeepTheButton();
        ThrowingExtrasKeepTheButtonAndLaterExtras();
        OptionalGameCallsHaveAJitBoundary();
        PanelAndModalUseTheGuards();
        Console.WriteLine("CouchCoopHostPanelSetupTests: 4 cases passed");
    }

    private static void MissingHotkeysKeepTheButton()
    {
        var installed = false;
        var laidOut = false;
        var logs = new List<string>();
        var hotkeys = new CouchCoopGameHotkeys(() => null, logs.Add);
        CouchCoopHostPanelSetup.Install(() => installed = true, () => laidOut = installed,
            () => { }, () => { }, () => { }, () =>
            {
                Expect(installed && laidOut, "the button is ready before the hotkey adapter runs");
                Expect(!hotkeys.TryPush("test", null!, () => { }), "the hotkey adapter fails");
            });
        Expect(installed && laidOut && logs.Count == 1, "a failed adapter leaves the button installed and laid out");
    }

    private static void ThrowingExtrasKeepTheButtonAndLaterExtras()
    {
        var steps = new List<string>();
        CouchCoopHostPanelSetup.Install(() => steps.Add("button"), () => steps.Add("layout"),
            () => throw new TypeInitializationException("hint", new MissingFieldException()),
            () => steps.Add("dialog"),
            () => throw new TypeLoadException("alert"),
            () => throw new MissingMethodException("hotkey"));
        Expect(steps.SequenceEqual(new[] { "button", "layout", "dialog" }),
            "the core finishes first and each optional failure is isolated");
    }

    private static void OptionalGameCallsHaveAJitBoundary()
    {
        foreach (var name in new[] { "InstallHint", "InstallDialog", "InstallAlert", "BindHotkey", "UnbindHotkey" })
            ExpectNoInlining(typeof(CouchCoopQrHostPanel), name);
        foreach (var name in new[] { "BindCancel", "ReassertCancelBinding", "UnbindCancel" })
            ExpectNoInlining(typeof(CouchCoopModalDialog), name);
    }

    private static void ExpectNoInlining(Type type, string name)
        => Expect(type.GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetMethodImplementationFlags().HasFlag(MethodImplAttributes.NoInlining),
            $"{type.Name}.{name} keeps optional game calls out of its guarded caller's JIT compilation");

    private static void PanelAndModalUseTheGuards()
    {
        var install = typeof(CouchCoopHostPanelSetup).GetMethod("Install", BindingFlags.Static | BindingFlags.NonPublic)!;
        Expect(Calls(typeof(CouchCoopQrHostPanel).GetMethod("Install")!, install), "the real panel uses the tested install sequence");
        var guard = typeof(CouchCoopModalDialog).GetMethod("TryHotkeys", BindingFlags.Instance | BindingFlags.NonPublic)!;
        foreach (var name in new[] { "OpenModal", "Close", "ReassertWhileOpen", "OnTreeExiting" })
        {
            var method = typeof(CouchCoopModalDialog).GetMethod(name,
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
            Expect(Calls(method, guard), $"{name} guards hotkey work outside its JIT boundary");
        }
    }

    private static bool Calls(MethodInfo caller, MethodInfo target)
    {
        var il = caller.GetMethodBody()!.GetILAsByteArray()!;
        for (var i = 0; i + 4 < il.Length; i++)
        {
            if (il[i] is not (0x28 or 0x6F)) continue;
            try
            {
                if (caller.Module.ResolveMethod(BitConverter.ToInt32(il, i + 1)) is MethodInfo resolved
                    && resolved.Module == target.Module && resolved.MetadataToken == target.MetadataToken)
                    return true;
            }
            catch (ArgumentException) { } // An opcode-shaped operand byte is not a method token.
        }
        return false;
    }

    private static void Expect(bool condition, string label)
    {
        if (!condition) throw new Exception($"[CouchCoopHostPanelSetupTests] FAILED: {label}");
    }
}
