namespace CouchCoop.MirrorProtocol.SceneModel;

using System.Collections.Generic;

// Track-D/P static background pre-composite ("static bake") — the PURE-C# eligibility + prefix planner (Godot-free,
// Exe-testable, exactly like CullIndex). The phone is GPU fill-bound inside the design-res raster and ~33% of scene
// fill is background/room/floor that is ~80% static; this planner decides WHICH bottom-most run of the painter's
// order can be replaced by ONE pre-composited quad, and the StaticBake controller (Godot side) builds/swaps the bake.
//
// Track-P (z-aware): the render order is NOT the raw pre-order DFS — a node's ZIndex re-sorts it. Godot paints in
// EFFECTIVE-Z order (the sum of ZIndex down the ancestor chain, ZAsRelative defaulting true), ties broken by pre-order
// (a stable sort of the pre-order by effZ). Combat streams its whole background under a single zIndex:-10 container, so
// ~276 nodes inherit effZ -10 (the "background band"): they paint UNDER the z=0 gameplay layer even though pre-order
// interleaves them. v1 refused any non-zero-z node outright, so it baked nothing. v2 builds the real paint order,
// bakes its bottom-most eligible PREFIX, and draws the quad at that prefix's boundary z (QuadZ) so the live z<0
// leftovers (atmosphere particles etc.) still sort correctly against it.
//
// A prefix of the PAINT order is NOT ancestor-closed (a baked z=-10 band sits below its own z=0 parent group in paint
// order). So a baked node's ancestors that fall OUTSIDE the prefix become CARRIERS: structural clones the controller
// builds (transform/modulate/clip cascade) but does NOT self-paint or suppress in the live tree. The plan therefore
// yields BakedIds (the prefix — self-paint suppressed live + fully cloned), CarrierIds (ancestors cloned as pure
// scaffolding), a BuildOrder (baked ∪ carriers, pre-order so a clone's parent is always built first), and QuadZ.
//
// CONSERVATIVE by construction (any uncertainty ⇒ ineligible ⇒ the prefix ends below the node): a missed bake only
// forgoes a fill win; a wrong bake shows stale/mis-composited pixels. Every per-node rule errs toward NOT baking.
//
// This class owns ONLY the math + the stability/thrash bookkeeping. The per-view "dynamically owned" facts
// (TweenOwns* / an "__anim" cosmetic ticker / a non-zero input lift / a not-yet-decoded texture) live on the Godot
// MirrorNodeView, so the controller collects them into `dynamicallyExcluded` and hands them in; the per-shader "may
// be baked in Static mode" facts live on the Godot ShaderStore, collected into `effectStaticOk`. The planner never
// reaches into Godot. Reuses CullBounds.OfRect / DesignAabb for the coverage math.
public sealed class StaticBakePlanner
{
    // The design rect is ALWAYS 1080 tall (StageStretch.DesignHeight); the width widens with the spread factor.
    public const double DesignHeight = CullIndex.DesignHeight;

    // Godot's ZIndex is clamped to ±4096; the quad's ZIndex is clamped by the controller, but pin the constant here.
    public const int MaxZIndex = 4096;

    // ---- stability window (a node must sit still this long before it may be baked) -------------------------------
    // BOTH clauses must clear. The frames clause exists because --replay applies EVERYTHING in ONE drain (so a pure
    // drain count can never advance past 1 there) and idle screens (map/shop) stop draining entirely: when the whole
    // scene has been drain-quiet for MinStableFrames, the drains clause is satisfied by that global quiescence (see
    // Stable). In live combat, drains keep arriving, so a node must survive MinStableDrains non-touching drains —
    // real quiescence, not just wall-clock. Tween-hint targets count as a change (they animate).
    public const int MinStableDrains = 10;
    public const int MinStableFrames = 20;

    // ---- budget gate (don't bake a trivial run — the quad + bake viewport cost must pay for itself) ---------------
    public const int MinPaintingNodes = 10;
    public const double MinCoverageFactor = 1.25; // Σ clamped design-space paint areas ≥ 1.25 × design area

    // ---- Track-P3 multi-region (bake static segments AROUND same-bucket interleaved particles) --------------------
    // v2 baked ONE contiguous bottom prefix and stopped at the first particle. In combat the z=-10 background band is
    // PARTICLE-INTERLEAVED (~22 particle groups threaded through ~145 static painters), so the prefix collapses to ~4
    // nodes and never reaches budget. v3 keeps the interleaved particles LIVE (exact — a frozen particle can't be
    // reordered or re-cloned faithfully; both were measured wrong at ~600-800k px vs a 15k jitter floor) and bakes the
    // static SEGMENTS between them into separate quads. Correctness = paint-order preservation: the whole band (baked
    // segment quads + the live painters between them) is re-leveled to a dense run of DISTINCT absolute z values BELOW
    // the band's bucket z (so still under the creatures/gameplay that sit at the bucket z and above), in the exact live
    // paint order — draw order is therefore byte-identical, only the integer z labels are spread apart. A live painter
    // between two baked segments composites between their quads because its absolute z lands between theirs.
    //
    // Multi-region ONLY activates when the v2 prefix ends at a PARTICLE in the bottom bucket (spine/intent/shader/
    // dynamic boundaries fall through to v2 unchanged — this is why every v2 test, none of which has a particle
    // boundary, plans identically).

    // Cap on baked segments (each is a bake viewport + quad — VRAM/setup cost). Segments beyond the cap, and segments
    // below MinPaintersPerRegion, stay LIVE (still z-re-leveled so order is preserved — they just aren't pre-composited).
    public const int MaxRegions = 6;

    public const int MinPaintersPerRegion = 3; // a 1-2 painter segment isn't worth its own viewport — leave it live

    // ---- WS-ADDBAKE: alpha-preserving additive clone (Add joins region membership everywhere) ---------------------
    // v3/v3b kept every non-Mix painter (and every Add-blend shader) OUT of upper regions (bottomOnly) because a
    // premult "over" quad can't reproduce a RAW additive draw sitting above a live particle, and the v3b add sub-quad
    // (one hoisted Add suffix per region) couldn't reproduce the add/occluder interleave either (AE≈107k). WS-ADDBAKE
    // bakes the Add content INTO the SAME region quad as the mix content via an alpha-preserving additive clone: the
    // Add clone renders in the bake viewport with `blend_premul_alpha` + a fragment epilogue (COLOR.rgb *= COLOR.a;
    // COLOR.a = 0.0;), so its bake texel is (rgb*a, 0) — under PMALPHA that accumulates rgb WITHOUT touching dst alpha,
    // and the region's premult-over composite of an add-only texel IS a true add (the micro-leg proved the identity
    // closes to RGBA8 rounding, including the (1-a_mix) attenuation of an earlier add by a later mix in the region).
    //
    // So Add is NO LONGER bottom-only: a plain-Add painter and a REWRITABLE cleared Add-blend shader are ordinary
    // region members, baked in any region (region 0 included — raw-Add there was only accidentally correct over opaque
    // mix; the variant is correct unconditionally). The controller applies the variant to Add clones. `bottomOnlyIds`
    // now holds ONLY Sub/Mul painters + UN-rewritable Add-blend shaders (containment: they stay live/re-leveled, never
    // baked raw). The v3b add-partition split + the separate add quad are DELETED.

    // ---- Track-P3c per-region isolation (position-stable z + per-region invalidation) -----------------------------
    // v3 re-leveled the band to a DENSE run of z (baseZ = bucketZ − slotCount): removing/rebaking any one slot shifts
    // EVERY other slot's z by one, so the whole band must rebake as a unit. v3c assigns each slot a POSITION-STABLE z
    // (z = bucketZ − (N − paintPos)): distinct, strictly increasing with paint order, all below bucketZ — but a slot's
    // z depends ONLY on its own paint position + the (structure-invariant) node count, so tearing down the top of the
    // band leaves every lower slot's z untouched. That lets the controller release a top-suffix of the band (an upper
    // region churned) and keep the stable bottom regions baked, byte-identically.

    // ---- Track-P3c band-scoped stability relax --------------------------------------------------------------------
    // Live combat never stabilizes the background band under the STRICT window (creature/VFX churn keeps arriving), so
    // combat can't bake live. The band (effZ == bucketZ, the bottom bucket that paints under gameplay) is exactly the
    // static fill we want; RELAX its stability window (halve both clauses) so it settles ~2× sooner, WITHOUT touching
    // the strict window for gameplay-bucket nodes, dynamically-excluded (tween/anim/lift) nodes, or CARRIER ancestors
    // (a carrier is structural scaffolding above the band — it must be fully settled to clone faithfully).

    // Halved window for background-bucket nodes. Carriers + non-bucket nodes keep Min*Stable*.
    public const int MinStableDrainsBand = MinStableDrains / 2;
    public const int MinStableFramesBand = MinStableFrames / 2;

    // ---- WS-BGBAKE band flatten (per-room combat background bake) -------------------------------------------------
    // The exact planners above end the bakeable band at the FIRST non-particle blocker, so live combat's ~65-way
    // additive-interleaved z<0 band (shaders/spines/intents threaded through the static parallax layers) never bakes
    // (bakeState=Idle in 23/26 measured device configs). PlanBandFlatten trades exact mid-band ordering for fill:
    // interlopers do NOT end the band — every eligible static painter below the LAST live interloper merges into ONE
    // flatten quad (A), the trailing static run above it (the Foreground) into a second exact quad (B), and the live
    // interlopers re-level between them. The only approximation: an interloper that had static painters above it now
    // draws above that static (faint fog/glow rises through mid layers — measured cheap, gated by the fidelity loop).
    // Budget: ≥ BandMinPainters painters total and clamped coverage ≥ (base + perExtra·(regions−1)) design-areas, so
    // each quad's own screen of fill is paid for. bucketZ ≥ 0 (spine-background families) refuses — the caller falls
    // back to the exact Plan() path, which is also the fallback for every refusal here.
    public const int BandMinPainters = 6;
    public const double BandMinCoverageFactor = 1.0;
    public const double BandCoveragePerExtraRegion = 0.5;

    // WS-BGBAKE round 3 (ordering-exact segmentation): a segment becomes its own region quad only when its clamped
    // coverage pays for the quad's own screen of fill. Runs below EITHER per-region gate (MinPaintersPerRegion /
    // this) demote to live-at-their-slots — no quad, ordering exact, zero fill overhead.
    public const double BandRegionMinCoverageFactor = 1.25;

    // ---- thrash guard (an id that keeps invalidating an active bake is benched so map-scroll can't rebake-storm) --
    public const int ThrashStrikeLimit = 2;    // strikes within the window ⇒ bench
    public const int ThrashWindowDrains = 30;  // strikes older than this reset the counter
    public const int ThrashCooldownDrains = 30; // benched for this many drains

    // ---- WS-BGBAKE room bench (band-plan repeat offenders exiled for the ROOM, not a drain window) -----------------
    // The drain-window thrash guard above can never catch combat's slow-cadence offenders: the wave banner
    // (NinePatchRect Draw + MegaLabel Text + a fade tween hint) redraws every ~9s, far outside ThrashWindowDrains
    // (~sub-second), so it re-baked and re-tore the band forever. Band invalidations therefore get a SECOND bench,
    // scoped to the room: strikes accumulate per room epoch (a keyframe = room change resets them), and the SECOND
    // strike exiles the id until the next room — it becomes a live re-leveled interloper in every later band plan of
    // this room. The controller registers ONLY painting BAKED MEMBERS here (never carriers/ancestors — see
    // BandInvalidationPolicy), and the bench is deliberately NOT consulted by the ancestor gate (AncestorStaticReason),
    // so even a mis-registered ancestor could only lose its own self-paint, never reject the band under it. The
    // exact path's RegisterInvalidation/thrash guard is untouched.
    public const int RoomBenchStrikeLimit = 2;

