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
// The same seam builds the second stub: the one swapped onto a forwarding NODE (the audio manager's `Proxy`)
// so a vanilla forward inlined into another mod's Harmony wrapper — which no prefix of ours can reach — lands on
// null instead of the released system. That stub extends the node's own native class and must neither redeclare
// anything that class already has nor declare an engine virtual that would switch the node's processing back on.
//
// Registered near the TOP of the runner sequence on purpose, and reachable alone as `-- fmod-stub`. The
// sequence no longer takes the process down partway (the SIGSEGV inside HeadlessAudioMuteTargetsTests was
// fixed on 2026-09-17), but a source-generation guard costs nothing to run first and should not depend on
// every suite above it passing.
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
        ANodeStubExtendsTheNodesOwnNativeClass();
        ANodeStubNeverRedeclaresWhatTheNativeBaseHas();
        ANodeStubDeclaresNoEngineVirtuals();
        ANodeStubRefusesKeywordsAndCompilerInternals();
        AClassNameThatCannotFollowExtendsIsRefused();
        TheSameMethodsInAnyOrderProduceTheSameSource();
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

    // What a forwarding node's script declares (its own methods only) — the shape the audio manager's forwards
    // need: `Call("play_loop", path, flag)` must land on a two-arg func that returns null.
    private static void ANodeStubExtendsTheNodesOwnNativeClass()
    {
        var source = FmodSingletonStub.BuildScriptSource(
            "Node", [("play_loop", 2), ("stop_loop", 1), ("set_param", 3), ("stop_all_loops", 0)], NodeMembers);

        Expect(source.StartsWith("extends Node\n", StringComparison.Ordinal),
            "a node stub extends the node's own native class — anything else and set_script refuses it");
        Expect(source.Contains("func play_loop(a0 = null, a1 = null):\n\treturn null\n", StringComparison.Ordinal),
            "a two-arg forward is declared with two optional args and returns null");
        Expect(source.Contains("func stop_loop(a0 = null):\n\treturn null\n", StringComparison.Ordinal),
            "a one-arg forward is declared with one optional arg");
        Expect(source.Contains("func set_param(a0 = null, a1 = null, a2 = null):", StringComparison.Ordinal),
            "a three-arg forward keeps all three");
        Expect(source.Contains("func stop_all_loops():\n\treturn null\n", StringComparison.Ordinal),
            "a zero-arg forward is declared with no args at all");
        Expect(CountOccurrences(source, "func ") == 4, "exactly the four forwards are declared, nothing invented");
    }

    // The runtime hands the seam ClassDB's full member list for the native class; every one of those must be
    // dropped, and Object's members must be dropped even when that list is missing (ClassDB unavailable).
    private static void ANodeStubNeverRedeclaresWhatTheNativeBaseHas()
    {
        string[] objectMembers = ["free", "call", "connect", "get", "set", "has_method", "get_class", "set_script"];
        var methods = NodeMembers.Concat(objectMembers).Select(name => (name, 1)).Append(("play_music", 1));

        var withClassDb = FmodSingletonStub.BuildScriptSource("Node", methods, NodeMembers);
        foreach (var name in NodeMembers.Concat(objectMembers))
        {
            Expect(!withClassDb.Contains($"func {name}(", StringComparison.Ordinal),
                $"'{name}' is inherited by a Node and must not be redeclared — it would fail the compile");
        }

        Expect(withClassDb.Contains("func play_music(a0 = null):", StringComparison.Ordinal),
            "the forward alongside them still gets its stub");

        var withoutClassDb = FmodSingletonStub.BuildScriptSource("Node", methods, inheritedNames: null);
        foreach (var name in objectMembers)
        {
            Expect(!withoutClassDb.Contains($"func {name}(", StringComparison.Ordinal),
                $"'{name}' is an Object member and stays filtered by the baked list even without ClassDB");
        }
    }

    // A proxy script's own method list includes its engine virtuals. Declaring `_process` on the stub would make
    // the node process every frame again; declaring `_ready`/`_enter_tree` would run on the next tree entry.
    private static void ANodeStubDeclaresNoEngineVirtuals()
    {
        string[] virtuals =
        [
            "_ready", "_process", "_physics_process", "_enter_tree", "_exit_tree", "_init", "_notification",
            "_input", "_unhandled_input", "_to_string",
        ];

        var source = FmodSingletonStub.BuildScriptSource(
            "Node", virtuals.Select(name => (name, 1)).Append(("play_one_shot", 3)), NodeMembers);

        foreach (var name in virtuals)
        {
            Expect(!source.Contains($"func {name}(", StringComparison.Ordinal),
                $"engine virtual '{name}' must not be declared on a node stub");
        }

        Expect(!source.Contains("func _", StringComparison.Ordinal), "no underscore-prefixed func at all");
        Expect(source.Contains("func play_one_shot(a0 = null, a1 = null, a2 = null):", StringComparison.Ordinal),
            "the forward in the same list survives");
    }

    // A script's method list can carry compiler-internal entries (`@implicit_new`-style names) next to its real
    // methods; neither those nor a keyword can be a func name, and one of them would fail the WHOLE script.
    private static void ANodeStubRefusesKeywordsAndCompilerInternals()
    {
        var source = FmodSingletonStub.BuildScriptSource(
            "Node",
            [
                ("@implicit_new", 0), ("@implicit_ready", 0), ("pass", 0), ("match", 1), ("await", 0),
                ("update_music", 1),
            ],
            NodeMembers);

        foreach (var rejected in new[] { "@implicit_new", "@implicit_ready", "pass(", "match(", "await(" })
        {
            Expect(!source.Contains($"func {rejected}", StringComparison.Ordinal),
                $"'{rejected}' cannot be declared and must be dropped rather than break the whole script");
        }

        Expect(source.Contains("func update_music(a0 = null):", StringComparison.Ordinal),
            "the declarable forward in the same batch survives");
    }

    // The base class is written into the source verbatim, so the seam refuses anything that is not a class name
    // GDScript could extend rather than emit a script that cannot compile (or says something else entirely).
    private static void AClassNameThatCannotFollowExtendsIsRefused()
    {
        foreach (var bad in new[] { "", "Node\nfunc x():", "Node; pass", "2DNode", "class", "extends" })
        {
            var threw = false;
            try
            {
                FmodSingletonStub.BuildScriptSource(bad, [("play_loop", 2)], NodeMembers);
            }
            catch (ArgumentException)
            {
                threw = true;
            }

            Expect(threw, $"'{bad.Replace("\n", "\\n")}' is refused as a base class");
        }

        Expect(FmodSingletonStub.IsExtendableClassName("Node2D"), "an ordinary native class name is accepted");
        Expect(FmodSingletonStub.IsExtendableClassName("RefCounted"), "…as is the singleton stub's base");
    }

    // The runtime keeps ONE compiled proxy stub per generated source (the music controller's proxy is rebuilt
    // every run), which only works if the same methods always generate byte-identical source.
    private static void TheSameMethodsInAnyOrderProduceTheSameSource()
    {
        var forward = FmodSingletonStub.BuildScriptSource(
            "Node", [("stop_music", 0), ("load_act_bank", 2), ("update_music", 1)], NodeMembers);
        var reversed = FmodSingletonStub.BuildScriptSource(
            "Node", [("update_music", 1), ("load_act_bank", 2), ("stop_music", 0)], Enumerable.Reverse(NodeMembers));

        Expect(forward == reversed, "method and inherited-name order do not change the generated source");
    }

    // A slice of what ClassDB reports for Node (inherited Object members included at runtime). The test only
    // needs names that could plausibly collide; the runtime passes the engine's real list.
    private static readonly string[] NodeMembers =
    [
        "add_child", "remove_child", "get_node", "get_node_or_null", "get_parent", "get_children", "get_tree",
        "is_inside_tree", "queue_free", "set_process", "set_physics_process", "get_path", "set_name", "get_name",
        "reparent", "set_process_mode", "is_node_ready", "request_ready",
    ];

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
