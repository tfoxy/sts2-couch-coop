namespace CouchCoop.MirrorProtocol.SceneModel;

using System;
using System.Collections.Generic;

// Track-B "perceived Full" text overlay — the PURE-C# eligibility + occlusion planner (Godot-free, Exe-testable,
// exactly like CullIndex / StaticBakePlanner). At a Half/Quarter render scale the whole mirror stage rasterizes at
// design/2 (or /4) res and gets scaled up, so text — which the eye reads pixel-for-pixel — turns mushy. This planner
// decides WHICH static, safe text labels can be promoted OUT of the scaled stage into a native-resolution overlay
// CanvasLayer, where they rasterize crisp (the TextOverlay controller on the Godot side builds/orders the proxies).
//
// The producer never streams a "this text is promotable" flag; the decision is proved from geometry + paint order +
// the live "dynamically owned" facts the controller collects off the views (tween/bob/lift/unsettled). CONSERVATIVE
// by construction: a missed promotion just forgoes crispness (the label renders in-stage as today); a WRONG promotion
// paints native text where a covering panel should hide it, or freezes an animating label. Every rule errs toward NOT
// promoting.
//
// PAINT-ORDER MODEL. TextAttachment.Sync re-asserts the "__text" child as the LAST child every Sync, so a node's text
// paints AFTER its whole subtree. In the pre-order OrderedIds flatten a node N's subtree is the contiguous run
// [index(N), subtreeEnd(N)]; a plain self-paint of N happens at index(N); a label L's text happens JUST AFTER
// subtreeEnd(L). We give each paint contribution a total-ordered key:
//   self-paint of N  →  (index(N),      0, 0)
//   text-paint of L  →  (subtreeEnd(L), 1, -depth(L))
// so a plain node N occludes label L iff index(N) > subtreeEnd(L) (its self-paint key beats L's text key); every node
// inside L's subtree (index in [index(L),subtreeEnd(L)]) sorts BEFORE L's text (tier 0 < 1 at the boundary) so a
// label is never blocked by its own descendants; and two nested labels tiebreak by -depth so the ANCESTOR's text
// paints last (on top), matching Godot. Index/depth/subtreeEnd tables are rebuilt only on Keyframe/OrderChanged.
public sealed class TextOverlayPlanner
{
    public const double DesignHeight = CullIndex.DesignHeight;

    // Slack (design px) added on every side of a promoted label's paint box: absorbs font-metric overflow (ascenders/
    // descenders, outline, shadow) beyond the streamed rect so an occlusion test near a box edge stays conservative.
    // This is a pure-C# GUESS (the planner can't measure fonts) — a blanket ±24 halo around the STREAMED LAYOUT RECT.
    // A centered/right-aligned counter (TopBar HP, gold, energy) leaves most of its rect empty, so this halo phantom-
    // extends the label into a genuinely ADJACENT icon and the occlusion gate rejects it as Occluded though nothing
    // covers a single glyph. Track E fixes this: when the client feeds a MEASURED glyph AABB for an id, the planner
    // uses that tight box + the small MeasuredSlackPx below instead — this TextSlackPx is only the FALLBACK now.
    public const double TextSlackPx = 24;

    // Track E: the tiny safety margin added on every side of a MEASURED glyph AABB (the client reads the live "__text"
    // child's real laid-out extent). The measurement already bounds ink (advance box + outline + shadow), so a hair of
    // margin covers sub-pixel rasterization / rounding — nothing like the blanket ±24 the pure-C# guess needs.
    public const double MeasuredSlackPx = 4;

    // Extra horizontal slack added when the stage is widened (F≠1): the label's rendered box is shifted by its
    // cumulative SpreadRecord.Dx and may be anchor-WIDENED, and the planner works off the UN-widened streamed rect, so
    // pad the wide-screen uncertainty.
    public const double SpreadSlackPx = 16;

    // A dynamically-owned (lift/unsettled-texture/modulate-tween) painter is a blocker whose exact pixels we can't
    // trust this instant AND whose motion is UNBOUNDED (a transform tween sweeps anywhere, a lift raises arbitrarily);
    // inflate its box generously so an earlier label near a jittering occluder stays in-stage. (Track-C: the halo
    // magnitude now lives in PaintOrderTables so the CardLayerPlanner inflates occluders identically.)
    public const double DynamicSlackPx = PaintOrderTables.DynamicSlackPx;

    // A BOUNDED cosmetic painter (the ±10px enemy-intent bob, the in-place orb spin — CosmeticAnimator) can only jitter
    // within a small, KNOWN envelope: the bob's peak-to-peak vertical travel is 2×amp = 20px, the orb spin's AABB grows
    // by ≤ (√2−1)/2 · side ≈ 0.2·side (a few px for a ~50px orb). Inflating such a blocker by the FULL DynamicSlackPx=48
    // needlessly occludes a neighbor a bounded cosmetic never reaches. 20px covers a bob sampled at either extreme
    // travelling to the other, and the small-orb spin growth — safe (never under-covers the real drawn art).
    public const double BoundedCosmeticSlackPx = PaintOrderTables.BoundedCosmeticSlackPx;

    // ---- reject taxonomy (first-fail; a per-reason histogram explains current coverage) --------------------------
    public enum TextReject
    {
        None,          // promotable
        Dynamic,       // id or an ancestor is tween/bob/lift/unsettled-texture owned (controller's excluded set)
        CardOwned,     // id is inside an NCard subtree whose text is owned by the CardLayer
        Effect,        // particle / spine / shader / intent / material anywhere on the chain
        Blend,         // a non-Mix canvas blend mode anywhere on the chain
        Clip,          // a clipping ancestor that does not fully contain the label
        ZOrder,        // ZIndex≠0 or ShowBehindParent anywhere on the chain (breaks the DFS-order premise)
        UnknownBounds, // the label has no trusted design-space box
        Offscreen,     // the label's box is fully outside the design rect
        Invisible,     // the label or an ancestor is not visible, or the effective modulate alpha is ~0
        Occluded,      // something paints on top of the label's text and overlaps it
    }

