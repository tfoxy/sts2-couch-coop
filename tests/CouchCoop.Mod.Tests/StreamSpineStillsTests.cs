using CouchCoop.Mod.Patches;
using CouchCoop.Mod.Session;
using Godot;
using Spirectl.Sts2.Live;
using Suspender = CouchCoop.Mod.Session.CouchCoopHeadlessVisualSuspender;

internal static class StreamSpineStillsTests
{
    public static void Run()
    {
        Assert(CouchCoopStreamSpineStills.ShouldFreeze(true, true), "armed + on freezes");
        Assert(!CouchCoopStreamSpineStills.ShouldFreeze(true, false), "armed + off stays live");
        Assert(!CouchCoopStreamSpineStills.ShouldFreeze(false, true), "disarm releases even when the preference is on");
        Assert(!CouchCoopStreamSpineStills.ShouldFreeze(false, false), "not armed stays on the old path");
        NewUnreadySpineStaysLive();
        FirstSuccessfulPoseFreezesTheNewSpine();
        ReadyNewSpineFreezesAndPosesImmediately();
        NewSpineSubtreeGetsExactlyOnePoseFrame();
        OriginallyDisabledSpriteStillGetsItsPoseFrame();
        ExemptPoseSubtreesAreUntouched();
        InterruptedPoseRefreezesTheCapturedSubtree();
        FailedPoseSchedulingRefreezesTheSubtree();
        IndependentStoresRestoreOriginalModes();
        ExemptionsMatchTheMirror();
        DeathDelayStillCapsWhileTheSuspenderIsDisabled();
        RepresentativePoseUsesTheSharedChooser();
        UnrecordedLoopUsesItsLiveMidpoint();
        UnrecordedPauseKeepsItsExactTime();
        NoLiveTrackLeavesTheNodeUntouched();
        RecordedScheduleWinsOverTheFreezeFallback();
        PoseFrameDropsCrossedEvents();
        PoseFrameRestoresAnExistingPauseAndSignalBlock();
        GameScaleChangesDuringTheFrameWin();
        FailedPoseRestoresTemporarySettings();
        AttackReturnsToIdleOnOneDeadline();
        NewScheduleCancelsThePriorDeadline();
        LoneOneShotRestsAtItsEnd();
        LoopsAndUnknownDurationsHaveNoDeadline();
        PausedTracksWaitForResume();
        DisarmCancelsEveryDeadline();
        DeferredDeadlineUsesTheNewestSchedule();
        QueuedClipSelectionIncludesTheSameAnimationName();
        Console.WriteLine("stream spine: 32 tests passed");
    }

    private static void NewUnreadySpineStaysLive()
    {
        var rig = new AdmissionRig();
        Assert(!rig.Pose(), "NodeAdded cannot freeze an uninitialised animation state");
        Assert(rig.Track.Processing && rig.Frozen.Count == 0 && rig.Finish is null,
            "an unready sprite and its subtree stay live, without a refreeze or retry callback");
    }

    private static void FirstSuccessfulPoseFreezesTheNewSpine()
    {
        var rig = new AdmissionRig();
        rig.Pose(); // Deferred NodeAdded, before the animation exists.
        rig.Ready = true; // The first recorded schedule queues another deferred pose.
        Assert(rig.Pose(), "the schedule-driven pose admits a node that was not frozen yet");
        rig.Track.Process(0.016f);
        rig.Finish!();
        Assert(rig.Track.PoseTime == 1 && !rig.Track.Processing && rig.Track.Delivered == 0,
            "the first ready track builds its sampled mesh before refreezing, without jump events");
        rig.Frozen.Restore((_, mode) => rig.Track.Processing = mode);
        Assert(rig.Track.Processing, "off restores the new node's original live mode");
    }

    private static void ReadyNewSpineFreezesAndPosesImmediately()
    {
        var rig = new AdmissionRig { Ready = true };
        Assert(rig.Pose() && rig.Frozen.Contains(42), "an already-ready new spine is admitted on its first pose");
        Assert(rig.Track.Processing && rig.Track.Scale == 0, "the admitted sprite gets its one native zero-delta frame");
        rig.Track.Process(0.016f);
        rig.Finish!();
        Assert(rig.Track.PoseTime == 1 && !rig.Track.Processing && rig.Track.Scale == 1,
            "ready spines retain the existing midpoint and restored playback scale");
    }

