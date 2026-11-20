using CouchCoop.Mod.Server;
using CouchCoop.Mod.Session;
using CouchCoop.Mod.Patches;
using Godot;

internal static class StreamStaticParticlesTests
{
    private static int _assertions;

    public static void Run()
    {
        _assertions = 0;
        (bool Armed, bool[] Pages, bool Expected)[] votes =
        [
            (true, [true, true], true),
            (true, [true, false], false),
            (true, [false, true], false),
            (true, [true], true),
            (true, [false], false),
            (true, [], false),
            (false, [true, true], false),
            (false, [], false),
        ];
        foreach (var (armed, pages, expected) in votes)
            Assert(CouchCoopBrowserServer.ComputeStreamParticleFreezeDesired(armed, pages) == expected,
                "only an armed capture with unanimous nonempty stream-page demand freezes particles");
        foreach (var armed in new[] { false, true })
        foreach (var desired in new[] { false, true })
            Assert(CouchCoopStreamStaticParticles.ShouldFreeze(armed, desired) == (armed && desired),
                "the session independently gates demand on capture arming");

        (bool OneShot, double Lifetime, double Explosiveness, double Expected)[] warmups =
        [
            (false, 3, 0, 3),
            (false, 3, 1, 3),
            (false, 20, 0, 20),
            (false, -1, 0, 0),
            (false, double.NaN, 0, 0),
            (true, 3, 0, 3),
            (true, 3, 1, 1.5),
            (true, 3, 0.5, 2.25),
            (true, 0, 0, 0),
            (true, -1, 0, 0),
            (true, 100, 0, 100),
            (true, double.PositiveInfinity, 0, 0),
            (true, 1, double.NaN, 0),
        ];
        foreach (var (oneShot, lifetime, explosiveness, expected) in warmups)
            Assert(CouchCoopStreamStaticParticles.WarmupSeconds(oneShot, lifetime, explosiveness) == expected,
                "loopers prewarm one lifetime; bursts use half their active time");
        Assert(CouchCoopStreamStaticParticles.ActiveTimeSeconds(3, 0) == 6, "spread burst active time");
        Assert(CouchCoopStreamStaticParticles.ActiveTimeSeconds(3, 1) == 3, "explosive burst active time");
        RemovalDurationUsesSpeedAndClamps();
        StartTargetsResolveWithoutTheEngine();
        RestartReplacesTheDeadline();
        TreeExitCancelsQueuedRemoval();
        DeactivateCancelsEveryDeadline();
        RemovalRunsOnceOnTheNextFrame();
        FailedSchedulingDropsTheEntry();
        RestoringOneEmitterPreservesOtherSavedModes();
        ExitRestoresSurvivorsAndDropsFreedNodes();
        DeactivationBeforeExitCleanupRestoresOnce();
        FreezeRequiresNativeProcessing();
        StopReleasesFrozenAndPendingEmitters();
        RestartInvalidatesADeferredStop();
        Console.WriteLine($"stream static particles: {_assertions} pure cases passed");
    }

    private static void RemovalDurationUsesSpeedAndClamps()
    {
        (double Lifetime, double Explosiveness, double Speed, double Expected)[] durations =
        [
            (2, 0, 1, 2), (2, 1, 1, 1),
            (2, 0, 0.5, 4), (2, 1, 0.5, 2),
            (2, 0, 2, 1), (2, 1, 2, 0.5),
            (3, 0.5, 1.5, 1.5),
            (0.01, 1, 1, 0.5), (100, 0, 1, 10),
            (0, 0, 1, 0.5), (-1, 0, 1, 0.5),
            (1, 0, 0, 10), (1, 0, -1, 10),
            (0.001, 0, 0, 1),
            (double.NaN, 0, 1, 0.5), (double.PositiveInfinity, 0, 1, 0.5),
            (1, double.NaN, 1, 0.5), (1, 0, double.NaN, 0.5),
            (1, 0, double.PositiveInfinity, 0.5),
        ];
        foreach (var (lifetime, explosiveness, speed, expected) in durations)
            Assert(CouchCoopStreamStaticParticles.RemovalDelaySeconds(lifetime, explosiveness, speed) == expected,
                "the deadline uses the remaining half-burst divided by speed, clamped to 0.5–10 seconds");
    }

