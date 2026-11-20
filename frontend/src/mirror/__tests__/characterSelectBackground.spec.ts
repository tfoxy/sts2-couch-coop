import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import StaticBackground from "@/mirror/StaticBackground.vue";
import { admitHostStaticBackground } from "@/mirror/hostStaticBackground";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import {
  isStaticBackgroundSuppressibleRoot,
  staticBgCoversScenePath,
  tryParseCharacterSelectBackgroundSceneId
} from "@/mirror/renderer/staticBackgroundPolicy";
import { createMirrorState, applySceneDelta, parseSceneDelta } from "@/mirror/sceneTree";
import { parseBrowserEnvelopeValue } from "@/protocol/browserEnvelope";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";

const scene = (id: string) => `res://scenes/screens/char_select/char_select_bg_${id}.tscn`;
const descriptor = (id: string) => ({ scenePath: scene(id), url: `/bg/char-select/${id}?v=1`, id: `seat:42:${id}` });

describe("character-select background stills", () => {
  it.each(["ironclad", "silent", "fool", "random_character"])("covers the strict %s scene", (id) => {
    expect(tryParseCharacterSelectBackgroundSceneId(scene(id))).toBe(id);
    expect(staticBgCoversScenePath(scene(id))).toBe(true);
  });

  it.each(["", "Silent", "silent2", "../silent", "silent/prop", "silent%2fprop"])("refuses the id %s", (id) => {
    expect(tryParseCharacterSelectBackgroundSceneId(scene(id))).toBeNull();
    expect(staticBgCoversScenePath(scene(id))).toBe(false);
  });

  it("rejects foreign prefixes and subresources", () => {
    expect(tryParseCharacterSelectBackgroundSceneId("res://scenes/events/background_scenes/silent.tscn")).toBeNull();
    expect(tryParseCharacterSelectBackgroundSceneId(`${scene("silent")}::sub`)).toBeNull();
    expect(tryParseCharacterSelectBackgroundSceneId(null)).toBeNull();
  });

  it("uses the seat's pick independently of the host and drops the room latch", () => {
    const seat = descriptor("silent");
    const host = descriptor("ironclad");
    const latch = { scenePath: host.scenePath, descriptor: host };
    expect(admitHostStaticBackground(seat, host, latch)).toEqual({ descriptor: seat, latch: null });
    expect(admitHostStaticBackground(seat, null, null).descriptor).toBe(seat);
    const pick = descriptor("random_character");
    expect(admitHostStaticBackground(pick, host, latch).descriptor).toBe(pick);
    expect(admitHostStaticBackground(null, host, latch).descriptor).toBeNull();
  });

  it("resolves the seat still against the host origin, including a relay prefix", () => {
    globalThis.__couchCoopHostBase = "https://relay.example/~h/abcdefghijklmnopqrstuv";
    try {
      const envelope = parseBrowserEnvelopeValue({ type: "session", hostName: "host", scrollAction: true,
        session: { name: "Alice", status: "assigned", joined: true, playerId: "seat:1", connectionCount: 1 },
        players: [], screen: { kind: "lobby", type: null, title: null, mirrorMode: "mp-character-select" },
        staticBackground: descriptor("silent") });
      expect(envelope.type).toBe("session");
      if (envelope.type !== "session") throw new Error("expected session");
      expect(envelope.staticBackground?.url).toBe("https://relay.example/~h/abcdefghijklmnopqrstuv/bg/char-select/silent?v=1");
    } finally {
      delete globalThis.__couchCoopHostBase;
    }
  });

  it("keeps the old renderer's char-select subtree live and requests no still", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, upserts: [
      { id: "container", parentId: null, name: "AnimatedBg", nodeType: "Control", visible: true },
      { id: "bg", parentId: "container", name: "silent_bg", nodeType: "Control", visible: true, sceneFilePath: scene("silent") }
    ], orderedIds: ["container", "bg"] })!);
    expect(isStaticBackgroundSuppressibleRoot(state.nodes.get("container")!, state.nodes)).toBe(false);
    expect(isStaticBackgroundSuppressibleRoot(state.nodes.get("bg")!, state.nodes)).toBe(false);
    const decode = vi.fn();
    const previous = mirrorSettings.staticBgEnabled;
    mirrorSettings.staticBgEnabled = true;
    __setStillDecoderForTest(decode);
    const wrapper = mount(StaticBackground, { props: { descriptor: descriptor("silent"), state } });
    try {
      expect(decode).not.toHaveBeenCalled();
      expect(wrapper.find("img").exists()).toBe(false);
    } finally {
      wrapper.unmount();
      __setStillDecoderForTest(null);
      mirrorSettings.staticBgEnabled = previous;
    }
  });
});
