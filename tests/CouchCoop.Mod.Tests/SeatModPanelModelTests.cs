using System.Text.RegularExpressions;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Session;

// The host's seat-mod panel: which mods it lists, what each row says, and what pressing one does.
//
// The panel itself is a Godot Panel and cannot be constructed here (see the rule above the pure suites in
// BrowserServerRouteTests), so every decision it draws lives in SeatModPanelModel and is asserted below —
// including the text: each row's copy is checked as a catalog KEY plus named arguments, never as resolved
// English, so the suite needs no game localization table and a reworded sentence does not break it.
//
// What is NOT covered here: that the panel paints what the model says, that the confirm button actually
// takes focus, and that a d-pad walks onto the rows. Those need an engine and a screenshot.
//
// The fixture is the maintainer's own machine, reduced to the cases that matter: a leaf with nothing
// depending on it (MintySpire2, the mod that crashed the seat), a library a gameplay mod needs (BaseLib), a
// gameplay mod (Downfall), and a three-deep chain of cosmetic mods for cascades.
internal static class SeatModPanelModelTests
{
    public static void Run()
    {
        GameplayModsAreNeverListedAndEverythingElseIs();
        EverythingStartsOn();
        ALockedRowNamesTheModThatLocksItAndDoesNotToggle();
        ALeafTurnsOffAtOnceAndOnlyItsIdIsStored();
        ATurnOffThatTakesOthersAsksFirstAndWritesNothing();
        AHeldOffRowNamesWhatTookItAndDoesNotToggle();
        TurningBackOnRestoresOnlyWhatTheCascadeTook();
        TheCascadePreviewLeavesOutWhatIsAlreadyOff();
        TurningOnAModAnotherChoiceStillHoldsSaysSoAtOnce();
        AConfirmThatNoLongerAppliesWritesNothing();
        ChoicesNoRowCanShowAreCarriedOverUntouched();
        IdsMatchWithoutRegardToCase();
        APanelWithNothingToOfferStaysHidden();
        RowNodeNamesAreStableAndGodotSafe();
        EveryKeyTheModelEmitsShipsWithTheSamePlaceholders();

        Console.WriteLine("SeatModPanelModelTests: ok");
    }

    private static readonly SeatModDescriptor Minty = Mod("MintySpire2", "Minty Spire 2");
    private static readonly SeatModDescriptor IntentGraph = Mod("intentgraph2", "Intent Graph");
    private static readonly SeatModDescriptor BaseLib = Mod("BaseLib", "BaseLib");
    private static readonly SeatModDescriptor Downfall = Mod("Downfall", "Downfall", gameplay: true, "BaseLib");
    private static readonly SeatModDescriptor UiLib = Mod("UiLib", "Ui Lib");
    private static readonly SeatModDescriptor Cards = Mod("PrettyCards", "Pretty Cards", gameplay: false, "UiLib");
    private static readonly SeatModDescriptor Extras = Mod("PrettyExtras", "Pretty Extras", gameplay: false, "PrettyCards");

    private static readonly IReadOnlyList<SeatModDescriptor> Machine = [Minty, IntentGraph, BaseLib, Downfall, UiLib, Cards, Extras];

    // Gameplay mods have no switch to offer: a seat with a different gameplay set is a desynchronised run. A
    // locked library IS listed, because a host hunting for the mod that crashes their players deserves to see
    // it and be told why it stays.
    private static void GameplayModsAreNeverListedAndEverythingElseIs()
    {
        var rows = SeatModPanelModel.Rows(Machine, []);
        Expect(!rows.Any(row => row.Id == Downfall.Id), "a gameplay mod is never listed");
        Expect(rows.Any(row => row.Id == BaseLib.Id), "a locked library is listed");
        Expect(
            rows.Select(row => row.Name).SequenceEqual(["BaseLib", "Intent Graph", "Minty Spire 2", "Pretty Cards", "Pretty Extras", "Ui Lib"]),
            $"rows come in name order so the list does not reshuffle between openings (got {string.Join(" | ", rows.Select(row => row.Name))})");

        var twice = SeatModPanelModel.Rows([Minty, Mod("mintyspire2", "Minty Spire 2 (local)")], []);
        Expect(twice.Count == 1, "an id installed twice is one switch, so one row — and one node name");

        var unnamed = SeatModPanelModel.Rows([Mod("bare-id", "  ")], []);
        Expect(unnamed.Single().Name == "bare-id", "a mod with no manifest name prints its id");
    }

