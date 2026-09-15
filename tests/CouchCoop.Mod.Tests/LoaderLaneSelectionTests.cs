using CouchCoop.Mod.HostUi;
using CouchCoop.Mod.Loader;

// WHICH IMPLEMENTATION LANE ONE PAYLOAD PICKS, and when it refuses to pick at all.
//
// CouchCoop ships a single Workshop payload carrying an implementation per game build under
// `lanes/<floor version>/`, because the two-branch-linked-revisions shape does not survive the Steam client:
// branch-linked resolution runs only on subscribe/first-acquire, and every later periodic refresh takes the
// item's NEWEST revision branch-blind — so a stable subscriber drifts onto the beta payload and the game
// refuses it outright. The runtime half of that fix is CouchCoopLaneSelection, and this is its gate.
//
// Pure: temp directories, fabricated release_info.json files, fabricated lane trees. No game, no Steam, no
// network, no Godot — which is the point, since the decision has to be made BEFORE any lane assembly loads.
//
// Reachable as `dotnet run --project tests/CouchCoop.Mod.Tests -- lanes`. Registered under its own verb and
// NOT only in the full sequence, which dies partway through on some machines (see the note above
// HeadlessAudioMuteTargetsTests in BrowserServerRouteTests.cs); a suite reachable only from there is a suite
// that has never run.
internal static class LoaderLaneSelectionTests
{
    public static void Run()
    {
        VersionParsingIsTolerantOfThePrefixesTheGameAndTheLanesUse();
        VersionParsingRefusesAnythingThatIsNotThreeNumbers();
        VersionComparisonIsNumericPerComponent();
        AnExactLaneWins();
        TheNearestLowerLaneWinsWhenThereIsNoExactMatch();
        AGameNewerThanEveryLaneStillGetsTheHighestLane();
        AGameOlderThanEveryLaneIsRefusedByName();
        NoLanesDirectoryIsTheFlatDevLayout();
        AFlatDeployBuiltForAnotherGameBuildIsRefusedByName();
        AFlatDeployWithNothingTrustworthyToCompareStaysSilent();
        ALanePayloadIgnoresTheDeployStamp();
        AnUndetectableGameVersionRefusesOnlyWhenLanesExist();
        ANonVersionDirectoryInsideLanesIsIgnored();
        AnEmptyLanesDirectoryIsRefusedRatherThanSilentlyFlat();
        TheInstallWalkFindsTheGameFromTheModDirectory();
        TheInstallWalkFailsOnTheWorkshopShapeSoTheProcessRungMatters();
        TheInstallWalkReachesIntoAMacOsAppBundle();
        ReleaseInfoIsReadVerbatimOrNotAtAll();
        ProbeOrderPutsTheLaneAheadOfTheSharedRoot();
        AnAlreadyLoadedCopyFromADifferentPathIsRefused();
        SharedPayloadFilesResolveFromThePayloadRootNotTheLane();
        AStaleRootCopyIsReportedRatherThanRefused();
        Console.WriteLine("LoaderLaneSelectionTests: ok");
    }

    /// <summary>
    /// A lane-owned assembly left at the mod root is named in the log, and never fatal.
    /// </summary>
    /// <remarks>
    /// Both arrangements happen for real and they want opposite verdicts, which is why this reports
    /// instead of refusing. Extracting a new release over an old one is the ordinary manual upgrade and
    /// leaves stale root copies from the pre-lanes layout — refusing there would break every such upgrade
    /// to fix nothing. A dev deploy over an old release install is the reverse: flat assemblies at the
    /// root, shadowed by a leftover `lanes/`, running old code with no symptom. That one is fixed in
    /// `scripts/build-local-mod.sh`, which removes `lanes/` before deploying; this message is the backstop
    /// if anything reintroduces it.
    /// </remarks>
    private static void AStaleRootCopyIsReportedRatherThanRefused()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1");
        var lane = Path.Combine(root.Path, "lanes", "0.107.1");
        File.WriteAllText(Path.Combine(lane, "CouchCoop.Mod.dll"), "lane");

        Assert(
            CouchCoopLaneSelection.DescribeIgnoredRootCopy(root.Path, lane, "CouchCoop.Mod") is null,
            "no message when the root holds no copy at all — the released payload's normal shape");

        File.WriteAllText(Path.Combine(root.Path, "CouchCoop.Mod.dll"), "stale root");
        var message = CouchCoopLaneSelection.DescribeIgnoredRootCopy(root.Path, lane, "CouchCoop.Mod");
        Assert(message is not null, "a root copy beside a chosen lane is reported");
        Assert(message!.Contains(lane, StringComparison.Ordinal), "the message names the lane in use");
        Assert(
            message.Contains(Path.Combine(root.Path, "CouchCoop.Mod.dll"), StringComparison.Ordinal),
            "the message names the ignored copy, so it can be deleted without guessing");

