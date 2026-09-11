using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// P2 (WS-select) discard-select flash — client-side proof that the producer fix cures the flash and the round-3
// behaviour caused it. Runs the wire through the REAL client merge (SceneTreeApplier.ApplySceneDelta →
// MergeNode) + the pure GlobalTransformIndex (the same gNode pass-through the native reconciler and the web
// mirrorRenderer bake), so it asserts on the card's composed GLOBAL — what actually renders.
//
// Mechanism (confirmed by the real capture cap/A-select.ndjson): the SELECT reparents the hand card into a fresh
// NSelectedHandCardHolder under the centre container (global ≈960,488, holder scale 0.8) WHILE the container lifts
// on a real tween (a ~500ms suppression window opens). Round-3's reparent force-emit shipped the card's
// mid-reparent LOCAL (0, +677.5) → composed global ≈(960,1030), bottom-centre; the client pinned it for the whole
// window and only snapped to centre at the settle re-emit — the "1-frame off-centre, holds, then snaps" flash.
//
// The fix ships the reparent upsert with Transform=null. MergeNode wholesale-adopts a Name-bearing upsert →
// node.Transform=null → GlobalTransformIndex pass-through (child global == parent global) → the card renders at the
// holder (centre) IMMEDIATELY, rides the container tween, and settles exact. This probe proves both the before
// (jump) and after (hold), self-contained (no capture needed), and additionally replays the real capture when
// COUCHCOOP_MIRROR_SELECTFLASH_PROBE_NDJSON points at it (skips silently otherwise).
internal static class SelectFlashReplayProbe
{
    public static void Run()
    {
        SyntheticBefore_ShipsTransform_CardJumpsBottomCentre();
        SyntheticAfter_TransformLessReparent_CardHoldsCentre();
        RealCaptureReplay_OptionalEnvGated();
    }

    // Node ids mirror the real capture roles.
    private const string Root = "root";
    private const string Cont = "cont";       // NSelectedHandCardContainer — lifts 488 → 540
    private const string Hand = "hand";       // the card's pre-select hand holder
    private const string Sel = "sel";         // fresh NSelectedHandCardHolder (scale 0.8) under Cont
    private const string Card = "card";       // NCard

    private static MirrorNode N(string id, string? parent, double[]? transform, string name = "") =>
        new() { Id = id, ParentId = parent, Name = name, Transform = transform };

    // Advance one drain: apply the delta through the real merge, recompute globals, read the card's composed global,
    // then reset the per-drain changed set (the renderer clears it each drain; GlobalTransformIndex keys off it).
    private static double[] Drain(MirrorState state, GlobalTransformIndex index, MirrorDelta delta)
    {
        SceneTreeApplier.ApplySceneDelta(state, delta);
        index.Update(state);
        Check.That(index.TryGetGlobal(Card, out var g), "card has a composed global");
        var copy = g.ToArray();
        state.ChangedIds.Clear();
        return copy;
    }

    // The keyframe: root → Cont(960,488) → Hand(local 0,400 ⇒ global 960,888) → Card(local 0,0 ⇒ global 960,888).
    private static MirrorDelta Keyframe() => new()
    {
        Full = true,
        Upserts =
        [
            N(Root, null, [1, 0, 0, 1, 0, 0], "Root"),
            N(Cont, Root, [1, 0, 0, 1, 960, 488], "SelectedHandCardContainer"),
            N(Hand, Cont, [1, 0, 0, 1, 0, 400], "HandHolder"),
            N(Card, Hand, [1, 0, 0, 1, 0, 0], "Card"),
        ],
        OrderedIds = [Root, Cont, Hand, Card],
    };

    // The reparent drain: the fresh Sel holder (scale 0.8) appears under Cont and the card re-attaches under it.
    // `cardTransform` is the transition-start local (round-3) or null (the fix). The card upsert is Name-bearing
    // (a reparent ships the static block), so MergeNode wholesale-adopts it — a null transform truly nulls the node.
    private static MirrorDelta Reparent(double[]? cardTransform) => new()
    {
        Full = false,
        Upserts =
        [
            N(Sel, Cont, [0.8, 0, 0, 0.8, 0, 0], "SelectedHandCardHolder"),
            N(Card, Sel, cardTransform, "Card"),
        ],
    };