    private static void EverythingStartsOn()
    {
        foreach (var row in SeatModPanelModel.Rows(Machine, []))
        {
            Expect(row.IsOn, $"{row.Id} is on until the host says otherwise");
            if (row.Id != BaseLib.Id)
            {
                Expect(row.State == SeatModRowState.On && row.Status.Key == SeatModPanelModel.RowOnKey,
                    $"{row.Id} reads On");
                Expect(row.Explanation is null, $"{row.Id} toggles, so it has nothing to explain");
            }
        }
    }

    // BaseLib declares affects_gameplay false and still has to stay: Downfall needs it. The row must say so and
    // NAME Downfall — "cannot be turned off" with no reason is not an explanation.
    private static void ALockedRowNamesTheModThatLocksItAndDoesNotToggle()
    {
        var row = RowOf(SeatModPanelModel.Rows(Machine, []), BaseLib.Id);
        Expect(row.State == SeatModRowState.Locked && row.IsOn, "a library a gameplay mod needs is locked on");
        Expect(row.LockedBy?.Id == Downfall.Id, "and the lock is the gameplay mod that needs it");
        ExpectText(row.Status, SeatModPanelModel.RowLockedKey, ("mod", "Downfall"));
        ExpectText(row.Explanation, SeatModPanelModel.DetailLockedKey, ("mod", "BaseLib"), ("dependent", "Downfall"));

        var press = SeatModPanelModel.Press(Machine, [], BaseLib.Id);
        Expect(press.Kind == SeatModPressKind.Explain && press.Next is null, "pressing a locked row changes nothing");
        ExpectText(press.Detail, SeatModPanelModel.DetailLockedKey, ("mod", "BaseLib"), ("dependent", "Downfall"));

        // Not a special case for BaseLib: once nothing gameplay-affecting needs it, it is an ordinary switch.
        var withoutDownfall = Machine.Where(mod => mod.Id != Downfall.Id).ToArray();
        Expect(RowOf(SeatModPanelModel.Rows(withoutDownfall, []), BaseLib.Id).State == SeatModRowState.On,
            "the same library is an ordinary switch once no gameplay mod needs it");
    }

    private static void ALeafTurnsOffAtOnceAndOnlyItsIdIsStored()
    {
        var press = SeatModPanelModel.Press(Machine, [], Minty.Id);
        Expect(press.Kind == SeatModPressKind.TurnOff, "a mod nothing depends on turns off without a prompt");
        Expect(press.Next is { Count: 1 } next && next.Contains(Minty.Id), "and exactly its id is written");
        Expect(press.Detail is null, "with nothing to explain afterwards");

        var row = RowOf(SeatModPanelModel.Rows(Machine, press.Next!), Minty.Id);
        Expect(row.State == SeatModRowState.Off && !row.IsOn, "the row then reads Off");
        ExpectText(row.Status, SeatModPanelModel.RowOffKey);

        var back = SeatModPanelModel.Press(Machine, press.Next!, Minty.Id);
        Expect(back.Kind == SeatModPressKind.TurnOn && back.Next is { Count: 0 }, "pressing it again turns it back on");
    }

