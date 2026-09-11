// THE HAND, ON BOTH STAGES, ON ONE CLOCK — the fixture and the rig two specs share.
//
// `handLanding.spec.ts` plays three gestures written from the shape of a recording; `handLandingRepro.spec.ts`
// plays the byte-for-byte hint batches out of a player's own repro file. They differ ONLY in the wire they send,
// so everything that decides what "the hand" is and how a frame is driven lives here: one fixture chain, one fake
// clock, one way to build an arm. A second copy of this rig is how the two stages drifted apart in the first
// place, and it would be a strange lesson to learn twice.
//
// Not a `.spec.ts`, so vitest's default include glob does not collect it as a test file.

import { vi } from "vitest";

import type { HandPoseReport } from "@/mirror/handPoseProbe";
import type { LandingLogReport } from "@/mirror/landingLog";
import type { MirrorRenderer } from "@/mirror/mirrorRenderer";
import { HAND_RAISE_RAMP_START_Y } from "@/mirror/mirrorRenderer";
import {
  createMirrorRendererFor,
  requestedStageBackend,
  __setStageBackendForTest,
  type StageBackend
} from "@/mirror/rendererFactory";
import {
  applySceneDelta,
  createMirrorState,
  parseSceneDelta,
  MIRROR_DESIGN_WIDTH as DESIGN_W,
  type MirrorState
} from "@/mirror/sceneTree";

export { DESIGN_W };

// --- the fan ------------------------------------------------------------------------------------------------
//
// A holder's resting pose is the ramp's own START y and a focused one is its END y (see `HAND_RAISE_RAMP_*`):
// those two constants ARE the game's resting and focused fan heights, which is what makes the focus ramp a
// function of this one number. The horizontal fan and its per-card rotation are the recording's shape.

export const CARD_SPREAD_PX = 170;
export const CARD_SCALE = 0.8;
export const CARD_ROT_STEP = 0.14;

/** Slot `i` of an `n`-card fan, as a wire Transform2D 6-tuple in CONTAINER-LOCAL space. */
export function slot(i: number, n: number, y: number = HAND_RAISE_RAMP_START_Y): number[] {
  const centred = i - (n - 1) / 2;
  const rot = centred * CARD_ROT_STEP;
  const cos = Math.cos(rot) * CARD_SCALE;
  const sin = Math.sin(rot) * CARD_SCALE;
  return [cos, -sin, sin, cos, centred * CARD_SPREAD_PX, y];
}

/** The wire's transform spelling. */
export function xf(m: readonly number[]): Record<string, unknown> {
  return {
    xAxis: { x: m[0], y: m[1] },
    yAxis: { x: m[2], y: m[3] },
    origin: { x: m[4], y: m[5] }
  };
}

export interface NodeSpec {
  id: string;
  parentId: string | null;
  /**
   * `null` ⇒ a VOLATILE upsert: no name, no type. The distinction is load-bearing, not cosmetic — `mergeNode`
   * returns a NAMED upsert wholesale (it is the producer re-describing the node) and merges an unnamed one onto
   * what is retained. The producer uses both for one hand card within 60ms of each other, so a fixture that only
   * ever sends named upserts is not sending the wire.
   */
  name?: string | null;
  nodeType?: string;
  /**
   * `null` ⇒ omit the transform entirely, which the producer really does on a re-attach: a holder that changed
   * parent arrives as a full static re-describe with NO pose, and the pose follows in a later tick. That is a
   * node whose transform is momentarily nothing at all, mid-gesture, with a tween hint already armed on it.
   */
  transform?: readonly number[] | null;
  /** `null` ⇒ omit the box entirely; the default is the zero box the wire sends for a holder. */
  rect?: { x: number; y: number; w: number; h: number } | null;
  mouseFilter?: number;
  anchorLeft?: number;
  anchorRight?: number;
  sceneFilePath?: string;
  contentKey?: string;
  fill?: boolean;
  zIndex?: number;
}

