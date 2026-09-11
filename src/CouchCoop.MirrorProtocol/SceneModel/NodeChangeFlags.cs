using System;
using System.Collections.Generic;

namespace CouchCoop.MirrorProtocol.SceneModel;

// WS-P2 per-node change classification. SceneTreeApplier.ApplySceneDelta accumulates one of these per changed node
// (OR-merged across a drain's deltas, keyed in MirrorState.ChangeFlags) so the reconciler can take a LIGHT apply
// (transform/tint only) for an EXISTING view whose change set is a subset of Transform|Tint — skipping the full
// Apply's MaterialResolver / ResolveTexture / five effect Syncs / text sync / QueueRedraw. Anything heavier (a draw
// field, text, an effect, a static/structural change) keeps the full Apply.
//
// Bit flags so a node's changes OR together (a drain may move AND recolor a node in separate deltas).
[Flags]
public enum NodeChangeFlags
{
    None = 0,
    New = 1 << 0,       // a brand-new node (no retained entry) — always a full apply
    Static = 1 << 1,    // a static/structural field changed (name/type/parent/scene/anchors/mouseFilter) OR a
                        // static-bearing upsert re-sent the whole static block — full apply + identity-cache invalidate
    Transform = 1 << 2, // the local transform (+ redundant rotation/scale/pivot the matrix already encodes)
    Tint = 1 << 3,      // Visible / Opacity / Modulate / SelfModulate / ZIndex
    Draw = 1 << 4,      // texture / region / margins / nine-patch / fill / range / rect / localRect / outline / clip / blend
    Text = 1 << 5,      // text content or properties (font/shadow/rich)
    Effects = 1 << 6,   // particles / spine (excl. track-time) / shader id+params / intent frames
    Removed = 1 << 7,   // the node was removed this drain
    // R11: a pure atlas-FRAME swap — the TextureRegion crop changed to another SAME-SIZE region (a Sprite2D flip-book
    // frame, the Tezcatara candle flames) with NOTHING else drawn differently. Light-eligible (a re-crop of the same
    // texture needs only a QueueRedraw — MirrorNodeView.MarkRegionRedraw — not a full MaterialResolver/ResolveTexture
    // pass), and DELIBERATELY absent from SpreadIndex.WalkRelevant (a same-size region swap moves no spread input, so
    // a drain carrying only flame frames lets the wide-screen walk bail).
    Region = 1 << 8,
}

// The differ: classify what changed between a retained node and its merged upsert. Table-driven so the completeness
// guard (NodeChangeDifferTests) can reflect over MirrorNode's public properties and assert EVERY one is classified —
// a future wire field then cannot silently be treated as a no-change (and become light-eligible): it must be added
// to Rules (with a category + a comparer, or an explicit null comparer for a retained-static / ignored field).
//
// FAIL-CLOSED: the only categories that make a change light-eligible are Transform, Tint, and Region (Transform/Tint
// are exactly what ApplyLight rewrites; Region adds a same-size atlas re-crop, handled by the reconciler's
// MarkRegionRedraw at the light-apply sites — ApplyLight already refreshes `_node`, so the drawer re-samples the new
// crop with only a QueueRedraw). Every other field is classified into a heavier category (Draw/Text/Effects/Static)
// that forces the full Apply, so a mis-estimate can only ever be too conservative, never a dropped update.
public static class NodeChangeDiffer
{
    // R11 region-light fast path (client-set from COUCHCOOP_MIRROR_REGION_LIGHT in AppShell — MirrorProtocol stays
    // env-free). ON (default): a region↔region same-size swap classifies as the light-eligible Region flag. OFF:
    // Finalize remaps that Region bit to Draw, making the classification byte-identical to the pre-R11 single
    // TextureRegion→Draw rule (a full Apply per frame swap). The null↔non-null transition is ALWAYS Draw either way.

    // Everything a full Apply must cover — the flags for a new node (plus New) or a static-bearing re-upsert.
    public const NodeChangeFlags StructuralAll =
        NodeChangeFlags.Static | NodeChangeFlags.Transform | NodeChangeFlags.Tint |
        NodeChangeFlags.Draw | NodeChangeFlags.Text | NodeChangeFlags.Effects;

