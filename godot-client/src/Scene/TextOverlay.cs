// Track-B "perceived Full" text overlay. At a Half/Quarter render scale the whole mirror stage rasterizes at design/2
// (or /4) res and is scaled up, so text — read pixel-for-pixel — turns mushy. This controller promotes SAFE, STATIC
// text labels OUT of the scaled stage into a NATIVE-resolution CanvasLayer (Layer 32, between the stage at layer 0 and
// the UiRoot chrome at 64): per promoted label a Node2D holder at the live view's exact global transform (design space
// == root-canvas space) carries a Label/RichTextLabel built by the SAME TextBuilder + IdentityCache metrics as the
// in-stage "__text" child — identical layout, but rasterized crisp at native res. The in-stage "__text" is hidden
// (view.SetTextPromoted) so it never double-draws. Result: "perceived Full" text at Half's cheaper fill rate.
//
// The pure-C# TextOverlayPlanner owns the eligibility + paint-order occlusion math (Godot-free, Exe-tested); this
// controller owns the Godot proxy build/free, the per-frame visibility, the per-drain demotion guard, and the gating.
//
// Active when the persisted "Crisp text" client setting is on and RenderScale != Full. Inert at Full.
// Promotion runs at an eval cadence (every EvalCadenceFrames AND AssetStores.AllIdle — the font/asset-settled gate);
// per-frame work is visibility only. When Active flips false, DemoteAll. Freed with the stage on Back-to-menu.

using System.Collections.Generic;
using System.Text.Json.Nodes;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Scene.Drawers;
using CouchCoop.GodotClient.Scene.Effects;
using CouchCoop.GodotClient.Ui;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene;

public sealed partial class TextOverlay : CanvasLayer
{
    // The proxy holder is synced per frame (global
    // transform + live own modulate + visibility), so a promoted label whose OWN chain animates is TRACKED instead of
    // rejected/demoted; an OrderChanged (a hand re-fan during a card draw) replans+diffs in place instead of demoting
    // the WHOLE overlay (incl. the TopBar HP/gold that nothing near); a newly added/shown label promotes the SAME drain
    // (no cadence wait); demoted proxies are PARKED + revived. Net: crisp↔mushy transitions collapse to genuine
    // occlusion changes. The user-facing gate remains the "Crisp text" client setting.
    // The planner sweeps in Godot's true effZ paint order, so a combat-scene
    // label (creature HP number, power/block stack count, a floating "Wears Off" notification) that lives under the
    // z=-10 CombatSceneContainer / z=-9 CombatVfxContainer band is checked against the z=0 content that actually
    // paints over it — instead of never promoting at all.
    // env-gated per-transition trace (M3_TEXTOVL_TRANS lines) — the before/after headline metric's raw data (one line
    // per promote/revive/demote with the node NAME so a soak can bucket TopBar HP/gold vs the rest). Null-cost off.
    private static readonly bool TransDebug =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TRANS_DEBUG") == "1";

    // Each text
    // candidate's tight, alignment-aware glyph box (read off the live "__text" child) replaces the guess, so an
    // ADJACENT icon no longer phantom-occludes a padded HP/gold/energy counter.
    // The current planner batch:
    //   (a) TopBar floor number / deck count — occluder art-box tightening + measured-candidate tightening; the deck
    //       count's shader-bearing deck-button ancestor no longer Effect-rejects its label.
    //   (b) deck/draw/discard/exhaust dialog card text — CardOwned follows the CardLayer verdict; declined grid-card
    //       labels fall through, with clipping containment under the dialog ScrollContainer.
    //   (c) dialog sort-option labels — clipping containment.
    //   (e) hover-tip title/description — measured-candidate tightening (graze tolerance + low-alpha shadow tail).
    // Fade-in support covers both legs of the rest-site focused-description fix:
    //   (a) the planner's Invisible check reads the tween ENDPOINT alpha for a tween-owned fade-IN chain (via
    //       TweenReplayer.CollectFadeInEndpoints), so the label PROMOTES at the start of the fade instead of only after
    //       the tween settles on a drain the eval happens to see; and
    //   (b) RefreshProxiesStable composes the holder's ANCESTOR modulate from the LIVE view parents per frame, so a
    //       promoted label whose fade rides an ancestor is not pinned invisible while its own alpha animates.
    // (a) alone → promoted-but-invisible (holder pinned); (b) alone → crisp arrives late. Ship both.
    // env-gated design-space rect dump (one M3_TEXT_RECTS block per eval) for the crisp-text crop verification.
    private static readonly bool DumpRects =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TEXTRECTS") == "1";

    // env-gated per-candidate occlusion trace (M3_TEXTOVL_OCC lines) — diagnoses over-occlusion without a debugger.
    private static readonly bool DebugOcclusion =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TEXTOVL_DEBUG") == "1";

    // Between the stage (root default canvas, layer 0 / the SubViewportContainer) and UiRoot (layer 64). Immune to
    // AppShell child-order churn (CanvasLayers sort by Layer, not sibling order).
    private const int OverlayLayer = 32;

    // Attempt a plan at most this often (a plan sweeps ordered ids + collects the excluded set — not per-frame work).
    private const int EvalCadenceFrames = 30;

    // Re-promotion debounce for repeated transient demotions. It only delays a new promotion; a required demotion is
    // always applied immediately.
    private const int ChurnDemoteThreshold = 2;
    private const int ChurnWindowEvals = 4;
    private const int ChurnCooldownEvals = 4;

    private SceneReconciler _reconciler = null!;
    private MirrorStore _store = null!;
    private RenderContext _ctx = null!;

    private readonly TextOverlayPlanner _planner = new();
    private System.Func<string, double> _spreadDxOf = null!;

    // WS-COLUMN: a node's anchor-WIDENED rendered width (SpreadRecord.RenderedWidth; 0 = no override). Fed to the
    // planner so the clip-containment check measures a horizontally-stretched ScrollContainer at its true rendered
    // width — without it the deck/draw/discard/exhaust dialog's LAST grid column is falsely Clip-rejected at F≠1.
    private System.Func<string, double> _spreadWidthOf = null!;

    // Track E: the per-id measured DESIGN-space glyph AABB fed into Plan/CollectDemotions. Rebuilt every eval from the
    // live views (RefreshMeasurements), invalidated per-id on a content change between evals (OnDrained), and cleared
    // on any fresh-scene event (DemoteAll). A missing id ⇒ the planner falls back to its rect+slack guess for that id.
    private readonly Dictionary<string, DesignAabb> _measured = new(System.StringComparer.Ordinal);
    private System.Action<MirrorNodeView> _measureView = null!; // cached delegate for the per-eval ForEachLiveView sweep