    private sealed class AdmissionRig
    {
        public readonly SignalTrack Track = new() { Processing = true };
        public readonly FrozenNodeStates<bool> Frozen = new();
        public bool Ready;
        public Action? Finish;

        public bool Pose() => StreamSpineFreezeAdmission.TryPose(() =>
        {
            if (!Ready) return null;
            var frame = Track.CreateFrame();
            return () => frame.Begin(Sts2SpineAnimationSchedules.ChooseSampleTime("idle", 2, null),
                value => Track.Time = value, Track.ConsumeJump, finish => Finish = finish);
        }, () =>
        {
            Frozen.Remember(42, Track.Processing);
            Track.Processing = false;
        });
    }

    private static void NewSpineSubtreeGetsExactlyOnePoseFrame()
    {
        var rig = new PoseSubtreeRig();
        rig.Pose();
        Assert(rig.Owned.All(node => node.Mode == Node.ProcessModeEnum.Always),
            "a new sprite and all its frozen mesh, slot and bone descendants get the pose frame");
        Assert(rig.Disabled.Mode == Node.ProcessModeEnum.Disabled && rig.Container.Writes == 0,
            "an originally disabled spine and non-spine intermediates stay untouched");
        rig.Tick();
        Assert(rig.Owned.All(node => node.Updates == 1), "mesh children get their first native update too");
        Assert(rig.NextFrame.Count == 1, "the whole subtree shares exactly one refreeze callback");
        rig.NextFrame.Dequeue()();
        rig.Tick();
        Assert(rig.Owned.All(node => node.Mode == Node.ProcessModeEnum.Disabled && node.Updates == 1),
            "every admitted spine refreezes after exactly one update");
        rig.Restore();
        Assert(rig.Owned.All(node => node.Mode == node.OriginalMode) && rig.Frozen.Count == 0,
            "off restores each original process mode, including inherited modes");
    }

    private static void OriginallyDisabledSpriteStillGetsItsPoseFrame()
    {
        var rig = new PoseSubtreeRig(Node.ProcessModeEnum.Disabled);
        rig.Pose();
        Assert(rig.Sprite.Mode == Node.ProcessModeEnum.Always && !rig.Frozen.Contains(rig.Sprite.Id),
            "an already-disabled sprite retains its pose frame without acquiring a saved live mode");
        rig.Tick();
        rig.NextFrame.Dequeue()();
        rig.Restore();
        Assert(rig.Sprite.Mode == Node.ProcessModeEnum.Disabled && rig.Sprite.Updates == 1,
            "off leaves an originally disabled sprite disabled after its pose update");
    }

    private static void ExemptPoseSubtreesAreUntouched()
    {
        var rig = new PoseSubtreeRig();
        foreach (var (type, name) in new[]
        {
            ("NVfxSpine", "Overlay"), ("SubViewport", "@Sts2OffscreenExtraction@3"),
        })
        {
            var exempt = new PoseNode(100 + (ulong)rig.Sprite.Children.Count, type, name, Node.ProcessModeEnum.Always);
            var mesh = new PoseNode(exempt.Id + 100, "SpineMesh2D", "Mesh", Node.ProcessModeEnum.Inherit);
            exempt.Children.Add(mesh);
            rig.Sprite.Children.Add(exempt);
            // Even a remembered id must not let the pose walk enter an exempt subtree.
            rig.Frozen.Remember(exempt.Id, exempt.Mode);
            rig.Frozen.Remember(mesh.Id, mesh.Mode);
        }
        rig.Pose();
        rig.NextFrame.Dequeue()();
        foreach (var exempt in rig.Sprite.Children.Where(node => node.Id >= 100))
            Assert(exempt.Writes == 0 && exempt.Children[0].Writes == 0,
                "VFX and extraction subtrees are untouched by thaw and refreeze");
    }

    private static void InterruptedPoseRefreezesTheCapturedSubtree()
    {
        var rig = new PoseSubtreeRig();
        rig.Pose();
        rig.Sprite.Children.Clear(); // A reparent during the frame must not strand a thawed mesh.
        rig.Frame!.Finish();
        Assert(rig.Owned.All(node => node.Mode == Node.ProcessModeEnum.Disabled),
            "off/disarm or a newer pose refreezes every node captured at Begin");
        rig.Restore();
        rig.NextFrame.Dequeue()();
        Assert(rig.Owned.All(node => node.Mode == node.OriginalMode),
            "a stale callback cannot overwrite the original modes restored by off/disarm");
    }