export function wireNode(spec: NodeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: spec.id,
    parentId: spec.parentId,
    visible: true
  };
  if (spec.name !== null) {
    out.name = spec.name ?? spec.id;
    out.nodeType = spec.nodeType ?? "Godot.Control";
  }
  if (spec.transform !== null) {
    out.transform = xf(spec.transform ?? [1, 0, 0, 1, 0, 0]);
  }
  if (spec.rect !== null) {
    const r = spec.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    out.localRect = { position: { x: r.x, y: r.y }, size: { x: r.w, y: r.h } };
  }
  if (spec.mouseFilter != null) out.mouseFilter = spec.mouseFilter;
  if (spec.anchorLeft != null) out.anchorLeft = spec.anchorLeft;
  if (spec.anchorRight != null) out.anchorRight = spec.anchorRight;
  if (spec.sceneFilePath) out.sceneFilePath = spec.sceneFilePath;
  if (spec.contentKey) out.contentKey = spec.contentKey;
  if (spec.zIndex != null) out.zIndex = spec.zIndex;
  // Something to paint, so the card is a real drawn entity rather than an empty box.
  if (spec.fill) out.fillColor = { r: 1, g: 1, b: 1, a: 1, html: "#ffffff" };
  return out;
}

export const HOLDER_TYPE = "MegaCrit.Sts2.Core.Nodes.Cards.Holders.NHandCardHolder";
export const HAND_TYPE = "MegaCrit.Sts2.Core.Nodes.Combat.NPlayerHand";
export const HOLDER_SCENE = "res://scenes/cards/holders/hand_card_holder.tscn";

export const holderId = (i: number): string => `holder-${i}`;

/**
 * ONE holder's wire shape, keyframe and update alike.
 *
 * Every upsert carries the node's IDENTITY fields — the name, the type, the scene file, the anchors — because a
 * later upsert that omitted them would silently retype the node: the first draft of this fixture did exactly that
 * and turned the hand into five anonymous Controls halfway through the gesture, which reads as "there is no hand"
 * rather than as a bug in the fixture. The producer sends volatile fields only; a test that hand-writes the wire
 * has to be explicit instead.
 */
export function holderSpec(
  i: number,
  parentId: string,
  transform: readonly number[] | null,
  opts: { zIndex?: number; volatile?: boolean } = {}
): NodeSpec {
  // A VOLATILE upsert carries the pose and nothing else — the shape the producer sends every tick. The static one
  // carries the identity the merge keeps (see NodeSpec.name).
  if (opts.volatile) {
    return {
      id: holderId(i),
      parentId,
      name: null,
      transform,
      ...(opts.zIndex == null ? {} : { zIndex: opts.zIndex })
    };
  }
  return {
    id: holderId(i),
    parentId,
    name: `${holderId(i)}-CARD_STRIKE`,
    nodeType: HOLDER_TYPE,
    transform,
    anchorLeft: 0,
    anchorRight: 0,
    mouseFilter: 2,
    sceneFilePath: HOLDER_SCENE,
    ...(opts.zIndex == null ? {} : { zIndex: opts.zIndex })
  };
}

/**
 * The hand, as the wire streams it: a widening 0/1 frame, a zero-size 0.5-anchored positioner at the bottom
 * centre, and N zero-size holders under it, each carrying the card's own boxed parts.
 *
 * Every branch of `computeSpread` in that list is a different one — the widening frame hands out a budget, the
 * zero-size container is a pass-through group that takes its own field claim, the zero-size holder rides it, and
 * the boxed parts under the holder ride the holder. A fixture that flattened any of that would test arithmetic
 * rather than the hand.
 */
