namespace CouchCoop.MirrorProtocol.SceneModel;

// 1:1 C# port of the delta-application half of frontend/src/mirror/sceneTree.ts: applySceneDelta (full-keyframe
// reset → removals → upserts → order), mergeNode's static-vs-volatile merge, the intent frame-0 override, and the
// Stage 4 order-patch rebuild (buildOrderStructure + pre-order DFS flatten). The retained node map is patched IN
// PLACE so reacting to a frame is O(changed nodes).
public static class SceneTreeApplier
{
    // The game's BASE design resolution (see sceneTree.ts). MirrorView derives the real design size from the live
    // root but never below these, scaling-to-fit/letterboxing around it; rects are in that design space.
    public const int MirrorDesignWidth = 1920;
    public const int MirrorDesignHeight = 1080;

    // The widest the stage stretches before letterboxing again (~1.066x, e.g. 21:9 ultrawide / tall phones sideways).
    public const int MirrorMaxDesignWidth = 2520;

    // Apply a delta to the retained map in place. Static fields merge forward; a full keyframe resets the tree.
    public static void ApplySceneDelta(MirrorState state, MirrorDelta delta)
    {
        if (delta.Full)
        {
            state.Nodes.Clear();
            state.OrderedIds = [];
        }

        foreach (var id in delta.RemovedIds)
        {
            state.Nodes.Remove(id);
            state.ChangedIds.Add(id);
            AccumulateFlags(state, id, NodeChangeFlags.Removed);
        }

        foreach (var upsert in delta.Upserts)
        {
            NodeChangeFlags flags;
            if (state.Nodes.TryGetValue(upsert.Id, out var existing))
            {
                // WS-P2: MergeNode has old + new in hand — classify what actually changed (purely additive; the merged
                // node it returns is byte-identical to before, so replay parity is untouched).
                var merged = MergeNode(existing, upsert);
                state.Nodes[upsert.Id] = merged;
                flags = NodeChangeDiffer.Classify(existing, merged, upsert);
            }
            else
            {
                state.Nodes[upsert.Id] = upsert;
                flags = NodeChangeFlags.New | NodeChangeDiffer.StructuralAll;
            }

            state.ChangedIds.Add(upsert.Id);
            AccumulateFlags(state, upsert.Id, flags);
        }

        // Order: a full orderedIds array replaces it wholesale; a Stage 4 patch is applied to
        // the structure rebuilt from the PREVIOUS orderedIds + the now-current node map, then pre-order flattened.
        if (delta.OrderedIds is not null)
        {
            state.OrderedIds = [.. delta.OrderedIds];
        }
        else if (delta.OrderPatch is not null)
        {
            state.OrderedIds = ApplyOrderPatch(state, delta.OrderPatch);
        }

        if (delta.Hints.Count > 0)
        {
            state.PendingHints.AddRange(delta.Hints);
            // Safety valve: bound it so a consumer that isn't wired yet can't grow it without limit — hints are
            // one-shot, so dropping the oldest is harmless.
            if (state.PendingHints.Count > 256)
            {
                state.PendingHints.RemoveRange(0, state.PendingHints.Count - 256);
            }
        }

        // WS-3 card flights: same one-shot accumulate + bounded valve as the tween hints above. The bound is smaller
        // because a flight is one per SHUFFLED CARD (a full reshuffle is tens, not hundreds) and a dropped flight
        // leaves its node frozen for its window rather than merely un-eased — so an unbounded backlog would be worse
        // here, not better.
        if (delta.CardFlights.Count > 0)
        {
            state.PendingCardFlights.AddRange(delta.CardFlights);
            if (state.PendingCardFlights.Count > 64)
            {
                state.PendingCardFlights.RemoveRange(0, state.PendingCardFlights.Count - 64);
            }
        }

        state.ScreenType = delta.ScreenType;
        state.Revision += 1;
    }

