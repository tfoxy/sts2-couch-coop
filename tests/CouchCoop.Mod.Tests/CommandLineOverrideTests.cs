using CouchCoop.Mod.Patches;

// The override table that replaced FastmpPatch. Two properties matter and both are regressions waiting to happen:
//
//  1. A HOST must get an EMPTY table. The old patch answered HasArg("fastmp")==true for every instance, which the
//     game reads as "use ENet, not Steam" — that is exactly what made a real Steam session impossible. If this
//     table is ever non-empty on a host, normal hosting silently breaks again.
//  2. A headless SEAT must get fastmp="join" so the game's own auto-join path runs with no CLI args at all, plus
//     clientId when (and only when) a netId was handed to it — an empty/blank value must fall through to the
//     game's own default rather than being injected as garbage.
//
// Pure dictionary logic; no environment, no Harmony, no game.
internal static class CommandLineOverrideTests
{
    public static void Run()
    {
        HostGetsNoOverridesAtAll();
        SeatGetsJoinAndClientId();
        BlankClientIdIsOmitted();
        ClientIdIsTrimmed();
    }

    private static void HostGetsNoOverridesAtAll()
    {
        var table = CommandLineOverridePatch.BuildOverrides(isHeadlessClient: false, clientId: "1002");
        Assert(table.Count == 0, "a host gets an EMPTY override table (it must host normally, Steam included)");
        Assert(!table.ContainsKey("fastmp"),
            "a host never reports -fastmp (that flag forces PlatformType.None and kills real Steam hosting)");
    }

    private static void SeatGetsJoinAndClientId()
    {
        var table = CommandLineOverridePatch.BuildOverrides(isHeadlessClient: true, clientId: "1003");
        Assert(table.TryGetValue("fastmp", out var fastmp) && fastmp == "join",
            "a headless seat reports fastmp=join (drives the game's own ENet auto-join with no CLI args)");
        Assert(table.TryGetValue("clientId", out var clientId) && clientId == "1003",
            "a headless seat reports its netId as clientId");
        Assert(table.Count == 2, "the seat table carries exactly the two entries the game reads");
    }

    private static void BlankClientIdIsOmitted()
    {
        foreach (var blank in new string?[] { null, "", "   " })
        {
            var table = CommandLineOverridePatch.BuildOverrides(isHeadlessClient: true, clientId: blank);
            Assert(table.ContainsKey("fastmp"), "a seat still joins when no netId was supplied");
            Assert(!table.ContainsKey("clientId"),
                "a blank netId is OMITTED so the game's own clientId default applies (never injected blank)");
        }
    }

    private static void ClientIdIsTrimmed()
    {
        var table = CommandLineOverridePatch.BuildOverrides(isHeadlessClient: true, clientId: " 1004\n");
        Assert(table["clientId"] == "1004", "the netId is trimmed (env values pick up stray whitespace)");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[CommandLineOverrideTests] FAILED: {label}");
        }
    }
}
