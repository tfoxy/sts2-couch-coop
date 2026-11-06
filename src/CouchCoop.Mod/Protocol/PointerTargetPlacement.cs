using Godot;

namespace CouchCoop.Mod.Protocol;

/// <summary>A live node a pointer target names, as <see cref="PointerTargetPlacement"/> reads it.</summary>
internal interface IPointerTargetNode
{
    /// <summary>Still a valid node inside the tree (a freed node, or one that left the tree, is not).</summary>
    bool IsAlive { get; }

    /// <summary>A CanvasItem that is visible in tree. A node that is not a CanvasItem is never placed.</summary>
    bool IsVisibleCanvasItem { get; }

    /// <summary>The node's transform into the input coordinate space (the root canvas, couch's coordX/coordY).</summary>
    Transform2D CanvasTransform { get; }

    /// <summary>A Control's size (it lands when the point falls in <c>Rect2(0, size)</c>); null for another CanvasItem.</summary>
    Vector2? ControlSize { get; }
}

/// <summary>Finds the live nodes a target identity names: every instance of <c>scene</c>, then <c>path</c> under it.</summary>
internal interface IPointerTargetFinder
{
    /// <summary>
    /// The candidates. <paramref name="fresh"/>: a cached answer is not good enough (the placement is about to move
    /// an event, or call its target missing or ambiguous), so look again unless that was just done.
    /// </summary>
    IReadOnlyList<IPointerTargetNode> Find(string scene, string path, bool fresh);
}

/// <summary>
/// GSW input plan row C3: the host half of pointer targets on couch's own wire. A viewer's hover/click names the node
/// the user pointed at, as the render stream DREW it (<c>targetScene</c> + <c>targetPath</c>: the item's instance
/// scene and its path inside that instance, as render-stream <c>item_meta</c> carries them) and the point in that
/// node's own coordinates (<c>localX</c>/<c>localY</c>). By the time the message runs on the game thread the node may
/// have moved (a tween, a re-layout), so the coordinate alone would land beside it. This applies godot-scene-web's
/// <c>retarget: "when-missed"</c> rule (docs/input.md "Pointer targets", the reference GDScript injector's
/// <c>gsw_input_targets.gd</c>) before spirectl's coordinate injection:
/// <list type="bullet">
/// <item>a coordinate that still lands on the node goes as sent; a missed one moves to the node's transform applied
/// to <c>local</c>. A Control lands when the point, through the inverse of its transform, is inside
/// <c>Rect2(0, size)</c>; another CanvasItem when <c>transform * local</c> is within <see cref="Tolerance"/> px.</item>
/// <item>several live instances make a path ambiguous: the one the coordinate lands on wins, else the target is
/// missing. Never a guess.</item>
/// <item>a missing, freed or hidden node falls back to the coordinate.</item>
/// <item>a press binds its node and the offset it was moved by until every button is up: every hover, wheel tick and
/// release in between moves by that offset, whatever it names itself, so a drag stays on its node and relative
/// motion is preserved.</item>
/// </list>
/// A message without target fields and with nothing bound is untouched (the old coordinate path). One instance per
/// connection; called on the game thread only.
/// </summary>
internal sealed class PointerTargetPlacement(IPointerTargetFinder finder)
{
    /// <summary>How far (px) a non-Control CanvasItem's <c>transform * local</c> may sit from the point and land.</summary>
    internal const float Tolerance = 1f;

    private readonly IPointerTargetFinder _finder = finder ?? throw new ArgumentNullException(nameof(finder));
    private readonly HashSet<string> _held = new(StringComparer.Ordinal);
    private Binding? _binding;

    /// <summary>What a press binds: the offset it was moved by (zero when it landed or its node was missing).</summary>
    private sealed record Binding(Vector2 Offset, IPointerTargetNode? Node);

    /// <summary>The placement counters (diagnostics and tests).</summary>
    internal PointerTargetStats Stats { get; } = new();

