using System.Text.Json;
using CouchCoop.MirrorProtocol.SceneModel;

namespace CouchCoop.MirrorProtocol.Tests;

// WS-REST rest-site "option description stuck invisible on quick refocus / cold first click" — client-side proof that
// the held-restore short expiry + sweep self-heal cure the defect.
//
// The defect: when a faded option is re-focused the game re-shows the description as a PLAIN streamed resting-alpha
// write with NO fade-in hint (its fade-IN tween was killed by the unfocus, so the producer never emitted a hint). The
// hide-latch armed by the earlier fade-OUT sees a resting-VALUED write (value-identical to the pre-hide flash) and
// clamps it to 0. With NO further delta and no ¬visible hide to Cancel it, the description stays invisible until the
// (only) 400ms grace elapses. The current sweep reapplies the streamed alpha after the shorter held-restore grace.
//
// This probe ports MirrorNodeView.LatchedAlpha + SweepHideLatch (the exact per-channel latch state machine over the
// pure HideLatchPolicy) and drives the real refocus wire shape through it, asserting that the description un-sticks
// at ≤150ms with zero further deltas. It also
// replays a REAL capture when COUCHCOOP_MIRROR_RESTFOCUS_PROBE_NDJSON points at one (skips silently otherwise),
// reporting the diagnosis the plan asks for: whether the re-show carries a fade-in hint and whether first-click hints
// carry a StartOpacity.
internal static class RestFocusReplayProbe
{
    public static void Run()
    {
        SyntheticRefocus_DescriptionUnsticksBy150ms();
        SyntheticZeroWriteNeverStartsClock_SettleKeepsFullGrace();
        RealCaptureReplay_OptionalEnvGated();
        StreamReconstruction_PostFixCapture_DescriptionAlphaExceedsHalf();
    }

    // A faithful port of MirrorNodeView's per-channel hide-latch (LatchedAlpha + SweepHideLatch held-restore) over the
    // pure HideLatchPolicy — the SAME logic the native client runs, so the synthetic assertions bind the real fix.
    private sealed class LatchSim
    {
        private bool _latched;
        private double _restingA;
        private long _armMs;
        private long _heldRestoreMs; // 0 = not started

        public bool Latched => _latched;

        public void Arm(double restingA, long nowMs)
        {
            _latched = true;
            _restingA = restingA;
            _armMs = nowMs;
            _heldRestoreMs = 0;
        }

        // Port of LatchedAlpha: returns the WRITTEN alpha (0 while held, incoming on cancel/expire).
        public double Write(double incoming, bool visible, long nowMs)
        {
            if (!_latched)
            {
                return incoming;
            }

            double elapsed = nowMs - _armMs;
            double? heldRestoreElapsed = HeldRestoreElapsed(nowMs);
            var decision = HideLatchPolicy.Decide(true, _restingA, incoming, visible, elapsed, heldRestoreElapsed);
            if (decision == HideLatchPolicy.Decision.Hold)
            {
                if (incoming > HideLatchPolicy.AlphaEps && _heldRestoreMs == 0)
                {
                    _heldRestoreMs = nowMs; // start the clock on the first resting-valued Hold (never on a ≈0 write)
                }

                return 0d;
            }

            _latched = false;
            return incoming;
        }

        // Port of SweepHideLatch: returns the re-applied streamed alpha on a self-heal expiry, else NaN (no change).
        public double Sweep(long nowMs, double streamedA, bool tweenOwned)
        {
            if (!_latched)
            {
                return double.NaN;
            }

            bool graceExpired = (nowMs - _armMs) >= HideLatchPolicy.GraceMs;
            double? heldRestoreElapsed = HeldRestoreElapsed(nowMs);
            bool heldExpired = heldRestoreElapsed is >= HideLatchPolicy.HeldRestoreGraceMs;
            if (!graceExpired && !heldExpired)
            {
                return double.NaN;
            }

            _latched = false;
            return !tweenOwned ? streamedA : double.NaN;
        }

