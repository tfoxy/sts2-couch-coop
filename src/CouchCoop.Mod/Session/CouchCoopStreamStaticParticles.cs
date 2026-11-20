using Godot;

namespace CouchCoop.Mod.Session;

/// <summary>Event-driven CPU particle stills for a capture whose pages unanimously opt in.</summary>
public static class CouchCoopStreamStaticParticles
{
    private static readonly FrozenNodeStates<Node.ProcessModeEnum> Frozen = new();
    private static readonly Dictionary<CpuParticles2D, Emitter> Emitters = new(ReferenceEqualityComparer.Instance);
    private static readonly Dictionary<CpuParticles2D, object> PendingStarts = new(ReferenceEqualityComparer.Instance);
    private static readonly HashSet<Callable> DeferredFrames = [];
    private static readonly StreamParticleDeadlines Deadlines = new(ScheduleDeadline, NextFrame);
    private const double FinishMarginSeconds = 0.25;
    [ThreadStatic] private static bool _updatingEmitter;
    private static volatile bool _armed;
    private static volatile bool _desired;
    private static volatile bool _active;
    private static volatile SceneTree? _tree;
    private static int _generation;

    // Public because the reloadable server calls the process-wide session owner in the mod assembly.
    public static void SetDesired(bool desired)
    {
        if (_desired == desired) return;
        _desired = desired;
        Reconcile();
    }

    internal static void SetArmed(bool armed)
    {
        _armed = armed;
        Reconcile();
    }

    internal static bool ShouldFreeze(bool armed, bool desired) => armed && desired;

    internal static double ActiveTimeSeconds(double lifetime, double explosiveness)
    {
        var active = lifetime * (2 - explosiveness);
        return double.IsFinite(active) ? Math.Max(0, active) : 0;
    }

    // A one-shot is caught at half a particle lifetime (shortened by lifetime randomness), never later than half
    // its active window. Half the active window alone can equal a whole particle lifetime for a spread burst, which
    // would freeze a single-particle burst after its only particle died.
    internal static double WarmupSeconds(bool oneShot, double lifetime, double explosiveness, double lifetimeRandomness = 0)
    {
        if (!double.IsFinite(lifetime) || lifetime <= 0) return 0;
        if (!oneShot) return lifetime;
        var randomness = double.IsFinite(lifetimeRandomness) ? Math.Clamp(lifetimeRandomness, 0, 1) : 0;
        var particleMid = lifetime * Math.Min(0.5, 0.9 * (1 - randomness));
        return Math.Max(0, Math.Min(ActiveTimeSeconds(lifetime, explosiveness) / 2, particleMid));
    }

    // Simulated seconds left in a one-shot's active window after its warmup.
    internal static double RemainingSeconds(double lifetime, double explosiveness, double lifetimeRandomness = 0)
        => Math.Max(0, ActiveTimeSeconds(lifetime, explosiveness)
            - WarmupSeconds(true, lifetime, explosiveness, lifetimeRandomness));

    internal static double RemovalDelaySeconds(double lifetime, double explosiveness, double speedScale,
        double lifetimeRandomness = 0)
    {
        var remaining = RemainingSeconds(lifetime, explosiveness, lifetimeRandomness) / Math.Max(speedScale, 0.001);
        return double.IsFinite(remaining) ? Math.Clamp(remaining, 0.5, 10) : 0.5;
    }

    internal static bool CanFreeze(bool insideTree, bool emitting, bool visible, Node.ProcessModeEnum ownMode,
        bool canProcess, bool exempt, bool oneShot, bool warmed)
        => insideTree && (emitting || (warmed && oneShot)) && visible
            && ownMode != Node.ProcessModeEnum.Disabled && canProcess && !exempt;

    private static bool CanFreeze(CpuParticles2D node, bool oneShot, bool warmed)
    {
        if (!node.IsInsideTree()) return false;
        return CanFreeze(true, node.Emitting, node.IsVisibleInTree(), node.ProcessMode, node.CanProcess(),
            IsExempt(node), oneShot, warmed);
    }