export function handNodes(count: number): NodeSpec[] {
  const nodes: NodeSpec[] = [
    { id: "root", parentId: null, rect: { x: 0, y: 0, w: DESIGN_W, h: 1080 }, anchorLeft: 0, anchorRight: 1 },
    {
      id: "hand",
      parentId: "root",
      nodeType: HAND_TYPE,
      rect: { x: 0, y: 0, w: DESIGN_W, h: 1080 },
      anchorLeft: 0,
      anchorRight: 1,
      mouseFilter: 2,
      sceneFilePath: "res://scenes/combat/player_hand.tscn"
    },
    {
      id: "container",
      parentId: "hand",
      name: "CardHolderContainer",
      transform: [1, 0, 0, 1, DESIGN_W / 2, 1080],
      anchorLeft: 0.5,
      anchorRight: 0.5,
      mouseFilter: 2
    }
  ];
  for (let i = 0; i < count; i++) {
    const id = holderId(i);
    nodes.push(holderSpec(i, "container", slot(i, count)));
    // The 300x422 footprint a pointer lands on, and the art the player sees — both boxed Controls under a
    // zero-size holder, which is the branch that RIDES the holder's own field claim.
    nodes.push({
      id: `${id}-hitbox`,
      parentId: id,
      name: "Hitbox",
      transform: [1, 0, 0, 1, -150, -211],
      rect: { x: 0, y: 0, w: 300, h: 422 },
      mouseFilter: 0
    });
    nodes.push({
      id: `${id}-art`,
      parentId: id,
      name: "Art",
      nodeType: "Godot.TextureRect",
      transform: [1, 0, 0, 1, -150, -211],
      rect: { x: 0, y: 0, w: 300, h: 422 },
      mouseFilter: 2,
      fill: true
    });
    // The holder is a pooled shell; only this NCard child identifies which card the player actually has.
    nodes.push({
      id: `${id}-card`,
      parentId: id,
      name: "@Control",
      nodeType: "MegaCrit.Sts2.Core.Nodes.Cards.NCard",
      sceneFilePath: "res://scenes/cards/card.tscn",
      contentKey: `nc:DEFEND_IRONCLAD#${i + 1}`
    });
    // …AND THE PART THAT CLAIMS THE FIELD FOR ITSELF, which is the population the two nodes above cannot stand in
    // for. Every card part written before this one is a Control (`mouseFilter` set), and a Control under a
    // zero-size holder takes the RIDE branch: its shift is its holder's corrected claim, handed down. That made
    // this fixture structurally unable to reproduce the Aug-29 defect — a whole tweened subtree drawn through a
    // FROZEN claim — because nothing in it ever claimed anything.
    //
    // A recording of the real hand has both: a census over 546 nodes found 430 riders, 72 pass-through groups and
    // 44 positional claimers (`Sprite2D` and friends). So the fixture carries one of each below the holder: a
    // boxless group (mode 1, the ORIGIN field) with a boxed, anchor-less, `mouseFilter`-less sprite under it
    // (mode 2, the CENTRE field). Neither can inherit its way to the right answer, which is the point.
    nodes.push({
      id: `${id}-fx`,
      parentId: id,
      name: "CardFx",
      nodeType: "Godot.Node2D",
      transform: [1, 0, 0, 1, 0, 0],
      rect: null
    });
    nodes.push({
      id: `${id}-sprite`,
      parentId: `${id}-fx`,
      name: "Portrait",
      nodeType: "Godot.Sprite2D",
      transform: [1, 0, 0, 1, -150, -211],
      rect: { x: 0, y: 0, w: 300, h: 422 },
      fill: true
    });
  }
  return nodes;
}

/** Every id one holder contributes, in pre-order. */
export function holderTreeIds(i: number): string[] {
  return [holderId(i), `${holderId(i)}-hitbox`, `${holderId(i)}-art`, `${holderId(i)}-card`, `${holderId(i)}-fx`, `${holderId(i)}-sprite`];
}

/**
 * The whole tree in pre-order, for a hand of `count` with `parked` (if any) hoisted onto the hand ROOT — which is
 * where the game puts a holder whose card is out of the fan.
 */
export function orderFor(count: number, parked: number | null): string[] {
  const ids = ["root", "hand", "container"];
  for (let i = 0; i < count; i++) {
    if (i !== parked) {
      ids.push(...holderTreeIds(i));
    }
  }
  if (parked !== null) {
    ids.push(...holderTreeIds(parked));
  }
  return ids;
}

