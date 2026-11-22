using CouchCoop.Mod.Runtime;
using Godot;
using MegaCrit.Sts2.Core.Bindings.MegaSpine;
using Spirectl.Sts2.Live;

namespace CouchCoop.Mod.Session;

/// <summary>Event-driven spine freeze for an armed capture, independent of the mirror's suspender.</summary>
internal static class CouchCoopStreamSpineStills
{
    private static readonly FrozenNodeStates<Node.ProcessModeEnum> Frozen = new();
    private static readonly HashSet<ulong> Pending = [];
    private static readonly HashSet<ulong> PoseFailures = [];
    private static readonly Dictionary<ulong, StreamSpinePoseFrame> Frames = [];
    private static readonly Dictionary<ulong, float> PlaybackScales = [];
    private static readonly StreamSpineDeadlines Deadlines = new(ScheduleDeadline, QueuePose);
    private static ulong? _selectingAnimation;
    private static volatile bool _armed;
    private static volatile bool _active;
    private static SceneTree? _tree;
    private static int _generation;

    internal static bool IsActive => _active;
    internal static bool ShouldFreeze(bool armed, bool streamFreezeSpines) => armed && streamFreezeSpines;

    internal static Sts2SpineAnimationSchedules.Schedule? ResolveFreezeSchedule(
        Sts2SpineAnimationSchedules.Schedule? recorded, ulong id, ulong nowMsec,
        (string Animation, bool Looping, float Duration)? liveTrack)
    {
        if (recorded is not null) return recorded;
        return liveTrack is { } track
            ? new(id, track.Animation, track.Looping, track.Duration * 1000d, null, false, nowMsec)
            : null;
    }

    internal static (string? Animation, bool Looping, bool SelectReturn, float? PinnedTime) ResolvePose(
        Sts2SpineAnimationSchedules.Schedule schedule, ulong nowMsec, float? pausedTime)
    {
        var resolved = Sts2SpineAnimationSchedules.ResolveAt(schedule, nowMsec);
        var selectReturn = pausedTime is null && !schedule.CurrentLooping && schedule.NextAnim is not null
            && Math.Max(0, (double)nowMsec - schedule.StartedAtMsec) >= schedule.CurrentDurMsec;
        return (resolved.Anim, resolved.Looping, selectReturn,
            pausedTime ?? (resolved.Paused ? (float)resolved.TrackTime : null));
    }