    /// <summary>
    /// The coordinate a pointer message goes to. <paramref name="pressed"/>: true a press, false a release, null a
    /// hover or a full click (a press and release at one point, a wheel tick). <paramref name="button"/> names the
    /// button of a press/release (ignored otherwise).
    /// </summary>
    public Vector2 Place(Vector2 point, PointerTargetRef? target, bool? pressed, string? button)
    {
        var key = button ?? "left";
        if (pressed == true && _held.Contains(key))
        {
            // A press of a button we think is held: our record is stale (a release we never saw). Start over.
            _held.Clear();
            _binding = null;
        }

        if (_binding is { } bound)
        {
            var placed = point + bound.Offset;
            if (pressed == true) _held.Add(key);
            else if (pressed == false)
            {
                _held.Remove(key);
                if (_held.Count == 0) _binding = null;
            }

            Stats.Bound++;
            return placed;
        }

        var (position, node) = target is { } t ? PlaceOnTarget(point, t) : (point, null);
        if (pressed == true)
        {
            _held.Add(key);
            _binding = new Binding(position - point, node);
        }
        else if (pressed == false)
        {
            _held.Remove(key);
        }

        return position;
    }

    /// <summary>Drop any binding (the connection's input was cancelled).</summary>
    public void Reset()
    {
        _held.Clear();
        _binding = null;
    }

    private (Vector2 Position, IPointerTargetNode? Node) PlaceOnTarget(Vector2 point, PointerTargetRef target)
    {
        // A cached answer may miss an instance created since; it is safe for an event that lands, and is checked
        // again before any other decision.
        var (outcome, position, node) = Decide(point, target, _finder.Find(target.Scene, target.Path, fresh: false));
        if (outcome != Outcome.Landed)
        {
            (outcome, position, node) = Decide(point, target, _finder.Find(target.Scene, target.Path, fresh: true));
        }

        switch (outcome)
        {
            case Outcome.Landed: Stats.Landed++; break;
            case Outcome.Moved: Stats.Moved++; break;
            case Outcome.Ambiguous: Stats.Ambiguous++; break;
            default: Stats.Missing++; break;
        }

        return (position, node);
    }

    private enum Outcome { Landed, Moved, Missing, Ambiguous }

    private static (Outcome, Vector2, IPointerTargetNode?) Decide(
        Vector2 point, PointerTargetRef target, IReadOnlyList<IPointerTargetNode> candidates)
    {
        IPointerTargetNode? node = null;
        if (candidates.Count == 1)
        {
            node = candidates[0];
        }
        else if (candidates.Count > 1)
        {
            foreach (var candidate in candidates)
            {
                if (!candidate.IsAlive || !candidate.IsVisibleCanvasItem || !Lands(candidate, point, target.Local))
                {
                    continue;
                }

                if (node is not null)
                {
                    node = null;
                    break;
                }

                node = candidate;
            }

            if (node is null)
            {
                return (Outcome.Ambiguous, point, null);
            }
        }

        if (node is null || !node.IsAlive || !node.IsVisibleCanvasItem)
        {
            return (Outcome.Missing, point, null);
        }

        return Lands(node, point, target.Local)
            ? (Outcome.Landed, point, node)
            : (Outcome.Moved, node.CanvasTransform * target.Local, node);
    }

    internal static bool Lands(IPointerTargetNode node, Vector2 point, Vector2 local)
    {
        var xf = node.CanvasTransform;
        if (node.ControlSize is { } size)
        {
            if (xf.Determinant() == 0)
            {
                return false;
            }

            return new Rect2(Vector2.Zero, size).HasPoint(xf.AffineInverse() * point);
        }

        return (xf * local).DistanceTo(point) <= Tolerance;
    }
}

/// <summary>The node a message names: its instance scene, its path inside that instance, and the point in it.</summary>
internal readonly record struct PointerTargetRef(string Scene, string Path, Vector2 Local)
{
    /// <summary>The target a request carries, or null when it carries none (or an invalid one).</summary>
    public static PointerTargetRef? From(BrowserInputRequestEnvelope request)
    {
        if (string.IsNullOrEmpty(request.TargetScene) || string.IsNullOrEmpty(request.TargetPath)
            || request.LocalX is not { } x || request.LocalY is not { } y || !double.IsFinite(x) || !double.IsFinite(y))
        {
            return null;
        }

        return new PointerTargetRef(request.TargetScene, request.TargetPath, new Vector2((float)x, (float)y));
    }
}

/// <summary>Placement counters.</summary>
internal sealed class PointerTargetStats
{
    public long Landed;
    public long Moved;
    public long Missing;
    public long Ambiguous;
    public long Bound;

    public override string ToString()
        => $"landed={Landed} moved={Moved} missing={Missing} ambiguous={Ambiguous} bound={Bound}";
}
