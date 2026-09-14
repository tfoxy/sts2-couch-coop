using System.Reflection;
using CouchCoop.Mod.Session;
using Godot;

using DecorFreeze = CouchCoop.Mod.Session.CouchCoopHeadlessVisualSuspender.DecorFreeze;

// Regression guard for the decorative freeze in CouchCoopHeadlessVisualSuspender — the root-cause test for the
// "energy orb / its number disappears mid-combat" bug (round 8, item 6).
//
// The bug: the freeze used ProcessMode=Disabled on every decorative animator. In Godot 4.5.1 a Tween defaults to
// TWEEN_PAUSE_BOUND and `Tween::can_process()` returns `bound_node->can_process()`, while `Node::_can_process()`
// returns false outright for PROCESS_MODE_DISABLED — so disabling a node ALSO pauses the tweens it created on
// itself with CreateTween(). The energy counter slides in from (-480,128) to its rest origin (0,0) over 600ms on
// exactly such a tween, so a counter frozen mid-flight stayed off-position forever (a pre-fix recording pins it
// at (-20.374207, 5.4331055) — Expo-Out at t=0.273s of 0.6s — for all 1190 deltas).
//
// The fix splits the freeze into two mechanisms. These tests assert the property that makes each one CORRECT,
// against the installed STS2 assemblies (pure metadata reflection, no live game, no native Godot):
//
//   ProcessOnly  =>  the type MUST override _Process (SetProcess(false) is then enough to stop its churn) and it
//                    MUST NOT be ProcessMode-frozen (which would re-pause its self-bound tweens).
//   WholeNode    =>  the type MUST NOT override _Process (its churn is a self-bound tween chain, so pausing that
//                    chain via ProcessMode=Disabled is the only lever — and is the intended effect).
//
// One ABSENCE is pinned too (TheStarCounterIsNeverFrozen): a type whose per-frame path is the sole writer of
// something the mirror renders cannot be frozen at all, whichever mechanism is used.
//
// If a game update renames one of these node types, or moves the energy-orb spin off _Process onto a tween (or
// vice versa), the mechanism silently becomes wrong — these tests fail the build instead.
internal static class HeadlessDecorativeFreezeTests
{
    public static void Run()
    {
        EveryPolicyTypeResolves();
        ProcessOnlyTypesOverrideProcess();
        WholeNodeTypesDoNotOverrideProcess();
        TheEnergyCounterIsProcessOnly();
        TheStarCounterIsNeverFrozen();
    }

    // The freeze matches by C# type NAME (GetType().Name), so a rename in the game silently disables it. Resolve
    // every policy key against the installed sts2.dll and require it to be a Godot Node subclass.
    private static void EveryPolicyTypeResolves()
    {
        var missing = new List<string>();
        var notANode = new List<string>();
        foreach (var name in CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes.Keys)
        {
            var type = ResolveGameType(name);
            if (type is null)
            {
                missing.Add(name);
            }
            else if (!typeof(Node).IsAssignableFrom(type))
            {
                notANode.Add($"{name} ({type.FullName})");
            }
        }

        Assert(missing.Count == 0,
            $"every decorative-freeze type resolves against the installed STS2 assemblies (missing: {string.Join("; ", missing)})");
        Assert(notANode.Count == 0,
            $"every decorative-freeze type is a Godot.Node (not: {string.Join("; ", notANode)})");
    }

    // ProcessOnly is only sound if SetProcess(false) actually stops the churn — i.e. the churn lives in _Process.
    private static void ProcessOnlyTypesOverrideProcess()
    {
        foreach (var (name, how) in CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes)
        {
            if (how != DecorFreeze.ProcessOnly)
            {
                continue;
            }

            Assert(OverridesProcess(name),
                $"'{name}' is frozen ProcessOnly, so it must override _Process (SetProcess(false) is the only lever that mechanism pulls)");
        }
    }

    // WholeNode is only justified when there is NO _Process to disable — otherwise the narrower, tween-safe
    // ProcessOnly mechanism should have been used and ProcessMode=Disabled is needlessly stranding bound tweens.
    private static void WholeNodeTypesDoNotOverrideProcess()
    {
        foreach (var (name, how) in CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes)
        {
            if (how != DecorFreeze.WholeNode)
            {
                continue;
            }

            Assert(!OverridesProcess(name),
                $"'{name}' is frozen WholeNode (ProcessMode=Disabled, which also pauses its self-bound tweens). "
                + "It must NOT override _Process — a _Process-driven animator belongs on the tween-safe ProcessOnly path");
        }
    }

