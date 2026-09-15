using CouchCoop.Mod.Runtime;
using CouchCoop.Mod.Session;
using Spirectl.Sts2.Core.SceneInspection;
using Spirectl.Sts2.Embedding;

namespace CouchCoop.Mod.Server;

// Subscribes ONCE to spirectl's live scene-DELTA watch and (a) re-broadcasts each delta to all connected
// mirror clients and (b) keeps a RETAINED full map so a newly-connected client can be sent a Full keyframe
// before it starts receiving incremental deltas. The watch's callback fires on a BACKGROUND thread; the
// retained map is lock-guarded. When the scene-watch capability is unsupported the observer never
// subscribes (no broadcast).
//
// Deliberately a separate type from CouchCoopStateObserver: the mirror path shares no state with the
// semantic reconstruction path, so either can be deleted independently.
public sealed class CouchCoopSceneObserver(CouchCoopRuntimeHost runtimeHost) : IDisposable
{
    private readonly CouchCoopRuntimeHost _runtimeHost = runtimeHost ?? throw new ArgumentNullException(nameof(runtimeHost));
    private readonly object _gate = new();
    private readonly Dictionary<string, RuntimeSceneNodeDelta> _nodes = [];
    private List<string> _orderedIds = [];
    private string _screenType = "unknown";
    private string _screenInstanceId = "screen:unknown:live";
    private const string LocalTransformSpace = "local";
    private IDisposable? _subscription;

    // Raised (on a background thread) for every live scene delta — fanned out verbatim to all clients.
    public event Action<RuntimeSceneDelta>? SceneDeltaChanged;

    public void Start()
    {
        lock (_gate)
        {
            if (_subscription is not null || !_runtimeHost.HasCapability(CouchCoopRuntimeHost.SceneCapability))
            {
                return;
            }

            _subscription = _runtimeHost.SubscribeRuntimeSceneDelta(
                new RuntimeSceneSubscriptionRequest(),
                OnDelta);
        }
    }

    private void OnDelta(RuntimeSceneDelta delta)
    {
        if (!string.Equals(delta.TransformSpace, LocalTransformSpace, StringComparison.Ordinal))
        {
            Console.Error.WriteLine("[couchcoop] rejected scene delta without local transforms.");
            return;
        }

        lock (_gate)
        {
            Apply(delta);
        }

        // An emitted delta means the game visibly changed (idle spine/particle loops emit NONE — track time is
        // volatile and out of the producer's change signature), so it's the activity signal that resumes a
        // headless client's idle-suspended simulation. Runs on a background
        // thread; Mark() is a lock-free Volatile write.
        HeadlessIdleActivity.Mark();

        SceneDeltaChanged?.Invoke(delta);
    }

    // Maintain the retained map so BuildKeyframe can reconstruct the current full scene for a new client.
    // Merge static fields forward — name/type AND the styling block ride only on add/keyframe, so a later
    // volatile-only upsert (signalled by a null Name) must not erase them. When the upsert carries static
    // (Name present) it replaces the whole node.
    private void Apply(RuntimeSceneDelta delta)
    {
        if (delta.Full)
        {
            _nodes.Clear();
            _orderedIds = [];
        }

        foreach (var removedId in delta.RemovedIds)
        {
            _nodes.Remove(removedId);
        }

        foreach (var upsert in delta.Upserts)
        {
            _nodes[upsert.Id] = _nodes.TryGetValue(upsert.Id, out var existing) && upsert.Name is null
                ? MergeVolatile(existing, upsert)
                : upsert;
        }

        if (delta.OrderedIds is not null)
        {
            _orderedIds = [.. delta.OrderedIds];
        }

        _screenType = delta.ScreenType;
        _screenInstanceId = delta.ScreenInstanceId;
    }