    // Current planner geometry policy:
    //
    // GrazeTolerancePx — the occlusion test for a MEASURED candidate deflates the candidate box by this much before
    // the overlap sweep. A client MEASUREMENT bounds real ink exactly (advance box + outline + shadow); an AABB
    // "overlap" that intrudes no deeper than this is a side-bearing / rounding graze (the advance box extends past
    // the last glyph's ink by the trailing side bearing ≈2-3px; boxes are closed so touching edges "overlap"), not
    // evidence that a later painter covers a single glyph pixel. Deliberately small; UNMEASURED candidates keep the
    // full-conservative untightened test.
    public const double GrazeTolerancePx = 4;

    // A node clips when its ClipChildren flag is set. Eligibility keeps a label when the clipping ancestor's rendered
    // rect fully contains that label's box, because the overlay then needs no crop to match it.
    private readonly Func<MirrorNode, bool> _clips;

    public TextOverlayPlanner(Func<MirrorNode, bool>? clipPredicate = null) =>
        _clips = clipPredicate ?? (static n => n.ClipChildren != 0);

    // ---- paint-order index + shared occlusion helpers (Track-C extracted these into PaintOrderTables so the
    // CardLayerPlanner reuses the EXACT same model; this planner now delegates the index tables + the geometry/
    // predicate helpers to it — the existing TextOverlayPlannerTests prove no behavioural drift). -----------------
    private readonly PaintOrderTables _tables = new();

    // Shared empty set for the bounded-cosmetic blocker input (avoids a per-Plan allocation when absent).
    private static readonly HashSet<string> EmptySet = new(StringComparer.Ordinal);

    // Diagnostics from the LAST Plan.
    private readonly Dictionary<TextReject, int> _histogram = new();
    public IReadOnlyDictionary<TextReject, int> LastRejectHistogram => _histogram;
    public int LastEvaluated { get; private set; }   // text-bearing nodes considered (M in the measured=N/M telemetry)
    public int LastPromoted { get; private set; }    // labels promoted
    public int LastMeasured { get; private set; }    // text candidates that used a client MEASURED box (N in measured=N/M)