    internal static void RestoreSavedMode(FrozenNodeStates<Node.ProcessModeEnum> frozen, ulong id,
        Func<bool> isValid, Action<Node.ProcessModeEnum> restore)
    {
        if (frozen.TryRemove(id, out var mode) && isValid()) restore(mode);
    }

    private static void Reconcile()
    {
        if (!CouchCoopMod.EngineAvailable || (!ShouldFreeze(_armed, _desired) && !_active && _tree is null)) return;
        // Arming can arrive in a capture signal; the initial walk always waits a full frame.
        Callable.From(() =>
        {
            if (!ShouldFreeze(_armed, _desired)) Deactivate();
            else if (!_active && Engine.GetMainLoop() is SceneTree tree)
            {
                _tree = tree;
                NextFrame(Activate);
            }
        }).CallDeferred();
    }

    private static void Activate()
    {
        if (_active || !ShouldFreeze(_armed, _desired) || _tree is null) return;
        if (!Patches.StreamStaticParticleStartPatch.Apply()) return;
        _active = true;
        _tree.NodeAdded += OnNodeAdded;
        Walk(_tree.Root);
        // The walk's requests need an internal process before the buffers can be held.
        NextFrame(() => NextFrame(() => LogTransition("active")));
    }

    private static void Deactivate()
    {
        if (_active) LogTransition("inactive");
        _active = false;
        _generation++;
        if (_tree is { } tree && GodotObject.IsInstanceValid(tree))
        {
            tree.NodeAdded -= OnNodeAdded;
            foreach (var callback in DeferredFrames) tree.Disconnect(SceneTree.SignalName.ProcessFrame, callback);
        }
        DeferredFrames.Clear();
        Deadlines.Clear();
        PendingStarts.Clear();
        foreach (var emitter in Emitters.Values) emitter.Disconnect();
        Emitters.Clear();
        CouchCoopHeadlessVisualSuspender.Unfreeze(Frozen);
        _tree = null;
    }

    private static void LogTransition(string transition)
        => CouchCoopLog.Info($"[stream-particles] {transition}: frozen loopers={Emitters.Values.Count(e => e.Frozen && !e.OneShot)}, "
            + $"one-shots={Emitters.Values.Count(e => e.Frozen && e.OneShot)}");

    private static void NextFrame(Action action)
    {
        if (_tree is null) return;
        var generation = _generation;
        Callable callback = default;
        callback = Callable.From(() =>
        {
            DeferredFrames.Remove(callback);
            if (generation == _generation) action();
        });
        DeferredFrames.Add(callback);
        _tree.Connect(SceneTree.SignalName.ProcessFrame, callback, (uint)GodotObject.ConnectFlags.OneShot);
    }

    private static void OnNodeAdded(Node node)
        => NextFrame(() =>
        {
            if (_active && GodotObject.IsInstanceValid(node) && node.IsInsideTree() && !IsExempt(node)) Walk(node);
        });

    internal static void NotifyStarted(CpuParticles2D node)
    {
        if (!_active || !ShouldFreeze(_armed, _desired) || _updatingEmitter) return;
        // The hook only invalidates managed work; every emitter read waits until the next frame.
        if (Emitters.TryGetValue(node, out var emitter))
        {
            if (!emitter.OneShot) return;
            emitter.Invalidate();
            Deadlines.Cancel(emitter.Id);
        }
        var token = new object();
        PendingStarts[node] = token;
        var startedAt = System.Environment.TickCount64;
        NextFrame(() =>
        {
            if (!PendingStarts.TryGetValue(node, out var pending) || pending != token) return;
            PendingStarts.Remove(node);
            if (!_active || !GodotObject.IsInstanceValid(node) || !node.IsInsideTree() || !node.OneShot || IsExempt(node)) return;
            var current = Track(node);
            current.Invalidate();
            Deadlines.Cancel(current.Id);
            Restore(current);
            current.Retired = false;
            current.StartedAtMsec = startedAt;
            QueueFreeze(current);
        });
    }

