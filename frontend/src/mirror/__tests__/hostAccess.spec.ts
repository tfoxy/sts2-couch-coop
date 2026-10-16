import { describe, expect, it } from "vitest";
import { connectMirrorClient } from "@/mirror/mirrorClient";
import { normalizeHostAccess } from "@/protocol/browserEnvelope";

class Socket extends EventTarget {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  constructor(_url: string) { super(); Socket.current = this; }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  emit(raw: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(raw) })); }
  access(allowed: boolean, generation: number) {
    this.emit({ type: "host-access", hostAccess: { allowed, reason: allowed ? "allowed" : "menu-open", generation } });
  }
}
const frame = { type: "scene-delta", full: true, screenType: "run", upserts: [
  { id: "root", name: "Root", nodeType: "Control", visible: true }
], orderedIds: ["root"], removedIds: [] };
const session = { type: "session", hostName: "host", scrollAction: true, players: [],
  session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 },
  screen: { kind: "run", type: null, title: null, mirrorMode: "mp-run" } };
function connect() {
  const client = connectMirrorClient({ WebSocketCtor: Socket as unknown as typeof WebSocket,
    location: { href: "http://localhost/", protocol: "http:" } });
  return { client, socket: Socket.current };
}

describe("host access", () => {
  it("fails closed on absent, malformed and unknown permissions", () => {
    for (const value of [null, {}, { allowed: true, reason: "future", generation: 1 },
      { allowed: true, reason: "menu-open", generation: 1 },
      { allowed: true, reason: "allowed", generation: -1 },
      { allowed: true, reason: "allowed", generation: 1, sceneResetGeneration: -1 }]) {
      expect(normalizeHostAccess(value).allowed).toBe(false);
    }
    const { client, socket } = connect();
    socket.emit(session);
    socket.emit(frame);
    client.sendInput({ kind: "key", key: "Enter", pressed: true });
    expect(client.state.nodes.size).toBe(0);
    expect(socket.sent).toEqual([]);
  });

  it("clears retained frames and hints, blocks all control kinds, and keeps coordination available", () => {
    const { client, socket } = connect();
    socket.access(true, 1);
    socket.emit(frame);
    expect(client.state.nodes.size).toBe(1);
    socket.access(false, 2);
    socket.emit(frame);
    for (const kind of ["hover", "click", "key", "pad"] as const) client.sendInput({ kind });
    expect(client.sendAction({ semanticActionId: "set-scroll-offset" })).toBeNull();
    client.sendSceneAck();
    client.sendSettings({ refreshRate: 12, freezeParticles: true, freezeSpines: true, freezeDecor: true });
    expect(socket.sent).toEqual([]);
    expect(client.state.nodes.size).toBe(0);
    expect(client.state.orderedIds).toEqual([]);
    expect(client.state.pendingHints).toEqual([]);
    expect(client.state.pendingCardFlights).toEqual([]);
    client.sendSettings({ staticBg: true, trailDrive: true, tweenReplay: true, refreshRate: 12 });
    client.sendJoin("Alice");
    client.sendWatch(false);
    expect(socket.sent.map(message => message.type)).toEqual(["settings", "join", "watch"]);
    expect(socket.sent[0]).not.toHaveProperty("refreshRate");
  });

  it("requires a fresh full frame after each reopening and ignores stale status/session generations", () => {
    const { client, socket } = connect();
    socket.access(true, 1);
    socket.emit(frame);
    for (const generation of [2, 4, 6]) {
      socket.access(false, generation);
      socket.emit({ ...session, hostAccess: { allowed: true, reason: "allowed", generation: generation - 1 } });
      socket.access(true, generation - 1);
      socket.emit(frame);
      expect(client.hostAccess.allowed).toBe(false);
      expect(client.session?.hostAccess?.allowed).toBe(false);
      expect(client.state.nodes.size).toBe(0);
      socket.access(true, generation + 1);
      socket.emit({ ...frame, full: false });
      expect(client.state.nodes.size).toBe(0);
      socket.emit(frame);
      expect(client.state.nodes.size).toBe(1);
    }
  });

  it("retains the displayed tree through loading, rejects deltas until a fresh full scene, and preserves ordinary refreshes", () => {
    const { client, socket } = connect();
    const access = (allowed: boolean, generation: number, reason = allowed ? "allowed" : "transitioning", sceneResetGeneration = 0) =>
      socket.emit({ type: "host-access", hostAccess: { allowed, reason, generation, sceneResetGeneration } });
    access(true, 1);
    socket.emit(frame);
    const node = client.state.nodes.get("root");
    const revision = client.state.revision;
    access(true, 1); // map/deck/roster refresh with unchanged permission
    expect(client.state.revision).toBe(revision);
    expect(client.sceneGeneration).toBe(1);
    access(false, 2);
    expect(client.state.nodes.get("root")).toBe(node);
    expect(client.sceneGeneration).toBeNull();
    socket.emit(frame);
    expect(client.state.revision).toBe(revision);
    client.sendInput({ kind: "key", key: "Enter", pressed: false });
    client.sendSceneAck();
    expect(socket.sent).toEqual([]);
    access(true, 3);
    socket.emit({ ...frame, full: false });
    expect(client.sceneGeneration).toBeNull();
    expect(client.state.nodes.get("root")).toBe(node);
    socket.emit(frame);
    expect(client.sceneGeneration).toBe(3);
    // A menu-open update may be coalesced away; its reset epoch must still clear the displayed scene.
    access(true, 6, "allowed", 1);
    expect(client.state.nodes.size).toBe(0);
    expect(client.sceneGeneration).toBeNull();
    access(false, 7, "transitioning", 1);
    expect(client.state.nodes.size).toBe(0);
  });

  it("keeps a separate allowed instance live while the host control socket is denied", () => {
    const host = connect();
    const seat = connect();
    host.socket.access(false, 2);
    seat.socket.access(true, 0);
    seat.socket.emit(frame);
    seat.client.sendInput({ kind: "click", pressed: true });
    expect(host.client.state.nodes.size).toBe(0);
    expect(seat.client.state.nodes.size).toBe(1);
    expect(seat.socket.sent[0]).toMatchObject({ type: "input", kind: "click" });
  });
});