    internal static void StartTargetsResolveWithoutTheEngine()
    {
        var restart = StreamStaticParticleStartPatch.ResolveRestart();
        Assert(restart?.DeclaringType == typeof(CpuParticles2D) && !restart.IsStatic,
            "the typed CPU restart target resolves");
        var setter = StreamStaticParticleStartPatch.ResolveEmittingSetter();
        Assert(setter?.DeclaringType == typeof(CpuParticles2D) && !setter.IsStatic
            && setter.GetParameters() is [{ ParameterType: var parameter }] && parameter == typeof(bool),
            "the typed CPU emitting setter resolves with its boolean value");
        CouchCoopStreamStaticParticles.NotifyStarted(null!);
        Assert(true, "a disarmed start is a no-op without reading any native node");
        CouchCoopStreamStaticParticles.NotifyStopped(null!);
        Assert(true, "a disarmed stop is a no-op without reading any native node");
    }

    private static void RestartReplacesTheDeadline()
    {
        var rig = new DeadlineRig();
        rig.Start(42, 1);
        var old = rig.Timers[0];
        old.Fire();
        Assert(rig.Frames.Count == 1 && rig.Finished.Count == 0, "timeout defers emitter reads by one frame");
        rig.Start(42, 2);
        Assert(old.Cancelled && rig.Timers.Count == 2 && rig.Timers[1].Delay == 2,
            "restart replaces the old deadline using the new burst duration");
        old.Fire();
        rig.Frame();
        Assert(rig.Finished.Count == 0 && rig.Frames.Count == 0, "restart also invalidates an already queued removal");
        rig.Timers[1].Fire();
        rig.Frame();
        Assert(rig.Finished.SequenceEqual([42UL]), "only the replacement burst is drained");
    }

    private static void TreeExitCancelsQueuedRemoval()
    {
        var rig = new DeadlineRig();
        rig.Start(42, 1);
        rig.Timers[0].Fire();
        rig.Deadlines.Cancel(42); // TreeExiting cancels synchronously, before deferred native cleanup.
        rig.Timers[0].Fire();
        rig.Frame();
        Assert(rig.Timers[0].Cancelled && rig.Finished.Count == 0 && rig.Frames.Count == 0,
            "tree exit invalidates both the timer and any dispatched removal");
        rig.Deadlines.Cancel(42);
        Assert(rig.Timers.Count == 1, "repeated tree-exit cancellation is harmless");
    }

    private static void DeactivateCancelsEveryDeadline()
    {
        var rig = new DeadlineRig();
        rig.Start(42, 1);
        rig.Start(43, 2);
        rig.Timers[0].Fire();
        rig.Deadlines.Clear();
        foreach (var timer in rig.Timers) timer.Fire();
        rig.Frame();
        Assert(rig.Timers.All(timer => timer.Cancelled) && rig.Finished.Count == 0,
            "off, demand loss or disarm cancels all timer and frame callbacks");
        rig.Start(42, 3);
        rig.Timers[2].Fire();
        rig.Frame();
        Assert(rig.Finished.SequenceEqual([42UL]), "a later activation can schedule fresh work for the same emitter");
    }

    private static void RemovalRunsOnceOnTheNextFrame()
    {
        var rig = new DeadlineRig();
        rig.Start(42, 0.5);
        rig.Timers[0].Fire();
        rig.Timers[0].Fire();
        Assert(rig.Frames.Count == 1 && rig.Finished.Count == 0, "a timeout queues only one removal frame");
        rig.Frame();
        rig.Timers[0].Fire();
        Assert(rig.Finished.SequenceEqual([42UL]) && rig.Timers[0].Cancelled && rig.Frames.Count == 0,
            "removal disposes the timer and never repeats");
    }

    private static void FailedSchedulingDropsTheEntry()
    {
        Action? staleCallback = null;
        var frames = new Queue<Action>();
        var deadlines = new StreamParticleDeadlines((_, callback) =>
        {
            staleCallback = callback;
            throw new InvalidOperationException("scheduler failed");
        }, frames.Enqueue);
        try
        {
            deadlines.Replace(42, 1, () => throw new Exception("unexpected removal"));
            throw new Exception("expected scheduler failure");
        }
        catch (InvalidOperationException) { }
        staleCallback!();
        Assert(frames.Count == 0, "a failed scheduler cannot leave a callback eligible to remove the emitter");
        deadlines.Cancel(42);
        deadlines.Clear();
    }