        // The flat dev layout has no lane, so there is nothing shadowing anything and nothing to say.
        Assert(
            CouchCoopLaneSelection.DescribeIgnoredRootCopy(root.Path, null, "CouchCoop.Mod") is null,
            "a flat deploy is silent");

        // Selection itself is unchanged by the stale copy: it still picks the lane, and does not refuse.
        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(selection.Refusal is null, "a stale root copy never refuses the mod");
        Assert(LaneName(selection) == "0.107.1", "the lane still wins over the root copy");
    }

    /// <summary>
    /// The implementation assembly is a level deeper than the files it serves, and must not look for them
    /// beside itself.
    /// </summary>
    /// <remarks>
    /// `frontend/` ships ONCE at the payload root while `CouchCoop.Mod.dll` ships per lane, so
    /// `CouchCoopHostUiServices` resolving its static root beside its own assembly would hand every browser
    /// client a directory that does not exist — a failure no unit test of the SELECTOR can see, because the
    /// lane is chosen correctly and only the serving is wrong.
    /// </remarks>
    private static void SharedPayloadFilesResolveFromThePayloadRootNotTheLane()
    {
        var separator = Path.DirectorySeparatorChar;
        var payload = $"{separator}game{separator}mods{separator}couchcoop";

        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot($"{payload}{separator}lanes{separator}0.107.1") == payload,
            "a lane directory resolves to the payload root above it");
        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot($"{payload}{separator}lanes{separator}0.111.0") == payload,
            "every lane resolves to the same payload root");
        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot($"{payload}{separator}lanes{separator}0.107.1{separator}")
                == payload,
            "a trailing separator does not defeat the lane test");

        // The flat dev deploy, which is what `scripts/build-local-mod.sh` writes.
        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot(payload) == payload,
            "a flat payload root is returned unchanged");

        // A `lanes` segment somewhere up the install path is NOT a lane directory: only the assembly's
        // immediate parent being named `lanes` is.
        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot($"{separator}lanes{separator}games{separator}couchcoop")
                == $"{separator}lanes{separator}games{separator}couchcoop",
            "a 'lanes' segment further up the path is left alone");
        Assert(
            CouchCoopHostUiServices.ResolvePayloadRoot(string.Empty) == string.Empty,
            "an empty directory is returned unchanged rather than throwing");
    }

    // ---------------------------------------------------------------------------------------------
    // Parsing.
    // ---------------------------------------------------------------------------------------------

    private static void VersionParsingIsTolerantOfThePrefixesTheGameAndTheLanesUse()
    {
        // The install writes the prefix ("version": "v0.107.1" on the stable build, "v0.111.0" on the beta);
        // the lane directories are bare so they read as ordinary version folders. Both must parse to the
        // same thing or the exact-match case never fires.
        Assert(Parsed("v0.107.1") == Parsed("0.107.1"), "a leading v is stripped");
        Assert(Parsed("V0.107.1") == Parsed("0.107.1"), "an upper-case V is stripped too");

        // Suffixes are truncated rather than refused: a game build that ships one must still land in the
        // lane its numeric version selects, instead of the mod refusing to load over punctuation.
        Assert(Parsed("0.111.0-beta") == Parsed("0.111.0"), "a prerelease suffix is truncated");
        Assert(Parsed("0.111.0+build.42") == Parsed("0.111.0"), "a build suffix is truncated");
        Assert(Parsed("v0.111.0-beta.2+sha.abc") == Parsed("0.111.0"), "prefix and both suffixes together");
        Assert(Parsed("  v0.107.1  ") == Parsed("0.107.1"), "surrounding whitespace is trimmed");
    }

    private static void VersionParsingRefusesAnythingThatIsNotThreeNumbers()
    {
        foreach (var rejected in new[]
        {
            null, "", "   ", "0.107", "0.107.1.2", "0", "abc", "0.1a.1", "0..1", "v", "0.107.x",
            // The v is only stripped when a DIGIT follows, so this stays a name rather than becoming a
            // version with a missing major.
            "vnext",
            // NumberStyles.None: no sign, no whitespace, no separators inside a component.
            "+0.107.1", "0.-1.1", "0. 107.1", "0.1,000.1",
        })
        {
            Assert(!CouchCoopLaneSelection.TryParseVersion(rejected, out _), $"'{rejected ?? "<null>"}' is not a version");
        }
    }

    private static void VersionComparisonIsNumericPerComponent()
    {
        // The regression this exists for: ordinally, "0.111.0" sorts BELOW "0.9.0", so a text comparison
        // would pick the v0.107.1 lane for a v0.111.0 game the moment the minor went two digits.
        Assert(Parsed("0.111.0").CompareTo(Parsed("0.9.0")) > 0, "0.111.0 is newer than 0.9.0");
        Assert(Parsed("0.107.1").CompareTo(Parsed("0.107.10")) < 0, "0.107.1 is older than 0.107.10");
        Assert(Parsed("1.0.0").CompareTo(Parsed("0.999.999")) > 0, "the major dominates");
        Assert(Parsed("0.107.1").CompareTo(Parsed("0.107.1")) == 0, "equal versions compare equal");
    }

    // ---------------------------------------------------------------------------------------------
    // Selection.
    // ---------------------------------------------------------------------------------------------

    private static void AnExactLaneWins()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0");

        var stable = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(stable.Refusal is null, "an exact match is not a refusal");
        Assert(LaneName(stable) == "0.107.1", $"v0.107.1 picks the 0.107.1 lane, not '{LaneName(stable)}'");
        Assert(stable.DetectedVersion == "v0.107.1", "the detected version is carried through verbatim");

        // The whole reason the mechanism exists: the SAME payload, the same directory, under the beta.
        var beta = CouchCoopLaneSelection.Select(root.Path, "v0.111.0");
        Assert(LaneName(beta) == "0.111.0", $"v0.111.0 picks the 0.111.0 lane, not '{LaneName(beta)}'");
    }

    private static void TheNearestLowerLaneWinsWhenThereIsNoExactMatch()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0");

        var selection = CouchCoopLaneSelection.Select(root.Path, "0.109.0");
        Assert(selection.Refusal is null, "a game between two lanes is not a refusal");
        Assert(LaneName(selection) == "0.107.1",
            $"0.109.0 takes the highest lane at or below it, not '{LaneName(selection)}'");
    }

    private static void AGameNewerThanEveryLaneStillGetsTheHighestLane()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0");

        // A game patch that changed nothing CouchCoop binds to must not take the mod offline for everyone
        // who applied it, which is what an exact-match rule would do on the day v0.112.0 ships.
        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.112.0");
        Assert(selection.Refusal is null, "a game newer than every lane is not a refusal");
        Assert(LaneName(selection) == "0.111.0", $"v0.112.0 takes the 0.111.0 lane, not '{LaneName(selection)}'");
    }

    private static void AGameOlderThanEveryLaneIsRefusedByName()
    {
        using var root = new TempDir();
        Lanes(root, "0.111.0");

        // The opposite direction is NOT nearest-anything. A lane compiled against a newer game binds members
        // the running build does not have, and the failure surfaces from inside a game callback with nothing
        // naming CouchCoop — so it is refused here, where the message can say what happened.
        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(selection.LaneDirectory is null, "a refusal chooses no lane");
        Assert(selection.Refusal is not null, "a game older than every lane refuses");
        Assert(selection.Refusal!.Contains("v0.107.1", StringComparison.Ordinal),
            $"the refusal names the detected version: {selection.Refusal}");
        Assert(selection.Refusal.Contains("0.111.0", StringComparison.Ordinal),
            $"the refusal names the lanes that are present: {selection.Refusal}");
    }

    private static void NoLanesDirectoryIsTheFlatDevLayout()
    {
        using var root = new TempDir();
        File.WriteAllText(Path.Combine(root.Path, "CouchCoop.Mod.dll"), "not really a dll");

        // scripts/build-local-mod.sh writes exactly this shape and predates lanes entirely. It must keep
        // working untouched, and SILENTLY — no refusal, no lane, and nothing to log.
        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(selection.LaneDirectory is null, "a flat payload selects no lane");
        Assert(selection.Refusal is null, "a flat payload is not a refusal");

        // ...including when the game version could not be read at all, which is the case on a dev machine
        // whose mod directory is not under the install.
        var unknown = CouchCoopLaneSelection.Select(root.Path, null);
        Assert(unknown.LaneDirectory is null && unknown.Refusal is null,
            "a flat payload with an unknown game version is still just flat");
    }

    /// <summary>
    /// The guard this whole flat-payload branch exists for: a dev deploy left behind by a game update.
    /// </summary>
    /// <remarks>
    /// The real incident, Sep 15 2026. The install was switched from stable to the public beta; the deploy
    /// in `mods/couchcoop` had been built at 18:18 against v0.107.1 and was still there. With no `lanes/`
    /// directory the loader took the flat path silently, loaded the v107 implementation into a v0.111.0
    /// game, and the bridge's API manifest died on `Could not load type '…Multiplayer.LobbyPlayer'` — a
    /// forty-frame stack naming a GAME type, which reads as "the game is broken" and names neither build.
    /// </remarks>
    private static void AFlatDeployBuiltForAnotherGameBuildIsRefusedByName()
    {
        using var root = new TempDir();
        File.WriteAllText(Path.Combine(root.Path, "CouchCoop.Mod.dll"), "not really a dll");
        LocalBuildInfo(root, "v0.107.1");

        var matched = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(matched.Refusal is null, "the build it was compiled for loads, which is every ordinary deploy");
        Assert(matched.LaneDirectory is null, "…and is still flat");

        var refused = CouchCoopLaneSelection.Select(root.Path, "v0.111.0");
        Assert(refused.LaneDirectory is null, "a refusal chooses nothing");
        Assert(refused.Refusal is not null, "a deploy built for another game build refuses");
        Assert(refused.Refusal!.Contains("v0.107.1", StringComparison.Ordinal),
            $"the refusal names the build this payload IS: {refused.Refusal}");
        Assert(refused.Refusal.Contains("v0.111.0", StringComparison.Ordinal),
            $"the refusal names the build that is installed: {refused.Refusal}");
        Assert(refused.Refusal.Contains("build-local-mod.sh", StringComparison.Ordinal),
            $"the refusal names the one command that fixes it: {refused.Refusal}");

        // EXACT, not nearest-lower-or-equal. This is the direction a lane accepts (v0.112.0 keeps taking the
        // 0.111.0 lane) and the direction that produced the crash, so the two rules must not be confused: a
        // flat payload carries one compile and knows only the one build it was compiled against.
        Assert(
            CouchCoopLaneSelection.Select(root.Path, "v0.107.2").Refusal is not null,
            "a NEWER game than the one this was built for still refuses");
        Assert(
            CouchCoopLaneSelection.Select(root.Path, "v0.106.0").Refusal is not null,
            "so does an older one");

        // The stamp writes the prefix and the parse is numeric, so the two spellings must agree.
        using var bare = new TempDir();
        LocalBuildInfo(bare, "0.107.1");
        Assert(CouchCoopLaneSelection.Select(bare.Path, "v0.107.1").Refusal is null,
            "'0.107.1' and 'v0.107.1' are the same build");
    }

    /// <summary>
    /// Every way the comparison can come up empty, all of which must stay flat and silent.
    /// </summary>
    /// <remarks>
    /// A guard that refused whenever it could not answer would take the mod down over a missing diagnostic
    /// rather than over a real mismatch — and three of these five are ordinary, not broken.
    /// </remarks>
    private static void AFlatDeployWithNothingTrustworthyToCompareStaysSilent()
    {
        // No stamp at all: a hand-assembled payload, or a deploy older than stamp-local-mod.sh.
        using var unstamped = new TempDir();
        Assert(CouchCoopLaneSelection.ReadFlatBuildGameVersion(unstamped.Path) is null, "no stamp, no answer");
        Assert(CouchCoopLaneSelection.Select(unstamped.Path, "v0.111.0").Refusal is null,
            "an unstamped flat payload is still just flat");

        // `unknown` is what the stamp writes when the lane probe could not read the install.
        using var unknown = new TempDir();
        LocalBuildInfo(unknown, "unknown");
        Assert(CouchCoopLaneSelection.ReadFlatBuildGameVersion(unknown.Path) is null,
            "'unknown' is the absence of an answer, not an answer");
        Assert(CouchCoopLaneSelection.Select(unknown.Path, "v0.111.0").Refusal is null, "…so nothing refuses");

        // A RELEASE stamp names a reference package per lane and no single build. It should never reach the
        // flat path (a release payload carries lanes/), but if it does it must not be read as one build.
        using var release = new TempDir();
        File.WriteAllText(
            Path.Combine(release.Path, CouchCoopLaneSelection.BuildInfoFileName),
            """
            {
              "schemaVersion": "couchcoop-release-build-info/v2",
              "dependencies": {
                "sts2References": {
                  "stable": { "gameBuild": "v0.107.1", "bridgeGameApi": "v107" },
                  "public-beta": { "gameBuild": "v0.111.0", "bridgeGameApi": "v111" }
                }
              }
            }
            """);
        Assert(CouchCoopLaneSelection.ReadFlatBuildGameVersion(release.Path) is null,
            "a release stamp carries no single compiled-for build");
        Assert(CouchCoopLaneSelection.Select(release.Path, "v0.111.0").Refusal is null,
            "…and so cannot refuse anything");

        // Unparseable and unreadable stamps: a truncated write, and a version the ladder cannot compare.
        using var malformed = new TempDir();
        File.WriteAllText(Path.Combine(malformed.Path, CouchCoopLaneSelection.BuildInfoFileName), "{ not json");
        Assert(CouchCoopLaneSelection.ReadFlatBuildGameVersion(malformed.Path) is null, "broken JSON is silent");
        Assert(CouchCoopLaneSelection.Select(malformed.Path, "v0.111.0").Refusal is null, "…and never fatal");

        using var nonVersion = new TempDir();
        LocalBuildInfo(nonVersion, "main");
        Assert(CouchCoopLaneSelection.Select(nonVersion.Path, "v0.111.0").Refusal is null,
            "a stamp that is not a M.m.p version cannot be compared, so it is accepted");

        // And the other side of the comparison: a game whose version could not be read. A flat payload with
        // an undetectable install was already silent before this guard existed, and must stay that way.
        using var stamped = new TempDir();
        LocalBuildInfo(stamped, "v0.107.1");
        Assert(CouchCoopLaneSelection.Select(stamped.Path, null).Refusal is null,
            "an undetectable game version is not a mismatch");
    }

    /// <summary>The stamp is the FLAT payload's build identity, and a lane payload has its own.</summary>
    /// <remarks>
    /// A release archive extracted over an older one can leave a stale root `build-info.txt` beside a fresh
    /// `lanes/` tree — the same shape `DescribeIgnoredRootCopy` exists for. Reading it there would refuse a
    /// payload that is choosing its lane perfectly well.
    /// </remarks>
    private static void ALanePayloadIgnoresTheDeployStamp()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0");
        LocalBuildInfo(root, "v0.107.1");

        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.111.0");
        Assert(selection.Refusal is null, "a stale stamp beside lanes/ never refuses");
        Assert(LaneName(selection) == "0.111.0", $"the lane still decides — got '{LaneName(selection)}'");
    }

    private static void AnUndetectableGameVersionRefusesOnlyWhenLanesExist()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0");

        foreach (var undetectable in new[] { null, "", "   ", "not-a-version", "0.107" })
        {
            var selection = CouchCoopLaneSelection.Select(root.Path, undetectable);
            Assert(selection.LaneDirectory is null, $"'{undetectable ?? "<null>"}' chooses no lane");
            Assert(selection.Refusal is not null, $"'{undetectable ?? "<null>"}' refuses");
            Assert(selection.Refusal!.Contains("0.107.1", StringComparison.Ordinal)
                && selection.Refusal.Contains("0.111.0", StringComparison.Ordinal),
                $"the refusal names the lanes present: {selection.Refusal}");
        }

        // Not a fall-back to the newest lane. "I cannot tell which game this is" and "this is the newest
        // game" are different facts, and guessing the second from the first is how a stable install ends up
        // running beta code — the exact failure the lane payload exists to stop.
        var unreadable = CouchCoopLaneSelection.Select(root.Path, "not-a-version");
        Assert(unreadable.Refusal!.Contains("not-a-version", StringComparison.Ordinal),
            $"the refusal quotes what the install actually said: {unreadable.Refusal}");
    }

    private static void ANonVersionDirectoryInsideLanesIsIgnored()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1", "0.111.0", "backup", "0.111", "README");

        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.111.0");
        Assert(LaneName(selection) == "0.111.0",
            $"an unparseable sibling directory is skipped, not fatal — got '{LaneName(selection)}'");

        // But it is still NAMED when something goes wrong: a misnamed lane folder ("0.111") is precisely the
        // case where listing only the parseable names would hide the reason the payload cannot answer.
        using var misnamedOnly = new TempDir();
        Lanes(misnamedOnly, "0.111", "backup");
        var refused = CouchCoopLaneSelection.Select(misnamedOnly.Path, "v0.111.0");
        Assert(refused.Refusal is not null, "a lanes directory with no parseable lane refuses");
        Assert(refused.Refusal!.Contains("0.111", StringComparison.Ordinal)
            && refused.Refusal.Contains("backup", StringComparison.Ordinal),
            $"the refusal lists every directory present, parseable or not: {refused.Refusal}");
    }

    private static void AnEmptyLanesDirectoryIsRefusedRatherThanSilentlyFlat()
    {
        using var root = new TempDir();
        Directory.CreateDirectory(Path.Combine(root.Path, "lanes"));

        // A `lanes/` directory that answers nothing is a broken payload, not a dev deploy. Falling back to
        // the flat root would look for CouchCoop.Mod.dll beside the loader, where a lane payload never puts
        // it, and report a missing file instead of a missing lane.
        var selection = CouchCoopLaneSelection.Select(root.Path, "v0.107.1");
        Assert(selection.Refusal is not null, "an empty lanes directory refuses");
        Assert(selection.LaneDirectory is null, "an empty lanes directory chooses no lane");
    }

    // ---------------------------------------------------------------------------------------------
    // Finding the running game.
    // ---------------------------------------------------------------------------------------------

    private static void TheInstallWalkFindsTheGameFromTheModDirectory()
    {
        using var install = new TempDir();
        File.WriteAllText(
            Path.Combine(install.Path, "release_info.json"),
            """{"version":"v0.107.1","main_assembly_hash":1234}""");
        var modDirectory = Path.Combine(install.Path, "mods", "couchcoop");
        Directory.CreateDirectory(modDirectory);

        // Rung 1: a mod deployed into the install sits two levels below release_info.json.
        var root = CouchCoopLaneSelection.TryWalkToInstallRoot(modDirectory);
        Assert(root is not null, "the walk finds the install from <install>/mods/couchcoop");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(root) == "v0.107.1",
            "the walk's install root yields the declared version");

        // The lane payload also puts assemblies one level deeper; the bound has to cover that too.
        var laneDirectory = Path.Combine(modDirectory, "lanes", "0.107.1");
        Directory.CreateDirectory(laneDirectory);
        Assert(CouchCoopLaneSelection.TryWalkToInstallRoot(laneDirectory) is not null,
            "the walk still reaches the install from inside a lane directory");
    }

    private static void TheInstallWalkFailsOnTheWorkshopShapeSoTheProcessRungMatters()
    {
        // steamapps/workshop/content/<appid>/<item>/ is a sibling branch of the tree and is NEVER an
        // ancestor of the game, so walking up from a subscribed item can only fail. That is the shape every
        // real player has — which is why the process-executable rung is not an optional nicety, and why this
        // asserts the failure rather than assuming it.
        using var steamapps = new TempDir();
        var item = Path.Combine(steamapps.Path, "workshop", "content", "2868840", "3800644054");
        Directory.CreateDirectory(item);
        var install = Path.Combine(steamapps.Path, "common", "Slay the Spire 2");
        Directory.CreateDirectory(install);
        File.WriteAllText(Path.Combine(install, "release_info.json"), """{"version":"v0.111.0"}""");

        Assert(CouchCoopLaneSelection.TryWalkToInstallRoot(item) is null,
            "the walk from a Workshop item does not reach the install");

        // ...and the second rung, starting at the game executable's own directory, does.
        var executableDirectory = Path.Combine(install, "data_sts2_linuxbsd_x86_64");
        Directory.CreateDirectory(executableDirectory);
        var fromProcess = CouchCoopLaneSelection.TryWalkToInstallRoot(executableDirectory);
        Assert(CouchCoopLaneSelection.ReadInstallVersion(fromProcess) == "v0.111.0",
            "the process-executable rung reaches the install a Workshop item cannot see");
    }

    // THE macOS SHAPE, and it is the difference between the mod running and not running at all. A .app keeps
    // its executable in Contents/MacOS/ and its shipped data in Contents/Resources/ — SIBLINGS — so
    // release_info.json is an ancestor of neither starting point, and no walk depth reaches a sibling. With no
    // version, Select() refuses to pick a lane (correctly: it must never guess which build this is), so a
    // SHIPPED laned payload logged one line and loaded nothing at all. That is "the mod doesn't work on macOS".
    private static void TheInstallWalkReachesIntoAMacOsAppBundle()
    {
        using var temp = new TempDir();
        var contents = Path.Combine(temp.Path, "Slay the Spire 2", "SlayTheSpire2.app", "Contents");
        var resources = Path.Combine(contents, "Resources");
        var macOs = Path.Combine(contents, "MacOS");
        Directory.CreateDirectory(resources);
        Directory.CreateDirectory(macOs);
        File.WriteAllText(Path.Combine(resources, "release_info.json"), """{"version":"v0.111.0"}""");

        // Rung 1: this loader, deployed into the bundle's mods directory.
        var modDirectory = Path.Combine(macOs, "mods", "couchcoop");
        Directory.CreateDirectory(modDirectory);
        Assert(CouchCoopLaneSelection.ReadInstallVersion(
                CouchCoopLaneSelection.TryWalkToInstallRoot(modDirectory)) == "v0.111.0",
            "the walk reaches the bundle's resources from a mod inside Contents/MacOS/mods");

        // …and one level deeper, because the game's mod scan is recursive and a payload may nest.
        var nested = Path.Combine(modDirectory, "lanes", "0.111.0");
        Directory.CreateDirectory(nested);
        Assert(CouchCoopLaneSelection.TryWalkToInstallRoot(nested) is not null,
            "…and still reaches it from inside a lane directory under that");

        // Rung 2: the executable's own directory, which is what a Workshop install falls through to.
        Assert(CouchCoopLaneSelection.ReadInstallVersion(
                CouchCoopLaneSelection.TryWalkToInstallRoot(macOs)) == "v0.111.0",
            "the process rung reaches it from Contents/MacOS itself");

        // The bundle also has a flatter shape, with the file beside the binary. That one an ordinary upward
        // walk already reached, and it must keep winning where it exists: the tree we are sitting in is the
        // more specific answer than a sibling of one of its ancestors.
        File.WriteAllText(Path.Combine(macOs, "release_info.json"), """{"version":"v0.107.1"}""");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(
                CouchCoopLaneSelection.TryWalkToInstallRoot(modDirectory)) == "v0.107.1",
            "a version file beside the binary is preferred to the bundle's resources");

        // The sideways step is gated on the `.app` suffix. Reading a stranger's release_info.json would pick a
        // lane for a game this is not running under, which is the one outcome lanes exist to prevent.
        var impostor = Path.Combine(temp.Path, "some", "project", "Contents");
        Directory.CreateDirectory(Path.Combine(impostor, "Resources"));
        Directory.CreateDirectory(Path.Combine(impostor, "MacOS"));
        File.WriteAllText(Path.Combine(impostor, "Resources", "release_info.json"), """{"version":"v9.9.9"}""");
        Assert(CouchCoopLaneSelection.TryWalkToInstallRoot(Path.Combine(impostor, "MacOS")) is null,
            "an ordinary directory named Contents is not treated as a bundle");
    }

    private static void ReleaseInfoIsReadVerbatimOrNotAtAll()
    {
        using var install = new TempDir();
        var path = Path.Combine(install.Path, "release_info.json");

        // Verbatim, prefix included: a refusal message naming "0.107.1" when the file says "v0.107.1" sends
        // the reader looking for a string that is not there.
        File.WriteAllText(path, """{"version":"v0.107.1"}""");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(install.Path) == "v0.107.1", "the version is read verbatim");

        // Every shape of "this install would not say" is null, never a guess.
        Assert(CouchCoopLaneSelection.ReadInstallVersion(null) is null, "a null root reads nothing");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(Path.Combine(install.Path, "absent")) is null,
            "a missing install reads nothing");

        File.WriteAllText(path, "{ this is not json");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(install.Path) is null, "malformed JSON reads nothing");

        File.WriteAllText(path, """{"main_assembly_hash":1234}""");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(install.Path) is null, "a missing version reads nothing");

        File.WriteAllText(path, """{"version":107}""");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(install.Path) is null, "a non-string version reads nothing");

        File.WriteAllText(path, """["v0.107.1"]""");
        Assert(CouchCoopLaneSelection.ReadInstallVersion(install.Path) is null, "a non-object document reads nothing");

        // And the end-to-end consequence, which is the pairing this suite is really about: an install that
        // will not say which build it is, with lanes present, refuses.
        using var payload = new TempDir();
        Lanes(payload, "0.107.1", "0.111.0");
        var selection = CouchCoopLaneSelection.Select(
            payload.Path,
            CouchCoopLaneSelection.ReadInstallVersion(install.Path));
        Assert(selection.Refusal is not null, "an unreadable release_info.json plus lanes is a refusal");
    }

    // ---------------------------------------------------------------------------------------------
    // Probing.
    // ---------------------------------------------------------------------------------------------

    private static void ProbeOrderPutsTheLaneAheadOfTheSharedRoot()
    {
        using var root = new TempDir();
        Lanes(root, "0.107.1");
        var lane = Path.Combine(root.Path, "lanes", "0.107.1");

        // The lane owns the lane-varying pair...
        File.WriteAllText(Path.Combine(lane, "CouchCoop.Mod.dll"), "lane copy");
        // ...the root owns everything both lanes share, one copy each.
        File.WriteAllText(Path.Combine(root.Path, "CouchCoop.Mod.Contracts.dll"), "shared copy");

        string[] probe = [lane, root.Path];
        Assert(CouchCoopLaneSelection.FindAssembly(probe, "CouchCoop.Mod") == Path.Combine(lane, "CouchCoop.Mod.dll"),
            "the lane answers for a lane-varying assembly");
        Assert(
            CouchCoopLaneSelection.FindAssembly(probe, "CouchCoop.Mod.Contracts")
                == Path.Combine(root.Path, "CouchCoop.Mod.Contracts.dll"),
            "the root answers for a shared assembly");
        Assert(CouchCoopLaneSelection.FindAssembly(probe, "System.Text.Json") is null,
            "an assembly this payload does not ship is not claimed");
        Assert(CouchCoopLaneSelection.FindAssembly(probe, null) is null, "a nameless request is not claimed");

        // A stale root copy of a lane-varying assembly (an upgrade over a flat install, say) must NOT win.
        File.WriteAllText(Path.Combine(root.Path, "CouchCoop.Mod.dll"), "stale flat copy");
        Assert(CouchCoopLaneSelection.FindAssembly(probe, "CouchCoop.Mod") == Path.Combine(lane, "CouchCoop.Mod.dll"),
            "the lane still wins over a leftover copy beside the loader");
    }

    private static void AnAlreadyLoadedCopyFromADifferentPathIsRefused()
    {
        const string lane = "/mods/couchcoop/lanes/0.107.1/CouchCoop.Mod.dll";
        const string workshop = "/steamapps/workshop/content/2868840/3800644054/lanes/0.111.0/CouchCoop.Mod.dll";

        // The guard's whole job: two installed copies of CouchCoop, or the OTHER lane, already loaded under
        // a matching simple name. Handing that back silently runs a foreign binary with no symptom until it
        // binds a game member that moved.
        var conflict = CouchCoopLaneSelection.DescribeLoadedCopyConflict("CouchCoop.Mod", workshop, lane);
        Assert(conflict is not null, "a loaded copy from a different path is a conflict");
        Assert(conflict!.Fatal, "a foreign copy of an assembly CouchCoop owns is fatal");
        Assert(conflict.Message.Contains(workshop, StringComparison.Ordinal),
            $"the message names the loaded copy: {conflict.Message}");
        Assert(conflict.Message.Contains(lane, StringComparison.Ordinal),
            $"the message names the copy we would load: {conflict.Message}");

        // The loader's own assembly name is lower-case and carries no dot, so the ownership rule has to be a
        // prefix test rather than a "CouchCoop." namespace test.
        Assert(
            CouchCoopLaneSelection.DescribeLoadedCopyConflict(
                "couchcoop", "/other/couchcoop.dll", "/mods/couchcoop/couchcoop.dll") is { Fatal: true },
            "the loader's own assembly name counts as owned");
        Assert(
            CouchCoopLaneSelection.DescribeLoadedCopyConflict(
                "CouchCoop.Spirectl", "/other/CouchCoop.Spirectl.dll", lane) is { Fatal: true },
            "the privately renamed spirectl copy counts as owned");

        // NOT fatal for a bundled third-party dll. System.Diagnostics.DiagnosticSource.dll ships in the
        // GAME's own assembly directory on both v0.107.1 and v0.111.0 as well as in this payload, so binding
        // to the copy already in the process is the CLR's ordinary unification and is what worked before
        // lanes existed. Refusing there would invent a new way for the mod to die where nothing is wrong —
        // but it is still said out loud, because it is the shape a real incompatibility would take.
        var bundled = CouchCoopLaneSelection.DescribeLoadedCopyConflict(
            "System.Diagnostics.DiagnosticSource",
            "/game/data_sts2_linuxbsd_x86_64/System.Diagnostics.DiagnosticSource.dll",
            "/mods/couchcoop/System.Diagnostics.DiagnosticSource.dll");
        Assert(bundled is not null, "a bundled third-party dll loaded from elsewhere is still reported");
        Assert(!bundled!.Fatal, "a bundled third-party dll loaded from elsewhere is NOT fatal");

        // The same file is the normal case and must stay silent, including via a non-canonical spelling —
        // an unnormalised path would make every resolve after the first one fail.
        Assert(CouchCoopLaneSelection.DescribeLoadedCopyConflict("CouchCoop.Mod", lane, lane) is null,
            "the same path is not a conflict");
        Assert(
            CouchCoopLaneSelection.DescribeLoadedCopyConflict(
                "CouchCoop.Mod", "/mods/couchcoop/lanes/0.107.1/./CouchCoop.Mod.dll", lane) is null,
            "the comparison is on full paths, not on spelling");

        // Three cases that must NOT fire, because a false refusal takes the mod down where nothing is wrong:
        Assert(CouchCoopLaneSelection.DescribeLoadedCopyConflict("Newtonsoft.Json", "/game/Newtonsoft.Json.dll", null) is null,
            "a name this payload does not ship is somebody else's to answer for");
        Assert(CouchCoopLaneSelection.DescribeLoadedCopyConflict("CouchCoop.Mod", null, lane) is null,
            "an assembly with no location cannot be compared, so it is accepted");
        Assert(CouchCoopLaneSelection.DescribeLoadedCopyConflict("CouchCoop.Mod", "", lane) is null,
            "an empty location is the same 'cannot compare' answer");
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers.
    // ---------------------------------------------------------------------------------------------

    private static CouchCoopLaneSelection.LaneVersion Parsed(string text)
    {
        Assert(CouchCoopLaneSelection.TryParseVersion(text, out var version), $"'{text}' parses as a version");
        return version;
    }

    private static void Lanes(TempDir root, params string[] names)
    {
        foreach (var name in names)
        {
            Directory.CreateDirectory(Path.Combine(root.Path, "lanes", name));
        }
    }

    /// <summary>
    /// The dev-deploy stamp, in the shape <c>scripts/stamp-local-mod.sh</c> writes it — schema name, and
    /// the compiled-against build nested under <c>dependencies.sts2References.version</c>.
    /// </summary>
    private static void LocalBuildInfo(TempDir root, string gameVersion) =>
        File.WriteAllText(
            Path.Combine(root.Path, CouchCoopLaneSelection.BuildInfoFileName),
            $$"""
            {
              "schemaVersion": "couchcoop-local-build-info/v1",
              "version": "9999.0.0+dev.abcdef012345",
              "dependencies": {
                "sts2References": { "lane": "v107", "id": "local-install", "version": "{{gameVersion}}" }
              }
            }
            """);

    private static string? LaneName(CouchCoopLaneSelection.LaneSelection selection) =>
        selection.LaneDirectory is null ? null : Path.GetFileName(selection.LaneDirectory);

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "couchcoop-lanes-" + Guid.NewGuid().ToString("N"));

        public TempDir() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            try { Directory.Delete(Path, recursive: true); } catch { }
        }
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"LoaderLaneSelectionTests failed: {label}.");
        }
    }
}
