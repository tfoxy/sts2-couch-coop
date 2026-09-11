using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-spine wire fields: the reader picks up the new SpineSkin (top-level, VOLATILE) + spine.skelResPath (in the
// spine block, STATIC), MergeNode retains the static one while the volatile one rides the upsert, and the change
// differ classifies both as Effects (a skin change re-requests the clip → never light-eligible).
internal static class SpineWireFieldsTests
{
    public static void Run()
    {
        ReadsSkinAndSkelResPath();
        MergeRetainsSkelUpdatesSkin();
        SkinChangeIsNotLightEligible();
        SkelChangeClassifiedOnKeyframe();
        MatIsVolatileAndNotLightEligible();
        SkelArrivingLateIsAnEffectsChange();
        PausedIsVolatileAndNotLightEligible();
    }

    private static MirrorNode Parse(string json)
    {
        var delta = SceneDeltaReader.Parse(json);
        Check.That(delta is not null, "delta parsed");
        Check.That(delta!.Upserts.Count == 1, "one upsert");
        return delta.Upserts[0];
    }

    private static void ReadsSkinAndSkelResPath()
    {
        var node = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/x.tscn","nodePath":"Vis/Spine","animations":["idle"],"skelResPath":"res://models/x.skel.tres"},
           "spineCurrentAnim":"idle","spineSkin":"poisoned"}]}
        """);
        Check.Equal(node.SpineSkin, "poisoned", "spineSkin parsed (top-level volatile)");
        Check.Equal(node.SpineSkelResPath, "res://models/x.skel.tres", "spine.skelResPath parsed (static)");
        Check.Equal(node.SpineSceneResPath, "res://scenes/x.tscn", "spine sceneResPath still parsed");

        // Absent → null (a non-spine node, or a producer that didn't capture the skin/skeleton).
        var plain = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"Card","nodeType":"NinePatchRect"}]}
        """);
        Check.Equal(plain.SpineSkin, (string?)null, "spineSkin null when absent");
        Check.Equal(plain.SpineSkelResPath, (string?)null, "spineSkelResPath null when absent");
    }

    private static void MergeRetainsSkelUpdatesSkin()
    {
        var existing = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/x.tscn","nodePath":"Vis/Spine","animations":["idle"],"skelResPath":"res://models/x.skel.tres"},
           "spineCurrentAnim":"idle","spineSkin":"a"}]}
        """);
        // Volatile-only upsert (no name, no spine block): a new skin, no skeleton.
        var upsert = Parse("""
        {"type":"scene-delta","full":false,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","spineCurrentAnim":"idle","spineSkin":"b"}]}
        """);

        var merged = SceneTreeApplier.MergeNode(existing, upsert);
        Check.Equal(merged.SpineSkin, "b", "volatile skin rides the upsert (updated)");
        Check.Equal(merged.SpineSkelResPath, "res://models/x.skel.tres", "static skelResPath retained across a volatile-only upsert");
        Check.Equal(merged.SpineSceneResPath, "res://scenes/x.tscn", "static spine scene retained");
    }

    private static void SkinChangeIsNotLightEligible()
    {
        var existing = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/x.tscn","nodePath":"Vis/Spine","animations":["idle"]},
           "spineCurrentAnim":"idle","spineSkin":"a"}]}
        """);
        var upsert = Parse("""
        {"type":"scene-delta","full":false,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","spineCurrentAnim":"idle","spineSkin":"b"}]}
        """);
        var merged = SceneTreeApplier.MergeNode(existing, upsert);
        var flags = NodeChangeDiffer.Classify(existing, merged, upsert);
        Check.That((flags & NodeChangeFlags.Effects) != 0, "a skin change is an Effects change");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "a skin change forces the full apply (re-request), not light");
    }

    private static void SkelChangeClassifiedOnKeyframe()
    {
        var prior = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/x.tscn","nodePath":"Vis/Spine","animations":["idle"],"skelResPath":"res://models/a.tres"},
           "spineCurrentAnim":"idle"}]}
        """);
        var current = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/x.tscn","nodePath":"Vis/Spine","animations":["idle"],"skelResPath":"res://models/b.tres"},
           "spineCurrentAnim":"idle"}]}
        """);
        var flags = NodeChangeDiffer.ClassifyKeyframe(prior, current);
        Check.That((flags & NodeChangeFlags.Effects) != 0, "a keyframe skelResPath change is an Effects change");
    }

    // #8: the shader-material signature is a VOLATILE top-level field like SpineSkin, and a change must force the
    // full apply — the client re-requests the clip under the new `&mat=` so a re-tinted boss map point re-bakes
    // instead of serving the first-baked tint from cache forever.
    private static void MatIsVolatileAndNotLightEligible()
    {
        var existing = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"SpineSprite","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/ui/boss_map_point.tscn","nodePath":"SpriteContainer/SpineSprite","animations":["animation"]},
           "spineCurrentAnim":"animation","spineMat":"0123456789abcdef"}]}
        """);
        Check.Equal(existing.SpineMat, "0123456789abcdef", "spineMat parsed (top-level volatile)");

        var plain = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"Card","nodeType":"NinePatchRect"}]}
        """);
        Check.Equal(plain.SpineMat, (string?)null, "spineMat null when absent (every node without a shader material)");

        // The node became travelable → NBossMapPoint pushed a new black_layer_color into the shared material.
        var upsert = Parse("""
        {"type":"scene-delta","full":false,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","spineCurrentAnim":"animation","spineMat":"fedcba9876543210"}]}
        """);
        var merged = SceneTreeApplier.MergeNode(existing, upsert);
        Check.Equal(merged.SpineMat, "fedcba9876543210", "volatile mat rides the upsert (updated)");
        var flags = NodeChangeDiffer.Classify(existing, merged, upsert);
        Check.That((flags & NodeChangeFlags.Effects) != 0, "a material change is an Effects change");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "a material change forces the full apply (re-request), not light");
    }

    // #9/#13: a RUNTIME-injected skeleton (the treasure chest, the boss map point) reports its ANIMATION first and
    // its skeleton path only once the producer's late-static re-probe re-ships the spine block. That re-ship must
    // classify as an Effects change, or the client never learns to re-request with `&skel=` and the node stays blank.
    private static void SkelArrivingLateIsAnEffectsChange()
    {
        var before = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"ChestVisual","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/rooms/treasure_room.tscn","nodePath":"ChestVisual","animations":[]},
           "spineCurrentAnim":"animation"}]}
        """);
        Check.Equal(before.SpineSkelResPath, (string?)null, "no skeleton path before the re-probe lands");

        var after = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"ChestVisual","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/rooms/treasure_room.tscn","nodePath":"ChestVisual","animations":["animation","shine_fade"],"skelResPath":"res://animations/props/act1_chest.tres"},
           "spineCurrentAnim":"animation"}]}
        """);
        var flags = NodeChangeDiffer.ClassifyKeyframe(before, after);
        Check.That((flags & NodeChangeFlags.Effects) != 0, "the late skeleton path (anim unchanged) is an Effects change");
    }

    // #13: the chest is SetAnimation("animation") + AddAnimation("shine_fade") + SetTimeScale(0), i.e. frozen on
    // the closed-chest first frame. Both clients free-run a clip off the wall clock, so the paused flag has to
    // reach the spine layer (Effects) or they walk the chest open and on into its queued glow.
    private static void PausedIsVolatileAndNotLightEligible()
    {
        var existing = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"ChestVisual","nodeType":"SpineSprite",
           "spine":{"sceneResPath":"res://scenes/rooms/treasure_room.tscn","nodePath":"Chest/ChestVisual","animations":["animation","shine_fade"]},
           "spineCurrentAnim":"animation","spinePaused":true,"spineTrackTime":0}]}
        """);
        Check.That(existing.SpinePaused, "spinePaused parsed (top-level volatile)");

        var plain = Parse("""
        {"type":"scene-delta","full":true,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","name":"Card","nodeType":"NinePatchRect"}]}
        """);
        Check.That(!plain.SpinePaused, "spinePaused false when absent (every running node)");

        // Opening the chest resumes the track with the anim name unchanged.
        var upsert = Parse("""
        {"type":"scene-delta","full":false,"screenType":"run","removedIds":[],"orderedIds":["7"],"upserts":[
          {"id":"7","spineCurrentAnim":"animation","spineTrackTime":0.02}]}
        """);
        var merged = SceneTreeApplier.MergeNode(existing, upsert);
        Check.That(!merged.SpinePaused, "volatile paused rides the upsert (resumed)");
        var flags = NodeChangeDiffer.Classify(existing, merged, upsert);
        Check.That((flags & NodeChangeFlags.Effects) != 0, "a pause/resume flip is an Effects change");
        Check.That(!NodeChangeDiffer.IsLightEligible(flags), "a pause/resume flip forces the full apply, not light");
    }
}
