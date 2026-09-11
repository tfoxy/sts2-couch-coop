import { describe, expect, it } from "vitest";

import { regionBackgroundStyle, richTextLayeredHtml } from "@godot-scene-web/html";
import { DEFAULT_BBCODE_TAGS } from "@spirectl/presentation/render";

import { connectMirrorClient } from "@/mirror/mirrorClient";
import {
  applySceneDelta,
  createMirrorState,
  mirrorResourceUrl,
  parseSceneDelta
} from "@/mirror/sceneTree";

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send() {}

  close() {
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

function node(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    parentId: null,
    name: "Card",
    nodeType: "NinePatchRect",
    localRect: { position: { x: 100, y: 200 }, size: { x: 320, y: 480 } },
    visible: true,
    opacity: 1,
    rotation: 0,
    zIndex: 3,
    texture: { resourcePath: "res://images/cards/strike.png", resourceType: "Texture2D" },
    ninePatch: true,
    text: null,
    ...overrides
  };
}

function delta(overrides: Record<string, unknown> = {}) {
  return {
    type: "scene-delta",
    full: false,
    screenType: "run",
    upserts: [],
    removedIds: [],
    orderedIds: null,
    ...overrides
  };
}

function currentSession(overrides: Record<string, unknown> = {}) {
  const baseSession = { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 };
  const basePlayer = {
    playerId: "Alice", name: "Alice", isHost: false, isRunPlayer: true, connectionCount: 1,
    disconnected: false, isLocal: false, netId: null, isMirrorSeat: true, seatStatus: "ready",
    seatStatusReason: null, characterId: null
  };
  const baseScreen = { kind: "run", type: "combat", title: "Combat", mirrorMode: "mp-run" };
  const { session, players, screen, ...rest } = overrides;
  return {
    type: "session",
    session: { ...baseSession, ...(session as Record<string, unknown> | undefined) },
    players: players ?? [basePlayer],
    screen: { ...baseScreen, ...(screen as Record<string, unknown> | undefined) },
    hostName: "host",
    scrollAction: true,
    rewardAction: true,
    ...rest
  };
}

describe("mirrorResourceUrl", () => {
  it("maps a res:// path to the /res/ asset route", () => {
    expect(mirrorResourceUrl("res://images/cards/strike.png")).toBe("/res/images/cards/strike.png");
  });
});

describe("rich-text inline images", () => {
  // Mirrors MirrorView.richHtml's call: inline `[img]res://…png[/img]` (e.g. the per-pool energy orb) must
  // resolve to an <img> pointing at the host /res/ route instead of rendering as a blank placeholder span.
  const render = (value: string) =>
    richTextLayeredHtml(value, {
      customTags: DEFAULT_BBCODE_TAGS,
      textScale: true,
      resolveImage: (path) => (path ? { url: mirrorResourceUrl(path) } : undefined)
    });

  it("resolves an [img] path to an <img src> on the /res/ route", () => {
    const html = render("Costo ( [img]res://images/packed/sprite_fonts/ironclad_energy_icon.png[/img] )");
    expect(html).toContain('src="/res/images/packed/sprite_fonts/ironclad_energy_icon.png"');
    expect(html).toContain("godot-rich-img");
  });

  it("consumes the [img] tag into an <img> rather than leaking it as text", () => {
    const html = render("[img]res://images/packed/sprite_fonts/defect_energy_icon.png[/img]");
    // The bbcode tag itself must be gone (consumed); the path survives only inside <img> src/data-attrs.
    expect(html).not.toContain("[img]");
    expect(html).not.toContain("[/img]");
    expect(html).toContain('<img class="godot-rich-img"');
    expect(html).toContain('src="/res/images/packed/sprite_fonts/defect_energy_icon.png"');
  });
});

