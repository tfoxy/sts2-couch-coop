using Godot;
using System;
using System.Collections.Generic;
using System.Linq;

namespace CouchCoop.Mod.Session;

/// <summary>Which rung of the fallback ladder a single FMOD singleton ended on.</summary>
internal enum FmodDoorwayRung
{
    /// <summary>Best case: the name now resolves to a no-op stub. Any caller's guards pass and it gets null back.</summary>
    Stubbed,

    /// <summary>The name was removed but could not be re-pointed: <c>has_singleton</c> is false, so a guarded
    /// caller skips and an unguarded one takes a managed null path. The process lives either way.</summary>
    UnregisteredOnly,

    /// <summary>Neither was possible. The name still resolves to the real object whose native system we are about
    /// to release — a live doorway to a dead system. Logged as an ERROR, never silently.</summary>
    StillExposed,
}

/// <summary>What happened to one FMOD engine singleton, plus the REAL object we captured before touching it.</summary>
/// <param name="Name">The engine singleton name (e.g. <c>FmodServer</c>).</param>
/// <param name="Real">The original singleton object, retained so <c>shutdown()</c> can still be called on it —
/// registration is irrelevant to a direct <c>Call</c>.</param>
/// <param name="Rung">Which rung of the ladder this name ended on.</param>
/// <param name="Detail">Human-readable reason, for the one log line each rung emits.</param>
internal sealed record FmodDoorwayResult(string Name, GodotObject? Real, FmodDoorwayRung Rung, string Detail);

/// <summary>
/// Closes the FMOD engine singleton as a DOORWAY before <see cref="HeadlessFmodShutdown"/> releases the native
/// system behind it.
///
/// THE HOLE THIS EXISTS TO CLOSE. <c>FmodServer.shutdown()</c> frees the native FMOD system but leaves the Godot
/// object registered as an engine singleton and <c>IsInstanceValid</c>. Every guard a careful caller can write
/// still passes:
/// <code>
/// if (!Engine.HasSingleton("FmodServer")) return null;          // true — still registered
/// var s = Engine.GetSingleton("FmodServer");
/// return (s != null &amp;&amp; GodotObject.IsInstanceValid(s)) ? s : null;  // valid — the Godot object is alive
/// </code>
/// …and the very next <c>s.Call("load_bank", …)</c> dereferences freed native state and SIGSEGVs the process
/// (faults at +0x50/+0x90 inside <c>libGodotFmod…so</c>, nothing in <c>godot.log</c> — a native crash has no
/// managed exception for the caller's try/catch to catch). <see cref="HeadlessAudioMutePatch"/> no-ops every
/// VANILLA game→FMOD forward, but a third-party mod is not on that list and never can be: the shape above is
/// exactly the defensive wrapper a well-written mod ships (verified against the installed Downfall build's own
/// <c>Audio.FmodServer</c> helper, which is what a viewer tapping a modded character killed a seat through).
/// So the fix cannot be a longer list of callers — it has to make the DOORWAY harmless for callers we will
/// never see.
///
/// HOW. Before releasing the system, re-point the singleton NAME at a no-op stub: a runtime-compiled GDScript
/// declaring one <c>func</c> per FMOD method, all optional args, all returning <c>null</c>. Then
/// <c>has_singleton</c> stays true, <c>is_instance_valid</c> stays true, <c>has_method</c> stays true, and the
/// call that used to reach freed native memory returns <c>null</c> through pure script. A caller sees a
/// no-result, logs its own warning, and the seat lives.
///
/// EVERY <c>Fmod*</c> NAME, not a hardcoded one — <see cref="CloseDoorways"/> walks
/// <see cref="Engine.GetSingletonList"/>, because the GDExtension may register more than one and a name we
/// did not think of is exactly the one a mod will use.
///
/// FALLBACK LADDER, each rung logged explicitly (see <see cref="FmodDoorwayRung"/>). Godot refuses
/// <c>unregister_singleton</c> for singletons it does not consider user-created and validates the name on
/// <c>register_singleton</c>; both refusals arrive as an engine <c>push_error</c>, NOT as a managed exception,
/// so this class never trusts a call it made — it re-reads <see cref="Engine.HasSingleton"/> /
/// <see cref="Engine.GetSingleton"/> afterwards and decides from what it actually observes.
///
/// RESIDUAL RISK, accepted deliberately (the CPU win of a released mixer/DSP thread is worth it, decided with
/// the maintainer): re-pointing a NAME cannot retarget a reference someone already cached in a field, and
/// GDScript resolves engine singletons at COMPILE time, so GDScript that says <c>FmodServer.foo()</c> is baked
/// to the old pointer and is not covered. Both are out of reach of any name-level fix. What this does cover is
/// every caller that resolves the singleton per call — which is the documented, recommended shape and the one
/// the crash came through.
///
/// <see cref="BuildScriptSource"/> is deliberately a PURE, engine-free seam (strings in, GDScript source out)
/// so the declaration rules that decide whether the script compiles at all are unit-testable without a game.
/// </summary>
internal static class FmodSingletonStub
{
    /// <summary>The singleton-name prefix this closes. Matches <c>FmodServer</c> and anything else the
    /// GDExtension registers.</summary>
    internal const string FmodSingletonPrefix = "Fmod";