    // Retreat lever: if the AE=0 corpus gate ever fails on a non-Mix blend, flip this true to bake ONLY default
    // (Mix) blend nodes. Premultiplied "over" onto the transparent bake buffer is associative for Add/Sub/Mul at the
    // BOTTOM of the paint order (nothing is under them), so all four are allowed by default (verified by the gate).
    // static readonly (not const) so the retreat branch in BlendOk doesn't read as unreachable code.
    public static readonly bool RestrictToMixBlend = false;

    // Track-P retreat lever: a `MaterialRef` (a custom `.tres` material reference) is NEVER consumed by the native
    // renderer — MaterialResolver only ever resolves a mounted ShaderAttachment or a CanvasBlendMode BlendMaterial,
    // and a MaterialRef-only node has neither. So a MaterialRef-only node renders as PLAIN base art in every effect
    // mode and is legitimately bakeable. Flip false to fall back to the conservative v1 treatment (MaterialRef ⇒
    // ineligible) if a future producer ever starts honoring MaterialRef natively. static readonly so the guarded
    // branch never reads as unreachable.
    public static readonly bool AllowMaterialRef = true;

    private readonly struct Stability
    {
        public readonly long LastChangeFrame;
        public readonly long LastChangeDrain;

        public Stability(long frame, long drain)
        {
            LastChangeFrame = frame;
            LastChangeDrain = drain;
        }
    }

    private readonly struct Thrash
    {
        public readonly int Strikes;
        public readonly long LastStrikeDrain;
        public readonly long BenchedUntilDrain;

        public Thrash(int strikes, long lastStrikeDrain, long benchedUntilDrain)
        {
            Strikes = strikes;
            LastStrikeDrain = lastStrikeDrain;
            BenchedUntilDrain = benchedUntilDrain;
        }
    }

    private readonly Dictionary<string, Stability> _stability = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, Thrash> _thrash = new(System.StringComparer.Ordinal);

    // WS-BGBAKE round 3 keyframe stability preservation: the planner's OWN per-id prior-node snapshots (instances —
    // the applier replaces node objects, never mutates them). MirrorState.ChangeFlags is USELESS on a keyframe
    // (Nodes.Clear() makes every upsert classify New|StructuralAll), so a loop restart / resync keyframe used to
    // wipe ALL stability and force a full re-settle + re-bake (~1.3s of raw scene per seam). With priors retained,
    // the keyframe branch value-compares each id via NodeChangeDiffer.ClassifyKeyframe: an UNCHANGED node KEEPS its
    // stability entry (the immediate re-plan is identical → the controller can keep/rebuild the bake seamlessly);
    // changed/new ids stamp, vanished ids prune. Pure and KEYDIFF-independent.
    private readonly Dictionary<string, MirrorNode> _lastSeen = new(System.StringComparer.Ordinal);

    // The ids the LAST keyframe drain re-stamped (value-compared changed / brand-new / hint-targeted) — the C3
    // keyframe-survival gate intersects this with the bake's watched ids: empty intersection ⇒ the keyframe changed
    // nothing the bake depends on ⇒ the bake can SURVIVE the seam outright. Rebuilt on every keyframe drain.
    private readonly HashSet<string> _lastKeyframeChanged = new(System.StringComparer.Ordinal);

    public IReadOnlyCollection<string> LastKeyframeChangedIds => _lastKeyframeChanged;

    // WS-BGBAKE room bench: per-room strike counts. The room boundary is a SCREEN-TYPE change (combat → rewards →
    // combat …), NOT a keyframe: a mid-room resync/reconnect keyframe (or a looping replay harness) re-sends the same
    // scene with the same ids, and wiping the bench there would un-exile the wave banner and re-learn its 2 strikes
    // every time. Node ids are instance-scoped, so a REAL new room's nodes never collide with stale entries anyway;
    // the screen-type clear (plus a size cap) is just hygiene. An id with RoomBenchStrikeLimit strikes is exiled to a
    // live interloper for the rest of the room (see the section comment).
    private readonly Dictionary<string, int> _roomBenchStrikes = new(System.StringComparer.Ordinal);

    // WS-BGBAKE SUBTREE bench: per-room strike counts for NON-SPINE CARRIERS whose watch hits keep tearing the band
    // down (the enemy "Intents" HBoxContainer: exiled as a member, it kept scaffolding a couple of bakeable children
    // as a CARRIER — and its per-action modulate fade hint is a hint-on-carrier ⇒ Teardown forever). The second
    // strike exiles the carrier's WHOLE SUBTREE: PlanBandFlatten refuses any member candidate that is, or descends
    // from, a subtree-benched id, so the fading group re-levels live wholesale and its hints stop hitting the watch.
    // SAFETY: only ever registered for NON-spine carriers (never an ancestor of ALL members — BandInvalidationPolicy
    // filters), so the blast radius is that carrier's own subtree; it can never reject the band itself. The
    // semantics are correct by construction: a subtree that fades as a unit cannot be baked into a static quad.
    // Shares the room boundary + cap hygiene of _roomBenchStrikes exactly.
    private readonly Dictionary<string, int> _roomBenchSubtreeStrikes = new(System.StringComparer.Ordinal);

    private string? _roomBenchScreenType;
    private string? _roomBenchCandidateType;
    private int _roomBenchCandidateDrains;
    private const int RoomBenchMapCap = 256;

    // A screen-type change must PERSIST this many observed drains before it counts as a room change: transition
    // flickers and a looping replay's single leading "run" delta must not clear the bench. A real room change
    // (rewards/map screens live for seconds) crosses this within a fraction of a second.
    public const int RoomChangeDebounceDrains = 20;

    // Scratch reused across Plan calls (avoid per-eval allocation).
    private readonly Dictionary<string, List<string>> _childrenByParent = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _members = new(System.StringComparer.Ordinal);

    // Track-P paint-order scratch (rebuilt each Plan): the live-filtered pre-order, its per-id pre-order index, the
    // effective-z per id, the effZ-sorted paint order, and per-id paint position.
    private readonly List<string> _liveOrder = new();
    private readonly List<string> _paintOrder = new();
    private readonly Dictionary<string, int> _preIdx = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, int> _effZ = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, int> _paintPos = new(System.StringComparer.Ordinal);
    // Memoized "first non-static ancestor" reason for the CheckAncestors chain (stable/dynamic/thrash only — the clip
    // check depends on the descendant's own effZ, so it is not memoized). Cleared each Plan.
    private readonly Dictionary<string, BakeReject> _ancestorStatic = new(System.StringComparer.Ordinal);
    // Baked/carrier working sets (rebuilt each Plan).
    private readonly HashSet<string> _bakedSet = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _carrierSet = new(System.StringComparer.Ordinal);

    private readonly System.Comparison<string> _paintComparer;
    private readonly System.Comparison<string> _preOrderComparer;

    private long _frame;         // ObserveFrame tick count
    private long _drain;         // ObserveDrain (applied-drain) count
    private long _lastDrainFrame; // _frame at the last ObserveDrain — drives the drain-quiescence bypass
    private int _bucketZ;        // effZ of paint-order slot 0 (the bottom bucket) — set each Plan; drives the band relax

    public StaticBakePlanner()
    {
        // effZ-ascending, pre-order-tiebreak — the exact Godot paint order (a stable sort of the pre-order by effZ).
        _paintComparer = (a, b) =>
        {
            int za = _effZ[a], zb = _effZ[b];
            if (za != zb)
            {
                return za.CompareTo(zb);
            }

            return _preIdx[a].CompareTo(_preIdx[b]);
        };
        _preOrderComparer = (a, b) => _preIdx[a].CompareTo(_preIdx[b]);
    }

    // Diagnostics from the LAST Plan call (why the prefix ended where it did) — surfaced by the controller for the
    // soak / M3_WALK so "nothing baked" is explainable without a debugger.
    public StaticBakeDiagnostic LastDiagnostic { get; private set; }

    // Advance the wall-clock frame counter. Called once per controller _Process, EVERY frame (even with no drain),
    // so replay + idle screens accumulate frame-stability toward a bake.
    public void ObserveFrame() => _frame++;

    // Record a drain: bump the drain clock, stamp every changed / hint-target id as "just changed" (resets its
    // stability), initialise brand-new ids, and prune ids whose node vanished. A keyframe re-stamps the whole tree
    // (a fresh scene is stable-from-now). Call from the controller's OnDrained BEFORE any Plan reads stability.
    public void ObserveDrain(
        MirrorState state,
        IReadOnlySet<string> changedIds,
        IReadOnlyCollection<string> hintTargetIds,
        bool keyframe)
    {
        _drain++;
        _lastDrainFrame = _frame;

        // WS-BGBAKE room bench boundary: the SCREEN TYPE changing — and STAYING changed for the debounce window — is
        // the room change (see the field comments — a keyframe is NOT: resyncs and looping replays keyframe mid-room
        // and must not un-exile learned offenders; nor is a 1-delta transition blip).
        var screenType = state.ScreenType;
        if (string.Equals(screenType, _roomBenchScreenType, System.StringComparison.Ordinal))
        {
            _roomBenchCandidateType = null;
            _roomBenchCandidateDrains = 0;
        }
        else
        {
            _roomBenchCandidateDrains =
                string.Equals(screenType, _roomBenchCandidateType, System.StringComparison.Ordinal)
                    ? _roomBenchCandidateDrains + 1
                    : 1;
            _roomBenchCandidateType = screenType;
            if (_roomBenchCandidateDrains >= RoomChangeDebounceDrains)
            {
                _roomBenchScreenType = screenType;
                _roomBenchCandidateType = null;
                _roomBenchCandidateDrains = 0;
                RoomEpoch++;
                _roomBenchStrikes.Clear();
                _roomBenchSubtreeStrikes.Clear();
            }
        }

        if (_roomBenchStrikes.Count > RoomBenchMapCap)
        {
            _roomBenchStrikes.Clear(); // hygiene backstop — stale instance-scoped ids can never recur anyway
        }

        if (_roomBenchSubtreeStrikes.Count > RoomBenchMapCap)
        {
            _roomBenchSubtreeStrikes.Clear(); // same backstop
        }

        if (keyframe)
        {
            // Round 3: a keyframe re-sends the scene, but it is usually the SAME scene (loop restart / resync). An
            // id whose retained prior value-compares identical (ClassifyKeyframe == None) KEEPS its stability entry;
            // anything changed / brand-new stamps just-changed; vanished ids prune (with their bench/thrash state).
            List<string>? stale = null;
            foreach (var id in _stability.Keys)
            {
                if (!state.Nodes.ContainsKey(id))
                {
                    (stale ??= new List<string>()).Add(id);
                }
            }

            if (stale is not null)
            {
                foreach (var id in stale)
                {
                    _stability.Remove(id);
                    _thrash.Remove(id);
                    _roomBenchStrikes.Remove(id);
                    _roomBenchSubtreeStrikes.Remove(id);
                }
            }

            _lastKeyframeChanged.Clear();
            foreach (var (id, node) in state.Nodes)
            {
                bool unchanged = _stability.ContainsKey(id)
                    && _lastSeen.TryGetValue(id, out var prior)
                    && NodeChangeDiffer.ClassifyKeyframe(prior, node) == NodeChangeFlags.None;
                if (!unchanged)
                {
                    _stability[id] = new Stability(_frame, _drain);
                    _lastKeyframeChanged.Add(id);
                }
            }

            foreach (var id in hintTargetIds)
            {
                if (state.Nodes.ContainsKey(id))
                {
                    _lastKeyframeChanged.Add(id); // an armed tween target will move — treat as changed at the seam
                }
            }

            // Re-seed the priors wholesale (the keyframe's fresh instances are the next comparison baseline).
            _lastSeen.Clear();
            foreach (var (id, node) in state.Nodes)
            {
                _lastSeen[id] = node;
            }

            StampHintTargets(state, hintTargetIds); // an armed tween target is mid-animation even across a keyframe
            PruneThrashToLive(state);
            return;
        }

        foreach (var id in changedIds)
        {
            if (state.Nodes.TryGetValue(id, out var node))
            {
                _stability[id] = new Stability(_frame, _drain);
                _lastSeen[id] = node; // keep the prior snapshot current (instances are replaced, never mutated)
            }
            else
            {
                _stability.Remove(id); // removed this drain
                _thrash.Remove(id);
                _roomBenchStrikes.Remove(id);
                _roomBenchSubtreeStrikes.Remove(id);
                _lastSeen.Remove(id);
            }
        }

        StampHintTargets(state, hintTargetIds);
    }

