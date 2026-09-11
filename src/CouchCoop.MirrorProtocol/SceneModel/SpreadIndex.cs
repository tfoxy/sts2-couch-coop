using CouchCoop.MirrorProtocol.Input;

namespace CouchCoop.MirrorProtocol.SceneModel;

// OWNER: WS-P (SpreadWalk). WS-O shipped this STUB — the F=1 strict no-op path + the FROZEN public surface
// (<see cref="Update"/> / <see cref="TryGet"/>) that MirrorStore, SceneReconciler, and InteractiveRectScan program
// against. WS-P fills <see cref="Update"/> with the verbatim port of mirrorRenderer.ts visit() L2101-2255:
//   * the four spread branches (pass-through group / anchor algebra / boxed-Control ride / positional claimer)
//     + the fullCanvas re-center exception + the width override,
//   * the owner-anchored floater override (`dx = ParentDx + records[anchorOwnerId].Dx`) — which is WHY the records
//     dictionary must PERSIST across Updates (a not-yet-walked owner reads last drain's value, the web one-frame lag),
//   * the remote-follower hitTestShift over InteractiveRectScan,
//   * the `Paints` predicate (nodePaintsContent, native always renders shaders) AND NOT isPaintAnchorExcluded.
// WS-P touches ONLY this file + tests/.../SpreadWalkTests.cs.
//
// The per-node record maps to the web `data-spread-*` attrs (see SpreadRecord). Keyed by wire node id. Persisted
// across Updates (WS-P relies on last drain's values for the owner-floater override); the F=1 early-out clears it.
public sealed class SpreadIndex
{
    // The 1920-design canvas width (web MIRROR_DESIGN_WIDTH) — the squeeze-field clamp bound and the root's
    // parent-width. The stage widens beyond it; the walk resolves shifts in THIS 1920-space.
    private const double DesignWidth = 1920;

    // A particle / spine point-anchor's zero-size box (web ZERO_ORIGIN {x:0,y:0}) — it has no localRect, so drawBox
    // falls back to its transform origin.
    private static readonly MirrorRect ZeroOrigin = new(0, 0, 0, 0);

    // HSV-adjust shader ids (frontend/src/mirror/shaderResources.ts HSV_SHADER_IDS): their base texture is FINAL
    // art under a CSS/feColorMatrix tint, NOT a WebGL-canvas shader-input — so an HSV node is NOT a WebGL node.
    private static readonly HashSet<string> HsvShaderIds = new(StringComparer.Ordinal)
    {
        "res://shaders/hsv.gdshader",
        "uid://c66gb6g7tup3n",
    };

    // AURA layers that RENDER but must NEVER anchor the pointer's visual map (mirrorRenderer isPaintAnchorExcluded
    // L244-248): a card's always-on cyan glow (NCardHighlight, a huge mostly-transparent box) + its draw/play
    // `Flash` overlay (matched by NAME). LIVE-VERIFY: NCardHighlight is confirmed against the streamed nodeType;
    // extend these sets if another aura class starts hijacking hovers.
    private static readonly HashSet<string> PaintAnchorExcludedTypes = new(StringComparer.Ordinal) { "NCardHighlight" };
    private static readonly HashSet<string> PaintAnchorExcludedNames = new(StringComparer.Ordinal) { "Flash" };

    // Persistent across Updates BY DESIGN (the owner-anchored-floater override reads a not-yet-walked owner's
    // last-drain Dx). Overwritten per visit; unwalked (removed) ids are pruned at the end of each F!=1 walk. The
    // F=1 early-out clears it wholesale (strict no-op).
    private readonly Dictionary<string, SpreadRecord> _records = new(StringComparer.Ordinal);

    // Reused scratch (per-drain, single-threaded): the set of ids visited this walk (drives the prune) + the prune
    // key list. HitTestShift's InteractiveRectScan pass never touches these, so re-entrancy is safe.
    private readonly HashSet<string> _visited = new(StringComparer.Ordinal);
    private readonly List<string> _pruneScratch = new();

    // WS-P2 incremental ApplySpread. The pre-resolved per-VIEW stamp (SceneReconciler.ApplySpread's parent-relative
    // fold, computed inside the walk) keyed by wire node id, PERSISTED across Updates alongside _records so a stamp
    // can be compared against last drain's to detect which views actually need re-stamping. `_dirty` is the set of
    // ids whose stamp changed (or that were pruned) THIS Update; it clears at the top of every Update. `DirtyAll`
    // forces the reconciler onto its full loop for one Update on a factor change / F↔1 transition (every view's
    // offset rescales), where per-node comparison would flag ~everything anyway.
    private readonly Dictionary<string, SpreadViewStamp> _stamps = new(StringComparer.Ordinal);
    private readonly HashSet<string> _dirty = new(StringComparer.Ordinal);

    // The spread factor of the last <see cref="Update"/> (stageWidth / 1920; 1 = no spread).
    public double Factor { get; private set; } = 1;

    // Structural-walk bail count. Drains that cannot change spread inputs retain the current records.
    public long Bails { get; private set; }

