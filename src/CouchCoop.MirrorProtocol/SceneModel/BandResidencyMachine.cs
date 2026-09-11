namespace CouchCoop.MirrorProtocol.SceneModel;

using System.Collections.Generic;

// WS-BGBAKE round 3: the PURE band-bake drain-residency decision, hoisted out of the Godot StaticBake controller so
// the controller and the replay-driven residency test exercise the SAME logic verbatim (no more "the unit test
// passed but the controller's inline copy diverged"). Two phases, mirroring the controller's drain flow:
//
//   1. EvaluateStructure — the pre-watch-scan verdict for a drain's STRUCTURAL facts (keyframe / order change),
//      using the planner's projected order guard. A keyframe whose band prefix AND watched content are unchanged
//      SURVIVES outright (loop restart / resync = zero visible change); band-intact-but-content-touched retains
//      (invisible rebake); a band-structure change drops. An OrderChanged drain whose projected band prefix is
//      untouched proceeds (the caller counts the skip), anything else tears down.
//   2. EvaluateCulprits — the post-watch-scan verdict for the culprit sets (changed ids / hint targets that hit
//      some region's watch), via BandInvalidationPolicy. This phase OWNS the planner bench registrations (member
//      room-bench on BenchAndTeardown; non-spine-carrier subtree bench on any teardown), so a caller can never
//      tear down without the learning strikes being recorded.
//
// The machine holds only reusable scratch + the planner reference; all Godot-side lookups (baked-member / spine-
// carrier / change flags) arrive as delegates. The drain-window thrash registration stays with the caller (it is
// shared with the exact-path flow).
public sealed class BandResidencyMachine
{
    public enum StructureVerdict
    {
        Proceed,             // no structural objection — run the watch scan
        ProceedOrderSkipped, // ditto, and the order guard just absorbed an OrderChanged (caller counts the skip)
        Teardown,            // band-order change — the bake is misplaced (retain-class for the caller)
        KeyframeSurvive,     // C3: keyframe with the band prefix AND every watched id unchanged — the bake stands
        KeyframeRetain,      // C3: keyframe, band prefix intact but watched content changed — invisible rebake
        KeyframeDrop,        // C3: keyframe changed the band structure (a real room change) / survival unsupported
    }

    public enum CulpritVerdict
    {
        Survive,          // no culprit touched a cloned id — the bake stands untouched
        Follow,           // Transform-only spine-carrier moves — caller retransforms the quads (teardown on failure)
        BenchAndTeardown, // baked-member culprits — member bench strikes REGISTERED; caller tears down
        Teardown,         // unfollowable culprits — subtree bench strikes registered (if any); caller tears down
    }

    private readonly StaticBakePlanner _planner;
    private readonly HashSet<string> _benchIds = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _subtreeBenchIds = new(System.StringComparer.Ordinal);

    public BandResidencyMachine(StaticBakePlanner planner)
    {
        _planner = planner;
    }

    // The bench sets the LAST EvaluateCulprits classified (already registered with the planner) — for diagnostics.
    public IReadOnlyCollection<string> LastBenchIds => _benchIds;

    public IReadOnlyCollection<string> LastSubtreeBenchIds => _subtreeBenchIds;

    public StructureVerdict EvaluateStructure(
        MirrorState state,
        bool keyframe,
        bool orderChanged,
        IReadOnlyList<string> bandIds,
        IReadOnlyList<string>? excludedRoots,
        bool keyframeSurvivalSupported = false,
        System.Func<string, bool>? isWatched = null)
    {
        if (keyframe)
        {
            // C3 keyframe survival. A loop restart / resync re-sends the SAME scene: if (a) survival is supported
            // (KEYDIFF path — a FullRebuild resets the suppress bits and z overrides, so stale quads would
            // double-draw), (b) the PROJECTED band prefix is unchanged, and (c) the keyframe's value-classified
            // changes (planner ObserveDrain already ran for this drain) reach NO watched id — the bake simply
            // stands: zero visible change at the seam. Band prefix intact but watched content touched ⇒ invisible
            // retain-class rebake; band structure changed (a real room change) ⇒ drop.
            if (!keyframeSurvivalSupported || isWatched is null)
            {
                return StructureVerdict.KeyframeDrop;
            }

            if (!_planner.IsBandOrderUnchanged(state, bandIds, excludedRoots))
            {
                return StructureVerdict.KeyframeDrop;
            }

            foreach (var id in _planner.LastKeyframeChangedIds)
            {
                if (isWatched(id))
                {
                    return StructureVerdict.KeyframeRetain;
                }
            }

            return StructureVerdict.KeyframeSurvive;
        }

        if (orderChanged)
        {
            // The projected order guard: z≥0 reshuffles and churn INSIDE excluded live subtrees are invisible; any
            // change to the projected band prefix itself is fatal.
            return _planner.IsBandOrderUnchanged(state, bandIds, excludedRoots)
                ? StructureVerdict.ProceedOrderSkipped
                : StructureVerdict.Teardown;
        }

        return StructureVerdict.Proceed;
    }

    public CulpritVerdict EvaluateCulprits(
        IReadOnlyCollection<string> changedCulprits,
        IReadOnlyCollection<string> hintCulprits,
        System.Func<string, NodeChangeFlags> flagsOf,
        System.Func<string, bool> isBakedMember,
        System.Func<string, bool> isSpineCarrier)
    {
        _benchIds.Clear();
        _subtreeBenchIds.Clear();
        if (changedCulprits.Count == 0 && hintCulprits.Count == 0)
        {
            return CulpritVerdict.Survive;
        }

        var decision = BandInvalidationPolicy.Classify(
            changedCulprits, hintCulprits, flagsOf, isBakedMember, isSpineCarrier, _benchIds, _subtreeBenchIds);

        // Subtree exile learning happens on EVERY teardown-class verdict (the policy only ever emits NON-spine
        // carriers here); member bench strikes only on the member verdict. Registration lives HERE so no caller can
        // tear down while forgetting the strikes.
        switch (decision)
        {
            case BandDrainDecision.None:
                return CulpritVerdict.Survive;

            case BandDrainDecision.Follow:
                return CulpritVerdict.Follow;

            case BandDrainDecision.BenchAndTeardown:
                if (_benchIds.Count > 0)
                {
                    _planner.RegisterBandInvalidation(_benchIds);
                }

                if (_subtreeBenchIds.Count > 0)
                {
                    _planner.RegisterBandSubtreeInvalidation(_subtreeBenchIds);
                }

                return CulpritVerdict.BenchAndTeardown;

            default:
                if (_subtreeBenchIds.Count > 0)
                {
                    _planner.RegisterBandSubtreeInvalidation(_subtreeBenchIds);
                }

                return CulpritVerdict.Teardown;
        }
    }
}
