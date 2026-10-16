import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("direct-IP HTTPS browser routes", () => {
  it.each(["192.168.0.123", "10.0.0.7"])("keeps all browser lanes secure on %s", async (ip) => {
    vi.resetModules();
    const page = new URL(`https://${ip}:13337/?name=Player`);
    vi.stubGlobal("location", page);
    vi.stubGlobal("__couchCoopHostBase", undefined);
    const { hostBase, hostUrl, isRemoteHosted } = await import("@/join/hostBase");
    const client = await import("@/mirror/mirrorClient");
    const { tmpSfxUrl } = await import("@/audio/audioRoutes");
    expect(hostBase()).toBe(page.origin);
    expect(isRemoteHosted()).toBe(false);
    for (const route of [hostUrl("/res/images/card.png"), client.audioTakeIndexUrl(),
      tmpSfxUrl("res://debug_audio/hit.mp3", "build")!]) {
      expect(new URL(route, page).origin).toBe(page.origin);
    }
    const sockets = [
      client.buildMirrorWebSocketUrl(page),
      client.buildSeatMirrorWebSocketUrl("/ws?seat=seat-a", page),
      client.buildHeadlessMirrorWebSocketUrl(13357, page),
      client.buildAudioRenderWebSocketUrl(page.href),
      client.buildAudioSeatWebSocketUrl("/ws?seat=seat-a", page),
      client.buildAudioSeatWebSocketUrl(13357, page),
    ].map(value => new URL(value));
    for (const socket of sockets) {
      expect(socket.protocol).toBe("wss:");
      expect(socket.hostname).toBe(ip);
    }
    expect(sockets.map(socket => socket.port)).toEqual(["13337", "13337", "13357", "13337", "13337", "13357"]);
    expect(sockets[1].searchParams.get("seat")).toBe("seat-a");
    expect(sockets[4].searchParams.get("seat")).toBe("seat-a");
  }, 30_000); // First import compiles the full mirror graph when the complete suite runs concurrently.
});