describe("atlas-texture crop (flicker fix)", () => {
  // The producer now emits the UNDERLYING atlas image as `texture` plus a per-frame `textureRegion`. The
  // mirror must parse the region and (via the shared gsw crop math) keep the image URL constant across
  // animation frames, shifting only `background-position` — otherwise the icon re-fetches per frame (flicker).
  const atlasNode = (id: string, region: { x: number; y: number; w: number; h: number }) =>
    node(id, {
      name: "IntentSprite",
      nodeType: "Sprite2D",
      ninePatch: false,
      texture: { resourcePath: "res://images/atlases/intent_atlas.png", resourceType: "CompressedTexture2D" },
      textureRegion: { position: { x: region.x, y: region.y }, size: { x: region.w, y: region.h } }
    });

  it("parses textureRegion/textureMargin onto the node and points texture at the atlas", () => {
    const parsed = parseSceneDelta(
      delta({
        full: true,
        upserts: [
          node("1", {
            name: "IntentSprite",
            nodeType: "Sprite2D",
            ninePatch: false,
            texture: { resourcePath: "res://images/atlases/intent_atlas.png", resourceType: "CompressedTexture2D" },
            textureRegion: { position: { x: 64, y: 32 }, size: { x: 48, y: 48 } },
            textureMargin: { position: { x: 2, y: 3 }, size: { x: 4, y: 5 } }
          })
        ],
        orderedIds: ["1"]
      })
    );
    const n = parsed!.upserts[0];
    expect(n.textureUrl).toBe("/res/images/atlases/intent_atlas.png");
    expect(n.textureRegion).toEqual({ x: 64, y: 32, width: 48, height: 48 });
    expect(n.textureMargin).toEqual({ x: 2, y: 3, width: 4, height: 5 });
  });

  it("keeps the atlas URL stable while only background-position changes across frames", () => {
    const f1 = parseSceneDelta(delta({ full: true, upserts: [atlasNode("1", { x: 0, y: 0, w: 50, h: 50 })], orderedIds: ["1"] }))!
      .upserts[0];
    const f2 = parseSceneDelta(delta({ upserts: [atlasNode("1", { x: 50, y: 0, w: 50, h: 50 })] }))!.upserts[0];

    // Same stable image URL both frames.
    expect(f1.textureUrl).toBe(f2.textureUrl);

    const css1 = regionBackgroundStyle(f1.textureRegion!, { margin: f1.textureMargin ?? undefined });
    const css2 = regionBackgroundStyle(f2.textureRegion!, { margin: f2.textureMargin ?? undefined });
    // Native-scale crop (no atlas size / box): size auto, position is just the negated region origin.
    expect(css1.backgroundSize).toBe("auto");
    expect(css1.backgroundPosition).toBe("0px 0px");
    expect(css2.backgroundPosition).toBe("-50px 0px");
    // Only the viewport moved between frames.
    expect(css1.backgroundPosition).not.toBe(css2.backgroundPosition);
  });

  it("offsets by the transparent margin (region drawn at margin position)", () => {
    const css = regionBackgroundStyle(
      { x: 20, y: 10, width: 30, height: 30 },
      { margin: { x: 5, y: 7, width: 0, height: 0 } }
    );
    // background-position = -(region - margin) = -(20-5), -(10-7)
    expect(css.backgroundPosition).toBe("-15px -3px");
  });
});

