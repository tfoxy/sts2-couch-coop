import { describe, expect, it } from "vitest";
import { createFakeWorkerChannelPair } from "./fakes";

describe("createFakeWorkerChannelPair", () => {
  it("delivers postMessage asynchronously to the other endpoint's onmessage and listeners", async () => {
    const [a, b] = createFakeWorkerChannelPair();
    const received: unknown[] = [];
    b.onmessage = event => received.push(event.data);
    const viaListener: unknown[] = [];
    b.addEventListener("message", event => viaListener.push(event.data));
    a.postMessage({ kind: "hello" });
    expect(received).toEqual([]); // not yet delivered — postMessage never calls synchronously
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([{ kind: "hello" }]);
    expect(viaListener).toEqual([{ kind: "hello" }]);
  });

  it("is bidirectional and records each side's own sent transfer list", async () => {
    const [a, b] = createFakeWorkerChannelPair();
    const buffer = new ArrayBuffer(8);
    const aReceived: unknown[] = [];
    const bReceived: unknown[] = [];
    a.onmessage = event => aReceived.push(event.data);
    b.onmessage = event => bReceived.push(event.data);
    a.postMessage("to-b", [buffer]);
    b.postMessage("to-a");
    await Promise.resolve(); await Promise.resolve();
    expect(bReceived).toEqual(["to-b"]);
    expect(aReceived).toEqual(["to-a"]);
    expect(a.sent).toEqual([{ data: "to-b", transfer: [buffer] }]);
    expect(b.sent).toEqual([{ data: "to-a", transfer: [] }]);
  });

  it("removeEventListener stops further delivery to that listener", async () => {
    const [a, b] = createFakeWorkerChannelPair();
    const received: unknown[] = [];
    const listener = (event: MessageEvent): void => { received.push(event.data); };
    b.addEventListener("message", listener);
    a.postMessage(1);
    await Promise.resolve(); await Promise.resolve();
    b.removeEventListener("message", listener);
    a.postMessage(2);
    await Promise.resolve(); await Promise.resolve();
    expect(received).toEqual([1]);
  });
});
