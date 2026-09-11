// Pure state machine for the tween HIDE-LATCH (Feature B / WS-VIEW). After a fade-to-0 opacity tween settles, the game
// restores the node's alpha to its RESTING value (with Visible=true) for ONE drain BEFORE it hides/removes the node
// for pooling — and with the tween's alpha-ownership already cleared, the client writes that resting alpha straight
// through for a single frame: a 1-frame reappear FLASH. The latch clamps that lone resting-valued write back to the
// hidden state for a short grace window, then releases.
//
// The window is bounded by DESIGN, which is why a 400ms grace is safe: the defect is ≈1 drain wide, while the shortest
// LEGITIMATE re-show of a faded element is ≈1.1s away and always arrives as a NEW tween hint (which cancels the latch
// on arm). A hint-less reveal is a fade-IN RAMP whose alpha is neither ≈0 nor ≈resting → it cancels the latch on the
// first streamed write. So the grace cannot swallow a real reveal.
//
// Inputs: `latched` (is the channel latched?), `restingA` (the arm-time streamed alpha — the value the producer
// restores to, the resting SIGNATURE), `incomingA` (the streamed alpha about to be written), `visible` (the streamed
// Visible), `elapsedMs` (since arm). Output:
//   * Hold   → write the HIDDEN alpha 0: either the resting-valued flash (clamp it) or a consistent ≈0 write (the
//              tween settle / a producer re-affirm of the hidden state) — the latch STAYS armed.
//   * Cancel → release the latch and write `incomingA` through: a genuine reveal ramp, a hide (¬visible), or a
//              defensive not-latched call.
//   * Expire → release the latch (grace elapsed) and write `incomingA` through.
//
// DEVIATION (documented): the design's cancel list names "streamed alpha ≈0" as a hard CANCEL. Implemented instead as
// a HOLD (write 0, keep the latch): the tween SETTLE writes the fade endpoint (≈0) through this very machine one call
// after arming, and the producer can re-affirm alpha 0 for a drain or two BEFORE it ships the resting flash — a hard
// ≈0-cancel there would drop the just-armed latch and let the later flash leak. Holding on ≈0 is visually identical
// (0 is written either way) and the latch still releases promptly on the first reveal ramp / hide / new-tween /
// release / 400ms expiry, so it never sticks and never lets a flash through.
namespace CouchCoop.MirrorProtocol.SceneModel;

public static class HideLatchPolicy
{
    public const double AlphaEps = 0.01;     // |a| ≤ this ⇒ "hidden" / ≈0
    public const double RestingEps = 0.02;   // |a − restingA| ≤ this ⇒ the resting-valued flash
    public const double GraceMs = 400;       // the latch window (≫ the ~1-drain defect, ≪ the ~1.1s legit re-show)

    // WS-REST held-restore short expiry. The rest-site-refocus defect: the game
    // re-shows a faded option's description as a PLAIN streamed resting-alpha write with NO fade-in hint (the fade-in
    // tween was killed by the unfocus, so the producer never emits its hint). That write is value-IDENTICAL to the
    // pre-hide reappear FLASH at Decide time, so a value-based rule cannot tell them apart without regressing the
    // block-badge flash. The DISCRIMINATOR is TIME: the flash is a lone ≈1-drain write followed IMMEDIATELY (≪150ms)
    // by the node's hide (¬visible ⇒ Cancel); a genuine refocus re-show HOLDS the resting value indefinitely with no
    // hide. So a latch that has been clamping a resting-valued (>AlphaEps) write for ≥ HeldRestoreGraceMs EXPIRES —
    // revealing the option — while the block badge still Cancels first because its hide lands well inside 150ms.
    public const double HeldRestoreGraceMs = 150;

    public enum Decision
    {
        Hold,
        Cancel,
        Expire,
    }

    // `heldRestoreElapsedMs` is null until a resting-valued hold starts the clock. The caller never starts it on a
    // ≈0 write, so the short expiry can only release a genuinely-visible restore, never the hidden state.
    public static Decision Decide(
        bool latched, double restingA, double incomingA, bool visible, double elapsedMs, double? heldRestoreElapsedMs)
    {
        if (!latched)
        {
            return Decision.Cancel; // defensive: an unlatched channel writes through
        }

        if (elapsedMs >= GraceMs)
        {
            return Decision.Expire; // grace window elapsed → release
        }

        if (!visible)
        {
            return Decision.Cancel; // the node is being hidden anyway → no flash to suppress
        }

        if (System.Math.Abs(incomingA) <= AlphaEps)
        {
            return Decision.Hold; // ≈0: the hidden state (settle / producer re-affirm) → keep 0, keep the latch
        }

        if (System.Math.Abs(incomingA - restingA) <= RestingEps)
        {
            // The lone resting-valued reappear → normally clamp it back to the hidden state; but once it has been
            // held ≥ HeldRestoreGraceMs with no hide catching up, it was a genuine refocus re-show whose fade-in hint
            // was killed → EXPIRE (reveal).
            if (heldRestoreElapsedMs is >= HeldRestoreGraceMs)
            {
                return Decision.Expire;
            }

            return Decision.Hold;
        }

        return Decision.Cancel; // a reveal RAMP (neither ≈0 nor ≈resting) → a genuine show → release
    }
}
