using System.Collections.Concurrent;
using System.Diagnostics;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

// A headless mirror instance whose host connection is permanently gone must EXIT instead of parking behind
// STS2's network-error / "report a bug" modal forever. Two halves are covered here:
//   * the Harmony TARGETS still resolve against the installed STS2 assemblies — including the `NErrorPopup.Create`
//     OVERLOAD discrimination, which is the one thing a name-based lookup would silently get wrong (three static
//     Create siblings exist and patching the wrong one would suppress unrelated dialogs while leaving the network
//     popup up). Pure metadata reflection, same resolution the patch uses; no live game.
//   * the exit SEQUENCE's ordering/idempotence contract, with every effect injected so no process is harmed.
internal static class HeadlessDisconnectExitTests
{
    public static async Task RunAsync()
    {
        PatchTargetsResolve();
        NetworkErrorPopupOverloadIsResolvedByParameterType();
        await ArmsTheForceExitBackstopBeforeNotifyAndQuit();
        await DisarmStartsBeforeTheNotifyFinishes();
        await QuitWaitsForTheDisarm();
        await ADisarmThatNeverFinishesIsGuarded();
        await TheDisarmGuardStartsAtTheSequenceStart();
        await ADisarmThatThrowsStillQuits();
        TheBackstopCoversTheWholeBoundedExit();
        await ForceExitDoesNotWaitOnABlockedLog();
        await SecondTriggerIsIgnored();
        await NotifyFailureStillQuits();
        await NotifyThatNeverCompletesIsTimeBoxed();
        await QuitFailureLeavesTheBackstopToFinishTheJob();
        await ScheduledBackstopForceExits();
        ARunInProgressRefusalIsClassified();
        TheJoinHandshakeRefusalsAreClassified();
        await ASpecificReasonRefinesTheGenericOneThatStartedTheShutdown();
        await QuitReceivesTheReasonRefinedBeforeItRuns();
        await QuitWaitsForTheRefinedReasonReport();
        await ARefinedReasonReportThatNeverCompletesIsTimeBoxed();
        await AnEarlyRefinedReportDoesNotAddASecondNotifyWait();
        await AReportStartedAfterNotifyGetsItsOwnBound();
        await AFailedRefinedReasonReportStillQuits();
        await AGenericSecondReasonNeverDisplacesASpecificOne();
        await RefinementHappensAtMostOnceAndNeverThrows();
        Console.WriteLine("HeadlessDisconnectExitTests: 26 passed.");
    }

    // The seat learns its refusal as a rendered NetErrorInfo — free text — and the host panel resolves its copy
    // from an issue CODE. Classification is the join between the two; without it the one refusal a player can act
    // on arrives as a string nothing has a sentence for.
    private static void ARunInProgressRefusalIsClassified()
    {
        Assert(HeadlessDisconnectReason.Classify("DisconnectionReason RunInProgress False")
                == HeadlessDisconnectReason.RunInProgressCode,
            "a rendered RunInProgress refusal classifies to the run-in-progress issue code");
        Assert(HeadlessDisconnectReason.Classify("DisconnectionReason UnknownNetworkError False")
                == "DisconnectionReason UnknownNetworkError False",
            "a reason we have no sentence for is passed through unchanged rather than flattened");
        Assert(HeadlessDisconnectReason.Classify("  ") == "connection-ended", "an empty reason still names something");
        Assert(HeadlessDisconnectReason.IsSpecific(HeadlessDisconnectReason.RunInProgressCode)
                && !HeadlessDisconnectReason.IsSpecific(HeadlessDisconnectReason.NativeNetworkErrorCode),
            "'the socket is gone' is generic; 'the run had already begun' is not");
    }

