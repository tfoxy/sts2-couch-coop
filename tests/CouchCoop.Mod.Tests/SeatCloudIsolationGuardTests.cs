using System.Text.Json;
using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Localization;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;

namespace CouchCoop.Mod.Tests;

// "A seat that cannot guarantee Steam Cloud save isolation must not keep running" — the pure half of it: the
// verdict a set of refused write paths becomes, the test lever that forces that verdict, and the player-facing
// copy the host issue carries. No Harmony install, no live game, no Steam client, no process to kill: the guard's
// decision is separated from its exit precisely so it can be asserted here.
//
// The other halves live where they can be reached: the TARGET list is SeatCloudSaveIsolationTargetsTests (under
// `-- beta-targets`, because it reflects over the installed STS2 assemblies), and the host's reaction to a seat
// that refuses — or never declares — is in HeadlessConnectionLifecycleTests (`-- connections`).
internal static class SeatCloudIsolationGuardTests
{
    public static void Run()
    {
        NothingRefusedIsNoFailure();
        ARefusedPathNamesItselfAndTheStakes();
        TheTestLeverIsExactlyOneValue();
        AnAbsentDeclarationSurvivesTheWireAsNotDeclared();
        TheIssueCopyMatchesTheCatalogTheHostWillRender();
        Console.WriteLine("SeatCloudIsolationGuardTests: ok");
    }

    private static void NothingRefusedIsNoFailure()
        => Assert(HeadlessSeatCloudIsolationGuard.Failure([], 12) is null,
            "a seat that closed every write path has nothing to report and keeps running");

    // The detail is the whole support answer for this failure: WHICH path stayed open, and why that matters to
    // someone whose saves are on the line. A count on its own ("1 of 12 failed") names nothing to act on.
    private static void ARefusedPathNamesItselfAndTheStakes()
    {
        var detail = HeadlessSeatCloudIsolationGuard.Failure(
            ["SteamRemoteSaveStore.ForgetFile(String) does not resolve against the installed STS2 assemblies"], 12);
        Assert(detail is not null, "a refused path is a failure, not a warning");
        Assert(detail!.Contains("ForgetFile", StringComparison.Ordinal),
            "the detail names the path that stayed open");
        Assert(detail.Contains("1 of 12", StringComparison.Ordinal),
            "…and how much of the protection is missing");
        Assert(detail.Contains("Steam Cloud", StringComparison.Ordinal)
            && detail.Contains("overwrites the saves", StringComparison.Ordinal),
            "…and what is at stake, because the reader of this line is deciding whether to retry");

        var many = HeadlessSeatCloudIsolationGuard.Failure(["first path", "second path"], 12);
        Assert(many!.Contains("first path", StringComparison.Ordinal)
            && many.Contains("second path", StringComparison.Ordinal),
            "every refused path is listed — a game update usually moves several members at once");
    }

    // The lever exists so a live QA leg can exercise the refusal without editing code. It must answer to exactly
    // one value: anything looser and an environment set for some other tool starts refusing players' seats.
    private static void TheTestLeverIsExactlyOneValue()
    {
        Assert(SeatCloudSaveIsolationPatch.ForcedFailure("1"), "1 arms the lever");
        Assert(SeatCloudSaveIsolationPatch.ForcedFailure(" 1 "), "…whitespace around it included");
        foreach (var raw in new string?[] { null, "", "   ", "0", "true", "yes", "on", "11", "1.0" })
        {
            Assert(!SeatCloudSaveIsolationPatch.ForcedFailure(raw),
                $"'{raw ?? "<unset>"}' leaves an ordinary launch completely untouched");
        }
    }

    // The whole positive handshake rests on one JSON field, and on the direction its ABSENCE defaults in. A
    // payload that never carries it — an older or foreign CouchCoop heartbeating on a seat slot — must come out
    // of the deserializer as "did not declare", because that is the payload the host has to refuse.
    private static void AnAbsentDeclarationSurvivesTheWireAsNotDeclared()
    {
        var declared = JsonSerializer.Serialize(
            new HeadlessConnectionStatus(1, "Connecting", null, null, 0, 13357, 0, CloudSaveIsolated: true));
        Assert(JsonSerializer.Deserialize<HeadlessConnectionStatus>(declared)!.CloudSaveIsolated,
            "a seat that declares the isolation is understood as having declared it");

        const string withoutTheField =
            """{"Sequence":1,"NativePhase":"Connecting","ConnectedChildBrowserCount":0,"BrowserPort":13357}""";
        Assert(!JsonSerializer.Deserialize<HeadlessConnectionStatus>(withoutTheField)!.CloudSaveIsolated,
            "a status that never carried the field is NOT a declaration — the one default that must fail closed");
    }

    // The panel and the phone render the LOCALIZED twin of this issue, keyed on its code; the copyable report
    // carries the English. Keep them word for word, or a report and the panel above it read as two findings.
    private static void TheIssueCopyMatchesTheCatalogTheHostWillRender()
    {
        var issue = HeadlessClientManager.SeatCloudIsolationIssue("detail");
        Assert(issue.Code == HeadlessClientManager.SeatCloudIsolationCode, "the issue carries its own code");
        var english = CouchCoopLocalization.CatalogFor("eng");
        Assert(english["couchcoop_connection_error_seat_cloud_isolation_summary"] == issue.Summary,
            "the English summary matches its catalog entry");
        Assert(english["couchcoop_connection_error_seat_cloud_isolation_action"] == issue.Action,
            "the English action matches its catalog entry");

        // The two details the same code is raised with, told apart where a support answer needs them apart.
        Assert(HeadlessClientManager.UndeclaredCloudIsolationDetail.Contains("without stating", StringComparison.Ordinal),
            "a seat that never declared is described as silent on the point, not as having refused");
        var silent = HeadlessClientManager.NoSeatContactDetail(TimeSpan.FromSeconds(20));
        Assert(silent.Contains("20 seconds", StringComparison.Ordinal)
            && silent.Contains("cannot confirm CouchCoop is running", StringComparison.Ordinal)
            && !silent.Contains("CouchCoop is not running", StringComparison.Ordinal),
            "a seat that never spoke is described as one the host cannot vouch for, not as proven unmodded — a "
            + "healthy seat on a slow machine is outside the lobby at this deadline too");
        Assert(silent.Contains("may already have run its own startup cloud sync", StringComparison.Ordinal)
            && silent.Contains("couch-coop/save-backups/", StringComparison.Ordinal),
            "…and says plainly that stopping it may have been too late, and where the host's backup is");

        // The ACTION is shared by every shape above, including a seat that never spoke — which may already have
        // synced before it was stopped. So it must not promise that nothing was written.
        Assert(!issue.Action.Contains("before it could write", StringComparison.Ordinal),
            "the shared action promises nothing about what the seat did before it was stopped");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[SeatCloudIsolationGuardTests] FAILED: {label}");
        }
    }
}
