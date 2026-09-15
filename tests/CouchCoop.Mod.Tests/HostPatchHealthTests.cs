using CouchCoop.Mod.Connections;
using CouchCoop.Mod.Patches;

namespace CouchCoop.Mod.Tests;

/// <summary>
/// The host-side diagnostics a player can actually reach: whether this process could install its Harmony
/// hooks, and how that reaches the connections panel and the copyable report.
/// </summary>
/// <remarks>
/// Pure — a registry with a fake clock and a recorder — so it runs in the reachable verbs rather than only in
/// the full sequence, which dies partway through on some machines.
/// </remarks>
internal static class HostPatchHealthTests
{
    public static void Run()
    {
        HostIssueSeverityIsCarriedByTheRow();
        HostIssuesDeduplicateByCode();
        OneRowStandsForTheWholePatchSet();
        PatchHealthIsAlwaysInTheReport();
        TheProbeClassifiesEveryOutcomeAndNeverThrows();
    }

    private static void HostIssueSeverityIsCarriedByTheRow()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var fatalId = registry.ReportHostIssue("host-service-failed", "Service down", "Restart", "detail");
        var fatal = registry.Snapshot().Rows.Single(row => row.Id == fatalId);
        Assert(fatal.DeviceLabel == "Host service", "a host issue is a synthetic Host service row");
        Assert(fatal.Stage == ConnectionStage.Failed && fatal.Issue!.Outcome == ConnectionIssueOutcome.Failed
            && !fatal.Issue.IsWarning,
            "the existing call sites still produce an unchanged hard failure");