        private double? HeldRestoreElapsed(long nowMs)
        {
            if (_heldRestoreMs == 0)
            {
                return null;
            }

            return nowMs - _heldRestoreMs;
        }
    }

    private const double Resting = 1.0;

    // The resting-alpha re-show is clamped, then the sweep self-heals it at ≤150ms with no further
    // streamed write — the description reappears.
    private static void SyntheticRefocus_DescriptionUnsticksBy150ms()
    {
        var sim = new LatchSim();
        sim.Arm(Resting, nowMs: 0); // the earlier fade-OUT settled → latch armed

        // The hint-less refocus re-show: a plain resting-alpha (1) write, visible. Clamped to 0 (looks like the flash).
        Check.That(sim.Write(incoming: Resting, visible: true, nowMs: 10) == 0d,
            "refocus resting write is CLAMPED to 0 (armed latch)");

        // <150ms after the hold, no further write: the sweep keeps it at 0.
        Check.That(double.IsNaN(sim.Sweep(nowMs: 100, streamedA: Resting, tweenOwned: false)),
            "sweep at 90ms held (<150) does not release yet");

        // ≥150ms after the hold: the sweep self-heals — re-applies the streamed resting alpha (the description shows).
        double healed = sim.Sweep(nowMs: 170, streamedA: Resting, tweenOwned: false);
        Check.That(!double.IsNaN(healed) && System.Math.Abs(healed - Resting) < 1e-9,
            $"sweep at 160ms held (≥150) self-heals to the resting alpha (visible), got {healed:0.###}");
        Check.That(!sim.Latched, "the latch released on the held-restore expiry");
    }


    // A ≈0 write (the tween settle / a hidden re-affirm) must NOT start the held-restore clock, so the full 400ms
    // grace is preserved for a genuine disappear — only a resting-VALUED write ever arms the short expiry.
    private static void SyntheticZeroWriteNeverStartsClock_SettleKeepsFullGrace()
    {
        var sim = new LatchSim();
        sim.Arm(Resting, nowMs: 0);

        // The settle endpoint ≈0 held (keeps the latch, does NOT start the held-restore clock).
        Check.That(sim.Write(incoming: 0d, visible: true, nowMs: 5) == 0d, "≈0 settle write held at 0");
        // A ≈0 re-affirm well past 150ms still does not self-heal (the clock never started).
        Check.That(double.IsNaN(sim.Sweep(nowMs: 300, streamedA: Resting, tweenOwned: false)),
            "no held-restore expiry from ≈0 writes — the disappear keeps its full 400ms grace");
        Check.That(sim.Latched, "latch still armed at 300ms (only a resting-valued write starts the short clock)");
    }

    // Optional: replay the REAL rest-site refocus capture (audit-rest-refocus.ndjson). Confirms the diagnosis on live
    // data — a description node whose streamed modulate.a fades to ≈0 then is RESTORED to ≈resting with NO fade-in
    // hint — and reports whether any opacity hint carries a StartOpacity (the plan's first-click question). Then drives
    // the streamed alpha sequence through the current LatchSim. Skips SILENTLY without the env var so the suite stays
    // green in a plain checkout.
    private static void RealCaptureReplay_OptionalEnvGated()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_RESTFOCUS_PROBE_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var deltas = ReadDeltas(path);

        // Summarise every modulate/self_modulate:a hint: which targets get a fade-OUT (endOpacity≈0) vs a fade-IN
        // (endOpacity>0), and whether a StartOpacity ships. Directly answers the plan's diagnosis questions.
        int fadeIn = 0, fadeOut = 0, fadeInWithStart = 0;
        var fadeInTargets = new HashSet<string>(StringComparer.Ordinal);
        foreach (var d in deltas)
        {
            foreach (var h in d.Hints)
            {
                if (!IsOpacityProperty(h.Property) || h.EndOpacity is not { } end)
                {
                    continue;
                }

                if (end <= HideLatchPolicy.AlphaEps)
                {
                    fadeOut++;
                }
                else
                {
                    fadeIn++;
                    fadeInTargets.Add(h.TargetId);
                    if (h.StartOpacity is not null)
                    {
                        fadeInWithStart++;
                    }
                }
            }
        }