    private static void RestoringOneEmitterPreservesOtherSavedModes()
    {
        var frozen = new FrozenNodeStates<Node.ProcessModeEnum>();
        frozen.Remember(42, Node.ProcessModeEnum.Always);
        frozen.Remember(43, Node.ProcessModeEnum.Pausable);
        Assert(frozen.TryRemove(42, out var mode) && mode == Node.ProcessModeEnum.Always && frozen.Count == 1,
            "restart or removal takes only that emitter's original process mode");
        Assert(!frozen.TryRemove(42, out _), "a completed burst cannot restore its mode twice");
        frozen.Restore((id, saved) => Assert(id == 43 && saved == Node.ProcessModeEnum.Pausable,
            "other emitters retain their mode until their own cleanup or deactivation"));
        Assert(frozen.Count == 0, "deactivation consumes the remaining saved modes");
    }

    private static void ExitRestoresSurvivorsAndDropsFreedNodes()
    {
        var survivor = new ExitRig();
        survivor.Exit();
        Assert(survivor.Frozen.Count == 1 && survivor.Writes == 0, "exit retains the saved mode until deferred cleanup");
        survivor.Frame();
        Assert(survivor.Mode == Node.ProcessModeEnum.Inherit && survivor.Writes == 1 && survivor.Frozen.Count == 0,
            "a surviving emitter restores its inherited mode exactly once");
        survivor.Frozen.Remember(42, Node.ProcessModeEnum.Always); // A fresh tracker has frozen the re-entered node.
        survivor.Cleanup();
        Assert(survivor.Frozen.Count == 1 && survivor.Writes == 1,
            "an old exit callback cannot consume a re-entered emitter's newly saved mode");

        var reentered = new ExitRig();
        reentered.Exit();
        reentered.Cleanup(); // Re-entry replaces the exited tracker before its queued cleanup runs.
        Assert(reentered.Writes == 1 && reentered.Frozen.Count == 0,
            "re-entry restores the old mode before creating a fresh tracker");
        reentered.Frozen.Remember(42, Node.ProcessModeEnum.Always);
        reentered.Frame();
        Assert(reentered.Writes == 1 && reentered.Frozen.Count == 1,
            "deferred exit cleanup leaves the replacement tracker's saved mode intact");

        var freed = new ExitRig();
        freed.Exit();
        freed.Valid = false;
        freed.Frame();
        Assert(freed.Writes == 0 && freed.Frozen.Count == 0, "a freed emitter drops its saved mode without a native write");
    }

    private static void DeactivationBeforeExitCleanupRestoresOnce()
    {
        foreach (var valid in new[] { true, false })
        {
            var rig = new ExitRig { Valid = valid };
            rig.Exit();
            rig.Deactivate();
            rig.Frame(); // Exercise a dispatched callback even though production also disconnects it.
            Assert(rig.Writes == (valid ? 1 : 0) && rig.Frozen.Count == 0,
                "deactivation before exit cleanup restores a survivor once and skips a freed node");
        }
    }

    private static void FreezeRequiresNativeProcessing()
    {
        foreach (var warmed in new[] { false, true })
        foreach (var oneShot in new[] { false, true })
        {
            foreach (var mode in new[] { Node.ProcessModeEnum.Inherit, Node.ProcessModeEnum.Pausable,
                         Node.ProcessModeEnum.WhenPaused, Node.ProcessModeEnum.Always })
            {
                Assert(CouchCoopStreamStaticParticles.CanFreeze(true, true, true, mode, true, false, oneShot, warmed),
                    "each previously accepted live process mode still admits emitting loopers and bursts");
                Assert(!CouchCoopStreamStaticParticles.CanFreeze(true, true, true, mode, false, false, oneShot, warmed),
                    "both stages reject inherited disabling or tree pause even when the emitter's own mode is enabled");
            }
            Assert(!CouchCoopStreamStaticParticles.CanFreeze(false, true, true, Node.ProcessModeEnum.Inherit, true, false, oneShot, warmed),
                "an emitter outside the tree never freezes");
            Assert(!CouchCoopStreamStaticParticles.CanFreeze(true, true, false, Node.ProcessModeEnum.Inherit, true, false, oneShot, warmed),
                "an invisible emitter never freezes");
            Assert(!CouchCoopStreamStaticParticles.CanFreeze(true, true, true, Node.ProcessModeEnum.Disabled, true, false, oneShot, warmed),
                "an independently disabled emitter never freezes");
            Assert(!CouchCoopStreamStaticParticles.CanFreeze(true, true, true, Node.ProcessModeEnum.Inherit, true, true, oneShot, warmed),
                "an exempt emitter never freezes");
            Assert(CouchCoopStreamStaticParticles.CanFreeze(true, false, true, Node.ProcessModeEnum.Inherit, true, false, oneShot, warmed)
                == (oneShot && warmed), "only a warmed one-shot may freeze after native emission has stopped");
        }
    }

