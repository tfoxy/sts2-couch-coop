namespace CouchCoop.MirrorProtocol.SceneModel;

// A fire-and-forget decorative tween hint the client replays declaratively (TS MirrorTweenHint). `Property` is the
// raw Godot property; `To` is compact JSON or null; End/Start transform are CSS 6-tuples, `Group` ties a Godot
// tween's transform + opacity hints together.
public sealed record MirrorTweenHint(
    string TargetId,
    string Property,
    string? To,
    double DurationMs,
    string? Trans,
    string? Ease,
    IReadOnlyList<double>? EndTransform,
    double? EndOpacity,
    string? Group,
    IReadOnlyList<double>? StartTransform,
    double? StartOpacity);

// WS-3: a declarative CARD FLIGHT the client integrates locally (TS MirrorCardFlightHint) — the discard→draw
// shuffle sweep, or (`Kind`) the hand→discard fly that carries the card the player just played.
// Unlike MirrorTweenHint this is NOT a Godot tween — the game animates NCardFlyShuffleVfx in a per-rendered-frame
// async loop — so there is no CSS transition to arm: the client steps the game's own integrator per rAF and writes
// the pose. `TargetId`/`TrailId` join to MirrorNode.Id; `Start`/`End`/`Control` are streamed-space [x,y] points and
// `Basis` a streamed-space [a,b,c,d] basis, always GLOBAL (never re-based to a parent). `Duration` is the game's
// pseudo-time unit, not seconds; `WindowMs` is how long the producer has stopped
// streaming the FLIGHT node's transforms, i.e. how long the client owns them. `TrailId` addresses the comet root,
// which keeps streaming — the client uses it only to find the trail strokes it feeds the head to.
public sealed record MirrorCardFlightHint(
    string TargetId,
    string? TrailId,
    IReadOnlyList<double> Start,
    IReadOnlyList<double> End,
    IReadOnlyList<double> Control,
    IReadOnlyList<double> Basis,
    double Speed0,
    double Accel,
    double Duration,
    double Scale0,
    double WindowMs,
    // Which flight this is, NORMALIZED by the reader to exactly "shuffle" or "discard" so the client never handles a
    // null or an unknown spelling: the wire's absent/unrecognised kind reads as "shuffle", the motion every consumer
    // already knows. "discard" is the hand→discard fly, and the one thing that makes it different on screen is that
    // the moving element is the REAL card the player just played rather than a throwaway flier.
    string Kind,
    // The mover's on-screen angle (radians, same streamed space as everything else here) when the flight started —
    // the pose "discard" turns smoothly OUT of into the curve's tangent, so the card the player just dragged does
    // not flick to a new angle on its first frame. 0 for "shuffle", whose flier appears from nothing.
    double Rot0);

// One dirty parent's new ordered child-id list (TS `{ p, c }`).
public sealed record MirrorOrderParent(string P, IReadOnlyList<string> C);

// A Stage 4 incremental draw-order update (TS MirrorOrderPatch): the new root list (present only when roots
// changed) + every parent whose child list changed.
public sealed record MirrorOrderPatch(IReadOnlyList<string>? Roots, IReadOnlyList<MirrorOrderParent> Parents);

// A parsed `scene-delta` (TS MirrorDelta). `OrderedIds` (full array) XOR `OrderPatch` carries draw order.
public sealed class MirrorDelta
{
    public bool Full { get; init; }
    public string ScreenType { get; init; } = "";
    public IReadOnlyList<MirrorNode> Upserts { get; init; } = [];
    public IReadOnlyList<string> RemovedIds { get; init; } = [];
    public IReadOnlyList<string>? OrderedIds { get; init; }
    public MirrorOrderPatch? OrderPatch { get; init; }
    public IReadOnlyList<MirrorTweenHint> Hints { get; init; } = [];
    // WS-3 declarative card flights started this tick (see MirrorCardFlightHint). Separate from Hints: these are
    // integrated, not transitioned, and they come with the producer having STOPPED streaming their nodes.
    public IReadOnlyList<MirrorCardFlightHint> CardFlights { get; init; } = [];
}

// The retained mirror scene state (TS MirrorState). The node map is keyed by stable instance id and patched in
// place; `Revision` bumps on every applied delta. `ChangedIds`/`PendingHints` accumulate for the renderer to drain.
public sealed class MirrorState
{
    public string ScreenType { get; set; } = "unknown";
    public Dictionary<string, MirrorNode> Nodes { get; } = new(StringComparer.Ordinal);
    public List<string> OrderedIds { get; set; } = [];
    public int Revision { get; set; }
    public HashSet<string> ChangedIds { get; } = new(StringComparer.Ordinal);
    // WS-P2 per-node change classification, accumulated (OR-merged) across a drain's deltas alongside ChangedIds and
    // cleared in the same FinishDrain lifecycle. The reconciler reads it to take a light (transform/tint-only) apply
    // for an eligible existing view; identity-cache invalidation reads it for a Static-bearing drain. Purely additive
    // — never affects node merging, so cross-language replay parity is unchanged.
    public Dictionary<string, NodeChangeFlags> ChangeFlags { get; } = new(StringComparer.Ordinal);
    public List<MirrorTweenHint> PendingHints { get; } = [];
    // WS-3: same one-shot accumulate/drain lifecycle as PendingHints, for declarative card flights.
    public List<MirrorCardFlightHint> PendingCardFlights { get; } = [];

    public static MirrorState Create() => new();
}
