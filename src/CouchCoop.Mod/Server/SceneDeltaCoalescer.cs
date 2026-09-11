using Spirectl.Sts2.Core.SceneInspection;

namespace CouchCoop.Mod.Server;

// One pending upsert id's bookkeeping within a coalescing window. `NeedsStatic` = at least one folded upsert for
// this id carried the STATIC block (non-null Name — an add/keyframe), so the resolved node must be sent FULL.
// `IntentDirty` = at least one folded upsert carried a fresh enemy-intent frame set (the intent animation changed),
// so a pure-volatile projection must still ship the retained IntentFrames (they're sticky, re-sent only on change).
// `LineDirty` is the same bookkeeping for the Line2D stroke unit (map quill annotations): at least one folded upsert
// carried fresh stroke geometry, so the projection must ship the retained points/width/colour. Latest-wins for a
// slow client is exactly right here — a mid-drag stroke's LATEST array supersedes every intermediate one.
internal struct PendingUpsert
{
    public bool NeedsStatic;
    public bool IntentDirty;
    public bool LineDirty;
}

// A resolve request the coalescer hands the observer at Take time: resolve id `Id` to either its FULL retained
// snapshot (`NeedsStatic`) or a VOLATILE projection (`ToVolatile`), carrying IntentFrames only when `IntentDirty`
// and the Line2D stroke geometry only when `LineDirty`.
// Public because CouchCoopSceneObserver.ResolveUpserts consumes it across the coalescer→observer send seam.
public readonly record struct PendingUpsertRequest(string Id, bool NeedsStatic, bool IntentDirty, bool LineDirty);

// The coalescer's send output: the raw delta plus the Stage 4 order encoding decision. `OrderPatch` non-null means
// send the compact patch (and NOT Delta.OrderedIds); null with a non-null Delta.OrderedIds means send the full
// array (first structural send after a keyframe, or a churn too big to patch). The serializer reads this to pick.
public sealed record CoalescedSceneDelta(RuntimeSceneDelta Delta, SceneOrderPatch? OrderPatch);

// Accumulates incremental scene deltas for ONE connection into a single pending update, so a slow client never
// builds an unbounded send backlog (which made a click's resulting delta land ~1s late). Scene state is a
// snapshot stream — only the LATEST state of each changed node matters — so instead of queuing every delta we
// fold their changed/removed ids together and, when the socket is free, resolve those ids to their current state
// from the retained map (`Take`). The result is correct because the client applies deltas idempotently to a
// retained node map: applying `Take()`'s coalesced delta yields the same map as applying every folded delta in
// order. Not thread-safe; the caller (CouchCoopWebSocketConnection) guards it with its scene lock.
//
// Wire-diet: the producer emits LEAN volatile-only upserts, but the retained map re-inflates every node to its
// full static snapshot. Re-shipping that static block on every per-tick change is pure waste (the client already
// holds it), so each pending id tracks whether it actually NEEDS the static block (`NeedsStatic`) — only fresh
// adds/keyframes do — and Take projects the rest DOWN to a volatile-only upsert (ToVolatile) the client merges
// onto its retained statics, exactly as it already handles the producer's own volatile-only upserts.
internal sealed class SceneDeltaCoalescer
{
    private readonly Dictionary<string, PendingUpsert> _upserts = [];
    private readonly HashSet<string> _removedIds = [];
    private List<string>? _orderedIds;
    // One-shot tween hints accumulate across folds (unlike node state they are NOT latest-wins — each is a distinct
    // event to replay once), and flush on the next Take. A Full keyframe drops them (a fresh client replays nothing).
    private List<TweenHintDelta>? _hints;
    // WS-3 declarative card flights, same one-shot accumulate-across-folds lifecycle as _hints. Dropped by a Full
    // keyframe for the same reason: a fresh client is re-seeded from the keyframe's transforms and has no half-run
    // flight to continue — and the producer's suppression window closes on its own clock either way.
    private List<CardFlightHintDelta>? _cardFlights;
    private bool _full;
    private string _screenType = "unknown";
    private string _screenInstanceId = "screen:unknown:live";
    // The exact ordered id array last SENT to this connection (Stage 4 order patches diff against it). Null means
    // the next structural send must be a full array — nothing to diff against yet (right after a keyframe).
    private IReadOnlyList<string>? _lastSentOrder;

    // True when at least one delta has been folded since the last Take.
    public bool HasPending { get; private set; }

    // Discard everything accumulated AND the order baseline — used when this connection's scene stream is GATED
    // OFF and again when it is re-enabled (WS-B `watch` gate). Both halves matter:
    //   - the pending accumulator is a set of node ids whose state is resolved LATER, at Take time; holding it
    //     across a gap would ship a coalesced delta describing a scene the client stopped tracking.
    //   - `_lastSentOrder` is the exact array the client last received. Across a gap the client is re-seeded from
    //     a FULL keyframe sent outside this coalescer, so diffing the next order against the PRE-GAP baseline
    //     would emit a patch the client cannot apply to the order it actually holds — which renders as a subtly
    //     scrambled tree, not an obvious failure. Nulling it forces the next structural send to ship the full
    //     array, exactly like the first structural send after a fresh connect.
    public void Reset()
    {
        _upserts.Clear();
        _removedIds.Clear();
        _orderedIds = null;
        _hints = null;
        _cardFlights = null;
        _full = false;
        _lastSentOrder = null;
        HasPending = false;
    }