    // WS-P2: OR-merge a node's change flags into the drain's accumulator (a node can be touched by several deltas in
    // one drain — e.g. a move then a recolor).
    private static void AccumulateFlags(MirrorState state, string id, NodeChangeFlags flags)
    {
        state.ChangeFlags[id] = state.ChangeFlags.TryGetValue(id, out var prev) ? prev | flags : flags;
    }

    // A non-empty Name marks an upsert that carries the static block (add/keyframe). A volatile-only upsert (empty
    // name) keeps the retained node's static styling.
    public static MirrorNode MergeNode(MirrorNode existing, MirrorNode upsert)
    {
        if (upsert.Name.Length > 0)
        {
            return upsert;
        }

        // IntentFrames is STICKY: carry the retained set forward on a volatile-only upsert, but let a fresh non-null
        // upsert replace it. Then re-apply the frame-0 texture override.
        var intentFrames = upsert.IntentFrames ?? existing.IntentFrames;
        // The Line2D stroke unit is STICKY on the SAME policy (see MirrorNode.LinePoints): the producer re-ships
        // points/width/colour only when the stroke's signature changed, so a volatile-only upsert carries null for
        // all three and must keep the retained geometry. Mandatory, not an optimisation: a dormant/occluded stroke
        // repaints from the RETAINED points when it is revealed, and a dropped carry-forward would erase every
        // finished stroke on the map one tick after it appeared. An EMPTY (not null) upsert list is a real
        // instruction ("cleared") and correctly wins over the retained one.
        var linePoints = upsert.LinePoints ?? existing.LinePoints;
        var lineWidth = upsert.LineWidth ?? existing.LineWidth;
        var lineColor = upsert.LineColor ?? existing.LineColor;

        var merged = upsert.Clone();
        merged.Name = existing.Name;
        merged.NodeType = existing.NodeType;
        merged.ShowBehindParent = existing.ShowBehindParent;
        merged.ClipChildren = existing.ClipChildren;
        merged.ClipContents = existing.ClipContents;
        merged.NinePatchMargins = existing.NinePatchMargins;
        merged.Font = existing.Font;
        // The per-role rich-text fonts (+ their sizes/glyph spacing) are STATIC exactly like `Font` — theme items
        // don't change at runtime, so the producer rides them on add/keyframe only. Dropping them here would lose a
        // rich label's bold face one tick after it appears (the ClipChildren/ParticleSpec lesson).
        merged.RichBoldFont = existing.RichBoldFont;
        merged.RichItalicFont = existing.RichItalicFont;
        merged.RichBoldItalicFont = existing.RichBoldItalicFont;
        merged.RichBoldFontSizePx = existing.RichBoldFontSizePx;
        merged.RichItalicFontSizePx = existing.RichItalicFontSizePx;
        merged.RichBoldItalicFontSizePx = existing.RichBoldItalicFontSizePx;
        merged.RichBoldFontSpacingPx = existing.RichBoldFontSpacingPx;
        merged.RichItalicFontSpacingPx = existing.RichItalicFontSpacingPx;
        merged.RichBoldItalicFontSpacingPx = existing.RichBoldItalicFontSpacingPx;
        // `Outline` is intentionally NOT retained: it's volatile (streamed every emission) so a runtime recolor
        // takes effect on a volatile-only upsert.
        merged.Shadow = existing.Shadow;
        merged.RichText = existing.RichText;
        merged.ShaderId = existing.ShaderId;
        merged.MaterialRef = existing.MaterialRef;
        // `ShaderParams` is NOT kept: it's volatile (uniforms refresh per tick).
        merged.TextureStretchMode = existing.TextureStretchMode;
        merged.TextureFlipH = existing.TextureFlipH;
        merged.TextureFlipV = existing.TextureFlipV;
        merged.CanvasBlendMode = existing.CanvasBlendMode;
        // `ParticleSpec` is STATIC; `ParticleEmitting`/`ParticleRestartEpoch` are volatile (ride the upsert).
        merged.ParticleSpec = existing.ParticleSpec;
        // Spine scene/node/anims + skeleton path are STATIC (the clip key); volatile SpineCurrentAnim/SpineTrackTime/
        // SpineSkin ride the upsert (clone above), so a per-tick skin change takes effect.
        merged.SpineSceneResPath = existing.SpineSceneResPath;
        merged.SpineNodePath = existing.SpineNodePath;
        merged.SpineAnimations = existing.SpineAnimations;
        merged.SpineSkelResPath = existing.SpineSkelResPath;
        merged.SceneFilePath = existing.SceneFilePath;
        merged.MouseFilter = existing.MouseFilter;
        merged.AnchorLeft = existing.AnchorLeft;
        merged.AnchorRight = existing.AnchorRight;
        merged.AnchorOwnerId = existing.AnchorOwnerId;
        // ContainerLayout (BoxContainer orientation + alignment) is STATIC — keep it across volatile-only upserts.
        merged.ContainerLayout = existing.ContainerLayout;
        merged.IntentFrames = intentFrames;
        merged.LinePoints = linePoints;
        merged.LineWidth = lineWidth;
        merged.LineColor = lineColor;
        return ApplyIntentFrame0(merged);
    }