    internal static void NotifyStopped(CpuParticles2D node)
    {
        if (!_active || !ShouldFreeze(_armed, _desired) || _updatingEmitter) return;
        PendingStarts.Remove(node);
        if (!Emitters.TryGetValue(node, out var emitter)) return;
        emitter.Stop(() => Deadlines.Cancel(emitter.Id), () =>
        {
            if (_active && !emitter.Exited) Restore(emitter);
        }, NextFrame);
    }

    private static bool IsExempt(Node node)
    {
        for (Node? ancestor = node; ancestor is not null; ancestor = ancestor.GetParent())
            if (CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot(ancestor.GetType().Name)
                || CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(ancestor.Name.ToString())) return true;
        return false;
    }

    private static void Walk(Node node)
    {
        if (CouchCoopHeadlessVisualSuspender.IsParticleFreezeExemptSubtreeRoot(node.GetType().Name)
            || CouchCoopHeadlessVisualSuspender.IsOffscreenExtractionSubtreeRoot(node.Name.ToString())) return;
        if (node is CpuParticles2D { Emitting: true } particles)
        {
            if (!PendingStarts.ContainsKey(particles)) QueueFreeze(Track(particles));
        }
        foreach (var child in node.GetChildren()) Walk(child);
    }

    private static Emitter Track(CpuParticles2D node)
    {
        if (Emitters.TryGetValue(node, out var emitter))
        {
            if (!emitter.Exited) return emitter;
            emitter.CleanupExited();
        }
        emitter = new Emitter(node);
        Emitters.Add(node, emitter);
        node.VisibilityChanged += emitter.VisibilityChanged;
        node.TreeExiting += emitter.TreeExiting;
        return emitter;
    }

    private static void QueueFreeze(Emitter emitter)
    {
        var node = emitter.Node;
        if (!_active || !ShouldFreeze(_armed, _desired) || emitter.Exited || emitter.Pending || emitter.Frozen || emitter.Retired
            || !GodotObject.IsInstanceValid(node) || !CanFreeze(node, emitter.OneShot, warmed: false)) return;
        emitter.Pending = true;
        emitter.OneShot = node.OneShot;
        var revision = emitter.Revision;
        var warmup = WarmupSeconds(node.OneShot, node.Lifetime, node.Explosiveness, node.LifetimeRandomness);
        _updatingEmitter = true;
        try { node.RequestParticlesProcess((float)warmup); }
        finally { _updatingEmitter = false; }
        if (emitter.OneShot)
        {
            var delay = RemovalDelaySeconds(node.Lifetime, node.Explosiveness, node.SpeedScale, node.LifetimeRandomness);
            var remaining = RemainingSeconds(node.Lifetime, node.Explosiveness, node.LifetimeRandomness);
            var elapsedSinceStart = emitter.StartedAtMsec is { } startedAt
                ? Math.Max(0, System.Environment.TickCount64 - startedAt) / 1000d : 0;
            Deadlines.Replace(emitter.Id, Math.Max(0, delay - elapsedSinceStart), () => FinishBurst(emitter, remaining));
        }
        NextFrame(() => NextFrame(() =>
        {
            if (revision != emitter.Revision) return;
            emitter.Pending = false;
            // A prepared burst can stop emitting during warmup while its particles are still alive.
            if (!_active || !ShouldFreeze(_armed, _desired) || emitter.Exited || !GodotObject.IsInstanceValid(node)
                || !CanFreeze(node, emitter.OneShot, warmed: true)) return;
            if (Frozen.Remember(node.GetInstanceId(), node.ProcessMode))
            {
                node.ProcessMode = Node.ProcessModeEnum.Disabled;
                emitter.Frozen = true;
            }
        }));
    }

    private static void Restore(Emitter emitter)
    {
        var updating = _updatingEmitter;
        _updatingEmitter = true;
        try
        {
            RestoreSavedMode(Frozen, emitter.Id, () => GodotObject.IsInstanceValid(emitter.Node),
                mode => emitter.Node.ProcessMode = mode);
            emitter.Frozen = false;
        }
        finally { _updatingEmitter = updating; }
    }

