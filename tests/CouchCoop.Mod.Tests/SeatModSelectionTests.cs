using System.Text;
using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Session;

// Which mods a host may switch off for the seats it spawns, and whether a seat is actually launched that way.
//
// A seat runs under Godot's headless dummy renderer, and a mod that instantiates visual resources can kill it
// outright. The host gets a switch — but only for mods that declare no gameplay effect AND on which nothing
// gameplay-affecting depends, because a seat running a different gameplay mod set than its host is a
// desynchronised run. Five layers, all pure or temp-directory, no game and no engine:
//   1. the rule itself (SeatModSelectionPlan): who may be switched off, what goes with it, what comes back;
//   2. the inventory (SeatModInventory): host mod_list rows × manifests on disk → one descriptor per id,
//      failing SAFE (anything unreadable is treated as gameplay-affecting, so it is never offered);
//   3. the store (SeatModSelectionStore): the explicit choices only, empty on anything unreadable;
//   4. the rewrite (SeatModList + HeadlessSeatModSelection): the rows land disabled in every profile a seat
//      is seeded with, beside the couchcoop copy pin, and nothing else moves;
//   5. the service that joins them for the seat launch and the panel.
internal static class SeatModSelectionTests
{
    private const string Workshop = CouchCoopModBuildIdentity.WorkshopModSource;
    private const string Local = CouchCoopModBuildIdentity.LocalModSource;

    public static void Run()
    {
        // 1. The rule.
        GameplayModsAreNeverOffered();
        NonGameplayLeafIsOffered();
        LibraryIsLockedByTheGameplayModThatNeedsIt();
        LibraryIsOfferedOnceNothingGameplayNeedsIt();
        TransitiveGameplayDependentLocksAndIsNamedNearestFirst();
        UnknownIdsAreNeitherOfferedNorBlamed();
        DuplicateDescriptorsCannotHideAGameplayFlag();
        ResolveCascadesToTransitiveDependents();
        ResolveDropsAChoiceThatIsNoLongerAllowed();
        ResolveDropsUnknownIdsAndBlanks();
        DependencyCyclesTerminate();
        ReEnablingRestoresOnlyWhatTheCascadeTook();
        CascadePreviewShowsOnlyWhatWouldNewlyGoOff();
        DisableableIsStablyOrderedByName();

        // 2. The inventory.
        ManifestParsingAcceptsRealShapesIncludingABom();
        ManifestParsingFailsSafe();
        UnreadableManifestMakesARowGameplayAffecting();
        DualSourceCollapsesToOneDescriptorAndKeepsBothRows();
        ManifestFromTheOtherSourceIsNeverBorrowed();
        CouchCoopAndDisabledRowsAreNotInventoried();
        LoadedModSeamPrefersTheCopyTheGameLoaded();
        SourceSpellingsAreReconciledInOnePlace();
        InventoryReadsARealShapedDiskLayoutFromALocalDeploy();
        WorkshopRootIsFoundFromAWorkshopCopyAlone();
        UnresolvedWorkshopRootIsNamedWithWhy();
        HostModListIsTheMostRecentlyWrittenProfile();

        // 3. The store.
        StoreReadsNothingDisabledFromAnythingUnreadable();
        StoreRoundTripsTheExplicitSet();

        // 4. The rewrite.
        RewriteDisablesSeveralRowsAndTouchesNothingElse();
        RewriteAppendsMissingRowsAndLeavesADoneFileAlone();
        RewriteRefusesWhatThePinAlwaysRefused();
        SeedingAppliesHostChoicesBesideTheCopyPinInBothProfileRoots();
        SeedingWithNothingChosenStillPinsAndStaysOffTheErrorChannel();
        AProfileWithNoModListIsNothingToPinAndStaysOffTheErrorChannel();
        AProfileThatCouldNotBePinnedIsStillEscalated();

        // 5. The service.
        ServiceCachesOnlyASuccessfulInventoryRead();
        ServiceResolvesSeatRowsAcrossBothSources();

        Console.WriteLine("SeatModSelectionTests: ok");
    }

    // ---------------------------------------------------------------------------------------------
    // Fixtures: the shape of a real maintainer box (ids and relationships, not files).
    // ---------------------------------------------------------------------------------------------

    private static SeatModDescriptor Mod(string id, bool gameplay, params string[] dependencies)
        => new(id, Workshop, id, gameplay, dependencies);

    private static SeatModDescriptor Mod(string id, string name, bool gameplay, params string[] dependencies)
        => new(id, Workshop, name, gameplay, dependencies);

    private static readonly SeatModDescriptor BaseLib = Mod("BaseLib", gameplay: false);
    private static readonly SeatModDescriptor Minty = Mod("MintySpire2", "Minty Spire 2", gameplay: false, "BaseLib");
    private static readonly SeatModDescriptor IntentGraph = Mod("intentgraph2", "Intent Graph", gameplay: false);
    private static readonly SeatModDescriptor Downfall = Mod("Downfall", gameplay: true, "BaseLib");

    private static bool Same(IEnumerable<string> actual, params string[] expected)
    {
        var set = new HashSet<string>(actual, SeatModSelectionPlan.IdComparer);
        return set.Count == expected.Length && expected.All(set.Contains);
    }

    // ---------------------------------------------------------------------------------------------
    // 1. The rule.
    // ---------------------------------------------------------------------------------------------

    private static void GameplayModsAreNeverOffered()
    {
        var mods = new[] { BaseLib, Downfall };
        Assert(!SeatModSelectionPlan.CanDisable(mods, "Downfall", out var blockedBy), "a gameplay mod is not disableable");
        Assert(blockedBy?.Id == "Downfall", "a gameplay mod is blocked by itself, so the UI can say why");
    }

    private static void NonGameplayLeafIsOffered()
    {
        var mods = new[] { Minty, IntentGraph };
        Assert(SeatModSelectionPlan.CanDisable(mods, "intentgraph2", out var blockedBy), "a non-gameplay leaf is disableable");
        Assert(blockedBy is null, "an offered mod names no blocker");
    }

    private static void LibraryIsLockedByTheGameplayModThatNeedsIt()
    {
        // BaseLib declares no gameplay effect of its own — and a gameplay mod needs it. Minty (non-gameplay)
        // depends on it too and is listed FIRST, so the name reported must still be the gameplay one.
        var mods = new[] { BaseLib, Minty, Downfall };
        Assert(!SeatModSelectionPlan.CanDisable(mods, "BaseLib", out var blockedBy),
            "a library a gameplay mod depends on is not disableable");
        Assert(blockedBy?.Id == "Downfall", "the lock names the gameplay dependent, not a harmless one");
        Assert(!SeatModSelectionPlan.Disableable(mods).Any(m => m.Id == "BaseLib"), "a locked library is not offered");
    }

    private static void LibraryIsOfferedOnceNothingGameplayNeedsIt()
    {
        var mods = new[] { BaseLib, Minty };
        Assert(SeatModSelectionPlan.CanDisable(mods, "BaseLib", out var blockedBy) && blockedBy is null,
            "the same library becomes disableable the moment no gameplay mod needs it — it is not special-cased");
    }

    private static void TransitiveGameplayDependentLocksAndIsNamedNearestFirst()
    {
        // Lib ← Mid (harmless) ← Top (gameplay): Lib is still load-bearing, two steps away.
        var mods = new[]
        {
            Mod("Top", gameplay: true, "Mid"),
            Mod("Mid", gameplay: false, "Lib"),
            Mod("Lib", gameplay: false),
        };
        Assert(!SeatModSelectionPlan.CanDisable(mods, "Lib", out var blockedBy) && blockedBy?.Id == "Top",
            "a gameplay mod reached through another mod still locks the library");
        Assert(!SeatModSelectionPlan.CanDisable(mods, "Mid", out var midBlockedBy) && midBlockedBy?.Id == "Top",
            "…and the harmless mod in the middle");

        // Two gameplay dependents, one direct and one reached through a harmless mod listed ahead of it: the
        // direct one is the one a host recognises as needing the library.
        var nearest = new[]
        {
            Mod("Far", gameplay: true, "Bridge"),
            Mod("Bridge", gameplay: false, "Lib"),
            Mod("Near", gameplay: true, "Lib"),
            Mod("Lib", gameplay: false),
        };
        Assert(!SeatModSelectionPlan.CanDisable(nearest, "Lib", out var nearestBlocker) && nearestBlocker?.Id == "Near",
            "the blocker named is the nearest gameplay dependent");
    }