    // The settle re-emit after the window closes: Cont has lifted to 540 and the card sits at the holder origin.
    private static MirrorDelta Settle() => new()
    {
        Full = false,
        Upserts =
        [
            N(Cont, Root, [1, 0, 0, 1, 960, 540], "SelectedHandCardContainer"),
            N(Card, Sel, [1, 0, 0, 1, 0, 0], "Card"),
        ],
    };

    private static void SyntheticBefore_ShipsTransform_CardJumpsBottomCentre()
    {
        var state = MirrorState.Create();
        var index = new GlobalTransformIndex();

        var atHand = Drain(state, index, Keyframe());
        Check.That(Near(atHand, 960, 888), $"card starts at the hand (960,888), got ({atHand[4]:0.#},{atHand[5]:0.#})");

        // Round-3: the reparent ships the transition-start local (0,677.5) → composed global bottom-centre (960,1030).
        var atReparent = Drain(state, index, Reparent([1, 0, 0, 1, 0, 677.5]));
        Check.That(Near(atReparent, 960, 1030),
            $"round-3 reparent JUMPS the card to bottom-centre ~(960,1030), got ({atReparent[4]:0.#},{atReparent[5]:0.#})");
        Check.That(atReparent[5] - 540 > 400,
            $"the jump is FAR below the centre (the visible flash), got y={atReparent[5]:0.#}");

        // The settle snaps it back to centre — the user sees flash → snap.
        var atSettle = Drain(state, index, Settle());
        Check.That(Near(atSettle, 960, 540),
            $"settle resync lands the card at centre (960,540), got ({atSettle[4]:0.#},{atSettle[5]:0.#})");
    }

    private static void SyntheticAfter_TransformLessReparent_CardHoldsCentre()
    {
        var state = MirrorState.Create();
        var index = new GlobalTransformIndex();

        Drain(state, index, Keyframe());

        // The fix: the reparent upsert carries NO transform → GlobalTransformIndex pass-through → card global == the
        // holder's global (centre). NO bottom-centre flash.
        var atReparent = Drain(state, index, Reparent(cardTransform: null));
        Check.That(Near(atReparent, 960, 488),
            $"transform-less reparent HOLDS the card at the holder/centre (960,488), got ({atReparent[4]:0.#},{atReparent[5]:0.#})");
        Check.That(System.Math.Abs(atReparent[5] - 488) < 1.0,
            $"NO bottom-centre flash: card y stays at centre, got y={atReparent[5]:0.#}");

        // And the settle still lands exact (byte-identical end state to the before variant).
        var atSettle = Drain(state, index, Settle());
        Check.That(Near(atSettle, 960, 540),
            $"settle resync lands the card at centre (960,540), got ({atSettle[4]:0.#},{atSettle[5]:0.#})");
    }

    // Optional: replay the REAL discard-select capture (round-3 bridge) and prove the same story on live data —
    // the card node's composed global jumps to bottom-centre at the reparent, and nulling its transform there holds
    // it at the holder. Skips SILENTLY without the env var so the suite stays green in a plain checkout.
    private static void RealCaptureReplay_OptionalEnvGated()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_SELECTFLASH_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        // The real captured card node id (Defend, reparented into the SelectedHandCardHolder). Overridable.
        var cardId = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_SELECTFLASH_CARDID") ?? "76537663079";
        // Fresh delta graph per pass (pass 2 mutates the reparent upsert's transform, so it must not share objects).

        // The discriminator is the card's composed global AT THE REPARENT DELTA (the frame the client first pins for
        // the suppression window). Round-3 shipped the transition-start local → the card sits at bottom-centre; the
        // fix (transform-less) holds it at the holder (centre). The final settle lands centre in both.
        var (verbatimAtReparent, verbatimAtEnd, reparentIdx) = ReplayTrackY(ReadDeltas(path), cardId, nullCardTransformAtReparent: false);
        Console.Error.WriteLine(
            $"[selectflash] real capture round-3: card {cardId} Y at reparent={verbatimAtReparent:0.#}, at end={verbatimAtEnd:0.#} (reparent@delta#{reparentIdx})");
        Check.That(reparentIdx >= 0, "found the reparent delta (card parentId changes) in the real capture");
        Check.That(verbatimAtReparent > 900,
            $"round-3 capture PINS the card at bottom-centre (Y≈1030) at the reparent — the flash; got Y={verbatimAtReparent:0.#}");