    // The flag set the walk actually READS (fail-closed complement of Text|Effects): structure/identity (New/
    // Removed/Static — anchors, mouseFilter, containerLayout, parent, scene), geometry (Transform, Draw — localRect),
    // and paint alphas (Tint — the Paints predicate reads Visible/Opacity/Modulate/SelfModulate/ZIndex). A drain
    // whose every changed node stays outside this set cannot move any spread input.
    private const NodeChangeFlags WalkRelevant =
        NodeChangeFlags.New | NodeChangeFlags.Static | NodeChangeFlags.Transform |
        NodeChangeFlags.Tint | NodeChangeFlags.Draw | NodeChangeFlags.Removed;

    // WS-P2: true for the ONE Update after the factor changed (incl. 1→F and F→1) — every view's stamp rescales, so
    // the reconciler takes its full loop and ignores <see cref="DirtyIds"/>. False on a steady-factor Update.
    public bool DirtyAll { get; private set; }

    // WS-P2: the ids whose view-stamp changed (a moved node/ancestor, a new node, or a pruned one) since last Update.
    // Only meaningful when !DirtyAll (a steady-factor drain). The reconciler stamps exactly these views.
    public IReadOnlyCollection<string> DirtyIds => _dirty;

    // The spread record for a wire node, or false (with default = all-zero) when the node did not shift/widen this
    // walk — the common case even on a widened stage (most nodes ride their parent, dx == parent's dx).
    public bool TryGet(string id, out SpreadRecord record) => _records.TryGetValue(id, out record);

    // WS-P2: the pre-resolved view stamp for a wire node (the incremental reconciler reads this for a DirtyId), or
    // false when the node did not shift/widen this walk (no stamp → the view carries a zero offset).
    public bool TryGetStamp(string id, out SpreadViewStamp stamp) => _stamps.TryGetValue(id, out stamp);

    // Recompute every node's spread record for the current state + globals at `factor`. Runs in MirrorStore.FinishDrain
    // right after Transforms.Update (per-drain, mirroring the web per-reconcile) and again on a bare F change.
    public void Update(MirrorState state, GlobalTransformIndex transforms, double factor)
    {
        double prevFactor = Factor;
        Factor = factor;

        // WS-P2: a factor change (incl. 1↔F) rescales EVERY view's offset — force the reconciler onto its full loop
        // for this one Update (per-node comparison below would flag ~everything anyway). A steady-factor drain keeps
        // DirtyAll false and drives only the changed views. `_dirty` accumulates this Update's changed/pruned ids.
        DirtyAll = factor != prevFactor;
        _dirty.Clear();

        // STRICT no-op at F=1 (16:9): no node shifts, so there are no records — clear + return. This keeps the whole
        // wide-screen subsystem free on a 16:9 stage. The stamp cache clears too (an F→1 transition set DirtyAll, so
        // the reconciler's full zeroing pass runs once regardless).
        if (factor == 1)
        {
            _records.Clear();
            _stamps.Clear();
            return;
        }

        // WS-FPS BAIL: skip the whole walk when THIS drain could not have moved any spread input — steady factor,
        // a prior walk's records exist, and every changed node's OR-merged flags sit outside WalkRelevant (a spine
        // track echo / text / particle-volatile drain). Records, stamps, and (already-cleared) dirty ids stay as
        // last walk's — identical to what a full re-walk would recompute. FAIL-CLOSED guards: a keyframe re-upserts
        // everything as New|StructuralAll (never bails), and a ChangedIds/ChangeFlags count mismatch (a change that
        // somehow skipped classification) forces the walk.
        if (!DirtyAll
            && _records.Count > 0
            && state.ChangedIds.Count == state.ChangeFlags.Count
            && OnlyWalkIrrelevantChanges(state))
        {
            Bails++;
            return;
        }

        // DFS in draw order (OrderedIds), exactly the structure the reconciler + InteractiveRectScan use. The root's
        // parent is the viewport: it widens by the extra stage width the anchors budget against (web rootCtx
        // L3020-3033). parentGlobal starts at identity; parentWidth at the 1920 design canvas.
        var (rootIds, childIdsByParent) = SceneTreeApplier.BuildOrderStructure(state.OrderedIds, state.Nodes);
        double delta = (factor - 1) * DesignWidth; // the root's parent-width delta (== web DELTA at F=1.3125: 600)
        var root = new WalkCtx(
            ParentDx: 0,
            DeltaParentWidth: delta,
            AnchorDelta: delta,
            ParentDxProp: false,
            RideDx: 0,
            ParentWidth: DesignWidth,
            ParentGlobal: Affine.Identity,
            ParentRecordDx: 0); // WS-P2: the root's parent (the viewport) has no spread record → Dx 0

        _visited.Clear();
        foreach (var id in rootIds)
        {
            Visit(id, root, state, transforms, childIdsByParent, factor);
        }

        // Prune records for nodes no longer walked (a removed subtree) — the web's structural-walk prune. In-walk
        // persistence is untouched (a not-yet-walked owner still reads last drain's Dx during THIS walk; the prune
        // only drops ids that vanished from the tree). Cheap early-out when counts already match. WS-P2: _records and
        // _stamps carry identical key sets (both written every Visit), so the same prune drops both — and each pruned
        // id is marked dirty so the reconciler zeroes that view's now-orphaned offset.
        if (_records.Count != _visited.Count)
        {
            _pruneScratch.Clear();
            foreach (var key in _records.Keys)
            {
                if (!_visited.Contains(key))
                {
                    _pruneScratch.Add(key);
                }
            }

            foreach (var key in _pruneScratch)
            {
                _records.Remove(key);
                _stamps.Remove(key);
                _dirty.Add(key);
            }
        }
    }