    private static void UnknownIdsAreNeitherOfferedNorBlamed()
    {
        Assert(!SeatModSelectionPlan.CanDisable([Minty], "NotInstalled", out var blockedBy) && blockedBy is null,
            "an id this machine does not have is not disableable, and nothing is blamed for it");
        Assert(SeatModSelectionPlan.CanDisable([Minty, BaseLib], "mintyspire2", out _),
            "ids match case-insensitively — a manifest and a mod_list row are written by different parties");
    }

    private static void DuplicateDescriptorsCannotHideAGameplayFlag()
    {
        // The inventory collapses an id to one descriptor. A list that did not must still not let a second
        // copy's gameplay flag go unread.
        var mods = new[] { Mod("Twice", gameplay: false), Mod("Twice", gameplay: true) };
        Assert(!SeatModSelectionPlan.CanDisable(mods, "Twice", out var blockedBy) && blockedBy!.AffectsGameplay,
            "a gameplay flag on any descriptor of an id locks it");
    }

    private static void ResolveCascadesToTransitiveDependents()
    {
        var mods = new[] { Mod("L", gameplay: false), Mod("D1", gameplay: false, "L"), Mod("D2", gameplay: false, "D1") };
        Assert(Same(SeatModSelectionPlan.Resolve(mods, ["L"]), "L", "D1", "D2"),
            "switching a library off takes everything that depends on it, transitively");
        Assert(Same(SeatModSelectionPlan.Resolve(mods, ["D1"]), "D1", "D2"),
            "switching a mod off never takes what it depends ON");
        Assert(SeatModSelectionPlan.Resolve([Minty, BaseLib], ["mintyspire2"]).Contains("MintySpire2")
            && SeatModSelectionPlan.Resolve([Minty, BaseLib], ["mintyspire2"]).Single() == "MintySpire2",
            "the resolved id is the inventory's own spelling, not the stored one");
    }

    private static void ResolveDropsAChoiceThatIsNoLongerAllowed()
    {
        // Last week: BaseLib off (and Minty with it). This week the host subscribed to a gameplay mod that
        // needs BaseLib. The stored choice must stop applying rather than desynchronise every seat.
        IReadOnlySet<string> stored = new HashSet<string>(["BaseLib"], SeatModSelectionPlan.IdComparer);
        Assert(Same(SeatModSelectionPlan.Resolve([BaseLib, Minty], stored), "BaseLib", "MintySpire2"),
            "before the subscription the choice applies, cascade included");
        Assert(SeatModSelectionPlan.Resolve([BaseLib, Minty, Downfall], stored).Count == 0,
            "after it, the no-longer-allowed choice is DROPPED, and its cascade with it");

        Assert(Same(SeatModSelectionPlan.Resolve([BaseLib, Minty, Downfall], ["BaseLib", "MintySpire2"]), "MintySpire2"),
            "a separately chosen dependent that is still allowed stays off on its own account");
        Assert(SeatModSelectionPlan.Resolve([BaseLib, Downfall], ["Downfall"]).Count == 0,
            "a stored gameplay mod is never applied");
    }

    private static void ResolveDropsUnknownIdsAndBlanks()
    {
        Assert(SeatModSelectionPlan.Resolve([Minty, BaseLib], ["Unsubscribed"]).Count == 0,
            "an id this machine no longer has is dropped");
        Assert(SeatModSelectionPlan.Resolve([Minty, BaseLib], ["", "  "]).Count == 0, "blank ids are dropped");
        Assert(SeatModSelectionPlan.Resolve([Minty, BaseLib], null).Count == 0, "no stored choice disables nothing");
    }

    private static void DependencyCyclesTerminate()
    {
        // A malformed pair of manifests that depend on each other must cost a bounded walk, not a hung UI thread.
        var harmless = new[] { Mod("A", gameplay: false, "B"), Mod("B", gameplay: false, "A") };
        Assert(SeatModSelectionPlan.DependentsOf(harmless, "A").Select(m => m.Id).SequenceEqual(["B"]),
            "a cycle's dependents are walked once and exclude the start");
        Assert(Same(SeatModSelectionPlan.Resolve(harmless, ["A"]), "A", "B"), "a harmless cycle resolves as a whole");

        var withGameplay = new[] { Mod("A", gameplay: false, "B"), Mod("B", gameplay: true, "A") };
        Assert(!SeatModSelectionPlan.CanDisable(withGameplay, "A", out var blockedBy) && blockedBy?.Id == "B",
            "a gameplay mod in the cycle still locks it");

        var self = new[] { Mod("Self", gameplay: false, "Self") };
        Assert(SeatModSelectionPlan.DependentsOf(self, "Self").Count == 0, "a self-dependency is not a dependent");
    }

    private static void ReEnablingRestoresOnlyWhatTheCascadeTook()
    {
        var mods = new[] { Mod("L", gameplay: false), Mod("D1", gameplay: false, "L"), Mod("D2", gameplay: false, "D1") };

        // D1 switched off deliberately, then L. Turning L back on must leave D1 (and what D1 took) off.
        Assert(Same(SeatModSelectionPlan.Resolve(mods, ["D1", "L"]), "L", "D1", "D2"), "both choices apply");
        Assert(Same(SeatModSelectionPlan.Resolve(mods, ["D1"]), "D1", "D2"),
            "re-enabling L keeps the explicit D1 off — it survives the cascade going off and back on");

        // Only L switched off: turning it back on brings everything back, with no bookkeeping to go stale.
        Assert(Same(SeatModSelectionPlan.Resolve(mods, ["L"]), "L", "D1", "D2"), "the cascade applies");
        Assert(SeatModSelectionPlan.Resolve(mods, []).Count == 0, "re-enabling L restores what only its cascade took");
    }

    private static void CascadePreviewShowsOnlyWhatWouldNewlyGoOff()
    {
        var mods = new[]
        {
            Mod("L", gameplay: false),
            Mod("D1", gameplay: false, "L"),
            Mod("D2", gameplay: false, "D1"),
        };
        Assert(SeatModSelectionPlan.CascadePreview(mods, "L", []).Select(m => m.Id).SequenceEqual(["D1", "D2"]),
            "the host sees every dependent that would go off, before committing");
        Assert(SeatModSelectionPlan.CascadePreview(mods, "L", ["D1"]).Count == 0,
            "dependents that are already off are not announced again");
        Assert(SeatModSelectionPlan.CascadePreview([BaseLib, Minty, Downfall], "BaseLib", []).All(m => !m.AffectsGameplay),
            "a gameplay dependent is never listed as something that would go off");
    }

    private static void DisableableIsStablyOrderedByName()
    {
        var mods = new[] { Minty, Downfall, IntentGraph, BaseLib };
        Assert(SeatModSelectionPlan.Disableable(mods).Select(m => m.Id).SequenceEqual(["intentgraph2", "MintySpire2"]),
            "the offered list is ordered by name, so the panel does not reshuffle between openings");
    }

    // ---------------------------------------------------------------------------------------------
    // 2. The inventory.
    // ---------------------------------------------------------------------------------------------

    private const string MintyManifest = """
        {
          "id": "MintySpire2",
          "name": "Minty Spire 2",
          "version": "v1.2.0",
          "has_pck": true,
          "has_dll": true,
          "dependencies": [
            {
              "id": "BaseLib",
              "min_version": "3.4.5"
            }
          ],
          "affects_gameplay": false
        }
        """;

