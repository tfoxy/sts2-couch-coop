import { afterEach, describe, expect, it } from "vitest";
import { emitWarmAckTrace, warmAckTraceEnabled, type WarmAckTraceEvent } from "@/mirror/warmAckTrace";

const globalWithTrace = globalThis as typeof globalThis & {
  __benchWarmAckTrace?: (event: WarmAckTraceEvent) => void
};
afterEach(() => { delete globalWithTrace.__benchWarmAckTrace; });

describe("opt-in warm ack trace", () => {
  it("does nothing when absent and never propagates observer errors", () => {
    expect(warmAckTraceEnabled()).toBe(false);
    expect(() => emitWarmAckTrace({ kind: "absent", revision: 1 })).not.toThrow();
    globalWithTrace.__benchWarmAckTrace = () => { throw new Error("observer failure"); };
    expect(warmAckTraceEnabled()).toBe(true);
    expect(() => emitWarmAckTrace({ kind: "throwing", revision: 2 })).not.toThrow();
  });

  it("emits only the supplied scalar event", () => {
    const events: WarmAckTraceEvent[] = [];
    globalWithTrace.__benchWarmAckTrace = event => events.push(event);
    emitWarmAckTrace({ kind: "ack-guard", revision: 31, clientId: 2, guard: "empty" });
    expect(events).toEqual([{ kind: "ack-guard", revision: 31, clientId: 2, guard: "empty" }]);
  });
});
