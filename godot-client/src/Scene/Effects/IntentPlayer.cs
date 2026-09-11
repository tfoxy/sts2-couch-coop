// M1d effect seam — INTENT frame player (WS-J). MirrorNodeView.Apply calls Sync on every node update. Frame 0 of an
// enemy-intent glyph already renders in M1c (the applier's ApplyIntentFrame0 forces the node's texture fields to the
// first frame), so this only drives the LATER frames: a self-ticking "__intent" child cycles the atlas frames off the
// wall-clock and calls owner.SetIntentFrame(clone-with-frame-i) on each frame change.
//
// Port of mirrorRenderer.ts advanceIntent (L1385-1419) + the intent-key restart block (L1639-1654):
//   * Active only when IntentFrames has >1 frames (single-frame glyphs are static frame 0 — no ticker).
//   * The clock restarts when the key `AnimationName|Frames.Count` changes (a new intent), from frame −1 so the
//     first tick repaints.
//   * Each tick: frame = EffectMath.IntentFrameIndex(now − startMs, fps, count); on a CHANGE, frame 0 reverts to the
//     streamed node (SetIntentFrame(null) — it already carries frame 0), else a shallow NodeData clone with the
//     frame-i texture fields swapped in (mirroring SceneTreeApplier.ApplyIntentFrame0's field list).
//   * InstantTweens (deterministic --replay single-shot): FROZEN at frame 0 — no ticker, so the shot is byte-stable.

using CouchCoop.GodotClient.Scene;
using CouchCoop.MirrorProtocol.SceneModel;
using Godot;

namespace CouchCoop.GodotClient.Scene.Effects;

public static partial class IntentPlayer
{
    private const string TickerName = "__intent";

    // WS-B: build-once NodePath for the ticker probes (GetNodeOrNull(string) marshals a fresh NodePath per call).
    private static readonly NodePath TickerPath = TickerName;

    public static void Sync(MirrorNodeView owner, MirrorNode node, RenderContext ctx)
    {
        bool multi = node.IntentFrames is { Frames.Count: > 1 };
        bool wantTicker = !ctx.Options.InstantTweens && multi;

        // WS-P2 gate: no ticker wanted now AND none ever attached → skip the Detach probe entirely (the common case:
        // most nodes have no multi-frame intent). A node that HAD a ticker still reaches Detach below to tear it down.
        if (!wantTicker && !owner.HasIntentChild)
        {
            return;
        }

        // Deterministic single-shot OR a non-cycling glyph: freeze at frame 0 (the streamed node already carries it).
        // Detach any existing ticker + revert the substitute so the shot / static glyph is stable.
        if (!wantTicker)
        {
            Detach(owner);
            owner.HasIntentChild = false;
            return;
        }

        var ticker = owner.GetNodeOrNull<IntentTicker>(TickerPath);
        if (ticker is null)
        {
            ticker = new IntentTicker { Name = TickerName, ShowBehindParent = true };
            owner.AddChild(ticker); // END-APPENDED per the MirrorNodeView attachment-child ordering rule
            ticker.Bind(owner);
            owner.HasIntentChild = true;
        }

        ticker.Update(node.IntentFrames!);
    }

    // Track I (idle-animation suspend): freeze/unfreeze this view's intent-frame ticker. The ticker cycles frames off
    // the WALL CLOCK (_startMs-anchored), so SetProcess(false) holds the current frame (its SetIntentFrame Marks stop)
    // and SetProcess(true) resumes correct by definition (the next _Process computes the frame from now − _startMs —
    // exactly where the loop would be). Returns true iff a live "__intent" ticker was toggled (the controller gates on
    // owner.HasIntentChild; this re-confirms the child).
    public static bool SetSuspended(MirrorNodeView owner, bool suspend)
    {
        var ticker = owner.GetNodeOrNull<IntentTicker>(TickerPath);
        if (ticker is null)
        {
            return false;
        }

        ticker.SetProcess(!suspend);
        return true;
    }

    private static void Detach(MirrorNodeView owner)
    {
        var ticker = owner.GetNodeOrNull<IntentTicker>(TickerPath);
        if (ticker is not null)
        {
            owner.SetIntentFrame(null); // back to the streamed node (frame 0)
            ticker.Free(); // immediate — no extra deferred tick that could re-swap after we reverted
        }
    }

    // The self-ticking "__intent" child: holds the current frame spec + cycle clock and swaps the owner's intent
    // substitute on each frame change. Inert draw (a bare Node2D) — it only drives owner.SetIntentFrame.
    public sealed partial class IntentTicker : Node2D
    {
        private MirrorNodeView _owner = null!;
        private MirrorIntentFrames? _spec;
        private string? _key;
        private double _startMs;
        private int _shownFrame = -1;

        public void Bind(MirrorNodeView owner) => _owner = owner;

        // Reflect the current wire spec; restart the cycle when the animation key changes.
        public void Update(MirrorIntentFrames spec)
        {
            _spec = spec;
            string key = $"{spec.AnimationName}|{spec.Frames.Count}";
            if (_key != key)
            {
                _key = key;
                _startMs = Time.GetTicksMsec();
                _shownFrame = -1;
            }
        }

        public override void _Process(double delta)
        {
            var spec = _spec;
            if (spec is null || spec.Frames.Count <= 1)
            {
                return;
            }

            double fps = spec.Fps > 0 ? spec.Fps : 15; // reader defaults to 15, guard anyway
            int frame = EffectMath.IntentFrameIndex(Time.GetTicksMsec() - _startMs, fps, spec.Frames.Count);
            if (frame == _shownFrame)
            {
                return;
            }

            _shownFrame = frame;

            if (frame == 0)
            {
                _owner.SetIntentFrame(null); // streamed node already carries frame 0
                return;
            }

            // Shallow-clone the CURRENT streamed node (so every other draw field stays current) and swap in the
            // frame-i texture fields — exactly the trio SceneTreeApplier.ApplyIntentFrame0 overrides for frame 0.
            var frameNode = spec.Frames[frame];
            MirrorNode clone = _owner.NodeData.Clone();
            clone.TextureUrl = frameNode.Url;
            clone.TextureRegion = frameNode.Region;
            clone.TextureMargin = frameNode.Margin;
            _owner.SetIntentFrame(clone);
        }
    }
}