    // True when no changed node carries a walk-relevant bit (see WalkRelevant). O(changed nodes), tiny vs the walk.
    private static bool OnlyWalkIrrelevantChanges(MirrorState state)
    {
        foreach (var flags in state.ChangeFlags.Values)
        {
            if ((flags & WalkRelevant) != NodeChangeFlags.None)
            {
                return false;
            }
        }

        return true;
    }

    // Port of mirrorRenderer.ts visit()'s wide-screen re-layout (L2100-2255): resolve THIS node's absolute
    // horizontal shift `dx`, its anchor-widened rendered width, its field-vs-anchor flavor (Prop), and whether it
    // paints an anchor (Paints); then recurse with the child WalkCtx the four branches produced.
    private void Visit(
        string id,
        WalkCtx ctx,
        MirrorState state,
        GlobalTransformIndex transforms,
        Dictionary<string, List<string>> childIdsByParent,
        double factor)
    {
        if (!state.Nodes.TryGetValue(id, out var node))
        {
            return;
        }

        _visited.Add(id);

        // This node's GLOBAL Transform2D — the index reproduces the web gNode composition (transform-less node =
        // pass-through group whose global IS its parent's, NOT the identity/origin).
        IReadOnlyList<double> gNode = transforms.TryGetGlobal(id, out var g) ? g : Affine.Identity;

        // The node's OWN painted opacity (modulate.a x self_modulate.a), for the Paints gate below.
        double modAlpha = node.Modulate is { } mod ? mod.A : node.Opacity;
        double selfAlpha = node.SelfModulate is { } self ? self.A : 1;

        // A node paints/anchors its OWN visual when it has a real (positive-width) box, or is a particle/spine
        // point-anchor. drawBox is its local drawing box (particle/spine anchor at their transform origin).
        MirrorRect? drawBox = node.LocalRect ?? (node.ParticleSpec is not null || IsSpineClipNode(node) ? ZeroOrigin : null);

        double dx = ctx.ParentDx; // default: ride the parent rigidly (a consumed subtree inherits its absolute shift)
        double renderWidthOverride = 0; // grow this node's painted box by its anchor-driven width delta (0 = none)
        double childDeltaParentWidth = ctx.DeltaParentWidth;
        double childAnchorDelta = ctx.AnchorDelta;
        double childParentDx = ctx.ParentDx; // what THIS node hands its children as their baseline shift
        double childRideDx = ctx.RideDx; // the dx a rigid (Control) child should ride — a group's own claim
        // True when `dx` came from the positional squeeze FIELD (a positional claim / pass-through group, or riding a
        // field-derived parent shift), vs the anchor algebra. A default RIDER inherits its parent's flavor.
        bool spreadMode = ctx.ParentDxProp;
        bool childParentDxProp = ctx.ParentDxProp;

        // factor != 1 is guaranteed here (Update early-outs at F=1), so the whole re-layout body always runs.
        bool anchored = node.AnchorLeft is not null && node.AnchorRight is not null;
        double leftClaim = anchored ? node.AnchorLeft!.Value : 0;
        double span = anchored ? node.AnchorRight!.Value - node.AnchorLeft!.Value : 0;
        bool hasPaintBox = node.LocalRect is { } lr0 && lr0.Width > 0;
        bool pointAnchor = node.ParticleSpec is not null || IsSpineClipNode(node);
        bool boxlessPositioner = !hasPaintBox && !pointAnchor;
        double rate = factor - 1;
        double originGx = gNode[4];
        double centerGx = drawBox is not null
            ? gNode[4]
              + gNode[0] * (drawBox.X + (node.LocalRect?.Width ?? 0) / 2)
              + gNode[2] * (drawBox.Y + (node.LocalRect?.Height ?? 0) / 2)
            : gNode[4];

        if (ctx.DeltaParentWidth > 0)
        {
            if (IsBackgroundSceneRoot(node))
            {
                // R10 EVENT BACKGROUND SCENE ROOT (matched by scene identity, not geometry): re-center this
                // full-canvas bg on the widened frame and CONSUME the budget so the whole packed bg scene — the
                // background art AND its candle-flame Sprite2Ds — rides this ONE rigid shift, staying matched. 0.5·Δ
                // is the fullCanvas convention (a full-width bg centered at 960 in 1920-space would positional-claim
                // the same 960·rate); consuming (childDeltaParentWidth=0) stops the flame siblings from taking their
                // own per-center positional claims (which would desync them from a shifted bg).
                dx = ctx.ParentDx + 0.5 * ctx.DeltaParentWidth;
                renderWidthOverride = 0;
                childDeltaParentWidth = 0;
                childAnchorDelta = 0;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = false;
                childParentDxProp = false;
            }
            else if (IsPreviewContainer(node))
            {
                // R3-Q4 CARD-PREVIEW CONTAINER (matched by leaf type — a sibling of the event-bg re-center): a
                // (0/1-anchored) NGlobalUi container that re-renders a focused card's linked preview. The game lays the
                // backdrop + preview card out in CONTAINER-LOCAL coords; at F≠1 the inner card would otherwise take its
                // OWN positional center claim and drift off its backdrop. CONSUME the budget so backdrop + card ride the
                // SAME rigid shift, preserving the preview's F=1 container-local layout. Placement is width-conditional
                // (verified from real streams — NCardPreviewContainer/NGridCardPreviewContainer stream 1920×1080, but
                // NMessyCardPreviewContainer 1355×762 and the event GridCardPreviewContainer 989×1080 do NOT): a
                // FULL-FRAME (≈parent-width) container re-centers on ½Δ (the fullCanvas convention, so its 1920-authored
                // centered content lands on the widened stage centre); a NARROWER preview rides its parent's shift
                // instead of over-centering (the spec's non-full-1920 fallback). Both keep the CONSUME that fixes the
                // drift; only the container's overall placement differs.
                bool previewFullFrame = node.LocalRect is { } lrPrev && lrPrev.Width >= ctx.ParentWidth - 1;
                dx = previewFullFrame ? ctx.ParentDx + 0.5 * ctx.DeltaParentWidth : ctx.ParentDx;
                renderWidthOverride = 0;
                childDeltaParentWidth = 0;
                childAnchorDelta = 0;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = false;
                childParentDxProp = false;
            }
            else if (ctx.ContainerChildAlign is { } alignFactor)
            {
                // BOX CHILD: this node's PARENT is a widened BoxContainer that re-lays out its packed row/column. A
                // real Godot BoxContainer IGNORES its children's anchors, so the child does NOT run the anchor
                // algebra (which would strand a 0/0 child like the card-reward "Skip" button LEFT); it rides the
                // parent's shift plus the container's alignment redistribution — begin 0 / center ½ / end 1 of the
                // parent's widening (a V-box redistributes nothing horizontally → factor 0, so the child just rides
                // the parent's own dx). Consume the budget: the child's own subtree rides this ONE shift rigidly.
                // CROSS-AXIS EXCEPTION: a VERTICAL box also lays each child out across its full WIDTH (Godot
                // cross-axis fill), so a child whose own box already spans the container's pre-widen width is
                // full-frame background ART (the map parchment strip tiles) — it re-CENTERS on the widened box
                // (0.5 claim, the fullCanvas convention) instead of stranding left.
                double boxClaim = ctx.ContainerChildVertical
                    && node.LocalRect is { } lrb
                    && lrb.Width >= ctx.ParentWidth - 1
                        ? 0.5
                        : alignFactor;
                dx = ctx.ParentDx + boxClaim * ctx.DeltaParentWidth;
                childDeltaParentWidth = 0;
                childAnchorDelta = 0;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = false;
                childParentDxProp = false;
            }
            else if (boxlessPositioner && span <= 0.001)
            {
                // PASS-THROUGH GROUP: own origin field-shift, pass the budget through. Children see the SAME
                // budget-granting frame; its zero-size box gives them no anchor frame (anchorDelta 0), and its own
                // claim becomes their rideDx (boxed Control children ride the entity's ONE shift below).
                dx = ClampGx(originGx) * rate;
                childDeltaParentWidth = ctx.DeltaParentWidth;
                childAnchorDelta = 0;
                childParentDx = ctx.ParentDx;
                childRideDx = dx;
                spreadMode = true;
                childParentDxProp = ctx.ParentDxProp;
            }
            else if (anchored && ctx.AnchorDelta > 0)
            {
                // ANCHOR ALGEBRA: a Control whose anchors face a REAL resizing frame reproduces Godot's own resize
                // (0/0 pins, 0/1 stretches, 1/1 hugs right, 0.5/0.5 re-centers). EXCEPTION: a 0/0-anchored box that
                // covers its WHOLE frame (a full-canvas map parchment tile) is background ART — it re-CENTERS on the
                // widened frame (0.5 claim) instead of stranding left.
                bool fullCanvas = leftClaim <= 0.001
                    && span <= 0.001
                    && node.LocalRect is { } lrf
                    && lrf.Width >= ctx.ParentWidth - 1;
                // DRAWING-TOOLS EXCEPTION: the map's draw/erase/clear palette is a
                // SMALL 0/0-anchored box, so fullCanvas is false and the algebra would pin it to a fixed distance from
                // the stage's left edge — detaching it from the map content it belongs to, which re-centres on ½Δ.
                // Force the same 0.5 claim (matched by SCENE IDENTITY, not geometry — a plain 0/0 corner widget must
                // keep its corner). span is 0, so deltaW stays 0 and its buttons ride this ONE shift rigidly.
                // MENU-RIBBON EXCEPTION: same seam, same scene-identity match
                // — the main menu's focus ribbons must ride the 0.5-anchored option column they mark.
                bool centerClaim = fullCanvas
                    || IsDrawingTools(id, node, state)
                    || IsMenuReticle(id, node, state);
                dx = ctx.ParentDx + ctx.ParentGlobal[0] * (centerClaim ? 0.5 : leftClaim) * ctx.AnchorDelta;
                double deltaW = span * ctx.AnchorDelta;
                if (node.LocalRect is { } lrw && Math.Abs(deltaW) > 0.01)
                {
                    renderWidthOverride = lrw.Width + deltaW;
                }

                childDeltaParentWidth = deltaW;
                childAnchorDelta = deltaW;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = false;
                childParentDxProp = false;
            }
            else if ((anchored || node.MouseFilter is not null) && hasPaintBox)
            {
                // BOXED CONTROL under a ZERO anchor-frame: parent-relative UI (the card's EnergyIcon/Frame/labels,
                // a creature's Hitbox/HealthBar/Intents) rides its entity's ONE shift (the nearest pass-through
                // group's own claim), so the whole entity moves as one (no ~25px per-part drift).
                dx = ctx.RideDx;
                childDeltaParentWidth = 0;
                childAnchorDelta = 0;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = true;
                childParentDxProp = true;
            }
            else
            {
                // POSITIONAL CLAIMER: WORLD content placed at its own CENTER on the field, CONSUMING the budget —
                // non-Control visuals (Sprite2D arrow segments, world sprites, bg layers) and spine/particle
                // anchors, which the game positions in world space rather than relative to a parent rect.
                dx = ClampGx(centerGx) * rate;
                childDeltaParentWidth = 0;
                childAnchorDelta = 0;
                childParentDx = dx;
                childRideDx = dx;
                spreadMode = true;
                childParentDxProp = true;
            }
        }

        // OWNER-ANCHORED FLOATER (STS2's HoverTip, positioned each frame from ANOTHER control's global rect): it
        // inherits no shift down its own parent chain, so the ONLY correction is the owner's cumulative shift.
        // records[owner] may be THIS drain's value (owner walked earlier) or last drain's (one-frame lag).
        if (node.AnchorOwnerId is { } ownerId)
        {
            // Resolve a zero-size holder to its visual owner, then use that owner's absolute displacement. A
            // floater inherits no displacement down its own parent chain, so adding ParentDx would double-count.
            string resolvedId = TipOwnerResolve.ResolveVisualOwnerId(state, transforms, this, ownerId);
            dx = _records.TryGetValue(resolvedId, out var ownerRec) ? ownerRec.Dx : ctx.ParentDx;

            renderWidthOverride = 0;
            childDeltaParentWidth = 0;
            childAnchorDelta = 0;
            childParentDx = dx;
            childRideDx = dx;
            spreadMode = false;
            childParentDxProp = false;
        }

        // REMOTE FOLLOWER (a teammate's co-op cursor / targeting indicator drawn at a game-cursor position THIS
        // client never resolved): place it at the shift of the content under its true game point (hitTestShift).
        if (InteractiveRectScan.IsRemoteFollower(node))
        {
            dx = HitTestShift(gNode[4], gNode[5], state, transforms, factor);
            renderWidthOverride = 0;
            childDeltaParentWidth = 0;
            childAnchorDelta = 0;
            childParentDx = dx;
            childRideDx = dx;
            spreadMode = false;
            childParentDxProp = false;
        }

        // CONTAINER RE-LAYOUT signal for THIS node's children: when THIS node is a widened BoxContainer (it took the
        // anchor-algebra branch, so childDeltaParentWidth > 0), its children ride its OWN re-layout — a Godot
        // BoxContainer ignores child anchors — instead of running their own anchor algebra (see the BOX CHILD branch
        // above). The factor (0/0.5/1 for hbox begin/center/end; 0 for a vbox; null for a non-box) is read from the
        // streamed ContainerLayout. Null when the box didn't widen (a 0/0 box) or the node isn't a BoxContainer.
        double? childContainerAlign = childDeltaParentWidth > 0 ? ContainerHAlignFactor(node.ContainerLayout) : null;
        bool childContainerVertical = childContainerAlign is not null
            && node.ContainerLayout?.StartsWith("vbox", StringComparison.Ordinal) == true;

        // A VISUALLY-PAINTING anchor (web data-paints): the pointer map keys off painting anchors, and an aura
        // (glow/flash) renders but must never anchor. Spread-independent, but only consulted at F != 1 natively.
        bool paints = NodePaintsContent(node, modAlpha * selfAlpha) && !IsPaintAnchorExcluded(node);

        _records[id] = new SpreadRecord(dx, renderWidthOverride, spreadMode, paints);

        // WS-P2: resolve the FINAL per-view stamp here — the exact value SceneReconciler.ApplySpread would derive for
        // this node's view: fold the parent-relative shift (dx − parent's record Dx) through the parent's UNSHIFTED
        // global. `ctx.ParentGlobal` IS the same parent global ApplySpread reads from the transform index, and
        // `ctx.ParentRecordDx` IS the parent's own record Dx (root = 0), so this reproduces ApplySpread bit-for-bit
        // (proven by the SpreadWalkTests stamp-parity leg). Compare
        // against last drain's stamp: a new id or a changed stamp marks the view dirty so the reconciler re-stamps
        // only it. Most nodes ride their parent unchanged drain-over-drain → not dirty → the incremental fast path.
        var (ox, oy) = SpreadMath.ParentFrameOffset(ctx.ParentGlobal, dx - ctx.ParentRecordDx);
        var stamp = new SpreadViewStamp(ox, oy, renderWidthOverride);
        if (!_stamps.TryGetValue(id, out var prevStamp) || prevStamp != stamp)
        {
            _stamps[id] = stamp;
            _dirty.Add(id);
        }

        if (childIdsByParent.TryGetValue(id, out var kids))
        {
            var childCtx = new WalkCtx(
                ParentDx: childParentDx,
                DeltaParentWidth: childDeltaParentWidth,
                AnchorDelta: childAnchorDelta,
                ParentDxProp: childParentDxProp,
                RideDx: childRideDx,
                // This node's own width becomes its children's "parent width"; a zero-size positioner passes its
                // parent's (the budget-granting frame's) width through, so a nested anchored child's claim stays intact.
                ParentWidth: node.LocalRect is { } lrp && lrp.Width > 0 ? lrp.Width : ctx.ParentWidth,
                // Children compose their global in the walk against this node's UNSHIFTED true global (web
                // childParentGlobal = gNode), used by the anchor algebra's parentGlobal[0] basis lift.
                ParentGlobal: gNode,
                // WS-P2: this node's own record Dx is what its children fold against (ApplySpread reads it via the
                // parent's own SpreadRecord). Written above, so children read THIS walk's value.
                ParentRecordDx: dx,
                // If THIS node is a widened BoxContainer, its children ride its re-layout (see the BOX CHILD branch).
                ContainerChildAlign: childContainerAlign,
                ContainerChildVertical: childContainerVertical);

            foreach (var childId in kids)
            {
                Visit(childId, childCtx, state, transforms, childIdsByParent, factor);
            }
        }
    }

