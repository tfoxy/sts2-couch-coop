namespace CouchCoop.GodotClient.Scene;

// #7 instrumentation lever (COUCHCOOP_MIRROR_TWEEN_DEBUG=1, default OFF). Traces the three sites that can shrink a
// creature/spine view at removal (the "gets small at end of animation before disappearing" defect): the tween-replay
// ARM path (TweenReplayer.Arm — targetId, channel, duration, decomposed start/end scale), the pool-reset identity
// stamp (MirrorNodeView.ResetForPool — the transform scale AT reset), and the reconciler RELEASE path
// (SceneReconciler.Release — the transform scale + whether a transform tween owns it). INSTRUMENTATION ONLY: no
// behavior change — the wave-2 death-shrink agent (Task A3 #7) consumes the log to pick the branch fix. Read ONCE.
public static class TweenDebugSettings
{
    public static readonly bool Enabled =
        System.Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_TWEEN_DEBUG") == "1";
}