    private void StampHintTargets(MirrorState state, IReadOnlyCollection<string> hintTargetIds)
    {
        foreach (var id in hintTargetIds)
        {
            if (state.Nodes.ContainsKey(id))
            {
                _stability[id] = new Stability(_frame, _drain); // an armed tween target is mid-animation → not stable
            }
        }
    }

    // Register the ids that just invalidated an ACTIVE bake (the controller passes ChangedIds ∩ baked-prefix). Two
    // strikes inside the window bench the id for ThrashCooldownDrains drains, so a node that keeps churning (map
    // scroll edge, a flickering counter) can never anchor a bake — the prefix simply ends below it.
    public void RegisterInvalidation(IEnumerable<string> culpritIds)
    {
        foreach (var id in culpritIds)
        {
            _thrash.TryGetValue(id, out var t);
            int strikes = (_drain - t.LastStrikeDrain) <= ThrashWindowDrains ? t.Strikes + 1 : 1;
            long benchedUntil = t.BenchedUntilDrain;
            if (strikes >= ThrashStrikeLimit)
            {
                benchedUntil = _drain + ThrashCooldownDrains;
                strikes = 0; // consumed — start a fresh window after the bench expires
            }

            _thrash[id] = new Thrash(strikes, _drain, benchedUntil);
        }
    }

    // WS-BGBAKE room bench: register the baked-MEMBER culprits of a band-bake invalidation. Strikes accumulate for
    // the current room only (ObserveDrain's keyframe branch resets them); the second strike within the room exiles
    // the id — Eligibility rejects it, so the next band plan re-levels it as a LIVE interloper instead of re-baking
    // and re-tearing forever. Callers MUST pass only ids that were actually baked members (never carriers — the
    // controller filters via BandInvalidationPolicy). The exact path's thrash guard is a separate mechanism.
    public void RegisterBandInvalidation(IEnumerable<string> culpritIds)
    {
        foreach (var id in culpritIds)
        {
            _roomBenchStrikes.TryGetValue(id, out var strikes);
            _roomBenchStrikes[id] = strikes + 1;
        }
    }

    // True when the id has struck out for this room (see RegisterBandInvalidation).
    public bool IsRoomBenched(string id) =>
        _roomBenchStrikes.TryGetValue(id, out var strikes) && strikes >= RoomBenchStrikeLimit;

    // WS-BGBAKE subtree bench: register the NON-SPINE CARRIER culprits of a band-bake invalidation (the controller
    // filters via BandInvalidationPolicy — a spine carrier or a baked member is NEVER passed here). Same 2-strike /
    // room-boundary rule as RegisterBandInvalidation, but the exile applies to the carrier's WHOLE SUBTREE: the next
    // band plan refuses every member candidate at or under a benched id, so a group that animates as a unit (the
    // fading enemy-intent row) re-levels live wholesale and stops scaffolding anything into the quads.
    public void RegisterBandSubtreeInvalidation(IEnumerable<string> culpritIds)
    {
        foreach (var id in culpritIds)
        {
            _roomBenchSubtreeStrikes.TryGetValue(id, out var strikes);
            _roomBenchSubtreeStrikes[id] = strikes + 1;
        }
    }

    // True when the id's SUBTREE has struck out for this room (see RegisterBandSubtreeInvalidation).
    public bool IsRoomBenchedSubtree(string id) =>
        _roomBenchSubtreeStrikes.TryGetValue(id, out var strikes) && strikes >= RoomBenchStrikeLimit;

    // Diagnostics.
    public long DrainCount => _drain;
    public long FrameCount => _frame;

    // WS-BGBAKE room bench: bumps on every keyframe (= room change) — the epoch the room bench is scoped to.
    public long RoomEpoch { get; private set; }

    // Classify EVERY paint-order node by its per-node eligibility (independent of the prefix boundary) — the coverage
    // probe tallies this into a per-scene "rejected by reason" histogram. Pure; rebuilds the paint order + bucketZ like
    // Plan does, so a caller can run it right before/after Plan on the same state.
    public IReadOnlyList<(string Id, BakeReject Reason)> ClassifyPaintOrder(
        MirrorState state,
        GlobalTransformIndex transforms,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> effectStaticOk)
    {
        BuildPaintOrder(state);
        _ancestorStatic.Clear();
        var result = new List<(string, BakeReject)>(_paintOrder.Count);
        if (_paintOrder.Count == 0)
        {
            return result;
        }

        _bucketZ = _effZ[_paintOrder[0]];
        foreach (var id in _paintOrder)
        {
            var node = state.Nodes[id];
            result.Add((id, Eligibility(id, node, state, transforms, dynamicallyExcluded, effectStaticOk)));
        }

        return result;
    }

    // Compute the bake plan NOW: the trimmed bottom-most eligible prefix of the effective-Z PAINT order, plus the
    // ancestor carriers needed to clone it faithfully, or None. `designWidth` is the widened design width
    // (1920·spreadFactor); `dynamicallyExcluded` are the ids the controller marked live-owned (tween / anim ticker /
    // input lift / unsettled texture); `effectStaticOk` are the ShaderId ids the controller cleared for Static-mode
    // baking (mounted, allowed blend class, screen-read policy satisfied). Pure — no side effects on planner state.
    // `bottomOnlyIds` (WS-ADDBAKE): ids that can bake at the paint-order BOTTOM but not in an upper region — Sub/Mul
    // painters and UN-rewritable Add-blend shaders (a Sub/Mul draw, or an add shader whose bake-add rewrite failed, is
    // not reproducible by a premult "over" quad above a re-leveled live particle). A bottom-only id may bake in region
    // 0 only; in any upper region it stays LIVE (re-leveled). Plain-Add painters and REWRITABLE cleared Add-blend
    // shaders are NOT here — they are ordinary region members baked via the alpha-preserving variant. Null ⇒ empty
    // (the v2 single-region path never consults it — a prefix is the bottom, so all its blends are already safe).
    public StaticBakePlan Plan(
        MirrorState state,
        GlobalTransformIndex transforms,
        double designWidth,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> effectStaticOk,
        IReadOnlySet<string>? bottomOnlyIds = null)
    {
        bottomOnlyIds ??= System.Collections.Immutable.ImmutableHashSet<string>.Empty;
        BuildPaintOrder(state);
        _ancestorStatic.Clear();

        if (_paintOrder.Count == 0)
        {
            LastDiagnostic = StaticBakeDiagnostic.Empty(BakeReject.EmptyScene);
            return StaticBakePlan.None;
        }

        // Band-relax reference: the bottom bucket = the lowest effZ (paint-order slot 0). A node at this effZ is a
        // background-band node and gets the relaxed stability window (see Stable / Eligibility).
        _bucketZ = _effZ[_paintOrder[0]];

        // 1. Raw eligible boundary: the longest PAINT-order prefix where EVERY node passes the per-node rules (which
        //    now include a CheckAncestors carrier gate). Because the boundary is the FIRST ineligible paint-order
        //    node, everything before it is a contiguous bottom run of the render order.
        int k = _paintOrder.Count;
        string? boundaryId = null;
        BakeReject boundaryReason = BakeReject.None;
        for (int i = 0; i < _paintOrder.Count; i++)
        {
            var id = _paintOrder[i];
            var node = state.Nodes[id]; // guaranteed live (BuildPaintOrder filtered stale ids)
            BakeReject reason = Eligibility(id, node, state, transforms, dynamicallyExcluded, effectStaticOk);
            if (reason != BakeReject.None)
            {
                k = i;
                boundaryId = id;
                boundaryReason = reason;
                break;
            }
        }

        // Track-P3: the v2 prefix ended at a PARTICLE in the bottom bucket → bake the static segments around the
        // interleaved particles (multi-region), re-leveling the whole band to preserve paint order exactly. Only the
        // particle boundary triggers this; a spine/intent/shader/dynamic boundary falls through to the v2 prefix below.
        if (k > 0
            && boundaryId is not null
            && boundaryReason == BakeReject.Effect
            && state.Nodes[boundaryId].ParticleSpec is not null
            && _effZ[boundaryId] == _effZ[_paintOrder[0]])
        {
            var multi = PlanMultiRegion(state, transforms, designWidth, dynamicallyExcluded, effectStaticOk, bottomOnlyIds, k, boundaryId);
            if (multi is { } m)
            {
                return m;
            }
            // else: multi-region didn't pan out (< 2 regions / below total budget) → fall through to the v2 prefix.
        }

        if (k == 0)
        {
            LastDiagnostic = StaticBakeDiagnostic.Empty(boundaryReason, boundaryId);
            return StaticBakePlan.None;
        }

        // 2. Boundary trims to fixpoint (membership-based over the paint-order prefix). A baked node whose subtree is
        //    NOT fully in the prefix is OPEN; an open node with ClipChildren must stay live (its self-draw is the clip
        //    stencil for its live children) and any baked node with a LIVE ShowBehindParent child must stay live (that
        //    child renders BEHIND it, between the quad and it — impossible to reproduce once the parent is in the
        //    quad). Cutting to exclude the offending member can open a previously-closed node, so iterate until stable.
        int rawBoundary = k;
        k = TrimBoundary(state, k);
        if (k == 0)
        {
            LastDiagnostic = StaticBakeDiagnostic.Empty(boundaryReason, boundaryId) with { RawBoundary = rawBoundary };
            return StaticBakePlan.None;
        }

        // 3. Budget gate on the final prefix. Every painting node in the prefix has known bounds (an unknown-bounds
        //    painter is ineligible, so the prefix ended below it), so counting is exact.
        int paintCount = 0;
        double coverage = 0;
        int quadZ = int.MinValue;
        int minZ = int.MaxValue;
        int staticShaderCount = 0;
        for (int i = 0; i < k; i++)
        {
            var id = _paintOrder[i];
            var node = state.Nodes[id];
            int z = _effZ[id];
            if (z < minZ)
            {
                minZ = z;
            }

            if (node.ShaderId is not null)
            {
                staticShaderCount++;
            }

            if (Paints(node) && PaintAabb(id, node, transforms) is { } aabb)
            {
                paintCount++;
                coverage += ClampedArea(aabb, designWidth);
                if (z > quadZ)
                {
                    quadZ = z; // the boundary z the quad takes: the highest effZ among baked PAINTERS
                }
            }
        }

        double designArea = designWidth * DesignHeight;
        if (paintCount < MinPaintingNodes || coverage < MinCoverageFactor * designArea)
        {
            LastDiagnostic = new StaticBakeDiagnostic(
                rawBoundary, k, paintCount, coverage, boundaryId, boundaryReason,
                minZ == int.MaxValue ? 0 : minZ, 0, 0, staticShaderCount);
            return StaticBakePlan.None;
        }

        if (quadZ == int.MinValue)
        {
            quadZ = minZ == int.MaxValue ? 0 : minZ; // unreachable (budget requires ≥10 painters) — defensive
        }

        // 4. Materialise the plan: the baked prefix (in paint order), the ancestor carriers, and the pre-order
        //    BuildOrder (parents first) the controller clones from.
        var baked = new List<string>(k);
        for (int i = 0; i < k; i++)
        {
            baked.Add(_paintOrder[i]);
        }

        var (carriers, buildOrder) = BuildCarriersAndOrder(state, baked);

        LastDiagnostic = new StaticBakeDiagnostic(
            rawBoundary, k, paintCount, coverage, boundaryId, BakeReject.None,
            minZ == int.MaxValue ? 0 : minZ, quadZ, carriers.Count, staticShaderCount);
        return StaticBakePlan.Single(new StaticBakeRegion(baked, carriers, buildOrder, paintCount, coverage, quadZ));
    }