export function applyKeyframe(state: MirrorState, count: number): void {
  const specs = handNodes(count);
  applySceneDelta(
    state,
    parseSceneDelta({
      type: "scene-delta",
      full: true,
      screenType: "combat",
      upserts: specs.map(wireNode),
      orderedIds: specs.map((s) => s.id)
    })!
  );
}

/**
 * An in-place update.
 *
 * `order` is sent only when the delta CHANGES THE TREE, and sending it then is not optional: the renderers select
 * a structural walk on `state.orderedIds` changing identity (see sceneTree's late-node guard), so a reparent with
 * no order behind it leaves the DOM element under its old parent and the walk composing against the old parent's
 * global — a card selected out of the hand drew ~1000px away from where the canvas drew it, which is a fixture
 * that lies rather than a backend that is wrong. A real producer re-emits the order (as an `orderPatch`) for every
 * tree change, because a reparent necessarily changes pre-order.
 */
export function update(state: MirrorState, specs: NodeSpec[], hints?: unknown[], order?: string[]): void {
  const delta: Record<string, unknown> = {
    type: "scene-delta",
    full: false,
    screenType: "combat",
    upserts: specs.map(wireNode),
    hints
  };
  if (order) {
    delta.orderedIds = order;
  }
  applySceneDelta(state, parseSceneDelta(delta)!);
}

/** A `position` tween hint, in the producer's own spelling: an END 6-tuple in the target's PARENT-LOCAL space. */
export function positionHint(
  targetId: string,
  end: readonly number[],
  durationMs: number,
  start?: readonly number[]
): Record<string, unknown> {
  return {
    targetId,
    property: "position",
    durationMs,
    trans: "Expo",
    ease: "Out",
    endTransform: [...end],
    // A DECLARED START is the producer saying "begin the replay here, not wherever you have it" — it rides a
    // batch in which the target was also teleported, and it is what makes such a batch a PRIMED one on the DOM.
    ...(start ? { startTransform: [...start] } : {})
  };
}

// --- the two backends, on one clock ---------------------------------------------------------------------------

export interface Arm {
  stage: HTMLElement;
  renderer: MirrorRenderer;
  poses(): HandPoseReport;
  /**
   * The arm's INTENDED-LANDING rows (`landingLog.ts`) — where this backend decided to send each card, scored
   * against where the card ended up once the producer's word landed.
   *
   * Read off the RENDERER, never off `window.__mirrorLandingLog`: both arms install that name and the second one
   * built wins it, so a two-stage spec reading the window would silently score one backend twice.
   */
  landings(): LandingLogReport;
}

/** A no-op WebGL2 context — enough to drive the real canvas stage in jsdom. `canvasStage.spec.ts`'s stub. */
function stubWebgl2(): void {
  let canvasEl: HTMLCanvasElement | null = null;
  const constants = new Map<string, number>();
  let seed = 0x1000;
  const explicit: Record<string, unknown> = {
    get drawingBufferWidth() {
      return canvasEl?.width ?? 0;
    },
    get drawingBufferHeight() {
      return canvasEl?.height ?? 0;
    },
    viewport: () => {},
    clear: () => {},
    clearColor: () => {},
    drawArraysInstanced: () => {},
    getParameter: (pname: number) => (pname === (gl as unknown as Record<string, number>).MAX_TEXTURE_SIZE ? 8192 : 8),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getExtension: () => null
  };
  const gl = new Proxy(explicit, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return (target as Record<string, unknown>)[prop];
      if (/^[A-Z0-9_]+$/.test(prop)) {
        let v = constants.get(prop);
        if (v === undefined) {
          v = seed++;
          constants.set(prop, v);
        }
        return v;
      }
      if (/^create[A-Z]/.test(prop) || /Location$/.test(prop)) return () => ({});
      return () => undefined;
    }
  }) as unknown as WebGL2RenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string
  ) {
    if (kind !== "webgl2") return null;
    canvasEl = this;
    return gl as unknown as RenderingContext;
  } as typeof HTMLCanvasElement.prototype.getContext);
}