    // Merge a volatile-only upsert (null Name) onto the retained node: the fresh upsert carries every VOLATILE
    // field, while the STATIC styling block is kept from `existing` — those ride add/keyframe only, so erasing
    // them on a per-tick emission would drop the node's style. The kept set MUST mirror the producer's
    // includeStatic-gated fields in BuildNodeDelta (Sts2RuntimeSceneWatcher); a field missing here silently
    // vanishes one tick after a node appears (the ClipChildren / ParticleSpec / Spine lessons).
    internal static RuntimeSceneNodeDelta MergeVolatile(RuntimeSceneNodeDelta existing, RuntimeSceneNodeDelta upsert)
        => upsert with
        {
            Name = existing.Name,
            NodeType = existing.NodeType,
            ShowBehindParent = existing.ShowBehindParent,
            ClipChildren = existing.ClipChildren,
            // Control.clip_contents is STATIC too (producer gates it to add/keyframe) — keep it, or a clipping
            // container stops clipping one tick after it appears and its parked content pops into view.
            ClipContents = existing.ClipContents,
            // Control anchor fractions are STATIC (producer gates them to add/keyframe) — keep them across
            // volatile-only upserts, or the mirror loses its wide-screen re-layout data one tick after a node
            // appears (same lesson as ClipChildren/ParticleSpec). Null for non-Control nodes.
            AnchorLeft = existing.AnchorLeft,
            AnchorRight = existing.AnchorRight,
            // AnchorOwnerId is STATIC too (an owner-anchored floater's owner id, add/keyframe only) — keep it, or
            // the tooltip loses its owner one tick after it appears and reverts to the un-shifted native position.
            AnchorOwnerId = existing.AnchorOwnerId,
            // ContainerLayout (BoxContainer orientation + alignment) is STATIC — keep it across volatile-only upserts
            // or the wide-screen container re-layout data vanishes one tick after the container appears.
            ContainerLayout = existing.ContainerLayout,
            NinePatchMargins = existing.NinePatchMargins,
            Font = existing.Font,
            FontWeight = existing.FontWeight,
            FontStyle = existing.FontStyle,
            // The PER-ROLE rich-text fonts (+ their theme sizes / glyph spacing) are STATIC exactly like Font — the
            // producer gates them to add/keyframe because theme items don't change at runtime — so a volatile-only
            // upsert must KEEP the retained ones. Without this a rich label's `[b]` face would vanish one tick after
            // the node appears and the span would fall back to the label's own single-weight font (the very bug the
            // fields were added for), and the ToVolatile projection derived from this list would stop dropping them.
            RichBoldFont = existing.RichBoldFont,
            RichItalicFont = existing.RichItalicFont,
            RichBoldItalicFont = existing.RichBoldItalicFont,
            RichBoldFontSizePx = existing.RichBoldFontSizePx,
            RichItalicFontSizePx = existing.RichItalicFontSizePx,
            RichBoldItalicFontSizePx = existing.RichBoldItalicFontSizePx,
            RichBoldFontSpacingPx = existing.RichBoldFontSpacingPx,
            RichItalicFontSpacingPx = existing.RichItalicFontSpacingPx,
            RichBoldItalicFontSpacingPx = existing.RichBoldItalicFontSpacingPx,
            OutlineColor = existing.OutlineColor,
            OutlineSize = existing.OutlineSize,
            Shadow = existing.Shadow,
            RichText = existing.RichText,
            Material = existing.Material,
            Shader = existing.Shader,
            // MouseFilter + SceneFilePath are STATIC (producer gates them to add/keyframe) — keep them across
            // volatile-only upserts, or they vanish one tick after a node appears. MouseFilter drives the mirror's
            // pointer-events (non-interactive overlays → pointer-events:none so a full-screen transparent transition
            // rect stops eating hover/click on the widgets beneath it); SceneFilePath drives touch scene-targeting.
            MouseFilter = existing.MouseFilter,
            SceneFilePath = existing.SceneFilePath,
            // ContentKey (the pooled card's `nc:{entry}#{serial}` content identity) is STATIC — the producer emits
            // it with the static block only, so a volatile-only upsert must KEEP the retained one or a card node
            // loses its identity one tick after it appears (the ClipChildren/ParticleSpec lesson). A node whose
            // POOLED shell is re-assigned to another card arrives as a static payload (non-null Name), which
            // bypasses this merge entirely and replaces the whole node — so a re-assignment's new key wins.
            ContentKey = existing.ContentKey,
            // ShaderParameters is NOT kept here: it's volatile (numeric uniforms refresh per tick for
            // animating shaders like transitions), so a volatile-only upsert carries the fresh values.
            TextureStretchMode = existing.TextureStretchMode,
            TextureFlipH = existing.TextureFlipH,
            TextureFlipV = existing.TextureFlipV,
            CanvasBlendMode = existing.CanvasBlendMode,
            // ParticleSpec is STATIC (rides add/keyframe only) — keep it across volatile-only upserts or
            // it vanishes on the first per-tick emission. ParticleEmitting/ParticleRestartEpoch are
            // volatile and intentionally NOT kept (the fresh upsert carries them).
            ParticleSpec = existing.ParticleSpec,
            // Spine canonical address + animation list are STATIC (add/keyframe only) — keep them, same as
            // ParticleSpec, or the SpineSprite's clip identity vanishes on the first per-tick emission (and the
            // browser then sees a named, spine-less node and drops the clip). SpineCurrentAnim / SpineTrackTime
            // are VOLATILE and intentionally NOT kept (the fresh upsert carries them).
            Spine = existing.Spine,
            // IntentFrames is STICKY: the producer re-ships the enemy-intent glyph frame set ONLY on keyframe/add
            // or an intent-animation change, so a plain volatile-only upsert carries null — keep the retained set
            // then, but let a fresh non-null upsert (the intent just changed) REPLACE it. Same "carry-forward
            // unless the upsert supplies a new one" shape the client's mergeNode uses. Without this the glyph's
            // animation frames vanish one tick after the intent change and the icon reverts to a single texture.
            IntentFrames = upsert.IntentFrames ?? existing.IntentFrames,
            // The Line2D stroke unit (map quill annotations) is STICKY on the SAME policy as IntentFrames: the
            // producer computes only a cheap per-tick signature and re-ships points/width/colour as ONE unit when
            // that signature changed (or on add/keyframe), carrying null in between. Keep the retained values then,
            // but let a fresh non-null upsert REPLACE them. Without this every finished stroke on the map would go
            // blank one tick after it appeared. An EMPTY (not null) LinePoints is a real instruction — the stroke
            // was cleared (undo / clear-all) — and correctly wins over the retained array.
            LinePoints = upsert.LinePoints ?? existing.LinePoints,
            LineWidth = upsert.LineWidth ?? existing.LineWidth,
            LineColor = upsert.LineColor ?? existing.LineColor,
            // Godot's own line breaking for this label. STICKY on the IntentFrames/LinePoints policy rather than
            // plain-static, and the five fields ride as ONE unit: the producer computes them on the static path,
            // so a volatile-only upsert carries null and the retained wrap must survive — but a fresh non-null
            // upsert (the label was re-described, possibly with different words) must REPLACE the whole set.
            //
            // Merging them FIELD-WISE would be the bug here. A retained hash next to fresh ranges, or vice versa,
            // is a block that validates against a string it does not describe — which is precisely the stale-wrap
            // wrong-words failure the hash exists to catch, reintroduced by the merge that was supposed to be
            // carrying it safely. So the presence of `TextLineRanges` decides all five together.
            TextLineRanges = upsert.TextLineRanges ?? existing.TextLineRanges,
            TextLineBasis = upsert.TextLineRanges is not null ? upsert.TextLineBasis : existing.TextLineBasis,
            TextParsedText = upsert.TextLineRanges is not null ? upsert.TextParsedText : existing.TextParsedText,
            TextLineSourceLength =
                upsert.TextLineRanges is not null ? upsert.TextLineSourceLength : existing.TextLineSourceLength,
            TextLineSourceHash =
                upsert.TextLineRanges is not null ? upsert.TextLineSourceHash : existing.TextLineSourceHash,
        };

