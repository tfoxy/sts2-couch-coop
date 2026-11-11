using System.Reflection;
using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using Godot;
using Suspender = CouchCoop.Mod.Session.CouchCoopHeadlessVisualSuspender;

internal static class HeadlessSuspenderEnableTests
{
    private static int _assertions;

    public static void Run()
    {
        _assertions = 0;
        EveryProcessModeRoundTrips();
        EveryCallbackFlagPairRoundTrips();
        RescansKeepTheOriginalState();
        EnableDisableEnableRepopulatesTheBookkeeping();
        EnableDecisionsPreserveTheConfiguration();
        TimerDemandHonorsEnabledInEveryMode();
        BeforeInstallRemembersTheRequestedState();
        DisableClearsRuntimeStateAndIgnoresLateWork();
        DeathDelayCapHonorsEnabledAndPreservesTaskIdentity();
        AssetLoadTrackingHonorsEnabledAndInstallMode();
        ParticleRestartObservationHonorsEnabled();
        Console.WriteLine($"suspender enable: 11 tests, {_assertions} assertions passed");
    }

    private static void EveryProcessModeRoundTrips()
    {
        var states = new FrozenNodeStates<Node.ProcessModeEnum>();
        var restored = new Dictionary<ulong, Node.ProcessModeEnum>();
        foreach (var mode in Enum.GetValues<Node.ProcessModeEnum>())
        {
            Assert(states.Remember((ulong)mode, mode), "each process mode can be recorded, including Disabled");
        }
        states.Restore((id, mode) => restored.Add(id, mode));
        foreach (var mode in Enum.GetValues<Node.ProcessModeEnum>())
        {
            Assert(restored[(ulong)mode] == mode, $"{mode} restores exactly, without assuming Inherit");
        }
        Assert(states.Count == 0, "restoring process modes releases all ids");
        states.Restore((_, _) => throw new Exception("an empty ledger must not restore twice"));
    }

    private static void EveryCallbackFlagPairRoundTrips()
    {
        foreach (var process in new[] { false, true })
        foreach (var physics in new[] { false, true })
        {
            var states = new FrozenNodeStates<Suspender.ProcessFlags>();
            var prior = new Suspender.ProcessFlags(process, physics);
            states.Remember(42, prior);
            Suspender.ProcessFlags? restored = null;
            states.Restore((_, flags) => restored = flags);
            Assert(restored == prior, $"process={process}, physics={physics} restores without enabling extra callbacks");
            Assert(states.Count == 0, "process-only thaw releases its ids");
        }
    }

    private static void RescansKeepTheOriginalState()
    {
        var states = new FrozenNodeStates<Node.ProcessModeEnum>();
        Assert(states.Remember(12, Node.ProcessModeEnum.Always), "the first freeze captures the prior state");
        Assert(!states.Remember(12, Node.ProcessModeEnum.Disabled), "a second scan does not replace the saved mode");
        Assert(!states.Remember(12, Node.ProcessModeEnum.Pausable), "reasserting a freeze keeps the first mode");
        Assert(states.Count == 1 && states.Contains(12), "reasserting does not duplicate the id");
        states.Restore((_, mode) => Assert(mode == Node.ProcessModeEnum.Always, "thaw restores the first mode"));

        var callbacks = new FrozenNodeStates<Suspender.ProcessFlags>();
        callbacks.Remember(15, new(true, false));
        callbacks.Remember(15, new(true, true));
        callbacks.Restore((_, flags) => Assert(flags == new Suspender.ProcessFlags(true, false),
            "process-only reassertion does not overwrite the original physics flag"));
    }

    private static void EnableDisableEnableRepopulatesTheBookkeeping()
    {
        // Same decision and state stores as the runtime, with ordinary values standing in for native nodes.
        var categories = Enumerable.Range(0, 3).Select(_ => new FrozenNodeStates<Node.ProcessModeEnum>()).ToArray();
        var callbacks = new FrozenNodeStates<Suspender.ProcessFlags>();
        var configured = new Suspender.FreezeStates(true, true, true);
        var liveModes = new[] { Node.ProcessModeEnum.Always, Node.ProcessModeEnum.WhenPaused, Node.ProcessModeEnum.Inherit };
        var priorModes = liveModes.ToArray();
        var liveFlags = new Suspender.ProcessFlags(true, false);
        foreach (var enabled in new[] { true, false, true, false })
        {
            var actions = Suspender.ComputeEnableActions(enabled, hasViewers: true, configured);
            if (actions.ReleaseAll)
            {
                for (var i = 0; i < categories.Length; i++)
                {
                    var index = i;
                    categories[i].Restore((_, mode) => liveModes[index] = mode);
                }
                callbacks.Restore((_, flags) => liveFlags = flags);
                Assert(liveModes.SequenceEqual(priorModes), "disable restores all category modes");
                Assert(liveFlags == new Suspender.ProcessFlags(true, false), "disable restores callback flags");
            }
            else
            {
                var freezes = new[] { actions.FreezeNow.Particles, actions.FreezeNow.Spines, actions.FreezeNow.Decor };
                for (var i = 0; i < categories.Length; i++)
                {
                    if (!freezes[i]) continue;
                    categories[i].Remember((ulong)i, liveModes[i]);
                    liveModes[i] = Node.ProcessModeEnum.Disabled;
                }
                if (actions.FreezeNow.Decor)
                {
                    callbacks.Remember(4, liveFlags);
                    liveFlags = new(false, false);
                }
            }
            Assert(categories.All(states => states.Count == (enabled ? 1 : 0)),
                "every category empties on disable and repopulates on enable");
            Assert(callbacks.Count == (enabled ? 1 : 0), "process-only bookkeeping follows the same cycle");
        }
    }