    // The horizontal shift a REMOTE follower should ride, given its TRUE game point (px,py = its global transform
    // origin): the cumulative absolute spreadDx of the TOPMOST visibly-painting mouse-visible control under the
    // point (over the retained records, since the follower's own subtree is streamed). No painting anchor (dead
    // board space) → a POSITIONAL claim at the point's own game X. Port of mirrorRenderer.ts hitTestShift L1075-1091.
    private double HitTestShift(double px, double py, MirrorState state, GlobalTransformIndex transforms, double factor)
    {
        double clampedX = px < 0 ? 0 : px > DesignWidth ? DesignWidth : px;
        double dx = (factor - 1) * clampedX;

        // InteractiveRectScan.Collect is back-to-front (paint order), so the LAST containing candidate wins — the
        // topmost painter, as the pointer map picks. It reads each candidate's SpreadDx off THIS (in-flight) index.
        foreach (var r in InteractiveRectScan.Collect(state, transforms, this))
        {
            var inv = Affine.Inverse(Affine.NodeMatrix(r.Global, r.LocalRect.X, r.LocalRect.Y));
            if (inv is null)
            {
                continue;
            }

            double lx = inv[0] * px + inv[2] * py + inv[4];
            double ly = inv[1] * px + inv[3] * py + inv[5];
            if (lx >= 0 && lx <= r.LocalRect.Width && ly >= 0 && ly <= r.LocalRect.Height)
            {
                dx = r.SpreadDx;
            }
        }

        return dx;
    }