    // WS-CRISP capture (dumpcrisp verb): when CaptureRejects is set the LAST Plan records the per-id first-fail reject
    // (None for a promoted label) and, for an Occluded label, the first blocker id. Opt-in so a normal Eval pays zero
    // recording cost (the controller flips it on only around a diagnostic Plan). Cleared + refilled by that Plan.
    public bool CaptureRejects;
    private readonly Dictionary<string, TextReject> _rejectById = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string?> _culpritById = new(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, TextReject> LastRejectById => _rejectById;
    public IReadOnlyDictionary<string, string?> LastCulpritById => _culpritById;

    // Optional debug sink (set by the controller under an env flag) — receives one line per occluded candidate naming
    // the first blocker, so an over-occlusion can be diagnosed without a debugger. Null in production (zero cost).
    public System.Action<string>? Debug;

    // Rebuild the pre-order index/depth/subtreeEnd tables. Call on the first Plan and on every Keyframe/OrderChanged
    // drain (the controller does). Cheap (two linear passes) and only on structural drains. Delegated to the shared
    // PaintOrderTables (Track-C).
    public void RebuildIndex(MirrorState state) => _tables.RebuildIndex(state);

    // ---- the plan --------------------------------------------------------------------------------------------------

    // Compute the promotable text labels NOW. `spreadDxOf` returns a node's cumulative wide-screen shift (0 at F=1);
    // `spreadWidthOf` optionally returns a node's anchor-widened rendered width. It keeps clipping-ancestor bounds
    // aligned with the stretched scene geometry.
    // `spreadFactor` (stageWidth/1920) gates the extra spread slack. `dynamicallyExcluded` = the ids whose live view
    // is tween/bob/lift/unsettled owned (the controller's CollectBakeExcluded-style sweep); `transformOwned` ⊆ that,
    // the ids owning an ACTIVE transform tween (their painted position is uncertain → they block everything earlier).
    // `boundedCosmetic` ⊆ dynamicallyExcluded — the ids whose ONLY dynamism is a bounded ±10px bob / in-place spin
    // (the controller's pure-cosmetic sweep); as a BLOCKER such a node gets the small BoundedCosmeticSlackPx halo, not
    // the full unbounded DynamicSlackPx. `measuredExtents` (Track E, optional) is the client-measured DESIGN-space glyph
    // AABB per text id (already post-spread — read off the live view's real global transform); when an id is present its
    // LABEL box (candidacy + demoted-text-blocker role) uses that tight box + MeasuredSlackPx instead of the streamed
    // rect + TextSlackPx guess. A MISSING id falls back to the rect+slack box → a conservative SUPERSET of the measured
    // one, never less safe than before. Pure — no side effects beyond diagnostics. Output ASCENDING by paint key.
    public TextOverlayPlan Plan(
        MirrorState state,
        GlobalTransformIndex transforms,
        double spreadFactor,
        Func<string, double> spreadDxOf,
        IReadOnlySet<string> dynamicallyExcluded,
        IReadOnlySet<string> transformOwned,
        IReadOnlySet<string>? boundedCosmetic,
        IReadOnlyDictionary<string, DesignAabb>? measuredExtents,
        bool excludeCardSubtrees,
        TextOverlayOptions options,
        Func<string, double>? spreadWidthOf,
        IReadOnlyDictionary<string, double>? fadeInAlpha)
    {
        boundedCosmetic ??= EmptySet;
        _histogram.Clear();
        LastEvaluated = 0;
        LastPromoted = 0;
        LastMeasured = 0;
        if (CaptureRejects)
        {
            _rejectById.Clear();
            _culpritById.Clear();
        }

        var ordered = state.OrderedIds;
        if (ordered.Count == 0)
        {
            return TextOverlayPlan.None;
        }

        bool widened = spreadFactor != 1;
        double designWidth = 1920 * spreadFactor; // 1920 at F=1; the widened design rect otherwise

        // Pass A — classify every node into occluder contributions + candidate labels. One reverse-sweep event list.
        var events = new List<Event>(ordered.Count);
        var agnostic = new List<BlockerEntry>();  // z≠0 / ShowBehindParent painters: block order-agnostically
        bool agnosticUnknown = false;                            // an order-agnostic painter with unknown bounds → blocks everything
        string? agnosticUnknownId = null;

        foreach (var id in ordered)
        {
            if (!state.Nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            // A self-paint occluder must be an opaque own-painter AND rendered-visible through its WHOLE ancestor
            // chain (an inactive full-screen overlay's dimmer ColorRect is hidden by its parent's Visible=false /
            // modulate α≈0 — its OWN alpha is 1, but it paints nothing, so it must not occlude).
            bool paintsSelf = IsOpaqueBlocker(node) && ChainCovers(state, node, id);
            bool textBearing = node.Text is { Text.Length: > 0 } && node.Visible && OwnAlpha(node) > 0.02;
            if (!paintsSelf && !textBearing)
            {
                continue;
            }

            // TWO boxes: a LABEL box (layout rect + text slack — the conservative extent of this node's own glyphs,
            // used for its candidacy + as a demoted-text blocker) and a BLOCKER box (this node's tight DRAWN ART, no
            // text-slack halo, region-letterboxed — used when its own texture/fill/range OCCLUDES an earlier label). A
            // texture never overflows its rect the way a font can, so an occluder does not receive text slack.
            //
            // A measured LABEL has role-specific boxes: the CANDIDATE box is raw measured ink
            // box (the measurement already bounds advance + outline + shadow; the MeasuredSlackPx pad only guarded
            // rounding, which the GrazeTolerancePx deflate at test time covers), while the box used when the label is
            // a demoted-text BLOCKER of earlier labels keeps the +MeasuredSlackPx pad (the conservative direction for
            // that role). Unmeasured ids keep the single rect+TextSlackPx box for both roles.
            bool isMeasured = measuredExtents is not null && measuredExtents.ContainsKey(id);
            DesignAabb? labelBox = LabelBoxOf(id, node, transforms, spreadDxOf, widened, measuredExtents,
                candidateRole: true);

            // The box used when THIS label is a demoted-text OCCLUDER of earlier labels. WS-EVENTTEXT #14 Leg B: when
            // the client supplied a TIGHT measured OCCLUDER box for this text id (TextBlockerExtents — a single-line
            // RichTextLabel narrowed to its drawn ink, e.g. the full-screen-box "NEOW" ancient banner), use it + the
            // small MeasuredSlackPx instead of the full box width; that box can only SHRINK toward the drawn art, so a
            // present id is never less safe than the regular blocker box. Absent id uses the measured/rect blocker box:
            // a measured id keeps its slack-padded measured box, an unmeasured id its rect+TextSlack.
            DesignAabb? labelBlockerBox;
            if (options.TextBlockerExtents is { } blockerText && blockerText.TryGetValue(id, out var tightBlocker))
            {
                labelBlockerBox = tightBlocker.Inflate(MeasuredSlackPx);
            }
            else if (isMeasured)
            {
                labelBlockerBox = LabelBoxOf(id, node, transforms, spreadDxOf, widened, measuredExtents, candidateRole: false);
            }
            else
            {
                labelBlockerBox = labelBox;
            }

            // A client-measured drawn-art box for a textured occluder (decode-time alpha used-rect,
            // stretch-mapped into the layout rect by the live view) replaces the layout-rect blocker box — the
            // "tighten the OCCLUDER box" precedent extended from the streamed-region letterbox to a measurement (a
            // TopBar room icon streams no TextureRegion). It can only shrink the layout rect and bounds all painted art.
            // never under-covers real art (the used-rect bounds every non-transparent pixel).
            DesignAabb? blockerBox = !paintsSelf ? null
                : options.BlockerArtExtents is { } artMap && artMap.TryGetValue(id, out var art) ? art
                : BlockerAabb(id, node, transforms, spreadDxOf, widened);

            // A measured transparent hole inside this blocker's art (a stretched scroll-edge fade
            // gradient covers the whole dialog rect but paints only its extreme rows — a label fully inside the
            // transparent middle is NOT covered). Only trusted for a STATIC blocker: a jittering one's hole moves.
            DesignAabb? blockerHole = paintsSelf && !dynamicallyExcluded.Contains(id)
                && options.BlockerArtHoles is { } holeMap && holeMap.TryGetValue(id, out var hole)
                ? hole
                : null;

            // Z-indexed painters use their effective Z paint key; only ShowBehindParent remains order-agnostic.
            bool orderAgnostic = node.ShowBehindParent;
            if (orderAgnostic && (paintsSelf || textBearing))
            {
                // A text-agnostic painter blocks with its glyph (label) box; a pure self-painter with its tight art box.
                // Text uses its blocker-role box, with slack retained because it acts as an occluder here.
                DesignAabb? agBox = textBearing ? labelBlockerBox : blockerBox;
                if (agBox is { } ab)
                {
                    agnostic.Add(new BlockerEntry(Blocker(id, ab, dynamicallyExcluded, boundedCosmetic), id,
                        textBearing ? null : blockerHole));
                }
                else
                {
                    agnosticUnknown = true;
                    agnosticUnknownId ??= id;
                }

                // An order-agnostic painter is NOT also a candidate (eligibility rejects ZOrder chains) and its
                // self/text contribution is fully captured by the agnostic set — skip the ordered events for it.
                continue;
            }

            // Self-paint occluder event. An UNBOUNDED effect (a spine/shader anchor or a materialed node with no
            // streamed rect) covers only its localized effect art, NEVER the full screen, so it must not suffix-bail
            // every earlier label — skip it as a blocker. A genuinely unbounded PLAIN painter (no rect + fill/texture/
            // range, vanishingly rare) still suffix-bails as unknown coverage.
            if (paintsSelf && !(blockerBox is null && IsEffectBearing(node)))
            {
                events.Add(new Event(
                    PaintKey(_tables.EffZOf(id), _tables.IndexOf(id), 0, 0),
                    EventKind.SelfPaint,
                    id,
                    blockerBox,
                    Suffix: transformOwned.Contains(id),
                    Dynamic: dynamicallyExcluded.Contains(id),
                    Hole: blockerHole));
            }

            // Text-paint: a candidate (decided in the sweep) OR an in-stage blocker (if it fails eligibility).
            if (textBearing)
            {
                LastEvaluated++;
                if (measuredExtents is not null && measuredExtents.ContainsKey(id))
                {
                    LastMeasured++;
                }

                var reject = Eligibility(id, node, state, transforms, designWidth, labelBox,
                    excludeCardSubtrees, options, spreadDxOf, spreadWidthOf, widened,
                    fadeInAlpha);
                if (CaptureRejects)
                {
                    _rejectById[id] = reject;
                }

                events.Add(new Event(
                    PaintKey(_tables.EffZOf(id), _tables.SubtreeEndOf(id), 1, -_tables.DepthOf(id)),
                    EventKind.TextPaint,
                    id,
                    labelBox,
                    Suffix: false,
                    Dynamic: dynamicallyExcluded.Contains(id),
                    Candidate: reject == TextReject.None,
                    Reject: reject,
                    BlockerBox: labelBlockerBox,
                    Measured: isMeasured));

                if (reject != TextReject.None)
                {
                    Bump(reject);
                }

                Debug?.Invoke($"eval id={id} name='{node.Name}' reject={reject} box={FormatBox(labelBox)} {NodeDetail(node)}");
            }
        }

        // Pass B — single reverse sweep (latest paint key first). Accumulate later-painting blocker geometry; decide
        // each candidate against it (+ the order-agnostic set + a suffix bail).
        events.Sort(static (a, b) => b.Key.CompareTo(a.Key));

        var blockers = new List<BlockerEntry>();
        bool suffixBlockAll = agnosticUnknown; // an unknown-bounds agnostic painter blocks every label everywhere
        string? suffixCulprit = agnosticUnknownId;
        var promoted = new List<TextOverlayItem>();

        foreach (var ev in events)
        {
            if (ev.Kind == EventKind.SelfPaint)
            {
                // A self-paint contributes a blocker for every EARLIER-painting label.
                if (ev.Suffix || ev.Box is null)
                {
                    suffixBlockAll = true; // transform-tween-owned OR unknown-bounds later painter → block all earlier
                    suffixCulprit ??= ev.Id;
                }
                else
                {
                    blockers.Add(new BlockerEntry(ev.Box.Value, ev.Id, ev.Hole));
                }

                continue;
            }

            // TextPaint.
            if (!ev.Candidate)
            {
                // A non-promotable text label still rasterizes in-stage → it covers earlier overlapping labels.
                // The measured blocker box keeps its slack pad in this role.
                if (ev.BlockerBox is { } nb && ev.Reject != TextReject.Invisible && ev.Reject != TextReject.Offscreen
                    && ev.Reject != TextReject.UnknownBounds)
                {
                    blockers.Add(new BlockerEntry(nb, ev.Id, null));
                }
                else if (ev.BlockerBox is null && ev.Reject != TextReject.Invisible && ev.Reject != TextReject.Offscreen)
                {
                    suffixBlockAll = true;
                    suffixCulprit ??= ev.Id;
                }

                continue;
            }

            // A candidate is promotable unless something later overlaps it. A measured candidate's test box
            // is deflated by GrazeTolerancePx — the measurement bounds ink exactly, so an AABB graze no deeper than
            // the tolerance is side-bearing/rounding, not covered ink. Unmeasured candidates test untightened.
            var label = ev.Box!.Value;
            var testBox = ev.Measured ? DeflateSafe(label, GrazeTolerancePx) : label;
            string? culprit;
            DesignAabb? culpritBox = null;
            if (suffixBlockAll)
            {
                culprit = suffixCulprit;
            }
            else if (FirstOverlapEntry(testBox, blockers) is { } hb)
            {
                culprit = hb.Id;
                culpritBox = hb.Box;
            }
            else if (FirstOverlapEntry(testBox, agnostic) is { } ha)
            {
                culprit = ha.Id;
                culpritBox = ha.Box;
            }
            else
            {
                culprit = null;
            }

            if (culprit is not null)
            {
                Bump(TextReject.Occluded);
                if (CaptureRejects)
                {
                    _rejectById[ev.Id] = TextReject.Occluded;
                    _culpritById[ev.Id] = culprit;
                }

                if (Debug is not null)
                {
                    string cn = state.Nodes.TryGetValue(culprit, out var cnode) ? cnode.Name : "?";
                    string ct = cnode?.NodeType ?? "?";
                    bool cdyn = dynamicallyExcluded.Contains(culprit);
                    string ckind = cnode is null ? "?"
                        : cnode.TextureUrl is not null ? "tex"
                        : cnode.Range is not null ? "range"
                        : cnode.FillColor is not null ? "fill"
                        : cnode.Text is { Text.Length: > 0 } ? "text" : "?";
                    Debug($"occluded id={ev.Id} name='{(state.Nodes.TryGetValue(ev.Id, out var en) ? en.Name : "?")}' " +
                          $"labelBox={FormatBox(label)} by={culprit} byName='{cn}' byType={ct} byKind={ckind} " +
                          $"byDyn={cdyn} byBox={FormatBox(culpritBox)} by:{(cnode is null ? "?" : NodeDetail(cnode))}");
                }

                blockers.Add(new BlockerEntry(ev.BlockerBox ?? label, ev.Id, null)); // demoted → covers earlier labels
            }
            else
            {
                promoted.Add(new TextOverlayItem(ev.Id, ev.Key, label));
            }
        }

        // Emit in ASCENDING paint-key order (the controller MoveChild-orders holders by this: ancestor text last = top).
        promoted.Reverse();
        LastPromoted = promoted.Count;
        return new TextOverlayPlan(promoted);
    }

    // ---- per-drain demotion guard (cheap; runs every drain, not the eval cadence) --------------------------------

    // Given the CURRENTLY promoted items, decide which must demote and which must rebuild their content in place, from
    // just this drain's changed set + tween hints (no full re-Plan). Conservatism invariant (tested): the demote set
    // is a SUPERSET of what a fresh Plan would now reject for those ids — so a stale promotion can never survive a
    // drain that would have rejected it. `demoteInto` / `rebuildInto` are cleared and filled.
    public void CollectDemotions(
        MirrorState state,
        GlobalTransformIndex transforms,
        double spreadFactor,
        Func<string, double> spreadDxOf,
        IReadOnlyList<TextOverlayItem> promoted,
        IReadOnlySet<string> changedIds,
        IReadOnlyList<MirrorTweenHint> hints,
        IReadOnlySet<string> dynamicallyExcluded,
        ISet<string> demoteInto,
        ISet<string> rebuildInto,
        ISet<string> churnDemoteInto,
        IReadOnlyDictionary<string, DesignAabb>? measuredExtents,
        bool excludeCardSubtrees,
        TextOverlayOptions options,
        Func<string, double>? spreadWidthOf,
        IReadOnlyDictionary<string, double>? fadeInAlpha)
    {
        demoteInto.Clear();
        rebuildInto.Clear();
        churnDemoteInto.Clear();
        if (promoted.Count == 0)
        {
            return;
        }

        bool widened = spreadFactor != 1;
        var promotedIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in promoted)
        {
            promotedIds.Add(p.Id);
        }

        foreach (var p in promoted)
        {
            if (demoteInto.Contains(p.Id))
            {
                continue;
            }

            // A promoted label whose own node changed is revalidated. Ineligible labels demote; eligible labels rebuild.
            if (changedIds.Contains(p.Id))
            {
                // Use the SAME box source as Plan (measured if the client supplied one for this id, else rect+slack), so
                // the demote set stays a conservative SUPERSET of what a fresh Plan would reject (the locked invariant).
                if (state.Nodes.TryGetValue(p.Id, out var pn)
                    && Eligibility(p.Id, pn, state, transforms, 1920 * spreadFactor,
                        LabelBoxOf(p.Id, pn, transforms, spreadDxOf, widened, measuredExtents, candidateRole: true),
                        excludeCardSubtrees, options, spreadDxOf, spreadWidthOf, widened,
                        fadeInAlpha) == TextReject.None)
                {
                    rebuildInto.Add(p.Id);
                }
                else
                {
                    demoteInto.Add(p.Id);
                    rebuildInto.Remove(p.Id);
                    continue;
                }
            }

        }

        // 3. A changed painting node that now overlaps a promoted label ⇒ demote the label (a new occluder appeared).
        foreach (var id in changedIds)
        {
            if (!state.Nodes.TryGetValue(id, out var node) || !PaintsAny(node))
            {
                continue;
            }

            if (RenderedAabb(id, node, transforms, spreadDxOf, widened) is not { } cbox)
            {
                continue;
            }

            foreach (var p in promoted)
            {
                // A changed ancestor paints behind the label's text; the per-frame proxy sync tracks that motion.
                if (IsAncestorOf(state, id, p.Id))
                {
                    continue;
                }

                if (!promotedIds.Contains(id) && !demoteInto.Contains(p.Id) && cbox.Overlaps(p.Aabb))
                {
                    demoteInto.Add(p.Id);
                    rebuildInto.Remove(p.Id);
                }
            }
        }

        // A promoted label whose clipping ancestor changed this drain demotes. Containment allows a label inside a clip
        // region only while the clip rect fully contains it; a scroll
        // (the ScrollContainer's own node changing) moves that containment out from under the proof mid-drain, and
        // the un-nested overlay proxy cannot reproduce the crop. Demote-on-scroll (the label re-promotes at the next
        // eval if still fully inside) instead of building clip tracking.
        foreach (var p in promoted)
        {
            if (demoteInto.Contains(p.Id))
            {
                continue;
            }

            string? cur = state.Nodes.TryGetValue(p.Id, out var pnode) ? pnode.ParentId : null;
            int guard = 0;
            while (cur is not null && state.Nodes.TryGetValue(cur, out var anode) && guard++ < 4096)
            {
                if (_clips(anode) && changedIds.Contains(cur))
                {
                    demoteInto.Add(p.Id);
                    rebuildInto.Remove(p.Id);
                    break;
                }

                cur = anode.ParentId;
            }
        }

        // A transform hint's swept box (current ∪ endpoint) overlapping a promoted label demotes it, except when the
        // hint targets that label's own chain, which the per-frame proxy sync tracks.
        foreach (var h in hints)
        {
            if (h.EndTransform is not { Count: 6 } endT
                || !state.Nodes.TryGetValue(h.TargetId, out var tn)
                || tn.LocalRect is not { } rect)
            {
                continue;
            }

            DesignAabb? cur = RenderedAabb(h.TargetId, tn, transforms, spreadDxOf, widened);
            var endBox = CullBounds.OfRect(endT, rect.X, rect.Y, rect.Width, rect.Height);
            var swept = cur is { } c ? c.Union(endBox) : endBox;
            foreach (var p in promoted)
            {
                if (string.Equals(h.TargetId, p.Id, StringComparison.Ordinal) || IsAncestorOf(state, h.TargetId, p.Id))
                {
                    continue;
                }

                if (!demoteInto.Contains(p.Id) && swept.Overlaps(p.Aabb))
                {
                    demoteInto.Add(p.Id);
                    rebuildInto.Remove(p.Id);
                }
            }
        }
    }

    // ---- effective modulate (the overlay holder's ancestor-composed tint) ----------------------------------------

    // The product of the Godot Modulate down the chain root→id. The overlay holder sits UNDER the CanvasLayer (not
    // nested), so it must carry the full ancestor cascade the in-stage label got for free via tree nesting. Delegated
    // to the shared PaintOrderTables (Track-C); kept here as the public entry point the TextOverlay controller + tests
    // already call.
    public static Rgba EffectiveModulate(MirrorState state, string id) => PaintOrderTables.EffectiveModulate(state, id);

    // WS-CRISP R17 fade-in variant (delegated) — see PaintOrderTables.EffectiveModulate(state, id, fadeInAlpha).
    public static Rgba EffectiveModulate(MirrorState state, string id, IReadOnlyDictionary<string, double>? fadeInAlpha) =>
        PaintOrderTables.EffectiveModulate(state, id, fadeInAlpha);

    // ---- eligibility (pre-occlusion; first-fail) ------------------------------------------------------------------

    // The per-label gate up to (not including) occlusion — order: card-owned → effect → blend →
    // clip → z-order → unknown-bounds → offscreen → invisible. `box` is the pre-computed rendered AABB (may be null).
    // A candidate's own-chain motion is tracked by the controller; dynamic ownership still enlarges occluder halos.
    // `excludeCards` applies the CardLayer's current root verdict: promoted or not-yet-evaluated cards own their text;
    // known declined cards fall through to the regular text-overlay rules.
    private TextReject Eligibility(
        string id,
        MirrorNode label,
        MirrorState state,
        GlobalTransformIndex transforms,
        double designWidth,
        DesignAabb? box,
        bool excludeCards,
        TextOverlayOptions options,
        Func<string, double>? spreadDxOf = null,
        Func<string, double>? spreadWidthOf = null,
        bool widened = false,
        IReadOnlyDictionary<string, double>? fadeInAlpha = null)
    {
        // Walk self + ancestors once, testing the chain rules; a single walk keeps this cheap on deep trees.
        string? cur = id;
        int guard = 0;
        bool anyInvisible = false;
        while (cur is not null && state.Nodes.TryGetValue(cur, out var node) && guard++ < 4096)
        {
            if (excludeCards && NodeTypeLeaf(node.NodeType) == "NCard")
            {
                // Only a card the CardLayer ACTUALLY promoted (its clone carries the labels
                // crisp — a loose proxy would double the text) or a card it has NOT yet evaluated (the same-drain
                // window a freshly dealt card sits in — err toward NOT promoting until the CardLayer claims or
                // declines it) owns its text. A KNOWN-DECLINED card (a deck-dialog grid card the CardLayer rejects by
                // design: AncestorClip, ParkedCap economics) renders in-stage mushy, so its labels FALL THROUGH to
                // the ordinary text-overlay rules — that is the whole (b) fix.
                bool owned = options.CardPromotedRoots.Contains(cur)
                    || !options.CardKnownRoots.Contains(cur);
                if (owned)
                {
                    return TextReject.CardOwned;
                }
            }

            // The controller tracks the candidate's own-chain motion per frame; the set still feeds occluder halos.

            if (IsEffectBearing(node))
            {
                // A shader/material on an ANCESTOR shades only that ancestor's OWN draw (a Godot canvas
                // material never cascades to children), so it cannot alter how the label's text rasterizes — the deck
                // button's hover shader / a card TypePlaque's HSV NinePatch no longer reject the label under them.
                // Particle / spine / intent ancestors STILL reject (they draw through attached children with
                // unknowable extents), as does any effect on the label node itself (its own material shades its text).
                bool shaderAncestorDoesNotAffectText = !ReferenceEquals(cur, id)
                    && node.ParticleSpec is null && node.SpineSceneResPath is null && node.IntentFrames is null;
                if (!shaderAncestorDoesNotAffectText)
                {
                    return TextReject.Effect;
                }
            }

            if (node.CanvasBlendMode is { } bm && bm != 0)
            {
                return TextReject.Blend;
            }

            // The label node itself clipping its OWN children is fine (text isn't a child view); an ANCESTOR clip
            // would crop the label in-stage but not on the un-nested overlay, so reject.
            //
            // A clipping ancestor whose exact clip rect (its rendered rect under the global
            // — no slack pads; the label box IS slack-padded, which is the strict direction for a containment test; and
            // WS-COLUMN: the anchor-WIDENED rendered width when the stage is stretched, so a 0..1-anchored ScrollContainer
            // is not treated as narrower than it draws) fully CONTAINS the label box cannot crop a single glyph pixel,
            // so it is non-clipping FOR THIS LABEL —
            // this is what lets a deck-dialog grid card's title/description (under the dialog ScrollContainer) and
            // the dialog's sort-option labels promote. A partially-contained (scrolled-half-out) label still rejects:
            // the overlay cannot reproduce the crop. The scroll hazard is handled by the per-drain guard (a changed
            // clipping ancestor demotes every promoted label under it — see CollectDemotions rule 5).
            if (!ReferenceEquals(cur, id) && _clips(node))
            {
                bool contained = box is { } lb && spreadDxOf is not null
                    && PaintOrderTables.ClipRenderedAabb(cur, node, transforms, spreadDxOf, spreadWidthOf, widened) is { } clipRect
                    && Contains(clipRect, lb);
                if (!contained)
                {
                    return TextReject.Clip;
                }
            }

            // Z-indexed labels use their effective Z paint key. ShowBehindParent remains unorderable within its band.
            if (node.ShowBehindParent)
            {
                return TextReject.ZOrder;
            }

            if (!node.Visible)
            {
                anyInvisible = true;
            }

            cur = node.ParentId;
        }

        if (box is null)
        {
            return TextReject.UnknownBounds;
        }

        if (box.Value.FullyOutside(designWidth, DesignHeight, 0))
        {
            return TextReject.Offscreen;
        }

        // WS-CRISP R17: `anyInvisible` (a Visible=false ancestor) stays fail-closed. The effective-modulate α check
        // uses the fade-in override so a label under a tween-owned fade-IN (whose streamed modulate the producer pins
        // at ≈0 for the whole reveal) reads the tween ENDPOINT alpha (>0) instead of the pin — the rest-site focused
        // description promotes at the start of its fade instead of only after the tween settles. Null map ⇒ the plain
        // streamed product (byte-identical to pre-R17). A genuine fade-OUT never enters the map (endpoint ≤ 0.05).
        if (anyInvisible || EffectiveModulate(state, id, fadeInAlpha).A <= 0.004)
        {
            return TextReject.Invisible;
        }

        return TextReject.None;
    }

    // ---- geometry / predicate helpers ----------------------------------------------------------------------------

    // Track E: the LABEL box for a text node — the box used for its candidacy (eligibility + occlusion) AND for its
    // role as a demoted-text BLOCKER of earlier labels. When the client supplied a MEASURED glyph AABB for `id`, use
    // that tight, alignment-aware box + the small MeasuredSlackPx (the measurement is already in post-spread design
    // space, so NO ShiftX). Otherwise fall back to the pure-C# rect + TextSlackPx guess — a strict SUPERSET of the
    // measured box, so a missing measurement is never LESS safe than before. The single choke point Plan AND
    // CollectDemotions call, so both always agree on the box source (the demotion-superset invariant).
    private static DesignAabb? LabelBoxOf(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf, bool widened,
        IReadOnlyDictionary<string, DesignAabb>? measuredExtents, bool candidateRole = false)
    {
        if (measuredExtents is not null && measuredExtents.TryGetValue(id, out var measured))
        {
            // The candidate box is the raw measured ink box — the measurement
            // already bounds advance + outline + shadow, and the occlusion test separately deflates by
            // GrazeTolerancePx. The BLOCKER role (candidateRole=false) keeps the slack pad.
            return candidateRole ? measured : measured.Inflate(MeasuredSlackPx);
        }

        return RenderedAabb(id, node, transforms, spreadDxOf, widened);
    }

    // Containment test for a clipping ancestor: does `outer` fully contain `inner`?
    private static bool Contains(DesignAabb outer, DesignAabb inner) =>
        outer.MinX <= inner.MinX && outer.MinY <= inner.MinY && outer.MaxX >= inner.MaxX && outer.MaxY >= inner.MaxY;

    // Shrink a box by `d` on every side, clamped so it never inverts (a tiny box degenerates to its center point).
    private static DesignAabb DeflateSafe(DesignAabb b, double d)
    {
        double dx = Math.Min(d, (b.MaxX - b.MinX) / 2);
        double dy = Math.Min(d, (b.MaxY - b.MinY) / 2);
        return new DesignAabb(b.MinX + dx, b.MinY + dy, b.MaxX - dx, b.MaxY - dy);
    }

    // The node's rendered design-space AABB (label box: layout rect under the global, spread-shifted, + text slack).
    // Delegated to PaintOrderTables with THIS planner's text/spread slack magnitudes (Track-C).
    private static DesignAabb? RenderedAabb(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf, bool widened) =>
        PaintOrderTables.RenderedAabb(id, node, transforms, spreadDxOf, widened, TextSlackPx, SpreadSlackPx);

    // A blocker's AABB inflated by a motion halo (bounded cosmetic vs unbounded dynamic). Delegated (Track-C).
    private static DesignAabb Blocker(
        string id, DesignAabb box, IReadOnlySet<string> dynamicallyExcluded, IReadOnlySet<string> boundedCosmetic) =>
        PaintOrderTables.Blocker(id, box, dynamicallyExcluded, boundedCosmetic, DynamicSlackPx, BoundedCosmeticSlackPx);

    // A textured/fill/range OCCLUDER's tight DRAWN-ART design box (letterbox-tightened for KeepAspectCentered).
    // Delegated (Track-C).
    private static DesignAabb? BlockerAabb(
        string id, MirrorNode node, GlobalTransformIndex transforms, Func<string, double> spreadDxOf, bool widened) =>
        PaintOrderTables.BlockerAabb(id, node, transforms, spreadDxOf, widened);

    // One accumulated occluder: its haloed box, id, and optional transparent hole inside its
    // art — the label is only covered when the overlapped region reaches OUTSIDE the hole.
    private readonly record struct BlockerEntry(DesignAabb Box, string Id, DesignAabb? Hole);

    // Does blocker `b` actually cover any part of `box`? Overlap of the blocker box, minus the hole exemption: when
    // the whole overlapped region lies INSIDE the blocker's transparent hole, nothing painted sits over the label.
    private static bool Covers(DesignAabb box, in BlockerEntry b)
    {
        if (!box.Overlaps(b.Box))
        {
            return false;
        }

        if (b.Hole is not { } h)
        {
            return true;
        }

        double ix0 = Math.Max(box.MinX, b.Box.MinX);
        double iy0 = Math.Max(box.MinY, b.Box.MinY);
        double ix1 = Math.Min(box.MaxX, b.Box.MaxX);
        double iy1 = Math.Min(box.MaxY, b.Box.MaxY);
        return !(h.MinX <= ix0 && h.MinY <= iy0 && h.MaxX >= ix1 && h.MaxY >= iy1);
    }

    private static string? FirstOverlap(DesignAabb box, List<BlockerEntry> against)
    {
        foreach (var b in against)
        {
            if (Covers(box, b))
            {
                return b.Id;
            }
        }

        return null;
    }

    // Diagnostics variant of FirstOverlap: returns the overlapping blocker's box too (for the debug trace).
    private static (string Id, DesignAabb Box)? FirstOverlapEntry(DesignAabb box, List<BlockerEntry> against)
    {
        foreach (var b in against)
        {
            if (Covers(box, b))
            {
                return (b.Id, b.Box);
            }
        }

        return null;
    }

    // Compact "[minX,minY maxX,maxY]" formatting for the gated debug trace (null box → "none").
    private static string FormatBox(DesignAabb? box) =>
        box is { } b ? $"[{b.MinX:0},{b.MinY:0} {b.MaxX:0},{b.MaxY:0}]" : "none";

    // Compact node geometry/paint detail for the gated debug trace (raw layout rect, texture region, nine-patch
    // margins, z-index, blend, text halign) — used to distinguish a phantom-slack overlap from a real drawn overlap.
    private static string NodeDetail(MirrorNode node)
    {
        var r = node.LocalRect;
        string rect = r is null ? "rect=none" : $"rect=[{r.X:0},{r.Y:0} {r.Width:0}x{r.Height:0}]";
        string reg = node.TextureRegion is { } tr ? $" region=[{tr.X:0},{tr.Y:0} {tr.Width:0}x{tr.Height:0}]" : "";
        string nine = node.NinePatch ? $" nine={(node.NinePatchMargins is { } nm ? $"{nm.Left:0}/{nm.Top:0}/{nm.Right:0}/{nm.Bottom:0}" : "?")}" : "";
        string z = node.ZIndex is { } zz && zz != 0 ? $" z={zz}" : "";
        string tex = node.TextureUrl is not null ? " tex=1" : "";
        string stretch = node.TextureStretchMode is { } sm ? $" stretch={sm}" : "";
        string ha = node.Text is { } t && t.Halign is { } h ? $" halign={h}" : "";
        return rect + reg + nine + z + tex + stretch + ha;
    }

    // Shared occlusion predicates (Track-C: moved to PaintOrderTables; kept as thin forwarders so the call sites +
    // semantics here are byte-identical). IsOpaqueBlocker = "can this node's own paint HIDE something under it";
    // ChainCovers = "does it render visible through its whole ancestor chain"; OwnAlpha / IsEffectBearing as named.
    private static bool IsOpaqueBlocker(MirrorNode node) => PaintOrderTables.IsOpaqueBlocker(node);

    private static double OwnAlpha(MirrorNode node) => PaintOrderTables.OwnAlpha(node);

    private static bool ChainCovers(MirrorState state, MirrorNode node, string id) =>
        PaintOrderTables.ChainCovers(state, node, id);

    // Any own OPAQUE paint incl. visible text — used by the demotion guard's "a changed node now covers a promoted
    // label" test. A transparent/faded/additive change never demotes.
    private static bool PaintsAny(MirrorNode node) =>
        IsOpaqueBlocker(node) || (node.Visible && OwnAlpha(node) > 0.02 && node.Text is { Text.Length: > 0 });

    private static bool IsEffectBearing(MirrorNode node) => PaintOrderTables.IsEffectBearing(node);

    // True when `ancestorId` is a strict ancestor of `id`.
    private static bool IsAncestorOf(MirrorState state, string ancestorId, string id)
    {
        string? cur = state.Nodes.TryGetValue(id, out var node) ? node.ParentId : null;
        int guard = 0;
        while (cur is not null && guard++ < 4096)
        {
            if (string.Equals(cur, ancestorId, StringComparison.Ordinal))
            {
                return true;
            }

            cur = state.Nodes.TryGetValue(cur, out var n) ? n.ParentId : null;
        }

        return false;
    }

    // The leaf of a dotted node type ("Godot.NCard" → "NCard") for card-subtree eligibility.
    private static string NodeTypeLeaf(string nodeType)
    {
        int dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }

    private void Bump(TextReject reject)
    {
        _histogram.TryGetValue(reject, out var c);
        _histogram[reject] = c + 1;
    }

    // A total-ordered paint key: (effZ band, primary index, tier [self=0/text=1], sub [-depth for text]). Delegated to
    // the shared PaintOrderTables so the text and card planners key identically. effZ=0 preserves the
    // pre-order key's relative order exactly.
    private static long PaintKey(int effZ, int primary, int tier, int sub) =>
        PaintOrderTables.PaintKey(effZ, primary, tier, sub);

    private enum EventKind
    {
        SelfPaint,
        TextPaint,
    }

    private readonly record struct Event(
        long Key,
        EventKind Kind,
        string Id,
        DesignAabb? Box,
        bool Suffix = false,
        bool Dynamic = false,
        bool Candidate = false,
        TextReject Reject = TextReject.None,
        DesignAabb? BlockerBox = null,
        bool Measured = false,
        DesignAabb? Hole = null);
}

// Current text-overlay planner inputs from the controller.
//   CardPromotedRoots — NCard root ids the CardLayer is currently promoting (clusters live, reviving, or queued in
//     its amortized build): their labels stay CardOwned (the clone carries them crisp — never double-promote).
//   CardKnownRoots — every NCard root the CardLayer EVALUATED in its last plan. A root it has not yet seen is
//     treated as owned (conservative same-drain window); a KNOWN root that is not promoted was DECLINED, so its
//     labels fall through to the ordinary text rules.
//   BlockerArtExtents — client-MEASURED drawn-art design boxes for textured occluders (decode-time alpha used-rect,
//     stretch-mapped, transformed by the live view): replaces the layout-rect blocker box for those ids.
public sealed class TextOverlayOptions
{
    private static readonly HashSet<string> Empty = new(System.StringComparer.Ordinal);