describe("parseSceneDelta", () => {
  it("returns null for non-scene-delta payloads", () => {
    expect(parseSceneDelta({ type: "state" })).toBeNull();
    expect(parseSceneDelta(null)).toBeNull();
  });

  it("normalizes a node's rect, opacity, texture url and z-index", () => {
    const parsed = parseSceneDelta(delta({ full: true, upserts: [node("1")], orderedIds: ["1"] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.full).toBe(true);
    const n = parsed!.upserts[0];
    expect(n.localRect).toEqual({ x: 100, y: 200, width: 320, height: 480 });
    expect(n.opacity).toBe(1);
    expect(n.zIndex).toBe(3);
    expect(n.textureUrl).toBe("/res/images/cards/strike.png");
    expect(parsed!.orderedIds).toEqual(["1"]);
  });
});

describe("applySceneDelta", () => {
  it("a full keyframe populates the map and order", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta(delta({ full: true, upserts: [node("1"), node("2")], orderedIds: ["1", "2"] }))!);
    expect(state.nodes.size).toBe(2);
    expect(state.orderedIds).toEqual(["1", "2"]);
    expect(state.revision).toBe(1);
  });

  it("an incremental patch updates only the named node and keeps static fields", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta(delta({ full: true, upserts: [node("1")], orderedIds: ["1"] }))!);
    // Volatile-only upsert: blank static (name/type), moved rect — must keep the original name/type.
    applySceneDelta(state, parseSceneDelta(delta({
      upserts: [node("1", { name: "", nodeType: "", localRect: { position: { x: 5, y: 6 }, size: { x: 7, y: 8 } } })]
    }))!);
    const n = state.nodes.get("1")!;
    expect(n.localRect).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(n.name).toBe("Card");
    expect(n.nodeType).toBe("NinePatchRect");
    expect(state.revision).toBe(2);
  });

  it("removal drops ids and a full keyframe replaces the map", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta(delta({ full: true, upserts: [node("1"), node("2")], orderedIds: ["1", "2"] }))!);
    applySceneDelta(state, parseSceneDelta(delta({ removedIds: ["2"] }))!);
    expect(state.nodes.has("2")).toBe(false);
    expect(state.nodes.has("1")).toBe(true);

    applySceneDelta(state, parseSceneDelta(delta({ full: true, upserts: [node("9")], orderedIds: ["9"] }))!);
    expect([...state.nodes.keys()]).toEqual(["9"]);
    expect(state.orderedIds).toEqual(["9"]);
  });

  it("refreshes the (volatile) outline color on a volatile-only upsert", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta(
        delta({
          full: true,
          orderedIds: ["hp"],
          upserts: [
            node("hp", {
              name: "HpLabel",
              outlineColor: { r: 1, g: 0, b: 0, a: 1, html: "#ff0000ff" },
              outlineSize: 12
            })
          ]
        })
      )!
    );
    expect(state.nodes.get("hp")!.outline?.colorHtml).toBe("#ff0000ff");
    // Volatile-only upsert (blank name) recolors the outline blue — must NOT be frozen by the static merge.
    applySceneDelta(
      state,
      parseSceneDelta(
        delta({
          upserts: [
            node("hp", { name: "", outlineColor: { r: 0, g: 0, b: 1, a: 1, html: "#0000ffff" }, outlineSize: 12 })
          ]
        })
      )!
    );
    expect(state.nodes.get("hp")!.outline?.colorHtml).toBe("#0000ffff");
  });

  it("parses clip_children and retains it (static) across a volatile-only upsert", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta(delta({ full: true, orderedIds: ["mask"], upserts: [node("mask", { name: "Mask", clipChildren: 1 })] }))!
    );
    expect(state.nodes.get("mask")!.clipChildren).toBe(1);
    applySceneDelta(state, parseSceneDelta(delta({ upserts: [node("mask", { name: "" })] }))!);
    expect(state.nodes.get("mask")!.clipChildren).toBe(1);
  });
});

describe("local scene transforms", () => {
  it("uses local composition without a transform-space wire selector", () => {
    const state = createMirrorState();
    applySceneDelta(state, parseSceneDelta(delta({ full: true, upserts: [node("1")], orderedIds: ["1"] }))!);
  });
});