    private static double ClampGx(double gx) => gx < 0 ? 0 : gx > DesignWidth ? DesignWidth : gx;

    // Port of nodeStyles.ts nodePaintsContent L115-138 — true when a node draws VISIBLE OWN CONTENT (a texture, a
    // rich/plain text run, a filled fill_color, a live SpineSprite clip, or a WebGL/HSV shader paint), false for
    // pure transform-group containers, particle-only emitters, and anything faded to near nothing. The web-only
    // `shadersEnabled=false` degrade branch is DROPPED — the native client always renders shaders.
    private static bool NodePaintsContent(MirrorNode node, double effectiveOpacity)
    {
        if (effectiveOpacity <= 0.02)
        {
            return false;
        }

        if (node.Text is not null)
        {
            return true;
        }

        if (IsSpineClipNode(node))
        {
            return true;
        }

        if (IsWebglShaderNode(node) || node.ShaderId is not null)
        {
            return true; // WebGL canvas / HSV color-matrix — a real shader paint
        }

        if (node.FillColor is { A: > 0.02 })
        {
            return true;
        }

        return node.TextureUrl is not null
            && node.ClipChildren != 1
            && !IsWebglShaderNode(node)
            && node.ParticleSpec is null;
    }

    private static bool IsPaintAnchorExcluded(MirrorNode node) =>
        PaintAnchorExcludedTypes.Contains(NodeTypeLeaf(node.NodeType)) || PaintAnchorExcludedNames.Contains(node.Name);

