namespace CouchCoop.MirrorProtocol.SceneModel;

/// <summary>
/// The TWO background scene-path conventions the mirror knows, in one place so the spread index, the static
/// background provider/tracker (Mod) and the frontend twins cannot drift apart:
///
///   - COMBAT:  <c>res://scenes/backgrounds/&lt;id&gt;/&lt;id&gt;_background.tscn</c> (directory name == file stem;
///     per-layer sub-scenes live one directory deeper and must NOT match). Parsed by the Mod's
///     CouchCoopStaticBackgroundProvider.TryParseBackgroundId, which delegates its id alphabet to
///     <see cref="IsValidBackgroundId"/> here.
///   - EVENT:   <c>res://scenes/events/background_scenes/&lt;id&gt;.tscn</c> — the per-event backdrop family
///     (neow, darv, orobas, pael, tanx, vakuu, nonupeipe, tezcatara ship today). Disjoint from the combat
///     convention by directory.
///
/// The frontend twin of the EVENT patterns is mirrorRenderer's EVENT_BG_SCENE_PATTERNS / the /bg/events wire
/// grammar in StaticBackground.vue; keep them in sync by hand (there is no codegen across the TS/C# boundary).
/// </summary>
public static class BackgroundSceneFamilies
{
    /// <summary>The event-backdrop scene directory (spirectl's EventBackgroundScenePrefix twin).</summary>
    public const string EventBackgroundScenePrefix = "res://scenes/events/background_scenes/";

    private const string SceneSuffix = ".tscn";

    // Substrings that identify an EVENT background-scene root by SceneFilePath (the SpreadIndex matcher, moved
    // here verbatim). The directory segment is the real discriminator; the legacy "tezcatara" substring is
    // retained (subsumed by the directory match, but harmless and event-specific) for belt-and-braces safety.
    private static readonly string[] EventBackgroundSceneFilePatterns =
    {
        "events/background_scenes/",
        "tezcatara",
    };

    /// <summary>
    /// Loose family membership by substring, case-insensitive — the spread-branch matcher (a streamed
    /// SceneFilePath may be any casing). Use <see cref="TryParseEventBackgroundId"/> when minting ids/URLs;
    /// this is for "does this node ride the event-backdrop spread/suppression family" decisions.
    /// </summary>
    public static bool MatchesEventBackgroundPattern(string sceneFilePath)
    {
        foreach (var pattern in EventBackgroundSceneFilePatterns)
        {
            if (sceneFilePath.Contains(pattern, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The event-background id for a scene path following the STRICT event convention
    /// <c>res://scenes/events/background_scenes/&lt;id&gt;.tscn</c>, else null. Exact-prefix and single-segment
    /// on purpose (no nested directories, no non-.tscn resources): this is the reversible half that mints
    /// <c>/bg/events/&lt;id&gt;</c> URLs, so it must only accept what
    /// <see cref="BuildEventBackgroundScenePath"/> can rebuild byte-for-byte.
    /// </summary>
    public static string? TryParseEventBackgroundId(string? scenePath)
    {
        if (scenePath is null
            || !scenePath.StartsWith(EventBackgroundScenePrefix, StringComparison.Ordinal)
            || !scenePath.EndsWith(SceneSuffix, StringComparison.Ordinal))
        {
            return null;
        }

        var id = scenePath[EventBackgroundScenePrefix.Length..^SceneSuffix.Length];
        return id.Contains('/') || !IsValidBackgroundId(id) ? null : id;
    }

    /// <summary>The exact scene path <see cref="TryParseEventBackgroundId"/> parsed the id out of.</summary>
    public static string BuildEventBackgroundScenePath(string id)
        => EventBackgroundScenePrefix + id + SceneSuffix;

    /// <summary>
    /// Whether <paramref name="id"/> is a plausible background id (lowercase snake_case / digits) — the shared
    /// alphabet for every family's ids and URLs.
    /// </summary>
    public static bool IsValidBackgroundId(string id)
        => id.Length > 0 && id.All(ch => char.IsAsciiLetterLower(ch) || char.IsAsciiDigit(ch) || ch == '_');

    /// <summary>
    /// The ROOMS family: screens whose backdrop is not a mounted scene but an INLINE subtree of the room scene
    /// itself. The merchant shop inlines its whole backdrop (spine, fire shader sprites, particles) under
    /// <c>SceneContainer/BgContainer</c>, with the interactive merchant button/inventory OUTSIDE it — so the
    /// still replaces exactly that subtree and the shop stays fully interactive. One committed table on BOTH
    /// sides (the frontend twin is mirrorRenderer's ROOM_BG_SUBTREES) — the resource paths the mod needs to
    /// address, nothing more.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> RoomBackgroundSubtrees =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["res://scenes/rooms/merchant_room.tscn"] = "SceneContainer/BgContainer",
        };

    private const string RoomScenePrefix = "res://scenes/rooms/";

    /// <summary>The room-background id for a scene path IN THE TABLE (reversible), else null.</summary>
    public static string? TryParseRoomBackgroundId(string? scenePath)
    {
        if (scenePath is null
            || !RoomBackgroundSubtrees.ContainsKey(scenePath)
            || !scenePath.StartsWith(RoomScenePrefix, StringComparison.Ordinal)
            || !scenePath.EndsWith(SceneSuffix, StringComparison.Ordinal))
        {
            return null;
        }

        var id = scenePath[RoomScenePrefix.Length..^SceneSuffix.Length];
        return IsValidBackgroundId(id) ? id : null;
    }

    /// <summary>The exact scene path <see cref="TryParseRoomBackgroundId"/> parsed the id out of.</summary>
    public static string BuildRoomScenePath(string id) => RoomScenePrefix + id + SceneSuffix;
}