describe("styling fields", () => {
  it("normalizes modulate/self_modulate, scale, pivot, fill, nine-patch margins and show-behind", () => {
    const parsed = parseSceneDelta(
      delta({
        full: true,
        orderedIds: ["1"],
        upserts: [
          node("1", {
            modulate: { r: 1, g: 0, b: 0, a: 0.5, html: "#ff000080" },
            selfModulate: { r: 0.5, g: 0.5, b: 0.5, a: 1, html: "#808080ff" },
            scaleX: 1.2,
            scaleY: 1.3,
            pivotX: 10,
            pivotY: 20,
            fillColor: { r: 0, g: 0, b: 0, a: 0.8, html: "#000000cc" },
            ninePatchMargins: { left: 4, top: 6, right: 8, bottom: 10 },
            showBehindParent: true
          })
        ]
      })
    )!;
    const n = parsed.upserts[0];
    expect(n.modulate).toEqual({ r: 1, g: 0, b: 0, a: 0.5, html: "#ff000080" });
    expect(n.selfModulate?.r).toBe(0.5);
    expect(n.scaleX).toBe(1.2);
    expect(n.scaleY).toBe(1.3);
    expect(n.pivotX).toBe(10);
    expect(n.pivotY).toBe(20);
    expect(n.fillColor?.html).toBe("#000000cc");
    expect(n.ninePatchMargins).toEqual({ left: 4, top: 6, right: 8, bottom: 10 });
    expect(n.showBehindParent).toBe(true);
  });

  it("defaults scale to 1 and drops all-zero nine-patch margins", () => {
    const n = parseSceneDelta(delta({ full: true, orderedIds: ["1"], upserts: [node("1")] }))!.upserts[0];
    expect(n.scaleX).toBe(1);
    expect(n.scaleY).toBe(1);
    expect(n.ninePatchMargins).toBeNull();
    expect(n.modulate).toBeNull();
  });

  it("a volatile-only upsert keeps the retained static styling block", () => {
    const state = createMirrorState();
    applySceneDelta(
      state,
      parseSceneDelta(
        delta({
          full: true,
          orderedIds: ["1"],
          upserts: [node("1", { showBehindParent: true, ninePatchMargins: { left: 2, top: 2, right: 2, bottom: 2 } })]
        })
      )!
    );
    // Volatile-only (empty name) upsert with defaulted static — must not erase show-behind / margins.
    applySceneDelta(state, parseSceneDelta(delta({ upserts: [node("1", { name: "", nodeType: "", showBehindParent: false })] }))!);
    const n = state.nodes.get("1")!;
    expect(n.showBehindParent).toBe(true);
    expect(n.ninePatchMargins).toEqual({ left: 2, top: 2, right: 2, bottom: 2 });
  });
});