    // When a node carries an intent frame set, force its textureUrl/textureRegion/textureMargin to frame 0 so the
    // atlas-canvas path paints the glyph. Idempotent no-op for nodes without intent frames. Mutates + returns node.
    public static MirrorNode ApplyIntentFrame0(MirrorNode node)
    {
        if (node.IntentFrames is { Frames.Count: > 0 } frames)
        {
            var frame0 = frames.Frames[0];
            node.TextureUrl = frame0.Url;
            node.TextureRegion = frame0.Region;
            node.TextureMargin = frame0.Margin;
        }

        return node;
    }

    // Build the (rootIds, childIdsByParent) structure for one draw order using the EXACT rules the renderer uses:
    // skip an id whose node isn't live, and an id is a child of its parent only when the parent is ALSO live.
    public static (List<string> RootIds, Dictionary<string, List<string>> ChildIdsByParent) BuildOrderStructure(
        IReadOnlyList<string> order,
        IReadOnlyDictionary<string, MirrorNode> nodes)
    {
        var childIdsByParent = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var rootIds = new List<string>();
        foreach (var id in order)
        {
            if (!nodes.TryGetValue(id, out var node))
            {
                continue;
            }

            if (node.ParentId is { } parentId && nodes.ContainsKey(parentId))
            {
                if (!childIdsByParent.TryGetValue(parentId, out var list))
                {
                    list = [];
                    childIdsByParent[parentId] = list;
                }

                list.Add(id);
            }
            else
            {
                rootIds.Add(id);
            }
        }

        return (rootIds, childIdsByParent);
    }

    // Pre-order DFS flatten of (rootIds, childIdsByParent) → the draw order (byte-identical to the server's).
    public static List<string> FlattenOrder(IReadOnlyList<string> rootIds, IReadOnlyDictionary<string, List<string>> childIdsByParent)
    {
        var output = new List<string>();
        var stack = new Stack<string>();
        for (var i = rootIds.Count - 1; i >= 0; i--)
        {
            stack.Push(rootIds[i]);
        }

        while (stack.Count > 0)
        {
            var id = stack.Pop();
            output.Add(id);
            if (childIdsByParent.TryGetValue(id, out var kids))
            {
                for (var i = kids.Count - 1; i >= 0; i--)
                {
                    stack.Push(kids[i]);
                }
            }
        }

        return output;
    }

    // Apply a Stage 4 order patch: rebuild the base structure from the previous orderedIds + current nodes,
    // overwrite each dirty parent's child list (and the roots when the patch carries them), then flatten.
    private static List<string> ApplyOrderPatch(MirrorState state, MirrorOrderPatch patch)
    {
        var (rootIds, childIdsByParent) = BuildOrderStructure(state.OrderedIds, state.Nodes);
        foreach (var parent in patch.Parents)
        {
            childIdsByParent[parent.P] = [.. parent.C];
        }

        return FlattenOrder(patch.Roots ?? rootIds, childIdsByParent);
    }

}