    // Capture transitions already run on the main thread; preference changes may arrive from a browser thread.
    internal static void SetArmed(bool armed)
    {
        _armed = armed;
        if (armed)
        {
            if (!CouchCoopHeadlessVisualSuspender.StreamFreezeSpines) return;
            // Arming arrives inside a capture signal. Defer the initial tree read by one frame too.
            if (Engine.GetMainLoop() is SceneTree tree)
                GameDeferred.Register(() => tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(ReconcileOnMainThread),
                    (uint)GodotObject.ConnectFlags.OneShot));
        }
        else Reconcile();
    }

    internal static void Reconcile()
    {
        if (!_armed && !_active) return;
        if (OS.GetThreadCallerId() == OS.GetMainThreadId()) ReconcileOnMainThread();
        else GameDeferred.Post(ReconcileOnMainThread);
    }

    private static void ReconcileOnMainThread()
    {
        var freeze = ShouldFreeze(_armed, CouchCoopHeadlessVisualSuspender.StreamFreezeSpines);
        if (freeze == _active) return;
        _generation++;
        if (!freeze)
        {
            _active = false;
            Sts2SpineAnimationSchedules.Recorded -= OnScheduleRecorded;
            Sts2SpineAnimationSchedules.PlaybackScaleChanged -= OnPlaybackScaleChanged;
            Pending.Clear();
            PoseFailures.Clear();
            Deadlines.Clear();
            PlaybackScales.Clear();
            foreach (var id in Frames.Keys.ToArray()) FinishPose(id);
            if (_tree is { } tree && GodotObject.IsInstanceValid(tree)) tree.NodeAdded -= OnNodeAdded;
            _tree = null;
            CouchCoopHeadlessVisualSuspender.Unfreeze(Frozen);
            return;
        }

        if (Engine.GetMainLoop() is not SceneTree sceneTree) return;
        _tree = sceneTree;
        _active = true;
        // A frozen skeleton cannot deliver animation events owed by a death sequence. Keep the same cap as
        // the mirror freeze, even while the rest of that suspender is disabled for capture.
        Patches.HeadlessDeathDelayCapPatch.Apply();
        sceneTree.NodeAdded += OnNodeAdded;
        Sts2SpineAnimationSchedules.Recorded += OnScheduleRecorded;
        Sts2SpineAnimationSchedules.PlaybackScaleChanged += OnPlaybackScaleChanged;
        QueueSpines(sceneTree.Root);
    }

    private static void OnNodeAdded(Node node)
    {
        var generation = _generation;
        // Defer every node read out of the signal by one frame. New skeletons are caught by tree notifications,
        // without extending the mirror suspender's existing periodic scans to capture mode.
        GameDeferred.Register(() => _tree?.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(() =>
        {
            if (!_active || generation != _generation || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree()) return;
            for (Node? ancestor = node; ancestor is not null; ancestor = ancestor.GetParent())
            {
                if (CouchCoopHeadlessVisualSuspender.IsSpineFreezeExempt(ancestor.GetType().Name, ancestor.Name.ToString())) return;
            }
            QueueSpines(node);
        }), (uint)GodotObject.ConnectFlags.OneShot));
    }

    private static void OnScheduleRecorded(Sts2SpineAnimationSchedules.Schedule schedule)
    {
        // Selecting a recorded return also passes through the direct-animation hook. It is already being posed.
        if (_selectingAnimation == schedule.InstanceId) return;
        Deadlines.Cancel(schedule.InstanceId);
        QueuePose(schedule.InstanceId);
    }

    private static void OnPlaybackScaleChanged(ulong id, float scale)
    {
        // Only bookkeeping in the hook: a game pause/resume during the pose frame owns the restored scale.
        if (Frames.TryGetValue(id, out var frame)) frame.RestoreTimeScale = scale;
        if (PlaybackScales.TryGetValue(id, out var prior) && prior == scale) return;
        Deadlines.Cancel(id);
        PlaybackScales[id] = scale;
        QueuePose(id);
    }

    private static void QueueSpines(Node root)
    {
        if (CouchCoopHeadlessVisualSuspender.IsSpineFreezeExempt(root.GetType().Name, root.Name.ToString())) return;
        // Admission only queues a pose. Disabling an unready sprite (or its bones/slots) prevents its first mesh.
        if (root.IsClass("SpineSprite")) QueuePose(root.GetInstanceId());
        foreach (var child in root.GetChildren()) QueueSpines(child);
    }

    private static void QueuePose(ulong id)
    {
        if (!_active || !Pending.Add(id)) return;
        var generation = _generation;
        GameDeferred.Register(() => _tree?.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(() =>
        {
            if (!_active || generation != _generation) return;
            Pending.Remove(id);
            FinishPose(id);
            Pose(id);
        }), (uint)GodotObject.ConnectFlags.OneShot));
    }

    private static void Pose(ulong id)
    {
        if (GodotObject.InstanceFromId(id) is not Node node || !node.IsInsideTree() || !node.IsClass("SpineSprite")) return;
        for (Node? ancestor = node; ancestor is not null; ancestor = ancestor.GetParent())
        {
            if (CouchCoopHeadlessVisualSuspender.IsSpineFreezeExempt(ancestor.GetType().Name, ancestor.Name.ToString())) return;
        }
        try
        {
            StreamSpineFreezeAdmission.TryPose(() => PreparePose(node, id),
                () => CouchCoopHeadlessVisualSuspender.FreezeAllSpine(node, Frozen));
        }
        catch (Exception exception)
        {
            FinishPose(id);
            Deadlines.Cancel(id);
            LogPoseFailure(id, $"{exception.GetType().Name}: {exception.Message}");
        }
    }

    private static Action? PreparePose(Node node, ulong id)
    {
        var recorded = Sts2SpineAnimationSchedules.ReadRecorded(id);
        var sprite = new MegaSprite(node);
        // get_current is unsafe on an uninitialised native state. Only read a ready track.
        if (!sprite.IsAnimationStateReady()) return PoseNotReady(id, "animation state is not ready");
        var state = sprite.GetAnimationState();
        var skeleton = sprite.GetSkeleton();
        if (skeleton is null) return PoseNotReady(id, "skeleton is not ready");
#if STS2_API_V111_OR_LATER
        using var entry = state.GetCurrent(0);
#else
        var entry = state.GetCurrent(0);
#endif
        if (entry is null) return PoseNotReady(id, "animation track is empty");
        var scale = state.BoundObject.Call("get_time_scale").AsSingle();
        PlaybackScales[id] = scale;
        var paused = scale == 0 || entry.BoundObject.Call("get_time_scale").AsSingle() == 0;
        var nowMsec = Time.GetTicksMsec();
        // A freeze notification can precede any animation hook (for example an authored map icon).
        // Read its live track once here; this local fallback is never published or used for deadlines.
        var schedule = ResolveFreezeSchedule(recorded, id, nowMsec, recorded is null
            ? (entry.GetAnimationName(), entry.BoundObject.Call("get_loop").AsBool(), entry.GetAnimationDuration()) : null)!;
        var target = ResolvePose(schedule, nowMsec, paused ? entry.GetTrackTime() : null);

        // Consume the jump with sprite signals blocked, through the game's typed wrappers. The following
        // zero-delta native frame advances the event cursor and updates meshes at the exact sample time.
        // Its transform/mesh signals stay enabled; only the synthetic jump suppresses SFX/VFX events.
        var subtree = new StreamSpinePoseSubtree<Node>(node, parent => parent.GetChildren(),
            child => CouchCoopHeadlessVisualSuspender.IsSpineFreezeExempt(child.GetType().Name, child.Name.ToString()),
            child => child == node || Frozen.Contains(child.GetInstanceId()),
            (child, processing) =>
            {
                if (GodotObject.IsInstanceValid(child))
                    child.ProcessMode = processing ? Node.ProcessModeEnum.Always : Node.ProcessModeEnum.Disabled;
            });
        var frame = new StreamSpinePoseFrame(node.IsBlockingSignals(), scale,
            blocked => { if (GodotObject.IsInstanceValid(node)) node.SetBlockSignals(blocked); },
            value =>
            {
                if (GodotObject.IsInstanceValid(node) && GodotObject.IsInstanceValid(state.BoundObject))
                    state.BoundObject.Call("set_time_scale", value);
            },
            subtree.SetProcessing);
        return () =>
        {
            Frames[id] = frame;
            // ProcessFrame precedes native node processing. The next signal refreezes after exactly one update.
            frame.Begin(() =>
            {
                if (target.SelectReturn)
                {
                    // Use the game's wrapper, with signals already muted, to select the recorded queued clip.
                    _selectingAnimation = id;
                    try { state.SetAnimation(target.Animation!, target.Looping, 0); }
                    finally { _selectingAnimation = null; }
                }
#if STS2_API_V111_OR_LATER
                using var current = state.GetCurrent(0);
#else
                var current = state.GetCurrent(0);
#endif
                if (current is null) throw new InvalidOperationException("No track after selecting the recorded animation.");
                var sample = Sts2SpineAnimationSchedules.ChooseSampleTime(
                    current.GetAnimationName(), current.GetAnimationDuration(), target.PinnedTime);
                // Remove crossfade weights so this animation supplies the sampled pose.
                current.SetMixDuration(0);
                current.SetTrackTime(sample);
            }, () => { state.Update(0); state.Apply(skeleton); }, finish => GameDeferred.Register(() => _tree!.Connect(
                SceneTree.SignalName.ProcessFrame, Callable.From(() =>
            {
                if (Frames.GetValueOrDefault(id) == frame) Frames.Remove(id);
                try { finish(); } // Idempotent after off/disarm or a newer pose.
                catch (Exception exception)
                {
                    CouchCoopLog.Info($"[stream-spine] restore failed for {id}: {exception.GetType().Name}: {exception.Message}");
                }
            }), (uint)GodotObject.ConnectFlags.OneShot)));
            if (Sts2SpineAnimationSchedules.ReadRecorded(id) is { } latest)
                Deadlines.Refresh(latest, Time.GetTicksMsec(), paused);
        };
    }

    private static Action? PoseNotReady(ulong id, string reason)
    {
        LogPoseFailure(id, reason);
        // Stay live. A recorded animation schedules another attempt, with all reads deferred by one frame.
        return null;
    }

    private static void LogPoseFailure(ulong id, string reason)
    {
        if (PoseFailures.Add(id)) CouchCoopLog.Info($"[stream-spine] pose failed for {id}: {reason}");
    }

    private static void FinishPose(ulong id)
    {
        if (!Frames.Remove(id, out var frame)) return;
        try { frame.Finish(); }
        catch (Exception exception)
        {
            CouchCoopLog.Info($"[stream-spine] restore failed for {id}: {exception.GetType().Name}: {exception.Message}");
        }
    }

    private static IDisposable ScheduleDeadline(double delaySeconds, Action callback)
    {
        // This is a deadline derived from the SetNextState hook's schedule, not a poll. The maintainer approved
        // this specific one-shot exception; the timeout queues a pose and all game reads wait until next frame.
        return GameDeferred.Delay(_tree!, delaySeconds, callback);
    }


}