    private static void ManifestParsingAcceptsRealShapesIncludingABom()
    {
        const string workshopPath = "/lib/steamapps/workshop/content/2868840/3737336234/MintySpire2/MintySpire2.json";

        // Real manifests ship with a UTF-8 byte-order mark. Under the fail-safe, one read as unreadable would
        // lock the very mod a host needs to switch off.
        var withBom = SeatModInventory.ParseManifest("\uFEFF" + MintyManifest, workshopPath);
        Assert(withBom is not null && withBom.Id == "MintySpire2", "a manifest with a BOM is read");
        Assert(withBom!.AffectsGameplay == false, "affects_gameplay: false is honoured");
        Assert(withBom.DependencyIds.SequenceEqual(["BaseLib"]), "object-shaped dependency entries yield their ids");
        Assert(withBom.Name == "Minty Spire 2", "the display name is read");
        Assert(withBom.Source == Workshop, "the manifest's source comes from its path shape");

        var bareStrings = SeatModInventory.ParseManifest(
            """{"id": "X", "affects_gameplay": false, "dependencies": ["BaseLib", {"id": "Other"}],}""",
            "/games/sts2/mods/x/x.json");
        Assert(bareStrings is not null && bareStrings.DependencyIds.SequenceEqual(["BaseLib", "Other"]),
            "bare-string dependency entries are accepted beside objects, and a trailing comma is tolerated");
        Assert(bareStrings!.Source == Local, "a local mods/ path is the local source");
        Assert(bareStrings.Name is null, "a manifest with no name falls back later, not here");

        var noDependencies = SeatModInventory.ParseManifest("""{"id": "godotexplorer", "affects_gameplay": false}""", "/g/mods/ge/mod_manifest.json");
        Assert(noDependencies is not null && noDependencies.DependencyIds.Count == 0 && !noDependencies.AffectsGameplay,
            "a manifest that declares no dependencies has none");
    }

    private static void ManifestParsingFailsSafe()
    {
        const string path = "/g/mods/m/m.json";
        Assert(SeatModInventory.ParseManifest("""{"id": "M"}""", path)!.AffectsGameplay,
            "a manifest that does not declare affects_gameplay is treated as affecting it");
        Assert(SeatModInventory.ParseManifest("""{"id": "M", "affects_gameplay": "false"}""", path)!.AffectsGameplay,
            "only a JSON false counts — the string \"false\" is not a declaration");
        Assert(SeatModInventory.ParseManifest("""{"id": "M", "affects_gameplay": false, "dependencies": "BaseLib"}""", path)!.AffectsGameplay,
            "a dependency list that is present but unreadable voids the manifest's own claim of harmlessness");
        Assert(SeatModInventory.ParseManifest("""{"id": "M", "affects_gameplay": false, "dependencies": [42]}""", path)!.AffectsGameplay,
            "so does a dependency entry of an unknown shape");

        Assert(SeatModInventory.ParseManifest("""{"name": "no id"}""", path) is null, "a JSON object with no id is not a manifest");
        Assert(SeatModInventory.ParseManifest("""{"id": 7}""", path) is null, "a non-string id is not a manifest");
        Assert(SeatModInventory.ParseManifest("""["id"]""", path) is null, "an array is not a manifest");
        Assert(SeatModInventory.ParseManifest("{ not json", path) is null, "invalid JSON is not a manifest (and does not throw)");
    }

    private static SeatModManifest Manifest(string json, string path)
        => SeatModInventory.ParseManifest(json, path) ?? throw new Exception($"fixture did not parse: {path}");

    private static void UnreadableManifestMakesARowGameplayAffecting()
    {
        var rows = new[]
        {
            new SeatModListRow("MintySpire2", Workshop, true),
            new SeatModListRow("Mystery", Workshop, true),
        };
        var manifests = new[]
        {
            Manifest(MintyManifest, "/lib/workshop/content/2868840/1/MintySpire2/MintySpire2.json"),
        };
        var snapshot = SeatModInventory.Build(rows, manifests, []);
        var mystery = snapshot.Mods.Single(m => m.Id == "Mystery");
        Assert(mystery.AffectsGameplay, "a row whose manifest cannot be found is recorded as gameplay-affecting");
        Assert(mystery.Name == "Mystery", "an unknown mod is named by its id");
        Assert(!SeatModSelectionPlan.CanDisable(snapshot.Mods, "Mystery", out _), "…so it is never offered");
        Assert(SeatModSelectionPlan.CanDisable(snapshot.Mods, "MintySpire2", out _),
            "a readable neighbour is unaffected by it");
    }

    private static void DualSourceCollapsesToOneDescriptorAndKeepsBothRows()
    {
        // BaseLib installed twice. The local copy declares itself harmless; the Workshop copy (a different
        // version) says otherwise and depends on something extra. One descriptor, the OR and the union.
        var rows = new[]
        {
            new SeatModListRow("BaseLib", Local, true),
            new SeatModListRow("BaseLib", Workshop, true),
        };
        var manifests = new[]
        {
            Manifest("""{"id": "BaseLib", "name": "BaseLib", "affects_gameplay": false, "dependencies": []}""",
                "/games/sts2/mods/BaseLib/BaseLib.json"),
            Manifest("""{"id": "BaseLib", "affects_gameplay": true, "dependencies": [{"id": "Extra"}]}""",
                "/lib/workshop/content/2868840/3737335127/BaseLib/BaseLib.json"),
        };
        var snapshot = SeatModInventory.Build(rows, manifests, []);
        Assert(snapshot.Mods.Count == 1, "the same id from two sources is ONE descriptor");
        Assert(snapshot.Mods[0].AffectsGameplay, "its gameplay flag is the OR of both copies");
        Assert(snapshot.Mods[0].DependencyIds.SequenceEqual(["Extra"]), "its dependencies are the union");
        Assert(snapshot.RowsFor(["baselib"]).SequenceEqual([new SeatModRowKey("BaseLib", Local), new SeatModRowKey("BaseLib", Workshop)]),
            "and it stays TWO rows, so switching it off reaches whichever copy a seat would load");

        var harmless = SeatModInventory.Build(rows,
        [
            Manifest("""{"id": "BaseLib", "affects_gameplay": false}""", "/games/sts2/mods/BaseLib/BaseLib.json"),
            Manifest("""{"id": "BaseLib", "affects_gameplay": false}""", "/lib/workshop/content/2868840/9/BaseLib.json"),
        ], []);
        Assert(!harmless.Mods.Single().AffectsGameplay, "two harmless copies stay harmless");
    }

    private static void ManifestFromTheOtherSourceIsNeverBorrowed()
    {
        // Only the Workshop copy's manifest was found. The local copy may be another version entirely.
        var rows = new[] { new SeatModListRow("Tool", Local, true), new SeatModListRow("Tool", Workshop, true) };
        var snapshot = SeatModInventory.Build(rows,
            [Manifest("""{"id": "Tool", "affects_gameplay": false}""", "/lib/workshop/content/2868840/5/Tool.json")], []);
        Assert(snapshot.Mods.Single().AffectsGameplay,
            "a copy whose own manifest is missing makes the id gameplay-affecting, even beside a harmless twin");

        var unclassified = SeatModInventory.Build([new SeatModListRow("Tool", Local, true)],
            [Manifest("""{"id": "Tool", "affects_gameplay": false}""", "/somewhere/else/Tool.json")], []);
        Assert(!unclassified.Mods.Single().AffectsGameplay,
            "a manifest whose location has neither shape can still describe a row nothing else describes");
    }

    private static void CouchCoopAndDisabledRowsAreNotInventoried()
    {
        var rows = new[]
        {
            new SeatModListRow("couchcoop", Local, true),
            new SeatModListRow("CouchCoop", Workshop, true),
            new SeatModListRow("OldMod", Workshop, false),
            new SeatModListRow("intentgraph2", Workshop, true),
        };
        var manifests = new[]
        {
            Manifest("""{"id": "couchcoop", "affects_gameplay": false}""", "/g/mods/couchcoop/couchcoop.json"),
            Manifest("""{"id": "OldMod", "affects_gameplay": false}""", "/lib/workshop/content/2868840/7/OldMod.json"),
            Manifest("""{"id": "intentgraph2", "name": "Intent Graph", "affects_gameplay": false}""",
                "/lib/workshop/content/2868840/3747528152/intentgraph2.json"),
        };
        var snapshot = SeatModInventory.Build(rows, manifests, []);
        Assert(snapshot.Mods.Select(m => m.Id).SequenceEqual(["intentgraph2"]),
            "couchcoop is never offered (in any case), and a row the host itself has disabled is not the host's to take away");
        Assert(snapshot.Rows.All(row => !HeadlessSeatModSelection.IsCouchCoop(row.Id)), "no couchcoop row is carried either");
        Assert(snapshot.Mods[0].Name == "Intent Graph", "the manifest name is what the panel shows");
    }

