import { describe, expect, it } from "vitest";

// @ts-expect-error The CLI-owned ESM helper stays plain JavaScript so Node can import it without a build step.
import { h15CoordinateVerdict, h15FocusedGrabFailure, planH15FifthPlay } from "../../../../scripts/lib/h15-plan.mjs";

describe("H15 deterministic planning", () => {
  it("stages one over-slop point before the semantic board destination", () => {
    expect(planH15FifthPlay({ cx: 100, cy: 800 }, { cx: 100, cy: 300 })).toEqual({
      from: { cx: 100, cy: 800 },
      to: { cx: 100, cy: 300 },
      overSlop: { cx: 100, cy: 768 },
    });
    expect(planH15FifthPlay({ cx: 100, cy: 100 }, { cx: 100.5, cy: 100.5 })).toBeNull();
  });

  it("treats only Y as raw for the independent dead-space sentinel", () => {
    const verdict = h15CoordinateVerdict([{ coordX: 960, coordY: 380 }], { gx: 1200, gy: 380 });
    expect(verdict.raw).toBe(true); // wide-stage squeeze changed X, but no raise inverse changed Y
    expect(verdict.corrected).toBe(false);
  });

  function completeEvidence(pointerKind: "mouse" | "touch" = "touch") {
    return {
      pointerKind,
      dead: { raw: true, corrected: false },
      upperCoordinates: { corrected: true },
      positive: { focused: true, raiseSettled: true, contactHeld: true },
      focusedGrab: {
        startInsideNativeHitbox: true,
        nativePress: { focusedAtNativeY: true },
        pressedInput: { pressed: true } as { pressed: boolean } | null,
        pressedInsideNativeHitbox: true,
        pressedResolvesToTarget: true,
        leftFan: true,
        restored: true,
      },
    };
  }

  it("reports every strict focused-grab predicate in priority order", () => {
    const cases = [
      { name: "dead point was not raw", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.dead.raw = false; }, expected: "the fixed board-empty point was not sent raw while the fourth survivor was raised" },
      { name: "dead point was raise-corrected", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.dead.corrected = true; }, expected: "the fixed board-empty point was not sent raw while the fourth survivor was raised" },
      { name: "upper band was not corrected", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.upperCoordinates.corrected = false; }, expected: "the fourth survivor's raised-only upper band sent no raise-corrected coordinate" },
      { name: "positive sample did not focus", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.positive.focused = false; }, expected: "the raised-only fourth-card sample did not focus its own holder by zFocus and poseFocus" },
      { name: "positive sample did not settle", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.positive.raiseSettled = false; }, expected: "the focused fourth survivor did not settle its raiseDy at zero while held" },
      { name: "touch contact was released", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.positive.contactHeld = false; }, expected: "the H15 positive touch peek released before its focused dy=0 contact reached the over-slop press" },
      { name: "touch began outside its native OBB", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.startInsideNativeHitbox = false; }, expected: "the retained H15 touch contact was not inside its focused holder's native hitbox" },
      { name: "native press was not at focused dy zero", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.nativePress.focusedAtNativeY = false; }, expected: "the H15 fourth-survivor grab did not send its native press while that holder was focused at dy zero" },
      { name: "pressed edge was absent", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.pressedInput = null; }, expected: "the H15 fourth-survivor grab emitted no coordinate-only pressed:true edge" },
      { name: "touch pressed outside its native OBB", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.pressedInsideNativeHitbox = false; }, expected: "the H15 coordinate-only pressed:true edge did not resolve inside its focused holder's native hitbox" },
      { name: "touch pressed for another owner", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.pressedResolvesToTarget = false; }, expected: "the H15 coordinate-only pressed:true edge resolved to a native owner other than its focused holder" },
      { name: "holder did not leave the fan", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.leftFan = false; }, expected: "the focused fourth survivor did not leave the fan when H15 grabbed it" },
      { name: "holder did not rejoin", mutate: (evidence: ReturnType<typeof completeEvidence>) => { evidence.focusedGrab.restored = false; }, expected: "the H15 fourth-survivor grab did not safely cancel back into a whole fan" },
    ];

    for (const testCase of cases) {
      const evidence = completeEvidence();
      testCase.mutate(evidence);
      expect(h15FocusedGrabFailure(evidence), testCase.name).toBe(testCase.expected);
    }
  });

  it("keeps the contact and native-OBB assertions touch-specific, while retaining shared mouse gates", () => {
    const mouse = completeEvidence("mouse");
    mouse.positive.contactHeld = false;
    mouse.focusedGrab.startInsideNativeHitbox = false;
    mouse.focusedGrab.pressedInsideNativeHitbox = false;
    mouse.focusedGrab.pressedResolvesToTarget = false;
    expect(h15FocusedGrabFailure(mouse)).toBeNull();

    mouse.focusedGrab.leftFan = false;
    expect(h15FocusedGrabFailure(mouse)).toBe("the focused fourth survivor did not leave the fan when H15 grabbed it");
  });
});