/// <summary>At most one cancellable end-of-clip deadline per recorded, running one-shot.</summary>
internal sealed class StreamSpineDeadlines(Func<double, Action, IDisposable> scheduleDeadline, Action<ulong> queuePose)
{
    private sealed class PendingDeadline(Sts2SpineAnimationSchedules.Schedule schedule)
    {
        internal readonly Sts2SpineAnimationSchedules.Schedule Schedule = schedule;
        internal IDisposable? Timer;
    }

    private readonly Dictionary<ulong, PendingDeadline> _pending = [];

    internal void Refresh(Sts2SpineAnimationSchedules.Schedule schedule, ulong nowMsec, bool paused)
    {
        var elapsed = Math.Max(0, (double)nowMsec - schedule.StartedAtMsec);
        var remaining = schedule.CurrentDurMsec - elapsed;
        if (paused || schedule.CurrentLooping || !double.IsFinite(remaining) || remaining <= 0)
        {
            Cancel(schedule.InstanceId);
            return;
        }
        if (_pending.TryGetValue(schedule.InstanceId, out var prior) && prior.Schedule == schedule) return;
        Cancel(schedule.InstanceId);
        var pending = new PendingDeadline(schedule);
        _pending[schedule.InstanceId] = pending;
        try
        {
            pending.Timer = scheduleDeadline(remaining / 1000, () =>
            {
                if (_pending.GetValueOrDefault(schedule.InstanceId) != pending) return;
                Cancel(schedule.InstanceId);
                queuePose(schedule.InstanceId);
            });
        }
        catch
        {
            Cancel(schedule.InstanceId);
            throw;
        }
    }