    // WS-CRISP R17: the tween ENDPOINT alpha per node with an active fade-IN (TweenReplayer.CollectFadeInEndpoints),
    // rebuilt each Plan / drain-guard call and fed to the planner so the Invisible eligibility check reads the alpha
    // the fade animates to instead of the producer-pinned ≈0.
    private readonly Dictionary<string, double> _fadeInAlpha = new(System.StringComparer.Ordinal);

    // Per-id measured drawn-art design boxes for textured OCCLUDERS (decode-time used-rect, stretch-
    // mapped by the view — see MirrorNodeView.TryGetBlockerArtRect), rebuilt in the same per-eval sweep as _measured;
    // plus the CardLayer root-verdict scratch sets and the options object handed to the planner. Its sets are refilled
    // at each eval and drain guard.
    private readonly Dictionary<string, DesignAabb> _blockerArt = new(System.StringComparer.Ordinal);
    private readonly Dictionary<string, DesignAabb> _blockerArtHoles = new(System.StringComparer.Ordinal);

    // WS-EVENTTEXT #14 Leg B: per-id TIGHT ink box for a TEXT view used ONLY as a demoted-occluder box (a single-line
    // RichTextLabel narrowed to its drawn glyphs — see MirrorNodeView.TryGetTextGlyphRect tightRichWidth). Rebuilt each
    // eval in the same live-view sweep as _measured; fed to the planner via TextOverlayOptions.TextBlockerExtents so
    // the full-screen-box ancient name banner ("NEOW") stops phantom-occluding the event options beside it.
    private readonly Dictionary<string, DesignAabb> _textBlockerExtents = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _cardPromotedRoots = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _cardKnownRoots = new(System.StringComparer.Ordinal);
    private TextOverlayOptions? _plannerOptions;

    // One promoted label's live proxy.
    private sealed class Proxy
    {
        public required Node2D Holder;
        public required Control Label;
        public bool Rich;
        public long PaintKey;
        public DesignAabb Aabb; // the planner's rendered box (the per-drain demotion guard reads it)

        // Track-ST per-frame-sync guards (skip a redundant Godot property write when the sampled value is unchanged).
        public Transform2D LastHolder;
        public Color LastLabelMod = Colors.White;
        public bool LastVisible = true;

        // WS-CRISP R17 (leg b): the last LIVE ancestor-composed modulate written onto the holder per frame (guards a
        // redundant write when the fade hasn't advanced). Sentinel-init so the first sync always writes.
        public Color LastHolderMod = new(-1, -1, -1, -1);
    }

    private readonly Dictionary<string, Proxy> _proxies = new(System.StringComparer.Ordinal);

    // Track-ST park/revive (mirrors the CardLayer): a demoted proxy's holder+label is HIDDEN and kept in-tree instead
    // of Free()d, and a re-promotion of the same id REVIVES it (re-configure content, re-show, re-hoist the in-stage
    // text) — reusing the built Label/RichTextLabel node. Cap ≥ the promotable-label count; overflow / a rich↔plain
    // type flip / a scene teardown Free()s the parked entry. Pruned each eval when the id is no longer promotable.
    private readonly Dictionary<string, Proxy> _parked = new(System.StringComparer.Ordinal);
    private const int ParkedCap = 24;

    // Track-ST scratch for the per-frame proxy sync (ids whose live view vanished → demote after the read loop).
    private readonly List<string> _syncDemoteScratch = new();

    // Reused scratch (avoid per-eval / per-drain allocation).
    private readonly HashSet<string> _excluded = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _transformOwned = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _boundedCosmetic = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _planIds = new(System.StringComparer.Ordinal);
    private readonly List<string> _removeScratch = new();
    private readonly HashSet<string> _demote = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _rebuild = new(System.StringComparer.Ordinal);
    private readonly List<TextOverlayItem> _currentItems = new();

    // Transient demotions accumulate between evaluations, then arm the shared re-promotion debounce.
    private readonly HashSet<string> _churnDemote = new(System.StringComparer.Ordinal);
    private readonly HashSet<string> _pendingChurn = new(System.StringComparer.Ordinal);
    private readonly RepromoteDebounce _debounce =
        new(ChurnDemoteThreshold, ChurnWindowEvals, ChurnCooldownEvals);

    public long ChurnSuppressed { get; private set; }


    private bool _active;
    private bool _indexDirty = true;
    private int _framesSinceEval;
    private bool _evaluatedThisScene; // an eval ran with assets idle (the shot-settle terminal)

    // Telemetry (instance-scoped — dies with the stage on Back-to-menu; AppShell surfaces it).
    public long BuildTotal { get; private set; }   // proxies FRESH-built (promotions)
    public long DemoteTotal { get; private set; }  // proxies torn down / parked (demotions)
    public long ReviveTotal { get; private set; }  // Track-ST: parked proxies revived (a cheap promotion)

    // Track-ST headline metric: total crisp↔mushy TRANSITIONS this session. Every fresh build + every revive is a
    // "crisp text appears" flip; every demote/park is a "crisp text disappears" flip. transitionsPerMin (elapsed comes
    // from AppShell) is the before/after number the user's flicker bug is measured by — the target is that this
    // collapses to genuine occlusion events (≈0 for the TopBar during card draws).
    public long TransitionsTotal => BuildTotal + ReviveTotal + DemoteTotal;

    // Track-Z telemetry fix: demotes of a label that is still SCREEN-VISIBLE at demote time (its node renders visible
    // text through its whole chain). A demote of a label that just vanished/hid (the dominant demote reason: the node
    // left the scene, an ancestor hid, a fade finished) is NOT a perceptible crisp→mushy flip — the text disappears
    // entirely either way — so the raw DemoteTotal over-counts the user-facing flicker.
    public long VisibleDemoteTotal { get; private set; }

    // The USER-FACING flicker metric: fresh builds (every promotion is a visible mushy→crisp flip — eligibility rejects
    // an invisible label) + screen-visible demotes. Revives are EXCLUDED: a park+revive pair is at most ONE visible
    // flip and its visible half is already counted by the park-side VisibleDemote (an invisible park+revive is zero
    // flips). The raw TransitionsTotal above is kept for soak-to-soak comparability.
    public long VisibleTransitionsTotal => BuildTotal + VisibleDemoteTotal;

    public int PromotedCount => _proxies.Count;
    public int ParkedCount => _parked.Count;
    public int LastEvaluated => _planner.LastEvaluated;
    public bool Active => _active;