    // The light-eligible mask: a change set with ONLY these bits (or None) can take ApplyLight. Region joins
    // Transform/Tint (R11) — a same-size atlas re-crop rides the light path (ApplyLight refresh + MarkRegionRedraw).
    public const NodeChangeFlags LightMask = NodeChangeFlags.Transform | NodeChangeFlags.Tint | NodeChangeFlags.Region;

    // True when this change set can take the reconciler's light apply (only transform/tint bits set).
    public static bool IsLightEligible(NodeChangeFlags flags) => (flags & ~LightMask) == NodeChangeFlags.None;

    // Classify a merged volatile-only upsert (existing + merged in hand). A static-bearing upsert (upsert.Name set,
    // MergeNode returns it verbatim) re-declares the whole static block → treat as a full change. Otherwise diff the
    // fields that can actually differ on a volatile-only merge (the Rules with a non-null comparer).
    public static NodeChangeFlags Classify(MirrorNode existing, MirrorNode merged, MirrorNode upsert)
    {
        if (upsert.Name.Length > 0)
        {
            return StructuralAll;
        }

        NodeChangeFlags flags = NodeChangeFlags.None;
        foreach (var rule in Rules)
        {
            if (rule.Changed is { } cmp && cmp(existing, merged))
            {
                flags |= rule.Category;
            }
        }

        return Finalize(flags);
    }

    private static NodeChangeFlags Finalize(NodeChangeFlags flags) => flags;

    // Track-A keyframe diff. `prior` = the live view's last-applied node; `current` = the same id's node in the keyframe
    // -reset state. A keyframe re-sends every node's WHOLE static block, so — unlike Classify — this does NOT short-
    // circuit on a set Name; it value-compares EVERY field so an unchanged Reload node classifies as None (skip its
    // Apply), a transform/tint-only change classifies light-eligible (ApplyLight), and anything heavier forces the full
    // Apply. Retained-static fields use their KeyframeChanged comparer; the volatile fields reuse `Changed`. Same fail-
    // closed guarantee as Classify: the only light-eligible categories are Transform|Tint, so a mis-estimate is only ever
    // too conservative (a redundant full Apply), never a dropped update.
    public static NodeChangeFlags ClassifyKeyframe(MirrorNode prior, MirrorNode current)
    {
        NodeChangeFlags flags = NodeChangeFlags.None;
        foreach (var rule in Rules)
        {
            var cmp = rule.Changed ?? rule.KeyframeChanged;
            if (cmp is not null && cmp(prior, current))
            {
                flags |= rule.Category;
            }
        }

        return Finalize(flags);
    }

    // Every classified MirrorNode property name (the completeness guard checks this covers all public properties).
    // Lazily built on first access so it doesn't depend on static-field init order relative to `Rules` below.
    private static HashSet<string>? _classifiedNames;
    public static IReadOnlyCollection<string> ClassifiedNames => _classifiedNames ??= BuildNames();

