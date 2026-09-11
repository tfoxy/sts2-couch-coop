import { describe, expect, it, vi } from "vitest";

import { createPressModalityTracker } from "@/inputModality";

function pointer(pointerType: string): Event {
  const event = new Event("pointerdown");
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("press modality tracker", () => {
  it("starts unknown, ignores touch pointerdown, and alternates the listener that can change modality", () => {
    const target = new EventTarget();
    const added = vi.spyOn(target, "addEventListener");
    const removed = vi.spyOn(target, "removeEventListener");
    const tracker = createPressModalityTracker(target);
    const changes: string[] = [];
    tracker.subscribe((next) => changes.push(next));

    expect(tracker.current()).toBe("unknown");
    target.dispatchEvent(pointer("touch"));
    expect(tracker.current()).toBe("unknown");

    target.dispatchEvent(new Event("touchstart"));
    expect(tracker.current()).toBe("touch");
    expect(changes).toEqual(["touch"]);
    expect(removed).toHaveBeenCalledWith("touchstart", expect.any(Function));

    // The synthetic pointerdown paired with that touch is ignored, while mouse takes over and swaps listeners.
    target.dispatchEvent(pointer("touch"));
    expect(tracker.current()).toBe("touch");
    target.dispatchEvent(pointer("mouse"));
    expect(tracker.current()).toBe("pointer");
    expect(changes).toEqual(["touch", "pointer"]);
    expect(removed).toHaveBeenCalledWith("pointerdown", expect.any(Function));

    target.dispatchEvent(new Event("touchstart"));
    expect(tracker.current()).toBe("touch");
    expect(changes).toEqual(["touch", "pointer", "touch"]);
    expect(added.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(2);
    tracker.dispose();
  });

  it("treats pen as pointer modality and does not notify for repeated same-mode input", () => {
    const target = new EventTarget();
    const tracker = createPressModalityTracker(target);
    const listener = vi.fn();
    tracker.subscribe(listener);

    target.dispatchEvent(pointer("pen"));
    expect(tracker.current()).toBe("pointer");
    target.dispatchEvent(pointer("mouse")); // listener is intentionally dormant in pointer mode
    expect(listener).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });
});