    // An all-static-null template. MergeVolatile(existing, upsert) keeps the STATIC block from `existing`, so
    // MergeVolatile(EmptyStatic, node) yields `node` with every static field NULLED — i.e. the VOLATILE projection
    // — derived FROM the merge list itself so the two can never drift (a field the merge keeps static is the exact
    // field the projection drops). Id/volatile placeholders are irrelevant (overwritten by `node`'s values).
    private static readonly RuntimeSceneNodeDelta EmptyStatic = new(
        Id: string.Empty, ParentId: null, Name: null, NodeType: null, Rect: null,
        Visible: false, Opacity: 0, ZIndex: null, Rotation: 0, Texture: null, NinePatch: false, Text: null);

    // Project a retained node DOWN to the lean volatile-only upsert the producer would have emitted for a per-tick
    // change: static fields nulled (the client keeps its retained statics via mergeNode), volatile fields carried.
    // Derived from MergeVolatile so the kept/dropped split is single-sourced, then two corrections:
    //   1. OutlineColor/OutlineSize are producer-VOLATILE but MergeVolatile keeps them static (a retained-map
    //      quirk) — restore the retained value so the projection matches a real producer volatile-only upsert
    //      (the client's mergeNode treats outline as volatile and takes it from the upsert).
    //   2. IntentFrames are STICKY — include the retained set ONLY when it changed this window (`intentDirty`);
    //      otherwise null so the client carries its own retained set forward (matching the producer's re-ship policy).
    //   3. The Line2D stroke unit (LinePoints/LineWidth/LineColor) is STICKY the same way, gated on `lineDirty`.
    //      This gate is what keeps an IDLE map free: the retained map re-inflates every finished stroke's full
    //      point array, so without it every per-tick projection of a map node would re-ship kilobytes of unchanged
    //      geometry the client already holds. All three ride together (the producer emits them as one unit).
    internal static RuntimeSceneNodeDelta ToVolatile(RuntimeSceneNodeDelta node, bool intentDirty, bool lineDirty)
        => MergeVolatile(EmptyStatic, node) with
        {
            OutlineColor = node.OutlineColor,
            OutlineSize = node.OutlineSize,
            IntentFrames = intentDirty ? node.IntentFrames : null,
            LinePoints = lineDirty ? node.LinePoints : null,
            LineWidth = lineDirty ? node.LineWidth : null,
            LineColor = lineDirty ? node.LineColor : null,
        };