describe("connectMirrorClient", () => {
  it("applies scene-delta frames into the retained state and ignores other frames", async () => {
    MockWebSocket.instances = [];
    let changes = 0;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onChange() {
        changes += 1;
      }
    });

    const socket = MockWebSocket.instances[0];
    await Promise.resolve();
    expect(client.status).toBe("connected");

    // A frame that is not a scene delta — an envelope type this client does not handle — is ignored.
    socket.emit({ type: "state", rootScene: "run" });
    expect(client.state.nodes.size).toBe(0);

    socket.emit(delta({ full: true, upserts: [node("1")], orderedIds: ["1"] }));
    expect(client.state.nodes.size).toBe(1);
    expect(client.state.screenType).toBe("run");
    expect(client.state.revision).toBe(1);

    socket.emit(delta({ upserts: [node("1", { name: "", nodeType: "", visible: false })] }));
    expect(client.state.nodes.get("1")!.visible).toBe(false);
    expect(changes).toBeGreaterThan(0);

    client.close();
  });

  it("connects with canonical current selectors and surfaces the parsed session without state", async () => {
    MockWebSocket.instances = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    // The mirror opts out of the full state broadcast at the protocol level.
    expect(socket.url).toBe("ws://localhost/ws?watch=1&staticBg=0&cardFlight=1&handTween=1&trailDrive=0");
    expect(client.session).toBeNull();

    // A `session` envelope (roster + screen kind) is parsed + surfaced for the join form — without touching scene.
    socket.emit(currentSession());
    expect(client.session?.screen?.kind).toBe("run");
    expect(client.session?.players?.[0]?.name).toBe("Alice");
    expect(client.state.nodes.size).toBe(0);

    client.close();
  });

  it("redirects to a headless game instance when the session carries headlessMirrorPort", async () => {
    MockWebSocket.instances = [];
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit(currentSession({ headlessMirrorPort: 13357, session: { joined: true } }));
    expect(redirectPort).toBe(13357);

    client.close();
  });

  it("fires onDirectView (not redirect) when the session carries directView", async () => {
    MockWebSocket.instances = [];
    let directView = 0;
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onDirectView() {
        directView += 1;
      },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    // A host/watch-only or singleplayer-run join reply: watch the host stream in place, no redirect.
    socket.emit(currentSession({ directView: true, session: { joined: true } }));
    expect(directView).toBe(1);
    expect(redirectPort).toBeNull();

    client.close();
  });

  it("surfaces the host's refresh-rate baseline off the session envelope", async () => {
    MockWebSocket.instances = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit(currentSession({ refreshRate: 60 }));
    expect(client.session?.refreshRate).toBe(60);

    client.close();
  });

  it("fires onJoinRejected with the code when the join is refused", async () => {
    MockWebSocket.instances = [];
    let rejection: string | null = null;
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onJoinRejected(reason) {
        rejection = reason;
      },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    // An unjoined reply carrying a rejection code → picker + message, never a redirect.
    socket.emit(currentSession({
      joinRejection: "not-a-session-player",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 }
    }));
    expect(rejection).toBe("not-a-session-player");
    expect(redirectPort).toBeNull();

    client.close();
  });

  it("fires onJoinRejected even when the reply also claims the session joined", async () => {
    // REGRESSION: the host derives `session` from the name→roster assignment, which reports `joined: true` for a
    // name the join handler had just refused — so a full lobby answered with BOTH `joined: true` and
    // `joinRejection: "no-free-instance"`. The client used to require `joined !== true` before surfacing a
    // rejection, swallowed the message, never cleared `pendingName`, and left the join screen spinning forever on
    // a seat that was never coming. A rejection is terminal on its own.
    MockWebSocket.instances = [];
    let rejection: string | null = null;
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onJoinRejected(reason) {
        rejection = reason;
      },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit(currentSession({
      joinRejection: "no-free-instance",
      session: { name: "Dee", status: "joined", joined: true, playerId: "Dee", connectionCount: 1 }
    }));
    expect(rejection).toBe("no-free-instance");
    expect(redirectPort).toBeNull();

    client.close();
  });

  it("prefers a granted view over a rejection code on the same reply", async () => {
    // The three directives stay mutually exclusive and ordered: dropping the `joined` guard must not let a
    // stale/spurious rejection field beat an actual redirect.
    MockWebSocket.instances = [];
    let rejection: string | null = null;
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onJoinRejected(reason) {
        rejection = reason;
      },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit(currentSession({
      joinRejection: "no-free-instance",
      headlessMirrorPort: 13387,
      session: { name: "Dee", status: "joined", joined: true, playerId: "p:1005", connectionCount: 1 }
    }));
    expect(redirectPort).toBe(13387);
    expect(rejection).toBeNull();

    client.close();
  });

  it("carries the host's fault text alongside a join-failed rejection", async () => {
    // "join-failed" is the code the host mints when its own join handler THREW, and it is the only one that
    // carries detail — every other code is self-describing, so the second line would be noise.
    MockWebSocket.instances = [];
    const seen: { reason: string; detail: string | null | undefined }[] = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onJoinRejected(reason, detail) {
        seen.push({ reason, detail });
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit(currentSession({
      joinRejection: "join-failed",
      joinRejectionDetail: "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary.",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 }
    }));
    expect(seen).toEqual([
      {
        reason: "join-failed",
        detail: "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary."
      }
    ]);

    // A detail-free code reports null rather than a stale string.
    socket.emit(currentSession({
      joinRejection: "no-free-instance",
      session: { name: null, status: "unassigned", joined: false, playerId: null, connectionCount: 0 }
    }));
    expect(seen[1]).toEqual({ reason: "no-free-instance", detail: null });

    client.close();
  });

  it("treats an action-result error during a pending join as that join failing", async () => {
    // THE BACKSTOP. The host's receive loop answers ANY faulted message with an `action-result`, which this
    // client is otherwise deaf to — so a server-side throw during a join was delivered, dropped, and the picker
    // spun on "Joining…" forever. That is the exact shape of the MALLOC_ARENA_MAX bug.
    MockWebSocket.instances = [];
    const errors: string[] = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onActionError(message) {
        errors.push(message);
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    client.sendJoin("Alice");
    socket.emit({
      type: "action-result",
      requestId: "join:1",
      code: "invalid-action-message",
      message: "The given key 'MALLOC_ARENA_MAX' was not present in the dictionary."
    });
    expect(errors).toEqual(["The given key 'MALLOC_ARENA_MAX' was not present in the dictionary."]);

    // …and exactly ONCE per join: the join is resolved, so a second fault is somebody else's.
    socket.emit({ type: "action-result", requestId: "x", code: "internal-action-failure", message: "again" });
    expect(errors).toHaveLength(1);

    client.close();
  });

  it("ignores an action-result when no join is in flight, and any successful one", async () => {
    // The gate matters: a refused map-node vote (a real, ordinary `action-result` error this client sends on
    // purpose) must never clear a form the viewer isn't using — and a SUCCESS carries no `code` at all.
    MockWebSocket.instances = [];
    const errors: string[] = [];
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onActionError(message) {
        errors.push(message);
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    socket.emit({ type: "action-result", requestId: "action:1", code: "disabled-action", message: "nope" });
    expect(errors).toHaveLength(0);

    client.sendJoin("Alice");
    socket.emit({ type: "action-result", requestId: "join:1" }); // a success — no code
    expect(errors).toHaveLength(0);

    client.close();
  });

  it("stops reporting join faults once the join has been granted", async () => {
    MockWebSocket.instances = [];
    const errors: string[] = [];
    let redirectPort: number | null = null;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onActionError(message) {
        errors.push(message);
      },
      onHeadlessRedirect(port) {
        redirectPort = port;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    client.sendJoin("Alice");
    socket.emit(currentSession({ headlessMirrorPort: 13357, session: { joined: true } }));
    expect(redirectPort).toBe(13357);
    // A fault AFTER the seat was granted is about something else entirely (an input, a vote) and must not be
    // reported as the join failing — the viewer is already in their game.
    socket.emit({ type: "action-result", requestId: "input:9", code: "internal-action-failure", message: "boom" });
    expect(errors).toHaveLength(0);

    client.close();
  });

  it("records round-trip latency from a pong frame without touching the scene", async () => {
    MockWebSocket.instances = [];
    let latencyUpdates = 0;
    const client = connectMirrorClient({
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      location: { href: "http://localhost/", protocol: "http:" },
      onLatency() {
        latencyUpdates += 1;
      }
    });
    const socket = MockWebSocket.instances[0];
    await Promise.resolve();

    // The host echoes the client's `t0` back; the client computes RTT = now - t0.
    socket.emit({ type: "pong", t0: performance.now() - 25 });
    expect(client.latency.count).toBe(1);
    expect(client.latency.lastMs).toBeGreaterThanOrEqual(0);
    expect(client.latency.p50).not.toBeNull();
    expect(client.latency.p95).not.toBeNull();
    expect(latencyUpdates).toBe(1);
    // A pong is not a scene delta — it must not mutate the retained node map.
    expect(client.state.nodes.size).toBe(0);

    client.close();
  });
});