    // Wire the controller (called by AppShell.MountRenderStage AFTER the reconciler is bound). Parks inert until the
    // first eval; the supported Crisp Text setting and render scale decide Active each frame.
    public void Bind(SceneReconciler reconciler, MirrorStore store)
    {
        Layer = OverlayLayer;
        // Run the per-frame proxy sync late, after this frame's tweens have stepped live transforms.
        ProcessPriority = 100;

        _reconciler = reconciler;
        _store = store;
        _ctx = reconciler.Context;
        _spreadDxOf = id => _store.Spread.TryGet(id, out var rec) ? rec.Dx : 0.0;
        _spreadWidthOf = id => _store.Spread.TryGet(id, out var rec) ? rec.RenderedWidth : 0.0;
        _measureView = MeasureViewInto;
        if (DebugOcclusion)
        {
            _planner.Debug = line => GD.Print($"M3_TEXTOVL_OCC: {line}");
        }

        _active = ComputeActive();
    }

    // Crisp text applies below the full render scale.
    private static bool ComputeActive() =>
        ClientSettingsStore.CrispText && ClientEffectSettings.RenderScale != RenderScale.Full;

    public override void _Process(double delta)
    {
        // Poll the settings each frame (O(1) static reads — cheaper than a generation compare). On Active→false, tear
        // every proxy down so nothing is left promoted at Full / with the setting off.
        bool want = ComputeActive();
        if (want != _active)
        {
            _active = want;
            if (!_active)
            {
                DemoteAll();
            }
            else
            {
                _framesSinceEval = 0; // re-eval promptly on Active→true
            }
        }

        if (!_active)
        {
            return;
        }

        // Per-frame proxy sync tracks live transforms, opacity, and visibility.
        RefreshProxiesStable();

        _framesSinceEval++;
        // Text promotion uses conservative geometry while textures settle; capture still waits for idle assets.
        if (_framesSinceEval >= EvalCadenceFrames)
        {
            _framesSinceEval = 0;
            Eval();
        }
    }

    // Track-ST per-frame proxy sync: re-sample each promoted label's holder global transform + its live OWN modulate +
    // its tree-visibility from the live view, so an animating chain (transform/opacity tween, bob, input lift) is
    // tracked crisp. The holder's ANCESTOR-composed modulate is refreshed per DRAIN (RefreshHolder); the LABEL child
    // carries the node's live own modulate here (self_modulate stays folded into the glyph colours by TextBuilder).
    // Guarded writes. A vanished view ⇒ demote after the read loop (never mutate the dictionary mid-iteration).
    private void RefreshProxiesStable()
    {
        _syncDemoteScratch.Clear();
        foreach (var (id, px) in _proxies)
        {
            if (!GodotObject.IsInstanceValid(px.Holder))
            {
                continue;
            }

            if (!_reconciler.TryGetView(id, out var view) || !GodotObject.IsInstanceValid(view))
            {
                _syncDemoteScratch.Add(id);
                continue;
            }

            var gt = view.GetGlobalTransform();
            if (px.LastHolder != gt || px.Holder.Transform != gt)
            {
                px.Holder.Transform = gt;
                px.LastHolder = gt;
            }

            var own = view.Modulate; // live own modulate (captures an in-flight opacity tween on the label itself)
            if (px.LastLabelMod != own || px.Label.Modulate != own)
            {
                px.Label.Modulate = own;
                px.LastLabelMod = own;
            }

            // WS-CRISP R17 (leg b): the holder carries the ANCESTOR-composed modulate. RefreshHolder samples it per
            // DRAIN from the producer-pinned STREAMED value, which stays ≈0 for the whole duration of a fade that rides
            // an ANCESTOR — so a promoted label would sit invisible even though its ancestor's alpha is animating up.
            // Re-compose it here per frame from the live view parents, guarded so a settled tip re-stamps for free.
            {
                var anc = LiveAncestorModulate(id);
                if (px.LastHolderMod != anc || px.Holder.Modulate != anc)
                {
                    px.Holder.Modulate = anc;
                    px.LastHolderMod = anc;
                }
            }

            bool visible = view.IsVisibleInTree() && !view.SelfPaintSuppressed;
            if (px.LastVisible != visible || px.Holder.Visible != visible)
            {
                px.Holder.Visible = visible;
                px.LastVisible = visible;
            }
        }

        foreach (var id in _syncDemoteScratch)
        {
            Demote(id);
        }
    }

    // WS-CRISP R17 (leg b): the ancestor-composed modulate from the LIVE view parents of `id` (its PARENT up to the
    // root, product of each parent's own Godot Modulate — which the in-flight opacity tween writes directly). Mirrors
    // RefreshHolder's `EffectiveModulate(parentId)` but off the live views instead of the producer-pinned streamed
    // state, so a tween-owned ancestor fade is tracked per frame. A parent with no live view (transiently unresolved)
    // falls back to its streamed node modulate (EffectiveModulate parity). The label child carries the node's OWN
    // modulate (above), so holder(ancestor) × label(own) reproduces the full effective cascade.
    private Color LiveAncestorModulate(string id)
    {
        float r = 1, g = 1, b = 1, a = 1;
        string? cur = _store.State.Nodes.TryGetValue(id, out var self) ? self.ParentId : null;
        int guard = 0;
        while (cur is not null && _store.State.Nodes.TryGetValue(cur, out var node) && guard++ < 4096)
        {
            Color m;
            if (_reconciler.TryGetView(cur, out var pv) && GodotObject.IsInstanceValid(pv))
            {
                m = pv.Modulate;
            }
            else
            {
                double na = node.Modulate is { } mm ? mm.A : node.Opacity;
                m = node.Modulate is { } c
                    ? new Color((float)c.R, (float)c.G, (float)c.B, (float)na)
                    : new Color(1, 1, 1, (float)na);
            }

            r *= m.R;
            g *= m.G;
            b *= m.B;
            a *= m.A;
            cur = node.ParentId;
        }

        return new Color(r, g, b, a);
    }

    // Rebuild the fade-in endpoint map from active modulate tweens for the planner. Called before each plan
    // and each drain-guard CollectDemotions so the eligibility Invisible check always reads the CURRENT reveal targets.
    private System.Collections.Generic.IReadOnlyDictionary<string, double>? CollectFadeIn()
    {
        _fadeInAlpha.Clear();
        TweenReplayer.CollectFadeInEndpoints(_fadeInAlpha);
        return _fadeInAlpha;
    }

    // ---- eval (promotion) --------------------------------------------------------------------------------------