    // Track-P3 multi-region: the v2 prefix [0, firstBoundary) ended at a bottom-bucket particle. Bake the static
    // SEGMENTS around the interleaved particles into separate quads, keeping the particles (and any sub-threshold
    // static run) LIVE, and re-level the whole band to a dense run of DISTINCT absolute z values below the bucket z so
    // draw order is byte-identical (only the z labels spread). Returns null (→ caller falls back to the v2 prefix) when
    // fewer than 2 regions form or the total budget isn't met. Pure — reuses the same eligibility gate as v2.
    //
    // WS-ADDBAKE: a segment is a contiguous run of eligible members regardless of blend (plain-Add painters + REWRITABLE
    // cleared Add-blend shaders bake right into the region quad via the alpha-preserving variant — no add partition, no
    // mix-after-add split). Only bottom-only members (Sub/Mul + un-rewritable Add) end a segment and re-level live.
    private StaticBakePlan? PlanMultiRegion(
        MirrorState state,
        GlobalTransformIndex transforms,
        double designWidth,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> effectStaticOk,
        IReadOnlySet<string> bottomOnlyIds,
        int firstBoundary,
        string boundaryId)
    {
        int bucketZ = _effZ[_paintOrder[0]];
        int count = _paintOrder.Count;

        // Segment 0 = the raw v2 prefix [0, firstBoundary): a contiguous bottom run of eligible members. Add members
        // in it bake via the alpha-preserving variant just like every upper region (region 0 gets no special case).
        var segments = new List<Seg>();
        var seg0 = new List<string>(firstBoundary);
        for (int i = 0; i < firstBoundary; i++)
        {
            seg0.Add(_paintOrder[i]);
        }

        segments.Add(new Seg(seg0, 0));

        var liveIds = new List<string>(); // live band painters (particles + sub-threshold static) → z-biased in place
        int pos = firstBoundary;

        while (pos < count)
        {
            // Consume the gap: bridgeable particles + bottom-only members (same bucket) stay live; a non-particle
            // blocker or a bucket change ends the band.
            bool bandEnded = false;
            while (pos < count)
            {
                var gid = _paintOrder[pos];
                if (_effZ[gid] != bucketZ)
                {
                    bandEnded = true; // a higher bucket begins — the bottom band is complete
                    break;
                }

                var gnode = state.Nodes[gid];

                // A bottom-only member (Sub/Mul painter or un-rewritable Add shader) in a GAP stays LIVE (re-leveled):
                // it can't be reproduced by a premult "over" quad above the re-leveled live content below it.
                if (bottomOnlyIds.Contains(gid))
                {
                    if (Paints(gnode))
                    {
                        liveIds.Add(gid);
                    }

                    pos++;
                    continue;
                }

                if (Eligibility(gid, gnode, state, transforms, dynamicallyExcluded, effectStaticOk) == BakeReject.None)
                {
                    break; // next static segment starts here (an eligible member, any bakeable blend)
                }

                if (gnode.ParticleSpec is not null)
                {
                    liveIds.Add(gid); // bridge the particle: leave it live, re-level it between the quads
                    pos++;
                    continue;
                }

                bandEnded = true; // spine / intent / dynamic / clip blocker — the bakeable band ends
                break;
            }

            if (bandEnded || pos >= count)
            {
                break;
            }

            // Once the region cap is hit, the remaining band static stays LIVE (still re-leveled) up to the band end.
            if (segments.Count >= MaxRegions)
            {
                while (pos < count && _effZ[_paintOrder[pos]] == bucketZ)
                {
                    var rid = _paintOrder[pos];
                    var rnode = state.Nodes[rid];
                    if (Eligibility(rid, rnode, state, transforms, dynamicallyExcluded, effectStaticOk) != BakeReject.None
                        && rnode.ParticleSpec is null)
                    {
                        break; // a real blocker ends the band
                    }

                    if (Paints(rnode))
                    {
                        liveIds.Add(rid);
                    }

                    pos++;
                }

                break;
            }

            // Collect the next static segment = a contiguous run in the bottom bucket of eligible members (any bakeable
            // blend). A segment always STARTS with an eligible member (the gap loop broke here on one). A bottom-only
            // member (Sub/Mul / un-rewritable Add), any ineligible node, a particle, or a bucket change ends the run
            // (it re-levels live via the gap loop).
            int segStart = pos;
            var members = new List<string>();
            while (pos < count)
            {
                var sid = _paintOrder[pos];
                if (_effZ[sid] != bucketZ)
                {
                    break;
                }

                if (bottomOnlyIds.Contains(sid))
                {
                    break; // Sub/Mul / un-rewritable Add — ends the segment, re-levels live
                }

                if (Eligibility(sid, state.Nodes[sid], state, transforms, dynamicallyExcluded, effectStaticOk) != BakeReject.None)
                {
                    break; // unstable / dynamic / particle / spine … — the run ends here
                }

                members.Add(sid);
                pos++;
            }

            if (CountPainters(members, state, transforms) >= MinPaintersPerRegion)
            {
                segments.Add(new Seg(members, segStart));
            }
            else
            {
                foreach (var sid in members)
                {
                    if (Paints(state.Nodes[sid]))
                    {
                        liveIds.Add(sid); // sub-threshold run stays live (z-biased), not baked
                    }
                }
            }
        }

        if (segments.Count < 2)
        {
            return null; // no interleaving win — let the v2 prefix path decide
        }

        // Total budget across all baked segments — the whole bake must pay for itself.
        int totalPaint = 0;
        double totalCoverage = 0;
        int staticShaderCount = 0;
        foreach (var seg in segments)
        {
            staticShaderCount += CountShadersAndFill(seg.Members, state, transforms, designWidth, ref totalPaint, ref totalCoverage);
        }

        if (totalPaint < MinPaintingNodes || totalCoverage < MinCoverageFactor * designWidth * DesignHeight)
        {
            return null;
        }

        // Absolute-z re-leveling. Slots = every region (one z) + every live painter (one z), ordered by paint position.
        // PerRegion (default): each slot's z is POSITION-STABLE (z = bucketZ − (N − pos)) so tearing down the top of the
        // band never shifts a lower slot's z; dense fallback packs them (baseZ = bucketZ − slotCount). Both are
        // distinct, strictly increasing with paint order, and all strictly BELOW bucketZ (under gameplay at/above it).
        var slots = new List<(int Pos, int SegmentIdx, string? LiveId)>(segments.Count + liveIds.Count);
        for (int r = 0; r < segments.Count; r++)
        {
            slots.Add((segments[r].StartPos, r, null));
        }

        foreach (var id in liveIds)
        {
            slots.Add((_paintPos[id], -1, id));
        }

        slots.Sort((a, b) => a.Pos.CompareTo(b.Pos));

        int slotCount = slots.Count;
        int floorZ = bucketZ - (count - slots[0].Pos);
        if (floorZ < -MaxZIndex)
        {
            return null; // pathologically deep band — refuse rather than clamp (would collide z labels)
        }

        var regionQuadZ = new int[segments.Count];
        var liveZ = new List<LiveZOverride>(liveIds.Count);
        for (int s = 0; s < slotCount; s++)
        {
            var slot = slots[s];
            int z = bucketZ - (count - slot.Pos);
            if (slot.SegmentIdx >= 0)
            {
                regionQuadZ[slot.SegmentIdx] = z;
            }
            else
            {
                liveZ.Add(new LiveZOverride(slot.LiveId!, z));
            }
        }

        // Materialise each region (its members + carriers + pre-order build order, at its position-stable slot z).
        var regions = new List<StaticBakeRegion>(segments.Count);
        int topQuadZ = int.MinValue;
        int totalCarriers = 0;
        for (int r = 0; r < segments.Count; r++)
        {
            var seg = segments[r];
            var (carriers, build) = BuildCarriersAndOrder(state, seg.Members);
            totalCarriers += carriers.Count;

            int rp = 0;
            double rc = 0;
            AccumulateFill(seg.Members, state, transforms, designWidth, ref rp, ref rc);

            int z = regionQuadZ[r];
            regions.Add(new StaticBakeRegion(seg.Members, carriers, build, rp, rc, z));

            if (z > topQuadZ)
            {
                topQuadZ = z;
            }
        }

        LastDiagnostic = new StaticBakeDiagnostic(
            firstBoundary, pos, totalPaint, totalCoverage, boundaryId, BakeReject.None,
            floorZ, topQuadZ, totalCarriers, staticShaderCount);
        return new StaticBakePlan(regions, liveZ, totalPaint, totalCoverage, topQuadZ);
    }

