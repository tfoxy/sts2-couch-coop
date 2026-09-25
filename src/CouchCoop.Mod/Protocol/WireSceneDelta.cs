using System.Text.Json.Serialization;
using CouchCoop.Mod.Server;
using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Protocol;

// Couch-coop WIRE DTO for the mirror scene-delta. The producer's RuntimeSceneNodeDelta writes every value-type
// field ALWAYS (a non-nullable bool/double/int can't be omitted), so a per-tick upsert re-shipped visible:true,
// opacity:1, scaleX:1, ninePatch:false, rotation:0 … on every node every frame — bytes the client would fill with
// the exact same default anyway. This DTO makes each such field NULLABLE and maps it to null when it equals the
// client's normalizeNode fallback default, so `WhenWritingNull` omits it (and the client refills the default).
//
// The omission rule is: a field may be omitted IFF its value equals the client fallback default for that field
// (sceneTree.ts normalizeNode). The defaults, verified field-by-field against that table, are annotated per field.
// Fields whose null is MEANINGFUL (visible:false, opacity:0, spineLooping:false) are NOT dropped by a blanket
// default-ignore — they are explicitly mapped (e.g. Visible = value ? null : false) so only the true default is
// omitted. `full` is ALWAYS written. CouchCoop's scene wire is always parent-relative, so it carries no
// transform-space selector.
//
// Complex fields reference the existing snapshot records unchanged, so the SceneDeltaWire* leaf converters still
// slim their nested colors / vector2s / resource refs. The dead `Rotation` field (hard-coded 0 by the producer)
// is dropped end-to-end; the client already tolerates its absence (rotation: asNumber(record.rotation) => 0).
public sealed record WireNodeDelta(
    string Id,
    string? ParentId,
    string? Name,
    string? NodeType,
    RuntimeSceneResourceRefSnapshot? Texture,
    RuntimeSceneTextPropertiesSnapshot? Text,
    RuntimeSceneColorSnapshot? Modulate,
    RuntimeSceneColorSnapshot? SelfModulate,
    RuntimeSceneColorSnapshot? FillColor,
    RuntimeSceneColorSnapshot? OutlineColor,
    RuntimeSceneResourceRefSnapshot? Font,
    // PER-ROLE rich-text fonts — STATIC, null (omitted) on every node the producer found nothing to say for, which
    // is all but the handful of bbcode RichTextLabels whose theme names a different font FILE for the role. Godot
    // renders `[b]` by SWAPPING to the `bold_font` theme item rather than synthesising, so this is what lets the
    // mirror's `<strong>` resolve the real bold face. Plain passthrough (the resource-ref converter slims each to
    // its path, exactly like `Font`).
    RuntimeSceneResourceRefSnapshot? RichBoldFont,
    RuntimeSceneResourceRefSnapshot? RichItalicFont,
    RuntimeSceneResourceRefSnapshot? RichBoldItalicFont,
    RuntimeSceneResourceRefSnapshot? Material,
    RuntimeSceneResourceRefSnapshot? Shader,
    IReadOnlyList<RuntimeSceneShaderParamSnapshot>? ShaderParameters,
    RuntimeSceneTransform2DSnapshot? Transform,
    RuntimeSceneRect2Snapshot? LocalRect,
    RuntimeSceneRect2Snapshot? TextureRegion,
    RuntimeSceneRect2Snapshot? TextureMargin,
    RuntimeScenePatchMarginsSnapshot? NinePatchMargins,
    RuntimeSceneTextShadowSnapshot? Shadow,
    RuntimeSceneParticleSpecSnapshot? ParticleSpec,
    RuntimeSceneSpineSnapshot? Spine,
    RuntimeSceneIntentFramesSnapshot? IntentFrames,
    // LINE2D STROKE GEOMETRY (the map quill annotations) — a STICKY unit, null (omitted) on every node that is not a
    // `Line2D`, i.e. all but the handful of strokes under the map's DrawViewport. Plain passthroughs: `LinePoints` is
    // the producer's already-flattened, already-2dp-rounded `[x0,y0,…]` NODE-LOCAL array (an EMPTY array is meaningful
    // — the stroke was cleared — so it must NOT be defaulted away), `LineColor` reuses `RuntimeSceneColorSnapshot`
    // exactly as the producer does (the leaf converter slims it to `{html}` like every other colour).
    IReadOnlyList<double>? LinePoints,
    double? LineWidth,
    RuntimeSceneColorSnapshot? LineColor,
    string? SpineCurrentAnim,
    // Volatile runtime skin (null when unknown → omitted). The client folds it into the clip identity + `&skin=`
    // query. The STATIC SpineSkelResPath rides the `Spine` snapshot (RuntimeSceneSpineSnapshot.SkelResPath) — no
    // separate wire field here (it serializes inside `spine`).
    string? SpineSkin,
    // Volatile shader-material signature (#8; null when the node has no normal_material ShaderMaterial → omitted).
    // The client folds it into the clip identity + the `&mat=` query, so a re-tinted material re-bakes instead of
    // serving the first-baked clip forever from the cache.
    string? SpineMat,
    // Volatile paused flag (#13) — true only while the game froze the track (SetTimeScale(0)); omitted when false.
    bool? SpinePaused,
    string? SceneFilePath,
    string? FontWeight,
    string? FontStyle,
    string? AnchorOwnerId,
    string? ContainerLayout,
    // WS-E: the DECLARATIVE INFINITE ANIMATION the producer pinned to rest on this node, for the client to replay
    // on its own clock (today: "mapPointPulse", the travelable map node's icon-scale sweep). Volatile, but it only
    // changes on the animation's start/stop edges. Null for every node without a pinned loop → omitted.
    string? PinnedLoopAnim,
    // R13: the stable identity of the CONTENT this node shows — STATIC (rides add/keyframe/re-attach only, and
    // MergeVolatile carries it forward). Today the one case is a card: STS2 POOLS `NCard` visuals, so a node's
    // instance id says nothing about WHICH card is on screen (the same id is a Strike this tick and a Bash the
    // next). The key is `nc:{entry}#{serial}` — see RuntimeSceneNodeDelta.ContentKey / Sts2ContentKey. Null for
    // every node without one (almost all of them) → omitted, so the wire is unchanged off the card scenes.
    string? ContentKey,
    int? ZIndex,
    int? MouseFilter,
    int? TextureStretchMode,
    int? CanvasBlendMode,
    // Nullable value types — null (omitted) means "== the client fallback default".
    bool? Visible,            // client default TRUE  (record.visible !== false)  -> omit when true
    float? Opacity,           // client default 1     (record.opacity == null ? 1) -> omit when 1
    float? ScaleX,            // client default 1     -> omit when 1
    float? ScaleY,            // client default 1     -> omit when 1
    float? PivotX,            // client default 0     -> omit when 0
    float? PivotY,            // client default 0     -> omit when 0
    bool? NinePatch,          // client default FALSE -> omit when false
    bool? ShowBehindParent,   // client default FALSE -> omit when false
    int? ClipChildren,        // client default 0     -> omit when 0
    bool? ClipContents,       // client default FALSE -> omit when false (Control.clip_contents; see MirrorNode)
    bool? Focused,            // client default FALSE -> omit when false/null (authoritative clickable focus)
    bool? RichText,           // client default FALSE -> omit when false
    bool? TextureFlipH,       // client default FALSE -> omit when false
    bool? TextureFlipV,       // client default FALSE -> omit when false
    bool? ParticleEmitting,   // client default FALSE -> omit when false
    long? ParticleRestartEpoch, // client default 0   -> omit when 0
    float? SpineTrackTime,    // client default 0     -> omit when 0
    bool? SpineLooping,       // client default TRUE  -> omit when true
    float? OutlineSize,       // nullable passthrough (null already omitted)
    float? RangeValue,        // nullable passthrough
    float? RangeMin,
    float? RangeMax,
    float? AnchorLeft,        // nullable passthrough (null-vs-0 distinction preserved: only null omitted)
    float? AnchorRight,
    // PER-ROLE rich-text font SIZES (absolute px) and GLYPH SPACING (px) — nullable passthroughs, so no
    // `wireDefaults` entry is needed: the producer already omits a role size that EQUALS the node's normal size and
    // a zero spacing, and null is exactly "nothing to say for this role" (never a defaultable value). Narrowed to
    // float like every other px scalar on this DTO.
    float? RichBoldFontSizePx,
    float? RichItalicFontSizePx,
    float? RichBoldItalicFontSizePx,
    float? RichBoldFontSpacingPx,
    float? RichItalicFontSpacingPx,
    float? RichBoldItalicFontSpacingPx)
{
    public static WireNodeDelta FromNode(RuntimeSceneNodeDelta n) => new(
        Id: n.Id,
        ParentId: n.ParentId,
        Name: n.Name,
        NodeType: n.NodeType,
        Texture: n.Texture,
        Text: n.Text,
        Modulate: n.Modulate,
        SelfModulate: n.SelfModulate,
        FillColor: n.FillColor,
        OutlineColor: n.OutlineColor,
        Font: n.Font,
        RichBoldFont: n.RichBoldFont,
        RichItalicFont: n.RichItalicFont,
        RichBoldItalicFont: n.RichBoldItalicFont,
        Material: n.Material,
        Shader: n.Shader,
        ShaderParameters: n.ShaderParameters,
        Transform: n.Transform,
        LocalRect: n.LocalRect,
        TextureRegion: n.TextureRegion,
        TextureMargin: n.TextureMargin,
        NinePatchMargins: n.NinePatchMargins,
        Shadow: n.Shadow,
        ParticleSpec: n.ParticleSpec,
        Spine: n.Spine,
        IntentFrames: n.IntentFrames,
        LinePoints: n.LinePoints,
        LineWidth: n.LineWidth,
        LineColor: n.LineColor,
        SpineCurrentAnim: n.SpineCurrentAnim,
        SpineSkin: n.SpineSkin,
        SpineMat: n.SpineMat,
        SpinePaused: n.SpinePaused ? true : null,
        SceneFilePath: n.SceneFilePath,
        FontWeight: n.FontWeight,
        FontStyle: n.FontStyle,
        AnchorOwnerId: n.AnchorOwnerId,
        ContainerLayout: n.ContainerLayout,
        PinnedLoopAnim: n.PinnedLoopAnim,
        ContentKey: n.ContentKey,
        ZIndex: n.ZIndex,
        MouseFilter: n.MouseFilter,
        TextureStretchMode: n.TextureStretchMode,
        CanvasBlendMode: n.CanvasBlendMode,
        Visible: n.Visible ? null : false,
        Opacity: n.Opacity == 1.0 ? null : (float)n.Opacity,
        ScaleX: n.ScaleX == 1.0 ? null : (float)n.ScaleX,
        ScaleY: n.ScaleY == 1.0 ? null : (float)n.ScaleY,
        PivotX: n.PivotX == 0.0 ? null : (float)n.PivotX,
        PivotY: n.PivotY == 0.0 ? null : (float)n.PivotY,
        NinePatch: n.NinePatch ? true : null,
        ShowBehindParent: n.ShowBehindParent ? true : null,
        ClipChildren: n.ClipChildren == 0 ? null : n.ClipChildren,
        ClipContents: n.ClipContents ? true : null,
        Focused: n.Focused is true ? true : null,
        RichText: n.RichText ? true : null,
        TextureFlipH: n.TextureFlipH ? true : null,
        TextureFlipV: n.TextureFlipV ? true : null,
        ParticleEmitting: n.ParticleEmitting ? true : null,
        ParticleRestartEpoch: n.ParticleRestartEpoch == 0 ? null : n.ParticleRestartEpoch,
        SpineTrackTime: n.SpineTrackTime == 0.0 ? null : (float)n.SpineTrackTime,
        SpineLooping: n.SpineLooping ? null : false,
        OutlineSize: n.OutlineSize is null ? null : (float)n.OutlineSize.Value,
        RangeValue: n.RangeValue is null ? null : (float)n.RangeValue.Value,
        RangeMin: n.RangeMin is null ? null : (float)n.RangeMin.Value,
        RangeMax: n.RangeMax is null ? null : (float)n.RangeMax.Value,
        AnchorLeft: n.AnchorLeft is null ? null : (float)n.AnchorLeft.Value,
        AnchorRight: n.AnchorRight is null ? null : (float)n.AnchorRight.Value,
        RichBoldFontSizePx: n.RichBoldFontSizePx is null ? null : (float)n.RichBoldFontSizePx.Value,
        RichItalicFontSizePx: n.RichItalicFontSizePx is null ? null : (float)n.RichItalicFontSizePx.Value,
        RichBoldItalicFontSizePx: n.RichBoldItalicFontSizePx is null ? null : (float)n.RichBoldItalicFontSizePx.Value,
        RichBoldFontSpacingPx: n.RichBoldFontSpacingPx is null ? null : (float)n.RichBoldFontSpacingPx.Value,
        RichItalicFontSpacingPx: n.RichItalicFontSpacingPx is null ? null : (float)n.RichItalicFontSpacingPx.Value,
        RichBoldItalicFontSpacingPx:
            n.RichBoldItalicFontSpacingPx is null ? null : (float)n.RichBoldItalicFontSpacingPx.Value);
}