    // Plan → diff against the live proxies → build new proxies (proxy FIRST, then SetTextPromoted(true) the same frame)
    // → demote gone ones → re-order holders by paint key. Times the whole attempt on the TextOverlay walk bucket.
    //
    // Track-ST: this is now ALSO the same-drain replan the OrderChanged/Keyframe hook runs (in place of DemoteAll) — a
    // hand re-fan re-plans + diffs instead of dropping every proxy. `changedIds` (when supplied by that hook) rebuilds a
    // kept proxy whose content changed the same drain; `forceRebuildKept` (a surviving-tree keyframe) rebuilds every
    // kept proxy's content. A kept proxy otherwise keeps its Label and just re-syncs its holder (per-frame does the rest).
    private void Eval(IReadOnlySet<string>? changedIds = null, bool forceRebuildKept = false)
    {
        long start = WalkProfiler.Start();

        _debounce.BeginEval(_pendingChurn);
        _pendingChurn.Clear();

        if (_indexDirty)
        {
            _planner.RebuildIndex(_store.State);
            _indexDirty = false;
        }

        PruneParked(); // drop parked proxies whose label left the scene / lost its text (a revive can never match)

        _excluded.Clear();
        _boundedCosmetic.Clear();
        _reconciler.CollectBakeExcluded(_excluded, _boundedCosmetic); // both sets in one _views pass
        // Track-C: a promoted card's cloneable members (incl. its title/type/description labels) read as Dynamic here,
        // so the text overlay does NOT also promote those labels as loose proxies (no double label — the card clone
        // already carries them crisp). No-op when the card layer is off / promoting nothing.
        _reconciler.CollectCardPromoted(_excluded);
        _transformOwned.Clear();
        TweenReplayer.CollectTransformOwned(_transformOwned);

        // Track E: rebuild the measured glyph extents from the live views (once per eval, not per frame), then feed them
        // to the planner so a tight, alignment-aware label box replaces the blanket rect+24 guess.
        RefreshMeasurements();

        // Per-frame proxy sync tracks own-chain motion; CardLayer owns promoted card text.
        bool excludeCards = _reconciler.CardLayerActive;
        var plan = _planner.Plan(
            _store.State, _store.Transforms, _store.SpreadFactor, _spreadDxOf, _excluded, _transformOwned,
            _boundedCosmetic, _measured, excludeCards, BuildPlannerOptions(),
            _spreadWidthOf, CollectFadeIn());
        _evaluatedThisScene = true;

        _planIds.Clear();
        foreach (var item in plan.Items)
        {
            _planIds.Add(item.Id);
        }

        // Demote proxies no longer promotable.
        _removeScratch.Clear();
        foreach (var (id, _) in _proxies)
        {
            if (!_planIds.Contains(id))
            {
                _removeScratch.Add(id);
            }
        }

        foreach (var id in _removeScratch)
        {
            Demote(id);
        }

        // Build new proxies + refresh the cached box on kept ones.
        foreach (var item in plan.Items)
        {
            if (_proxies.TryGetValue(item.Id, out var existing))
            {
                existing.Aabb = item.Aabb;
                existing.PaintKey = item.PaintKey;

                // Track-ST: a kept proxy re-syncs its holder in place (a replan may have followed an ancestor move), and
                // rebuilds its label content when this drain changed it (or a surviving-tree keyframe forces it). OFF →
                // the holder refresh already happened per-drain in OnDrained; nothing to do here.
                if (_reconciler.TryGetView(item.Id, out var keptView) && GodotObject.IsInstanceValid(keptView))
                {
                    if (forceRebuildKept || (changedIds is not null && changedIds.Contains(item.Id)))
                    {
                        RebuildProxyContent(item.Id);
                    }
                    else
                    {
                        RefreshHolder(existing, keptView);
                    }
                }
            }
            else if (RepromoteSuppressed(item.Id))
            {
                ChurnSuppressed++;
            }
            else
            {
                Promote(item);
            }
        }

        // Order holders by paint key ascending (ancestor text last = drawn on top), so overlapping promoted labels
        // compose exactly as the in-stage paint order would.
        for (int i = 0; i < plan.Items.Count; i++)
        {
            if (_proxies.TryGetValue(plan.Items[i].Id, out var px) && GodotObject.IsInstanceValid(px.Holder))
            {
                MoveChild(px.Holder, i);
            }
        }

        WalkProfiler.Stop(WalkProfiler.Metric.TextOverlay, start);
        LogOutcome(plan);

        if (DumpRects)
        {
            DumpRectLines(plan);
        }
    }

    // Build the native-res proxy for `item`, THEN hide the in-stage text (same frame → no flash of double text).
    // Track-ST: try a parked-proxy REVIVE first (reuse the built Label node); else a fresh build.
    private void Promote(TextOverlayItem item)
    {
        if (!_reconciler.TryGetView(item.Id, out var view) || !GodotObject.IsInstanceValid(view))
        {
            return;
        }

        var node = view.TextEffectiveNode;
        bool rich = node.RichText;

        if (TryRevive(item, view, node, rich))
        {
            return;
        }

        var holder = new Node2D { Name = $"txo_{Sanitize(item.Id)}" };
        Control label = rich ? new RichTextLabel() : new Label();
        label.Name = "__txt";
        holder.AddChild(label);
        AddChild(holder);

        Configure(label, node);
        var proxy = new Proxy { Holder = holder, Label = label, Rich = rich, PaintKey = item.PaintKey, Aabb = item.Aabb };
        _proxies[item.Id] = proxy;
        RefreshHolder(proxy, view);

        view.SetTextPromoted(true); // now the overlay text is up → hide the in-stage "__text" this same frame
        BuildTotal++;
        Trace("promote", item.Id);
    }

    // Track-ST: revive a PARKED proxy for `item` — same id, same rich/plain kind → re-Configure the retained Label
    // from the current node, re-show the holder, re-hide the in-stage text, and refresh the holder. Reuses the built
    // Label/RichTextLabel node (no fresh construction). False (caller fresh-builds) when there is no parked entry, the
    // kind flipped, or the parked holder/label is stale — the parked entry is Free()d on a kind flip / stale mismatch.
    private bool TryRevive(TextOverlayItem item, MirrorNodeView view, MirrorNode node, bool rich)
    {
        if (!_parked.Remove(item.Id, out var parked))
        {
            return false;
        }

        if (!GodotObject.IsInstanceValid(parked.Holder) || !GodotObject.IsInstanceValid(parked.Label)
            || parked.Rich != rich)
        {
            if (GodotObject.IsInstanceValid(parked.Holder))
            {
                parked.Holder.Free();
            }

            return false;
        }

        parked.PaintKey = item.PaintKey;
        parked.Aabb = item.Aabb;
        Configure(parked.Label, node);
        parked.Holder.Visible = true;
        parked.LastVisible = true;
        _proxies[item.Id] = parked;
        RefreshHolder(parked, view);

        view.SetTextPromoted(true);
        ReviveTotal++;
        Trace("revive", item.Id);
        return true;
    }

