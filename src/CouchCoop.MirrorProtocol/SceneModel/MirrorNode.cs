namespace CouchCoop.MirrorProtocol.SceneModel;

// 1:1 C# port of the TS `MirrorNode` interface (frontend/src/mirror/sceneTree.ts). A MUTABLE class (not a
// record): the applier merges static-vs-volatile in place and `applyIntentFrame0` reassigns the texture fields,
// mirroring the TS object-spread + mutation semantics. Numeric fields that TS types as `number` are `double`
// here; the discrete Godot enums (ClipChildren/ZIndex/MouseFilter/StretchMode/BlendMode) are `int?`/`int` and
// the particle restart counter is `long`, to match how the TS reader consumes them.
public sealed class MirrorNode
{
    public required string Id { get; set; }
    public string? ParentId { get; set; }

    // ---- Static (carried on add/keyframe; retained across volatile-only upserts) ----
    public string Name { get; set; } = "";
    public string NodeType { get; set; } = "";
    public bool ShowBehindParent { get; set; }
    public int ClipChildren { get; set; }
    // `Control.clip_contents` — a DIFFERENT Godot property from `ClipChildren` above, and the one that bounds a
    // LAYOUT container. `clip_children` stencils descendants against this node's own DRAWN alpha, so a container
    // that paints nothing clips nothing; `clip_contents` clips a Control's children to its RECTANGLE whether it
    // paints or not. The game uses it to hide a panel's content by parking that content outside the panel box
    // rather than by touching `visible`/`modulate` (the ancient-event options, which slide up from below the
    // ContentContainer while the dialogue plays), so without it the mirror draws the parked content in full.
    public bool ClipContents { get; set; }
    public MirrorMargins? NinePatchMargins { get; set; }
    public MirrorFont? Font { get; set; }
    // PER-ROLE rich-text fonts — STATIC. Non-null only on a bbcode RichTextLabel (`RichText`) whose theme names a
    // DIFFERENT font FILE for that role than the node's own `Font`. Godot never synthesises bold/italic inside a
    // RichTextLabel: it renders a `[b]` / `[i]` / `[b][i]` span by SWAPPING the label's font to its `bold_font` /
    // `italics_font` / `bold_italics_font` theme item, so with only `Font` on the wire a `[b]` span inherited the
    // label's single-face normal font and could not render bold (faux bold is deliberately blocked by
    // `font-synthesis: none`). Same value shape as `Font`, minus weight/style (the wire carries none for a role).
    public MirrorFont? RichBoldFont { get; set; }
    public MirrorFont? RichItalicFont { get; set; }
    public MirrorFont? RichBoldItalicFont { get; set; }
    // The role's own theme font size in ABSOLUTE px — STATIC. Non-null ONLY when the role size differs from the
    // node's normal font size (so a null means "render the span at the node's own size").
    public double? RichBoldFontSizePx { get; set; }
    public double? RichItalicFontSizePx { get; set; }
    public double? RichBoldItalicFontSizePx { get; set; }
    // The role font's glyph spacing in px (Godot FontVariation `spacing_glyph` — extra px after every glyph) —
    // STATIC. Non-null only when non-zero, i.e. for the handful of role fonts reached through a spaced variation.
    public double? RichBoldFontSpacingPx { get; set; }
    public double? RichItalicFontSpacingPx { get; set; }
    public double? RichBoldItalicFontSpacingPx { get; set; }
    public MirrorShadow? Shadow { get; set; }
    public bool RichText { get; set; }
    public string? ShaderId { get; set; }
    public string? MaterialRef { get; set; }
    public IReadOnlyList<MirrorShaderParam>? ShaderParams { get; set; }
    public int? TextureStretchMode { get; set; }
    public bool TextureFlipH { get; set; }
    public bool TextureFlipV { get; set; }
    // TS `canvasBlendMode?: number` — undefined (absent) maps to null here.
    public int? CanvasBlendMode { get; set; }
    public MirrorParticleSpec? ParticleSpec { get; set; }
    public string? SpineSceneResPath { get; set; }
    public string? SpineNodePath { get; set; }
    public IReadOnlyList<string>? SpineAnimations { get; set; }
    // The SpineSprite skeleton's res:// path (RuntimeSceneSpineSnapshot.SkelResPath) — STATIC, null when unknown.
    // The client appends it as `&skel=` on a ONE-SHOT retry after a failed clip fetch (#8: a dynamically-added
    // SpineSprite whose scene lookup misses on the offline extract can still be baked from the skeleton directly).
    public string? SpineSkelResPath { get; set; }
    public string? SceneFilePath { get; set; }
    public int? MouseFilter { get; set; }
    public double? AnchorLeft { get; set; }
    public double? AnchorRight { get; set; }
    public string? AnchorOwnerId { get; set; }
    // BoxContainer layout hint ("hbox-begin"/"hbox-center"/"hbox-end"/"vbox-…") — STATIC. Non-null only on a
    // BoxContainer-derived node. The wide-screen re-layout uses it so a container's children ride the container's
    // OWN re-layout (Godot BoxContainer ignores child anchors) instead of running their own anchor algebra. Null
    // for non-BoxContainer nodes.
    public string? ContainerLayout { get; set; }