    private static void FailedPoseSchedulingRefreezesTheSubtree()
    {
        var rig = new PoseSubtreeRig();
        try
        {
            rig.Pose(_ => throw new InvalidOperationException("schedule failed"));
            throw new Exception("expected scheduling failure");
        }
        catch (InvalidOperationException) { rig.Frame!.Finish(); }
        Assert(rig.Owned.All(node => node.Mode == Node.ProcessModeEnum.Disabled),
            "a failure after thaw refreezes the whole subtree");
        rig.Restore();
        Assert(rig.Owned.All(node => node.Mode == node.OriginalMode), "failure preserves all saved modes");
    }

    private sealed class PoseNode(ulong id, string type, string name, Node.ProcessModeEnum mode)
    {
        public readonly ulong Id = id;
        public readonly string Type = type, Name = name;
        public readonly Node.ProcessModeEnum OriginalMode = mode;
        public Node.ProcessModeEnum Mode = mode;
        public readonly List<PoseNode> Children = [];
        public int Writes, Updates;
    }

    private sealed class PoseSubtreeRig
    {
        public readonly PoseNode Sprite;
        public readonly PoseNode Container = new(2, "Node2D", "Container", Node.ProcessModeEnum.Inherit);
        public readonly PoseNode Disabled = new(6, "SpineBoneNode", "Disabled", Node.ProcessModeEnum.Disabled);
        public readonly PoseNode[] Owned;
        public readonly FrozenNodeStates<Node.ProcessModeEnum> Frozen = new();
        public readonly Queue<Action> NextFrame = new();
        public StreamSpinePoseFrame? Frame;

        public PoseSubtreeRig(Node.ProcessModeEnum spriteMode = Node.ProcessModeEnum.Pausable)
        {
            Sprite = new(1, "SpineSprite", "Sprite", spriteMode);
            Owned = [Sprite,
                new(3, "SpineMesh2D", "Mesh", Node.ProcessModeEnum.Inherit),
                new(4, "SpineSlotNode", "Slot", Node.ProcessModeEnum.Always),
                new(5, "SpineBoneNode", "Bone", Node.ProcessModeEnum.WhenPaused)];
            Sprite.Children.Add(Container);
            Container.Children.Add(Owned[1]);
            Owned[1].Children.Add(Owned[2]);
            Owned[2].Children.Add(Owned[3]);
            Sprite.Children.Add(Disabled);
        }

        public void Pose(Action<Action>? nextFrame = null)
        {
            var subtree = new StreamSpinePoseSubtree<PoseNode>(Sprite, node => node.Children,
                node => Suspender.IsSpineFreezeExempt(node.Type, node.Name),
                node => node == Sprite || Frozen.Contains(node.Id), (node, processing) =>
                {
                    node.Mode = processing ? Node.ProcessModeEnum.Always : Node.ProcessModeEnum.Disabled;
                    node.Writes++;
                });
            Frame = new(false, 1, _ => { }, _ => { }, subtree.SetProcessing);
            StreamSpineFreezeAdmission.TryPose(() => () => Frame.Begin(1, _ => { }, () => { }, nextFrame ?? NextFrame.Enqueue),
                () =>
                {
                    foreach (var node in Owned)
                    {
                        if (node.Mode == Node.ProcessModeEnum.Disabled) continue;
                        Frozen.Remember(node.Id, node.Mode);
                        node.Mode = Node.ProcessModeEnum.Disabled;
                    }
                });
        }

        public void Tick()
        {
            foreach (var node in Owned)
                if (node.Mode == Node.ProcessModeEnum.Always) node.Updates++;
        }

        public void Restore() => Frozen.Restore((id, mode) => Owned.Single(node => node.Id == id).Mode = mode);
    }

    private static readonly Sts2SpineAnimationSchedules.Schedule Attack = new(42, "attack", false, 500, "idle", true, 1000);