    // R10/R7: an EVENT background-scene root, identified by its streamed SceneFilePath. STS2 mounts each event
    // backdrop from ModelCatalog.BackgroundScenePath as a single packed scene directly under
    // `res://scenes/events/background_scenes/<event>.tscn` (neow, darv, orobas, pael, tanx, vakuu, nonupeipe,
    // tezcatara ship in the current build). Matching that DIRECTORY segment makes EVERY event backdrop — the
    // full-canvas art AND its candle-flame Sprite2Ds AND a point-anchor SpineSprite (neow's figure) — ride ONE
    // rigid ½Δ re-center (a consumed subtree) instead of each part taking its own divergent positional claim (the
    // neow-spine-strands-left bug). Deliberately scoped to the EVENT directory: combat/map/room backdrops live
    // under the DIFFERENT `res://scenes/backgrounds/<name>/<name>_background.tscn` convention (with per-layer
    // `<name>_bg_NN.tscn` / `<name>_fg.tscn` sub-scenes) — none of them contain `events/background_scenes/`, so
    // they keep their fullCanvas-anchored / vbox branches and are never rigidly re-centered here. The pattern list
    // itself lives in BackgroundSceneFamilies, shared with the Mod's static-background tracker/provider (the
    // /bg/events grammar). Verify / widen at a live event via the QA `dumpspread` verb (DemoInputPlayer.DoDumpSpread).
    //
    // Keyed on SceneFilePath identity — a boxless bg positioner and a full-canvas bg sprite look identical
    // geometrically, so only the scene file distinguishes the event backdrop family from ordinary world
    // sprites/groups that must keep their own positional claims.
    private static bool IsBackgroundSceneRoot(MirrorNode node)
        => node.SceneFilePath is { Length: > 0 } path && BackgroundSceneFamilies.MatchesEventBackgroundPattern(path);