    private static void FinishBurst(Emitter emitter, double remaining)
    {
        emitter.Invalidate();
        emitter.Retired = true;
        var node = emitter.Node;
        if (!_active || !ShouldFreeze(_armed, _desired) || emitter.Exited || !GodotObject.IsInstanceValid(node)
            || !node.IsInsideTree()) return;
        _updatingEmitter = true;
        try
        {
            Restore(emitter);
            // Let Godot clear the buffer and deliver its own finished signal on the next internal process.
            node.RequestParticlesProcess((float)(remaining + FinishMarginSeconds));
        }
        finally { _updatingEmitter = false; }
    }

    private static IDisposable ScheduleDeadline(double delaySeconds, Action callback)
    {
        var timer = _tree!.CreateTimer(delaySeconds, ignoreTimeScale: true);
        var callable = Callable.From(callback);
        timer.Connect(SceneTreeTimer.SignalName.Timeout, callable, (uint)GodotObject.ConnectFlags.OneShot);
        return new DeadlineCancellation(timer, callable);
    }

    private sealed class DeadlineCancellation(SceneTreeTimer timer, Callable callback) : IDisposable
    {
        public void Dispose()
        {
            if (GodotObject.IsInstanceValid(timer) && timer.IsConnected(SceneTreeTimer.SignalName.Timeout, callback))
                timer.Disconnect(SceneTreeTimer.SignalName.Timeout, callback);
        }
    }

    private sealed class Emitter(CpuParticles2D node) : StreamParticleWork
    {
        internal ulong Id { get; } = node.GetInstanceId();
        internal CpuParticles2D Node { get; } = node;
        internal bool Frozen;
        internal bool OneShot = node.OneShot;
        internal bool Exited;
        internal bool Retired;
        internal long? StartedAtMsec;

        internal void VisibilityChanged() => NextFrame(() => QueueFreeze(this));

        internal void TreeExiting()
        {
            // Only bookkeeping in the signal. Native subscriptions are released outside it.
            Exited = true;
            Invalidate();
            Deadlines.Cancel(Id);
            PendingStarts.Remove(Node);
            NextFrame(CleanupExited);
        }

        internal void CleanupExited() => Cleanup(() =>
            {
                Restore(this);
                Emitters.Remove(Node);
                Disconnect();
            });

        internal void Disconnect()
        {
            if (!GodotObject.IsInstanceValid(Node)) return;
            Node.VisibilityChanged -= VisibilityChanged;
            Node.TreeExiting -= TreeExiting;
        }
    }
}

/// <summary>Invalidates deferred freeze work before stops or exits release the saved mode.</summary>
internal class StreamParticleWork
{
    internal int Revision;
    internal bool Pending;
    private bool _cleanedUp;

    internal void Invalidate()
    {
        Revision++;
        Pending = false;
    }

    internal void Stop(Action cancelDeadline, Action restore, Action<Action> nextFrame)
    {
        Invalidate();
        cancelDeadline();
        var revision = Revision;
        nextFrame(() =>
        {
            if (revision == Revision) restore();
        });
    }

    internal void Cleanup(Action cleanup)
    {
        if (_cleanedUp) return;
        _cleanedUp = true;
        cleanup();
    }
}

/// <summary>One removal deadline per burst, invalidated even after its timeout queued a frame callback.</summary>
internal sealed class StreamParticleDeadlines(Func<double, Action, IDisposable> schedule, Action<Action> nextFrame)
{
    private sealed class PendingDeadline
    {
        internal IDisposable? Timer;
        internal bool Queued;
    }

    private readonly Dictionary<ulong, PendingDeadline> _pending = [];

    internal void Replace(ulong id, double delaySeconds, Action finish)
    {
        Cancel(id);
        var pending = new PendingDeadline();
        _pending[id] = pending;
        try
        {
            pending.Timer = schedule(delaySeconds, () =>
            {
                if (_pending.GetValueOrDefault(id) != pending || pending.Queued) return;
                pending.Queued = true;
                nextFrame(() =>
                {
                    if (_pending.GetValueOrDefault(id) != pending) return;
                    Cancel(id);
                    finish();
                });
            });
        }
        catch
        {
            Cancel(id);
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