    private static void AttackReturnsToIdleOnOneDeadline()
    {
        var rig = new DeadlineRig();
        rig.Pose();
        rig.Deadlines.Refresh(Attack, 1100, false);
        Assert(rig.Timers.Count == 1 && rig.Timers[0].Delay == 0.5, "one deadline uses the recorded end, independent of the sample time");
        Assert(rig.Animation == "attack" && rig.Track.PoseTime == 0.25f, "the attack starts as one midpoint pose");
        rig.Now = 1500;
        rig.Timers[0].Fire();
        Assert(rig.Animation == "attack" && rig.Queued.Count == 1, "the timeout defers all track reads and posing");
        rig.Queued.Dequeue()();
        Assert(rig.Animation == "idle" && rig.Track.PoseTime == 1, "the deadline poses the queued idle at its own midpoint");
        Assert(rig.Track.Delivered == 0 && !rig.Track.Processing, "neither the jump nor the return replays SFX/VFX or leaves processing enabled");
        rig.Timers[0].Fire();
        Assert(rig.Timers.Count == 1 && rig.Queued.Count == 0, "the deadline never repeats or reschedules a loop");
    }

    private static void NewScheduleCancelsThePriorDeadline()
    {
        var rig = new DeadlineRig();
        rig.Pose();
        var old = rig.Timers[0];
        rig.Schedule = Attack with { CurrentAnim = "hurt", StartedAtMsec = 1200 };
        rig.Now = 1250;
        rig.Pose();
        Assert(old.Cancelled && rig.Timers.Count == 2 && rig.Timers[1].Delay == 0.45, "a new schedule replaces, rather than duplicates, the deadline");
        old.Fire(); // A callback already dispatched before disconnect must also be harmless.
        Assert(rig.Queued.Count == 0, "a stale deadline cannot pose the superseded schedule");
        rig.Deadlines.Cancel(42); // The recorded hook cancels immediately, before the deferred pose.
        rig.Timers[1].Fire();
        Assert(rig.Timers[1].Cancelled && rig.Queued.Count == 0, "hook cancellation invalidates the replacement too");
    }

    private static void LoneOneShotRestsAtItsEnd()
    {
        var rig = new DeadlineRig { Schedule = Attack with { NextAnim = null } };
        rig.Pose();
        Assert(rig.Track.PoseTime == 0.25f && rig.Timers.Count == 1, "a lone one-shot initially uses its representative pose");
        rig.Now = 1500;
        rig.Timers[0].Fire();
        rig.Queued.Dequeue()();
        Assert(rig.Animation == "attack" && rig.Track.PoseTime == 0.5f, "a lone one-shot rests at its exact end after its deadline");
        rig.Now = 9000;
        rig.Pose();
        Assert(rig.Track.PoseTime == 0.5f && rig.Timers.Count == 1, "the rest is stable and creates no further deadlines");
    }

    private static void LoopsAndUnknownDurationsHaveNoDeadline()
    {
        var timers = new List<FakeDeadline>();
        var deadlines = new StreamSpineDeadlines((delay, fire) => AddTimer(timers, delay, fire), _ => { });
        foreach (var schedule in new[]
        {
            Attack with { CurrentLooping = true }, Attack with { CurrentDurMsec = 0, NextAnim = null },
            Attack with { CurrentDurMsec = double.NaN }, Attack with { CurrentDurMsec = double.PositiveInfinity },
        })
            deadlines.Refresh(schedule, 1000, false);
        Assert(timers.Count == 0, "loops and unresolved durations do not create speculative deadlines");
        var target = CouchCoopStreamSpineStills.ResolvePose(Attack with { CurrentDurMsec = 0 }, 1000, null);
        Assert(target.SelectReturn && target.Animation == "idle", "a zero-duration queued head resolves immediately, matching shared replay");
    }

    private static void PausedTracksWaitForResume()
    {
        var rig = new DeadlineRig();
        rig.Pose();
        rig.Now = 1200;
        rig.PausedTime = 0.125f;
        rig.Pose();
        Assert(rig.Timers[0].Cancelled && rig.Track.PoseTime == 0.125f, "a game pause cancels the deadline and preserves the exact track time");
        rig.Now = 5000;
        rig.Pose();
        Assert(rig.Animation == "attack" && rig.Track.PoseTime == 0.125f && rig.Timers.Count == 1, "a paused track never advances to the queued clip");
        rig.PausedTime = null;
        rig.Schedule = Attack with { StartedAtMsec = 4800 }; // The playback-scale hook reanchors on resume.
        rig.Pose();
        Assert(rig.Timers.Count == 2 && rig.Timers[1].Delay == 0.3, "resume schedules only the remaining recorded duration");
        rig.Now = 5300;
        rig.Timers[1].Fire();
        rig.Queued.Dequeue()();
        Assert(rig.Animation == "idle", "a resumed track returns only at its reanchored deadline");
    }