    // The specific regression: the combat energy counter must never be ProcessMode-frozen, or its AnimIn position
    // tween pauses mid-flight and the orb (or just its Label, when the strand lands across the cull margin)
    // vanishes from the mirror.
    private static void TheEnergyCounterIsProcessOnly()
    {
        var policy = CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes;
        Assert(policy.TryGetValue("NEnergyCounter", out var energy) && energy == DecorFreeze.ProcessOnly,
            "NEnergyCounter is frozen ProcessOnly so its self-bound AnimIn/AnimOut position tween keeps running");
        Assert(policy.TryGetValue("NIntent", out var intent) && intent == DecorFreeze.ProcessOnly,
            "NIntent is frozen ProcessOnly (its churn is the _Process bob, not a tween)");

        // The counter's AnimIn/AnimOut are what the ProcessOnly mechanism protects — assert they still exist.
        var counter = ResolveGameType("NEnergyCounter");
        Assert(counter is not null && counter.GetMethod("AnimIn", Flags) is not null
                && counter.GetMethod("AnimOut", Flags) is not null,
            "NEnergyCounter still declares AnimIn/AnimOut (the self-bound position tweens the freeze must not pause)");
    }

    // The star counter must stay OUT of the policy entirely. Freezing its per-frame work froze the browser's star
    // COUNT: on screen a gain ramps the number up to its new total, and that ramp is the only writer of the count
    // label on the way up (a spend lands on it at once — which is why spending alone looked healthy), so a frozen
    // seat showed a stale count for the rest of the fight while the game's own window was right. Nothing is lost by
    // running it: the counter's ring spin is removed from the wire by the PRODUCER (spirectl's Sts2OrbSpinFold
    // divides the accumulated rotation back out to the authored rest), not by this freeze.
    //
    // The general rule this is one instance of — "no ProcessOnly type may own a value the mirror renders whose only
    // writer is that same per-frame path" — is NOT asserted mechanically, and deliberately. Both halves are beyond
    // reflection: which nodes the browser renders is a client-side fact, and "only writer" needs a transitive IL
    // walk of the game's own call graph (the per-frame path here reaches the label through a helper, so a one-level
    // scan would miss it). That analysis is brittle across game updates and is exactly the kind of internals
    // reconstruction that does not belong in a committed file, so the specific type is pinned instead.
    private static void TheStarCounterIsNeverFrozen()
    {
        Assert(!CouchCoopHeadlessVisualSuspender.DecorativeAnimatorTypes.ContainsKey("NStarCounter"),
            "NStarCounter must NOT be in the decorative-freeze policy — freezing it strands the browser's star "
            + "count at its pre-gain value (see the comment above this test, and in the policy table)");

        // A rename in the game would make the pin above vacuously true, so keep the name honest.
        Assert(ResolveGameType("NStarCounter") is not null,
            "NStarCounter still resolves against the installed STS2 assemblies (if the game renamed it, re-point "
            + "this pin at the new name rather than dropping it)");
    }

    private const BindingFlags Flags =
        BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly;

    // `_Process` is a virtual on Godot.Node; DeclaredOnly tells us the game type OVERRIDES it (rather than
    // inheriting the engine's no-op), which is exactly what the ProcessOnly mechanism switches off.
    private static bool OverridesProcess(string typeName)
        => ResolveGameType(typeName)?.GetMethod("_Process", Flags, null, [typeof(double)], null) is not null;

    // The policy keys are bare C# type NAMES (matching the runtime GetType().Name check). Scan the loaded STS2
    // assembly for a unique match rather than hardcoding namespaces, which have moved between game versions.
    private static Type? ResolveGameType(string typeName)
    {
        var sts2 = typeof(MegaCrit.Sts2.Core.Nodes.Audio.NAudioManager).Assembly;
        return Array.Find(sts2.GetTypes(), t => t.Name == typeName);
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessDecorativeFreezeTests] FAILED: {label}");
        }
    }
}