    private static HashSet<string> BuildNames()
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in Rules)
        {
            set.Add(r.Name);
        }

        return set;
    }

    // One field's classification. `Changed` is non-null ONLY for fields that can differ on a volatile-only merge (the
    // volatile fields + the handful MergeNode does NOT retain: ParentId, Outline, ShaderParams, IntentFrames). A null
    // comparer means the field is retained-static (can't change without a static-bearing upsert → StructuralAll), an
    // identity key (Id), or DELIBERATELY IGNORED (SpineTrackTime — SpineLayer free-runs off the wall clock and never
    // reseeds on a track-time echo, so a bare track-time delta must stay light-eligible).
    //
    // `KeyframeChanged` is used ONLY by ClassifyKeyframe (the Track-A keyframe-diff path): a keyframe re-sends every
    // node's whole static block, so the retained-static fields (null `Changed`) CAN legitimately differ vs the live
    // view's prior node and must be value-compared there. It is null for the volatile / already-`Changed` rules (those
    // reuse `Changed`) and for the two never-diffed rules (Id / SpineTrackTime). Fail-closed: a list-bearing field a
    // comparer cannot cheaply value-compare (ParticleSpec record-eq, ShaderParams/IntentFrames ref-eq) errs toward
    // "changed" — a redundant full Apply, never a dropped update.
    private readonly record struct FieldRule(
        string Name,
        NodeChangeFlags Category,
        Func<MirrorNode, MirrorNode, bool>? Changed,
        Func<MirrorNode, MirrorNode, bool>? KeyframeChanged = null);

    private static readonly FieldRule[] Rules =
    {
        // ---- identity / structural ----
        new(nameof(MirrorNode.Id), NodeChangeFlags.None, null), // the map key; never differs for a given node
        new(nameof(MirrorNode.ParentId), NodeChangeFlags.Static, static (e, m) => !string.Equals(e.ParentId, m.ParentId, StringComparison.Ordinal)),

        // ---- static block (retained across a volatile-only merge → cannot change without a static-bearing upsert;
        // `Changed` stays null so Classify never flags them, but a keyframe re-sends the block so ClassifyKeyframe
        // value-compares them via KeyframeChanged) ----
        new(nameof(MirrorNode.Name), NodeChangeFlags.Static, null, static (e, m) => !string.Equals(e.Name, m.Name, StringComparison.Ordinal)),
        new(nameof(MirrorNode.NodeType), NodeChangeFlags.Static, null, static (e, m) => !string.Equals(e.NodeType, m.NodeType, StringComparison.Ordinal)),
        new(nameof(MirrorNode.ShowBehindParent), NodeChangeFlags.Draw, null, static (e, m) => e.ShowBehindParent != m.ShowBehindParent),
        new(nameof(MirrorNode.ClipChildren), NodeChangeFlags.Draw, null, static (e, m) => e.ClipChildren != m.ClipChildren),
        new(nameof(MirrorNode.ClipContents), NodeChangeFlags.Draw, null, static (e, m) => e.ClipContents != m.ClipContents),
        new(nameof(MirrorNode.NinePatchMargins), NodeChangeFlags.Draw, null, static (e, m) => e.NinePatchMargins != m.NinePatchMargins),
        new(nameof(MirrorNode.Font), NodeChangeFlags.Text, null, static (e, m) => e.Font != m.Font),
        // The per-role rich-text fonts (+ their theme sizes / glyph spacing) are retained-static exactly like Font
        // and, like it, are pure TEXT styling — they only reach the DOM as the `--godot-rich-*` variables on the
        // text element, so a keyframe that changes one wants the same full re-apply a Font change wants.
        new(nameof(MirrorNode.RichBoldFont), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldFont != m.RichBoldFont),
        new(nameof(MirrorNode.RichItalicFont), NodeChangeFlags.Text, null, static (e, m) => e.RichItalicFont != m.RichItalicFont),
        new(nameof(MirrorNode.RichBoldItalicFont), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldItalicFont != m.RichBoldItalicFont),
        new(nameof(MirrorNode.RichBoldFontSizePx), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldFontSizePx != m.RichBoldFontSizePx),
        new(nameof(MirrorNode.RichItalicFontSizePx), NodeChangeFlags.Text, null, static (e, m) => e.RichItalicFontSizePx != m.RichItalicFontSizePx),
        new(nameof(MirrorNode.RichBoldItalicFontSizePx), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldItalicFontSizePx != m.RichBoldItalicFontSizePx),
        new(nameof(MirrorNode.RichBoldFontSpacingPx), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldFontSpacingPx != m.RichBoldFontSpacingPx),
        new(nameof(MirrorNode.RichItalicFontSpacingPx), NodeChangeFlags.Text, null, static (e, m) => e.RichItalicFontSpacingPx != m.RichItalicFontSpacingPx),
        new(nameof(MirrorNode.RichBoldItalicFontSpacingPx), NodeChangeFlags.Text, null, static (e, m) => e.RichBoldItalicFontSpacingPx != m.RichBoldItalicFontSpacingPx),
        new(nameof(MirrorNode.Shadow), NodeChangeFlags.Text, null, static (e, m) => e.Shadow != m.Shadow),
        new(nameof(MirrorNode.RichText), NodeChangeFlags.Text, null, static (e, m) => e.RichText != m.RichText),
        new(nameof(MirrorNode.ShaderId), NodeChangeFlags.Effects, null, static (e, m) => !string.Equals(e.ShaderId, m.ShaderId, StringComparison.Ordinal)),
        new(nameof(MirrorNode.MaterialRef), NodeChangeFlags.Effects, null, static (e, m) => !string.Equals(e.MaterialRef, m.MaterialRef, StringComparison.Ordinal)),
        new(nameof(MirrorNode.TextureStretchMode), NodeChangeFlags.Draw, null, static (e, m) => e.TextureStretchMode != m.TextureStretchMode),
        new(nameof(MirrorNode.TextureFlipH), NodeChangeFlags.Draw, null, static (e, m) => e.TextureFlipH != m.TextureFlipH),
        new(nameof(MirrorNode.TextureFlipV), NodeChangeFlags.Draw, null, static (e, m) => e.TextureFlipV != m.TextureFlipV),
        new(nameof(MirrorNode.CanvasBlendMode), NodeChangeFlags.Draw, null, static (e, m) => e.CanvasBlendMode != m.CanvasBlendMode),
        // ParticleSpec record-eq compares its list members by reference → conservative on a keyframe (an actual
        // particle node re-Applies), but null==null so the overwhelming plain-node majority still skips.
        new(nameof(MirrorNode.ParticleSpec), NodeChangeFlags.Effects, null, static (e, m) => e.ParticleSpec != m.ParticleSpec),
        new(nameof(MirrorNode.SpineSceneResPath), NodeChangeFlags.Effects, null, static (e, m) => !string.Equals(e.SpineSceneResPath, m.SpineSceneResPath, StringComparison.Ordinal)),
        new(nameof(MirrorNode.SpineNodePath), NodeChangeFlags.Effects, null, static (e, m) => !string.Equals(e.SpineNodePath, m.SpineNodePath, StringComparison.Ordinal)),
        new(nameof(MirrorNode.SpineAnimations), NodeChangeFlags.Effects, null, static (e, m) => !SeqEqual(e.SpineAnimations, m.SpineAnimations)),
        // SpineSkelResPath is STATIC (rides the spine snapshot on add/keyframe, retained by MergeNode) — like the
        // other spine-static fields it can't change on a volatile-only merge (null Changed), but a keyframe re-sends
        // the block so ClassifyKeyframe value-compares it. Effects (a skeleton change is a spine identity change).
        new(nameof(MirrorNode.SpineSkelResPath), NodeChangeFlags.Effects, null, static (e, m) => !string.Equals(e.SpineSkelResPath, m.SpineSkelResPath, StringComparison.Ordinal)),
        new(nameof(MirrorNode.SceneFilePath), NodeChangeFlags.Static, null, static (e, m) => !string.Equals(e.SceneFilePath, m.SceneFilePath, StringComparison.Ordinal)),
        new(nameof(MirrorNode.MouseFilter), NodeChangeFlags.Static, null, static (e, m) => e.MouseFilter != m.MouseFilter),
        new(nameof(MirrorNode.AnchorLeft), NodeChangeFlags.Static, null, static (e, m) => e.AnchorLeft != m.AnchorLeft),
        new(nameof(MirrorNode.AnchorRight), NodeChangeFlags.Static, null, static (e, m) => e.AnchorRight != m.AnchorRight),
        new(nameof(MirrorNode.AnchorOwnerId), NodeChangeFlags.Static, null, static (e, m) => !string.Equals(e.AnchorOwnerId, m.AnchorOwnerId, StringComparison.Ordinal)),
        // ContainerLayout is a static, retained BoxContainer hint — it only changes with scene structure (a
        // static-bearing upsert), so classify it Static (never light-eligible).
        new(nameof(MirrorNode.ContainerLayout), NodeChangeFlags.Static, null, static (e, m) => !string.Equals(e.ContainerLayout, m.ContainerLayout, StringComparison.Ordinal)),

        // ---- static block, but NOT retained by MergeNode (rides the upsert) → diff it ----
        // ShaderParams: keep-last-on-null — a null upsert means "unchanged" (never a reset), so only a fresh non-null
        // param list (a new reference) counts as a change.
        new(nameof(MirrorNode.ShaderParams), NodeChangeFlags.Effects, static (e, m) => m.ShaderParams is not null && !ReferenceEquals(e.ShaderParams, m.ShaderParams)),
        // IntentFrames is sticky (upsert ?? existing); a fresh non-null set → a new reference → an effect change.
        new(nameof(MirrorNode.IntentFrames), NodeChangeFlags.Effects, static (e, m) => !ReferenceEquals(e.IntentFrames, m.IntentFrames)),
        // The Line2D stroke unit is sticky on the same policy, so the same reference test applies: the merge hands
        // the RETAINED list straight through when the upsert carried none, so "unchanged" is literally the same
        // reference; a re-shipped stroke (an appended point, a clear) always arrives as a freshly parsed list.
        // Classified DRAW (never light-eligible): the polyline lives behind the full Apply — the web reconciler
        // repaints it in updateSubLayers and the native view re-pushes Points/Width/DefaultColor onto its `__line`
        // child — and ApplyLight rewrites only transform/tint, so a light apply would silently freeze the stroke
        // mid-drag. Width/colour value-compare (double / record equality) and are Draw for the same reason.
        new(nameof(MirrorNode.LinePoints), NodeChangeFlags.Draw, static (e, m) => !ReferenceEquals(e.LinePoints, m.LinePoints)),
        new(nameof(MirrorNode.LineWidth), NodeChangeFlags.Draw, static (e, m) => e.LineWidth != m.LineWidth),
        new(nameof(MirrorNode.LineColor), NodeChangeFlags.Draw, static (e, m) => e.LineColor != m.LineColor),

        // ---- volatile ----
        new(nameof(MirrorNode.ParticleEmitting), NodeChangeFlags.Effects, static (e, m) => e.ParticleEmitting != m.ParticleEmitting),
        new(nameof(MirrorNode.ParticleRestartEpoch), NodeChangeFlags.Effects, static (e, m) => e.ParticleRestartEpoch != m.ParticleRestartEpoch),
        new(nameof(MirrorNode.SpineCurrentAnim), NodeChangeFlags.Effects, static (e, m) => !string.Equals(e.SpineCurrentAnim, m.SpineCurrentAnim, StringComparison.Ordinal)),
        // SpineSkin is VOLATILE (rides the upsert, not retained). A skin change re-requests the clip → NOT light-
        // eligible, so classify it Effects (like SpineCurrentAnim).
        new(nameof(MirrorNode.SpineSkin), NodeChangeFlags.Effects, static (e, m) => !string.Equals(e.SpineSkin, m.SpineSkin, StringComparison.Ordinal)),
        // SpineMat (#8) is VOLATILE like SpineSkin and, like it, a change re-requests the clip → Effects.
        new(nameof(MirrorNode.SpineMat), NodeChangeFlags.Effects, static (e, m) => !string.Equals(e.SpineMat, m.SpineMat, StringComparison.Ordinal)),
        // SpinePaused (#13) is VOLATILE: a freeze/resume flip changes how the clip plays, so it must reach the
        // spine layer (Effects), not be swallowed by the light path.
        new(nameof(MirrorNode.SpinePaused), NodeChangeFlags.Effects, static (e, m) => e.SpinePaused != m.SpinePaused),
        // DELIBERATELY EXCLUDED: SpineLayer plays off the wall clock and ignores track-time echoes, so a bare
        // track-time delta triggers NO reconcile work → keep it light-eligible (no flag).
        new(nameof(MirrorNode.SpineTrackTime), NodeChangeFlags.None, null),
        new(nameof(MirrorNode.SpineLooping), NodeChangeFlags.Effects, static (e, m) => e.SpineLooping != m.SpineLooping),
        new(nameof(MirrorNode.Outline), NodeChangeFlags.Draw, static (e, m) => e.Outline != m.Outline),
        new(nameof(MirrorNode.Transform), NodeChangeFlags.Transform, TransformChanged),
        new(nameof(MirrorNode.LocalRect), NodeChangeFlags.Draw, static (e, m) => e.LocalRect != m.LocalRect),
        new(nameof(MirrorNode.Visible), NodeChangeFlags.Tint, static (e, m) => e.Visible != m.Visible),
        new(nameof(MirrorNode.Opacity), NodeChangeFlags.Tint, static (e, m) => e.Opacity != m.Opacity),
        // Rotation/Scale/Pivot are redundant with the transform matrix (the sole native placement input) — grouped
        // under Transform so a bare change stays light-eligible (ApplyLight rewrites the authoritative matrix).
        new(nameof(MirrorNode.Rotation), NodeChangeFlags.Transform, static (e, m) => e.Rotation != m.Rotation),
        new(nameof(MirrorNode.ScaleX), NodeChangeFlags.Transform, static (e, m) => e.ScaleX != m.ScaleX),
        new(nameof(MirrorNode.ScaleY), NodeChangeFlags.Transform, static (e, m) => e.ScaleY != m.ScaleY),
        new(nameof(MirrorNode.PivotX), NodeChangeFlags.Transform, static (e, m) => e.PivotX != m.PivotX),
        new(nameof(MirrorNode.PivotY), NodeChangeFlags.Transform, static (e, m) => e.PivotY != m.PivotY),
        new(nameof(MirrorNode.ZIndex), NodeChangeFlags.Tint, static (e, m) => e.ZIndex != m.ZIndex),
        new(nameof(MirrorNode.TextureUrl), NodeChangeFlags.Draw, static (e, m) => !string.Equals(e.TextureUrl, m.TextureUrl, StringComparison.Ordinal)),
        // R11: TextureRegion is classified by TWO rules (both named TextureRegion so the completeness guard still sees
        // the property classified exactly once — ClassifiedNames is a HashSet that dedups the name). The two comparers
        // are mutually exclusive, so at most one ever fires. Keeping two rules (rather than one Category-switching rule)
        // preserves the static table + the reflection guard.
        //   (1) null↔non-null transition (a texture gaining/losing its atlas crop) → Draw: the drawer must re-resolve.
        new(nameof(MirrorNode.TextureRegion), NodeChangeFlags.Draw, static (e, m) => (e.TextureRegion is null) != (m.TextureRegion is null)),
        //   (2) region↔region swap (both non-null, differ) → Region (a pure atlas frame swap). Region is light-eligible
        //       (MarkRegionRedraw re-crop) and out of WalkRelevant. A SIZE-changing swap ALSO trips the LocalRect Draw rule
        //       (Sprite2D LocalRect derives from region size) → Region|Draw → NOT light-eligible → full Apply.
        new(nameof(MirrorNode.TextureRegion), NodeChangeFlags.Region, static (e, m) => e.TextureRegion is not null && m.TextureRegion is not null && e.TextureRegion != m.TextureRegion),
        new(nameof(MirrorNode.TextureMargin), NodeChangeFlags.Draw, static (e, m) => e.TextureMargin != m.TextureMargin),
        new(nameof(MirrorNode.NinePatch), NodeChangeFlags.Draw, static (e, m) => e.NinePatch != m.NinePatch),
        new(nameof(MirrorNode.Modulate), NodeChangeFlags.Tint, static (e, m) => e.Modulate != m.Modulate),
        new(nameof(MirrorNode.SelfModulate), NodeChangeFlags.Tint, static (e, m) => e.SelfModulate != m.SelfModulate),
        new(nameof(MirrorNode.FillColor), NodeChangeFlags.Draw, static (e, m) => e.FillColor != m.FillColor),
        new(nameof(MirrorNode.Range), NodeChangeFlags.Draw, static (e, m) => e.Range != m.Range),
        new(nameof(MirrorNode.Text), NodeChangeFlags.Text, static (e, m) => e.Text != m.Text),
    };

    // Value equality for a string list (SpineAnimations) — records compare list members by reference, so ClassifyKeyframe
    // needs this to let an identical spine-anim set skip rather than re-Apply on every keyframe. Null-aware.
    private static bool SeqEqual(IReadOnlyList<string>? a, IReadOnlyList<string>? b)
    {
        if (ReferenceEquals(a, b))
        {
            return true;
        }

        if (a is null || b is null || a.Count != b.Count)
        {
            return false;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (!string.Equals(a[i], b[i], StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }

    // Transform is a 6-tuple list (no value equality) — compare element-wise, null-aware.
    private static bool TransformChanged(MirrorNode e, MirrorNode m)
    {
        var a = e.Transform;
        var b = m.Transform;
        if (ReferenceEquals(a, b))
        {
            return false;
        }

        if (a is null || b is null || a.Count != b.Count)
        {
            return true;
        }

        for (int i = 0; i < a.Count; i++)
        {
            if (a[i] != b[i])
            {
                return true;
            }
        }

        return false;
    }
}