    private static void DisarmCancelsEveryDeadline()
    {
        var timers = new List<FakeDeadline>();
        var fired = 0;
        var deadlines = new StreamSpineDeadlines((delay, callback) => AddTimer(timers, delay, callback), _ => fired++);
        deadlines.Refresh(Attack, 1000, false);
        deadlines.Refresh(Attack with { InstanceId = 43 }, 1000, false);
        deadlines.Clear();
        foreach (var timer in timers) timer.Fire();
        Assert(timers.Count == 2 && timers.All(timer => timer.Cancelled) && fired == 0, "off/disarm cancels every node and rejects stale callbacks");
    }

    private static void DeferredDeadlineUsesTheNewestSchedule()
    {
        var rig = new DeadlineRig();
        rig.Pose();
        rig.Now = 1500;
        rig.Timers[0].Fire();
        rig.Schedule = Attack with { CurrentAnim = "hurt", StartedAtMsec = 1500 };
        rig.Queued.Dequeue()();
        Assert(rig.Animation == "hurt" && rig.Track.PoseTime == 0.25f, "a new schedule wins even after the old timeout queued a pose");
    }

    private static void QueuedClipSelectionIncludesTheSameAnimationName()
    {
        var target = CouchCoopStreamSpineStills.ResolvePose(Attack with { NextAnim = "attack" }, 1500, null);
        Assert(target.SelectReturn && target.Animation == "attack" && target.Looping, "a queued loop with the same name still replaces the one-shot track");
        var paused = CouchCoopStreamSpineStills.ResolvePose(Attack, 9000, 0);
        Assert(!paused.SelectReturn && paused.PinnedTime == 0, "a zero-time pause prevents even an overdue queued transition");
    }

    private static FakeDeadline AddTimer(List<FakeDeadline> timers, double delay, Action fire)
    {
        var timer = new FakeDeadline(delay, fire);
        timers.Add(timer);
        return timer;
    }

    private sealed class FakeDeadline(double delay, Action fire) : IDisposable
    {
        public double Delay { get; } = delay;
        public bool Cancelled { get; private set; }
        public void Fire() => fire(); // Deliberately bypass cancellation to exercise the production token guard.
        public void Dispose() => Cancelled = true;
    }

    private sealed class DeadlineRig
    {
        public readonly List<FakeDeadline> Timers = [];
        public readonly Queue<Action> Queued = [];
        public readonly SignalTrack Track = new();
        public readonly StreamSpineDeadlines Deadlines;
        public Sts2SpineAnimationSchedules.Schedule Schedule = Attack;
        public ulong Now = 1000;
        public float? PausedTime;
        public string Animation = "attack";

        public DeadlineRig() => Deadlines = new((delay, fire) => AddTimer(Timers, delay, fire), _ => Queued.Enqueue(Pose));

        public void Pose()
        {
            var target = CouchCoopStreamSpineStills.ResolvePose(Schedule, Now, PausedTime);
            if (!target.SelectReturn) Animation = Schedule.CurrentAnim;
            var frame = Track.CreateFrame();
            Action? finish = null;
            frame.Begin(() =>
            {
                if (target.SelectReturn)
                {
                    Animation = target.Animation!;
                    Assert(Track.Blocked, "selecting a queued clip suppresses its native start/interrupt signals too");
                }
                var duration = Animation == "idle" ? 2 : 0.5f;
                Track.Time = Sts2SpineAnimationSchedules.ChooseSampleTime(Animation, duration, target.PinnedTime);
            }, Track.ConsumeJump, callback => finish = callback);
            Track.Process(0.016f);
            finish!();
            Deadlines.Refresh(Schedule, Now, PausedTime is not null);
        }
    }