        var warningId = registry.ReportHostIssue("host-seat-profile-shared", "Shared profile", "Carry on", "detail", isWarning: true);
        var warning = registry.Snapshot().Rows.Single(row => row.Id == warningId);
        Assert(warning.Issue!.IsWarning && warning.Issue.Outcome == ConnectionIssueOutcome.Degraded,
            "a degraded host condition is recorded as a warning, not a failure");
        Assert(warning.Stage != ConnectionStage.Failed,
            "a warning must not move the entry to Failed — the session is still running");
        Assert(registry.BuildReport(warningId)!.Contains("outcome: degraded", StringComparison.Ordinal),
            "the copyable report says plainly that this one is a limitation");
    }

    private static void HostIssuesDeduplicateByCode()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var first = registry.ReportHostIssue("host-patch-failed", "Cannot attach", "Restart", "first cause");
        var again = registry.ReportHostIssue("host-patch-failed", "Cannot attach", "Restart", "second cause");
        Assert(first == again, "the same code returns the first report rather than opening a second");
        Assert(registry.Snapshot().Rows.Count(row => row.DeviceLabel == "Host service") == 1, "…and adds no row");
        Assert(registry.BuildReport(first)!.Contains("first cause", StringComparison.Ordinal),
            "the first cause is the one retained");

        // Padding is not a different problem: the row carries the cleaned code, so the match uses it too.
        Assert(registry.ReportHostIssue("  host-patch-failed  ", "Cannot attach", "Restart") == first,
            "a padded code is the same issue");
        Assert(registry.ReportHostIssue("host-seat-profile-shared", "Shared", "Carry on", null, isWarning: true) != first,
            "a different code is a different row");
        Assert(registry.Snapshot().Rows.Count(row => row.DeviceLabel == "Host service") == 2, "two distinct host issues, two rows");
    }

    private static void OneRowStandsForTheWholePatchSet()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var previous = CouchCoopPatchHealth.Registry;
        CouchCoopPatchHealth.Registry = registry;
        CouchCoopPatchHealth.Reset();
        try
        {
            Assert(CouchCoopPatchHealth.Describe() == "probe=not-run; failedPatches=none", "a fresh process claims nothing");

            CouchCoopPatchHealth.PatchFailed("AlphaPatch", costsCoop: false, "alpha could not install");
            Assert(!registry.Snapshot().Rows.Any(), "a patch the player cannot act on raises no row");
            Assert(CouchCoopPatchHealth.Describe().Contains("AlphaPatch", StringComparison.Ordinal),
                "…but it is still named in the report fact");

            CouchCoopPatchHealth.PatchFailed("BetaPatch", costsCoop: true, "beta could not install");
            CouchCoopPatchHealth.PatchFailed("GammaPatch", costsCoop: true, "gamma could not install");
            CouchCoopPatchHealth.PatchFailed("BetaPatch", costsCoop: true, "beta could not install");
            var rows = registry.Snapshot().Rows;
            Assert(rows.Count(row => row.Issue?.Code == CouchCoopPatchHealth.IssueCode) == 1,
                "a host whose patching is broken loses every patch at once and gets ONE row");
            Assert(rows.Single().Issue!.Detail!.Contains("beta could not install", StringComparison.Ordinal),
                "the first failure that costs co-op is the one the row explains");
            var described = CouchCoopPatchHealth.Describe();
            Assert(described.Contains("AlphaPatch", StringComparison.Ordinal)
                && described.Contains("BetaPatch", StringComparison.Ordinal)
                && described.Contains("GammaPatch", StringComparison.Ordinal),
                "the fact lists every failed patch, including the ones recorded after the row was raised");
            Assert(described.Split("BetaPatch").Length == 2, "a repeated failure is recorded once");

            CouchCoopPatchHealth.RecordProbe("ok");
            Assert(CouchCoopPatchHealth.Describe().StartsWith("probe=ok;", StringComparison.Ordinal), "the probe verdict leads");

            CouchCoopPatchHealth.Reset();
            CouchCoopPatchHealth.ProbeFailed("DllNotFoundException: blocked", "the probe patch was refused");
            Assert(registry.Snapshot().Rows.Count(row => row.Issue?.Code == CouchCoopPatchHealth.IssueCode) == 1,
                "a refused probe reports under the same deduplicated code");
            Assert(CouchCoopPatchHealth.Describe().Contains("failed(DllNotFoundException: blocked)", StringComparison.Ordinal),
                "the fact carries why the probe was refused");
        }
        finally
        {
            CouchCoopPatchHealth.Registry = previous;
            CouchCoopPatchHealth.Reset();
        }
    }

    private static void PatchHealthIsAlwaysInTheReport()
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var id = Guid.NewGuid();
        registry.Connected(id, "phone");
        registry.BeginAttempt(id);
        registry.Fail(id, "native-disconnected", "Lost", "Retry", "detail");
        var report = registry.BuildReport(id)!;
        Assert(report.Contains("patchHealth: probe=", StringComparison.Ordinal),
            "every report says whether this host's hooks installed — a host with none looks like a network fault otherwise");
    }

    private static void TheProbeClassifiesEveryOutcomeAndNeverThrows()
    {
        Assert(CouchCoopHarmonyProbe.Run(() => true).Succeeded, "a detour that took effect is a pass");

        var inert = CouchCoopHarmonyProbe.Run(() => false);
        Assert(!inert.Succeeded && inert.Error!.Contains("did not take effect", StringComparison.Ordinal),
            "a patch that applies without detouring is a failure, not a pass");

        // The shape of the real thing: MonoMod's helper load is refused and the throw comes back out of Patch().
        var refused = CouchCoopHarmonyProbe.Run(() => throw new DllNotFoundException("code signature invalid"));
        Assert(!refused.Succeeded && refused.Error == "DllNotFoundException: code signature invalid",
            "a refused native load is reported by type and message, which is what the player copies");

        // And the production path itself, which must answer rather than throw whatever this machine decides.
        // MEASURED in this suite's own process: MonoMod answers "PlatformNotSupportedException: CoreCLR
        // version … is not supported" here, because a bare `dotnet run` host is not the game's runtime. That is
        // the point — the probe REPORTS a refusal instead of dying on it, which is the whole contract.
        var live = CouchCoopHarmonyProbe.Run();
        Assert(live.Succeeded == (live.Error is null), "the live probe returns a definite outcome with its cause");
    }

    private static void Assert(bool value, string message)
    {
        if (!value) throw new Exception($"[HostPatchHealthTests] FAILED: {message}");
    }

    /// <summary>A stopped clock: nothing here measures elapsed time, and a frozen one keeps rows comparable.</summary>
    private sealed class FakeTime : TimeProvider
    {
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => 0;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch;
    }
}