    // R3-Q4: the leaf node types of the full-frame card-PREVIEW containers (a focused card's linked-card preview,
    // e.g. Infinite Blades → Shiv). These are the ECHO_CONTAINER "Preview" subset (mirrorRenderer isEchoContainer) —
    // NARROWED to the three PREVIEW classes only, NOT the HoverTip/Inspect echoes (those float/zoom differently and
    // must not re-center). The container lays its backdrop + preview card out in container-local coords, so it must
    // re-center as ONE rigid unit on a widened stage.
    private static readonly HashSet<string> PreviewContainerTypes = new(StringComparer.Ordinal)
    {
        "NCardPreviewContainer",
        "NGridCardPreviewContainer",
        "NMessyCardPreviewContainer",
    };

    // True when this node is a full-frame card-preview container (R3-Q4). Matched by leaf node type.
    private static bool IsPreviewContainer(MirrorNode node) =>
        PreviewContainerTypes.Contains(NodeTypeLeaf(node.NodeType));

    // WS-3: the map screen's DRAWING-TOOLS palette, matched by SCENE IDENTITY — the scene FILE of the owning root plus
    // the node's scene-relative path, exactly the (file, relPath) tuple the view-scale table keys on (and the web
    // stamps as data-scene-file / data-scene-node-path). Identity rather than geometry/type: a 208×68 0/0-anchored
    // NinePatchRect is indistinguishable from any ordinary bottom-left corner widget, and those must KEEP their corner.
    private const string MapScreenSceneFile = "res://scenes/screens/map/map_screen.tscn";
    private const string DrawingToolsName = "DrawingTools";

    // The NAME test is a cheap zero-allocation pre-filter (one ordinal compare per anchored node) so the allocating
    // SceneIdentity walk only runs for the handful of nodes that could possibly match — the same shape as ViewScale's
    // MightMatchTable gate.
    private static bool IsDrawingTools(string id, MirrorNode node, MirrorState state)
    {
        if (!string.Equals(node.Name, DrawingToolsName, StringComparison.Ordinal))
        {
            return false;
        }

        var (file, relPath) = SceneIdentity.Resolve(id, state);
        return file == MapScreenSceneFile && relPath == DrawingToolsName;
    }

    // R19 6b: the MAIN MENU's focus ribbons, matched by the same SCENE IDENTITY shape as IsDrawingTools — the scene
    // FILE of the owning root plus the node's scene-relative path. Identity rather than geometry/type: a 40x40
    // 0/0-anchored TextureRect is indistinguishable from any ordinary top-left corner widget, and those must KEEP
    // their corner. relPath == the name because the ribbons are DIRECT children of the menu root.
    private const string MainMenuSceneFile = "res://scenes/screens/main_menu.tscn";
    private const string MenuReticleLeftName = "ButtonReticleLeft";
    private const string MenuReticleRightName = "ButtonReticleRight";

    // Same zero-allocation NAME pre-filter as IsDrawingTools: the allocating SceneIdentity walk only runs for the
    // handful of nodes that could possibly match.
    private static bool IsMenuReticle(string id, MirrorNode node, MirrorState state)
    {
        if (!string.Equals(node.Name, MenuReticleLeftName, StringComparison.Ordinal)
            && !string.Equals(node.Name, MenuReticleRightName, StringComparison.Ordinal))
        {
            return false;
        }

        var (file, relPath) = SceneIdentity.Resolve(id, state);
        return file == MainMenuSceneFile && relPath == node.Name;
    }

