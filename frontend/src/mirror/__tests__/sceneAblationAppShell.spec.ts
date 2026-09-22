import { mount } from "@vue/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import MirrorApp from "@/mirror/MirrorApp.vue";
import { sceneAblation } from "@/mirror/sceneAblation";
import { replaySession } from "../../../../scripts/lib/replay-session.mjs";

const prefetchGate = vi.hoisted(() => vi.fn(() => ({ resolve: vi.fn() })));

vi.mock("@/mirror/imagePrefetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/imagePrefetch")>();
  return { ...actual, createMirrorImagePrefetchGate: prefetchGate };
});

vi.mock("@/mirror/sceneAblation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/sceneAblation")>();
  return { ...actual, sceneAblation: actual.createSceneAblationRuntime({ dev: true,
    requested: { version: 1, mode: "app-shell" }, target: {} }) };
});

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

let app: ReturnType<typeof mount> | undefined;
afterEach(() => { app?.unmount(); prefetchGate.mockClear(); vi.unstubAllGlobals(); });

it("keeps a redirected app-shell socket unwatched from its first handshake", async () => {
  vi.stubGlobal("WebSocket", Socket);
  app = mount(MirrorApp, { global: { stubs: { MirrorView: true } } });
  await nextTick();
  Socket.instances[0]!.emit({ ...JSON.parse(replaySession([])), directView: false, headlessMirrorPort: 14000 });
  await nextTick();
  await nextTick();
  expect(Socket.instances).toHaveLength(2);
  const seat = Socket.instances[1]!;
  expect(new URL(seat.url).searchParams.get("watch")).toBe("0");
  seat.emit({ type: "scene-delta", full: true, screenType: "run", upserts: [], orderedIds: [] });
  await nextTick();
  expect(seat.sent.filter(value => value.type === "watch" && value.on === true)).toHaveLength(0);
  expect(sceneAblation.receipt().state.watching).toBe(false);
  expect(sceneAblation.receipt().stream.appliedBytes).toBe(0);
  expect(sceneAblation.receipt().stream.appliedRevisions).toBe(0);
  expect(prefetchGate).not.toHaveBeenCalled();
});