    // The cascade is shown BEFORE anything goes: the prompt lists what would go with it, and nothing is written
    // until the host confirms. The confirm then stores the one mod they chose, never the ones it took.
    private static void ATurnOffThatTakesOthersAsksFirstAndWritesNothing()
    {
        var press = SeatModPanelModel.Press(Machine, [], UiLib.Id);
        Expect(press.Kind == SeatModPressKind.ConfirmTurnOff, "a turn-off that takes other mods asks first");
        Expect(press.Next is null, "and writes nothing while it asks");
        Expect(press.Cascade.Select(mod => mod.Id).SequenceEqual([Cards.Id, Extras.Id]),
            "the prompt lists every mod that would go, transitively, in name order");
        ExpectText(press.Detail, SeatModPanelModel.ConfirmPromptKey, ("mod", "Ui Lib"), ("mods", "Pretty Cards, Pretty Extras"));

        var confirmed = SeatModPanelModel.Confirm(Machine, [], UiLib.Id);
        Expect(confirmed.Kind == SeatModPressKind.TurnOff, "confirming turns it off");
        Expect(confirmed.Next is { Count: 1 } next && next.Contains(UiLib.Id),
            "and stores only the host's own choice — the cascade is derived on every read, never written");

        var rows = SeatModPanelModel.Rows(Machine, confirmed.Next!);
        Expect(RowOf(rows, UiLib.Id).State == SeatModRowState.Off, "the chosen mod is off");
        Expect(RowOf(rows, Cards.Id).State == SeatModRowState.OffWithDependency
            && RowOf(rows, Extras.Id).State == SeatModRowState.OffWithDependency,
            "and everything that needs it is off with it");
    }

    private static void AHeldOffRowNamesWhatTookItAndDoesNotToggle()
    {
        var chosen = Set(UiLib.Id);
        var row = RowOf(SeatModPanelModel.Rows(Machine, chosen), Extras.Id);
        Expect(!row.IsOn && row.OffWith.Select(mod => mod.Id).SequenceEqual([UiLib.Id]),
            "a mod held off by a cascade names the choice that took it — the one to turn back on, not the nearest link");
        ExpectText(row.Status, SeatModPanelModel.RowOffWithKey, ("mods", "Ui Lib"));
        ExpectText(row.Explanation, SeatModPanelModel.DetailOffWithKey, ("mod", "Pretty Extras"), ("mods", "Ui Lib"));

        var press = SeatModPanelModel.Press(Machine, chosen, Extras.Id);
        Expect(press.Kind == SeatModPressKind.Explain && press.Next is null,
            "pressing it explains instead of toggling: on alone, it would load without what it needs");
        ExpectText(press.Detail, SeatModPanelModel.DetailOffWithKey, ("mod", "Pretty Extras"), ("mods", "Ui Lib"));

        // Two independent choices each hold it; both have to come back, so both are named.
        var both = RowOf(SeatModPanelModel.Rows(Machine, Set(UiLib.Id, Cards.Id)), Extras.Id);
        Expect(both.OffWith.Select(mod => mod.Id).SequenceEqual([Cards.Id, UiLib.Id]), "every choice holding it is named");
    }

    // The behaviour the host asked for, and the reason only explicit choices are stored: re-enabling a mod
    // brings back what its cascade took, while a mod the host switched off deliberately stays off.
    private static void TurningBackOnRestoresOnlyWhatTheCascadeTook()
    {
        var chosen = Set(UiLib.Id, Extras.Id);
        var before = SeatModPanelModel.Rows(Machine, chosen);
        Expect(RowOf(before, Extras.Id).State == SeatModRowState.Off,
            "a mod the host chose reads as their choice even while a cascade covers it too");

        var press = SeatModPanelModel.Press(Machine, chosen, UiLib.Id);
        Expect(press.Kind == SeatModPressKind.TurnOn && press.Next is { Count: 1 } next && next.Contains(Extras.Id),
            "turning the library back on removes only its own entry");

        var after = SeatModPanelModel.Rows(Machine, press.Next!);
        Expect(RowOf(after, UiLib.Id).State == SeatModRowState.On, "the library is back");
        Expect(RowOf(after, Cards.Id).State == SeatModRowState.On, "what only its cascade took is back with it");
        Expect(RowOf(after, Extras.Id).State == SeatModRowState.Off, "the host's own choice stays off");
    }

    private static void TheCascadePreviewLeavesOutWhatIsAlreadyOff()
    {
        var press = SeatModPanelModel.Press(Machine, Set(Extras.Id), UiLib.Id);
        Expect(press.Kind == SeatModPressKind.ConfirmTurnOff && press.Cascade.Select(mod => mod.Id).SequenceEqual([Cards.Id]),
            "a mod that is already off is not news, so the prompt leaves it out");

        // Everything that needs it is already off: nothing else would change, so nothing to confirm.
        var quiet = SeatModPanelModel.Press(Machine, Set(Cards.Id), UiLib.Id);
        Expect(quiet.Kind == SeatModPressKind.TurnOff, "a turn-off that takes nothing new goes through at once");
    }

