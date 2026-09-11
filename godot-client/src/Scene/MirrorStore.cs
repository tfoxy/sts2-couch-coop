// The retained mirror scene: a plain (non-Node) class owning the MirrorState node map + the game-space
// GlobalTransformIndex, fed by the background parse worker. The owner's _Process calls DrainInto() once per
// frame: it applies parsed deltas in order under a per-frame time budget (WS-B), sends ONE scene-ack per APPLIED
// delta (ack strictly AFTER apply — that part of the coalescer credit contract is unchanged), refreshes the
// transform index once, and raises OnChange. The budget defers only the SECOND+ delta of a burst frame (each
// delta applies atomically; the first always applies, so >=1 delta+ack lands every frame with pending data): a
// deferred delta's ack defers with it, the server's single-credit pump pauses on the missing ack, and the
// backlog drains at >=1/frame — that pause IS the flow control working as designed, and the server's 500ms
// ack-self-heal can never fire (one frame is ~16.7ms). The replay path (CompleteInputAndDrain) is UNBUDGETED.

using System;
using System.Collections.Generic;
using CouchCoop.GodotClient.App;
using CouchCoop.GodotClient.Net;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.GodotClient.Scene;

public sealed class MirrorStore : IDisposable
{
    public MirrorState State { get; } = MirrorState.Create();
    public GlobalTransformIndex Transforms { get; } = new();

    // Wide-screen re-layout (M2). The per-node spread records, recomputed each drain in FinishDrain (after the
    // transform index) and on a bare F change via SetSpreadFactor. Free at F=1 (SpreadIndex early-outs).
    public SpreadIndex Spread { get; } = new();

    // The horizontal spread factor (stageWidth / 1920; 1 = no spread). StageStretch pushes it via SetSpreadFactor.
    public double SpreadFactor { get; private set; } = 1;

    // Raised when SetSpreadFactor changes the factor, so the reconciler re-stamps every view's spread offset/width
    // WITHOUT waiting for an incoming delta (an F change with a static scene must still relayout).
    public event Action? SpreadChanged;

    // Set the spread factor (from StageStretch on a window resize / toggle). Recomputes the spread index immediately
    // against the current state + globals and raises SpreadChanged. A no-op when the factor is unchanged (so a
    // per-frame push at a steady factor — the common case — costs nothing).
    public void SetSpreadFactor(double factor)
    {
        if (factor < 1)
        {
            factor = 1;
        }

        if (factor == SpreadFactor)
        {
            return;
        }

        SpreadFactor = factor;
        Spread.Update(State, Transforms, factor);
        SpreadChanged?.Invoke();
    }

    // Set by the coordinator to the ACTIVE socket's SendSceneAck. Invoked once per applied delta. Null in the
    // file-fed replay path (there is no socket — nothing to credit).
    public Action? SendAck { get; set; }

    // Raised after a drain that applied ≥1 delta, carrying the new revision. The renderer (M1c) subscribes.
    public event Action<int>? OnChange;

    // Snapshot handed to the M1c reconciler in the drain hook (Drained), BETWEEN the transform-index refresh and
    // the ChangedIds clear. `ChangedIds` is the live set the applier accumulated across every delta of this drain
    // (do NOT retain it past the callback — it is cleared right after). `Hints` is the accumulated tween hints for
    // this drain (a snapshot; the pending list is cleared alongside — consume-pre-clear, same pattern as ChangedIds).
    // `Keyframe` is true when ANY applied delta was a full keyframe (→ full rebuild); `OrderChanged` when any delta
    // touched draw order (orderedIds/orderPatch).
    public readonly record struct DrainInfo(
        IReadOnlySet<string> ChangedIds,
        IReadOnlyList<MirrorTweenHint> Hints,
        bool Keyframe,
        bool OrderChanged,
        int Revision);

    // Raised in FinishDrain AFTER the transform index is refreshed but BEFORE ChangedIds is cleared, so the
    // reconciler can consume the changed set + structure flags. Fires once per drain that applied ≥1 delta.
    public event Action<DrainInfo>? Drained;

    private readonly SceneDeltaParsePipeline _pipeline = new();

    // Splits multi-delta bursts across frames while leaving ordinary incremental drains unaffected.
    private const double DrainBudgetMs = 5.0;

    // Times DrainInto stopped on the budget with parsed deltas still pending (telemetry; ~0 in steady play —
    // a steadily-climbing count means the budget trips outside bursts and the default needs raising).
    public long DrainDeferrals { get; private set; }

    // Parsed deltas currently waiting in the pipeline's OUT channel (gauge; returns to 0 after each burst).
    public int PendingParsed => _pipeline.PendingParsed;

    public int Revision => State.Revision;

    // Hand a raw scene-delta packet (from the active socket) to the parse worker.
    public void EnqueueRawDelta(byte[] utf8Packet) => _pipeline.Enqueue(utf8Packet);

