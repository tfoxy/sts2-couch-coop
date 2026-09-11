using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// The shared background scene-path grammar (BackgroundSceneFamilies): the STRICT event id parse that mints
// /bg/events/<id> URLs must accept exactly what BuildEventBackgroundScenePath can rebuild, and the LOOSE
// pattern matcher must keep SpreadIndex's historical substring behavior.
internal static class BackgroundSceneFamiliesTests
{
    public static void Run()
    {
        EventIdRoundTrips();
        RejectsForeignConventions();
        PatternMatcherKeepsSpreadBehavior();
        RoomTableRoundTrips();
    }

    private static void RoomTableRoundTrips()
    {
        Check.Equal(
            BackgroundSceneFamilies.TryParseRoomBackgroundId("res://scenes/rooms/merchant_room.tscn"),
            "merchant_room",
            "the table room parses to its id");
        Check.Equal(
            BackgroundSceneFamilies.BuildRoomScenePath("merchant_room"),
            "res://scenes/rooms/merchant_room.tscn",
            "…and rebuilds byte-for-byte");
        Check.Equal(
            BackgroundSceneFamilies.RoomBackgroundSubtrees["res://scenes/rooms/merchant_room.tscn"],
            "SceneContainer/BgContainer",
            "the committed subtree path is the one the shop mounts");
        Check.That(
            BackgroundSceneFamilies.TryParseRoomBackgroundId("res://scenes/rooms/rest_site_room.tscn") is null,
            "rooms OUTSIDE the table never parse (the table IS the membership)");
        Check.That(
            BackgroundSceneFamilies.TryParseRoomBackgroundId(null) is null,
            "null is rejected");
    }

    private static void EventIdRoundTrips()
    {
        foreach (var id in new[] { "neow", "tezcatara", "darv", "nonupeipe", "the_city_2" })
        {
            var path = BackgroundSceneFamilies.BuildEventBackgroundScenePath(id);
            Check.Equal(path, $"res://scenes/events/background_scenes/{id}.tscn", $"built path for {id}");
            Check.Equal(BackgroundSceneFamilies.TryParseEventBackgroundId(path), id, $"round-trip {id}");
        }
    }

    private static void RejectsForeignConventions()
    {
        // Combat convention, sub-resources, nested paths, wrong casing/alphabet, non-scenes.
        foreach (var path in new[]
                 {
                     null,
                     "",
                     "res://scenes/backgrounds/glory/glory_background.tscn",
                     "res://scenes/events/background_scenes/neow_water_reflection.gdshader",
                     "res://scenes/events/background_scenes/neow/props.tscn",
                     "res://scenes/events/background_scenes/Neow.tscn",
                     "res://scenes/events/background_scenes/.tscn",
                     "res://scenes/events/ancient_event_layout.tscn",
                 })
        {
            Check.That(
                BackgroundSceneFamilies.TryParseEventBackgroundId(path) is null,
                $"rejects {path ?? "<null>"}");
        }
    }

    private static void PatternMatcherKeepsSpreadBehavior()
    {
        // Substring + case-insensitive (a streamed SceneFilePath may be any casing), including the legacy
        // belt-and-braces "tezcatara" and paths the STRICT parse rejects (sub-scenes still ride the spread family).
        Check.That(
            BackgroundSceneFamilies.MatchesEventBackgroundPattern("res://scenes/events/background_scenes/neow.tscn"),
            "directory match");
        Check.That(
            BackgroundSceneFamilies.MatchesEventBackgroundPattern("res://scenes/Events/Background_Scenes/pael.tscn"),
            "case-insensitive");
        Check.That(
            BackgroundSceneFamilies.MatchesEventBackgroundPattern("res://scenes/other/tezcatara_extra.tscn"),
            "legacy tezcatara substring");
        Check.That(
            BackgroundSceneFamilies.MatchesEventBackgroundPattern("res://scenes/events/background_scenes/neow/props.tscn"),
            "nested sub-scene still rides the family");
        Check.That(
            !BackgroundSceneFamilies.MatchesEventBackgroundPattern("res://scenes/backgrounds/glory/glory_background.tscn"),
            "combat convention excluded");
    }
}