    /// <summary>Base class of the generated stub. <c>RefCounted</c> rather than <c>Object</c> so the instance's
    /// lifetime is owned by the reference we hold: it cannot be leaked at exit, and cannot be freed under us.</summary>
    internal const string StubBaseClass = "RefCounted";

    /// <summary>Upper bound on declared parameters per stub method. Far above any real FMOD signature; exists so
    /// a nonsense arg count from a method list can never generate a multi-thousand-parameter function.</summary>
    internal const int MaxDeclaredArgs = 32;

    // Everything an Object/RefCounted ALREADY has. Redeclaring any of these is a GDScript COMPILE error
    // ("Function 'free' already defined in base class"), which would fail the whole script and cost us the stub —
    // and GetMethodList() on the singleton returns these inherited members right alongside the FMOD ones, so the
    // filter is not optional. Baked here (rather than read from ClassDB) so the seam stays pure and testable;
    // CloseDoorways ADDITIONALLY subtracts the live ClassDB list, so a Godot version that grows a new Object
    // method does not silently break the stub.
    private static readonly HashSet<string> ObjectMethodNames = new(StringComparer.Ordinal)
    {
        "free", "call", "call_deferred", "callv", "has_method", "get_method_argument_count", "has_signal",
        "get", "set", "get_indexed", "set_indexed", "get_property_list", "get_method_list", "get_signal_list",
        "get_signal_connection_list", "get_incoming_connections", "property_can_revert", "property_get_revert",
        "notification", "to_string", "get_instance_id", "set_script", "get_script", "set_meta", "remove_meta",
        "get_meta", "has_meta", "get_meta_list", "add_user_signal", "has_user_signal", "remove_user_signal",
        "emit_signal", "connect", "disconnect", "is_connected", "set_block_signals", "is_blocking_signals",
        "set_message_translation", "can_translate_messages", "tr", "tr_n", "set_translation_domain",
        "get_translation_domain", "is_class", "get_class", "is_queued_for_deletion", "cancel_free",
        "set_deferred", "get_script_instance",
        // RefCounted's own.
        "init_ref", "reference", "unreference", "get_reference_count",
    };

    // GDScript keywords cannot be function names. A method list will never contain one, but the generated source
    // has to be valid or NOTHING gets stubbed, so the cheap guard stays.
    private static readonly HashSet<string> GdScriptReservedWords = new(StringComparer.Ordinal)
    {
        "if", "elif", "else", "for", "while", "match", "when", "break", "continue", "pass", "return",
        "class", "class_name", "extends", "is", "in", "as", "self", "super", "signal", "func", "static",
        "const", "enum", "var", "breakpoint", "preload", "await", "yield", "assert", "void", "and", "or",
        "not", "true", "false", "null", "namespace", "trait",
    };