    private static void LoadedModSeamPrefersTheCopyTheGameLoaded()
    {
        // Two Workshop items claim the same id (seen for real with two CouchCoop items). One says harmless, one
        // does not. With no live account the OR wins; with one, the loaded copy's manifest is the one read.
        var rows = new[] { new SeatModListRow("Dup", Workshop, true) };
        var manifests = new[]
        {
            Manifest("""{"id": "Dup", "affects_gameplay": false}""", "/lib/workshop/content/2868840/111/Dup.json"),
            Manifest("""{"id": "Dup", "affects_gameplay": true}""", "/lib/workshop/content/2868840/222/Dup.json"),
        };
        Assert(SeatModInventory.Build(rows, manifests, []).Mods.Single().AffectsGameplay,
            "with no loaded-mod source (the default) an ambiguous id resolves to gameplay-affecting");

        var loaded = new[] { new SeatLoadedMod("dup", "SteamWorkshop", "Duplicate", "/lib/workshop/content/2868840/111") };
        var sharp = SeatModInventory.Build(rows, manifests, loaded).Mods.Single();
        Assert(!sharp.AffectsGameplay, "the copy the game says it loaded decides");
        Assert(sharp.Name == "Duplicate", "and names it");
    }

    private static void SourceSpellingsAreReconciledInOnePlace()
    {
        Assert(SeatModInventory.NormalizeSource("SteamWorkshop", null) == Workshop, "PascalCase Workshop");
        Assert(SeatModInventory.NormalizeSource("steam_workshop", null) == Workshop, "snake_case Workshop");
        Assert(SeatModInventory.NormalizeSource("ModsDirectory", null) == Local, "PascalCase local");
        Assert(SeatModInventory.NormalizeSource("mods_directory", null) == Local, "snake_case local");
        Assert(SeatModInventory.NormalizeSource("Something", "/g/mods/x") == Local, "an unknown spelling falls back to the path");
        Assert(SeatModInventory.NormalizeSource(null, "/nowhere/x") is null, "neither says: unknown");
    }

    // A fake Steam library and a separate fake user dir, mirroring the maintainer's box: a LOCAL-deploy
    // CouchCoop with Workshop third-party mods. The app id in the library's appmanifest is deliberately not the
    // real one, so finding the Workshop items proves the id came from the install and not from a constant.
    private sealed class DiskFixture : IDisposable
    {
        public const string AppId = "1234567";
        private readonly TempDir _root = new();

        public DiskFixture()
        {
            SteamApps = Path.Combine(_root.Path, "E-drive", "SteamLibrary", "steamapps");
            Install = Path.Combine(SteamApps, "common", "Slay the Spire 2");
            Content = Path.Combine(SteamApps, "workshop", "content", AppId);
            HostUserDir = Path.Combine(_root.Path, "C-drive", "Users", "p", "AppData", "Roaming", "SlayTheSpire2");

            Directory.CreateDirectory(Install);
            File.WriteAllText(Path.Combine(SteamApps, $"appmanifest_{AppId}.acf"),
                "\"AppState\"\n{\n\t\"appid\"\t\t\"" + AppId + "\"\n\t\"installdir\"\t\t\"Slay the Spire 2\"\n}\n");
            File.WriteAllText(Path.Combine(SteamApps, "appmanifest_99.acf"), "\"AppState\"\n{\n\t\"installdir\"\t\t\"Other Game\"\n}\n");
            // Another app's Workshop content in the same library must never be read.
            Write(Path.Combine(SteamApps, "workshop", "content", "99", "1", "Trap.json"), """{"id": "MintySpire2", "affects_gameplay": true}""");

            // BaseLib: one directory below the item root.
            Write(Path.Combine(Content, "3737335127", "BaseLib", "BaseLib.json"),
                """{"id": "BaseLib", "name": "BaseLib", "dependencies": [], "affects_gameplay": false}""");
            // Minty: with a real UTF-8 BOM on disk.
            var mintyPath = Path.Combine(Content, "3737336234", "MintySpire2", "MintySpire2.json");
            Directory.CreateDirectory(Path.GetDirectoryName(mintyPath)!);
            File.WriteAllBytes(mintyPath, [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(MintyManifest)]);
            // Intent Graph: AT the item root, beside other files.
            Write(Path.Combine(Content, "3747528152", "intentgraph2.json"),
                """{"id": "intentgraph2", "name": "Intent Graph", "dependencies": [], "affects_gameplay": false}""");
            File.WriteAllText(Path.Combine(Content, "3747528152", "IntentGraph.dll"), "not a manifest");
            // A gameplay mod that needs BaseLib.
            Write(Path.Combine(Content, "3747508091", "Downfall.json"),
                """{"id": "Downfall", "name": "Downfall", "dependencies": [{"id": "BaseLib", "min_version": "3.4.7"}], "affects_gameplay": true}""");
            // A manifest three levels down: past the bounded search, so its row stays unknown (fail-safe).
            Write(Path.Combine(Content, "3800000000", "a", "b", "Deep.json"), """{"id": "Deep", "affects_gameplay": false}""");
            // A local mod in the install.
            Write(Path.Combine(Install, "mods", "godotexplorer", "mod_manifest.json"),
                """{"id": "godotexplorer", "name": "Godot Explorer", "affects_gameplay": false}""");
            Write(Path.Combine(Install, "mods", "couchcoop", "couchcoop.json"), """{"id": "couchcoop", "affects_gameplay": false}""");
        }

        public string SteamApps { get; }
        public string Install { get; }
        public string Content { get; }
        public string HostUserDir { get; }

        public string Profile(string root, string name, string modListJson, DateTime writtenUtc)
        {
            var path = Path.Combine(HostUserDir, root, name, "settings.save");
            Write(path, $$$"""{"language": "eng", "mod_settings": {"mod_list": {{{modListJson}}}, "mods_enabled": true}}""");
            File.SetLastWriteTimeUtc(path, writtenUtc);
            return path;
        }

        public static void Write(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
        }

        public void Dispose() => _root.Dispose();
    }

    private const string HostModList = """
        [
          {"id": "godotexplorer", "is_enabled": true, "source": "mods_directory"},
          {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
          {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"},
          {"id": "BaseLib", "is_enabled": true, "source": "steam_workshop"},
          {"id": "MintySpire2", "is_enabled": true, "source": "steam_workshop"},
          {"id": "intentgraph2", "is_enabled": true, "source": "steam_workshop"},
          {"id": "Downfall", "is_enabled": true, "source": "steam_workshop"},
          {"id": "Deep", "is_enabled": true, "source": "steam_workshop"},
          {"id": "OldMod", "is_enabled": false, "source": "steam_workshop"}
        ]
        """;

    private static void InventoryReadsARealShapedDiskLayoutFromALocalDeploy()
    {
        using var disk = new DiskFixture();
        disk.Profile("steam", "76561198000000000", HostModList, new DateTime(2026, 9, 22, 12, 0, 0, DateTimeKind.Utc));

        var roots = SeatModInventory.ResolveRoots(
            disk.HostUserDir,
            ownAssemblyPath: Path.Combine(disk.Install, "mods", "couchcoop", "CouchCoop.Mod.dll"),
            installRoot: disk.Install,
            processDirectory: disk.Install);
        Assert(roots.WorkshopContentDirs.SequenceEqual([disk.Content]),
            "a LOCAL CouchCoop still finds the Workshop content dir, through the library the install sits in — and "
            + "only this game's, by the app id the library's own appmanifest gives");
        Assert(roots.LocalModsDirs.SequenceEqual([Path.Combine(disk.Install, "mods")]), "the install's mods dir, once");

        var snapshot = SeatModInventory.Read(roots, NoSeatLoadedMods.Instance);
        Assert(snapshot is not null, "the inventory reads");
        var mods = snapshot!.Mods.ToDictionary(m => m.Id);
        Assert(mods.Keys.SequenceEqual(["godotexplorer", "BaseLib", "MintySpire2", "intentgraph2", "Downfall", "Deep"]),
            $"one descriptor per enabled non-CouchCoop row, in mod_list order (got {string.Join(",", mods.Keys)})");
        Assert(!mods["MintySpire2"].AffectsGameplay && mods["MintySpire2"].DependencyIds.SequenceEqual(["BaseLib"]),
            "the BOM'd Minty manifest was read — not failed safe into a lock");
        Assert(mods["MintySpire2"].Name == "Minty Spire 2", "with its display name");
        Assert(!mods["BaseLib"].AffectsGameplay, "a manifest one level below the item root is found");
        Assert(!mods["intentgraph2"].AffectsGameplay, "a manifest at the item root is found");
        Assert(!mods["godotexplorer"].AffectsGameplay && mods["godotexplorer"].Source == Local, "a local mod is found");
        Assert(mods["Downfall"].AffectsGameplay, "a gameplay mod reads as one");
        Assert(mods["Deep"].AffectsGameplay, "a manifest past the bounded search leaves its row unknown, hence gameplay");

        Assert(SeatModSelectionPlan.Disableable(snapshot.Mods).Select(m => m.Id)
                .SequenceEqual(["godotexplorer", "intentgraph2", "MintySpire2"]),
            "offered: the harmless leaves, by name");
        Assert(!SeatModSelectionPlan.CanDisable(snapshot.Mods, "BaseLib", out var blockedBy) && blockedBy?.Id == "Downfall",
            "BaseLib is locked, and the lock names Downfall");

        Assert(SeatModInventory.DescribeRoots(roots) ==
                $"seat mod inventory roots: user dir={disk.HostUserDir}; workshop content=[{disk.Content}]; "
                + $"local mods=[{Path.Combine(disk.Install, "mods")}]",
            $"the roots line names what was resolved, and no reasons when nothing is missing (got '{SeatModInventory.DescribeRoots(roots)}')");
    }