    // Tear one proxy down THIS frame: un-hide the in-stage text (if the view still lives) THEN, under Track-ST, PARK the
    // hidden holder for a cheap revive (`park` true — the default) or immediately Free it (`park` false — teardown /
    // eviction). OFF always Free()s (the original atomic pattern; no ghost draw, the "__text" re-shows the same frame).
    private void Demote(string id, bool park = true)
    {
        if (!_proxies.Remove(id, out var proxy))
        {
            return;
        }

        if (_reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
        {
            view.SetTextPromoted(false); // un-hoist FIRST → the in-stage "__text" re-shows this same frame
        }

        if (park && GodotObject.IsInstanceValid(proxy.Holder))
        {
            proxy.Holder.Visible = false; // hidden in-tree — zero draw cost, ready for a revive
            proxy.LastVisible = false;
            if (_parked.Count >= ParkedCap)
            {
                EvictOneParked();
            }

            if (_parked.Remove(id, out var stale) && GodotObject.IsInstanceValid(stale.Holder))
            {
                stale.Holder.Free();
            }

            _parked[id] = proxy;
        }
        else if (GodotObject.IsInstanceValid(proxy.Holder))
        {
            proxy.Holder.Free();
        }

        DemoteTotal++;
        if (IsScreenVisibleText(id))
        {
            VisibleDemoteTotal++; // a perceptible crisp→mushy flip (the label still renders — just back in-stage)
        }

        Trace("demote", id);
    }

    // Does `id` still render visible text on screen RIGHT NOW (node present, text non-empty, every ancestor Visible,
    // ancestor-composed modulate alpha above the paint threshold)? The visible-transition discriminator: a demote of a
    // label failing this is imperceptible (the text vanished anyway).
    private bool IsScreenVisibleText(string id)
    {
        if (!_store.State.Nodes.TryGetValue(id, out var node) || node.Text is not { Text.Length: > 0 })
        {
            return false;
        }

        string? cur = id;
        int guard = 0;
        while (cur is not null && _store.State.Nodes.TryGetValue(cur, out var n) && guard++ < 4096)
        {
            if (!n.Visible)
            {
                return false;
            }

            cur = n.ParentId;
        }

        return TextOverlayPlanner.EffectiveModulate(_store.State, id).A > 0.02;
    }

    // Track-ST: free one parked proxy (arbitrary; overflow eviction).
    private void EvictOneParked()
    {
        foreach (var (id, proxy) in _parked)
        {
            _parked.Remove(id);
            if (GodotObject.IsInstanceValid(proxy.Holder))
            {
                proxy.Holder.Free();
            }

            return;
        }
    }

    // Track-ST: free parked proxies whose label left the scene or lost its text (a revive can never match). Called from
    // Eval (the eval cadence / replan) so stale parks don't linger until eviction.
    private void PruneParked()
    {
        if (_parked.Count == 0)
        {
            return;
        }

        List<string>? dead = null;
        foreach (var (id, _) in _parked)
        {
            if (!_store.State.Nodes.TryGetValue(id, out var n) || n.Text is not { Text.Length: > 0 })
            {
                (dead ??= new List<string>()).Add(id);
            }
        }

        if (dead is not null)
        {
            foreach (var id in dead)
            {
                if (_parked.Remove(id, out var proxy) && GodotObject.IsInstanceValid(proxy.Holder))
                {
                    proxy.Holder.Free();
                }
            }
        }
    }

    private void DemoteAll()
    {
        // A fresh-start event drops stale geometry and debounce state.
        _pendingChurn.Clear();
        _debounce.Reset();
        _measured.Clear(); // Track E: stale glyph measurements from the prior scene must not feed the next plan

        // Track-ST: a fresh-scene event makes any parked clone stale (a revive across it would resurrect wrong text) —
        // Free every parked holder too.
        if (_parked.Count > 0)
        {
            foreach (var (_, proxy) in _parked)
            {
                if (GodotObject.IsInstanceValid(proxy.Holder))
                {
                    proxy.Holder.Free();
                }
            }

            _parked.Clear();
        }

        if (_proxies.Count == 0)
        {
            return;
        }

        _removeScratch.Clear();
        foreach (var (id, _) in _proxies)
        {
            _removeScratch.Add(id);
        }

        foreach (var id in _removeScratch)
        {
            Demote(id, park: false); // teardown → Free, never park
        }
    }

    private bool RepromoteSuppressed(string id) => _debounce.Suppressed(id);

    // A genuine text-content update should not remain withheld by an earlier transient-demotion cooldown.
    private void ClearDebounceForTextChanges(IReadOnlySet<string> changedIds)
    {
        if (changedIds.Count == 0)
        {
            return;
        }

        var flags = _store.State.ChangeFlags;
        foreach (var id in changedIds)
        {
            if (flags.TryGetValue(id, out var f) && (f & NodeChangeFlags.Text) != NodeChangeFlags.None)
            {
                _debounce.Clear(id);
            }
        }
    }


    // Re-configure a promoted label's CONTENT in place (a changed but still-eligible label — e.g. a ticking HP counter)
    // — crisp, no flicker. A rich↔plain flip can't reconfigure in place, so demote and let the next eval re-promote.
    private void RebuildProxyContent(string id)
    {
        if (!_proxies.TryGetValue(id, out var proxy)
            || !_reconciler.TryGetView(id, out var view)
            || !GodotObject.IsInstanceValid(view))
        {
            return;
        }

        var node = view.TextEffectiveNode;
        if (node.RichText != proxy.Rich)
        {
            Demote(id);
            return;
        }

        Configure(proxy.Label, node);
        RefreshHolder(proxy, view);
    }

    // ---- reconciler hooks ---------------------------------------------------------------------------------------

    // Tail-called from SceneReconciler.OnDrained AFTER the StaticBake hook. Keyframe/OrderChanged (incl. dialog opens)
    // demote everything + mark the paint-order index dirty; otherwise the cheap per-drain guard.
    public void OnDrained(MirrorStore.DrainInfo info)
    {
        ClearDebounceForTextChanges(info.ChangedIds);

        if (info.Keyframe || info.OrderChanged)
        {
            _indexDirty = true;

            // Replan and diff surviving views in place; a full rebuild replaces view objects so proxies are stale.
            if (_active && !(info.Keyframe && _reconciler.LastDrainFullRebuilt))
            {
                Eval(changedIds: info.ChangedIds, forceRebuildKept: info.Keyframe); // self-timed on the TextOverlay bucket
            }
            else
            {
                DemoteAll();
                _evaluatedThisScene = false; // a fresh scene — the shot must wait for a new eval
            }

            return;
        }

        if (!_active)
        {
            return;
        }

        if (_proxies.Count == 0)
        {
            // Track-ST event-driven promotion: a drain that ADDED or SHOWED a candidate text node (with no order change
            // — e.g. a Visible toggle) promotes it THIS drain instead of waiting for the ~30-frame cadence. Self-timed.
            // Nothing is promoted, so no guard demotes to exclude.
            if (HasNewCandidateText(info.ChangedIds, null))
            {
                Eval();
            }

            return;
        }

        long start = WalkProfiler.Start();

        BuildCurrentItems();

        _excluded.Clear();
        _reconciler.CollectBakeExcluded(_excluded);

        // Track E: a changed node's cached glyph box is now stale (its text/geometry may have moved) — drop it so
        // CollectDemotions falls back to the conservative rect+slack box for it (a fresh eval re-measures next cycle).
        {
            foreach (var id in info.ChangedIds)
            {
                _measured.Remove(id);
            }
        }

        // Per-frame sync tracks own-chain motion; CardLayer owns promoted card text.
        bool excludeCards = _reconciler.CardLayerActive;
        _planner.CollectDemotions(
            _store.State, _store.Transforms, _store.SpreadFactor, _spreadDxOf,
            _currentItems, info.ChangedIds, info.Hints, _excluded, _demote, _rebuild, _churnDemote,
            _measured, excludeCards, BuildPlannerOptions(), _spreadWidthOf,
            CollectFadeIn());

        foreach (var id in _churnDemote)
        {
            _pendingChurn.Add(id);
        }


        foreach (var id in _demote)
        {
            Demote(id);
        }

        foreach (var id in _rebuild)
        {
            RebuildProxyContent(id);
        }

        // Refresh every surviving holder's transform + modulate for this drain (a moved ancestor shifts the label).
        foreach (var (id, px) in _proxies)
        {
            if (_reconciler.TryGetView(id, out var view) && GodotObject.IsInstanceValid(view))
            {
                RefreshHolder(px, view);
            }
        }

        WalkProfiler.Stop(WalkProfiler.Metric.TextOverlay, start);

        // Track-ST event-driven: a Visible-toggle / late-add candidate that this drain introduced evals THIS drain
        // (self-timed). Run AFTER the guard's Stop so the two TextOverlay-bucket samples don't nest. Exclude the ids the
        // guard just demoted / rebuilt: a genuinely NEW candidate is neither, whereas a proxy the conservative guard
        // (padded boxes) just demoted must NOT be immediately re-promoted here — that would be a same-drain
        // demote↔revive thrash (the guard's padded occlusion demote correcting-then-uncorrecting against the tight-box
        // Plan). Re-promotion of such a label happens on the next replan (order change / cadence) when it is genuinely clear.
        if (HasNewCandidateText(info.ChangedIds, _demote, _rebuild))
        {
            Eval();
        }
    }

    // Track-ST: does this drain's changed set carry a GENUINELY NEW text candidate (text-bearing + visible, not already
    // promoted, and not one the guard just demoted/rebuilt this drain)? A cheap pre-filter for the event-driven eval
    // (Eval itself does the full eligibility/occlusion/card-exclusion work).
    private bool HasNewCandidateText(IReadOnlySet<string> changedIds, ISet<string>? justDemoted, ISet<string>? justRebuilt = null)
    {
        foreach (var id in changedIds)
        {
            if (_proxies.ContainsKey(id)
                || (justDemoted is not null && justDemoted.Contains(id))
                || (justRebuilt is not null && justRebuilt.Contains(id)))
            {
                continue;
            }

            if (_store.State.Nodes.TryGetValue(id, out var n) && n.Visible && n.Text is { Text.Length: > 0 })
            {
                return true;
            }
        }

        return false;
    }

    // A bare spread-factor relayout shifts every holder's transform (and re-widens boxes) — drop all proxies, re-plan.
    public void OnSpreadChanged()
    {
        DemoteAll();
    }

    // An effect-mode flip re-Applied every view (re-showing suppressed "__text") and may have toggled effect-bearing
    // nodes — drop all proxies and re-plan next eval.
    public void OnRefreshEffects()
    {
        DemoteAll();
    }

    // ---- per-frame / per-drain holder maintenance ---------------------------------------------------------------

    // Per-drain: sample the view's EXACT global transform (includes the SpreadOffset fold + any ancestor move) onto the
    // holder, and the ancestor-composed EffectiveModulate onto its Modulate (self_modulate is folded into the label by
    // TextBuilder, not here). Also refresh visibility so the drain leaves a consistent state.
    private void RefreshHolder(Proxy proxy, MirrorNodeView view)
    {
        if (!GodotObject.IsInstanceValid(proxy.Holder))
        {
            return;
        }

        var gt = view.GetGlobalTransform();
        proxy.Holder.Transform = gt;
        proxy.LastHolder = gt;

        // The holder carries only the ancestor-composed modulate; the label carries its live own modulate.
        string? parentId = _store.State.Nodes.TryGetValue(view.NodeId, out var n) ? n.ParentId : null;
        var anc = parentId is null ? new Rgba(1, 1, 1, 1) : TextOverlayPlanner.EffectiveModulate(_store.State, parentId);
        proxy.Holder.Modulate = new Color((float)anc.R, (float)anc.G, (float)anc.B, (float)anc.A);

        var own = view.Modulate;
        proxy.Label.Modulate = own;
        proxy.LastLabelMod = own;

        bool visible = view.IsVisibleInTree() && !view.SelfPaintSuppressed;
        proxy.Holder.Visible = visible;
        proxy.LastVisible = visible;
    }

    // Configure the proxy label from the effective node via the SAME TextBuilder + IdentityCache metrics as the
    // in-stage SyncText, so the overlay layout is pixel-for-pixel the in-stage layout (just crisp).
    private void Configure(Control label, MirrorNode node)
    {
        var m = _ctx.IdentityCache.Resolve(node.Id, _store.State);
        if (label is RichTextLabel rtl)
        {
            TextBuilder.ConfigureRich(rtl, node, m.TextScale, m.LineHeight, m.ParagraphExtra, _ctx.Textures);
        }
        else
        {
            // R15: pass the same vertical nudge as the in-stage SyncText so the promoted proxy label sits pixel-for-
            // pixel where the in-stage label does (proxy parity).
            TextBuilder.ConfigureLabel((Label)label, node, m.TextScale, m.MaxSizePx, m.Wrap, m.NudgeYPx);
        }

        label.MouseFilter = Control.MouseFilterEnum.Ignore; // render-only (TextBuilder already sets this; belt-and-braces)
    }

    private void BuildCurrentItems()
    {
        _currentItems.Clear();
        foreach (var (id, px) in _proxies)
        {
            _currentItems.Add(new TextOverlayItem(id, px.PaintKey, px.Aabb));
        }
    }

    // ---- Track E: measured text extents -------------------------------------------------------------------------

    // Rebuild the per-id measured glyph AABB map from EVERY live view's "__text" child (once per eval). Cheap (a font-
    // metric read + a 4-corner transform per text node), gated behind AssetStores.AllIdle by the caller so fonts have
    // settled. Cleared first so a view that lost its text (or whose measurement is now unreliable) drops out.
    // The same sweep also collects textured occluders' drawn-art boxes (_blockerArt).
    private void RefreshMeasurements()
    {
        _measured.Clear();
        _blockerArt.Clear();
        _blockerArtHoles.Clear();
        _textBlockerExtents.Clear();
        _reconciler.ForEachLiveView(_measureView);
    }

    // Measure one live view's glyph box (view-local) and record its DESIGN-space AABB (the view's real global transform
    // — which already folds the wide-screen spread offset — applied to the local glyph rect). Skips a view with no
    // shaped "__text" child (the planner then falls back to rect+slack for that id). It also records
    // a textured view's tight drawn-art box (decode-time used-rect, stretch-mapped) for the occluder-tightening path,
    // and measure the glyph box with the low-alpha shadow tail exempted.
    private void MeasureViewInto(MirrorNodeView view)
    {
        if (view.TryGetTextGlyphRect(out var glyph, exemptLowAlphaShadow: true))
        {
            _measured[view.NodeId] = DesignAabbOf(view.GetGlobalTransform(), glyph);
        }

        // The tight text-occluder box is identical to the candidate glyph box for a plain Label
        // (or an untightenable RichTextLabel), but narrowed to the drawn ink for a single-line RichTextLabel so a
        // full-screen-box name banner ("NEOW") no longer phantom-occludes the options. Fed to the planner as the text
        // label's demoted-OCCLUDER box only (never its candidacy). Measured in the same sweep to keep it drain-coherent.
        if (view.TryGetTextGlyphRect(out var blockerGlyph, exemptLowAlphaShadow: true, tightRichWidth: true))
        {
            _textBlockerExtents[view.NodeId] = DesignAabbOf(view.GetGlobalTransform(), blockerGlyph);
        }

        if (view.TryGetBlockerArtRect(_ctx.Textures, out var art, out var hole))
        {
            var gt = view.GetGlobalTransform();
            _blockerArt[view.NodeId] = DesignAabbOf(gt, art);
            if (hole is { } hp)
            {
                // The hole must stay a SUBSET of the true transparent region under any transform: an axis-aligned
                // design box of a ROTATED hole rect could claim painted pixels, so only record it when the global is
                // axis-aligned (no rotation/skew — the UI chrome cases the hole exists for).
                if (Mathf.IsZeroApprox(gt.X.Y) && Mathf.IsZeroApprox(gt.Y.X))
                {
                    _blockerArtHoles[view.NodeId] = DesignAabbOf(gt, hp);
                }
            }
        }
    }

    // Refresh the CardLayer root-verdict sets and hand the planner its current geometry options.
    private TextOverlayOptions BuildPlannerOptions()
    {
        _cardPromotedRoots.Clear();
        _cardKnownRoots.Clear();
        _reconciler.CollectCardRootSets(_cardPromotedRoots, _cardKnownRoots);
        return _plannerOptions ??= new TextOverlayOptions
        {
            CardPromotedRoots = _cardPromotedRoots,
            CardKnownRoots = _cardKnownRoots,
            BlockerArtExtents = _blockerArt,
            BlockerArtHoles = _blockerArtHoles,
            TextBlockerExtents = _textBlockerExtents,
        };
    }

    // The design-space AABB of a view-local Rect2 under a global affine — the four transformed corners' min/max (so a
    // rotated/scaled label is bounded exactly). Mirrors CullBounds.OfRect / DumpRectLines' corner transform.
    private static DesignAabb DesignAabbOf(Transform2D gt, Rect2 local)
    {
        Vector2 p = local.Position;
        Vector2 s = local.Size;
        Vector2 c0 = gt * p;
        Vector2 c1 = gt * (p + new Vector2(s.X, 0));
        Vector2 c2 = gt * (p + new Vector2(0, s.Y));
        Vector2 c3 = gt * (p + s);
        float minX = Mathf.Min(Mathf.Min(c0.X, c1.X), Mathf.Min(c2.X, c3.X));
        float minY = Mathf.Min(Mathf.Min(c0.Y, c1.Y), Mathf.Min(c2.Y, c3.Y));
        float maxX = Mathf.Max(Mathf.Max(c0.X, c1.X), Mathf.Max(c2.X, c3.X));
        float maxY = Mathf.Max(Mathf.Max(c0.Y, c1.Y), Mathf.Max(c2.Y, c3.Y));
        return new DesignAabb(minX, minY, maxX, maxY);
    }

    // ---- shot settle / telemetry --------------------------------------------------------------------------------

    // AppShell.MaybeCapture ANDs this in. Inert (not Active) → always settled (the OFF / Full shot is unaffected).
    // Active → wait until an idle-asset eval has run this scene, so the ON shot is provably non-vacuous.
    public bool IsShotSettled => !_active || _evaluatedThisScene;

    // One machine-readable status token for the M1C_SHOT line (proves the ON parity run actually promoted labels).
    public string ShotStatus() =>
        $"textOverlay[active={_active} promoted={_proxies.Count} evaluated={_planner.LastEvaluated} " +
        $"measured={_planner.LastMeasured}]";

    // WS-CRISP dumpcrisp: run a fresh per-id-capture Plan over the CURRENT state, then report every evaluated text
    // candidate's first-fail reject (None = promotable) + the occluding blocker id when Occluded. This is the capture
    // surface that decides the R18 sort-button (Clip vs Effect) and R19-relic (measured-Occluded vs unmeasured) fixes:
    // read the reject each label ACTUALLY hits instead of guessing. Zero cost to normal play (CaptureRejects is off
    // outside this call). Returns "off"-shaped JSON when inert. Diagnostic only — mutates no proxy.
    public JsonObject DumpCrispJson()
    {
        if (!_active)
        {
            return new JsonObject { ["active"] = false, ["reason"] = "inactive" };
        }

        if (_indexDirty)
        {
            _planner.RebuildIndex(_store.State);
            _indexDirty = false;
        }

        _excluded.Clear();
        _boundedCosmetic.Clear();
        _reconciler.CollectBakeExcluded(_excluded, _boundedCosmetic);
        _reconciler.CollectCardPromoted(_excluded);
        _transformOwned.Clear();
        TweenReplayer.CollectTransformOwned(_transformOwned);
        RefreshMeasurements();
        bool excludeCards = _reconciler.CardLayerActive;

        _planner.CaptureRejects = true;
        try
        {
            _planner.Plan(
                _store.State, _store.Transforms, _store.SpreadFactor, _spreadDxOf, _excluded, _transformOwned,
                _boundedCosmetic, _measured, excludeCards, BuildPlannerOptions(),
                _spreadWidthOf, CollectFadeIn());
        }
        finally
        {
            _planner.CaptureRejects = false;
        }

        var arr = new JsonArray();
        foreach (var (id, reject) in _planner.LastRejectById)
        {
            string? name = _store.State.Nodes.TryGetValue(id, out var n) ? n.Name : null;
            var entry = new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["reject"] = reject.ToString(),
                ["measured"] = _measured.ContainsKey(id),
            };
            if (reject == TextOverlayPlanner.TextReject.Occluded
                && _planner.LastCulpritById.TryGetValue(id, out var culprit) && culprit is not null)
            {
                entry["culprit"] = culprit;
                entry["culpritName"] = _store.State.Nodes.TryGetValue(culprit, out var cn) ? cn.Name : null;
            }

            arr.Add(entry);
        }

        return new JsonObject
        {
            ["active"] = true,
            ["evaluated"] = _planner.LastEvaluated,
            ["promoted"] = _proxies.Count,
            ["measured"] = _planner.LastMeasured,
            ["hist"] = RejectHistogram(),
            ["candidates"] = arr,
        };
    }