    private static void StopReleasesFrozenAndPendingEmitters()
    {
        foreach (var alreadyFrozen in new[] { false, true })
        {
            var rig = new DeadlineRig();
            var work = new StreamParticleWork { Pending = !alreadyFrozen };
            var frozen = new FrozenNodeStates<Node.ProcessModeEnum>();
            var mode = Node.ProcessModeEnum.Inherit;
            var restores = 0;
            if (alreadyFrozen)
            {
                frozen.Remember(42, mode);
                mode = Node.ProcessModeEnum.Disabled;
            }
            rig.Start(42, 1);
            rig.Timers[0].Fire(); // Removal was already dispatched when the managed stop arrived.
            var freezeRevision = work.Revision;
            rig.Frames.Enqueue(() =>
            {
                if (freezeRevision == work.Revision) mode = Node.ProcessModeEnum.Disabled;
            });
            void Restore() => CouchCoopStreamStaticParticles.RestoreSavedMode(frozen, 42, () => true, saved =>
            {
                mode = saved;
                restores++;
            });
            work.Stop(() => rig.Deadlines.Cancel(42), Restore, rig.Frames.Enqueue);
            Assert(!work.Pending && rig.Timers[0].Cancelled && restores == 0,
                "stop immediately invalidates pending work and the deadline while deferring native writes");
            rig.Timers[0].Fire();
            while (rig.Frames.Count > 0) rig.Frame();
            Assert(mode == Node.ProcessModeEnum.Inherit && restores == (alreadyFrozen ? 1 : 0)
                && frozen.Count == 0 && rig.Finished.Count == 0,
                "stop releases a frozen emitter once, leaves a pending emitter live and rejects stray work");
            work.Stop(() => rig.Deadlines.Cancel(42), Restore, rig.Frames.Enqueue);
            rig.Frame();
            Assert(restores == (alreadyFrozen ? 1 : 0), "a repeated stop cannot restore a saved mode twice");
        }
    }

    private static void RestartInvalidatesADeferredStop()
    {
        var work = new StreamParticleWork();
        Action? deferred = null;
        var restored = false;
        work.Stop(() => { }, () => restored = true, callback => deferred = callback);
        work.Invalidate(); // A newer start owns restoration and the next freeze sequence.
        deferred!();
        Assert(!restored, "a deferred stop cannot overwrite the state owned by a newer burst");
    }

    private sealed class ExitRig
    {
        internal readonly FrozenNodeStates<Node.ProcessModeEnum> Frozen = new();
        private readonly StreamParticleWork _work = new();
        private readonly Queue<Action> _frames = [];
        internal bool Valid = true;
        internal Node.ProcessModeEnum Mode = Node.ProcessModeEnum.Disabled;
        internal int Writes;

        internal ExitRig() => Frozen.Remember(42, Node.ProcessModeEnum.Inherit);
        internal void Exit()
        {
            _work.Invalidate();
            _frames.Enqueue(Cleanup);
        }
        internal void Frame() => _frames.Dequeue()();
        internal void Cleanup() => _work.Cleanup(() => CouchCoopStreamStaticParticles.RestoreSavedMode(
            Frozen, 42, () => Valid, Restore));
        internal void Deactivate() => Frozen.Restore((_, mode) => { if (Valid) Restore(mode); });
        private void Restore(Node.ProcessModeEnum mode)
        {
            Mode = mode;
            Writes++;
        }
    }

    private sealed class DeadlineRig
    {
        internal readonly List<FakeDeadline> Timers = [];
        internal readonly Queue<Action> Frames = [];
        internal readonly List<ulong> Finished = [];
        internal readonly StreamParticleDeadlines Deadlines;

        internal DeadlineRig() => Deadlines = new((delay, callback) =>
        {
            var timer = new FakeDeadline(delay, callback);
            Timers.Add(timer);
            return timer;
        }, Frames.Enqueue);

        internal void Start(ulong id, double delay) => Deadlines.Replace(id, delay, () => Finished.Add(id));
        internal void Frame() => Frames.Dequeue()();
    }

    private sealed class FakeDeadline(double delay, Action callback) : IDisposable
    {
        internal double Delay { get; } = delay;
        internal bool Cancelled;
        internal void Fire() => callback(); // Exercise token guards even when disconnect races with dispatch.
        public void Dispose() => Cancelled = true;
    }

    private static void Assert(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
        _assertions++;
    }
}