    // A LOCAL CouchCoop finds Workshop mods only through the Steam library its install sits in. When that cannot be
    // resolved, every Workshop mod drops out of the panel — so the roots line must say which way failed and why.
    private static void UnresolvedWorkshopRootIsNamedWithWhy()
    {
        using var root = new TempDir();
        // The shape of a QA farm: a game copy outside any Steam library, with a local CouchCoop in it.
        var farm = Path.Combine(root.Path, "farm", "game");
        var ownAssembly = Path.Combine(farm, "mods", "couchcoop", "CouchCoop.Mod.dll");
        DiskFixture.Write(ownAssembly, "not a dll");
        var userDir = Path.Combine(root.Path, "user", "SlayTheSpire2");

        var roots = SeatModInventory.ResolveRoots(userDir, ownAssembly, installRoot: farm, processDirectory: farm);
        Assert(roots.WorkshopContentDirs.Count == 0, "no Workshop content dir can be found");
        Assert(roots.LocalModsDirs.SequenceEqual([Path.Combine(farm, "mods")]), "the local mods dir still is");
        Assert(roots.WorkshopMisses.SequenceEqual(
            [
                $"CouchCoop is not the Workshop copy ({ownAssembly})",
                $"{farm} is not inside a Steam library (no steamapps{Path.DirectorySeparatorChar}common"
                    + $"{Path.DirectorySeparatorChar}<game> within 8 levels above it)",
            ]),
            $"each way that found nothing says why, once even when the install root and the executable's directory "
            + $"are the same place (got {string.Join(" | ", roots.WorkshopMisses)})");

        var line = SeatModInventory.DescribeRoots(roots);
        Assert(line == $"seat mod inventory roots: user dir={userDir}; workshop content=none ({roots.WorkshopMisses[0]}; "
                + $"{roots.WorkshopMisses[1]}) — Workshop mods cannot be listed; local mods=[{Path.Combine(farm, "mods")}]",
            $"the line names what resolved, what did not, and why (got '{line}')");

        // A library that IS found but holds no Workshop content for this game says that instead.
        using var disk = new DiskFixture();
        Directory.Delete(disk.Content, recursive: true);
        var noContent = SeatModInventory.ResolveRoots(
            disk.HostUserDir,
            Path.Combine(disk.Install, "mods", "couchcoop", "CouchCoop.Mod.dll"),
            installRoot: disk.Install,
            processDirectory: null);
        Assert(noContent.WorkshopContentDirs.Count == 0, "no content dir for this game's app ids");
        Assert(noContent.WorkshopMisses.Any(miss =>
                miss.StartsWith($"no Workshop content dir in the Steam library {disk.Install} sits in (", StringComparison.Ordinal)
                && miss.Contains(DiskFixture.AppId, StringComparison.Ordinal)),
            $"the library rung names the library and the app ids it tried (got {string.Join(" | ", noContent.WorkshopMisses)})");
        Assert(noContent.WorkshopMisses.Contains("the executable's directory is unknown"), "and an unknown fact says so");

        Assert(SeatModInventory.DescribeRoots(new SeatModInventoryRoots(null, [], [])).StartsWith(
                "seat mod inventory roots: user dir=unresolved, so the host's mod list cannot be read", StringComparison.Ordinal),
            "an unresolved user dir is named as the reason nothing is listed");
    }

    private static void WorkshopRootIsFoundFromAWorkshopCopyAlone()
    {
        // A real player: CouchCoop itself is a Workshop item, and nothing else is known.
        using var disk = new DiskFixture();
        var ownAssembly = Path.Combine(disk.Content, "3802305221", "lanes", "0.107", "CouchCoop.Mod.dll");
        var roots = SeatModInventory.ResolveRoots(disk.HostUserDir, ownAssembly, installRoot: null, processDirectory: null);
        Assert(roots.WorkshopContentDirs.SequenceEqual([disk.Content]),
            "the Workshop copy's own path names its content dir, app id included");
        Assert(roots.LocalModsDirs.Count == 0, "and implies no local mods dir");
        Assert(SeatModInventory.WorkshopContentDirOf("/somewhere/CouchCoop.Mod.dll") is null, "no shape, no dir");
        Assert(SeatModInventory.InstallDirOfAppManifest("\"installdir\"\t\t\"Slay the Spire 2\"") == "Slay the Spire 2",
            "an appmanifest's installdir is read");
    }

    private static void HostModListIsTheMostRecentlyWrittenProfile()
    {
        using var disk = new DiskFixture();
        var older = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var newer = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);
        disk.Profile("steam", "76561198000000001", """[{"id": "SecondAccountMod", "is_enabled": true, "source": "steam_workshop"}]""", older);
        disk.Profile("steam", "76561198000000002", """[{"id": "intentgraph2", "is_enabled": true, "source": "steam_workshop"}]""", newer);
        // The newest file of all, but with no usable list: it is skipped, not preferred.
        var offline = Path.Combine(disk.HostUserDir, "default", "1", "settings.save");
        DiskFixture.Write(offline, """{"mod_settings": null}""");
        File.SetLastWriteTimeUtc(offline, newer.AddDays(1));

        var rows = SeatModInventory.ReadHostRows(disk.HostUserDir);
        Assert(rows is not null && rows.Select(r => r.Id).SequenceEqual(["intentgraph2"]),
            "the running profile's list is the most recently written one that has a list");

        Assert(SeatModInventory.PickHostRows([]) is null, "no profile, no list");
        var tie = new DateTime(2026, 5, 5, 0, 0, 0, DateTimeKind.Utc);
        IReadOnlyList<SeatModListRow> first = [new("A", Workshop, true)];
        IReadOnlyList<SeatModListRow> second = [new("B", Workshop, true)];
        Assert(ReferenceEquals(SeatModInventory.PickHostRows([(first, tie), (second, tie)]), first),
            "a tie goes to the earlier candidate (steam profiles are offered first)");