    internal void Cancel(ulong id)
    {
        if (_pending.Remove(id, out var pending)) pending.Timer?.Dispose();
    }

    internal void Clear()
    {
        foreach (var id in _pending.Keys.ToArray()) Cancel(id);
    }
}

/// <summary>Give a frozen spine subtree one pose update without changing its saved modes.</summary>
internal sealed class StreamSpinePoseSubtree<TNode>(
    TNode root, Func<TNode, IEnumerable<TNode>> children, Func<TNode, bool> exempt,
    Func<TNode, bool> frozen, Action<TNode, bool> setProcessing)
{
    private readonly List<TNode> _nodes = [];

    internal void SetProcessing(bool processing)
    {
        // Admission freezes before Begin, so collect here. Keep that same set for refreeze even if reparented.
        if (processing) Collect(root);
        foreach (var node in _nodes) setProcessing(node, processing);
        if (!processing) _nodes.Clear();
    }

    private void Collect(TNode node)
    {
        if (exempt(node)) return;
        if (frozen(node)) _nodes.Add(node);
        foreach (var child in children(node)) Collect(child);
    }
}

/// <summary>The temporary settings owned by one pose update; also restored on off/disarm or failure.</summary>
internal sealed class StreamSpinePoseFrame(
    bool signalsBlocked, float timeScale, Action<bool> blockSignals, Action<float> setTimeScale,
    Action<bool> setProcessing)
{
    private bool _finished;
    internal float RestoreTimeScale { get; set; } = timeScale;

    internal void Begin(float sample, Action<float> setTrackTime, Action consumeJump, Action<Action> nextFrame)
        => Begin(() => setTrackTime(sample), consumeJump, nextFrame);

    internal void Begin(Action preparePose, Action consumeJump, Action<Action> nextFrame)
    {
        blockSignals(true);
        try
        {
            setTimeScale(0);
            preparePose();
            consumeJump();
        }
        finally { blockSignals(signalsBlocked); }
        setProcessing(true);
        nextFrame(Finish);
    }

    internal void Finish()
    {
        if (_finished) return;
        _finished = true;
        try { setProcessing(false); }
        finally { setTimeScale(RestoreTimeScale); }
    }
}

/// <summary>Admit a spine to the freeze only after its track can supply a pose.</summary>
internal static class StreamSpineFreezeAdmission
{
    internal static bool TryPose(Func<Action?> preparePose, Action freeze)
    {
        if (preparePose() is not { } pose) return false;
        freeze();
        pose();
        return true;
    }
}
