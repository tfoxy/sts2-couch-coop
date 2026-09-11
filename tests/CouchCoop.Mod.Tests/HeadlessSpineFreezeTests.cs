using System.Reflection;
using CouchCoop.Mod.Session;

// Regression guard for the always-on SPINE freeze in CouchCoopHeadlessVisualSuspender.
//
// The bug (found while diagnosing why four creature spine anchors were 100% of an idle mirror wire): the freeze
// walk's gate was `node.ProcessMode != Disabled && LooksLikeSpine(node) && _spineFrozenIds.Add(id)`. The dedup set
// doubled as the GATE, so the walk froze each id exactly once ever. A spine node whose ProcessMode came back after
// that first pass was then skipped for the rest of the run — its skeleton kept deforming every frame, every bone/
// slot anchor under it kept writing a new transform, and the producer kept streaming them — while the log still
// counted the node as "held". Two ways in: anything that writes ProcessMode on a spine node after the first scan,
// and Godot ObjectDB instance-id recycling (a freed creature's id handed to a NEW node; the set is never swept of
// dead ids, so the new node inherits the old one's "already frozen" verdict).
//
// The fix makes the set a REPORTING set and re-asserts the freeze on every scan, exactly like the decorative
// walk's ProcessOnly branch has always done. These tests pin the property (and the SHAPE of the decision, whose
// signature can no longer even express "skip because we've seen this id") without needing a live scene tree.
internal static class HeadlessSpineFreezeTests
{
    public static void Run()
    {
        AnUnfrozenSpineNodeIsAlwaysFrozen();
        AnAlreadyFrozenNodeIsLeftAlone();
        NonSpineNodesAreNeverTouched();
        TheDecisionCannotDependOnHavingSeenTheNodeBefore();
    }

    // The whole point: the verdict does not change on the second, tenth or thousandth scan of the same node. If a
    // future edit reintroduces a "first time only" gate, this is what fails.
    private static void AnUnfrozenSpineNodeIsAlwaysFrozen()
    {
        for (var scan = 0; scan < 3; scan++)
        {
            Assert(
                CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze(alreadyDisabled: false, looksLikeSpine: true),
                $"a spine node found un-frozen on scan #{scan + 1} is frozen again "
                + "(the dedup set is a reporting set, never the gate)");
        }
    }

    // The cheap ProcessMode read is what keeps the re-assert free in the steady state: a node that is already
    // frozen is not re-written (and, in the walk, never even reaches the native GetClass probe).
    private static void AnAlreadyFrozenNodeIsLeftAlone()
        => Assert(
            !CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze(alreadyDisabled: true, looksLikeSpine: true),
            "an already-frozen spine node is not re-written");

    private static void NonSpineNodesAreNeverTouched()
    {
        Assert(
            !CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze(alreadyDisabled: false, looksLikeSpine: false),
            "a non-spine node is never frozen by the spine walk");
        Assert(
            !CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze(alreadyDisabled: true, looksLikeSpine: false),
            "a non-spine node is never frozen by the spine walk, however its ProcessMode reads");
    }

    // The structural half of the guard: the decision takes the node's LIVE state and nothing else. A parameter
    // meaning "we have frozen this id before" is exactly what made the freeze one-shot, so its absence is the fix.
    private static void TheDecisionCannotDependOnHavingSeenTheNodeBefore()
    {
        var method = typeof(CouchCoopHeadlessVisualSuspender)
            .GetMethod(nameof(CouchCoopHeadlessVisualSuspender.ShouldAssertSpineFreeze),
                BindingFlags.Public | BindingFlags.Static);
        Assert(method is not null, "ShouldAssertSpineFreeze is the spine walk's decision seam");

        var names = Array.ConvertAll(method!.GetParameters(), p => p.Name ?? string.Empty);
        Assert(names.Length == 2, $"ShouldAssertSpineFreeze takes exactly the two live facts (got: {string.Join(", ", names)})");
        Assert(
            Array.TrueForAll(names, n => !n.Contains("seen", StringComparison.OrdinalIgnoreCase)
                                         && !n.Contains("already", StringComparison.OrdinalIgnoreCase)
                                         || n == "alreadyDisabled"),
            $"no 'have we seen this id' input may gate the freeze (parameters: {string.Join(", ", names)})");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessSpineFreezeTests] FAILED: {label}");
        }
    }
}
