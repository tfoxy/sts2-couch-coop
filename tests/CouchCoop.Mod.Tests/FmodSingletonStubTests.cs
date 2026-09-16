using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

// The rules that decide whether a headless seat survives a third-party mod's FMOD call.
//
// FmodSingletonStub re-points the `FmodServer` engine singleton at a runtime-compiled GDScript stub before
// HeadlessFmodShutdown releases the native system, so a mod's per-call lookup gets null instead of freed native
// memory. ALL of that hinges on the generated GDScript actually COMPILING: if `Reload()` fails, the swap
// degrades to rung 2 (unregister-only) and the stub never exists. The compile itself only happens inside a game
// process, so what is testable here — and what this suite pins — is the source generation: every rule below is
// something that would have made the script fail to compile, or made the stub answer a call it should have
// answered.
//
// Registered near the TOP of the runner sequence on purpose: the full sequence takes the process down with
// SIGSEGV inside HeadlessAudioMuteTargetsTests on some machines (pre-existing, unrelated), and anything
// registered after that point silently never runs. Also reachable alone as `-- fmod-stub`.
internal static class FmodSingletonStubTests
{
    public static void Run()
    {
        EveryFmodMethodBecomesANoOpFunc();
        ArgumentsAreDeclaredOptionalSoAShorterCallStillLands();
        MethodsTheBaseClassAlreadyHasAreNeverRedeclared();
        NamesThatCannotBeDeclaredAreDropped();
        DuplicateNamesCollapseToTheWidestSignature();
        AbsurdArgCountsAreClamped();
        AnEmptyMethodListStillProducesAValidStub();
        Console.WriteLine("FmodSingletonStubTests: ok");
    }

    // The shape Downfall's helper needs: it calls `load_bank(path, 0)` behind has_singleton / is_instance_valid /
    // has_method guards. All three keep passing after the swap; this is the part that makes the CALL harmless.
    private static void EveryFmodMethodBecomesANoOpFunc()
    {
        var source = FmodSingletonStub.BuildScriptSource([("load_bank", 2), ("shutdown", 0)]);

        Expect(source.StartsWith("extends RefCounted\n", StringComparison.Ordinal),
            "the stub extends RefCounted, so the reference we retain owns its lifetime");
        Expect(source.Contains("func load_bank(a0 = null, a1 = null):\n\treturn null\n", StringComparison.Ordinal),
            "a two-arg FMOD method is declared with two optional args and returns null");
        Expect(source.Contains("func shutdown():\n\treturn null\n", StringComparison.Ordinal),
            "a zero-arg FMOD method is declared with no args at all");
    }

    // A caller that passes FEWER args than the real signature took must still land on the stub. `= null` on every
    // parameter is what buys that; a required parameter would make the call error instead of returning null.
    private static void ArgumentsAreDeclaredOptionalSoAShorterCallStillLands()
    {
        var source = FmodSingletonStub.BuildScriptSource([("play_one_shot", 3)]);

        Expect(source.Contains("func play_one_shot(a0 = null, a1 = null, a2 = null):", StringComparison.Ordinal),
            "every declared parameter carries a default, so any arity up to the real one resolves");
        Expect(!source.Contains("a3", StringComparison.Ordinal),
            "and no parameter beyond the real signature is invented");
    }

    // THE ONE THAT COSTS THE MOST IF IT REGRESSES. GetMethodList() on the singleton returns Object's own members
    // alongside FMOD's; redeclaring any of them is a GDScript compile error ("already defined in base class"),
    // which fails the WHOLE script — so one unfiltered `free` would silently cost every method its stub.
    private static void MethodsTheBaseClassAlreadyHasAreNeverRedeclared()
    {
        string[] inherited =
        [
            "free", "call", "callv", "call_deferred", "connect", "disconnect", "is_connected", "emit_signal",
            "get", "set", "has_method", "has_signal", "get_class", "is_class", "to_string", "get_instance_id",
            "notification", "set_script", "get_script", "set_meta", "get_meta", "has_meta", "tr",
            "reference", "unreference", "get_reference_count",
        ];

        var source = FmodSingletonStub.BuildScriptSource(
            inherited.Select(name => (name, 1)).Append(("set_global_parameter_by_name", 2)));

        foreach (var name in inherited)
        {
            Expect(!source.Contains($"func {name}(", StringComparison.Ordinal),
                $"'{name}' is inherited from Object/RefCounted and must not be redeclared — it would fail the compile");
        }

        Expect(source.Contains("func set_global_parameter_by_name(a0 = null, a1 = null):", StringComparison.Ordinal),
            "the real FMOD method alongside them still gets its stub");
    }

    private static void NamesThatCannotBeDeclaredAreDropped()
    {
        var source = FmodSingletonStub.BuildScriptSource(
        [
            ("_to_string", 0),          // an engine virtual: legal to override, but overriding it breaks the stub
            ("_notification", 1),
            ("has spaces", 0),          // not an identifier at all
            ("3d_listener", 0),         // cannot start with a digit
            ("weird-name", 0),
            ("func", 0),                // a GDScript keyword
            ("return", 1),
            ("", 0),
            ("wave_bank", 1),           // …and the one good name in the batch
        ]);

        foreach (var rejected in new[] { "_to_string", "_notification", "has spaces", "3d_listener", "weird-name", "func(", "return(" })
        {
            Expect(!source.Contains($"func {rejected}", StringComparison.Ordinal),
                $"'{rejected}' cannot be declared and must be dropped rather than break the whole script");
        }

        Expect(source.Contains("func wave_bank(a0 = null):", StringComparison.Ordinal),
            "a declarable name in the same batch survives the filtering");
    }

    // GDScript has no overloads, so two entries for one name must collapse — to the WIDEST, or a caller using the
    // longer signature would hit "too many arguments" instead of the no-op.
    private static void DuplicateNamesCollapseToTheWidestSignature()
    {
        var source = FmodSingletonStub.BuildScriptSource([("play_one_shot", 1), ("play_one_shot", 3), ("play_one_shot", 2)]);

        Expect(CountOccurrences(source, "func play_one_shot(") == 1,
            "one name is declared exactly once, whatever the method list said");
        Expect(source.Contains("func play_one_shot(a0 = null, a1 = null, a2 = null):", StringComparison.Ordinal),
            "and it keeps the widest arity seen, so the longest real call still resolves");
    }

    private static void AbsurdArgCountsAreClamped()
    {
        var wide = FmodSingletonStub.BuildScriptSource([("silly", 5000)]);
        Expect(CountOccurrences(wide, " = null") == FmodSingletonStub.MaxDeclaredArgs,
            $"a nonsense arg count is clamped to {FmodSingletonStub.MaxDeclaredArgs}, not turned into a 5000-parameter func");

        var negative = FmodSingletonStub.BuildScriptSource([("odd", -4)]);
        Expect(negative.Contains("func odd():", StringComparison.Ordinal),
            "a negative arg count declares no parameters rather than generating invalid source");
    }

    // Rung 1 with nothing declarable is still better than rung 3: the name resolves to a live, harmless object.
    private static void AnEmptyMethodListStillProducesAValidStub()
    {
        var source = FmodSingletonStub.BuildScriptSource([]);

        Expect(source.StartsWith("extends RefCounted\n", StringComparison.Ordinal),
            "an empty method list still yields a compilable script, not an empty string");
        Expect(!source.Contains("func ", StringComparison.Ordinal),
            "…with no methods invented for it");
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count++;
            index += needle.Length;
        }

        return count;
    }

    private static void Expect(bool condition, string message)
    {
        if (!condition) throw new Exception("FmodSingletonStubTests: " + message);
    }
}
