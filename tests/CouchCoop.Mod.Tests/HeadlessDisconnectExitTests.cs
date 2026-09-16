using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using HarmonyLib;
using MegaCrit.Sts2.Core.Entities.Multiplayer;
using MegaCrit.Sts2.Core.Multiplayer;
using MegaCrit.Sts2.Core.Nodes.CommonUi;

// WS-8: a headless mirror instance whose host connection is permanently gone must EXIT instead of parking behind
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
        await SecondTriggerIsIgnored();
        await NotifyFailureStillQuits();
        await NotifyThatNeverCompletesIsTimeBoxed();
        await QuitFailureLeavesTheBackstopToFinishTheJob();
        await ScheduledBackstopForceExits();
        ARunInProgressRefusalIsClassified();
        await ASpecificReasonRefinesTheGenericOneThatStartedTheShutdown();
        await AGenericSecondReasonNeverDisplacesASpecificOne();
        await RefinementHappensAtMostOnceAndNeverThrows();
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

    // THE RACE THAT LOST THE DIAGNOSIS. The transport publishes a generic drop first and starts the shutdown; the
    // game's own handler follows with the reason the host actually gave. The second one used to be logged as
    // "already running — ignoring" and thrown away, leaving the host to show the generic join copy ("check that
    // game and mod versions match") for a run the seat simply was not in.
    private static async Task ASpecificReasonRefinesTheGenericOneThatStartedTheShutdown()
    {
        var refined = new List<string>();
        var notifies = 0;
        var quits = 0;
        var arms = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => { notifies++; return Task.CompletedTask; },
            quit: () => quits++,
            forceExit: () => { },
            schedule: (_, _) => arms++,
            log: _ => { },
            refineReason: refined.Add);

        Assert(await sequence.StartAsync(HeadlessDisconnectReason.NativeNetworkErrorCode), "the generic drop starts the shutdown");
        Assert(!await sequence.StartAsync(HeadlessDisconnectReason.RunInProgressCode),
            "the specific reason does not restart the shutdown");
        Assert(sequence.Reason == HeadlessDisconnectReason.RunInProgressCode,
            "…but it becomes the recorded reason");
        Assert(refined.Count == 1 && refined[0] == HeadlessDisconnectReason.RunInProgressCode,
            "…and is handed to the hook that reports it upstream");
        Assert(notifies == 1 && quits == 1 && arms == 1,
            $"refinement changes nothing about the shutdown itself (notify={notifies} quit={quits} arm={arms})");
    }

    private static async Task AGenericSecondReasonNeverDisplacesASpecificOne()
    {
        var refined = new List<string>();
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: () => { },
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { },
            refineReason: refined.Add);

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
            quit: () => { },
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
    // send and the clean quit). Any other order would let a wedged instance survive indefinitely — the whole
    // defect this workstream exists to kill.
    private static async Task ArmsTheForceExitBackstopBeforeNotifyAndQuit()
    {
        var trace = new List<string>();
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (reason, _) => { trace.Add($"notify:{reason}"); return Task.CompletedTask; },
            quit: () => trace.Add("quit"),
            forceExit: () => trace.Add("force-exit"),
            schedule: (delay, _) => trace.Add($"arm:{delay.TotalSeconds}"),
            log: _ => { });

        var started = await sequence.StartAsync("DisconnectionReason UnknownNetworkError False");

        Assert(started, "the first trigger starts the sequence");
        Assert(sequence.Started, "the sequence reports itself started");
        Assert(string.Join(",", trace) == $"arm:{HeadlessDisconnectExitSequence.ForceExitDelay.TotalSeconds},notify:DisconnectionReason UnknownNetworkError False,quit",
            $"order is arm-backstop → notify viewers → clean quit (got: {string.Join(",", trace)})");
        Assert(!trace.Contains("force-exit"), "the backstop is only armed, never fired inline");
    }

    // The game can report the same drop through more than one path (transport event, then a handler's own
    // Disconnect call). A re-entry must not re-send the last gasp or arm a second SIGKILL timer.
    private static async Task SecondTriggerIsIgnored()
    {
        var notifies = 0;
        var quits = 0;
        var arms = 0;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => { notifies++; return Task.CompletedTask; },
            quit: () => quits++,
            forceExit: () => { },
            schedule: (_, _) => arms++,
            log: _ => { });

        Assert(await sequence.StartAsync("first"), "first trigger runs");
        Assert(!await sequence.StartAsync("second"), "second trigger is refused");
        Assert(notifies == 1 && quits == 1 && arms == 1,
            $"each effect happened exactly once (notify={notifies} quit={quits} arm={arms})");
    }

    // The last gasp is best-effort: a viewer socket that is already gone must not stop the instance exiting.
    private static async Task NotifyFailureStillQuits()
    {
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => throw new IOException("socket already gone"),
            quit: () => quit = true,
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { });

        Assert(await sequence.StartAsync("boom"), "the sequence runs");
        Assert(quit, "a failed last-gasp notify does not block the clean quit");
    }

    // A notify that never completes (a half-open socket) must not consume the force-exit budget.
    private static async Task NotifyThatNeverCompletesIsTimeBoxed()
    {
        var quit = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => new TaskCompletionSource().Task, // never completes
            quit: () => quit = true,
            forceExit: () => { },
            schedule: (_, _) => { },
            log: _ => { },
            notifyTimeout: TimeSpan.FromMilliseconds(50));

        var start = DateTimeOffset.UtcNow;
        Assert(await sequence.StartAsync("hang"), "the sequence runs");
        var elapsed = DateTimeOffset.UtcNow - start;
        Assert(quit, "a hung notify is abandoned and the clean quit still runs");
        Assert(elapsed < TimeSpan.FromSeconds(2), $"the notify is time-boxed (took {elapsed.TotalMilliseconds:0}ms)");
    }

    // If the clean quit itself throws (no SceneTree / a game already tearing down), the sequence still completes
    // and the armed backstop is what ends the process.
    private static async Task QuitFailureLeavesTheBackstopToFinishTheJob()
    {
        Action? armed = null;
        var forced = false;
        var sequence = new HeadlessDisconnectExitSequence(
            notifyViewers: (_, _) => Task.CompletedTask,
            quit: () => throw new InvalidOperationException("No SceneTree main loop to quit."),
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
            quit: () => { },
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
