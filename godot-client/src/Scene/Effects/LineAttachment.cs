// WS-2 consumer (native half) — LINE2D STROKE geometry, i.e. the map quill annotations.
//
// A map annotation is a `Line2D` instanced from `res://scenes/screens/map/map_line_draw.tscn` (pen) or
// `..._erase.tscn` (eraser), appended LIVE under the map's 960x1620 `DrawViewport` as the finger drags. Such a node
// has NO texture rect, NO text and — critically — NO `localRect` on the wire (the producer only measures
// Control/Sprite2D), so `TextureDrawer.PaintBox` returns null for it and the owner view paints nothing at all. Its
// entire appearance is `linePoints` + `lineWidth` + `lineColor`, which is what this attachment renders.
//
// SHAPE. Structural copy of ParticleAttachment: a static facade (`Sync`) that owns ONE `__line` child, plus the
// child class itself. Here the child IS a real Godot `Line2D` — the engine already draws exactly this primitive, so
// there is nothing to re-implement. It sits at IDENTITY transform under the owner, whose element carries the
// streamed matrix, and the producer's points are NODE-LOCAL, so they are pushed verbatim.
//
// NOT STREAMED, BY DESIGN (see the producer's Sts2Line2DGeometryEmit): joint/cap modes are constant `round` on both
// authored stroke scenes, so they are set ONCE at construction; and there is no eraser flag on the wire — an eraser
// is exactly the stroke whose already-streamed `ShaderId` is `line_erase.gdshader` (blend_sub).
//
// COST. `Configure` keys on the same cheap signature the PRODUCER changes on (`count|last|width|colour|eraser`), so
// an idle map (dozens of finished strokes, re-Applied by any unrelated drain) costs one string build and an early
// return; only the stroke actually under the finger re-pushes its arrays.

using System;
using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static class LineAttachment
{
    private const string ChildName = "__line";

    // WS-B: build-once NodePath for the child probes (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath ChildPath = ChildName;

    // The producer streams no eraser flag: an eraser stroke is exactly the one whose shader is the blend_sub
    // `line_erase.gdshader`, and that path already rides the generic `ShaderId`. Suffix-matched so a res:// prefix
    // change can't silently turn every eraser back into a pen.
    internal const string EraseShaderSuffix = "line_erase.gdshader";

    // Erasers use a shared Sub-blend CanvasItemMaterial via BlendMaterials.For(2).

    // Godot's own Line2D default width, used only if the producer somehow streamed points without one.
    internal const float DefaultWidth = 4f;

    public static void Sync(MirrorNodeView owner, MirrorNode node, RenderContext ctx)
    {
        // `LinePoints` is the sole signal (there is no localRect to wait on). An EMPTY array still means "this is a
        // stroke" — it was CLEARED (undo / clear-all) — so the child is KEPT and simply emptied, ready to be drawn
        // into again. Only a null (never-streamed / not-a-Line2D) tears it down.
        bool wantLine = node.LinePoints is not null;

        // WS-P2 gate: nothing to render AND none ever attached → skip the marshalled child probe entirely.
        if (!wantLine && !owner.HasLineChild)
        {
            return;
        }

        var layer = owner.GetNodeOrNull<LineLayer>(ChildPath);

        if (!wantLine)
        {
            if (layer is not null)
            {
                owner.RemoveChild(layer);
                layer.Free();
            }

            owner.HasLineChild = false;
            return;
        }

        if (layer is null)
        {
            layer = new LineLayer { Name = ChildName, ShowBehindParent = true };
            owner.AddChild(layer); // end-appended; the reconciler's MoveChild pass keeps non-view children at the tail
            owner.HasLineChild = true;
        }

        layer.Configure(node);
    }

    // True when this stroke is the ERASER variant (blend_sub shader), not the pen.
    internal static bool IsEraser(MirrorNode node) =>
        node.ShaderId is { } id && id.EndsWith(EraseShaderSuffix, StringComparison.Ordinal);

    // The no-op-skip key. Mirrors the PRODUCER's own change signature (Sts2Line2DGeometryEmit.Signature) plus the
    // eraser bit: point COUNT catches an append and a clear/undo, the LAST point catches an undo-then-redraw that
    // lands on the same length, and width/colour catch a palette or tool change. A mid-array edit at unchanged
    // count AND unchanged tip is not expressible by the game's append-only stroke API.
    internal static string Signature(MirrorNode node)
    {
        var points = node.LinePoints;
        int count = points is null ? 0 : points.Count;
        string last = count >= 2
            ? string.Concat(Str(points![count - 2]), ",", Str(points[count - 1]))
            : string.Empty;
        return string.Concat(
            count.ToString(System.Globalization.CultureInfo.InvariantCulture), "|",
            last, "|",
            Str(node.LineWidth ?? DefaultWidth), "|",
            node.LineColor?.Html ?? string.Empty, "|",
            IsEraser(node) ? "1" : "0");
    }

    private static string Str(double v) => v.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
}