    // Removing the host's own choice can leave a mod off anyway, held by another. The press that did it says so,
    // rather than leaving the host looking at a row that did not move.
    private static void TurningOnAModAnotherChoiceStillHoldsSaysSoAtOnce()
    {
        var press = SeatModPanelModel.Press(Machine, Set(UiLib.Id, Cards.Id), Cards.Id);
        Expect(press.Kind == SeatModPressKind.TurnOn && press.Next is { Count: 1 } next && next.Contains(UiLib.Id),
            "the host's own entry is removed");
        ExpectText(press.Detail, SeatModPanelModel.DetailOffWithKey, ("mod", "Pretty Cards"), ("mods", "Ui Lib"));
    }

    private static void AConfirmThatNoLongerAppliesWritesNothing()
    {
        var alreadyOff = SeatModPanelModel.Confirm(Machine, Set(UiLib.Id), UiLib.Id);
        Expect(alreadyOff.Kind == SeatModPressKind.None && alreadyOff.Next is null, "confirming a mod that is already off writes nothing");
        var locked = SeatModPanelModel.Confirm(Machine, [], BaseLib.Id);
        Expect(locked.Kind == SeatModPressKind.None && locked.Next is null, "confirming a locked mod writes nothing");
        var unknown = SeatModPanelModel.Press(Machine, [], "not-installed");
        Expect(unknown.Kind == SeatModPressKind.None && unknown.Next is null, "an id with no row does nothing");
        var gameplay = SeatModPanelModel.Press(Machine, [], Downfall.Id);
        Expect(gameplay.Kind == SeatModPressKind.None && gameplay.Next is null, "a gameplay mod cannot be pressed off");
    }

    // The store's policy, not the panel's: an id this machine no longer has, and a choice a new gameplay
    // subscription has overridden, are both written back exactly as they were read. Resolve already declines to
    // apply them, and the second shows as locked in the meantime.
    private static void ChoicesNoRowCanShowAreCarriedOverUntouched()
    {
        var chosen = Set("uninstalled-mod", BaseLib.Id);
        var rows = SeatModPanelModel.Rows(Machine, chosen);
        Expect(RowOf(rows, BaseLib.Id).State == SeatModRowState.Locked, "an overridden choice shows as locked, and on");

        var press = SeatModPanelModel.Press(Machine, chosen, Minty.Id);
        Expect(press.Next is { } next && next.SetEquals(["uninstalled-mod", BaseLib.Id, Minty.Id]),
            "a press adds its own id and carries every other stored id over unchanged");
    }

    private static void IdsMatchWithoutRegardToCase()
    {
        var chosen = Set("MINTYSPIRE2");
        Expect(RowOf(SeatModPanelModel.Rows(Machine, chosen), Minty.Id).State == SeatModRowState.Off,
            "a stored id matches its mod whatever its case");
        var press = SeatModPanelModel.Press(Machine, chosen, "mintyspire2");
        Expect(press.Kind == SeatModPressKind.TurnOn && press.Next is { Count: 0 },
            "and turning it back on removes it whatever case either side used");
    }

    // A vanilla install, or one with only gameplay mods, has nothing to decide: no rows means no panel, exactly
    // as the connection card hides with no rows.
    private static void APanelWithNothingToOfferStaysHidden()
    {
        Expect(SeatModPanelModel.Rows([], []).Count == 0, "no inventory, no rows");
        Expect(SeatModPanelModel.Rows([Downfall, Mod("sts2unlimited", "Unlimited", gameplay: true)], []).Count == 0,
            "gameplay mods alone leave nothing to list");
        Expect(SeatModPanelModel.Rows([BaseLib, Downfall], []).Count == 1,
            "a single locked library is still something to show");
    }

    private static void RowNodeNamesAreStableAndGodotSafe()
    {
        Expect(SeatModPanelModel.RowNodeName("MintySpire2") == "CouchCoopSeatModRow_MintySpire2",
            "a plain id is the QA-stable node name as it stands");
        Expect(SeatModPanelModel.RowNodeName("com.example:mod@2/\"x\"%") == "CouchCoopSeatModRow_com_example_mod_2__x__",
            "the characters Godot refuses in a node name become underscores instead of an engine-chosen rename");
        Expect(RowOf(SeatModPanelModel.Rows(Machine, []), Minty.Id).NodeName == "CouchCoopSeatModRow_MintySpire2",
            "rows carry their node name");
    }