    private static void RepresentativePoseUsesTheSharedChooser()
    {
        foreach (var (clip, duration, paused, expected) in new (string, float, float?, float)[]
        {
            ("idle_loop", 2, null, 1), ("attack", 0.8f, null, 0.4f),
            ("die", 2, null, 2), ("boss_defeat", 3, null, 3),
            ("animation", 2, 0, 0), ("attack", 2, 0.375f, 0.375f),
            ("die", 2, 0.5f, 0.5f), ("attack", 2, 9, 2), ("idle", 0, null, 0),
        })
            Assert(Sts2SpineAnimationSchedules.ChooseSampleTime(clip, duration, paused) == expected,
                $"sample for {clip} (paused={paused}) is {expected}");
    }

    private static void UnrecordedLoopUsesItsLiveMidpoint()
    {
        var schedule = CouchCoopStreamSpineStills.ResolveFreezeSchedule(null, 42, 9000, ("idle", true, 2))!;
        Assert(schedule.CurrentLooping && schedule.NextAnim is null, "the freeze fallback describes only the live loop");
        var target = CouchCoopStreamSpineStills.ResolvePose(schedule, 9000, null);
        var sample = Sts2SpineAnimationSchedules.ChooseSampleTime(target.Animation!,
            (float)(schedule.CurrentDurMsec / 1000), target.PinnedTime);
        var track = new SignalTrack { Time = 0.125f };
        var frame = track.CreateFrame();
        Action? finish = null;
        frame.Begin(sample, value => track.Time = value, track.ConsumeJump, callback => finish = callback);
        track.Process(0.016f);
        finish!();
        Assert(track.PoseTime == 1 && !target.SelectReturn, "an unrecorded live loop is posed at its midpoint");
        Assert(track.Delivered == 0 && track.Updates == 1 && !track.Processing,
            "the fallback uses the same event suppression and one-frame refreeze");
    }

    private static void UnrecordedPauseKeepsItsExactTime()
    {
        var schedule = CouchCoopStreamSpineStills.ResolveFreezeSchedule(null, 42, 9000, ("idle", true, 2))!;
        var target = CouchCoopStreamSpineStills.ResolvePose(schedule, 9000, 0.375f);
        Assert(Sts2SpineAnimationSchedules.ChooseSampleTime(target.Animation!, 2, target.PinnedTime) == 0.375f,
            "an unrecorded game-paused track keeps its exact time");
    }

    private static void NoLiveTrackLeavesTheNodeUntouched()
    {
        Assert(CouchCoopStreamSpineStills.ResolveFreezeSchedule(null, 42, 9000, null) is null,
            "an unrecorded node without a live track has no pose to apply");
    }

    private static void RecordedScheduleWinsOverTheFreezeFallback()
    {
        var schedule = CouchCoopStreamSpineStills.ResolveFreezeSchedule(Attack, 42, 9000, ("idle", true, 2))!;
        Assert(schedule == Attack, "a later recorded schedule replaces the unrecorded freeze fallback");
        var target = CouchCoopStreamSpineStills.ResolvePose(schedule, 1500, null);
        Assert(target.SelectReturn && target.Animation == "idle", "the recorded queued transition still wins");
    }

    private static void PoseFrameDropsCrossedEvents()
    {
        var track = new SignalTrack();
        var frame = track.CreateFrame();
        var deferred = new Queue<Action>();
        frame.Begin(1, value => track.Time = value, track.ConsumeJump, deferred.Enqueue);
        Assert(track.Processing && track.Scale == 0 && !track.Blocked, "the native pose frame retains transform/mesh signals");
        track.Process(0.016f); // Crossing the SFX/VFX event at t=0.25 must not deliver it.
        Assert(track.Time == 1 && track.PoseTime == 1 && track.Delivered == 0, "the pose is exact and crossed events are dropped");
        Assert(deferred.Count == 1, "exactly one refreeze is scheduled");
        deferred.Dequeue()();
        Assert(!track.Processing && track.Scale == 1 && !track.Blocked, "refreeze restores temporary settings");
        track.Process(1);
        Assert(track.Updates == 1, "a frozen node does no further deformation");
        track.Processing = true; // OFF restores the live process mode.
        track.Process(0.016f);
        Assert(track.Delivered == 0, "thaw does not replay the event crossed by the pose jump");
        frame.Finish();
        Assert(track.Processing, "a stale refreeze callback cannot undo a completed thaw");
    }