    // Merge one delta into the pending accumulator. A Full keyframe supersedes everything pending (the next
    // Take rebuilds the whole tree); otherwise upserts win by id (latest state resolved at Take time) and
    // removals drop a pending upsert and are remembered.
    public void Fold(RuntimeSceneDelta delta)
    {
        if (delta.Full)
        {
            _full = true;
            _upserts.Clear();
            _removedIds.Clear();
            _orderedIds = null;
            _hints = null;
            _cardFlights = null;
        }

        if (delta.Hints is { Count: > 0 } hints)
        {
            (_hints ??= []).AddRange(hints);
        }

        if (delta.CardFlights is { Count: > 0 } cardFlights)
        {
            (_cardFlights ??= []).AddRange(cardFlights);
        }

        foreach (var removedId in delta.RemovedIds)
        {
            _upserts.Remove(removedId);
            if (!_full)
            {
                _removedIds.Add(removedId);
            }
        }

        foreach (var upsert in delta.Upserts)
        {
            _removedIds.Remove(upsert.Id);
            // An upsert carrying statics (non-null Name) is an add/keyframe — the node must be sent FULL. IntentFrames
            // present means the intent animation changed this tick — its (sticky) frames must ride the resolved node.
            // LinePoints present means the same for a Line2D stroke (the three line fields ship as one unit, so the
            // points field alone decides). All three flags are STICKY across folds within a window: once a node needs
            // its static block (or a fresh intent / stroke), a later plain volatile fold must not clear that.
            _upserts.TryGetValue(upsert.Id, out var pending);
            pending.NeedsStatic |= upsert.Name is not null;
            pending.IntentDirty |= upsert.IntentFrames is not null;
            pending.LineDirty |= upsert.LinePoints is not null;
            _upserts[upsert.Id] = pending;
        }

        if (delta.OrderedIds is not null)
        {
            _orderedIds = [.. delta.OrderedIds];
        }

        _screenType = delta.ScreenType;
        _screenInstanceId = delta.ScreenInstanceId;
        HasPending = true;
    }

    // Produce the coalesced delta to send and clear the accumulator. A pending Full → a fresh keyframe from
    // `buildKeyframe`; otherwise an incremental delta whose upserts are resolved via `resolve` — FULL for ids that
    // need the static block, a VOLATILE projection otherwise. When the structure changed this window, `buildIndexes`
    // (the last-sent order + the new order, indexed under one node-map snapshot) drives the Stage 4 decision:
    // ship a compact order PATCH, or the full array when there's nothing to diff against / the churn is too big.
    // Returns null when nothing is resolvable.
    public CoalescedSceneDelta? Take(
        Func<RuntimeSceneDelta?> buildKeyframe,
        Func<IReadOnlyList<PendingUpsertRequest>, IReadOnlyList<RuntimeSceneNodeDelta>> resolve,
        Func<IReadOnlyList<string>, IReadOnlyList<string>, (SceneStructureIndex Old, SceneStructureIndex New)> buildIndexes)
    {
        HasPending = false;

        if (_full)
        {
            _full = false;
            _orderedIds = null;
            _upserts.Clear();
            _removedIds.Clear();
            _hints = null;
            _cardFlights = null;
            var keyframe = buildKeyframe();
            // A keyframe carries the whole order; the client rebuilds its structure from it, so the next incremental
            // structural send has a fresh baseline to patch against.
            _lastSentOrder = keyframe?.OrderedIds is { } order ? [.. order] : null;
            return keyframe is null ? null : new CoalescedSceneDelta(keyframe, null);
        }

        var requests = new List<PendingUpsertRequest>(_upserts.Count);
        foreach (var (id, pending) in _upserts)
        {
            requests.Add(new PendingUpsertRequest(id, pending.NeedsStatic, pending.IntentDirty, pending.LineDirty));
        }

        var removedIds = _removedIds.ToArray();
        var orderedIds = _orderedIds;
        var hints = _hints;
        var cardFlights = _cardFlights;
        _upserts.Clear();
        _removedIds.Clear();
        _orderedIds = null;
        _hints = null;
        _cardFlights = null;

        var upserts = resolve(requests);
        // Hints alone (no node change this tick) still warrant a send — the client replays them. So does a card
        // flight ALONE, and more urgently: the producer has already stopped streaming that flight's nodes, so a
        // dropped send would strand them frozen for the whole window.
        if (upserts.Count == 0
            && removedIds.Length == 0
            && orderedIds is null
            && (hints is null || hints.Count == 0)
            && (cardFlights is null || cardFlights.Count == 0))
        {
            return null;
        }

        // Stage 4: when the order changed, try to send a compact patch instead of the full ~52KB array. The patch
        // is self-verified (SceneOrderDiff reconstructs the exact new order before emitting) — a failed check or a
        // missing baseline falls back to the full array. Either way, remember the new order as the next baseline.
        SceneOrderPatch? orderPatch = null;
        if (orderedIds is not null)
        {
            if (_lastSentOrder is not null)
            {
                var (oldIndex, newIndex) = buildIndexes(_lastSentOrder, orderedIds);
                orderPatch = SceneOrderDiff.TryComputePatch(oldIndex, newIndex, orderedIds);
            }

            _lastSentOrder = orderedIds;
        }

        var delta = new RuntimeSceneDelta(
            Full: false,
            ScreenType: _screenType,
            ScreenInstanceId: _screenInstanceId,
            Upserts: upserts,
            RemovedIds: removedIds,
            // When a patch is sent, the full array is redundant — drop it from the raw delta so the serializer emits
            // only the patch. When no patch (full array or no structural change), keep it.
            OrderedIds: orderPatch is null ? orderedIds : null,
            Hints: hints,
            CardFlights: cardFlights);

        return new CoalescedSceneDelta(delta, orderPatch);
    }
}