    // The dominant reject reason from the last plan.
    public string TopReject()
    {
        var top = TextOverlayPlanner.TextReject.None;
        int best = -1;
        foreach (var (reason, count) in _planner.LastRejectHistogram)
        {
            if (count > best)
            {
                best = count;
                top = reason;
            }
        }

        return best <= 0 ? "none" : $"{top}={best}";
    }

    // The full reject histogram as a compact "Reason=N Reason=N" string (BENCH_RESULT / soak diagnostics).
    public string RejectHistogram()
    {
        if (_planner.LastRejectHistogram.Count == 0)
        {
            return "none";
        }

        var parts = new List<string>();
        foreach (var (reason, count) in _planner.LastRejectHistogram)
        {
            parts.Add($"{reason}={count}");
        }

        parts.Sort(System.StringComparer.Ordinal);
        return string.Join(" ", parts);
    }

    private int _lastLoggedPromoted = -1;
    private long _lastLoggedChurnSum = -1;

    private void LogOutcome(TextOverlayPlan plan)
    {
        // Print on a promoted-count change OR a build/revive/demote advance (so steady-count churn is still visible for
        // the idle-combat soak). Quiet when the outcome AND the transition totals are both unchanged.
        long churnSum = BuildTotal + ReviveTotal + DemoteTotal;
        if (plan.Items.Count == _lastLoggedPromoted && churnSum == _lastLoggedChurnSum)
        {
            return;
        }

        _lastLoggedPromoted = plan.Items.Count;
        _lastLoggedChurnSum = churnSum;
        GD.Print($"M3_TEXTOVL: promoted={plan.Items.Count} parked={_parked.Count} evaluated={_planner.LastEvaluated} " +
                 $"measured={_planner.LastMeasured}/{_planner.LastEvaluated} " +
                 $"topReject={TopReject()} hist=[{RejectHistogram()}] builds={BuildTotal} revives={ReviveTotal} " +
                 $"demotes={DemoteTotal} transitions={TransitionsTotal} visDemotes={VisibleDemoteTotal} " +
                 $"visTransitions={VisibleTransitionsTotal} churnSuppressed={ChurnSuppressed}");
    }

