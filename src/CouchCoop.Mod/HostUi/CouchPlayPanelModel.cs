using CouchCoop.Mod.Contracts;

namespace CouchCoop.Mod.HostUi;

internal sealed record CouchPlayOption(CouchPlayMode Mode, string LabelKey, string DescriptionKey)
{
    public string Key => Mode.ToString();
}

/// <summary>The host's mode choices and the centre card's disabled state, independent of the engine.</summary>
internal static class CouchPlayPanelModel
{
    public const string TitleKey = "couchcoop_couch_play_title";
    public const string EnableKey = "couchcoop_couch_play_enable";
    public const CouchPlayMode EnableMode = CouchPlayMode.SoloScreens;

    public static IReadOnlyList<CouchPlayOption> Options { get; } =
    [
        new(CouchPlayMode.Off, "couchcoop_couch_play_off", "couchcoop_couch_play_off_description"),
        new(CouchPlayMode.SoloScreens, "couchcoop_couch_play_solo", "couchcoop_couch_play_solo_description"),
        new(CouchPlayMode.EveryScreen, "couchcoop_couch_play_every", "couchcoop_couch_play_every_description"),
    ];

    public static CouchPlayOption Selected(CouchPlayMode mode)
        => Options.FirstOrDefault(option => option.Mode == mode) ?? Options[0];

    public static CouchPlayMode? Choose(string key)
        => Options.FirstOrDefault(option => option.Key == key)?.Mode;

    public static bool ShowsEnable(bool solo, CouchPlayMode mode) => solo && mode == CouchPlayMode.Off;
}