// The `__line` child: a REAL Godot `Line2D` at identity transform under the owner view. Joint + caps are set once
// (constant `round` on both authored stroke scenes); everything else is refreshed by `Configure`, which early-outs
// on an unchanged signature so a re-Applied idle map costs nothing.
public sealed partial class LineLayer : Line2D
{
    // The signature the currently-pushed geometry was built from (null = nothing pushed yet).
    private string? _sig;

    // Reused across configures so a growing stroke doesn't allocate a fresh array on every appended point until it
    // actually outgrows the buffer. `Points` copies into the engine, so handing it an over-long buffer is not an
    // option — the exact-length array below is what is assigned; this only avoids the churn while the count is stable.
    private Vector2[] _scratch = Array.Empty<Vector2>();

    public LineLayer()
    {
        // Constant on both authored stroke scenes — hard-coded rather than streamed (see the producer notes).
        JointMode = LineJointMode.Round;
        BeginCapMode = LineCapMode.Round;
        EndCapMode = LineCapMode.Round;
        // The stroke's own colour is DefaultColor; nothing here should inherit a modulate the owner applies to its
        // (non-existent) own paint.
        Antialiased = true;
    }

    public void Configure(MirrorNode node)
    {
        string sig = LineAttachment.Signature(node);
        if (_sig == sig)
        {
            return;
        }

        _sig = sig;

        var points = node.LinePoints;
        int pairs = points is null ? 0 : points.Count / 2;
        if (_scratch.Length != pairs)
        {
            _scratch = new Vector2[pairs];
        }

        for (int i = 0; i < pairs; i++)
        {
            _scratch[i] = new Vector2((float)points![i * 2], (float)points[(i * 2) + 1]);
        }

        // An empty / single-point array draws nothing — exactly the "stroke cleared" instruction. The node stays.
        Points = _scratch;
        Width = node.LineWidth is { } w ? (float)w : LineAttachment.DefaultWidth;

        bool eraser = LineAttachment.IsEraser(node);
        if (eraser)
        {
            // The real thing: the shared Sub-blend CanvasItemMaterial (BlendMaterials owns immutable singletons —
            // never mutate the returned instance). The stroke's own default_color still modulates the subtraction.
            DefaultColor = ColorOf(node.LineColor);
            Material = BlendMaterials.For(2);
        }
        else
        {
            DefaultColor = ColorOf(node.LineColor);
            Material = null;
        }

        // The trail TEXTURE (trail2.png/trail3.png, texture_mode tile) is deliberately NOT applied: it rides the
        // generic primary-texture probe and would need the async TextureStore + a Generation guard to land on this
        // child. The pen renders as a flat stroke, which is the same documented fidelity gap the browser has.
    }

    private static Color ColorOf(MirrorColor? color) =>
        color is { } c ? new Color((float)c.R, (float)c.G, (float)c.B, (float)c.A) : Colors.White;
}