    // WS-BGBAKE band flatten, round 3: ORDERING-EXACT segmented plan. The z<0 bottom bucket is walked in paint order;
    // live-subtree roots (exclusion policy + subtree bench — creatures/HUD/VFX containers) collapse to ONE LiveZ slot
    // each with their whole subtree skipped; eligible statics group into maximal contiguous runs CUT before every
    // member that follows a RECORDED live slot (particle / spine / intent / un-cleared shader / dynamic / unstable /
    // excluded root / demoted member — unrecorded non-painting skips never cut). Each run that clears the per-region
    // gates (painters + coverage) becomes a region quad at the SlotZ of its first member; failing runs demote to
    // live-at-their-slots. The induced order (quads at anchors + live ids at positions + excluded subtrees at root
    // slots) is therefore order-isomorphic to the band paint order — mid-band occlusion is EXACT (round 2's one-quad
    // collapse re-leveled ~40 mid-band interlopers above the whole background). Sub/Mul members obey a SEGMENT-LOCAL
    // premise: a bottomOnly member stays only when a painting member of its OWN segment precedes it (its blend then
    // composites onto in-quad pixels; the residual — content below the segment escaping where the segment's own
    // pixels are transparent — is fidelity-gated). Conservative rejects stay live, never baked. Pure — every refusal
    // returns None so the caller can fall back to the exact path.
    public StaticBakePlan PlanBandFlatten(
        MirrorState state,
        GlobalTransformIndex transforms,
        double designWidth,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> effectStaticOk,
        IReadOnlySet<string>? bottomOnlyIds = null)
    {
        bottomOnlyIds ??= System.Collections.Immutable.ImmutableHashSet<string>.Empty;
        BuildPaintOrder(state);
        _ancestorStatic.Clear();

        if (_paintOrder.Count == 0)
        {
            LastDiagnostic = StaticBakeDiagnostic.Empty(BakeReject.EmptyScene);
            return StaticBakePlan.None;
        }

        _bucketZ = _effZ[_paintOrder[0]];
        int bucketZ = _bucketZ;
        if (bucketZ >= 0)
        {
            // No real z<0 background band (flat / spine-drawn backdrop) — flatten legitimately refuses; the exact
            // path decides (today's behavior for the spine-background combat families).
            LastDiagnostic = StaticBakeDiagnostic.Empty(BakeReject.NoBand);
            return StaticBakePlan.None;
        }

        RebuildChildren(state); // the exclusion cross-bucket probe + the containment fixpoint both walk children

        // 1. Band walk & classify. Per band id (paint order): a live-subtree ROOT (exclusion policy || subtree
        //    bench) with a z-flat subtree collapses to ONE recorded live slot (descendants skipped, projected out of
        //    BandIds); a cross-bucket subtree falls back to per-painter recording (a root z override would drag its
        //    cross-bucket descendants to the deep slot). Otherwise: eligible ⇒ member candidate (bottomOnly ids ARE
        //    candidates — the segment-local premise applies in step 3); ineligible ⇒ recorded live iff it draws
        //    pixels of its own (an invisible ineligible group needs no slot — its children classify themselves).
        int bandCount = 0;
        var members = new List<string>();            // member candidates, in paint order
        var live = new List<(string Id, int Pos)>(); // recorded live slots, in paint order
        var bandIds = new List<string>();            // the PROJECTED band prefix (see plan.BandIds)
        var excludedRoots = new List<string>();      // slot-collapsed live-subtree roots, in band order
        var excludedRootSet = new HashSet<string>(System.StringComparer.Ordinal);
        var fallbackRootSet = new HashSet<string>(System.StringComparer.Ordinal); // cross-bucket → per-painter live
        var underStatus = new Dictionary<string, int>(System.StringComparer.Ordinal); // memo: 0 none / 1 collapsed / 2 fallback

        // Strict-ancestor live-subtree status. Band roots land in the two sets before their descendants are visited
        // (pre-order within the bucket); an OUT-of-band ancestor (a z≥0 container that is policy-matched or
        // subtree-benched — e.g. a benched non-spine carrier above the band) makes its band descendants per-painter
        // live, preserving the round-2 bench semantics for that shape.
        int UnderLiveSubtree(string id)
        {
            if (underStatus.TryGetValue(id, out var memo))
            {
                return memo;
            }

            int result = 0;
            if (state.Nodes.TryGetValue(id, out var n) && n.ParentId is { } pid && state.Nodes.TryGetValue(pid, out var pn))
            {
                if (excludedRootSet.Contains(pid))
                {
                    result = 1;
                }
                else if (fallbackRootSet.Contains(pid))
                {
                    result = 2;
                }
                else
                {
                    result = UnderLiveSubtree(pid);
                    if (result == 0
                        && (!_effZ.TryGetValue(pid, out var pz) || pz != bucketZ)
                        && (IsRoomBenchedSubtree(pid) || BandBakeExclusionPolicy.IsExcludedRoot(pn)))
                    {
                        result = 2; // live-subtree ancestor OUTSIDE the band — per-painter fallback
                    }
                }
            }

            underStatus[id] = result;
            return result;
        }

        // Is every descendant of `rootId` in THIS band bucket? (A cross-bucket descendant would inherit the root's
        // deep slot z through the relative chain — refuse the collapse, fall back to per-painter.)
        bool SubtreeIsBandFlat(string rootId)
        {
            if (!_childrenByParent.TryGetValue(rootId, out var kids))
            {
                return true;
            }

            var stack = new Stack<string>(kids);
            while (stack.Count > 0)
            {
                var cur = stack.Pop();
                if (!_effZ.TryGetValue(cur, out var z) || z != bucketZ)
                {
                    return false;
                }

                if (_childrenByParent.TryGetValue(cur, out var more))
                {
                    foreach (var c in more)
                    {
                        stack.Push(c);
                    }
                }
            }

            return true;
        }

        for (int i = 0; i < _paintOrder.Count; i++)
        {
            var id = _paintOrder[i];
            if (_effZ[id] != bucketZ)
            {
                break; // the bottom bucket is a paint-order prefix — a higher bucket ends the band
            }

            bandCount++;
            var node = state.Nodes[id];

            int status = UnderLiveSubtree(id);
            if (status == 1)
            {
                continue; // under a slot-collapsed root — skipped AND projected out of BandIds
            }

            bandIds.Add(id);

            if (status == 0 && IsLiveSubtreeRoot(id, node))
            {
                if (SubtreeIsBandFlat(id))
                {
                    excludedRootSet.Add(id);
                    excludedRoots.Add(id);
                    live.Add((id, i)); // ONE slot — the root override re-levels the whole subtree coherently
                    continue;
                }

                fallbackRootSet.Add(id);
                status = 2; // cross-bucket safety valve: per-painter recording for the whole subtree
            }

            if (status == 2)
            {
                if (Paints(node) || node.ParticleSpec is not null || node.SpineSceneResPath is not null
                    || node.IntentFrames is not null)
                {
                    live.Add((id, i));
                }

                continue;
            }

            if (Eligibility(id, node, state, transforms, dynamicallyExcluded, effectStaticOk) == BakeReject.None)
            {
                members.Add(id);
                continue;
            }

            if (Paints(node) || node.ParticleSpec is not null || node.SpineSceneResPath is not null
                || node.IntentFrames is not null)
            {
                live.Add((id, i));
            }
        }

        _members.Clear();
        foreach (var id in members)
        {
            _members.Add(id);
        }

        // The member's induced paint position: an intra-z ShowBehindParent member renders immediately BEFORE its
        // parent's self-draw, so it pairs with a MEMBER parent (same segment, clone reproduces the flag natively).
        int EffPos(string id)
        {
            var n = state.Nodes[id];
            return n.ShowBehindParent && n.ParentId is { } pid && _members.Contains(pid)
                ? _paintPos[pid]
                : _paintPos[id];
        }

        // 2+3. Containment + segmentation + segment-local Sub/Mul premise, iterated to fixpoint (members only ever
        // shrink ⇒ terminates). Containment: a member that clips a live (non-member) child is that child's stencil,
        // and a member with a live show-behind child has that child drawing between the quad and it — neither is
        // reproducible from inside a quad ⇒ demote to live. An intra-z SBP member with a NON-member parent demotes.
        // Segmentation: cut the member run before every member that follows a recorded live slot. Premise: a
        // bottomOnly member (Sub/Mul painter, bottomOnly shader) needs a painting member of its OWN segment before
        // it; violators demote (a demotion is a new recorded slot ⇒ new cut ⇒ iterate).
        var segments = new List<List<string>>();
        bool changed = true;
        while (changed)
        {
            changed = false;

            // Containment fixpoint (unchanged semantics from round 2).
            bool contChanged = true;
            while (contChanged)
            {
                contChanged = false;
                for (int i = members.Count - 1; i >= 0; i--)
                {
                    var id = members[i];
                    var node = state.Nodes[id];
                    bool demote = node.ShowBehindParent
                        && (node.ParentId is not { } sbpPid || !_members.Contains(sbpPid));

                    if (!demote && _childrenByParent.TryGetValue(id, out var kids))
                    {
                        foreach (var child in kids)
                        {
                            if (_members.Contains(child))
                            {
                                continue; // baked child — no boundary issue (an excluded-subtree child counts as
                                          // LIVE here: it still needs its parent's clip stencil / behind-parent slot)
                            }

                            if (node.ClipChildren != 0)
                            {
                                demote = true; // its live children would lose their clip stencil
                                break;
                            }

                            if (state.Nodes.TryGetValue(child, out var cn) && cn.ShowBehindParent)
                            {
                                demote = true; // a live child that draws BEHIND it can't sit above the quad
                                break;
                            }
                        }
                    }

                    if (demote)
                    {
                        _members.Remove(id);
                        members.RemoveAt(i);
                        if (Paints(node))
                        {
                            live.Add((id, _paintPos[id]));
                        }

                        contChanged = true;
                    }
                }
            }

            // Segmentation over the members ordered by induced position (stable — an SBP child shares its parent's
            // position and follows it in walk order).
            live.Sort(static (a, b) => a.Pos.CompareTo(b.Pos));
            var ordered = new List<string>(members);
            ordered.Sort((a, b) =>
            {
                int ea = EffPos(a), eb = EffPos(b);
                return ea != eb ? ea.CompareTo(eb) : _paintPos[a].CompareTo(_paintPos[b]);
            });

            segments.Clear();
            List<string>? cur = null;
            int prevEff = int.MinValue;
            int li = 0;
            foreach (var id in ordered)
            {
                int eff = EffPos(id);
                bool cut = cur is null;
                while (li < live.Count && live[li].Pos < eff)
                {
                    if (live[li].Pos > prevEff)
                    {
                        cut = true; // a recorded live slot sits between the previous member and this one
                    }

                    li++;
                }

                if (cut)
                {
                    cur = new List<string>();
                    segments.Add(cur);
                }

                cur!.Add(id);
                prevEff = eff;
            }

            // Segment-local Sub/Mul premise.
            foreach (var seg in segments)
            {
                bool paintingSeen = false;
                foreach (var id in seg)
                {
                    if (bottomOnlyIds.Contains(id) && !paintingSeen)
                    {
                        _members.Remove(id);
                        members.Remove(id);
                        if (Paints(state.Nodes[id]))
                        {
                            live.Add((id, _paintPos[id]));
                        }

                        changed = true; // its demotion is a new cut — re-run containment + segmentation
                    }
                    else if (Paints(state.Nodes[id]))
                    {
                        paintingSeen = true;
                    }
                }
            }
        }

        // 4. Per-region gates: a run becomes a quad only when it has enough painters AND its coverage pays for the
        //    quad's own screen of fill; failing runs demote to live-at-their-own-slots (ordering exact, no quad).
        //    Then the MaxRegions cap: keep the highest (coverage − designArea) wins, demote the rest.
        double designArea = designWidth * DesignHeight;
        var kept = new List<(List<string> Members, int AnchorPos, int Paint, double Cov)>();
        foreach (var seg in segments)
        {
            int p = 0;
            double c = 0;
            AccumulateFill(seg, state, transforms, designWidth, ref p, ref c);
            if (p >= MinPaintersPerRegion && c >= BandRegionMinCoverageFactor * designArea)
            {
                kept.Add((seg, EffPos(seg[0]), p, c));
            }
            else
            {
                foreach (var id in seg)
                {
                    if (Paints(state.Nodes[id]))
                    {
                        live.Add((id, _paintPos[id]));
                    }
                }
            }
        }

        if (kept.Count > MaxRegions)
        {
            // (coverage − designArea) ordering == coverage ordering (constant offset); anchor asc breaks ties.
            kept.Sort(static (a, b) => a.Cov != b.Cov ? b.Cov.CompareTo(a.Cov) : a.AnchorPos.CompareTo(b.AnchorPos));
            for (int i = kept.Count - 1; i >= MaxRegions; i--)
            {
                foreach (var id in kept[i].Members)
                {
                    if (Paints(state.Nodes[id]))
                    {
                        live.Add((id, _paintPos[id]));
                    }
                }

                kept.RemoveAt(i);
            }

            kept.Sort(static (a, b) => a.AnchorPos.CompareTo(b.AnchorPos));
        }

        live.Sort(static (a, b) => a.Pos.CompareTo(b.Pos));

        // 5. Global budget over the surviving regions (each extra region charges another half screen of fill).
        int regionCount = kept.Count;
        int totalPaint = 0;
        double totalCoverage = 0;
        foreach (var k in kept)
        {
            totalPaint += k.Paint;
            totalCoverage += k.Cov;
        }

        double needed = (BandMinCoverageFactor + BandCoveragePerExtraRegion * (regionCount - 1)) * designArea;
        if (regionCount == 0 || totalPaint < BandMinPainters || totalCoverage < needed)
        {
            LastDiagnostic = new StaticBakeDiagnostic(
                bandCount, bandCount, totalPaint, totalCoverage, null, BakeReject.BudgetGate, bucketZ, 0, 0, 0);
            return StaticBakePlan.None;
        }

        // 6. Position-stable slot z: z = bucketZ − (bandCount − pos) over BAND positions (skipped excluded-subtree
        //    descendants still occupy positions, so slots stay stable while a subtree churns). All member/live
        //    positions are distinct ⇒ z distinct, strictly increasing with paint order, strictly below bucketZ.
        //    Refuse a pathologically deep band rather than clamp. No recorded slots at all ⇒ the single region takes
        //    the band's natural boundary z (mount order sorts the quad under the live tree at equal z).
        int SlotZ(int pos) => bucketZ - (bandCount - pos);
        bool naturalZ = live.Count == 0; // ⇒ no cuts were possible ⇒ exactly one region
        if (!naturalZ)
        {
            int floorPos = System.Math.Min(kept[0].AnchorPos, live[0].Pos);
            if (SlotZ(floorPos) < -MaxZIndex)
            {
                LastDiagnostic = StaticBakeDiagnostic.Empty(BakeReject.BudgetGate) with { RawBoundary = bandCount };
                return StaticBakePlan.None;
            }
        }

        // 7. Materialise: regions bottom→top (anchor order), live overrides in paint order.
        var regions = new List<StaticBakeRegion>(regionCount);
        int totalCarriers = 0;
        int staticShaders = 0;
        foreach (var (segMembers, anchorPos, p, c) in kept)
        {
            var (carriers, build) = BuildCarriersAndOrder(state, segMembers);
            totalCarriers += carriers.Count;
            regions.Add(new StaticBakeRegion(segMembers, carriers, build, p, c, naturalZ ? bucketZ : SlotZ(anchorPos)));
            foreach (var id in segMembers)
            {
                if (state.Nodes[id].ShaderId is not null)
                {
                    staticShaders++;
                }
            }
        }

        var liveZ = new List<LiveZOverride>(live.Count);
        foreach (var (id, pos) in live)
        {
            liveZ.Add(new LiveZOverride(id, SlotZ(pos)));
        }

        int topQuadZ = regions[^1].QuadZ;
        LastDiagnostic = new StaticBakeDiagnostic(
            bandCount, bandCount, totalPaint, totalCoverage, null, BakeReject.None,
            naturalZ ? bucketZ : SlotZ(System.Math.Min(kept[0].AnchorPos, live[0].Pos)), topQuadZ, totalCarriers, staticShaders);
        return new StaticBakePlan(regions, liveZ, totalPaint, totalCoverage, topQuadZ, bandIds, excludedRoots);
    }