    // Retains the generated scripts and their instances for the life of the process. A registered singleton is a
    // bare pointer as far as Godot is concerned — it adds no reference — so without this the stub would be
    // collected out from under the name we just pointed at it, which is the same dangling-doorway bug in a new hat.
    //
    // Typed `object`, not `GodotObject`, deliberately: this type's static initializer must not so much as mention
    // a Godot type, because BuildScriptSource is unit-tested in a process with GodotSharp linked and NO engine
    // running, where touching the wrong Godot static is a SIGSEGV rather than an exception.
    private static readonly List<object> Retained = [];

    private static readonly object Gate = new();

    /// <summary>
    /// PURE SEAM (no engine calls, no Godot types): turns a singleton's method list into GDScript source for a
    /// stub that answers every one of those methods with <c>null</c>.
    ///
    /// The rules encoded here are the ones that decide whether the script COMPILES, which is the difference
    /// between rung 1 and rung 2 of the ladder:
    /// - drop anything an <c>Object</c>/<c>RefCounted</c> already declares — redeclaring it is a compile error;
    /// - drop leading-underscore names: Godot's engine virtuals (<c>_to_string</c>, <c>_get</c>, <c>_notification</c>…)
    ///   are legal to override but overriding them to return <c>null</c> would break the stub as an object;
    /// - drop anything that is not a plain ASCII identifier, and GDScript's reserved words;
    /// - de-duplicate by name, keeping the LARGEST arg count seen, so a caller passing the longer signature still
    ///   resolves (GDScript has no overloads);
    /// - declare every parameter optional (<c>= null</c>) so a caller passing fewer args than the real method took
    ///   still lands on the stub rather than erroring.
    /// </summary>
    /// <param name="methods">Method name + declared argument count, as read from the real singleton.</param>
    /// <returns>Compilable GDScript source. Never null; with nothing declarable it is the bare base class, which
    /// is still a valid (if method-less) stub.</returns>
    internal static string BuildScriptSource(IEnumerable<(string Name, int ArgCount)> methods)
    {
        ArgumentNullException.ThrowIfNull(methods);

        var widest = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (name, argCount) in methods)
        {
            if (!IsDeclarable(name))
            {
                continue;
            }

            var clamped = Math.Clamp(argCount, 0, MaxDeclaredArgs);
            widest[name] = widest.TryGetValue(name, out var existing) ? Math.Max(existing, clamped) : clamped;
        }

        var builder = new System.Text.StringBuilder();
        builder.Append("extends ").Append(StubBaseClass).Append('\n');
        builder.Append("# CouchCoop headless seat: no-op stand-in for a torn-down FMOD singleton.\n");
        builder.Append("# Every method answers null so a caller's has_singleton/is_instance_valid/has_method\n");
        builder.Append("# guards still pass and its call cannot reach the released native system.\n");

        // Ordinal sort purely for determinism — the same singleton must always produce the same source, so the
        // generated script is diffable in a log and the seam's test can assert on it.
        foreach (var name in widest.Keys.OrderBy(static n => n, StringComparer.Ordinal))
        {
            var argCount = widest[name];
            builder.Append("func ").Append(name).Append('(');
            for (var i = 0; i < argCount; i++)
            {
                if (i > 0)
                {
                    builder.Append(", ");
                }

                builder.Append('a').Append(i).Append(" = null");
            }

            builder.Append("):\n\treturn null\n");
        }

