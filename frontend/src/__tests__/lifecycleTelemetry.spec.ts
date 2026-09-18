import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.replaceChildren();
});

describe("lifecycle telemetry delivery", () => {
  it("serializes checkpoint batches so a later POST cannot overtake an earlier one", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const nonce = "0123456789abcdef0123456789abcdef";
    const content = btoa(JSON.stringify({ endpoint: "/__couchcoop/lifecycle", nonce }));
    document.head.innerHTML = `<meta name="couchcoop-lifecycle" content="${content}" />`;

    let resolveFirst: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const telemetry = await import("../lifecycleTelemetry");
    telemetry.installLifecycleTelemetry();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    telemetry.sceneCheckpoint("scene-received");
    telemetry.sceneCheckpoint("render-begin");
    telemetry.sceneCheckpoint("frame-presented");
    telemetry.sceneCheckpoint("ack-sent");
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst?.(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