// One dirty parent's new ordered child-id list on the wire.
public sealed record WireOrderParent(string P, IReadOnlyList<string> C);

// Stage 4 order patch: the new root list (only when roots changed) + every parent whose child list changed. The
// client applies it to its structure (rebuilt from the PREVIOUS orderedIds + node map) and re-flattens to the new
// order — replacing the full ~52KB orderedIds array on a structural change.
public sealed record WireOrderPatch(IReadOnlyList<string>? Roots, IReadOnlyList<WireOrderParent> Parents);

// Couch-coop wire envelope. Mirrors RuntimeSceneDelta's top-level shape (so the flat client-read layout is
// unchanged) but its upserts are the slimmed WireNodeDelta. Order
// is carried EITHER as the full `OrderedIds` array OR the compact `OrderPatch` (never both) — the client keys on
// whichever is present; a full orderedIds array remains the keyframe path.
public sealed record WireSceneDelta(
    bool Full,
    string ScreenType,
    string ScreenInstanceId,
    IReadOnlyList<WireNodeDelta> Upserts,
    IReadOnlyList<string> RemovedIds,
    IReadOnlyList<string>? OrderedIds,
    WireOrderPatch? OrderPatch,
    IReadOnlyList<TweenHintDelta>? Hints,
    // WS-3 declarative card flights (see CardFlightHintDelta). Omitted when empty, like Hints — an older client
    // simply never sees the key, and the host only ever suppresses a flight's transforms when the connecting
    // client declared it can replay them (`?cardFlight`).
    //
    // ONE array, BOTH kinds: an entry's optional `Kind`/`Rot0` say whether it is the shuffle sweep (no key at all,
    // the legacy bytes) or the hand→discard fly. Carried unchanged from the shared DTO rather than re-declared
    // here, so a client that does not know a kind still gets a replayable flight instead of a dropped one.
    IReadOnlyList<CardFlightHintDelta>? CardFlights)
{
    // Keep the discriminator last so the one-pass serializer remains byte-for-byte compatible with the former
    // suffix splice and with checked-in browser fixtures.
    [JsonPropertyOrder(int.MaxValue)]
    public string Type => "scene-delta";

    public static WireSceneDelta FromDelta(RuntimeSceneDelta delta, SceneOrderPatch? orderPatch = null)
    {
        var upserts = new List<WireNodeDelta>(delta.Upserts.Count);
        foreach (var node in delta.Upserts)
        {
            upserts.Add(WireNodeDelta.FromNode(node));
        }

        WireOrderPatch? wirePatch = null;
        if (orderPatch is not null)
        {
            var parents = new List<WireOrderParent>(orderPatch.Parents.Count);
            foreach (var parent in orderPatch.Parents)
            {
                parents.Add(new WireOrderParent(parent.ParentId, parent.ChildIds));
            }

            wirePatch = new WireOrderPatch(orderPatch.Roots, parents);
        }

        return new WireSceneDelta(
            Full: delta.Full,
            ScreenType: delta.ScreenType,
            ScreenInstanceId: delta.ScreenInstanceId,
            Upserts: upserts,
            // A patch supersedes the full array (the coalescer already nulled OrderedIds when it emitted a patch).
            OrderedIds: wirePatch is null ? delta.OrderedIds : null,
            OrderPatch: wirePatch,
            RemovedIds: delta.RemovedIds,
            Hints: delta.Hints is { Count: > 0 } ? delta.Hints : null,
            CardFlights: delta.CardFlights is { Count: > 0 } ? delta.CardFlights : null);
    }
}