    // Resolve a batch of accumulated pending ids to the node deltas to send: a FULL retained snapshot for ids that
    // need the static block (fresh add/keyframe), a lean VOLATILE projection otherwise. One lock acquisition for the
    // whole batch. Skips ids no longer live. Used by a connection's coalescing sender at send time so the delta
    // carries fresh nodes (never a stale intermediate) and stays light, without re-implementing the merge here.
    public IReadOnlyList<RuntimeSceneNodeDelta> ResolveUpserts(IReadOnlyList<PendingUpsertRequest> requests)
    {
        if (requests.Count == 0)
        {
            return [];
        }

        lock (_gate)
        {
            var nodes = new List<RuntimeSceneNodeDelta>(requests.Count);
            foreach (var request in requests)
            {
                if (_nodes.TryGetValue(request.Id, out var node))
                {
                    nodes.Add(request.NeedsStatic ? node : ToVolatile(node, request.IntentDirty, request.LineDirty));
                }
            }

            return nodes;
        }
    }

    // Build the parent→children / roots structure index for one draw order, MIRRORING the client's
    // rebuildStructure (mirrorRenderer.ts) and applySceneDelta order build: skip an id whose node isn't live, and
    // an id is a child of its parent only when the parent is ALSO a live node (else it's a root). Both the
    // last-sent and new orders are indexed under ONE lock so the Stage 4 diff sees a single, consistent node-map
    // snapshot. Used by the coalescer to compute an order patch. `newOrder` may be null (no structural change).
    public (SceneStructureIndex Old, SceneStructureIndex New) BuildStructureIndexes(
        IReadOnlyList<string> oldOrder,
        IReadOnlyList<string> newOrder)
    {
        lock (_gate)
        {
            return (BuildStructureIndexLocked(oldOrder), BuildStructureIndexLocked(newOrder));
        }
    }