        // The producer fix: null the card's transform on that reparent → GlobalTransformIndex pass-through holds it at
        // the holder (centre, Y≈488), never the bottom-centre flash.
        var (fixAtReparent, fixAtEnd, _) = ReplayTrackY(ReadDeltas(path), cardId, nullCardTransformAtReparent: true);
        Console.Error.WriteLine(
            $"[selectflash] transform-less reparent: card {cardId} Y at reparent={fixAtReparent:0.#}, at end={fixAtEnd:0.#}");
        Check.That(fixAtReparent < 600,
            $"transform-less reparent HOLDS the card near the holder/centre at the reparent (no bottom flash); got Y={fixAtReparent:0.#}");
        Check.That(verbatimAtReparent - fixAtReparent > 300,
            $"the fix lifts the card off the bottom-centre flash by a large margin ({verbatimAtReparent - fixAtReparent:0.#}px)");
        // Both variants settle to the same end (centre-ish) — the fix changes only the mid-window pin, not the result.
        Check.That(System.Math.Abs(verbatimAtEnd - fixAtEnd) < 2.0,
            $"both variants settle to the same end Y (round-3 {verbatimAtEnd:0.#} == fix {fixAtEnd:0.#})");
    }

    // Replay the captured deltas, returning the card's composed-Y at the reparent delta, its Y at the last delta that
    // touched it, and the reparent delta index (where the card's parentId first changes). When
    // nullCardTransformAtReparent, the card's transform on that reparent delta is nulled first (the producer fix).
    private static (double AtReparent, double AtEnd, int ReparentIdx) ReplayTrackY(
        List<MirrorDelta> deltas, string cardId, bool nullCardTransformAtReparent)
    {
        var state = MirrorState.Create();
        var index = new GlobalTransformIndex();
        double atReparent = double.NaN, atEnd = double.NaN;
        int reparentIdx = -1;
        string? lastParent = null;

        for (var i = 0; i < deltas.Count; i++)
        {
            var delta = deltas[i];
            var isReparentHere = false;
            // Detect the reparent: the card upsert whose parentId differs from what we last saw.
            foreach (var u in delta.Upserts)
            {
                if (u.Id != cardId || u.ParentId is not { } p)
                {
                    continue;
                }

                if (p != lastParent && reparentIdx < 0 && lastParent is not null)
                {
                    reparentIdx = i;
                    isReparentHere = true;
                    if (nullCardTransformAtReparent)
                    {
                        u.Transform = null; // the producer fix: omit the transform on the suppressed reparent
                    }
                }

                lastParent = p;
            }

            SceneTreeApplier.ApplySceneDelta(state, delta);
            index.Update(state);
            if (state.Nodes.ContainsKey(cardId) && index.TryGetGlobal(cardId, out var g))
            {
                atEnd = g[5];
                if (isReparentHere)
                {
                    atReparent = g[5];
                }
            }

            state.ChangedIds.Clear();
        }

        return (atReparent, atEnd, reparentIdx);
    }

    private static List<MirrorDelta> ReadDeltas(string path)
    {
        var deltas = new List<MirrorDelta>();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            string payload = line;
            if (line.StartsWith("{\"t\"", StringComparison.Ordinal))
            {
                using var doc = JsonDocument.Parse(line);
                if (!doc.RootElement.TryGetProperty("data", out var d) || d.GetString() is not { } inner)
                {
                    continue;
                }

                payload = inner;
            }

            var delta = SceneDeltaReader.Parse(payload);
            if (delta is not null)
            {
                deltas.Add(delta);
            }
        }

        return deltas;
    }

    private static bool Near(double[] g, double x, double y, double tol = 1.5)
        => System.Math.Abs(g[4] - x) < tol && System.Math.Abs(g[5] - y) < tol;
}