    // The model names its copy by key; this proves each key ships in English with exactly the named arguments the
    // model supplies. (Parity across the other thirteen catalogs is CouchCoopLocalizationTests' job.)
    private static void EveryKeyTheModelEmitsShipsWithTheSamePlaceholders()
    {
        var english = CouchCoopLocalization.CatalogFor(CouchCoopLocalization.EnglishLanguage);
        foreach (var key in SeatModPanelModel.StandingCopyKeys)
        {
            Expect(english.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value), $"{key} ships in English");
            Expect(!Placeholders(value!).Any(), $"{key} is standing copy and takes no arguments");
        }

        var emitted = new List<CouchCoopText>();
        foreach (var chosen in new[] { Set(), Set(UiLib.Id), Set(UiLib.Id, Extras.Id) })
        {
            foreach (var row in SeatModPanelModel.Rows(Machine, chosen))
            {
                emitted.Add(row.Status);
                if (row.Explanation is { } explanation) emitted.Add(explanation);
                if (SeatModPanelModel.Press(Machine, chosen, row.Id).Detail is { } detail) emitted.Add(detail);
            }
        }

        foreach (var key in new[]
        {
            SeatModPanelModel.RowOnKey, SeatModPanelModel.RowOffKey, SeatModPanelModel.RowLockedKey,
            SeatModPanelModel.RowOffWithKey, SeatModPanelModel.DetailLockedKey, SeatModPanelModel.DetailOffWithKey,
            SeatModPanelModel.ConfirmPromptKey,
        })
        {
            Expect(emitted.Any(text => text.Key == key), $"the fixture exercises {key}");
        }

        foreach (var text in emitted)
        {
            Expect(text.Key.StartsWith("couchcoop_seatmods_", StringComparison.Ordinal), $"{text.Key} is in the panel's namespace");
            Expect(english.TryGetValue(text.Key, out var template) && !string.IsNullOrWhiteSpace(template), $"{text.Key} ships in English");
            var expected = Placeholders(template!).Distinct().Order().ToArray();
            var supplied = text.Arguments.Keys.Order().ToArray();
            Expect(expected.SequenceEqual(supplied),
                $"{text.Key} is given exactly the arguments its template names (template [{string.Join(",", expected)}], given [{string.Join(",", supplied)}])");
        }
    }

    private static SeatModDescriptor Mod(string id, string name, bool gameplay = false, params string[] dependencies)
        => new(id, CouchCoopModBuildIdentity.WorkshopModSource, name, gameplay, dependencies);

    private static HashSet<string> Set(params string[] ids) => new(ids, SeatModSelectionPlan.IdComparer);

    private static SeatModRowView RowOf(IReadOnlyList<SeatModRowView> rows, string id)
        => rows.FirstOrDefault(row => SeatModSelectionPlan.IdComparer.Equals(row.Id, id))
            ?? throw new InvalidOperationException($"SeatModPanelModelTests failed: no row for {id}");

    private static void ExpectText(CouchCoopText? text, string key, params (string Name, string Value)[] arguments)
    {
        Expect(text is { } value && value.Key == key, $"the text is {key} (got {text?.Key ?? "none"})");
        var actual = text!.Value.Arguments;
        Expect(actual.Count == arguments.Length, $"{key} carries {arguments.Length} argument(s) (got {actual.Count})");
        foreach (var (name, expected) in arguments)
        {
            Expect(actual.TryGetValue(name, out var argument) && argument.Literal == expected,
                $"{key} names {name}={expected} (got {(actual.TryGetValue(name, out var got) ? got.Literal : "nothing")})");
        }
    }

    private static IEnumerable<string> Placeholders(string value)
        => Regex.Matches(value, "\\{([^\\s{}]+)\\}").Select(match => match.Groups[1].Value);

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"SeatModPanelModelTests failed: {because}");
        }
    }
}