    private SceneStructureIndex BuildStructureIndexLocked(IReadOnlyList<string> order)
    {
        var rootIds = new List<string>();
        var childIdsByParent = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var lists = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var id in order)
        {
            if (!_nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            if (node.ParentId is { } parentId && _nodes.ContainsKey(parentId))
            {
                if (!lists.TryGetValue(parentId, out var list))
                {
                    list = [];
                    lists[parentId] = list;
                    childIdsByParent[parentId] = list;
                }

                list.Add(id);
            }
            else
            {
                rootIds.Add(id);
            }
        }

        return new SceneStructureIndex { RootIds = rootIds, ChildIdsByParent = childIdsByParent };
    }

    // R10 KEYFRAME SELF-CONSISTENCY.
    // A keyframe's OrderedIds must name only nodes the keyframe actually CARRIES. It could not, historically: the
    // producer's order array included nodes it had never emitted (a subtree born hidden is registered but pruned
    // from every incremental capture), so the retained order held ids with no retained node — this method dropped
    // them from `Upserts` and shipped them in `OrderedIds` anyway. Two consequences, both real:
    //   * the connection's order baseline (SceneDeltaCoalescer._lastSentOrder) then disagreed with what the client
    //     could actually build, so SceneOrderDiff's self-verification failed and EVERY structural send fell back to
    //     the full ~52KB array instead of a compact patch;
    //   * more importantly the id was ALREADY in the client's order when the node finally emitted, so that emit
    //     carried no order change — and `state.orderedIds !== lastOrderedIds` is the client's ONLY structural-walk
    //     trigger, so the node was merged into the map and never placed in the tree.
    // spirectl's producer now withholds unemitted ids from OrderedIds (SPIRECTL_SCENE_WATCH_ORDER_EMITTED_ONLY), so
    // this filter is normally a no-op — it is the host-side guard that keeps the invariant true regardless of which
    // producer version is embedded. Fabricating stubs is deliberately NOT the alternative: the host knows nothing
    // about an id it never received (not even its parent), so a stub would enter the tree as a nameless orphan ROOT.
    // A Full keyframe of the current retained scene, or null if nothing has been observed yet. Sent to a
    // client on connect so it has the complete tree before incremental deltas arrive.
    public RuntimeSceneDelta? BuildKeyframe()
    {
        lock (_gate)
        {
            if (_nodes.Count == 0 && _orderedIds.Count == 0)
            {
                return null;
            }

            var (upserts, orderedIds) = BuildKeyframeContents(_orderedIds, _nodes);

            return new RuntimeSceneDelta(
                Full: true,
                ScreenType: _screenType,
                ScreenInstanceId: _screenInstanceId,
                Upserts: upserts,
                RemovedIds: [],
                OrderedIds: orderedIds);
        }
    }

    /// <summary>
    /// The (upserts, orderedIds) pair a keyframe should carry for one retained (order, node map) snapshot. Pure, so
    /// the invariant "every id in OrderedIds has a node in Upserts" is offline-unit-testable without a runtime host.
    /// </summary>
    internal static (List<RuntimeSceneNodeDelta> Upserts, List<string> OrderedIds) BuildKeyframeContents(
        IReadOnlyList<string> orderedIds,
        IReadOnlyDictionary<string, RuntimeSceneNodeDelta> nodes)
    {
        var upserts = new List<RuntimeSceneNodeDelta>(orderedIds.Count);
        var order = new List<string>(orderedIds.Count);
        foreach (var id in orderedIds)
        {
            if (nodes.TryGetValue(id, out var node))
            {
                upserts.Add(node);
                order.Add(id);
            }
        }

        return (upserts, order);
    }

    public void Dispose()
    {
        IDisposable? subscription;
        lock (_gate)
        {
            subscription = _subscription;
            _subscription = null;
        }

        subscription?.Dispose();
    }
}
