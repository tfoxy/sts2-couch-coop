using CouchCoop.MirrorProtocol.Input;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for EndTurnScan — the pure scene-file box lookup behind GestureCallbacks.EndTurnBoxAt (R4 change 2).
// Fixture style mirrors InteractiveRectScanTests (local-space state + GlobalTransformIndex + an F=1 SpreadIndex
// stub). The button is identified by the owning scene's file SUFFIX (end_turn_button.tscn) via SceneIdentity, and
// the box is the UNION game-space AABB of every eligible InteractiveRectScan rect that scene owns. Web twin:
// mirrorRenderer.spec's endTurnBoxAt test.
internal static class EndTurnScanTests
{
    private const string EndTurnScene = "res://scenes/combat/end_turn_button.tscn";

    public static void Run()
    {
        InsidePointReturnsComposedGameBox();
        OutsidePointReturnsNull();
        NoEndTurnSceneReturnsNull();
        HiddenEndTurnReturnsNull();
        UnionCoversEveryRectTheSceneOwns();
    }

    // ---- fixture helpers (InteractiveRectScanTests style) ----

    private static MirrorNode Node(
        string id,
        string? parent,
        double x,
        double y,
        double w = 0,
        double h = 0,
        int? mouseFilter = null,
        bool visible = true,
        string? sceneFile = null,
        string name = "") =>
        new()
        {
            Id = id,
            ParentId = parent,
            NodeType = "Control",
            Name = name,
            Visible = visible,
            MouseFilter = mouseFilter,
            SceneFilePath = sceneFile,
            Transform = [1, 0, 0, 1, x, y],
            LocalRect = w > 0 && h > 0 ? new MirrorRect(0, 0, w, h) : null,
        };

    private static (MirrorState State, GlobalTransformIndex Transforms, SpreadIndex Spread) Scene(params MirrorNode[] nodes)
    {
        var state = MirrorState.Create();
        foreach (var n in nodes)
        {
            state.Nodes[n.Id] = n;
            state.OrderedIds.Add(n.Id);
            state.ChangedIds.Add(n.Id);
        }

        state.Revision++;

        var transforms = new GlobalTransformIndex();
        transforms.Update(state);

        var spread = new SpreadIndex();
        spread.Update(state, transforms, 1); // F=1 stub → no spread records (16:9)
        return (state, transforms, spread);
    }

    // ---- tests ----

    // The end-turn root under an OFFSET parent: the box comes back in COMPOSED game space (hud 100,900 + local
    // 1500,80 → global 1600,980), and a point inside it returns the box.
    private static void InsidePointReturnsComposedGameBox()
    {
        var (s, t, sp) = Scene(
            Node("hud", null, 100, 900),
            Node("scene", "hud", 1500, 80, 280, 80, mouseFilter: 0, sceneFile: EndTurnScene, name: "EndTurnButton"));
        var box = EndTurnScan.BoxAt(s, t, sp, 1740, 1000);
        Check.That(box is not null, "a point inside the end-turn box returns it");
        Check.Close(box!.Value.MinX, 1600, "box MinX composed through the parent chain");
        Check.Close(box.Value.MinY, 980, "box MinY");
        Check.Close(box.Value.MaxX, 1880, "box MaxX");
        Check.Close(box.Value.MaxY, 1060, "box MaxY");
        Check.Close(box.Value.CenterX, 1740, "CenterX is the horizontal middle");
    }

    private static void OutsidePointReturnsNull()
    {
        var (s, t, sp) = Scene(
            Node("scene", null, 1600, 980, 280, 80, mouseFilter: 0, sceneFile: EndTurnScene, name: "EndTurnButton"));
        Check.That(EndTurnScan.BoxAt(s, t, sp, 1740, 900) is null, "a point above the box misses (null)");
        Check.That(EndTurnScan.BoxAt(s, t, sp, 100, 1000) is null, "a point left of the box misses (null)");
    }

    private static void NoEndTurnSceneReturnsNull()
    {
        // An eligible Stop control owned by a DIFFERENT scene never matches (scene-file suffix gate).
        var (s, t, sp) = Scene(
            Node("scene", null, 1600, 980, 280, 80, mouseFilter: 0, sceneFile: "res://scenes/combat/draw_pile.tscn"));
        Check.That(EndTurnScan.BoxAt(s, t, sp, 1740, 1000) is null, "no end-turn scene on screen → null");
    }

    private static void HiddenEndTurnReturnsNull()
    {
        // Out of combat the button is hidden: an invisible (or ancestor-hidden) control never emits a rect.
        var (s, t, sp) = Scene(
            Node("scene", null, 1600, 980, 280, 80, mouseFilter: 0, visible: false, sceneFile: EndTurnScene));
        Check.That(EndTurnScan.BoxAt(s, t, sp, 1740, 1000) is null, "a hidden end-turn button → null");
    }

    // The box is the UNION over every eligible rect the scene owns — so it never matters whether the mouse-visible
    // Control is the root or a descendant (a Label-only box would under-report the button height and park the
    // cursor still ON it). Root here is a boxless container; Visuals + Label (both mouse-visible) union to the
    // full 1600..1880 × 980..1060 button.
    private static void UnionCoversEveryRectTheSceneOwns()
    {
        var (s, t, sp) = Scene(
            Node("scene", null, 1600, 980, sceneFile: EndTurnScene, name: "EndTurnButton"),
            Node("visuals", "scene", 0, 0, 280, 60, mouseFilter: 0, name: "Visuals"),
            Node("label", "scene", 20, 60, 240, 20, mouseFilter: 1, name: "Label"));
        var box = EndTurnScan.BoxAt(s, t, sp, 1700, 1050); // inside only the LABEL band — still returns the union
        Check.That(box is not null, "a point inside any owned rect region of the union hits");
        Check.Close(box!.Value.MinX, 1600, "union MinX (Visuals' left edge)");
        Check.Close(box.Value.MinY, 980, "union MinY (Visuals' top edge)");
        Check.Close(box.Value.MaxX, 1880, "union MaxX");
        Check.Close(box.Value.MaxY, 1060, "union MaxY (Label's bottom edge extends past Visuals)");
    }
}