    // The two refusals the game's join handshake can answer with. A seat runs the host's own executable, so either
    // one means the two processes ended up with different content or mods loaded — not a version to update — and
    // the generic join copy ("the player game lost its connection") said nothing about it.
    private static void TheJoinHandshakeRefusalsAreClassified()
    {
        Assert(HeadlessDisconnectReason.Classify("ConnectionFailureReason VersionMismatch False")
                == HeadlessDisconnectReason.GameContentMismatchCode,
            "a rendered VersionMismatch refusal classifies to the game-content mismatch code");
        Assert(HeadlessDisconnectReason.Classify("ConnectionFailureReason ModMismatch False")
                == HeadlessDisconnectReason.ModMismatchCode,
            "a rendered ModMismatch refusal classifies to the mod mismatch code");
        Assert(HeadlessDisconnectReason.TryClassify("ConnectionFailureReason UnknownNetworkError False") is null
                && HeadlessDisconnectReason.TryClassify(null) is null,
            "TryClassify names nothing it has no sentence for");
        foreach (var code in new[]
                 {
                     HeadlessDisconnectReason.RunInProgressCode,
                     HeadlessDisconnectReason.GameContentMismatchCode,
                     HeadlessDisconnectReason.ModMismatchCode,
                 })
        {
            Assert(HeadlessDisconnectReason.IsSpecific(code) && HeadlessDisconnectReason.IsJoinRefusal(code),
                $"{code} is a specific join refusal");
        }
        Assert(!HeadlessDisconnectReason.IsJoinRefusal(HeadlessDisconnectReason.NativeNetworkErrorCode)
                && !HeadlessDisconnectReason.IsJoinRefusal(null),
            "the generic drop is not a refusal");
    }

    // THE RACE THAT LOST THE DIAGNOSIS. The transport publishes a generic drop first and starts the shutdown; the
    // game's own handler follows with the reason the host actually gave. The second one used to be logged as
    // "already running — ignoring" and thrown away, leaving the host to show the generic join copy ("check that
    // game and mod versions match") for a run the seat simply was not in.
    private static async Task ASpecificReasonRefinesTheGenericOneThatStartedTheShutdown()
    {
        var refined = new List<string>();
        var disarms = 0;
        var notifies = 0;
        var quits = 0;
        var arms = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => { notifies++; return Task.CompletedTask; },
            quit: _ => quits++,
            disarm: () => { disarms++; return Task.CompletedTask; },
            forceExit: () => { },
            schedule: (_, _) => arms++,
            log: _ => { },
            refineReason: reason => { refined.Add(reason); return Task.CompletedTask; });