        return builder.ToString();
    }

    /// <summary>PURE: whether <paramref name="name"/> can be declared as a <c>func</c> on the stub at all.</summary>
    internal static bool IsDeclarable(string? name)
    {
        if (string.IsNullOrEmpty(name) || name[0] == '_')
        {
            return false;
        }

        if (!char.IsAsciiLetter(name[0]))
        {
            return false;
        }

        foreach (var c in name)
        {
            if (!char.IsAsciiLetterOrDigit(c) && c != '_')
            {
                return false;
            }
        }

        return !ObjectMethodNames.Contains(name) && !GdScriptReservedWords.Contains(name);
    }

    /// <summary>
    /// ENGINE SIDE. Runs on the game main thread, immediately before the native system is released.
    ///
    /// Captures every <c>Fmod*</c> engine singleton's real object (so the caller can still call
    /// <c>shutdown()</c> on it — registration is irrelevant to a direct call), then walks the fallback ladder
    /// for each name and logs exactly one line per name saying which rung it ended on.
    /// </summary>
    /// <returns>One result per <c>Fmod*</c> singleton found, in the order the engine listed them.</returns>
    internal static List<FmodDoorwayResult> CloseDoorways()
    {
        var results = new List<FmodDoorwayResult>();

        string[] singletonNames;
        try
        {
            singletonNames = Engine.GetSingletonList();
        }
        catch (Exception exception)
        {
            CouchCoopLog.Error(
                "[fmod] could not enumerate engine singletons "
                + $"({exception.GetType().Name}: {exception.Message}) — the FMOD singleton is STILL EXPOSED to any "
                + "third-party caller after shutdown; a mod that calls it can crash this seat.");
            return results;
        }

        foreach (var name in singletonNames)
        {
            if (name is null || !name.StartsWith(FmodSingletonPrefix, StringComparison.Ordinal))
            {
                continue;
            }

            results.Add(CloseOne(name));
        }

        if (results.Count == 0)
        {
            CouchCoopLog.Info(
                $"[fmod] no '{FmodSingletonPrefix}*' engine singleton registered — no doorway to close.");
        }

        return results;
    }

    private static FmodDoorwayResult CloseOne(string name)
    {
        var real = Engine.HasSingleton(name) ? Engine.GetSingleton(name) : null;
        if (real is null || !GodotObject.IsInstanceValid(real))
        {
            var detail = "the singleton did not resolve to a valid object";
            CouchCoopLog.Info($"[fmod] singleton '{name}': {detail} — nothing to swap.");
            return new FmodDoorwayResult(name, null, FmodDoorwayRung.UnregisteredOnly, detail);
        }

        // Build the stub BEFORE unregistering: if compiling it fails we still want rung 2 (unregister-only),
        // and doing it in this order means the name is never pointed at nothing while we work.
        var stub = TryBuildStub(real, name, out var stubDetail);

        // Rung 1/2 both start here. Godot refuses this for a singleton it does not consider user-created, and
        // refuses by push_error rather than by throwing — so the ONLY trustworthy signal is re-reading
        // HasSingleton afterwards.
        try
        {
            Engine.UnregisterSingleton(name);
        }
        catch (Exception exception)
        {
            stubDetail = $"unregister_singleton threw {exception.GetType().Name}: {exception.Message}";
        }

        if (Engine.HasSingleton(name))
        {
            var detail = $"Godot refused to unregister '{name}' (it is not a user-created singleton); {stubDetail}";
            CouchCoopLog.Error(
                $"[fmod] LADDER RUNG 3 for '{name}': {detail}. The singleton still resolves to the real "
                + "object whose native system is about to be released, so a third-party caller that resolves it "
                + "per call can still crash this seat. FMOD is being shut down anyway (the CPU win is the point) "
                + "— this seat is knowingly exposed.");
            return new FmodDoorwayResult(name, real, FmodDoorwayRung.StillExposed, detail);
        }

        if (stub is null)
        {
            CouchCoopLog.Info(
                $"[fmod] LADDER RUNG 2 for '{name}': unregistered but not stubbed ({stubDetail}). "
                + "has_singleton() is now FALSE, so a guarded caller skips FMOD and an unguarded one takes a "
                + "managed null path — either way the seat survives the call.");
            return new FmodDoorwayResult(name, real, FmodDoorwayRung.UnregisteredOnly, stubDetail);
        }

        try
        {
            Engine.RegisterSingleton(name, stub);
        }
        catch (Exception exception)
        {
            stubDetail = $"register_singleton threw {exception.GetType().Name}: {exception.Message}";
        }

        // Same posture as the unregister: verify by observation. register_singleton validates the name and
        // refuses by push_error, and "refused" here has to degrade to rung 2, not be reported as rung 1.
        var swapped = Engine.HasSingleton(name)
            && Engine.GetSingleton(name) is { } registered
            && GodotObject.IsInstanceValid(registered)
            && registered.GetInstanceId() == stub.GetInstanceId();

        if (!swapped)
        {
            CouchCoopLog.Info(
                $"[fmod] LADDER RUNG 2 for '{name}': Godot refused to re-register the name onto the "
                + $"no-op stub ({stubDetail}). has_singleton() is now FALSE, so a guarded caller skips FMOD and an "
                + "unguarded one takes a managed null path — either way the seat survives the call.");
            return new FmodDoorwayResult(name, real, FmodDoorwayRung.UnregisteredOnly, stubDetail);
        }

        CouchCoopLog.Info(
            $"[fmod] LADDER RUNG 1 for '{name}': engine singleton swapped to a no-op GDScript stub "
            + $"({stubDetail}) BEFORE shutdown — a third-party caller's has_singleton/is_instance_valid/has_method "
            + "guards still pass and its call now returns null instead of reaching the released native system.");
        return new FmodDoorwayResult(name, real, FmodDoorwayRung.Stubbed, stubDetail);
    }

    private static GodotObject? TryBuildStub(GodotObject real, string name, out string detail)
    {
        try
        {
            var methods = ReadMethodList(real);
            var source = FilterAndBuild(methods);
            var script = new GDScript { SourceCode = source };
            var reload = script.Reload();
            if (reload != Error.Ok)
            {
                detail = $"GDScript stub for '{name}' failed to compile (Reload returned {reload})";
                return null;
            }

            if (script.New().AsGodotObject() is not { } instance || !GodotObject.IsInstanceValid(instance))
            {
                detail = $"GDScript stub for '{name}' compiled but produced no instance";
                return null;
            }

            lock (Gate)
            {
                // Hold BOTH: the instance so the registered pointer stays alive, and the script because the
                // instance's behaviour is the script.
                Retained.Add(instance);
                Retained.Add(script);
            }

            var declared = CountDeclaredFuncs(source);
            detail = $"{declared} no-op method(s) declared from {methods.Count} listed";
            return instance;
        }
        catch (Exception exception)
        {
            detail = $"building the stub for '{name}' threw {exception.GetType().Name}: {exception.Message}";
            return null;
        }
    }

    private static List<(string Name, int ArgCount)> ReadMethodList(GodotObject real)
    {
        var methods = new List<(string Name, int ArgCount)>();
        foreach (var entry in real.GetMethodList())
        {
            if (!entry.TryGetValue("name", out var nameValue))
            {
                continue;
            }

            var argCount = entry.TryGetValue("args", out var argsValue) ? argsValue.AsGodotArray().Count : 0;
            methods.Add((nameValue.AsString(), argCount));
        }

        return methods;
    }

    // The pure seam already drops everything an Object/RefCounted declares from a BAKED list. This additionally
    // subtracts what ClassDB says the base class has RIGHT NOW, so a Godot build that grew a new Object method
    // cannot turn the whole stub into a compile error (which would silently cost us rung 1).
    private static string FilterAndBuild(List<(string Name, int ArgCount)> methods)
    {
        HashSet<string>? baseMethods = null;
        try
        {
            baseMethods = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in ClassDB.ClassGetMethodList(StubBaseClass))
            {
                if (entry.TryGetValue("name", out var nameValue))
                {
                    baseMethods.Add(nameValue.AsString());
                }
            }
        }
        catch
        {
            baseMethods = null; // ClassDB unavailable — the baked list in the seam still covers the known set.
        }

        var candidates = baseMethods is null
            ? methods
            : methods.Where(m => !baseMethods.Contains(m.Name)).ToList();

        return BuildScriptSource(candidates);
    }

    private static int CountDeclaredFuncs(string source)
    {
        var count = 0;
        foreach (var line in source.Split('\n'))
        {
            if (line.StartsWith("func ", StringComparison.Ordinal))
            {
                count++;
            }
        }

        return count;
    }
}
