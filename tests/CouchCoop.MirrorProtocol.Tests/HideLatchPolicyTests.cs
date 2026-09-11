using CouchCoop.MirrorProtocol.SceneModel;
using D = CouchCoop.MirrorProtocol.SceneModel.HideLatchPolicy.Decision;

namespace CouchCoop.MirrorProtocol.Tests;

// Unit tests for HideLatchPolicy.Decide — the tween hide-latch state machine (Feature B / WS-VIEW). Full
// hold/cancel/expire matrix, including a non-1 resting alpha (0.75).
internal static class HideLatchPolicyTests
{
    private const double Grace = HideLatchPolicy.GraceMs; // 400
    private const double Mid = Grace / 2;                 // within the window

    private const double HeldGrace = HideLatchPolicy.HeldRestoreGraceMs; // 150

    public static void Run()
    {
        NotLatchedCancels();
        RestingFlashHolds();
        SettleAndReaffirmZeroHold();
        RevealRampCancels();
        HiddenCancels();
        ExpiryExpires();
        RestingNotOne();
        HeldRestoreMatrix();
    }

    private static void Eq(D actual, D expected, string label) => Check.Equal(actual, expected, label);

    // Defensive: an unlatched channel always writes through.
    private static void NotLatchedCancels()
    {
        Eq(HideLatchPolicy.Decide(latched: false, restingA: 1.0, incomingA: 1.0, visible: true, elapsedMs: 0, heldRestoreElapsedMs: null),
            D.Cancel, "not latched → Cancel");
    }

    // The core case: within grace, visible, the producer restores the resting alpha (1.0) → Hold (clamp to 0).
    private static void RestingFlashHolds()
    {
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, null), D.Hold, "resting flash (1.0) → Hold");
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.99, true, Mid, null), D.Hold, "resting flash within RestingEps → Hold");
    }

    // The tween settle write (≈0) and any producer re-affirm of the hidden state → Hold (keep 0, keep the latch).
    private static void SettleAndReaffirmZeroHold()
    {
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.0, true, 0, null), D.Hold, "settle endpoint 0 → Hold (keep latch)");
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.005, true, Mid, null), D.Hold, "re-affirm ≈0 → Hold");
    }

    // A reveal RAMP — an alpha that is neither ≈0 nor ≈resting — is a genuine fade-in → Cancel (write through).
    private static void RevealRampCancels()
    {
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.5, true, Mid, null), D.Cancel, "mid-ramp 0.5 → Cancel");
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.3, true, Mid, null), D.Cancel, "ramp 0.3 → Cancel");
    }

    // The producer hid the node (¬visible) → no flash to suppress → Cancel.
    private static void HiddenCancels()
    {
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, false, Mid, null), D.Cancel, "resting-but-hidden → Cancel");
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.0, false, Mid, null), D.Cancel, "hidden ≈0 → Cancel");
    }

    // The grace window elapsed (checked BEFORE the value tests) → Expire, even for a would-be Hold value.
    private static void ExpiryExpires()
    {
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Grace, null), D.Expire, "at grace boundary → Expire");
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Grace + 50, null), D.Expire, "past grace → Expire");
    }

    // A non-1 resting alpha (0.75): the flash restores 0.75 → Hold; a ramp value away from 0.75 → Cancel.
    private static void RestingNotOne()
    {
        Eq(HideLatchPolicy.Decide(true, 0.75, 0.75, true, Mid, null), D.Hold, "resting 0.75 flash → Hold");
        Eq(HideLatchPolicy.Decide(true, 0.75, 0.74, true, Mid, null), D.Hold, "resting 0.75 within RestingEps → Hold");
        Eq(HideLatchPolicy.Decide(true, 0.75, 0.72, true, Mid, null), D.Cancel, "0.72 (>RestingEps from 0.75) → Cancel");
        Eq(HideLatchPolicy.Decide(true, 0.75, 0.0, true, Mid, null), D.Hold, "resting 0.75, incoming ≈0 → Hold");
    }

    // WS-REST held-restore short expiry (the 6th `heldRestoreElapsedMs` argument). The rest-site refocus/first-click
    // re-show is a resting-valued write with no fade-in hint; once it has been HELD ≥ HeldRestoreGraceMs (150ms) it is
    // a genuine reveal → Expire (release). Block-badge parity: a ≈0 write never expires on the held clock, a not-visible
    // hide still Cancels first, and a null clock describes the first hold.
    private static void HeldRestoreMatrix()
    {
        // first-hold: the clock has not started yet → still a Hold (the clamp that starts the clock).
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, heldRestoreElapsedMs: null), D.Hold,
            "held-restore first hold (clock not started) → Hold");

        // <150ms held → still Hold (within the short window).
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, heldRestoreElapsedMs: 100), D.Hold,
            "held 100ms (<150) → Hold");
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, heldRestoreElapsedMs: HeldGrace - 1), D.Hold,
            "held 149ms (<150) → Hold");

        // ≥150ms held → Expire (the genuine hint-less reveal is released), even well inside the 400ms arm grace.
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, heldRestoreElapsedMs: HeldGrace), D.Expire,
            "held 150ms (=grace) → Expire");
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, true, Mid, heldRestoreElapsedMs: HeldGrace + 200), D.Expire,
            "held 350ms → Expire");
        Eq(HideLatchPolicy.Decide(true, 0.75, 0.75, true, Mid, heldRestoreElapsedMs: HeldGrace), D.Expire,
            "held 150ms, resting 0.75 → Expire");

        // not-visible BEFORE 150ms → Cancel (the ¬visible hide check precedes the held-restore expiry — the block-badge
        // guarantee: its real hide lands well inside 150ms and wins).
        Eq(HideLatchPolicy.Decide(true, 1.0, 1.0, false, Mid, heldRestoreElapsedMs: 100), D.Cancel,
            "not-visible before 150 → Cancel (hide wins)");

        // ≈0 write never expires on the held clock (MirrorNodeView never STARTS the clock on ≈0; even if a caller
        // passed a large elapsed here, a hidden re-affirm must stay a Hold, not flash the node visible).
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.0, true, Mid, heldRestoreElapsedMs: HeldGrace + 500), D.Hold,
            "≈0 write with a large held elapsed → Hold (never held-expires)");
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.005, true, Mid, heldRestoreElapsedMs: HeldGrace + 500), D.Hold,
            "re-affirm ≈0 with large held elapsed → Hold");

        // A reveal RAMP still Cancels regardless of the held clock (it's a genuine show either way).
        Eq(HideLatchPolicy.Decide(true, 1.0, 0.5, true, Mid, heldRestoreElapsedMs: HeldGrace + 500), D.Cancel,
            "reveal ramp with large held elapsed → Cancel");
    }
}