    public IReadOnlySet<string> CardPromotedRoots { get; init; } = Empty;

    public IReadOnlySet<string> CardKnownRoots { get; init; } = Empty;

    public IReadOnlyDictionary<string, DesignAabb>? BlockerArtExtents { get; init; }

    // Transparent HOLES inside textured blockers' art (the full-width/full-height all-transparent run of a stretched
    // edge-fade gradient) — a label whose overlap with the blocker lies entirely inside the hole is not covered.
    public IReadOnlyDictionary<string, DesignAabb>? BlockerArtHoles { get; init; }

    // WS-EVENTTEXT #14 Leg B: client-measured TIGHT ink boxes for TEXT occluders (a single-line RichTextLabel narrowed
    // to GetContentWidth positioned by its alignment — see MirrorNodeView.TryGetTextGlyphRect tightRichWidth). Used
    // ONLY for a text label's demoted-OCCLUDER-role box (candidacy is unaffected — a candidate keeps its conservative
    // full-box measurement), so a full-screen-box name banner ("NEOW") no longer phantom-occludes the event options
    // sitting beside its drawn glyphs. A missing id falls back to the measured/rect blocker box (byte-identical).
    public IReadOnlyDictionary<string, DesignAabb>? TextBlockerExtents { get; init; }
}

// One promoted text label: its wire id, its paint key (ascending = holder MoveChild order), and its rendered+slack
// design-space box (the controller caches this for the per-drain demotion guard).
public readonly record struct TextOverlayItem(string Id, long PaintKey, DesignAabb Aabb);

// A computed text-overlay plan: the promotable labels in ascending paint-key order.
public readonly record struct TextOverlayPlan(IReadOnlyList<TextOverlayItem> Items)
{
    public bool HasAny => Items.Count > 0;

    public static readonly TextOverlayPlan None = new(System.Array.Empty<TextOverlayItem>());
}

// A linear-space RGBA tint (the ancestor-composed effective modulate the overlay holder carries).
public readonly record struct Rgba(double R, double G, double B, double A);