    // WS-BGBAKE round 3: the unified live-subtree-root predicate — the static exclusion policy (creatures / HUD /
    // VFX containers, wire-data selectors) OR the runtime subtree bench (a learned repeat-offender carrier). Either
    // way the subtree re-levels live as a unit and is never baked/carried/watched.
    private bool IsLiveSubtreeRoot(string id, MirrorNode node) =>
        BandBakeExclusionPolicy.IsExcludedRoot(node) || IsRoomBenchedSubtree(id);

    // WS-BGBAKE order guard (pure): does the CURRENT state's bottom-bucket paint-order prefix still match `bandIds`
    // element-for-element — identity AND order AND count? Combat streams OrderChanged deltas ~7/s (hand-card
    // reorders, damage-number spawns …) that only shuffle the z≥0 world; a band-flatten bake depends ONLY on the z<0
    // prefix, so the controller may keep it across an order change that leaves this prefix untouched. Round 3: the
    // comparison is PROJECTED — ids under an `excludedRoots` root (strict-ancestor walk, memoized) are skipped, so
    // spawns / removals / reorders INSIDE an excluded live subtree (intent waves, combat VFX, HUD churn) are
    // invisible. ANY other difference — a member/gap reorder, add, remove, a z-migration, or an excluded ROOT itself
    // appearing/vanishing (roots stay in the projection) — returns false (conservative; the controller then tears
    // down exactly as before). O(nodes log nodes) — run only on OrderChanged drains while a band bake is live.
    public bool IsBandOrderUnchanged(MirrorState state, IReadOnlyList<string> bandIds, IReadOnlyList<string>? excludedRoots = null)
    {
        BuildPaintOrder(state);
        if (_paintOrder.Count == 0)
        {
            return bandIds.Count == 0; // the whole scene vanished — a live band plan is stale
        }

        HashSet<string>? roots = null;
        Dictionary<string, bool>? underMemo = null;
        if (excludedRoots is { Count: > 0 })
        {
            roots = new HashSet<string>(excludedRoots, System.StringComparer.Ordinal);
            underMemo = new Dictionary<string, bool>(System.StringComparer.Ordinal);
        }

        // Strict-ancestor membership under an excluded root (the root ITSELF is not "under" — it must still match
        // its projected slot, so a root appearing/vanishing/reordering is always visible).
        bool UnderExcluded(string id)
        {
            if (underMemo!.TryGetValue(id, out var memo))
            {
                return memo;
            }

            bool result = false;
            if (state.Nodes.TryGetValue(id, out var n) && n.ParentId is { } pid && state.Nodes.ContainsKey(pid))
            {
                result = roots!.Contains(pid) || UnderExcluded(pid);
            }

            underMemo[id] = result;
            return result;
        }

        int bucketZ = _effZ[_paintOrder[0]];
        int j = 0; // cursor into the PROJECTED bandIds
        for (int i = 0; i < _paintOrder.Count; i++)
        {
            var id = _paintOrder[i];
            if (_effZ[id] != bucketZ)
            {
                break; // prefix over — the projection must have been consumed exactly
            }

            if (underMemo is not null && UnderExcluded(id))
            {
                continue; // inside an excluded live subtree — projected out, churn invisible
            }

            if (j >= bandIds.Count || !string.Equals(bandIds[j], id, System.StringComparison.Ordinal))
            {
                return false; // longer projection / reordered / substituted id
            }

            j++;
        }

        return j == bandIds.Count; // shorter projection ⇒ false
    }

    // One collected band segment: a contiguous run of eligible members baked into ONE premult region quad. StartPos is
    // the paint position of the segment's first node (its z-releveling slot anchor).
    private readonly struct Seg
    {
        public readonly List<string> Members;
        public readonly int StartPos;

        public Seg(List<string> members, int startPos)
        {
            Members = members;
            StartPos = startPos;
        }
    }

    // Tally painters + clamped coverage for a member list into the running totals (budget / per-region telemetry).
    private void AccumulateFill(List<string> ids, MirrorState state, GlobalTransformIndex transforms, double designWidth, ref int paint, ref double coverage)
    {
        foreach (var id in ids)
        {
            var node = state.Nodes[id];
            if (Paints(node) && PaintAabb(id, node, transforms) is { } aabb)
            {
                paint++;
                coverage += ClampedArea(aabb, designWidth);
            }
        }
    }

    // AccumulateFill + a static-shader count (returns the shader count, folds paint/coverage into the refs).
    private int CountShadersAndFill(List<string> ids, MirrorState state, GlobalTransformIndex transforms, double designWidth, ref int paint, ref double coverage)
    {
        int shaders = 0;
        foreach (var id in ids)
        {
            var node = state.Nodes[id];
            if (node.ShaderId is not null)
            {
                shaders++;
            }

            if (Paints(node) && PaintAabb(id, node, transforms) is { } aabb)
            {
                paint++;
                coverage += ClampedArea(aabb, designWidth);
            }
        }

        return shaders;
    }

    // Count the painting nodes (trusted design box) in a segment — the per-region threshold uses this.
    private int CountPainters(List<string> seg, MirrorState state, GlobalTransformIndex transforms)
    {
        int n = 0;
        foreach (var id in seg)
        {
            var node = state.Nodes[id];
            if (Paints(node) && PaintAabb(id, node, transforms) is not null)
            {
                n++;
            }
        }

        return n;
    }

    // ---- paint-order construction (Track-P) ----------------------------------------------------------------------

    // Build the effective-Z paint order over the LIVE nodes of state.OrderedIds. OrderedIds can carry STALE ids (a
    // wire order list that outlived the nodes — the reconciler filters them via BuildOrderStructure, and so must we),
    // so filter to live ids while keeping their relative (pre-order) order. Then a forward pass computes each id's
    // effZ = effZ(parent) + (ZIndex ?? 0) — pre-order guarantees a live parent precedes its child; a stale/absent
    // parent yields a root (effZ = own ZIndex). Finally a stable sort of the pre-order by effZ IS the paint order.
    private void BuildPaintOrder(MirrorState state)
    {
        _liveOrder.Clear();
        _paintOrder.Clear();
        _preIdx.Clear();
        _effZ.Clear();
        _paintPos.Clear();

        var ordered = state.OrderedIds;
        for (int i = 0; i < ordered.Count; i++)
        {
            var id = ordered[i];
            if (!state.Nodes.ContainsKey(id))
            {
                continue; // stale id (node gone) — skip, exactly like BuildOrderStructure
            }

            _preIdx[id] = _liveOrder.Count;
            _liveOrder.Add(id);
        }

        foreach (var id in _liveOrder)
        {
            var node = state.Nodes[id];
            int z = node.ZIndex ?? 0;
            int baseZ = node.ParentId is { } pid && _effZ.TryGetValue(pid, out var pz) ? pz : 0;
            _effZ[id] = baseZ + z;
        }

        _paintOrder.AddRange(_liveOrder);
        _paintOrder.Sort(_paintComparer);
        for (int i = 0; i < _paintOrder.Count; i++)
        {
            _paintPos[_paintOrder[i]] = i;
        }
    }

    // The ancestor carriers of the baked set (its ancestor closure minus the baked set) + the pre-order BuildOrder
    // (baked ∪ carriers, parents before children) the controller clones from. A baked node's parent is either baked,
    // a carrier, or a stale/absent root (the clone parents directly under the bake viewport).
    private (List<string> Carriers, List<string> BuildOrder) BuildCarriersAndOrder(MirrorState state, List<string> baked)
    {
        _bakedSet.Clear();
        foreach (var id in baked)
        {
            _bakedSet.Add(id);
        }

        _carrierSet.Clear();
        foreach (var id in baked)
        {
            var cur = state.Nodes[id].ParentId;
            while (cur is not null && state.Nodes.ContainsKey(cur) && !_bakedSet.Contains(cur))
            {
                if (!_carrierSet.Add(cur))
                {
                    break; // this chain is already covered
                }

                cur = state.Nodes[cur].ParentId;
            }
        }

        var carriers = new List<string>(_carrierSet);
        carriers.Sort(_preOrderComparer);

        var buildOrder = new List<string>(_bakedSet.Count + _carrierSet.Count);
        buildOrder.AddRange(baked);
        buildOrder.AddRange(_carrierSet);
        buildOrder.Sort(_preOrderComparer); // pre-order → a clone's parent (lower preIdx) is always built first
        return (carriers, buildOrder);
    }

    // ---- per-node eligibility ------------------------------------------------------------------------------------

    // The per-node gate: BakeReject.None ⇒ eligible; any other value is the reason the prefix ends at this node.
    private BakeReject Eligibility(
        string id,
        MirrorNode node,
        MirrorState state,
        GlobalTransformIndex transforms,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> effectStaticOk)
    {
        // Hard effect rejects — particle / spine / intent draw dynamic pixels no static bake can reproduce.
        if (node.ParticleSpec is not null || node.SpineSceneResPath is not null || node.IntentFrames is not null)
        {
            return BakeReject.Effect;
        }

        // A shader node bakes ONLY when the controller cleared it for Static-mode baking (mounted, allowed blend
        // class, screen-read policy satisfied); otherwise its live TIME/screen-read pixels can't be frozen faithfully.
        if (node.ShaderId is not null && !effectStaticOk.Contains(id))
        {
            return BakeReject.Effect;
        }

        // A MaterialRef is never consumed by the native renderer (see AllowMaterialRef) → a MaterialRef-only node is
        // plain base art, bakeable in any mode. The retreat lever restores the conservative v1 reject.
        if (!AllowMaterialRef && node.MaterialRef is not null)
        {
            return BakeReject.Effect;
        }

        // Live-owned this instant (transform/modulate tween, "__anim" bob/spin ticker, input lift, texture still
        // decoding) — the controller collected these off the live views.
        if (dynamicallyExcluded.Contains(id))
        {
            return BakeReject.Dynamic;
        }

        // Benched by the thrash guard.
        if (_thrash.TryGetValue(id, out var t) && _drain < t.BenchedUntilDrain)
        {
            return BakeReject.Thrash;
        }

        // WS-BGBAKE room bench: struck out for this room (a band-bake repeat offender like the wave banner) — the
        // band plan re-levels it live instead. Deliberately NOT mirrored into AncestorStaticReason: a benched id
        // only ever loses its own self-paint; it can never reject the band beneath it as a "benched parent".
        if (IsRoomBenched(id))
        {
            return BakeReject.Thrash;
        }

        // Not sat still long enough. A background-band node (effZ == the bottom bucket, i.e. the static fill that
        // paints under gameplay) gets the RELAXED window so live combat can settle it; gameplay-bucket nodes stay
        // strict. Carriers keep the strict window (checked below via AncestorStaticReason).
        if (!Stable(id, relaxed: _effZ[id] == _bucketZ))
        {
            return BakeReject.Unstable;
        }

        // ShowBehindParent draws a child BEFORE its parent — but Godot honors that ONLY within the same z bucket (a
        // differing effZ means z-index wins and the child paints at its own z). Our paint-order model sorts by effZ
        // and cannot represent an intra-tree behind-parent flip across z, so refuse a cross-z behind-parent node.
        if (node.ShowBehindParent
            && node.ParentId is { } pid
            && _effZ.TryGetValue(pid, out var parentZ)
            && _effZ[id] != parentZ)
        {
            return BakeReject.ZOrderUncertain;
        }

        if (!BlendOk(node))
        {
            return BakeReject.Blend;
        }

        // A node that paints must have a trusted design-space box (for the coverage estimate AND so the clone lands
        // exactly where the original would). A pure group that paints nothing needs no box.
        if (Paints(node) && PaintAabb(id, node, transforms) is null)
        {
            return BakeReject.UnknownBounds;
        }

        // Every strict ancestor becomes either baked or a carrier — both are cloned, so each must be static enough to
        // clone faithfully (stable / not live-owned / not benched) and must not silently drop a clip the clone can't
        // reproduce (a clipping carrier is a suppressed structural node with no stencil).
        return CheckAncestors(id, node, state, dynamicallyExcluded);
    }

