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

/// <summary>Where a forwarding node ended up after <see cref="FmodSingletonStub.CloseProxyDoorway"/>.</summary>
internal enum FmodProxyOutcome
{
    /// <summary>Re-read and confirmed: the node's script IS the no-op stub and the node answers every forward the
    /// original script declared. A call through it returns null in pure script.</summary>
    Stubbed,

    /// <summary>The node still forwards to FMOD, or we could not prove that it does not. What that costs is the
    /// caller's decision — <see cref="HeadlessFmodShutdown"/> refuses to release the system over it.</summary>
    StillExposed,
}

/// <summary>What happened to one forwarding node.</summary>
/// <param name="Where">The node's tree path (its bare name when it is outside a tree), for the log line.</param>
/// <param name="Outcome">Whether the doorway is closed.</param>
/// <param name="Detail">Human-readable reason, carried into the one log line each outcome emits.</param>
internal sealed record FmodProxyResult(string Where, FmodProxyOutcome Outcome, string Detail);

/// <summary>
/// Closes FMOD's DOORWAYS — the engine singleton, and the vanilla forwarding nodes — before
/// <see cref="HeadlessFmodShutdown"/> releases the native system behind them.
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
/// THE SECOND DOORWAY: THE FORWARDING NODES. Every vanilla game→FMOD forward goes through a GDScript child
/// named <c>Proxy</c> — one under the audio manager, one under the per-run music controller — and that script
/// bound the FMOD singleton when it was COMPILED, so re-pointing the name never reaches it. The only thing
/// standing between those forwards and the released system used to be <see cref="HeadlessAudioMutePatch"/>,
/// and a Harmony patch only rewrites a method's own body, never a copy the JIT already inlined somewhere else.
/// A mod that initializes BEFORE CouchCoop and patches a method gets that method's replacement JIT-compiled at
/// patch time, optimized, with small callees — a vanilla audio forward included — inlined into it. That copy is
/// frozen un-muted before our prefix exists. Measured 2026-09-22: a Windows seat whose mod order put CouchCoop
/// last died at the Neow event with a native access violation inside the FMOD library, reached from another
/// mod's postfix through an inlined ambient-loop forward into the audio manager's proxy. (Linux never hit it
/// only because its mod order put CouchCoop first; load order is the variable, not the OS.) So
/// <see cref="CloseProxyDoorway"/> closes the NODE: it replaces the proxy's script with a stub built by the
/// same seam — <c>extends</c> the node's own native class (anything else and <c>set_script</c> refuses), one
/// <c>func</c> per method the original declared, no engine virtuals (so the stub cannot re-enable processing).
/// The node keeps its identity, so every reference already cached to it — the game's own, or one frozen into
/// another mod's wrapper — now lands on a method that returns null in pure script.
///
/// RESIDUAL RISK, accepted deliberately (the CPU win of a released mixer/DSP thread is worth it, decided with
/// the maintainer): re-pointing a NAME cannot retarget a reference someone already cached in a field, and
/// GDScript resolves engine singletons at COMPILE time, so GDScript that says <c>FmodServer.foo()</c> is baked
/// to the old pointer. For the two vanilla forwarding nodes that is closed at the node, above. It stays open for
/// any OTHER script or node that binds FMOD directly — a mod's own GDScript, a mod scene's FMOD node — which no
/// fix on our side can enumerate. What this does cover is every caller that resolves the singleton per call
/// (the documented shape, and the one the 2026-09-16 crash came through) plus every call routed through a
/// vanilla proxy, inlined copies included (the one the 2026-09-22 crash came through).
///
/// <see cref="BuildScriptSource(string, IEnumerable{ValueTuple{string, int}}, IEnumerable{string})"/> is
/// deliberately a PURE, engine-free seam (strings in, GDScript source out) so the declaration rules that decide
/// whether either stub compiles at all are unit-testable without a game.
/// </summary>
internal static class FmodSingletonStub
{
    /// <summary>The singleton-name prefix this closes. Matches <c>FmodServer</c> and anything else the
    /// GDExtension registers.</summary>
    internal const string FmodSingletonPrefix = "Fmod";

    /// <summary>Base class of the generated SINGLETON stub. <c>RefCounted</c> rather than <c>Object</c> so the
    /// instance's lifetime is owned by the reference we hold: it cannot be leaked at exit, and cannot be freed
    /// under us. A proxy stub instead extends whatever native class its node is.</summary>
    internal const string StubBaseClass = "RefCounted";

