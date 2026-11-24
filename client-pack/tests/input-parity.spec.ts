import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { connectMirrorClient, type MirrorInputMessage } from "../../frontend/src/mirror/mirrorClient";
import { createStreamInput } from "../../frontend/src/mirror/streamInput";

class Socket extends EventTarget {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  inputs: string[] = [];

  constructor(_url: string) {
    super();
    Socket.current = this;
  }

  send(text: string): void {
    if (JSON.parse(text).type === "input") this.inputs.push(text);
  }

  close(): void { this.readyState = 3; }

  emit(message: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

afterEach(() => vi.unstubAllGlobals());

it("matches the frontend stream press/release bytes at both live epochs", () => {
  // These are the actual wire strings collected by fake_host.py from the headless Godot run.
  const capture = process.env.COUCH_PACK_INPUTS;
  if (!capture) throw new Error("Run client-pack/test.sh to capture the pack's input messages first");
  const pack: string[] = JSON.parse(readFileSync(capture, "utf8"));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const client = connectMirrorClient({ url: "ws://offline.test/ws", watch: false,
    WebSocketCtor: Socket as unknown as typeof WebSocket });
  const socket = Socket.current;
  socket.emit({ type: "host-access", hostAccess: { allowed: true, reason: "allowed", generation: 0 } });
  const stage = document.createElement("div");
  stage.setPointerCapture = () => {};
  stage.releasePointerCapture = () => {};
  stage.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 1280,
    height: 800, right: 1280, bottom: 800, toJSON: () => ({}) });
  document.body.append(stage);
  const input = createStreamInput({
    stage,
    getClient: () => ({ clientToGame: () => ({ point: { x: 812, y: 640 }, item: 99, drawn: { x: 100, y: 200 } }) }),
    send: (message: MirrorInputMessage) => {
      // The app attaches the renderer's live epoch before forwarding stream input.
      if (message.kind === "click") client.sendInput({ ...message,
        presentationEpoch: client.session?.rendererState?.presentationEpoch });
    }
  });
  try {
    for (const epoch of [42, 43]) {
      socket.emit({ type: "session", session: { name: "Offline player", status: "assigned", joined: true,
        playerId: "player", connectionCount: 1 }, players: [],
        screen: { kind: "run", type: "Run", title: "Run", mirrorMode: "mp-run" },
        hostName: "host", scrollAction: true,
        hostAccess: { allowed: true, reason: "allowed", generation: 0 },
        rendererState: { state: "armed", presentationEpoch: epoch, presentationReady: true,
          presentationWidth: 1920, presentationHeight: 1080 } });
      expect(client.session?.rendererState?.presentationEpoch).toBe(epoch);
      for (const type of ["pointerdown", "pointerup"]) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 200, button: 0 });
        Object.defineProperties(event, { pointerType: { value: "mouse" }, pointerId: { value: 1 } });
        stage.dispatchEvent(event);
      }
    }
    expect(socket.inputs).toHaveLength(4);
    expect(pack.map(text => JSON.parse(text))).toEqual(socket.inputs.map(text => JSON.parse(text)));
    expect(pack).toEqual(socket.inputs);
  } finally {
    input.dispose();
    client.close();
    stage.remove();
  }
});