    // True when a node plays a Spine clip (a SpineSprite with a current anim). The web adds a device quality-tier
    // gate; the native client always renders spine, so it's dropped (mirrors SpineAttachment.cs's isSpine check).
    private static bool IsSpineClipNode(MirrorNode node) =>
        node.SpineSceneResPath is not null && !string.IsNullOrEmpty(node.SpineCurrentAnim);

    // Port of shaderAttributes.ts isWebglEligible / isWebglShaderNode (native = shaders always enabled): a non-HSV
    // shader node with a base texture-or-fill to sample and no atlas region renders via the WebGL self-layer, so
    // its raw texture must NOT double-paint in CSS (the nodePaintsContent paintsTexture gate uses this).
    private static bool IsWebglShaderNode(MirrorNode node)
    {
        if (node.ParticleSpec is not null)
        {
            return false; // a particle node renders via the particle runtime, not the shader self-layer
        }

        if (node.ShaderId is null || HsvShaderIds.Contains(node.ShaderId))
        {
            return false; // not a shader node, or HSV → rendered via feColorMatrix, not the canvas
        }

        if (node.TextureUrl is null && node.FillColor is null)
        {
            return false; // no base to sample → skipped (no canvas)
        }

        if (node.TextureRegion is not null)
        {
            return false; // atlas sprite → shader skipped, the CSS crop is the fallback
        }

        return true;
    }

    // The leaf (final dotted segment) of a Godot type name — mirrorRenderer nodeTypeLeaf.
    private static string NodeTypeLeaf(string nodeType)
    {
        var dot = nodeType.LastIndexOf('.');
        return dot >= 0 ? nodeType[(dot + 1)..] : nodeType;
    }

    // The horizontal redistribution factor for a child of a widened BoxContainer, or null when `containerLayout` is
    // not a BoxContainer hint. A HORIZONTAL box re-packs its row so a child shifts by begin 0 / center ½ / end 1 of
    // the box's widening; a VERTICAL box redistributes nothing horizontally (its alignment is the vertical packing),
    // so its children just ride the box's own shift → factor 0 (still intercepted, so a vbox child doesn't run the
    // Godot-ignored anchor algebra). Mirrors the web containerHAlignFactor. Null → not a box (child runs normally).
    private static double? ContainerHAlignFactor(string? containerLayout)
    {
        if (string.IsNullOrEmpty(containerLayout))
        {
            return null;
        }

        if (containerLayout.StartsWith("vbox", StringComparison.Ordinal))
        {
            return 0.0;
        }

        if (!containerLayout.StartsWith("hbox", StringComparison.Ordinal))
        {
            return null;
        }

        return containerLayout.EndsWith("-center", StringComparison.Ordinal) ? 0.5
            : containerLayout.EndsWith("-end", StringComparison.Ordinal) ? 1.0
            : 0.0; // -begin (or any unknown hbox suffix) packs from the left → no horizontal shift
    }

    // The subset of the web WalkCtx the SPREAD walk needs (placement/tint/opacity are the reconciler's job, not
    // this pure index's): the cumulative parent shift, the widening budget + anchor frame, the rigid-child ride,
    // the field-flavor flag, the parent width (full-canvas vs corner-widget test), and the parent's UNSHIFTED
    // global (the anchor algebra's basis lift).
    private readonly record struct WalkCtx(
        double ParentDx,
        double DeltaParentWidth,
        double AnchorDelta,
        bool ParentDxProp,
        double RideDx,
        double ParentWidth,
        IReadOnlyList<double> ParentGlobal,
        // WS-P2: the parent's OWN record Dx (root = 0), so a child can fold its parent-relative shift exactly as
        // SceneReconciler.ApplySpread does (rec.Dx − parentRecord.Dx). Independent of ParentDx (the baseline shift a
        // child inherits), which is NOT always the parent's record Dx (e.g. an anchor-algebra child's ParentDx is
        // the parent's shift, but a positional claimer overwrites ParentDx with its own claim for its children).
        double ParentRecordDx,
        // The horizontal redistribution factor a child of a widened BoxContainer parent rides (0 begin / 0.5 center
        // / 1 end for an H-box; 0 for a V-box → ride the parent's own shift), or null when the parent is NOT a
        // widened BoxContainer. A real Godot BoxContainer IGNORES its children's anchors and re-lays out its packed
        // row/column when its box resizes, so a box child must NOT run the anchor algebra — it rides `ParentDx +
        // factor·DeltaParentWidth` (see the BOX CHILD branch in Visit). Set by the parent from its ContainerLayout.
        double? ContainerChildAlign = null,
        // True when the widened BoxContainer parent is VERTICAL: its alignment packs the other axis, but Godot lays
        // each child out across the box's full WIDTH (cross-axis fill), so a child whose own box already spans the
        // container's pre-widen width is full-frame background ART that re-centers (the fullCanvas convention)
        // instead of stranding left (see the BOX CHILD branch).
        bool ContainerChildVertical = false);
}