    // Live per-frame drain: apply currently-parsed deltas in order under the frame budget (each delta atomic;
    // the FIRST always applies), ack each APPLIED delta, refresh the index once, notify. Returns the number of
    // deltas applied this drain. See the header comment for the deferred-ack flow-control contract.
    public int DrainInto()
    {
        int applied = 0;
        bool keyframe = false;
        bool orderChanged = false;
        long start = System.Diagnostics.Stopwatch.GetTimestamp();
        while (true)
        {
            // Budget check BETWEEN deltas, BEFORE consuming the next one (TryRead is destructive). Progress
            // guarantee: `applied > 0` exempts the first delta of the frame, so >=1 delta+ack always lands and
            // the server's single-credit pump can never starve (its 500ms self-heal is a further backstop).
            if (applied > 0 && DrainBudgetMs > 0 && ElapsedMs(start) >= DrainBudgetMs)
            {
                if (_pipeline.PendingParsed > 0)
                {
                    DrainDeferrals++;
                }

                break;
            }

            if (!_pipeline.TryRead(out var delta))
            {
                break;
            }

            keyframe |= delta.Full;
            orderChanged |= delta.OrderedIds is not null || delta.OrderPatch is not null;
            SceneTreeApplier.ApplySceneDelta(State, delta);
            SendAck?.Invoke(); // ack AFTER apply — this is what releases the next coalesced delta
            applied++;
        }

        if (applied > 0)
        {
            FinishDrain(keyframe, orderChanged);
        }

        return applied;
    }

    private static double ElapsedMs(long startTimestamp) =>
        (System.Diagnostics.Stopwatch.GetTimestamp() - startTimestamp) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;

    // Replay teardown: no more packets will arrive; block until the worker has parsed everything, applying each
    // (acking too, though SendAck is normally null in replay), then refresh the index once and notify.
    // WS-B: deliberately UNBUDGETED — the deterministic single-shot replay must apply everything in one pass.
    public void CompleteInputAndDrain()
    {
        _pipeline.CompleteInput();
        int applied = 0;
        bool keyframe = false;
        bool orderChanged = false;
        _pipeline.DrainAllBlocking(delta =>
        {
            keyframe |= delta.Full;
            orderChanged |= delta.OrderedIds is not null || delta.OrderPatch is not null;
            SceneTreeApplier.ApplySceneDelta(State, delta);
            SendAck?.Invoke();
            applied++;
        });

        if (applied > 0)
        {
            FinishDrain(keyframe, orderChanged);
        }
    }

    // WS-B: reused per-drain hints snapshot buffer (replaces the per-drain PendingHints.ToArray). Safe because the
    // DrainInfo.Hints contract is consume-pre-clear — consumers must not retain it past the Drained callback.
    private readonly List<MirrorTweenHint> _hintsBuffer = new();

    private void FinishDrain(bool keyframe, bool orderChanged)
    {
        // WS-W: the Drain bucket covers this whole method — Transforms.Update + Spread.Update + the reconciler's
        // Drained callback (which times its own Reconcile/Spread/Tween sub-buckets) — so it is the top-level
        // "how much did this drain cost" figure.
        long walkStart = WalkProfiler.Start();

        Transforms.Update(State);

        // Refresh the wide-screen spread records against the just-updated globals (per-drain, mirroring the web
        // per-reconcile). Free at F=1 (early-out); the reconciler consumes them in its Drained spread pass.
        // WS-P1: timed on its own SpreadIndex bucket (nested inside the Drain bucket above) so the record-recompute
        // cost is attributable separately from the reconciler's ApplySpread stamp pass.
        long spreadIndexStart = WalkProfiler.Start();
        Spread.Update(State, Transforms, SpreadFactor);
        WalkProfiler.Stop(WalkProfiler.Metric.SpreadIndex, spreadIndexStart);

        // Snapshot the drain's accumulated tween hints into the REUSED buffer and clear the pending list
        // (consume-pre-clear, same pattern as ChangedIds): the reconciler's TweenReplayer.Consume replays them
        // AFTER views update, then they're gone. WS-B: the buffer replaces a per-drain ToArray.
        _hintsBuffer.Clear();
        _hintsBuffer.AddRange(State.PendingHints);
        IReadOnlyList<MirrorTweenHint> hints = _hintsBuffer;
        State.PendingHints.Clear();

        // The M1c reconciler consumes ChangedIds HERE (transform index already refreshed above), BEFORE the clear.
        // WS-P2: the reconciler also reads State.ChangeFlags during this callback (light-apply eligibility + identity-
        // cache invalidation), so it too is cleared AFTER the callback below.
        Drained?.Invoke(new DrainInfo(State.ChangedIds, hints, keyframe, orderChanged, State.Revision));
        // The transform index + reconciler are the ChangedIds consumers; clear it so the next incremental update
        // stays minimal. ChangeFlags shares the ChangedIds lifecycle (accumulate across the drain, consume in Drained,
        // clear here).
        State.ChangedIds.Clear();
        State.ChangeFlags.Clear();
        OnChange?.Invoke(State.Revision);

        WalkProfiler.Stop(WalkProfiler.Metric.Drain, walkStart);
    }

    // Expose worker diagnostics (parsed-to-null count) for the connect-mode summary.
    public long Skipped => _pipeline.Skipped;

    public void Dispose() => _pipeline.Dispose();
}