    /// <summary>The child node every vanilla game→FMOD forward is routed through, under both the audio manager
    /// and the per-run music controller. A node name, which is all the code needs to find it.</summary>
    internal const string ProxyNodeName = "Proxy";

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

    // Compiled PROXY stubs, keyed by their generated source. The music controller's proxy is rebuilt with every
    // run and carries the same script each time, so one source must reuse one compiled stub rather than grow the
    // process by a script per run. Holding them here is also the retention: a node owns a reference to its
    // script, but only for as long as it lives, and the next run's node needs the stub to still exist. Typed
    // `object` for the same reason as Retained.
    private static readonly Dictionary<string, object> ProxyStubsBySource = new(StringComparer.Ordinal);

    private static readonly object Gate = new();

    /// <summary>PURE: the singleton stub — <see cref="StubBaseClass"/>, no extra inherited names.</summary>
    internal static string BuildScriptSource(IEnumerable<(string Name, int ArgCount)> methods) =>
        BuildScriptSource(StubBaseClass, methods, inheritedNames: null);

    /// <summary>
    /// PURE SEAM (no engine calls, no Godot types): turns a method list into GDScript source for a stub that
    /// extends <paramref name="baseClass"/> and answers every one of those methods with <c>null</c>.
    ///
    /// The rules encoded here are the ones that decide whether the script COMPILES — for the singleton, the
    /// difference between rung 1 and rung 2 of the ladder; for a proxy node, the difference between a closed
    /// doorway and a system we must not release:
    /// - drop anything an <c>Object</c>/<c>RefCounted</c> already declares (always, from the baked list), and
    ///   anything in <paramref name="inheritedNames"/> — redeclaring an inherited method is a compile error;
    /// - drop leading-underscore names: Godot's engine virtuals (<c>_to_string</c>, <c>_notification</c>,
    ///   <c>_ready</c>, <c>_process</c>…) are legal to override, but a stub that overrode them would break as an
    ///   object — and on a node, declaring <c>_process</c> is exactly what would switch processing back on;
    /// - drop anything that is not a plain ASCII identifier, and GDScript's reserved words;
    /// - de-duplicate by name, keeping the LARGEST arg count seen, so a caller passing the longer signature still
    ///   resolves (GDScript has no overloads);
    /// - declare every parameter optional (<c>= null</c>) so a caller passing fewer args than the real method took
    ///   still lands on the stub rather than erroring.
    /// </summary>
    /// <param name="baseClass">What the stub <c>extends</c>. For a node this must be the node's own native class,
    /// or <c>set_script</c> refuses the stub.</param>
    /// <param name="methods">Method name + declared argument count, as read from the real object or script.</param>
    /// <param name="inheritedNames">Everything <paramref name="baseClass"/> already has, as the engine reports it
    /// at runtime; null when unavailable, in which case only the baked <c>Object</c>/<c>RefCounted</c> list
    /// applies.</param>
    /// <returns>Compilable GDScript source. Never null; with nothing declarable it is the bare base class, which
    /// is still a valid (if method-less) stub.</returns>
    /// <exception cref="ArgumentException"><paramref name="baseClass"/> is not a class name GDScript can extend —
    /// it is written into the source verbatim, so anything else would be at best a compile error.</exception>
    internal static string BuildScriptSource(
        string baseClass,
        IEnumerable<(string Name, int ArgCount)> methods,
        IEnumerable<string>? inheritedNames)
    {
        ArgumentNullException.ThrowIfNull(methods);
        if (!IsExtendableClassName(baseClass))
        {
            throw new ArgumentException(
                $"'{baseClass}' is not a class name a GDScript stub can extend.", nameof(baseClass));
        }

        var inherited = inheritedNames is null ? null : new HashSet<string>(inheritedNames, StringComparer.Ordinal);
        var widest = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (name, argCount) in methods)
        {
            if (!IsDeclarable(name) || inherited?.Contains(name) == true)
            {
                continue;
            }

            var clamped = Math.Clamp(argCount, 0, MaxDeclaredArgs);
            widest[name] = widest.TryGetValue(name, out var existing) ? Math.Max(existing, clamped) : clamped;
        }

        var builder = new System.Text.StringBuilder();
        builder.Append("extends ").Append(baseClass).Append('\n');
        builder.Append("# CouchCoop headless seat: no-op stand-in for an FMOD doorway (an engine singleton or a\n");
        builder.Append("# forwarding node) whose native system is torn down. Every method answers null, so a\n");
        builder.Append("# caller's guards still pass and its call cannot reach the released native system.\n");

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

