using CouchCoop.Mod.Contracts;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;

internal static class CouchPlayPanelModelTests
{
    public static void Run()
    {
        Expect(CouchPlayPanelModel.Options.Select(option => option.Mode).SequenceEqual(
            new[] { CouchPlayMode.Off, CouchPlayMode.SoloScreens, CouchPlayMode.EveryScreen }), "three ordered choices");
        Expect(CouchPlayPanelModel.EnableMode == CouchPlayMode.SoloScreens, "enable chooses Solo screens");
        foreach (var option in CouchPlayPanelModel.Options)
        {
            Expect(CouchPlayPanelModel.Choose(option.Key) == option.Mode, "press chooses stable mode");
            Expect(CouchPlayPanelModel.Selected(option.Mode) == option, "selection follows mode");
            Expect(CouchPlayPanelModel.ShowsEnable(true, option.Mode) == (option.Mode == CouchPlayMode.Off), "solo Off shows enable");
            Expect(!CouchPlayPanelModel.ShowsEnable(false, option.Mode), "multiplayer always shows QR");
        }
        Expect(CouchPlayPanelModel.Choose("unknown") is null, "unknown selection cannot change the store");
        Expect(CouchPlayPanelModel.Choose("1") is null, "numeric enum spelling is not a choice");
        Expect(CouchPlayPanelModel.Selected((CouchPlayMode)99).Mode == CouchPlayMode.Off, "unknown mode displays Off");
        var english = CouchCoopLocalization.CatalogFor("eng");
        Expect(CouchPlayPanelModel.Options.Select(option => english[option.LabelKey]).SequenceEqual(
            new[] { "Off", "Solo screens", "Every screen" }), "agreed mode labels");
        Expect(CouchPlayPanelModel.Options.Select(option => english[option.DescriptionKey]).SequenceEqual(new[]
        {
            "Phones can't join single player.",
            "Phones play your solo runs and character select, pause menu included.",
            "Phones see and control every screen, main menu and Settings included.",
        }), "descriptions state each mode's reach");
        Console.WriteLine("CouchPlayPanelModelTests: 19 checks ok");
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition) throw new InvalidOperationException($"CouchPlayPanelModelTests failed: {because}");
    }
}