/** The rig: a fake `performance.now`, a fake frame/timer queue, and the backends built against them. */
export interface HandStage {
  /** Advance to `atMs`, running every due timer and then every booked frame callback. */
  pumpTo(atMs: number): void;
  /** Advance by `ms` (16 by default — one 60Hz frame). */
  pump(ms?: number): void;
  now(): number;
  makeArm(backend: StageBackend, spreadFactor: number, raise: boolean): Arm;
  /** Dispose every renderer and put the requested backend back — call from `afterEach`. */
  teardown(): void;
}

/**
 * Install the rig. Call from `beforeEach`; the caller still owns `vi.unstubAllGlobals()` / `restoreAllMocks()`.
 *
 * BOTH BACKENDS ARE REAL. Nothing here fakes a renderer: the DOM arm composes real elements and the canvas arm
 * builds a real draw list against a stubbed GL context. What is faked is only the environment they schedule on —
 * because the whole question is what they draw ON A GIVEN FRAME, and a real clock cannot be asked that.
 */
export function installHandStage(): HandStage {
  let clock = 0;
  let rafs: (FrameRequestCallback | null)[] = [];
  let timers: { id: number; at: number; cb: () => void }[] = [];
  let nextTimerId = 1;
  const backendAtStart = requestedStageBackend();
  const built: MirrorRenderer[] = [];

  document.body.innerHTML = "";
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => rafs.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    if (handle >= 1 && handle <= rafs.length) rafs[handle - 1] = null;
  });
  vi.stubGlobal("setTimeout", (cb: () => void, ms?: number) => {
    const id = nextTimerId++;
    timers.push({ id, at: clock + (ms ?? 0), cb });
    return id;
  });
  vi.stubGlobal("clearTimeout", (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
  );
  stubWebgl2();

  function pumpTo(atMs: number): void {
    clock = atMs;
    for (let guard = 0; guard < 8; guard++) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      timers = timers.filter((t) => t.at > clock);
      for (const t of due) t.cb();
    }
    for (let guard = 0; guard < 4; guard++) {
      const booked = rafs.splice(0, rafs.length).filter((cb): cb is FrameRequestCallback => cb !== null);
      if (booked.length === 0) break;
      for (const cb of booked) cb(clock);
    }
  }

  return {
    pumpTo,
    pump: (ms = 16) => pumpTo(clock + ms),
    now: () => clock,
    makeArm(backend: StageBackend, spreadFactor: number, raise: boolean): Arm {
      __setStageBackendForTest(backend);
      const stage = document.createElement("div");
      Object.defineProperty(stage, "clientWidth", { configurable: true, value: DESIGN_W * spreadFactor });
      Object.defineProperty(stage, "clientHeight", { configurable: true, value: 1080 });
      stage.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: DESIGN_W * spreadFactor, height: 1080 }) as DOMRect;
      document.body.appendChild(stage);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.appendChild(defs);
      document.body.appendChild(svg);
      const renderer = createMirrorRendererFor(stage, defs);
      built.push(renderer);
      renderer.setStretch(spreadFactor);
      // READABLE-HAND MODE IS AN AXIS, not a setting a spec picks. It defaults ON for a touch-first device — the
      // phone the report came from — and it is the SECOND channel a holder's drawn position is the sum of: the
      // wire's pose and a cosmetic lift ramped off the pose the card is HEADED FOR. A spec that scored only the
      // first channel would be blind to exactly half of "the card does not end where it should".
      renderer.setRaiseHandCards(raise);
      return {
        stage,
        renderer,
        poses: () => renderer.handPoses(),
        landings: () => renderer.landingLog()
      };
    },
    teardown(): void {
      for (const r of built) {
        r.dispose();
      }
      built.length = 0;
      __setStageBackendForTest(backendAtStart);
    }
  };
}

export { createMirrorState, type MirrorState, type StageBackend };