    // Carrier gate for a candidate baked node: walk its strict ancestors. The stable/dynamic/thrash portion is a pure
    // function of the ancestor chain (memoized via AncestorStaticReason); the clip portion depends on THIS node's
    // effZ (a clip ancestor only reproduces its stencil when it is itself baked — i.e. at effZ ≤ this node's effZ, so
    // it sorts at/below this node in paint order and is therefore inside the prefix too; a clip ancestor at higher
    // effZ is a CARRIER whose suppressed clone can't clip → reject).
    private BakeReject CheckAncestors(string id, MirrorNode node, MirrorState state, IReadOnlySet<string> dynamicallyExcluded)
    {
        var staticReason = AncestorStaticReason(id, state, dynamicallyExcluded);
        if (staticReason != BakeReject.None)
        {
            return staticReason;
        }

        int selfZ = _effZ[id];
        var cur = node.ParentId;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var anc))
        {
            if (anc.ClipChildren != 0 && _effZ[cur] > selfZ)
            {
                return BakeReject.CarrierBlocked;
            }

            cur = anc.ParentId;
        }

        return BakeReject.None;
    }

    // Memoized "first non-static ancestor" for id's PARENT chain (stable / dynamically-excluded / thrash-benched).
    // Independent of the descendant, so a whole sibling group shares its parent's memo. The clip check lives in
    // CheckAncestors (it needs the descendant's effZ).
    private BakeReject AncestorStaticReason(string id, MirrorState state, IReadOnlySet<string> dynamicallyExcluded)
    {
        if (_ancestorStatic.TryGetValue(id, out var memo))
        {
            return memo;
        }

        BakeReject reason = BakeReject.None;
        if (state.Nodes.TryGetValue(id, out var node) && node.ParentId is { } pid && state.Nodes.ContainsKey(pid))
        {
            if (!Stable(pid))
            {
                reason = BakeReject.CarrierUnstable;
            }
            else if (dynamicallyExcluded.Contains(pid))
            {
                reason = BakeReject.CarrierDynamic;
            }
            else if (_thrash.TryGetValue(pid, out var t) && _drain < t.BenchedUntilDrain)
            {
                reason = BakeReject.CarrierThrash;
            }
            else
            {
                reason = AncestorStaticReason(pid, state, dynamicallyExcluded);
            }
        }

        _ancestorStatic[id] = reason;
        return reason;
    }

    // BOTH clauses: framesSinceChange ≥ MinStableFrames AND (drainsSinceChange ≥ MinStableDrains OR the whole scene
    // has been drain-quiet for ≥ MinStableFrames). The drain-quiescence bypass is what lets --replay (one drain) and
    // an idle screen (drains stopped) reach stability on frames alone, while live combat still demands real drain
    // quiescence. A never-seen id (no stability entry) is treated as just-changed → not stable.
    private bool Stable(string id, bool relaxed = false)
    {
        if (!_stability.TryGetValue(id, out var s))
        {
            return false;
        }

        int minFrames = relaxed ? MinStableFramesBand : MinStableFrames;
        int minDrains = relaxed ? MinStableDrainsBand : MinStableDrains;

        long framesSinceChange = _frame - s.LastChangeFrame;
        if (framesSinceChange < minFrames)
        {
            return false;
        }

        long drainsSinceChange = _drain - s.LastChangeDrain;
        long framesSinceLastDrain = _frame - _lastDrainFrame;
        return drainsSinceChange >= minDrains || framesSinceLastDrain >= minFrames;
    }

    private static bool BlendOk(MirrorNode node)
    {
        int mode = node.CanvasBlendMode ?? 0; // null/0 = default Mix
        if (RestrictToMixBlend)
        {
            return mode == 0;
        }

        return mode is 0 or 1 or 2 or 3; // Mix / Add / Sub / Mul (anything else → default Mix but refuse to be safe)
    }

    // Does the node emit visible pixels of its own? Invisible nodes paint nothing (so they need no bounds and add no
    // coverage). Hard-effect nodes are already refused by Eligibility, so this only sees plain / static-shader paint.
    private static bool Paints(MirrorNode node) =>
        node.Visible
        && (node.TextureUrl is not null
            || node.FillColor is not null
            || node.Range is not null
            || node.Text is { Text.Length: > 0 });

    // The node's design-space paint AABB, or null when its box / global is unknown (mirrors CullIndex.LocalPaintBox).
    private static DesignAabb? PaintAabb(string id, MirrorNode node, GlobalTransformIndex transforms)
    {
        var box = node.LocalRect;
        if (box is null || !transforms.TryGetGlobal(id, out var g))
        {
            return null;
        }

        return CullBounds.OfRect(g, box.X, box.Y, box.Width, box.Height);
    }

    // Area of the AABB clamped to the design rect [0,width]×[0,height] (off-screen overhang doesn't count toward the
    // "does the bake cover enough of the frame" budget). Negative overlaps clamp to 0.
    private static double ClampedArea(DesignAabb aabb, double width)
    {
        double x0 = System.Math.Max(aabb.MinX, 0);
        double y0 = System.Math.Max(aabb.MinY, 0);
        double x1 = System.Math.Min(aabb.MaxX, width);
        double y1 = System.Math.Min(aabb.MaxY, DesignHeight);
        double w = x1 - x0;
        double h = y1 - y0;
        return w > 0 && h > 0 ? w * h : 0;
    }

    // ---- boundary trim -------------------------------------------------------------------------------------------

    // Membership-based trim over the paint-order prefix _paintOrder[0..k). A member with a LIVE (non-member) child
    // that either it clips (ClipChildren != 0 → the member's self-draw is the stencil) or that draws behind it
    // (child.ShowBehindParent → it renders between the quad and the member) must stay live: cut the prefix to exclude
    // that member (and everything above it in paint order, to keep the baked set a contiguous bottom run). Cutting can
    // open a previously-closed member (its now-live child), so re-scan to fixpoint.
    private int TrimBoundary(MirrorState state, int k)
    {
        RebuildChildren(state);

        while (k > 0)
        {
            _members.Clear();
            for (int i = 0; i < k; i++)
            {
                _members.Add(_paintOrder[i]);
            }

            int cut = k;
            for (int i = 0; i < k && i < cut; i++)
            {
                var id = _paintOrder[i];
                if (!_childrenByParent.TryGetValue(id, out var kids))
                {
                    continue;
                }

                var node = state.Nodes[id];
                foreach (var child in kids)
                {
                    if (_members.Contains(child))
                    {
                        continue; // baked child — no boundary issue
                    }

                    // `id` is OPEN (this child is live). Two violations force `id` out of the prefix:
                    if (node.ClipChildren != 0)
                    {
                        cut = i; // clip stencil must stay live for its live children
                        break;
                    }

                    if (state.Nodes.TryGetValue(child, out var childNode) && childNode.ShowBehindParent)
                    {
                        cut = i; // a live child that draws BEHIND id can't sit above the quad
                        break;
                    }
                }
            }

            if (cut == k)
            {
                return k;
            }

            k = cut; // cutting can open a previously-closed node → re-scan
        }

        return k;
    }

    // Build parent→children over the FULL tree (a member's children may lie beyond the prefix boundary — those are
    // exactly the live children the trims care about).
    private void RebuildChildren(MirrorState state)
    {
        _childrenByParent.Clear();
        foreach (var (id, node) in state.Nodes)
        {
            if (node.ParentId is { } pid)
            {
                if (!_childrenByParent.TryGetValue(pid, out var list))
                {
                    list = new List<string>();
                    _childrenByParent[pid] = list;
                }

                list.Add(id);
            }
        }
    }

    private void PruneThrashToLive(MirrorState state)
    {
        if (_thrash.Count == 0)
        {
            return;
        }

        List<string>? stale = null;
        foreach (var id in _thrash.Keys)
        {
            if (!state.Nodes.ContainsKey(id))
            {
                (stale ??= new List<string>()).Add(id);
            }
        }

        if (stale is not null)
        {
            foreach (var id in stale)
            {
                _thrash.Remove(id);
            }
        }
    }
}

// One baked region: `BakedIds` (paint order) are self-paint suppressed in the live tree and fully cloned into this
// region's bake viewport; `CarrierIds` are ancestors of the baked set that fall outside the segment — cloned as pure
// structural scaffolding (transform/modulate/clip cascade), never suppressed live. `BuildOrder` is (baked ∪ carriers)
// in pre-order so a clone's parent is always built first. `QuadZ` is the ABSOLUTE effective-Z the region's composite
// quad takes (v2 single region: the segment's boundary z; v3 multi-region: the dense re-leveled slot z).
public readonly record struct StaticBakeRegion(
    IReadOnlyList<string> BakedIds,
    IReadOnlyList<string> CarrierIds,
    IReadOnlyList<string> BuildOrder,
    int PaintCount,
    double Coverage,
    int QuadZ)
{
    // Every id CLONED for this region (baked ∪ carriers — Add members bake into the SAME region quad via the alpha-
    // preserving variant, so there is no separate partition). A drain that changes any of these moves or rebuilds the
    // region — the controller watches this set PER REGION so an upper region's churn releases only that region (and
    // the band above it), sparing the stable lower regions. Live re-leveled painters are deliberately NOT watched
    // (they draw live; only their z-order, an OrderChange, matters).
    public IEnumerable<string> WatchedIds()
    {
        foreach (var id in BakedIds)
        {
            yield return id;
        }

        foreach (var id in CarrierIds)
        {
            yield return id;
        }
    }
}

// An absolute effective-Z override the controller stamps on a LIVE band painter (an interleaved particle, or a
// sub-threshold static run) so it composites at its exact paint-order position BETWEEN the region quads. See
// MirrorNodeView.SetZOverride and StaticBakePlanner's re-leveling.
public readonly record struct LiveZOverride(string Id, int Z);

// WS-BGBAKE: what the controller should do about the culprits of a drain that touched a live BAND bake's watch.
public enum BandDrainDecision
{
    None,             // no culprit touched a cloned id — the bake stands untouched
    Follow,           // every culprit is a Transform-only move of a spine carrier — retransform the quads, keep the bake
    Teardown,         // some culprit can be neither followed nor benched — tear down exactly as before
    BenchAndTeardown, // baked-member culprits — register their room-bench strikes, then tear down as before
}