    /// <summary>PURE: whether <paramref name="name"/> can follow <c>extends</c> in the generated source. Native
    /// class names are plain identifiers; this only has to refuse what would corrupt the script.</summary>
    internal static bool IsExtendableClassName(string? name)
    {
        if (string.IsNullOrEmpty(name) || !(char.IsAsciiLetter(name[0]) || name[0] == '_'))
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

        return !GdScriptReservedWords.Contains(name);
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

    /// <summary>
    /// ENGINE SIDE. Runs on the game main thread. Closes one forwarding node as a doorway by replacing its script
    /// with a no-op stub, then RE-READS the node to decide what actually happened — <c>set_script</c> refuses by
    /// <c>push_error</c>, not by throwing, exactly like the singleton calls above — and logs exactly one line:
    /// <c>PROXY DOORWAY CLOSED</c> (info) or <c>PROXY DOORWAY OPEN</c> (error, carrying
    /// <paramref name="consequenceIfOpen"/>, which only the caller knows).
    ///
    /// Swapping the SCRIPT rather than the node is the point: every reference already held to this node — the
    /// game's own cached one, or one frozen into another mod's JIT-compiled wrapper — keeps pointing at the same
    /// object, which now answers through the stub.
    /// </summary>
    /// <param name="proxy">The forwarding node.</param>
    /// <param name="owner">Who it forwards for, for the log line (e.g. <c>audio manager</c>).</param>
    /// <param name="consequenceIfOpen">What an open doorway means at this call site.</param>
    internal static FmodProxyResult CloseProxyDoorway(Node proxy, string owner, string consequenceIfOpen)
    {
        var where = "(freed node)";
        FmodProxyResult result;
        try
        {
            if (GodotObject.IsInstanceValid(proxy))
            {
                where = Describe(proxy);
            }

            result = SwapProxyScript(proxy, where);
        }
        catch (Exception exception)
        {
            result = new FmodProxyResult(where, FmodProxyOutcome.StillExposed,
                $"swapping its script threw {exception.GetType().Name}: {exception.Message}");
        }

        if (result.Outcome == FmodProxyOutcome.Stubbed)
        {
            CouchCoopLog.Info(
                $"[fmod] PROXY DOORWAY CLOSED for the {owner} at '{result.Where}': {result.Detail} — every "
                + "forward through it, including a copy another mod's patch inlined before ours existed, now "
                + "returns null instead of reaching FMOD.");
        }
        else
        {
            CouchCoopLog.Error(
                $"[fmod] PROXY DOORWAY OPEN for the {owner} at '{result.Where}': {result.Detail}. {consequenceIfOpen}");
        }

        return result;
    }

    private static FmodProxyResult SwapProxyScript(Node proxy, string where)
    {
        if (!GodotObject.IsInstanceValid(proxy))
        {
            return Exposed(where, "the node is no longer valid");
        }

        var nativeClass = proxy.GetClass();

        // No script means the node's methods are its native class's own. If that class were FMOD's, a call would
        // reach the system natively and there is nothing to swap — so "no script" is never read as "closed".
        if (proxy.GetScript().AsGodotObject() is not Script original || !GodotObject.IsInstanceValid(original))
        {
            return Exposed(where,
                $"it carries no script, so whatever it forwards is native '{nativeClass}' code that cannot be stubbed");
        }

        if (IsProxyStub(original))
        {
            return Closed(where, "its script already is the no-op stub");
        }

        var methods = ReadMethodList(original.GetScriptMethodList());
        var source = FilterAndBuild(nativeClass, methods);
        var declared = DeclaredFuncNames(source);
        var stub = GetOrCompileProxyStub(source, out var compileDetail);
        if (stub is null)
        {
            return Exposed(where, compileDetail);
        }

        var originalName = DescribeScript(original);
        proxy.SetScript(stub);

        // Decide from what the node reports NOW. A refused set_script leaves the original attached; a stub that
        // attached but failed to instantiate leaves the node answering nothing through script — neither is a
        // closure we can vouch for.
        var attached = proxy.GetScript().AsGodotObject();
        if (attached is null || attached.GetInstanceId() != stub.GetInstanceId())
        {
            return Exposed(where,
                $"set_script did not take — the node still carries {DescribeScript(attached)}, not the stub");
        }

        var unanswered = declared.Where(name => !proxy.HasMethod(name)).ToList();
        if (unanswered.Count > 0)
        {
            return Exposed(where,
                $"the stub is attached but the node answers only {declared.Count - unanswered.Count} of "
                + $"{declared.Count} declared forward(s) (missing: {string.Join(", ", unanswered.Take(8))})");
        }

        return Closed(where,
            $"script {originalName} swapped for a no-op stub extending {nativeClass} ({compileDetail}; "
            + $"{declared.Count} no-op method(s) declared from {methods.Count} listed)");

        static FmodProxyResult Closed(string at, string detail) => new(at, FmodProxyOutcome.Stubbed, detail);
        static FmodProxyResult Exposed(string at, string detail) => new(at, FmodProxyOutcome.StillExposed, detail);
    }

    private static GDScript? GetOrCompileProxyStub(string source, out string detail)
    {
        lock (Gate)
        {
            if (ProxyStubsBySource.TryGetValue(source, out var cached)
                && cached is GDScript known
                && GodotObject.IsInstanceValid(known))
            {
                detail = "reused the compiled stub";
                return known;
            }
        }

        var script = new GDScript { SourceCode = source };
        var reload = script.Reload();
        if (reload != Error.Ok)
        {
            detail = $"the GDScript stub failed to compile (Reload returned {reload})";
            return null;
        }

        if (!script.CanInstantiate())
        {
            detail = "the GDScript stub compiled but cannot be instantiated";
            return null;
        }

        lock (Gate)
        {
            ProxyStubsBySource[source] = script;
        }

        detail = "compiled a new stub";
        return script;
    }

    private static bool IsProxyStub(Script script)
    {
        var id = script.GetInstanceId();
        lock (Gate)
        {
            return ProxyStubsBySource.Values.Any(stub => stub is GodotObject known && known.GetInstanceId() == id);
        }
    }

    // GetPath() on a node outside the tree push_errors, so only ask for it when the node can answer.
    private static string Describe(Node node) =>
        node.IsInsideTree() ? node.GetPath().ToString() : node.Name.ToString();

    private static string DescribeScript(GodotObject? script) => script switch
    {
        null => "no script",
        Resource { ResourcePath.Length: > 0 } resource => $"'{resource.ResourcePath}'",
        _ => $"an unsaved {script.GetClass()}",
    };

    private static GodotObject? TryBuildStub(GodotObject real, string name, out string detail)
    {
        try
        {
            var methods = ReadMethodList(real.GetMethodList());
            var source = FilterAndBuild(StubBaseClass, methods);
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

            var declared = DeclaredFuncNames(source).Count;
            detail = $"{declared} no-op method(s) declared from {methods.Count} listed";
            return instance;
        }
        catch (Exception exception)
        {
            detail = $"building the stub for '{name}' threw {exception.GetType().Name}: {exception.Message}";
            return null;
        }
    }

    // The same shape serves both doorways: an object's GetMethodList() (the singleton, inherited members and all)
    // and a script's GetScriptMethodList() (the proxy, only what the script itself declares).
    private static List<(string Name, int ArgCount)> ReadMethodList(IEnumerable<Godot.Collections.Dictionary> list)
    {
        var methods = new List<(string Name, int ArgCount)>();
        foreach (var entry in list)
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

    // The pure seam always drops everything an Object/RefCounted declares from a BAKED list. This additionally
    // hands it what ClassDB says the base class has RIGHT NOW (inherited members included), so a Godot build
    // that grew a new Object method cannot turn the whole stub into a compile error, and a proxy stub extending
    // Node — whose members no baked list here carries — never redeclares one of them either.
    private static string FilterAndBuild(string baseClass, List<(string Name, int ArgCount)> methods)
    {
        List<string>? baseMethods;
        try
        {
            baseMethods = [];
            foreach (var entry in ClassDB.ClassGetMethodList(baseClass))
            {
                if (entry.TryGetValue("name", out var nameValue))
                {
                    baseMethods.Add(nameValue.AsString());
                }
            }
        }
        catch
        {
            // ClassDB unavailable — the baked list still covers Object/RefCounted. For a proxy the input is the
            // script's OWN declarations, which cannot legally redeclare a native member; if one somehow did, the
            // compile fails and the caller reports the doorway open rather than guessing.
            baseMethods = null;
        }

        return BuildScriptSource(baseClass, methods, baseMethods);
    }

    private static List<string> DeclaredFuncNames(string source)
    {
        var names = new List<string>();
        foreach (var line in source.Split('\n'))
        {
            if (line.StartsWith("func ", StringComparison.Ordinal) && line.IndexOf('(') is var open and > 5)
            {
                names.Add(line[5..open]);
            }
        }

        return names;
    }
}