    // ---- Volatile ----
    public bool ParticleEmitting { get; set; }
    public long ParticleRestartEpoch { get; set; }
    public string? SpineCurrentAnim { get; set; }
    // The runtime SKIN the game currently has set on the SpineSprite (null when unknown) — VOLATILE. Folded into the
    // clip identity: the client appends `&skin=` (only when present) and RE-REQUESTS the clip when it changes, so a
    // skinned creature (Fossil Stalker / Skulking Colony) bakes with the same skin the live game shows.
    public string? SpineSkin { get; set; }
    // A short signature of the SpineSprite's `normal_material` ShaderMaterial (producer `spineMat`, #8) — VOLATILE,
    // null for every node without one (nearly all of them, so their clip URLs stay byte-identical). Folded into the
    // clip identity exactly like SpineSkin: the client appends `&mat=` (only when present) and RE-REQUESTS the clip
    // when it changes. Needed because the bake now applies that material, so the rendered pixels depend on uniform
    // values that are NOT part of the (scene, node, anim, skin, skel) address — the boss map point re-tints its
    // channel-remap mask shader per act + travel state, and an unshaded pre-fix blob lives under the same address.
    public string? SpineMat { get; set; }
    // The game has PAUSED this spine track (producer `spinePaused`; MegaAnimationState.SetTimeScale(0)) — VOLATILE.
    // Both clients free-run a clip off the wall clock between animation changes, so a paused track must HOLD the
    // streamed track time instead: the treasure chest sits frozen on the closed-chest first frame of "animation"
    // until the player opens it, and free-running walked it open (and on into its queued "shine_fade" glow).
    public bool SpinePaused { get; set; }
    public double SpineTrackTime { get; set; }
    public bool SpineLooping { get; set; } = true;
    public MirrorOutline? Outline { get; set; }
    // Parent-relative transform matrix [a,b,c,d,tx,ty] (or null); the node-local box.
    public IReadOnlyList<double>? Transform { get; set; }
    public MirrorRect? LocalRect { get; set; }
    public bool Visible { get; set; } = true;
    public double Opacity { get; set; } = 1;
    public double Rotation { get; set; }
    public double ScaleX { get; set; } = 1;
    public double ScaleY { get; set; } = 1;
    public double PivotX { get; set; }
    public double PivotY { get; set; }
    public int? ZIndex { get; set; }
    public string? TextureUrl { get; set; }
    public MirrorRect? TextureRegion { get; set; }
    public MirrorRect? TextureMargin { get; set; }
    public bool NinePatch { get; set; }
    public MirrorColor? Modulate { get; set; }
    public MirrorColor? SelfModulate { get; set; }
    public MirrorColor? FillColor { get; set; }
    public MirrorRange? Range { get; set; }
    public MirrorText? Text { get; set; }
    // Sticky (producer re-ships only on intent change; mergeNode carries it forward).
    public MirrorIntentFrames? IntentFrames { get; set; }

    // ---- Line2D stroke geometry (the map quill annotations) — STICKY, exactly like IntentFrames ----------------
    // The three ride as ONE unit: the producer emits them on add/keyframe or when the stroke's cheap signature
    // changed, and MergeNode carries them forward in between (a null upsert value means "unchanged"). A `Line2D`
    // has no texture rect and no text — its ENTIRE appearance IS points + width + colour — so without these a map
    // stroke renders as a completely blank node.
    //
    // `LinePoints` is FLATTENED (`[x0,y0,x1,y1,…]`) in NODE-LOCAL coordinates (the same space as LocalRect, which
    // the producer leaves NULL for every Line2D), 2-dp rounded. An EMPTY list is MEANINGFUL and distinct from
    // null: the stroke was CLEARED (undo / clear-all) and the client must erase what it drew; null means
    // "unchanged — keep the retained geometry".
    //
    // Joint/cap modes are NOT streamed (constant `round` on both authored stroke scenes — hard-coded by both
    // clients) and neither is an eraser flag: an eraser is exactly the stroke whose already-streamed `ShaderId`
    // ends with `line_erase.gdshader` (blend_sub).
    public IReadOnlyList<double>? LinePoints { get; set; }
    public double? LineWidth { get; set; }
    public MirrorColor? LineColor { get; set; }

    // Shallow copy (leaf types are immutable, lists read-only) — used by the static/volatile merge, mirroring the
    // TS `{ ...upsert }` object spread before the static-field overrides are applied.
    public MirrorNode Clone() => (MirrorNode)MemberwiseClone();
}