        Console.Error.WriteLine(
            $"[restfocus] capture={Path.GetFileName(path)} deltas={deltas.Count} opacityHints: fadeOut={fadeOut} fadeIn={fadeIn} fadeInWithStartOpacity={fadeInWithStart}");

        // Pick the description node: env-overridable, else auto-detect a node whose streamed modulate.a dips to ≈0 and
        // is later restored to ≈resting (>0.5) — the re-show. Track it through the LatchSim.
        var descId = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_RESTFOCUS_DESCID");
        descId ??= AutoDetectRestoredNode(deltas);
        if (descId is null)
        {
            Console.Error.WriteLine("[restfocus] no restored (fade→resting) node auto-detected; set COUCHCOOP_MIRROR_RESTFOCUS_DESCID to inspect one");
            return;
        }

        bool reShowHasFadeInHint = fadeInTargets.Contains(descId);
        Console.Error.WriteLine(
            $"[restfocus] description id={descId}: re-show carries a fade-IN hint? {reShowHasFadeInHint} (defect diagnosis expects FALSE — hint-less re-show)");

        // Drive the description's streamed modulate.a sequence through the latch: arm on the fade-out settle (first
        // ≈0), then feed each later streamed alpha and report whether the current latch releases it.
        bool unstuck = DriveLatchOverStreamedAlpha(deltas, descId);
        Console.Error.WriteLine($"[restfocus] latch replay: current-latch un-sticks={unstuck}");
        Check.That(unstuck, "current latch: the description un-sticks over the real streamed alpha sequence");
    }

    // WS-REST7 FIX 4 (producer prune-exemption + visible-neutralization) proof over a REAL streamed capture. Unlike
    // the synthetic latch probes above (which model the CLIENT), this reconstructs the STREAMED scene from a fresh
    // POST-FIX audit-rest-refocus capture and asserts the description node's streamed modulate.a DIPS to ≈0 after an
    // unfocus and then LATER EXCEEDS 0.5 on the refocus fade-in — i.e. the producer now actually EMITS the reveal
    // (previously the node was pruned every tick because its ChoicesScreen-chain Visible read false, so its fade-in
    // never streamed). Over the EXISTING PRE-fix capture the same node's alpha never exceeds ≈0, so no dip→restore
    // node is detected and the first assertion fails — the contrast the plan asks for. Env-gated on
    // COUCHCOOP_MIRROR_RESTFOCUS_STREAM_NDJSON (fresh post-fix capture); skips SILENTLY without it so a plain checkout
    // stays green. COUCHCOOP_MIRROR_RESTFOCUS_STREAM_DESCID pins the description id; else it is auto-detected.
    private static void StreamReconstruction_PostFixCapture_DescriptionAlphaExceedsHalf()
    {
        var path = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_RESTFOCUS_STREAM_NDJSON");
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return;
        }

        var deltas = ReadDeltas(path);

        // Pick the description node: env-overridable, else auto-detect a node whose streamed modulate.a dipped to ≈0
        // and was later restored above 0.5 (the streamed refocus reveal the FIX now emits). Over a PRE-fix capture no
        // such node exists (the fade-in was pruned) → descId is null and this assertion fails (the intended contrast).
        var descId = Environment.GetEnvironmentVariable("COUCHCOOP_MIRROR_RESTFOCUS_STREAM_DESCID");
        descId ??= AutoDetectRestoredNode(deltas);
        Check.That(descId is not null,
            "post-fix capture has a description node whose streamed alpha dips to ≈0 then is restored (>0.5) — the streamed refocus reveal; PRE-fix no such node exists (the fade-in was pruned, never emitted)");

        // Reconstruct the STREAMED scene and track the description's modulate.a: confirm it DIPPED to ≈0 (post-unfocus)
        // and that AFTER that dip it EXCEEDED 0.5 (the refocus fade-in the producer now streams — the FIX). Pure
        // producer-stream assertion; no client hide-latch involved.
        var state = MirrorState.Create();
        bool dipped = false;
        double maxAfterDip = 0d;
        foreach (var delta in deltas)
        {
            SceneTreeApplier.ApplySceneDelta(state, delta);
            if (state.Nodes.TryGetValue(descId!, out var n) && state.ChangedIds.Contains(descId!))
            {
                double a = StreamedAlpha(n);
                if (!dipped)
                {
                    if (a <= HideLatchPolicy.AlphaEps)
                    {
                        dipped = true;
                    }
                }
                else if (a > maxAfterDip)
                {
                    maxAfterDip = a;
                }
            }

            state.ChangedIds.Clear();
        }

        Check.That(dipped, $"description id={descId} streamed a fade-OUT to ≈0 (the post-unfocus dip) in the capture");
        Check.That(maxAfterDip > 0.5,
            $"description id={descId} streamed alpha EXCEEDS 0.5 AFTER the post-unfocus dip (peak {maxAfterDip:0.###}) — the producer now emits the refocus reveal; PRE-fix this stays ≈0 (the fade-in was pruned)");
    }

    // Auto-detect a node whose streamed modulate.a fell to ≈0 and was later restored to ≈resting (>0.5) — the re-show.
    private static string? AutoDetectRestoredNode(List<MirrorDelta> deltas)
    {
        var state = MirrorState.Create();
        var everDipped = new HashSet<string>(StringComparer.Ordinal);
        foreach (var delta in deltas)
        {
            SceneTreeApplier.ApplySceneDelta(state, delta);
            foreach (var id in state.ChangedIds)
            {
                if (!state.Nodes.TryGetValue(id, out var n))
                {
                    continue;
                }

                double a = StreamedAlpha(n);
                if (a <= HideLatchPolicy.AlphaEps)
                {
                    everDipped.Add(id);
                }
                else if (a > 0.5 && everDipped.Contains(id))
                {
                    return id; // dipped then restored to resting — the re-show
                }
            }

            state.ChangedIds.Clear();
        }

        return null;
    }

    // Replay the node's streamed modulate.a: arm the latch at the first ≈0 (fade settle), then feed each later streamed
    // alpha through the current LatchSim and sweep between deltas. Returns whether the node becomes visible.
    private static bool DriveLatchOverStreamedAlpha(List<MirrorDelta> deltas, string descId)
    {
        var state = MirrorState.Create();
        var sim = new LatchSim();
        bool armed = false;
        bool unstuck = false;
        long t = 0;

        foreach (var delta in deltas)
        {
            t += 16; // approximate one drain at ~60fps (the capture has no per-delta wall-clock we can trust here)
            SceneTreeApplier.ApplySceneDelta(state, delta);
            if (state.Nodes.TryGetValue(descId, out var n) && state.ChangedIds.Contains(descId))
            {
                double a = StreamedAlpha(n);
                bool visible = n.Visible;
                if (!armed && a <= HideLatchPolicy.AlphaEps)
                {
                    sim.Arm(Resting, t);
                    armed = true;
                }
                else if (armed)
                {
                    double written = sim.Write(a, visible, t);
                    if (written > 0.5) { unstuck = true; }
                }
            }

            // Sweep each drain for the drain-starvation + held-restore self-heal path.
            if (armed)
            {
                double healed = sim.Sweep(t, Resting, tweenOwned: false);
                if (!double.IsNaN(healed) && healed > 0.5) { unstuck = true; }
            }

            state.ChangedIds.Clear();
        }

        return unstuck;
    }

    private static double StreamedAlpha(MirrorNode n) => n.Modulate is { } m ? m.A : n.Opacity;

    private static bool IsOpacityProperty(string property) =>
        property is "modulate:a" or "modulate" or "self_modulate:a" or "self_modulate";

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
}