        using var empty = new TempDir();
        Assert(SeatModInventory.Read(new SeatModInventoryRoots(empty.Path, [], []), NoSeatLoadedMods.Instance) is null,
            "a user dir with no mod list is 'could not read', not an empty inventory");
    }

    // ---------------------------------------------------------------------------------------------
    // 3. The store.
    // ---------------------------------------------------------------------------------------------

    private static void StoreReadsNothingDisabledFromAnythingUnreadable()
    {
        using var root = new TempDir();
        Assert(SeatModSelectionStore.TryRead(null).Count == 0, "no path: nothing disabled");
        Assert(SeatModSelectionStore.TryRead(Path.Combine(root.Path, "absent.json")).Count == 0, "absent: nothing disabled");

        foreach (var (content, label) in new[]
                 {
                     ("{ corrupt", "corrupt JSON"),
                     ("", "an empty file"),
                     ("""["MintySpire2"]""", "an array root"),
                     ("""{"selection": {"method": "ipv4"}}""", "another store's shape"),
                     ("""{"explicitlyDisabled": "MintySpire2"}""", "a non-array list"),
                     ("""{"explicitlyDisabled": ["MintySpire2", 7]}""", "a list with an element this build did not write"),
                 })
        {
            var path = Path.Combine(root.Path, Guid.NewGuid().ToString("N") + ".json");
            File.WriteAllText(path, content);
            Assert(SeatModSelectionStore.TryRead(path).Count == 0, $"{label}: nothing disabled");
        }
    }

    private static void StoreRoundTripsTheExplicitSet()
    {
        using var root = new TempDir();
        var path = Path.Combine(root.Path, "not-yet", "seat-mods.json");
        SeatModSelectionStore.TryWrite(path, ["MintySpire2", "intentgraph2", "mintyspire2", " ", "BaseLib"]);
        var read = SeatModSelectionStore.TryRead(path);
        Assert(read.Count == 3, "duplicates (compared as ids are) and blanks are not stored");
        Assert(read.Contains("MINTYSPIRE2") && read.Contains("baselib"), "the set answers case-insensitively");
        Assert(File.ReadAllText(path) == """{"explicitlyDisabled":["BaseLib","intentgraph2","MintySpire2"]}""",
            "the file is sorted, so the same choice always writes the same bytes");

        SeatModSelectionStore.TryWrite(path, []);
        Assert(SeatModSelectionStore.TryRead(path).Count == 0, "re-enabling everything is stored as an empty set");

        var previous = Environment.GetEnvironmentVariable(SeatModSelectionStore.PathEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(SeatModSelectionStore.PathEnvironmentVariable, path);
            Assert(SeatModSelectionStore.ResolvePath() == path, "the environment override decides the path");
        }
        finally
        {
            Environment.SetEnvironmentVariable(SeatModSelectionStore.PathEnvironmentVariable, previous);
        }

        Assert(SeatModSelectionStore.ResolvePath() is { } defaultPath
            && Path.GetFileName(defaultPath) == "seat-mods.json"
            && Path.GetFileName(Path.GetDirectoryName(defaultPath)) == "couch-coop",
            "by default it sits in the couch-coop dir beside qr-prefs.json");
    }

    // ---------------------------------------------------------------------------------------------
    // 4. The rewrite.
    // ---------------------------------------------------------------------------------------------

    private static string Settings(string modListJson)
        => $$"""
        {
          "language": "eng",
          "mod_settings": {
            "mod_list": {{modListJson}},
            "mods_enabled": true
          }
        }
        """;

    private static void RewriteDisablesSeveralRowsAndTouchesNothingElse()
    {
        var original = Settings("""
            [
              {"id": "godotexplorer", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"},
              {"id": "BaseLib", "is_enabled": true, "source": "mods_directory"},
              {"id": "BaseLib", "is_enabled": true, "source": "steam_workshop"},
              {"id": "mintyspire2", "is_enabled": true, "source": "steam_workshop", "extra": 1},
              {"id": "intentgraph2", "is_enabled": true, "source": "steam_workshop"}
            ]
            """);
        var edit = SeatModList.Disable(original,
        [
            new SeatModRowKey("couchcoop", Workshop),
            new SeatModRowKey("BaseLib", Local),
            new SeatModRowKey("BaseLib", Workshop),
            new SeatModRowKey("MintySpire2", Workshop),
        ]);
        Assert(edit.Applied && edit.Updated is not null, "a multi-row disable is applied");

        var rows = ModList(edit.Updated!);
        Assert(rows.Count == 7, "no row is added when every row exists");
        Assert(Enabled(rows, "couchcoop", Workshop) == false && Enabled(rows, "couchcoop", Local) == true,
            "the copy pin's row is off and the other copy is untouched");
        Assert(Enabled(rows, "BaseLib", Local) == false && Enabled(rows, "BaseLib", Workshop) == false, "both BaseLib rows are off");
        Assert(Enabled(rows, "mintyspire2", Workshop) == false, "an id is matched case-insensitively");
        Assert(rows[5].GetProperty("id").GetString() == "mintyspire2" && rows[5].GetProperty("extra").GetInt32() == 1,
            "a matched row keeps its own id spelling and every other field");
        Assert(Enabled(rows, "godotexplorer", Local) == true && Enabled(rows, "intentgraph2", Workshop) == true,
            "unrelated rows are untouched");
        Assert(rows.Select(r => r.GetProperty("id").GetString()).SequenceEqual(
                ["godotexplorer", "couchcoop", "couchcoop", "BaseLib", "BaseLib", "mintyspire2", "intentgraph2"]),
            "row order — the player's load order — is preserved");

        var read = SeatModList.ReadRows(edit.Updated!, out var refusal);
        Assert(refusal is null && read!.Count(r => !r.IsEnabled) == 4, "the reader agrees with the rewriter");
    }

    private static void RewriteAppendsMissingRowsAndLeavesADoneFileAlone()
    {
        var original = Settings("""[{"id": "godotexplorer", "is_enabled": true, "source": "mods_directory"}]""");
        var edit = SeatModList.Disable(original, [new SeatModRowKey("MintySpire2", Workshop), new SeatModRowKey("BaseLib", Workshop)]);
        var rows = ModList(edit.Updated!);
        Assert(rows.Count == 3
            && rows[1].GetProperty("id").GetString() == "MintySpire2"
            && rows[2].GetProperty("id").GetString() == "BaseLib"
            && Enabled(rows, "MintySpire2", Workshop) == false,
            "missing rows are appended disabled, in the order asked, after every existing row");

        var again = SeatModList.Disable(edit.Updated!, [new SeatModRowKey("MintySpire2", Workshop), new SeatModRowKey("BaseLib", Workshop)]);
        Assert(again.Updated is null && again.Applied, "a file that already disables every row is left byte-identical");

        var numeric = Settings("""[{"id": "x", "is_enabled": true, "source": 1}]""");
        var refusedAppend = SeatModList.Disable(numeric, [new SeatModRowKey("MintySpire2", Workshop)]);
        Assert(refusedAppend.Updated is null && !refusedAppend.Applied
            && refusedAppend.NotDisabled.SequenceEqual([new SeatModRowKey("MintySpire2", Workshop)]),
            "no row is appended into a list that does not write source as a string — and the row is reported as not disabled");
    }

    private static void RewriteRefusesWhatThePinAlwaysRefused()
    {
        var rows = new[] { new SeatModRowKey("MintySpire2", Workshop) };
        foreach (var (json, label, nothingToPin) in new[]
                 {
                     // The deliberate refusals: a profile with no list, or an empty one, has nothing to pin.
                     ("""{"language": "eng"}""", "no mod_settings", true),
                     ("""{"mod_settings": null}""", "a null mod_settings", true),
                     ("""{"mod_settings": {"mods_enabled": true}}""", "a mod_settings with no mod_list", true),
                     ("""{"mod_settings": {"mod_list": null}}""", "a null mod_list", true),
                     ("""{"mod_settings": {"mod_list": []}}""", "an EMPTY mod_list (the first-modded-launch migration)", true),
                     // A shape this code does not know is a profile it could not pin.
                     ("""{"mod_settings": "nope"}""", "a non-object mod_settings", false),
                     ("""{"mod_settings": {"mod_list": "nope"}}""", "a non-array mod_list", false),
                     ("""[1]""", "a non-object file", false),
                 })
        {
            var edit = SeatModList.Disable(json, rows);
            Assert(edit.Updated is null && edit.Refusal is not null && !edit.Applied, $"{label} is refused, with a reason");
            Assert(edit.NothingToPin == nothingToPin,
                $"{label} {(nothingToPin ? "is" : "is NOT")} counted as nothing to pin");
            Assert(SeatModList.ReadRows(json, out var refusal) is null && refusal is not null, $"{label} has no rows to read");
        }
    }

    private static void SeedingAppliesHostChoicesBesideTheCopyPinInBothProfileRoots()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        var hostUserDir = Path.Combine(xdg, "SlayTheSpire2");
        var hostSettings = Settings("""
            [
              {"id": "godotexplorer", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "mods_directory"},
              {"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"},
              {"id": "BaseLib", "is_enabled": true, "source": "steam_workshop"},
              {"id": "MintySpire2", "is_enabled": true, "source": "steam_workshop"}
            ]
            """);
        var steamProfile = Path.Combine(hostUserDir, "steam", "76561198000000000", "settings.save");
        DiskFixture.Write(steamProfile, hostSettings);
        DiskFixture.Write(Path.Combine(hostUserDir, "default", "1", "settings.save"), hostSettings);

        HeadlessUserDirPrepareResult? result = null;
        var (errorChannel, stderr) = CaptureSeatLog(() => result = HeadlessUserDirSeeder.Prepare(
            4,
            HeadlessUserDirPlatform.Linux,
            key => key == "XDG_DATA_HOME" ? xdg : null,
            _ => Path.Combine(root.Path, "home"),
            seatModSourceToDisable: Workshop,
            hostChosenSeatModRows:
            [
                new SeatModRowKey("MintySpire2", Workshop),
                new SeatModRowKey("BaseLib", Workshop),
                // A host-chosen couchcoop row must never reach a seat: it would take the seat's CouchCoop.
                new SeatModRowKey("couchcoop", Local),
            ]));

        Assert(result is not null, "the slot is prepared");
        foreach (var profile in new[]
                 {
                     Path.Combine(result!.SlotUserDir, "steam", "76561198000000000", "settings.save"),
                     Path.Combine(result.SlotUserDir, "default", "1", "settings.save"),
                 })
        {
            var rows = ModList(File.ReadAllText(profile));
            Assert(Enabled(rows, "MintySpire2", Workshop) == false && Enabled(rows, "BaseLib", Workshop) == false,
                $"the host's choices are off in {profile}");
            Assert(Enabled(rows, "couchcoop", Workshop) == false, $"the copy pin still applies alongside in {profile}");
            Assert(Enabled(rows, "couchcoop", Local) == true, $"the copy the host runs still loads in {profile}");
            Assert(Enabled(rows, "godotexplorer", Local) == true, $"an unrelated mod is untouched in {profile}");
        }

        Assert(Enabled(ModList(File.ReadAllText(steamProfile)), "MintySpire2", Workshop) == true,
            "the host's own settings.save is never edited");

        var line = SeatLines(stderr, 4).SingleOrDefault();
        Assert(line is not null, "one line names what the seat was launched with");
        Assert(line!.Contains("MintySpire2 (steam_workshop)", StringComparison.Ordinal)
            && line.Contains("BaseLib (steam_workshop)", StringComparison.Ordinal),
            "the line names every host-chosen id and the source it was disabled for");
        Assert(line.Contains("copy pin=couchcoop (steam_workshop)", StringComparison.Ordinal), "and the copy pin");
        Assert(line.EndsWith("applied to 2 of 2 profile(s)", StringComparison.Ordinal), "and that both profiles carry it");
        Assert(!line.Contains("couchcoop (mods_directory)", StringComparison.Ordinal), "the refused couchcoop choice is not claimed");
        Assert(!errorChannel.Any(l => l.Contains("headless seat mods", StringComparison.Ordinal)),
            "a seat that carries every host choice is routine — its line is INFO, not the ERROR channel a report quotes");
    }

    // The live QA shape (leg D, Sep-22): the seat's Steam profile carries the host's list, and its offline
    // `default/1` profile has never seen a modded launch, so it has no mod_settings at all. That is how an ordinary
    // modded host's seats are seeded; it must not read as a seat that may load a mod the host switched off.
    private static void AProfileWithNoModListIsNothingToPinAndStaysOffTheErrorChannel()
    {
        using var root = new TempDir();
        var slotUserDir = Path.Combine(root.Path, "slot-2", "SlayTheSpire2");
        var steam = Path.Combine(slotUserDir, "steam", "76561198000000000", "settings.save");
        DiskFixture.Write(steam, Settings(Rows(
            Row("couchcoop", Local, true),
            Row("couchcoop", Workshop, true),
            Row("MintySpire2", Workshop, true))));
        var offline = Path.Combine(slotUserDir, "default", "1", "settings.save");
        const string Unmodded = """{"language": "eng", "fps_limit": 60}""";
        DiskFixture.Write(offline, Unmodded);
        SeatModRowKey[] chosen = [new("MintySpire2", Workshop)];

        SeatModPinOutcome? outcome = null;
        var (errorChannel, stderr) = CaptureSeatLog(
            () => outcome = HeadlessSeatModSelection.ApplyToSeat(slotUserDir, Workshop, chosen, 2));

        Assert(outcome is { Profiles: 2, Applied: 1, NothingToPin: 1, Missed: 0, FellShort: false },
            $"the profile without a mod list counts as nothing to pin, not as a miss (got {outcome})");
        Assert(Enabled(ModList(File.ReadAllText(steam)), "MintySpire2", Workshop) == false,
            "the profile with a list is pinned");
        Assert(File.ReadAllText(offline) == Unmodded, "the profile without one is left byte-identical");
        Assert(errorChannel.Count == 0, "nothing reaches the ERROR channel the connections report quotes");
        var line = SeatLines(stderr, 2).SingleOrDefault();
        Assert(line is not null, "the seat still gets its one line");
        Assert(line!.EndsWith(
                "applied to 1 of 2 profile(s) — every one with a mod list; 1 without one had nothing to pin",
                StringComparison.Ordinal),
            $"and it says the result is complete, and why one profile carries none (got '{line}')");
        Assert(!line.Contains("only", StringComparison.Ordinal) && !line.Contains("skip lines", StringComparison.Ordinal),
            "without the wording of a partial application");

        // An EMPTY list is the other deliberate refusal (the profile's first modded launch): also nothing to pin.
        var empty = Settings("[]");
        DiskFixture.Write(offline, empty);
        (errorChannel, stderr) = CaptureSeatLog(
            () => outcome = HeadlessSeatModSelection.ApplyToSeat(slotUserDir, Workshop, chosen, 3));
        Assert(outcome is { Profiles: 2, Applied: 1, NothingToPin: 1, FellShort: false } && errorChannel.Count == 0,
            $"an empty mod list is nothing to pin as well (got {outcome})");
        Assert(File.ReadAllText(offline) == empty, "and is not appended into");

        // A seat whose every profile lacks a list has nothing to pin at all — still not a miss.
        File.Delete(steam);
        (errorChannel, stderr) = CaptureSeatLog(
            () => outcome = HeadlessSeatModSelection.ApplyToSeat(slotUserDir, Workshop, chosen, 5));
        Assert(outcome is { Profiles: 1, Applied: 0, NothingToPin: 1, FellShort: false } && errorChannel.Count == 0,
            $"no profile with a list is nothing to pin, not a failure (got {outcome})");
        Assert(SeatLines(stderr, 5).Single().EndsWith("nothing to pin — none of the 1 profile(s) has a mod list", StringComparison.Ordinal),
            "and says so");
    }

    // A profile that HAS a mod list — or cannot be read well enough to tell — and was not pinned is the case where
    // a seat may load a mod the host switched off. That one keeps the escalated wording, on the ERROR channel.
    private static void AProfileThatCouldNotBePinnedIsStillEscalated()
    {
        using var root = new TempDir();
        var slotUserDir = Path.Combine(root.Path, "slot-4", "SlayTheSpire2");
        DiskFixture.Write(Path.Combine(slotUserDir, "steam", "76561198000000001", "settings.save"), Settings(Rows(
            Row("couchcoop", Local, true),
            Row("MintySpire2", Workshop, true))));
        // A list the rewrite declines to add a row to: it does not write `source` as a string.
        DiskFixture.Write(Path.Combine(slotUserDir, "steam", "76561198000000002", "settings.save"),
            Settings("""[{"id": "godotexplorer", "is_enabled": true, "source": 1}]"""));
        var offline = Path.Combine(slotUserDir, "default", "1", "settings.save");
        DiskFixture.Write(offline, """{"language": "eng"}""");
        SeatModRowKey[] chosen = [new("MintySpire2", Workshop)];

        SeatModPinOutcome? outcome = null;
        var (errorChannel, stderr) = CaptureSeatLog(
            () => outcome = HeadlessSeatModSelection.ApplyToSeat(slotUserDir, Workshop, chosen, 4));

        Assert(outcome is { Profiles: 3, Applied: 1, NothingToPin: 1, Missed: 1, FellShort: true },
            $"a list that could not take the rows is a miss; the list-less profile beside it is not (got {outcome})");
        var escalated = errorChannel.Where(l => l.StartsWith("headless seat mods slot=4", StringComparison.Ordinal)).ToList();
        Assert(escalated.Count == 1, "the seat's one line goes to the ERROR channel");
        Assert(escalated[0].EndsWith(
                "applied to only 1 of 3 profile(s) — the skip lines above say why; 1 without a mod list had nothing to pin",
                StringComparison.Ordinal),
            $"with the escalated wording, and the list-less profile still told apart (got '{escalated[0]}')");
        Assert(SeatLines(stderr, 4).Count == 1, "one line per seat, not one per channel on stderr");
        Assert(stderr.Contains("headless seat mod selection could not add slot=4", StringComparison.Ordinal),
            "the skip line it points at is there");

        // A profile that cannot be parsed at all is a miss too: nobody can say it had no list.
        DiskFixture.Write(offline, "{ not json");
        (errorChannel, _) = CaptureSeatLog(
            () => outcome = HeadlessSeatModSelection.ApplyToSeat(slotUserDir, Workshop, chosen, 6));
        Assert(outcome is { Profiles: 3, Applied: 1, NothingToPin: 0, Missed: 2, FellShort: true },
            $"an unparsable profile is a miss (got {outcome})");
        Assert(errorChannel.SingleOrDefault(l => l.StartsWith("headless seat mods slot=6", StringComparison.Ordinal)) is { } parseLine
            && parseLine.EndsWith("applied to only 1 of 3 profile(s) — the skip lines above say why", StringComparison.Ordinal),
            "and is escalated");

        // No profile at all, with something asked for, is not "nothing to pin": the seat carries nothing asked.
        Assert(SeatModPinOutcome.None.FellShort, "a seat with no profile at all falls short");
    }

    // Runs `action` with the seeder's ERROR-channel sink and stderr both captured: every place a seat launch's
    // mod-selection lines can go, short of the engine logger, which a test process cannot reach.
    private static (List<string> ErrorChannel, string Stderr) CaptureSeatLog(Action action)
    {
        var errorChannel = new List<string>();
        var stderr = new StringWriter();
        var previousSink = HeadlessUserDirSeeder.LogSink;
        var previousError = Console.Error;
        HeadlessUserDirSeeder.LogSink = errorChannel.Add;
        Console.SetError(stderr);
        try
        {
            action();
        }
        finally
        {
            Console.SetError(previousError);
            HeadlessUserDirSeeder.LogSink = previousSink;
        }

        return (errorChannel, stderr.ToString());
    }

    // The per-seat summary lines stderr carries for `slot`, prefix stripped.
    private static List<string> SeatLines(string stderr, int slot)
        => stderr.Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .Select(l => l.StartsWith(CouchCoopLog.Line(string.Empty), StringComparison.Ordinal)
                ? l[CouchCoopLog.Line(string.Empty).Length..]
                : l)
            .Where(l => l.StartsWith($"headless seat mods slot={slot}:", StringComparison.Ordinal))
            .ToList();

    private static void SeedingWithNothingChosenStillPinsAndStaysOffTheErrorChannel()
    {
        using var root = new TempDir();
        var xdg = Path.Combine(root.Path, "xdg");
        DiskFixture.Write(Path.Combine(xdg, "SlayTheSpire2", "steam", "1", "settings.save"), Settings("""
            [{"id": "couchcoop", "is_enabled": true, "source": "steam_workshop"}]
            """));

        var lines = new List<string>();
        var previousSink = HeadlessUserDirSeeder.LogSink;
        HeadlessUserDirSeeder.LogSink = lines.Add;
        try
        {
            var result = HeadlessUserDirSeeder.Prepare(
                5,
                HeadlessUserDirPlatform.Linux,
                key => key == "XDG_DATA_HOME" ? xdg : null,
                _ => Path.Combine(root.Path, "home"),
                seatModSourceToDisable: Workshop,
                hostChosenSeatModRows: []);
            Assert(Enabled(ModList(File.ReadAllText(Path.Combine(result!.SlotUserDir, "steam", "1", "settings.save"))),
                    "couchcoop", Workshop) == false,
                "with nothing host-chosen the copy pin still applies");
        }
        finally
        {
            HeadlessUserDirSeeder.LogSink = previousSink;
        }

        Assert(!lines.Any(l => l.Contains("headless seat mods", StringComparison.Ordinal)),
            "a seat with nothing host-chosen is routine, so its line stays off the error channel");

        Assert(HeadlessSeatModSelection.DescribeSeat(1, null, [], new SeatModPinOutcome(2, 1, 1, 0))
                .Contains("applied to only 1 of 2", StringComparison.Ordinal),
            "a partial application says so");
        Assert(!HeadlessSeatModSelection.DescribeSeat(1, null, [], new SeatModPinOutcome(2, 1, 1, 1))
                .Contains("only", StringComparison.Ordinal),
            "a profile with nothing to pin does not make an application partial");
        Assert(HeadlessSeatModSelection.DescribeSeat(1, null, [], SeatModPinOutcome.None)
                .Contains("nothing was disabled", StringComparison.Ordinal),
            "a seat with no profile to pin says nothing was disabled");
    }

    // ---------------------------------------------------------------------------------------------
    // 5. The service.
    // ---------------------------------------------------------------------------------------------

    private static void ServiceCachesOnlyASuccessfulInventoryRead()
    {
        using var root = new TempDir();
        var reads = 0;
        var snapshot = new SeatModInventorySnapshot([Minty, BaseLib], [new("MintySpire2", Workshop), new("BaseLib", Workshop)]);
        var service = new SeatModSelectionService(_ => { reads++; return snapshot; }, () => Path.Combine(root.Path, "s.json"));
        _ = service.ReadInventory();
        _ = service.ReadInventory();
        Assert(reads == 1, "the inventory is read once per process — the mod set does not change while the game runs");
        service.UseLoadedMods(NoSeatLoadedMods.Instance);
        _ = service.ReadInventory();
        Assert(reads == 2, "supplying a loaded-mod source drops the cache");

        var failures = 0;
        var failing = new SeatModSelectionService(_ => { failures++; return null; }, () => null);
        Assert(failing.ReadInventory().Count == 0 && failing.ReadInventory().Count == 0, "an unreadable inventory is empty");
        Assert(failures == 2, "…and is retried rather than cached, so a transient failure does not hide the panel");

        var throwing = new SeatModSelectionService(_ => throw new IOException("boom"), () => null);
        Assert(throwing.ReadInventory().Count == 0 && throwing.HostChosenSeatRows().Count == 0,
            "a throwing read is empty, never an exception to the caller");
    }

    private static void ServiceResolvesSeatRowsAcrossBothSources()
    {
        using var root = new TempDir();
        var store = Path.Combine(root.Path, "seat-mods.json");
        var lib = new SeatModDescriptor("BaseLib", Local, "BaseLib", false, []);
        var snapshot = new SeatModInventorySnapshot(
            [lib, Minty, IntentGraph],
            [new("BaseLib", Local), new("BaseLib", Workshop), new("MintySpire2", Workshop), new("intentgraph2", Workshop)]);
        var service = new SeatModSelectionService(_ => snapshot, () => store);

        Assert(service.HostChosenSeatRows().Count == 0, "nothing stored: nothing disabled — every mod on by default");

        service.WriteExplicitlyDisabled(["baselib"]);
        Assert(service.ReadExplicitlyDisabled().SequenceEqual(["baselib"]), "the store keeps the explicit choice only");
        Assert(service.HostChosenSeatRows().SequenceEqual(
                [new SeatModRowKey("BaseLib", Local), new SeatModRowKey("BaseLib", Workshop), new SeatModRowKey("MintySpire2", Workshop)]),
            "a seat is launched with every row of the chosen mod AND of its cascade, in mod_list order");

        var withGameplay = new SeatModSelectionService(
            _ => new SeatModInventorySnapshot([lib, Minty, Downfall], snapshot.Rows),
            () => store);
        Assert(withGameplay.HostChosenSeatRows().Count == 0,
            "a stored choice a new gameplay dependent has made illegal disables nothing");
    }

    // ---------------------------------------------------------------------------------------------

    private static List<JsonElement> ModList(string settingsJson)
    {
        using var document = JsonDocument.Parse(settingsJson);
        return document.RootElement.GetProperty("mod_settings").GetProperty("mod_list")
            .EnumerateArray().Select(element => element.Clone()).ToList();
    }

    private static string Row(string id, string source, bool enabled)
        => $$"""{"id": "{{id}}", "is_enabled": {{(enabled ? "true" : "false")}}, "source": "{{source}}"}""";

    private static string Rows(params string[] rows) => "[" + string.Join(", ", rows) + "]";

    private static bool? Enabled(List<JsonElement> rows, string id, string source)
    {
        foreach (var row in rows)
        {
            if (row.GetProperty("id").GetString() == id && row.GetProperty("source").GetString() == source)
                return row.GetProperty("is_enabled").GetBoolean();
        }

        return null;
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "couchcoop-seatmods-" + Guid.NewGuid().ToString("N"));

        public TempDir() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch { }
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition) throw new Exception($"SeatModSelectionTests failed: {label}.");
    }
}