        Assert(await sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode), "the generic drop starts the shutdown");
        Assert(!await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode),
            "the specific reason does not restart the shutdown");
        Assert(sequence.Reason == HeadlessDisconnectReason.RunInProgressCode,
            "…but it becomes the recorded reason");
        Assert(refined.Count == 1 && refined[0] == HeadlessDisconnectReason.RunInProgressCode,
            "…and is handed to the hook that reports it upstream");
        Assert(disarms == 1 && notifies == 1 && quits == 1 && arms == 1,
            $"refinement changes nothing about the shutdown itself (notify={notifies} quit={quits} arm={arms})");
    }

    private static async Task QuitReceivesTheReasonRefinedBeforeItRuns()
    {
        var disarm = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var trace = new List<string>();
        string? quitReason = null;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (reason, _) => { trace.Add($"notify:{reason}"); return Task.CompletedTask; },
            disarm: () => { trace.Add("disarm"); return disarm.Task; },
            quit: reason => { quitReason = reason; trace.Add("quit"); },
            schedule: (delay, _) => trace.Add($"arm:{delay.TotalSeconds}"),
            log: _ => { });

        var run = sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(!run.IsCompleted && quitReason is null, "the quit step waits for disarm");
        Assert(!await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode),
            "refinement does not restart the pending sequence");
        disarm.SetResult();
        Assert(await run, "the first sequence completes");

        Assert(quitReason == HeadlessDisconnectReason.RunInProgressCode,
            "quit receives the specific reason that arrived before its step");
        Assert(string.Join(",", trace) == $"arm:{HeadlessDisconnectExitSequence.ForceExitDelay.TotalSeconds},disarm,notify:{HeadlessDisconnectReason.NativeNetworkErrorCode},quit",
            "refinement preserves the backstop, disarm, notify, quit ordering");
    }

    private static async Task QuitWaitsForTheRefinedReasonReport()
    {
        var report = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var trace = new List<string>();
        HeadlessDisconnectExitSequence? sequence = null;
        sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (reason, _) =>
            {
                trace.Add($"notify:{reason}");
                Assert(!sequence!.StartAsync(HeadlessDisconnectReason.RunInProgressCode).GetAwaiter().GetResult(),
                    "a refinement during notify does not restart the shutdown");
                return Task.CompletedTask;
            },
            disarm: () => { trace.Add("disarm"); return Task.CompletedTask; },
            quit: _ => trace.Add("quit"),
            schedule: (delay, _) => trace.Add($"arm:{delay.TotalSeconds}"),
            log: _ => { },
            refineReason: _ => report.Task);

        var run = sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(!trace.Contains("quit") && !run.IsCompleted,
            "quit must wait for the pending refined-reason report");
        report.SetResult();
        Assert(await run.WaitAsync(TimeSpan.FromSeconds(2)), "report completion allows the shutdown to finish");
        Assert(string.Join(",", trace) == $"arm:{HeadlessDisconnectExitSequence.ForceExitDelay.TotalSeconds},disarm,notify:{HeadlessDisconnectReason.NativeNetworkErrorCode},quit",
            "waiting for the report preserves the existing exit ordering");
    }

    private static async Task ARefinedReasonReportThatNeverCompletesIsTimeBoxed()
    {
        var report = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var logs = new List<string>();
        var quit = false;
        var clock = new HeadlessClientManagerTests.ReconnectClock();
        HeadlessDisconnectExitSequence? sequence = null;
        sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) =>
            {
                sequence!.StartAsync(HeadlessDisconnectReason.RunInProgressCode).GetAwaiter().GetResult();
                return Task.CompletedTask;
            },
            quit: _ => quit = true,
            schedule: (_, _) => { },
            log: logs.Add,
            timeProvider: clock,
            refineReason: _ => report.Task);

        var run = sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(!quit && !run.IsCompleted, "a pending report holds the exit until its bound");
        Assert(clock.Timers.Count == 2 && clock.ActiveCount == 1
            && clock.Timers[^1].Due == HeadlessDisconnectExitSequence.NotifyTimeout,
            "only the report's existing notify bound remains after notify completes");
        clock.Advance(HeadlessDisconnectExitSequence.NotifyTimeout);
        Assert(await run.WaitAsync(TimeSpan.FromSeconds(2)),
            "a never-completing report cannot hold the exit open");
        Assert(quit && !report.Task.IsCompleted, "quit runs while the timed-out report is still pending");
        Assert(logs.Any(line => line.Contains("could not report the refined reason: TimeoutException")),
            "a report timeout is logged");
    }

    private static async Task AnEarlyRefinedReportDoesNotAddASecondNotifyWait()
    {
        var clock = new HeadlessClientManagerTests.ReconnectClock();
        var logs = new ConcurrentQueue<string>();
        var report = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var quit = false;
        HeadlessDisconnectExitSequence? sequence = null;
        sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) =>
            {
                sequence!.StartAsync(HeadlessDisconnectReason.RunInProgressCode).GetAwaiter().GetResult();
                return new TaskCompletionSource().Task;
            },
            quit: _ => quit = true,
            schedule: (_, _) => { },
            log: logs.Enqueue,
            timeProvider: clock,
            refineReason: _ => report.Task);

        var run = sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(clock.Timers.Count == 3 && clock.Timers.All(timer => timer.Due == HeadlessDisconnectExitSequence.NotifyTimeout),
            "notify cancellation, notify wait and refined report all start their bounds at the trigger");
        clock.Advance(HeadlessDisconnectExitSequence.NotifyTimeout);
        Assert(await run.WaitAsync(TimeSpan.FromSeconds(2)), "the shared deadline allows quit");
        Assert(quit && !report.Task.IsCompleted, "quit does not wait for the frozen host again");
        Assert(clock.Timers.Count == 3, "the quit step requests no second report timeout");
        Assert(logs.Any(line => line.Contains("could not report the refined reason: TimeoutException")),
            "the overlapping report timeout is still logged");
    }

    private static async Task AReportStartedAfterNotifyGetsItsOwnBound()
    {
        foreach (var completes in new[] { false, true })
        {
            var clock = new HeadlessClientManagerTests.ReconnectClock();
            var disarm = new TaskCompletionSource();
            var report = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var quit = false;
            var sequence = new HeadlessDisconnectExitSequence(
                notifyViewers: (_, _) => Task.CompletedTask,
                disarm: () => disarm.Task,
                quit: _ => quit = true,
                schedule: (_, _) => { },
                log: _ => { },
                timeProvider: clock,
                refineReason: _ => report.Task);

            var run = sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
            clock.Advance(HeadlessDisconnectExitSequence.NotifyTimeout);
            Assert(!await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode),
                "a refinement after notify does not restart the exit");
            Assert(clock.Timers.Count == 3 && clock.Timers[^1].Due == HeadlessDisconnectExitSequence.NotifyTimeout * 2,
                "the late report gets a full notify bound from its own start");
            disarm.SetResult();
            Assert(!quit && !run.IsCompleted, "the pending late report holds quit after disarm");

            if (completes) report.SetResult();
            else clock.Advance(HeadlessDisconnectExitSequence.NotifyTimeout);
            Assert(await run.WaitAsync(TimeSpan.FromSeconds(2)), $"the late report releases quit (completes={completes})");
            Assert(quit && report.Task.IsCompleted == completes,
                "either report completion or its original deadline allows quit");
            Assert(clock.Timers.Count == 3, "quit never starts another report bound");
        }
    }

    private static async Task AFailedRefinedReasonReportStillQuits()
    {
        foreach (var synchronous in new[] { false, true })
        {
            var logs = new List<string>();
            var quit = false;
            HeadlessDisconnectExitSequence? sequence = null;
            sequence = new HeadlessDisconnectExitSequence(
                notifyViewers: (_, _) =>
                {
                    sequence!.StartAsync(HeadlessDisconnectReason.RunInProgressCode).GetAwaiter().GetResult();
                    return Task.CompletedTask;
                },
                quit: _ => quit = true,
                schedule: (_, _) => { },
                log: logs.Add,
                refineReason: _ => synchronous
                    ? throw new IOException("report failed")
                    : Task.FromException(new IOException("report failed")));

            Assert(await sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode).WaitAsync(TimeSpan.FromSeconds(2)),
                $"a report failure (synchronous={synchronous}) does not fault the shutdown");
            Assert(quit && logs.Any(line => line.Contains("could not report the refined reason: IOException: report failed")),
                $"a report failure (synchronous={synchronous}) logs and still quits");
        }
    }

    private static async Task AGenericSecondReasonNeverDisplacesASpecificOne()
    {
        var refined = new List<string>();
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: _ => { },
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { },
            refineReason: reason => { refined.Add(reason); return Task.CompletedTask; });

        await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode);
        await sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(sequence.Reason == HeadlessDisconnectReason.RunInProgressCode,
            "a later 'the socket is gone' never overwrites the reason the host actually gave");
        Assert(refined.Count == 0, "…and reports nothing upstream");
    }

    // Bounded work: the seat is seconds from exiting, so however many disconnect notifications the game produces,
    // the refinement fires at most once — and a hook that throws must not be able to interfere with the exit.
    private static async Task RefinementHappensAtMostOnceAndNeverThrows()
    {
        var refined = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: _ => { },
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { },
            refineReason: _ => { refined++; throw new IOException("the host is already gone"); });

        await sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode);
        Assert(!await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode), "the refining trigger still returns false");
        Assert(!await sequence.StartAsync("DisconnectionReason NotInSaveGame False"), "a third reason is refused");
        Assert(refined == 1, $"the refinement hook ran exactly once (ran {refined} times)");
        Assert(sequence.Reason == HeadlessDisconnectReason.RunInProgressCode,
            "a hook that threw does not lose the refined reason");
    }

    // Every patched method must still exist. A game update that renames either one leaves a headless wedged behind
    // the modal again — a silent, invisible-by-definition regression, so it fails the build here instead.
    private static void PatchTargetsResolve()
    {
        var missing = new List<string>();
        foreach (var (type, name, args) in HeadlessDisconnectExitPatch.Targets)
        {
            if (AccessTools.Method(type, name, args) is null)
            {
                missing.Add($"{type.FullName}.{name}({string.Join(", ", args.Select(a => a.Name))})");
            }
        }

        Assert(missing.Count == 0,
            $"every HeadlessDisconnectExitPatch target resolves against the installed STS2 assemblies (missing: {string.Join("; ", missing)})");

        Assert(HeadlessDisconnectExitPatch.Targets.Any(t => t.Type == typeof(NErrorPopup) && t.Name == "Create"),
            "the popup suppression target is NErrorPopup.Create");
        Assert(
            HeadlessDisconnectExitPatch.Targets.Any(t =>
                t.Type == typeof(NetClientGameService) && t.Name == "OnDisconnectedFromHost"),
            "the disconnect trigger target is NetClientGameService.OnDisconnectedFromHost");
    }

    // The overload trap, asserted explicitly: `Create` has three static siblings and only the NetErrorInfo one is
    // the network-error popup. Resolution must be by PARAMETER TYPE.
    private static void NetworkErrorPopupOverloadIsResolvedByParameterType()
    {
        var overloads = typeof(NErrorPopup)
            .GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
            .Where(m => m.Name == "Create")
            .ToList();
        Assert(overloads.Count >= 2,
            $"NErrorPopup.Create really is overloaded (found {overloads.Count}) — a name-only lookup would be ambiguous");

        var resolved = AccessTools.Method(typeof(NErrorPopup), "Create", [typeof(NetErrorInfo)]);
        Assert(resolved is not null, "the NetErrorInfo overload resolves");
        var parameters = resolved!.GetParameters();
        Assert(parameters.Length == 1 && parameters[0].ParameterType == typeof(NetErrorInfo),
            "the resolved Create overload takes exactly one NetErrorInfo — not a LocString/string sibling");

        // And the patch's own target tuple is that same overload (not merely "a Create").
        var target = HeadlessDisconnectExitPatch.Targets.First(t => t.Type == typeof(NErrorPopup));
        Assert(target.Args.Length == 1 && target.Args[0] == typeof(NetErrorInfo),
            "the patch targets Create(NetErrorInfo) by parameter type");
    }

    // THE ORDERING CONTRACT: the force-exit backstop is armed BEFORE the two steps that can hang (the last-gasp
    // send and the process exit). Any other order would let a wedged instance survive indefinitely — the whole
    // defect this workstream exists to kill.
    private static async Task ArmsTheForceExitBackstopBeforeNotifyAndQuit()
    {
        var trace = new List<string>();
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (reason, _) => { trace.Add($"notify:{reason}"); return Task.CompletedTask; },
            quit: _ => trace.Add("quit"),
            disarm: () => { trace.Add("disarm"); return Task.CompletedTask; },
            forceExit: () => trace.Add("force-exit"),
            schedule: (delay, _) => trace.Add($"arm:{delay.TotalSeconds}"),
            log: _ => { });

        var started = await sequence.StartAsync("DisconnectionReason UnknownNetworkError False");

        Assert(started, "the first trigger starts the sequence");
        Assert(sequence.Started, "the sequence reports itself started");
        Assert(string.Join(",", trace) == $"arm:{HeadlessDisconnectExitSequence.ForceExitDelay.TotalSeconds},disarm,notify:DisconnectionReason UnknownNetworkError False,quit",
            $"order is arm-backstop → disarm → notify viewers → process exit (got: {string.Join(",", trace)})");
        Assert(!trace.Contains("force-exit"), "the backstop is only armed, never fired inline");
    }

    private static async Task DisarmStartsBeforeTheNotifyFinishes()
    {
        var notify = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var trace = new List<string>();
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => { trace.Add("notify"); return notify.Task; },
            disarm: () => { trace.Add("disarm"); return Task.CompletedTask; },
            quit: _ => trace.Add("quit"),
            schedule: (_, _) => { }, log: _ => { });

        var run = sequence.StartAsync("host-gone");
        Assert(string.Join(",", trace) == "disarm,notify", "disarm starts while the notify is still pending");
        Assert(!run.IsCompleted, "quit waits for the pending notify");
        notify.SetResult();
        await run;
        Assert(trace[^1] == "quit", "quit follows the notify");
    }

    private static async Task QuitWaitsForTheDisarm()
    {
        var disarm = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            disarm: () => disarm.Task,
            quit: _ => quit = true,
            schedule: (_, _) => { }, log: _ => { });

        var run = sequence.StartAsync("host-gone");
        Assert(!quit && !run.IsCompleted, "a completed notify does not quit before disarm");
        disarm.SetResult();
        await run;
        Assert(quit, "disarm completion allows quit");
    }

    private static async Task ADisarmThatNeverFinishesIsGuarded()
    {
        var logs = new List<string>();
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            disarm: () => new TaskCompletionSource().Task,
            disarmGuard: TimeSpan.FromMilliseconds(100),
            quit: _ => quit = true,
            schedule: (_, _) => { }, log: logs.Add);

        await sequence.StartAsync("host-gone").WaitAsync(TimeSpan.FromSeconds(1));
        Assert(quit, "a missing disarm callback is bounded");
        Assert(logs.Any(line => line.Contains("capture disarm did not finish within")), "the guard timeout is logged");
    }

    private static async Task TheDisarmGuardStartsAtTheSequenceStart()
    {
        var logs = new List<string>();
        var clock = Stopwatch.StartNew();
        TimeSpan? quitAfter = null;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => new TaskCompletionSource().Task,
            disarm: () => new TaskCompletionSource().Task,
            notifyTimeout: TimeSpan.FromMilliseconds(300),
            disarmGuard: TimeSpan.FromMilliseconds(500),
            quit: _ => quitAfter = clock.Elapsed,
            schedule: (_, _) => { }, log: logs.Add);

        await sequence.StartAsync("host-gone").WaitAsync(TimeSpan.FromSeconds(2));
        Assert(quitAfter is not null, "pending notify and disarm still allow quit");
        Assert(logs.Any(line => line.Contains("capture disarm did not finish within")), "the disarm guard timeout is logged");
        Assert(quitAfter < TimeSpan.FromMilliseconds(700),
            $"the guard starts beside notify, so quit follows the larger timeout, not their sum (took {quitAfter!.Value.TotalMilliseconds:0}ms)");
        Console.WriteLine($"HeadlessDisconnectExitTests guard start: quit after {quitAfter!.Value.TotalMilliseconds:0}ms.");
    }

    private static async Task ADisarmThatThrowsStillQuits()
    {
        foreach (var asynchronous in new[] { false, true })
        {
            var quit = false;
            var logs = new List<string>();
            var sequence = new HeadlessDisconnectExitSequence(
                notifyViewers: (_, _) => Task.CompletedTask,
                disarm: () => asynchronous ? Task.FromException(new IOException("disarm failed")) : throw new IOException("disarm failed"),
                quit: _ => quit = true,
                schedule: (_, _) => { }, log: logs.Add);

            await sequence.StartAsync("host-gone");
            Assert(quit && logs.Any(line => line.Contains("disarm failed:")), "a failed disarm logs and still quits");
        }
    }

    private static void TheBackstopCoversTheWholeBoundedExit()
    {
        Assert(HeadlessDisconnectExitSequence.DisarmGuard == TimeSpan.FromSeconds(5), "deferred disarm guard is five seconds");
        Assert(HeadlessDisconnectExitSequence.ForceExitDelay == TimeSpan.FromSeconds(7.5), "seat backstop is 7.5 seconds");
        Assert(HeadlessDisconnectExitSequence.ForceExitDelay >= HeadlessDisconnectExitSequence.DisarmGuard + TimeSpan.FromSeconds(1.5),
            "backstop covers disarm guard and process exit margin");
        Assert(HeadlessDisconnectExitSequence.ForceExitDelay > HeadlessDisconnectExitSequence.NotifyTimeout,
            "notify cannot consume the backstop");
    }

    private static async Task ForceExitDoesNotWaitOnABlockedLog()
    {
        using var unblockLog = new ManualResetEventSlim();
        var forced = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Action? backstop = null;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: _ => { }, forceExit: () => forced.TrySetResult(),
            schedule: (_, callback) => backstop = callback,
            log: line => { if (line.Contains("force-exiting")) unblockLog.Wait(); });
        await sequence.StartAsync("host-gone");
        var run = Task.Run(backstop!);
        try
        {
            await forced.Task.WaitAsync(TimeSpan.FromMilliseconds(500));
            await run;
        }
        finally
        {
            unblockLog.Set();
        }
    }

    // The game can report the same drop through more than one path (transport event, then a handler's own
    // Disconnect call). A re-entry must not re-send the last gasp or arm a second SIGKILL timer.
    private static async Task SecondTriggerIsIgnored()
    {
        var disarms = 0;
        var notifies = 0;
        var quits = 0;
        var arms = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => { notifies++; return Task.CompletedTask; },
            quit: _ => quits++,
            disarm: () => { disarms++; return Task.CompletedTask; },
            forceExit: () => { },
            schedule: (_, _) => arms++,
            log: _ => { });

        Assert(await sequence.StartAsync("first"), "first trigger runs");
        Assert(!await sequence.StartAsync("second"), "second trigger is refused");
        Assert(disarms == 1 && notifies == 1 && quits == 1 && arms == 1,
            $"each effect happened exactly once (notify={notifies} quit={quits} arm={arms})");
    }

    // The last gasp is best-effort: a viewer socket that is already gone must not stop the instance exiting.
    private static async Task NotifyFailureStillQuits()
    {
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => throw new IOException("socket already gone"),
            quit: _ => quit = true,
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { });

        Assert(await sequence.StartAsync("boom"), "the sequence runs");
        Assert(quit, "a failed last-gasp notify does not block the process exit");
    }

    // A notify that never completes (a half-open socket) must not consume the force-exit budget.
    private static async Task NotifyThatNeverCompletesIsTimeBoxed()
    {
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => new TaskCompletionSource().Task, // never completes
            quit: _ => quit = true,
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { },
            notifyTimeout: TimeSpan.FromMilliseconds(50));

        var start = DateTimeOffset.UtcNow;
        Assert(await sequence.StartAsync("hang"), "the sequence runs");
        var elapsed = DateTimeOffset.UtcNow - start;
        Assert(quit, "a hung notify is abandoned and the process exit still runs");
        Assert(elapsed < TimeSpan.FromSeconds(2), $"the notify is time-boxed (took {elapsed.TotalMilliseconds:0}ms)");
    }

    // If the process exit itself throws, the sequence still completes
    // and the armed backstop is what ends the process.
    private static async Task QuitFailureLeavesTheBackstopToFinishTheJob()
    {
        Action? armed = null;
        var forced = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: _ => throw new InvalidOperationException("Process exit failed."),
            forceExit: () => forced = true,
            schedule: (_, action) => armed = action,
            log: _ => { });

        Assert(await sequence.StartAsync("no tree"), "a throwing quit does not fault the sequence");
        Assert(armed is not null, "the backstop was armed before the quit attempt");
        Assert(!forced, "the backstop has not fired yet");
        armed!();
        Assert(forced, "when the armed backstop fires it force-exits");
    }

    // The armed action IS the force exit (and nothing else) — guards against a refactor that arms a no-op.
    private static async Task ScheduledBackstopForceExits()
    {
        Action? armed = null;
        TimeSpan delay = default;
        var forced = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: _ => { },
            forceExit: () => forced++,
            schedule: (d, action) => { delay = d; armed = action; },
            log: _ => { });

        await sequence.StartAsync("reason");
        Assert(delay == HeadlessDisconnectExitSequence.ForceExitDelay, "the backstop uses the documented delay");
        armed!();
        Assert(forced == 1, "the armed action force-exits exactly once");
    }

    private static void Assert(bool condition, string label)
    {
        if (!condition)
        {
            throw new Exception($"[HeadlessDisconnectExitTests] FAILED: {label}");
        }
    }
}