    private static void EnableDecisionsPreserveTheConfiguration()
    {
        foreach (var enabled in new[] { false, true })
        foreach (var viewers in new[] { false, true })
        for (var flags = 0; flags < 8; flags++)
        {
            var configured = new Suspender.FreezeStates((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0);
            var actions = Suspender.ComputeEnableActions(enabled, viewers, configured);
            Assert(actions.ReleaseAll == !enabled, "disable releases everything regardless of category flags or viewers");
            Assert(actions.FreezeNow == (enabled && viewers ? configured : default),
                "enable walks only configured categories and only with viewers");
        }
    }

    private static void TimerDemandHonorsEnabledInEveryMode()
    {
        foreach (var enabled in new[] { false, true })
        foreach (var rescanOnly in new[] { false, true })
        foreach (var viewers in new[] { false, true })
        foreach (var nudges in new[] { false, true })
        {
            var expected = enabled && (!rescanOnly || viewers || nudges);
            Assert(Suspender.ShouldRunTimer(enabled, rescanOnly, viewers, nudges) == expected,
                $"timer enabled={enabled}, rescanOnly={rescanOnly}, viewers={viewers}, nudges={nudges}");
        }
    }

    private static void BeforeInstallRemembersTheRequestedState()
    {
        using var saved = new StaticState();
        Set("_started", false);
        Assert(Suspender.IsEnabled, "the suspender defaults to enabled");
        Suspender.SetEnabled(false);
        Assert(!Suspender.IsEnabled && !Suspender.IsInstalled, "disable before install is remembered without installing");
        Assert(Suspender.EffectiveFreezes() == default, "disabled machinery reports no effective freezes");
        Suspender.SetEnabled(true);
        Assert(Suspender.IsEnabled && !Suspender.IsInstalled, "enable before install is remembered without installing");
    }

    private static void DisableClearsRuntimeStateAndIgnoresLateWork()
    {
        using var saved = new StaticState();
        Set("_started", true);
        Set("_enabled", true);
        Set("_rescanOnly", true);
        Set("_suspended", true);
        Set("_fpsThrottled", false); // Restoring Engine.MaxFps requires the live-game leg.
        Set("_freezeParticles", false);
        Set("_freezeSpine", true);
        Set("_freezeDecor", false);
        var pending = (Dictionary<ulong, long>)Field("_pendingFinishNudges").GetValue(null)!;
        Assert(pending.Count == 0, "the isolated test starts with no owed nudges");
        pending[42] = 123;
        try
        {
            // Empty native-node stores and no Timer let us exercise the real disable cleanup without Godot.
            Set("_enabled", false);
            Invoke("ReconcileEnabledStateOnMainThread");
            Assert(!Suspender.IsEnabled && Suspender.IsInstalled, "disable keeps the installation reusable");
            Assert(!(bool)Field("_suspended").GetValue(null)! && !(bool)Field("_fpsThrottled").GetValue(null)!,
                "disable clears both idle throttle latches");
            Assert(pending.Count == 0, "disable clears pending finish nudges even with particle freeze off");
            Assert(Suspender.EffectiveFreezes() == default, "installed but disabled reports no effective freezes");
            Assert(!(bool)Field("_freezeParticles").GetValue(null)! && (bool)Field("_freezeSpine").GetValue(null)!
                && !(bool)Field("_freezeDecor").GetValue(null)!, "disable preserves category configuration");
            Invoke("Tick", (object?)null);
            Assert(!(bool)Field("_suspended").GetValue(null)!, "a stray timeout remains inert");
            var report = Suspender.CreateStreamingDemandReporter();
            report(1, 1);
            report(0, 2);
            Assert(!Suspender.IsEnabled, "viewer transitions while disabled do not queue a native timer wake");
            Set("_enabled", true);
            Invoke("ReconcileEnabledStateOnMainThread");
            Assert(Suspender.IsEnabled && Suspender.EffectiveFreezes() == new Suspender.FreezeStates(false, true, false),
                "re-enable retains the same configured freezes");
        }
        finally
        {
            pending.Clear();
        }
    }

    private static void DeathDelayCapHonorsEnabledAndPreservesTaskIdentity()
    {
        using var saved = new StaticState();
        var pending = new TaskCompletionSource();
        var faulted = Task.FromException(new InvalidOperationException("delay failed"));
        var canceled = Task.FromCanceled(new CancellationToken(canceled: true));
        var postfix = typeof(HeadlessDeathDelayCapPatch).GetMethod(
            "CapDelayTaskPostfix", BindingFlags.Static | BindingFlags.NonPublic)!;
        var wrappers = new List<Task>();
        try
        {
            foreach (var enabled in new[] { true, false, true })
            {
                Set("_enabled", enabled);
                foreach (var original in new Task?[] { null, Task.CompletedTask, faulted, canceled, pending.Task })
                {
                    var shouldCap = enabled && ReferenceEquals(original, pending.Task);
                    Assert(HeadlessDeathDelayCapPatch.ShouldCapDelayTask(enabled, original) == shouldCap,
                        "only an enabled suspender caps an incomplete task");
                    object?[] args = [original];
                    postfix.Invoke(null, args);
                    Assert(ReferenceEquals(args[0], original) == !shouldCap,
                        "the postfix preserves the exact original task unless a cap is needed");
                    if (shouldCap) wrappers.Add((Task)args[0]!);
                }
            }
        }
        finally
        {
            pending.SetResult();
            Task.WhenAll(wrappers).GetAwaiter().GetResult();
            _ = faulted.Exception;
        }
    }

    private static void AssetLoadTrackingHonorsEnabledAndInstallMode()
    {
        foreach (var enabled in new[] { false, true })
        foreach (var started in new[] { false, true })
        foreach (var rescanOnly in new[] { false, true })
        foreach (var completed in new[] { false, true })
        {
            Assert(Suspender.ShouldTrackAssetLoading(enabled, started, rescanOnly, completed)
                == (enabled && started && !rescanOnly && !completed),
                "asset tracking requires an enabled full installation and an incomplete task");
        }

        using var saved = new StaticState();
        Set("_started", true);
        Set("_rescanOnly", false);
        Set("_fpsThrottled", false);
        var loads = (PendingAssetLoads)Field("AssetLoads").GetValue(null)!;
        Assert(!loads.HasPendingLoads, "the isolated hook test starts without pending loads");
        foreach (var enabled in new[] { true, false, true })
        {
            Set("_enabled", enabled);
            var load = new TaskCompletionSource();
            try
            {
                Suspender.TrackAssetLoading(load.Task);
                Assert(loads.HasPendingLoads == enabled,
                    "the actual asset hook stops registering loads while disabled and resumes on enable");
            }
            finally
            {
                load.SetResult();
            }
            Assert(!loads.HasPendingLoads, "each hook registration is released after completion");
        }
    }

    private static void ParticleRestartObservationHonorsEnabled()
    {
        foreach (var enabled in new[] { true, false, true })
        foreach (var hasFrozenParticles in new[] { false, true })
        {
            Assert(Suspender.ShouldObserveParticleRestart(enabled, hasFrozenParticles)
                == (enabled && hasFrozenParticles),
                "disabled restarts are ignored even before thaw clears the frozen-node ledger");
        }
    }

    private sealed class StaticState : IDisposable
    {
        private readonly Dictionary<FieldInfo, object?> _saved = new[]
        {
            "_started", "_enabled", "_rescanOnly", "_suspended", "_fpsThrottled",
            "_freezeParticles", "_freezeSpine", "_freezeDecor",
        }.Select(Field).ToDictionary(field => field, field => field.GetValue(null));

        public void Dispose()
        {
            foreach (var (field, value) in _saved) field.SetValue(null, value);
        }
    }

    private static FieldInfo Field(string name) => typeof(Suspender).GetField(name, BindingFlags.Static | BindingFlags.NonPublic)!;
    private static void Set(string name, object value) => Field(name).SetValue(null, value);
    private static void Invoke(string name, params object?[] args)
        => typeof(Suspender).GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, args);

    private static void Assert(bool condition, string message)
    {
        _assertions++;
        if (!condition) throw new Exception($"HeadlessSuspenderEnableTests: {message}");
    }
}
