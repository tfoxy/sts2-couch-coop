using CouchCoop.Mod.Connections;

// WS4 macOS: the "bound but unreachable" observation. A host whose inbound connections are refused by the
// macOS Local Network permission or by the application firewall binds, listens, and produces NOTHING — the
// connection never reaches accept(), so there is no failure to report and no row to raise. This suite pins the
// three things that decision has to get right:
//
//  1. It NEVER fires behind a working session. A connection at any point — before arming, during the wait, or
//     after the row is already standing — means the warning is not raised or is withdrawn.
//  2. It never accuses. "Nobody has scanned yet" and "nothing can reach this port" are the same observation
//     from inside the host, and the copy asserted below says so in as many words.
//  3. It is one row, warning-level, under a code the panel maps. An unmapped code renders the WRONG sentence
//     (see ConnectionUiTests.HostIssueCodesHaveTheirOwnLocalizedCopy).
//
// Pure: a fake clock and a controlled delay stand in for the 90-second wait, so nothing here sleeps and no
// socket is opened. Assert-or-throw, matching the repo's custom Exe runner.
internal static class HostReachabilityWatchTests
{
    public static void Run()
    {
        ThresholdReaderHandlesUnsetOffGarbageAndTheClampBand();
        FiresOnceWhenNothingConnects();
        AConnectionDuringTheWaitCancelsTheWarning();
        AConnectionAfterTheWarningWithdrawsTheRow();
        AConnectionBeforeArmingMeansTheWatchNeverArms();
        ArmingIsIdempotent();
        DisarmWithdrawsAStandingRow();
        ADisabledThresholdNeverArms();
        TheCopyNamesBothMacOsGatesAndNeverAccuses();
        OnlyADecisiveFirewallReadingChangesTheRow();
        Console.WriteLine("HostReachabilityWatchTests: ok");
    }