    private static void PoseFrameRestoresAnExistingPauseAndSignalBlock()
    {
        var track = new SignalTrack { Blocked = true, Scale = 0 };
        var frame = track.CreateFrame();
        frame.Begin(0.375f, value => track.Time = value, track.ConsumeJump, _ => { });
        track.Process(1);
        frame.Finish();
        Assert(track.Blocked && track.Scale == 0 && track.PoseTime == 0.375f, "a pre-existing pause and signal block survive");
    }

    private static void GameScaleChangesDuringTheFrameWin()
    {
        var track = new SignalTrack();
        var frame = track.CreateFrame();
        frame.Begin(1, value => track.Time = value, track.ConsumeJump, _ => { });
        frame.RestoreTimeScale = 0; // The SetTimeScale hook delivers a game pause before refreeze.
        frame.Finish();
        Assert(track.Scale == 0, "a game pause during the frame is retained");
    }

    private static void FailedPoseRestoresTemporarySettings()
    {
        var track = new SignalTrack();
        var frame = track.CreateFrame();
        try
        {
            frame.Begin(1, _ => throw new InvalidOperationException("pose failed"), track.ConsumeJump, _ => { });
            throw new Exception("expected pose failure");
        }
        catch (InvalidOperationException) { frame.Finish(); }
        Assert(!track.Blocked && track.Scale == 1 && !track.Processing, "failure restores settings without enabling processing");
    }

    // A signal-emitting track exercises the production suppression lifetime without loading native Godot.
    private sealed class SignalTrack
    {
        public bool Blocked, Processing;
        public float Scale = 1, Time, PoseTime;
        public int Delivered, Updates;
        private float _lastTime;
        public StreamSpinePoseFrame CreateFrame() => new(Blocked, Scale,
            value => Blocked = value, value => Scale = value, value => Processing = value);

        public void Process(float delta)
        {
            if (!Processing) return;
            Updates++;
            Time += delta * Scale;
            ConsumeJump();
            PoseTime = Time;
        }

        public void ConsumeJump()
        {
            if (_lastTime < 0.25f && Time >= 0.25f && !Blocked) Delivered++;
            _lastTime = Time;
        }
    }

    private static void IndependentStoresRestoreOriginalModes()
    {
        var old = new FrozenNodeStates<Node.ProcessModeEnum>();
        var stream = new FrozenNodeStates<Node.ProcessModeEnum>();
        var mode = Node.ProcessModeEnum.Always;
        old.Remember(42, mode);
        mode = Node.ProcessModeEnum.Disabled;
        old.Restore((_, prior) => mode = prior); // Arm releases the old suspender first.
        foreach (var (armed, on) in new[] { (true, true), (true, false), (true, true), (false, true) })
        {
            if (CouchCoopStreamSpineStills.ShouldFreeze(armed, on))
            {
                stream.Remember(42, mode);
                mode = Node.ProcessModeEnum.Disabled;
            }
            else
            {
                stream.Restore((_, prior) => mode = prior);
                Assert(mode == Node.ProcessModeEnum.Always && stream.Count == 0, "off/disarm restores the exact mode");
            }
            Assert(old.Count == 0, "stream freeze does not repopulate the old renderer's store");
        }
    }

    private static void ExemptionsMatchTheMirror()
    {
        Assert(Suspender.IsSpineFreezeExempt("NVfxSpine", "Overlay"), "self-freeing overlays remain live");
        Assert(Suspender.IsSpineFreezeExempt("Node2D", Suspender.OffscreenExtractionNodeName), "offscreen extraction remains live");
        Assert(!Suspender.IsSpineFreezeExempt("Node2D", "SpineSprite"), "ordinary skeletons freeze");
    }

    private static void DeathDelayStillCapsWhileTheSuspenderIsDisabled()
    {
        var pending = new TaskCompletionSource().Task;
        foreach (var (armed, on) in new[] { (true, true), (true, false), (false, true), (false, false) })
        {
            var freeze = CouchCoopStreamSpineStills.ShouldFreeze(armed, on);
            Assert(HeadlessDeathDelayCapPatch.ShouldCapDelayTask(false, pending, streamSpinesFrozen: freeze) == freeze,
                "the stream freeze keeps the death-delay cap when the old suspender is disabled");
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"StreamSpineStillsTests: {message}");
    }
}