    // env-gated (COUCHCOOP_MIRROR_TEXTRECTS=1): one line per promoted label with its DESIGN-space rect (the AABB of
    // the label's box under the holder's global transform) so the crop verification can slice exactly that region from
    // a Half+ON shot and a Full shot and pixel-compare the text.
    private void DumpRectLines(TextOverlayPlan plan)
    {
        GD.Print($"M3_TEXT_RECTS_BEGIN count={plan.Items.Count}");
        foreach (var item in plan.Items)
        {
            if (!_proxies.TryGetValue(item.Id, out var px) || !GodotObject.IsInstanceValid(px.Holder))
            {
                continue;
            }

            var gt = px.Holder.GetGlobalTransform();
            var pos = px.Label.Position;
            var size = px.Label.Size;
            // AABB of the four transformed corners of the label's local box.
            Vector2[] corners =
            {
                gt * pos,
                gt * (pos + new Vector2(size.X, 0)),
                gt * (pos + new Vector2(0, size.Y)),
                gt * (pos + size),
            };
            float minX = corners[0].X, minY = corners[0].Y, maxX = corners[0].X, maxY = corners[0].Y;
            for (int i = 1; i < 4; i++)
            {
                minX = Mathf.Min(minX, corners[i].X);
                minY = Mathf.Min(minY, corners[i].Y);
                maxX = Mathf.Max(maxX, corners[i].X);
                maxY = Mathf.Max(maxY, corners[i].Y);
            }

            GD.Print($"M3_TEXT_RECT id={item.Id} x={minX:0} y={minY:0} w={maxX - minX:0} h={maxY - minY:0}");
        }

        GD.Print("M3_TEXT_RECTS_END");
    }

    // Track-ST: env-gated one line per promote/revive/demote transition, carrying the node NAME so a soak can bucket
    // the TopBar HP/gold labels vs the rest (the before/after headline metric). Null-cost when the flag is off.
    private void Trace(string op, string id)
    {
        if (!TransDebug)
        {
            return;
        }

        string name = _store.State.Nodes.TryGetValue(id, out var n) ? n.Name : "?";
        GD.Print($"M3_TEXTOVL_TRANS: op={op} id={id} name='{name}' rev={_store.Revision}");
    }

    private static string Sanitize(string id)
    {
        var sb = new System.Text.StringBuilder(id.Length);
        foreach (char c in id)
        {
            sb.Append(char.IsLetterOrDigit(c) ? c : '_');
        }

        return sb.ToString();
    }
}