    private static void ThresholdReaderHandlesUnsetOffGarbageAndTheClampBand()
    {
        Expect(HostReachabilityWatch.ResolveWarnSeconds(null) == HostReachabilityWatch.DefaultWarnSeconds,
            "unset is the default threshold");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("   ") == HostReachabilityWatch.DefaultWarnSeconds,
            "blank is the default threshold");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("0") == 0, "0 disables the watch");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("-5") == 0, "a negative value disables the watch");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("OFF") == 0, "off disables, case-insensitively");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("false") == 0, "false disables");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("no") == 0, "no disables");

        // Garbage is the default rather than 0: a typo in an env var must not silently DELETE a diagnostic,
        // which is the failure mode this whole workstream exists to fix.
        Expect(HostReachabilityWatch.ResolveWarnSeconds("ninety") == HostReachabilityWatch.DefaultWarnSeconds,
            "garbage falls back to the default instead of disabling the watch");

        Expect(HostReachabilityWatch.ResolveWarnSeconds("120") == 120, "an in-band value is taken verbatim");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("1") == HostReachabilityWatch.MinimumWarnSeconds,
            "a value under the floor is clamped up, so it cannot fire during a normal join");
        Expect(HostReachabilityWatch.ResolveWarnSeconds("999999") == HostReachabilityWatch.MaximumWarnSeconds,
            "a value over the ceiling is clamped down");

        Expect(HostReachabilityWatch.DefaultWarnSeconds == 90,
            "the shipped threshold is 90s after a host lobby appears — see the remarks on DefaultWarnSeconds");
    }

    private static void FiresOnceWhenNothingConnects()
    {
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 90);
        Expect(watch.IsArmed, "arming starts the clock");
        Expect(registry.Snapshot().Rows.Count == 0, "and raises nothing until the threshold is reached");

        Release(delay, watch);

        var rows = registry.Snapshot().Rows;
        Expect(rows.Count == 1, $"one row is raised (got {rows.Count})");
        var row = rows[0];
        Expect(row.DeviceLabel == "Host service", "it is a host-service row, with no connection attempt behind it");
        Expect(row.Issue?.Code == HostReachabilityWatch.IssueCode, "under the reachability code");
        Expect(row.Issue?.IsWarning == true, "as a WARNING — the session is still running, nothing has failed");
        Expect(row.Issue?.Outcome == ConnectionIssueOutcome.Degraded,
            "recorded as Degraded, which the panel paints orange rather than failure red");
        Expect(row.Stage != ConnectionStage.Failed, "and the entry is never moved to Failed");
        Expect(row.Issue?.Detail?.Contains("192.168.0.9:13337", StringComparison.Ordinal) == true,
            "the detail names the endpoint the host was handing out");
        Expect(watch.RaisedIssueId == row.Id, "the watch remembers the row so it can withdraw it later");
    }

    private static void AConnectionDuringTheWaitCancelsTheWarning()
    {
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 90);
        Expect(delay.WaitForPending(1), "the wait is scheduled");

        watch.NoteInboundConnection();
        Expect(!watch.IsArmed, "an accepted connection disarms the watch");
        Expect(watch.SawInboundConnection, "…and latches the fact for the rest of the process");

        // The delay's cancellation is what normally ends the wait; release it anyway to prove that even a
        // delay which completes ANYWAY cannot raise a row behind a connection that already landed.
        delay.ReleaseAll();
        watch.PendingWatch?.GetAwaiter().GetResult();
        Expect(registry.Snapshot().Rows.Count == 0, "a connection during the wait leaves no warning at all");
    }

    private static void AConnectionAfterTheWarningWithdrawsTheRow()
    {
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 90);
        Release(delay, watch);
        Expect(registry.Snapshot().Rows.Count == 1, "the warning is standing");

        watch.NoteInboundConnection();
        Expect(registry.Snapshot().Rows.Count == 0,
            "the first connection to arrive withdraws it — the sentence is no longer true about this session");
        Expect(watch.RaisedIssueId is null, "and the watch forgets the row it withdrew");
    }

    private static void AConnectionBeforeArmingMeansTheWatchNeverArms()
    {
        // The listener is up from mod init, long before any lobby. Something that reached it at the main menu
        // is still proof that inbound packets arrive here, so the question is already answered.
        var (registry, delay, watch) = Harness();
        watch.NoteInboundConnection();
        watch.Arm("http://192.168.0.9:13337/", 90);
        Expect(!watch.IsArmed, "a watch is not armed once anything has already connected");
        Expect(watch.PendingWatch is null, "no wait is scheduled");
        Expect(!delay.WaitForPending(1, TimeSpan.FromMilliseconds(100)), "…so nothing is waiting on the clock");
        Expect(registry.Snapshot().Rows.Count == 0, "and no row is ever raised");
    }

    private static void ArmingIsIdempotent()
    {
        // The panel controller's tick raises its host-lobby event every 0.25s for as long as the lobby is on
        // screen, so re-arming has to be free AND must not stack four waits per second.
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 90);
        var first = watch.PendingWatch;
        for (var index = 0; index < 20; index++)
        {
            watch.Arm("http://192.168.0.9:13337/", 90);
        }

        Expect(ReferenceEquals(watch.PendingWatch, first), "re-arming keeps the original wait rather than adding one");
        Release(delay, watch);
        Expect(registry.Snapshot().Rows.Count == 1, "and twenty-one armings still yield exactly one row");
    }

    private static void DisarmWithdrawsAStandingRow()
    {
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 90);
        Release(delay, watch);
        Expect(registry.Snapshot().Rows.Count == 1, "the warning is standing");

        watch.Disarm();
        Expect(registry.Snapshot().Rows.Count == 0,
            "tearing the host services down withdraws a warning about a listener that no longer exists");
        Expect(!watch.IsArmed && watch.RaisedIssueId is null, "and leaves nothing armed behind it");

        // Disarming an idle watch is a no-op rather than an error — it is called on every teardown path.
        watch.Disarm();
        Expect(registry.Snapshot().Rows.Count == 0, "disarming twice is harmless");
    }

    private static void ADisabledThresholdNeverArms()
    {
        var (registry, delay, watch) = Harness();
        watch.Arm("http://192.168.0.9:13337/", 0);
        Expect(!watch.IsArmed && watch.PendingWatch is null, "a zero threshold never arms");
        Expect(!delay.WaitForPending(1, TimeSpan.FromMilliseconds(100)), "…and schedules no wait");
        Expect(registry.Snapshot().Rows.Count == 0, "…and raises nothing");
    }

    private static void TheCopyNamesBothMacOsGatesAndNeverAccuses()
    {
        var mac = HostReachabilityWatch.Describe(90, "http://192.168.0.9:13337/", isMacOS: true, isWindows: false);
        Expect(mac.Contains("Privacy & Security > Local Network", StringComparison.Ordinal),
            "the macOS detail names the Local Network privacy permission by its settings path");
        Expect(mac.Contains("Network > Firewall", StringComparison.Ordinal),
            "…and the application firewall by its settings path");
        Expect(mac.Contains("Steam", StringComparison.Ordinal),
            "…and Steam, because the prompt is commonly attributed to the launcher rather than the game");

        // THE product rule for this row. The host cannot tell the two cases apart, so the copy must not pick
        // one: a diagnostic that tells a solo player their firewall is broken is worse than no diagnostic.
        foreach (var text in new[]
                 {
                     mac,
                     HostReachabilityWatch.Describe(90, null, isMacOS: false, isWindows: true),
                     HostReachabilityWatch.Describe(90, null, isMacOS: false, isWindows: false),
                     HostReachabilityWatch.IssueSummary,
                     HostReachabilityWatch.IssueAction,
                 })
        {
            Expect(!string.IsNullOrWhiteSpace(text), "every copy string is a real sentence");
            foreach (var accusation in new[] { "is blocking", "is blocked", "are blocked", "denied", "refused" })
            {
                Expect(!text.Contains(accusation, StringComparison.OrdinalIgnoreCase),
                    $"the copy never asserts a block it cannot observe (found '{accusation}')");
            }
        }

        Expect(mac.Contains("nobody has scanned", StringComparison.OrdinalIgnoreCase)
            && mac.Contains("accept()", StringComparison.Ordinal),
            "the detail says outright that the two cases are indistinguishable from here, and why");
        Expect(HostReachabilityWatch.IssueAction.StartsWith("If nobody has tried yet", StringComparison.Ordinal),
            "the player-facing action leads with the innocent explanation, not the alarming one");

        var windows = HostReachabilityWatch.Describe(90, null, isMacOS: false, isWindows: true);
        Expect(windows.Contains("Windows", StringComparison.Ordinal) && !windows.Contains("System Settings", StringComparison.Ordinal),
            "a Windows host is not told to open macOS System Settings");
        var other = HostReachabilityWatch.Describe(45, null, isMacOS: false, isWindows: false);
        Expect(other.Contains("45s", StringComparison.Ordinal), "the detail carries the threshold it actually used");
        Expect(other.Contains("firewall", StringComparison.OrdinalIgnoreCase),
            "and stays useful on a platform with neither branch");

        // The one row that is ALLOWED to accuse, because by then it has asked and been told. Its copy lives on
        // the separate code checked below, never on the ambiguous one's — the loop above still forbids it there.
        Expect(HostReachabilityWatch.FirewallIssueSummary.Contains("is blocking", StringComparison.Ordinal),
            "the firewall row says plainly that this computer is blocking, which is the whole reason it exists");
        var asked = HostReachabilityWatch.Describe(90, null, isMacOS: false, isWindows: true,
            "Windows Firewall: no enabled inbound allow rule for this game exists on this computer.");
        Expect(asked.Contains("no enabled inbound allow rule", StringComparison.Ordinal),
            "a reading is appended to the detail rather than replacing the observation it came with");
        Expect(asked.Contains("accept()", StringComparison.Ordinal),
            "…which keeps the honest account of what this host can and cannot see");
    }

    private static void OnlyADecisiveFirewallReadingChangesTheRow()
    {
        // On Windows the row can do better than "this host cannot tell": WindowsFirewallProbe asks the OS
        // whether a rule for this game exists and covers the active network. Three answers earn the accusing
        // row; everything else — including every way of failing to get an answer — keeps the honest one.
        foreach (var verdict in new[]
                 {
                     WindowsFirewallVerdict.BlockRule,
                     WindowsFirewallVerdict.NoAllowRule,
                     WindowsFirewallVerdict.ProfileMismatch,
                 })
        {
            var (registry, delay, watch) = Harness(new WindowsFirewallReading(verdict, $"Windows Firewall: {verdict} sentence."));
            watch.Arm("http://192.168.0.9:13337/", 90);
            Release(delay, watch);

            var row = registry.Snapshot().Rows.Single();
            Expect(row.Issue?.Code == HostReachabilityWatch.FirewallIssueCode,
                $"{verdict} raises the firewall row, not the ambiguous one");
            Expect(row.Issue?.IsWarning == true, "…still as a warning: co-op has not failed, it has not started");
            Expect(row.Issue?.Detail?.Contains($"Windows Firewall: {verdict} sentence.", StringComparison.Ordinal) == true,
                "…and the probe's own sentence is carried into the copyable report");
        }

        foreach (var reading in new WindowsFirewallReading?[]
                 {
                     null,
                     new WindowsFirewallReading(WindowsFirewallVerdict.Unknown, "Windows Firewall: could not be queried."),
                     new WindowsFirewallReading(WindowsFirewallVerdict.Allowed, "Windows Firewall: this game IS allowed inbound."),
                 })
        {
            var (registry, delay, watch) = Harness(reading);
            watch.Arm("http://192.168.0.9:13337/", 90);
            Release(delay, watch);

            var row = registry.Snapshot().Rows.Single();
            Expect(row.Issue?.Code == HostReachabilityWatch.IssueCode,
                $"a {reading?.Verdict.ToString() ?? "missing"} reading keeps the row that accuses nobody");
            if (reading is not null)
            {
                Expect(row.Issue?.Detail?.Contains(reading.Detail, StringComparison.Ordinal) == true,
                    "…and still carries what the firewall said, because exonerating it is worth as much");
            }
        }

        // The two codes are separate strings, and BOTH have to be mapped in CouchCoopConnectionPanel.IssueKey —
        // an unmapped code renders the generic join sentence rather than a missing one.
        Expect(HostReachabilityWatch.FirewallIssueCode != HostReachabilityWatch.IssueCode,
            "the firewall row is its own code");
        Expect(!string.IsNullOrWhiteSpace(HostReachabilityWatch.FirewallIssueSummary)
            && !string.IsNullOrWhiteSpace(HostReachabilityWatch.FirewallIssueAction),
            "and carries its own English fallback copy for the report");
    }

    // ---- harness --------------------------------------------------------------------------------------------

    private static (ConnectionRegistry Registry, ControlledDelay Delay, HostReachabilityWatch Watch) Harness(
        WindowsFirewallReading? firewall = null)
    {
        var registry = new ConnectionRegistry(new FakeTime());
        var delay = new ControlledDelay();
        // The firewall reading is stubbed even in the default case: a unit suite must never spawn the real
        // query, which on a Windows developer box would make these legs depend on that machine's rules.
        return (registry, delay, new HostReachabilityWatch(registry, delay.Delay, null, _ => Task.FromResult(firewall)));
    }

    private static void Release(ControlledDelay delay, HostReachabilityWatch watch)
    {
        Expect(delay.WaitForPending(1), "the wait is scheduled");
        delay.ReleaseNext();
        watch.PendingWatch!.GetAwaiter().GetResult();
    }

    private sealed class FakeTime : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => _timestamp;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddMilliseconds(_timestamp);
    }

    private sealed class ControlledDelay
    {
        private readonly object _gate = new();
        private readonly Queue<TaskCompletionSource> _pending = [];
        private int _scheduled;

        public Task Delay(TimeSpan _, CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_gate)
            {
                _pending.Enqueue(completion);
                _scheduled++;
            }

            cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
            return completion.Task;
        }

        public bool WaitForPending(int count, TimeSpan? timeout = null)
            => SpinWait.SpinUntil(() => Volatile.Read(ref _scheduled) >= count, timeout ?? TimeSpan.FromSeconds(1));

        public void ReleaseNext()
        {
            TaskCompletionSource completion;
            lock (_gate)
            {
                completion = _pending.Dequeue();
            }

            completion.TrySetResult();
        }

        public void ReleaseAll()
        {
            lock (_gate)
            {
                while (_pending.TryDequeue(out var completion))
                {
                    completion.TrySetResult();
                }
            }
        }
    }

    private static void Expect(bool condition, string because)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"HostReachabilityWatchTests failed: {because}");
        }
    }
}