// WS-BGBAKE: the PURE culprit classifier behind the band-bake drain decision (unit-tested truth table; the
// controller supplies the Godot-side lookups as delegates). Given the changed-id and hint-target culprits that hit
// some region's watch:
//   * a BAKED MEMBER culprit (any flags, changed or hint) ⇒ BenchAndTeardown, and it joins `outBenchIds` — the next
//     plan exiles second-strike offenders (wave banner) to live interlopers via the planner's room bench;
//   * a CARRIER culprit ⇒ follow-eligible ONLY when its flags are EXACTLY Transform and it is a spine carrier (an
//     ancestor of ALL baked members in EVERY region — in practice the band's root container, i.e. screen shake);
//   * a HINT targeting a carrier is NEVER followed (a mid-tween quad would lag the live views) ⇒ Teardown;
//   * anything else unfollowable (carrier with Draw/Tint/Text/… flags, a non-spine carrier) ⇒ Teardown — and a
//     NON-SPINE carrier culprit (changed or hint) additionally joins `outSubtreeBenchIds`: the controller registers
//     its room-scoped SUBTREE strikes, so a carrier that keeps animating as a unit (the fading enemy-intent row —
//     exiled as a member, it kept scaffolding bakeable children and its fade hint tore the band down forever) is
//     exiled WITH its subtree on the second strike. A SPINE carrier is never benched in any form: subtree-benching
//     is restricted to non-spine carriers precisely so the blast radius is that carrier's own subtree — it can never
//     reject the band itself.
// BenchAndTeardown dominates Teardown dominates Follow; no culprits at all ⇒ None.
// WS-BGBAKE round 3: the PURE band-bake exclusion policy — wire-data selectors (QaHideSelector idiom: NodeType
// case-insensitive SUFFIX / Name case-insensitive EXACT, never ids) naming the subtrees that must NEVER be baked:
// the whole combat world shares effZ=−10, so creatures AND their HUD (HealthBar / HpMiddleground / Nameplate /
// Intents / reticles / orbs) are band nodes — round 2 SPLIT the HealthBar subtree (static parts baked, the
// tween-owned orange HpMiddleground re-leveled on top = the stale-orange-bar defect). An excluded root becomes a
// LIVE SUBTREE ROOT: one LiveZ slot at its band position, the whole subtree skipped (never member / carrier /
// watched) and re-leveled coherently via the root override (SetZOverride flips ZAsRelative on the ROOT only;
// children stay relative — the recording's creature subtrees are z-flat). The VFX containers are excluded so
// combat-vfx SPAWNS land inside an already-live subtree: invisible to the order guard, correctly depth-sorted.
public static class BandBakeExclusionPolicy
{
    private static readonly QaHideSelector[] Selectors = BuildSelectors();

    private static QaHideSelector[] BuildSelectors()
    {
        var defaults = new[]
        {
            "type:Combat.NCreature",             // whole creature subtree: spine + HealthBar + Nameplate + Intents + reticle + orbs
            "type:Combat.NCreatureStateDisplay", // belt-and-braces if ever mounted outside a creature
            "type:Combat.NHealthBar",
            "type:Combat.NIntent",
            "name:Intents",
            "type:Combat.NSelectionReticle",
            "name:BackCombatVfxContainer",       // combat VFX spawn points — spawns become guard-invisible
            "name:FrontCombatVfxContainer",
        };

        var list = new List<QaHideSelector>(defaults.Length + 2);
        foreach (var text in defaults)
        {
            if (QaHideSelector.TryParse(text, out var sel))
            {
                list.Add(sel);
            }
        }

        return list.ToArray();
    }

    // Does the policy name this node as a live-subtree root? Pure wire-data match; the planner unifies this with the
    // runtime subtree bench behind IsLiveSubtreeRoot.
    public static bool IsExcludedRoot(MirrorNode node)
    {
        foreach (var sel in Selectors)
        {
            if (sel.Matches(node))
            {
                return true;
            }
        }

        return false;
    }
}

public static class BandInvalidationPolicy
{
    public static BandDrainDecision Classify(
        IEnumerable<string> changedCulprits,
        IEnumerable<string> hintCulprits,
        System.Func<string, NodeChangeFlags> flagsOf,
        System.Func<string, bool> isBakedMember,
        System.Func<string, bool> isSpineCarrier,
        ICollection<string> outBenchIds,
        ICollection<string> outSubtreeBenchIds)
    {
        bool any = false, anyMember = false, anyUnfollowable = false;
        foreach (var id in changedCulprits)
        {
            any = true;
            if (isBakedMember(id))
            {
                anyMember = true;
                outBenchIds.Add(id); // members only — a carrier/ancestor must NEVER be room-benched
            }
            else if (!isSpineCarrier(id))
            {
                anyUnfollowable = true;
                outSubtreeBenchIds.Add(id); // non-spine carrier — learn its subtree exile (this drain still tears down)
            }
            else if (flagsOf(id) != NodeChangeFlags.Transform)
            {
                anyUnfollowable = true; // spine carrier with non-Transform flags — unfollowable but NEVER benched
            }
        }

        foreach (var id in hintCulprits)
        {
            any = true;
            if (isBakedMember(id))
            {
                anyMember = true;
                outBenchIds.Add(id);
            }
            else
            {
                anyUnfollowable = true; // an armed tween on a carrier — never follow blind mid-tween
                if (!isSpineCarrier(id))
                {
                    outSubtreeBenchIds.Add(id); // the Intents case: a per-action fade hint on a non-spine carrier
                }
            }
        }

        if (!any)
        {
            return BandDrainDecision.None;
        }

        if (anyMember)
        {
            return BandDrainDecision.BenchAndTeardown;
        }

        return anyUnfollowable ? BandDrainDecision.Teardown : BandDrainDecision.Follow;
    }
}

// A computed bake plan: an ordered list of `Regions` (bottom→top by QuadZ; v2 emits exactly one) plus the `LiveZ`
// absolute-z overrides for the live painters interleaved between the regions (empty for v2 single-region — a prefix
// has nothing live below it). `PaintCount`/`Coverage` are the totals; `QuadZ` is the top region's quad z (legacy).
// `BandIds` (WS-BGBAKE order guard): the PROJECTED band paint-order prefix a flatten plan was computed from — every
// effZ==bucketZ id in paint order MINUS the descendants of `ExcludedLiveRoots` (the roots themselves stay) — so the
// controller can keep the bake across an OrderChanged drain whose reshuffle leaves this projection untouched (see
// IsBandOrderUnchanged; spawns/removals INSIDE an excluded subtree are invisible). `ExcludedLiveRoots` = the
// slot-collapsed live-subtree roots (exclusion policy + subtree bench): each re-levels its whole subtree via ONE
// LiveZ override on the root. Both are ALWAYS null for the exact planners (their plans and the controller's
// handling of them stay byte-identical).
public readonly record struct StaticBakePlan(
    IReadOnlyList<StaticBakeRegion> Regions,
    IReadOnlyList<LiveZOverride> LiveZ,
    int PaintCount,
    double Coverage,
    int QuadZ,
    IReadOnlyList<string>? BandIds = null,
    IReadOnlyList<string>? ExcludedLiveRoots = null)
{
    public bool IsBakeable => Regions.Count > 0;

    // Track-P3c scoped invalidation: the indices of the regions whose WatchedIds intersect `changedIds` (in region
    // order). The controller releases these regions plus every region drawn ABOVE them (higher QuadZ) — a top-suffix
    // of the band — and keeps the stable lower regions baked byte-identically (position-stable z). A pure function
    // (the controller mirrors it with per-host HashSets to stay allocation-free on the drain path). Empty ⇒ no region
    // touched ⇒ the active bake stands.
    public List<int> RegionsTouchedBy(IReadOnlySet<string> changedIds)
    {
        var touched = new List<int>();
        for (int r = 0; r < Regions.Count; r++)
        {
            foreach (var id in Regions[r].WatchedIds())
            {
                if (changedIds.Contains(id))
                {
                    touched.Add(r);
                    break;
                }
            }
        }

        return touched;
    }

    // Back-compat single-region accessors (the v2 tests + the controller's single-region path read these). For one
    // region they ARE that region's fields (v2-identical); for multi-region they aggregate for telemetry only.
    public IReadOnlyList<string> BakedIds => Regions.Count == 1 ? Regions[0].BakedIds : Aggregate(static r => r.BakedIds);

    public IReadOnlyList<string> CarrierIds => Regions.Count == 1 ? Regions[0].CarrierIds : Aggregate(static r => r.CarrierIds);

    public IReadOnlyList<string> BuildOrder => Regions.Count == 1 ? Regions[0].BuildOrder : Aggregate(static r => r.BuildOrder);

    private List<string> Aggregate(System.Func<StaticBakeRegion, IReadOnlyList<string>> pick)
    {
        var acc = new List<string>();
        foreach (var r in Regions)
        {
            acc.AddRange(pick(r));
        }

        return acc;
    }

    public static readonly StaticBakePlan None = new(
        System.Array.Empty<StaticBakeRegion>(), System.Array.Empty<LiveZOverride>(), 0, 0, 0);

    // Wrap a single region as a plan (the v2 prefix path) — exactly reproduces v2 (one region, no live re-leveling).
    public static StaticBakePlan Single(StaticBakeRegion region) =>
        new(new[] { region }, System.Array.Empty<LiveZOverride>(), region.PaintCount, region.Coverage, region.QuadZ);
}

// Why the prefix ended where it did (the boundary node's failing rule), or None when the plan is bakeable. Surfaced
// for the soak / M3_WALK so "nothing baked" is diagnosable.
public enum BakeReject
{
    None,          // bakeable (or the boundary node was simply eligible up to the end)
    EmptyScene,    // no ordered ids at all
    StaleId,       // an ordered id with no live node (BuildPaintOrder filters these now — kept for wire compatibility)
    Effect,        // particle / spine / intent / a shader not cleared for Static / (retreat) a material ref
    Dynamic,       // tween / anim-ticker / input-lift / unsettled-texture (from the controller's excluded set)
    Thrash,        // benched by the thrash guard
    Unstable,      // has not sat still long enough (stability window)
    ZIndex,        // (legacy) non-zero z-index — no longer used; the planner is z-aware
    ZOrderUncertain,// a cross-z ShowBehindParent node the paint-order model can't place
    Blend,         // an unsupported canvas blend mode
    UnknownBounds, // paints but has no trusted design-space box
    CarrierBlocked,// a strict ancestor (carrier) clips but its suppressed clone can't reproduce the stencil
    CarrierUnstable,// a strict ancestor has not sat still long enough
    CarrierDynamic, // a strict ancestor is live-owned (tween / anim / lift / unsettled)
    CarrierThrash,  // a strict ancestor is benched by the thrash guard
    TrimmedToEmpty,// the boundary trims (open clip / live show-behind-parent child) cut the whole prefix
    BudgetGate,    // too few painters or too little coverage
    NoBand,        // WS-BGBAKE: the bottom bucket is not a z<0 background band — band flatten refused, exact path decides
}

// Diagnostics from a Plan call (indices into the PAINT order). RawBoundary = the first-ineligible cut; TrimmedBoundary
// = after the open-clip / show-behind trims; BoundaryId/Reason = what stopped the raw prefix; MinZ/QuadZ = the baked
// band's effZ span (QuadZ = the boundary z the quad takes); CarrierCount = ancestor scaffolding clones;
// StaticShaderCount = baked shader nodes (cleared for Static-mode baking).
public readonly record struct StaticBakeDiagnostic(
    int RawBoundary,
    int TrimmedBoundary,
    int PaintCount,
    double Coverage,
    string? BoundaryId,
    BakeReject BoundaryReason,
    int MinZ,
    int QuadZ,
    int CarrierCount,
    int StaticShaderCount)
{
    public static StaticBakeDiagnostic Empty(BakeReject reason, string? boundaryId = null) =>
        new(0, 0, 0, 0, boundaryId, reason, 0, 0, 0, 0);
}
