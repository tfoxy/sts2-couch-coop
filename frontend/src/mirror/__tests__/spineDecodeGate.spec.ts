import type { GpuInfo } from "@godot-scene-web/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMirrorRenderer,
  mirrorWalkStats,



  type MirrorRenderer
} from "@/mirror/mirrorRenderer";
import { applySceneDelta, createMirrorState, parseSceneDelta, type MirrorState } from "@/mirror/sceneTree";
import { isTerminalSpineAnim } from "@/mirror/spineAttributes";
import type { LoadedSpineClip } from "@/mirror/spineClip";
import { __setStillDecoderForTest } from "@/mirror/stillDecode";
import { mirrorSettings } from "@/mirror/mirrorSettings";
import { resolveRenderQuality, __setRenderQualityForTest } from "@/render/quality";

// R11 WS-F — DECODE-GATED ATOMIC STILL SWAP.
//
// THE BUG these specs pin: a still swap wrote a freshly-minted blob url straight onto the LIVE <img> (and its
// placement styles with it), so the element dropped the old bitmap the instant the request completed and painted
// NOTHING for the several frames Chromium took to raster the new one — "creatures flash invisible on every
// animation change". The fix decodes on a throwaway probe FIRST and only then commits mechanism → src →
// placement, all in one task, while the outgoing frame keeps painting.
//
// The decoder is driven through `__setStillDecoderForTest`, which is what makes the ORDERING observable at all:
// production's decode is a browser-only promise, and jsdom's `HTMLImageElement` has no `decode` (the module's
// fail-open synchronous pass-through — itself pinned below, because it is what keeps every other spine spec green
// without edits).
const { loadSpineClipMock, dropCacheEntryMock } = vi.hoisted(() => ({
  loadSpineClipMock: vi.fn(),
  dropCacheEntryMock: vi.fn()
}));
vi.mock("@/mirror/spineClip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mirror/spineClip")>();
  return {
    ...actual,
    loadSpineClip: (url: string) => loadSpineClipMock(url),
    dropSpineClipCacheEntry: (url: string) => dropCacheEntryMock(url)
  };
});

const UNKNOWN_GPU: GpuInfo = { renderer: "", software: false, unavailable: true };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(): { stage: HTMLElement; renderer: MirrorRenderer } {
  const stage = document.createElement("div");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svg.appendChild(defs);
  document.body.append(stage, svg);
  return { stage, renderer: createMirrorRenderer(stage, defs) };
}

function spineNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "spine",
    parentId: null,
    name: "SpineSprite",
    nodeType: "SpineSprite",
    transform: { xAxis: { x: 1, y: 0 }, yAxis: { x: 0, y: 1 }, origin: { x: 960, y: 540 } },
    visible: true,
    spine: {
      sceneResPath: "res://scenes/combat/characters/cultist.tscn",
      nodePath: "Visuals/SpineSprite",
      animations: ["idle_loop", "attack", "death"]
    },
    spineCurrentAnim: "idle_loop",
    spineTrackTime: 0,
    ...over
  };
}

function full(state: MirrorState, nodes: Record<string, unknown>[], order: string[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: true, screenType: "run", upserts: nodes, orderedIds: order })!);
}

function volatile(state: MirrorState, nodes: Record<string, unknown>[]): void {
  applySceneDelta(state, parseSceneDelta({ type: "scene-delta", full: false, screenType: "run", upserts: nodes })!);
}

// A 1-frame clip that carries an object url (what the <img> still path paints) and a LIVE refcount, so the specs
// can assert the retain/release balance the object url's lifetime actually depends on.
type TrackedClip = LoadedSpineClip & { refs: number };
function stillClip(stillUrl: string, offsetX = 1, offsetY = 2): TrackedClip {
  const clip: TrackedClip = {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 0,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [
      {
        index: 0,
        offsetX,
        offsetY,
        width: 10,
        height: 20,
        durationMs: 0,
        startMs: 0,
        png: new Uint8Array(),
        // Encoded-bytes-only: the <img> paints the object url, so a decoded ImageBitmap would be dead weight
        // (spineClip.ts's `stillImg` skip). advanceSpine's `!frame.bitmap` guard is what makes that safe.
        bitmap: null
      }
    ],
    stillUrl,
    degraded: false,
    refs: 0,
    retain() {
      clip.refs += 1;
    },
    release() {
      clip.refs -= 1;
    },
    dispose() {}
  };
  return clip;
}

function animatedClip(): LoadedSpineClip {
  const frame = (i: number) => ({
    index: i,
    offsetX: 0,
    offsetY: 0,
    width: 10,
    height: 20,
    durationMs: 150,
    startMs: i * 150,
    png: new Uint8Array(),
    bitmap: { id: `f${i}` } as unknown as ImageBitmap
  });
  return {
    canvasWidth: 100,
    canvasHeight: 200,
    totalDurationMs: 300,
    localX: -50,
    localY: -75,
    localWidth: 100,
    localHeight: 200,
    frames: [frame(0), frame(1)],
    stillUrl: null,
    degraded: false,
    retain() {},
    release() {},
    dispose() {}
  };
}

// The pending decode probes, newest last. Each entry's `ready()` is the moment the browser would have finished
// rastering that url.
let decodes: Array<{ url: string; ready: (ok: boolean) => void }> = [];

function img(stage: HTMLElement): HTMLImageElement | null {
  return stage.querySelector("img.mirror-spine-img");
}
function canvas(stage: HTMLElement): HTMLCanvasElement | null {
  return stage.querySelector("canvas.mirror-spine-canvas");
}

beforeEach(() => {
  document.body.innerHTML = "";
  decodes = [];
  loadSpineClipMock.mockReset();
  dropCacheEntryMock.mockReset();
  mirrorWalkStats.reset();
  __setStillDecoderForTest((url, ready) => {
    decodes.push({ url, ready });
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn()
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  __setStillDecoderForTest(null);
  __setRenderQualityForTest(undefined);
  mirrorSettings.spineMode = "static"; // the product default (the settings store is an app-wide singleton)
  vi.restoreAllMocks();
});

// Drive the default (static / still-only) lane: one fetch per identity, answered by `clips` keyed on the anim.
async function mountStill(clips: Record<string, LoadedSpineClip>): Promise<{ stage: HTMLElement; renderer: MirrorRenderer; state: MirrorState }> {
  loadSpineClipMock.mockImplementation((url: string) => {
    const anim = /anim=([^&]+)/.exec(url)?.[1] ?? "";
    const clip = clips[anim];
    return clip ? Promise.resolve(clip) : Promise.reject(new Error(`no clip for ${url}`));
  });
  const { stage, renderer } = harness();
  const state = createMirrorState();
  full(state, [spineNode()], ["spine"]);
  renderer.reconcile(state);
  await flush();
  return { stage, renderer, state };
}

async function switchAnim(renderer: MirrorRenderer, state: MirrorState, anim: string): Promise<void> {
  volatile(state, [spineNode({ spineCurrentAnim: anim })]);
  renderer.reconcile(state);
  await flush();
}

describe("spine still decode gate — ordering", () => {
  it("holds the swap until the decode resolves, then commits src + placement together", async () => {
    const idle = stillClip("blob:idle");
    const { stage } = await mountStill({ idle_loop: idle });

    // The clip has landed, but NOTHING has been written to the DOM yet: the canvas (the cold-start mechanism) is
    // still up and no <img> exists. Exactly one probe is in flight, for the clip's object url.
    expect(decodes.map((d) => d.url)).toEqual(["blob:idle"]);
    expect(img(stage)).toBeNull();
    expect(canvas(stage)).not.toBeNull();
    expect(mirrorWalkStats.spineStillDecodes).toBe(1);
    expect(mirrorWalkStats.spineStillCommits).toBe(0);

    decodes[0].ready(true);

    const el = img(stage)!;
    expect(el).not.toBeNull();
    expect(el.getAttribute("src")).toBe("blob:idle");
    // canvas 100w → node-local 100w ⇒ scale 1; origin (-50,-75) + the frame's (1,2) tight-crop offset.
    expect(el.style.width).toBe("10px");
    expect(el.style.height).toBe("20px");
    expect(el.style.transform).toBe("translate(-49px, -73px) scale(1)");
    expect(el.decoding).toBe("sync"); // gated ⇒ the swap presents atomically (frozen-canvas precedent)
    expect(canvas(stage)).toBeNull();
    expect(mirrorWalkStats.spineStillCommits).toBe(1);
  });

  it("leaves the OUTGOING still painting for the whole decode, and swaps src+styles in ONE task", async () => {
    const idle = stillClip("blob:idle", 1, 2);
    const attack = stillClip("blob:attack", 5, 6);
    const { stage, renderer, state } = await mountStill({ idle_loop: idle, attack });
    decodes[0].ready(true);
    const el = img(stage)!;
    const before = { src: el.getAttribute("src"), transform: el.style.transform };

    const seen: string[][] = [];
    const observer = new MutationObserver((records) => seen.push(records.map((r) => r.attributeName ?? "")));
    observer.observe(el, { attributes: true });

    await switchAnim(renderer, state, "attack");

    // THE FLICKER FIX: the element is untouched while the new frame decodes — same url, same geometry.
    expect(decodes.map((d) => d.url)).toEqual(["blob:idle", "blob:attack"]);
    expect(el.getAttribute("src")).toBe(before.src);
    expect(el.style.transform).toBe(before.transform);
    await Promise.resolve();
    expect(seen.flat()).toEqual([]); // literally zero attribute writes during the decode

    decodes[1].ready(true);
    expect(el.getAttribute("src")).toBe("blob:attack");
    expect(el.style.transform).toBe("translate(-45px, -69px) scale(1)");
    await Promise.resolve();
    // ATOMIC: the src and the placement land in the SAME mutation batch, so no frame can observe the new geometry
    // on the old pixels (or the reverse).
    expect(seen.length).toBe(1);
    expect(new Set(seen[0])).toEqual(new Set(["src", "style"]));
    observer.disconnect();
  });

  it("applies a SAME-url placement change immediately (a moving creature never waits on a decode)", async () => {
    const idle = stillClip("blob:idle");
    const { stage, renderer, state } = await mountStill({ idle_loop: idle });
    decodes[0].ready(true);
    const el = img(stage)!;
    expect(decodes.length).toBe(1);

    // Re-arrive at the SAME clip (idle → attack → idle, the combat loop): the pixels are already on screen, so the
    // re-placement is a pure style write with no probe at all.
    const attack = stillClip("blob:attack");
    loadSpineClipMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes("attack") ? attack : idle)
    );
    await switchAnim(renderer, state, "attack");
    expect(decodes.length).toBe(2); // the attack still is gated…
    await switchAnim(renderer, state, "idle_loop");
    expect(decodes.length).toBe(2); // …but coming back to the WARM idle url writes no new probe
    expect(el.getAttribute("src")).toBe("blob:idle");

    // …and the late attack decode is dropped: the record has moved back to the idle clip.
    decodes[1].ready(true);
    expect(el.getAttribute("src")).toBe("blob:idle");
    expect(mirrorWalkStats.spineStillStale).toBe(1);
  });

  it("dedupes a second arrival of the SAME url while its decode is in flight", async () => {
    // The still-first chain against a host that DEGRADES the animated bake to a single frame: the same clip is
    // applied twice (once as the still-first placeholder, once as the animated answer) before the first probe has
    // resolved. Without the dedupe token that is two decodes — and, on a busy screen, two per creature per swap.
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
    mirrorSettings.spineMode = "dynamic";
    const shared = stillClip("blob:idle");
    shared.degraded = true; // a deliberate host stand-in ⇒ no #4 retry=1 escalation
    loadSpineClipMock.mockImplementation(() => Promise.resolve(shared));
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();

    expect(loadSpineClipMock).toHaveBeenCalledTimes(2); // still-first, then the chained animated request
    expect(decodes.map((d) => d.url)).toEqual(["blob:idle"]); // …but ONE probe
    decodes[0].ready(true);
    expect(img(stage)!.getAttribute("src")).toBe("blob:idle");
    expect(mirrorWalkStats.spineStillCommits).toBe(1);
  });
});

describe("spine still decode gate — stale arrivals", () => {
  it("drops a decode whose identity changed mid-flight (two switches, only the last commits)", async () => {
    const idle = stillClip("blob:idle");
    const attack = stillClip("blob:attack");
    const hurt = stillClip("blob:hurt");
    const { stage, renderer, state } = await mountStill({ idle_loop: idle, attack, hurt });
    decodes[0].ready(true);
    const el = img(stage)!;

    await switchAnim(renderer, state, "attack");
    await switchAnim(renderer, state, "hurt");
    expect(decodes.map((d) => d.url)).toEqual(["blob:idle", "blob:attack", "blob:hurt"]);

    decodes[1].ready(true); // the superseded attack lands LATE — it must not paint
    expect(el.getAttribute("src")).toBe("blob:idle");
    expect(mirrorWalkStats.spineStillStale).toBe(1);

    decodes[2].ready(true);
    expect(el.getAttribute("src")).toBe("blob:hurt");
    expect(mirrorWalkStats.spineStillCommits).toBe(2);
  });

  it("drops a still whose decode outlives the animated hot-swap (still-first → clip)", async () => {
    // The animated lane: a cheap 1-frame still is fetched first, then the full clip is chained in behind it.
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
    mirrorSettings.spineMode = "dynamic";
    const still = stillClip("blob:still");
    loadSpineClipMock.mockImplementation((url: string) =>
      url.includes("still=1") ? Promise.resolve(still) : Promise.resolve(animatedClip())
    );
    const { stage, renderer } = harness();
    const state = createMirrorState();
    full(state, [spineNode()], ["spine"]);
    renderer.reconcile(state);
    await flush();

    expect(decodes.map((d) => d.url)).toEqual(["blob:still"]);
    // The animated clip has already swapped the mechanism back to the canvas by the time the still decodes.
    expect(canvas(stage)).not.toBeNull();
    decodes[0].ready(true);
    expect(img(stage)).toBeNull();
    expect(canvas(stage)).not.toBeNull();
    expect(mirrorWalkStats.spineStillStale).toBe(1);
    expect(still.refs).toBe(0); // the never-displayed still holds no retain
  });
});

describe("spine still decode gate — retain / release balance", () => {
  it("keeps the DISPLAYED clip retained across an identity change, and releases it on the swap + on teardown", async () => {
    const idle = stillClip("blob:idle");
    const attack = stillClip("blob:attack");
    const { stage, renderer, state } = await mountStill({ idle_loop: idle, attack });
    decodes[0].ready(true);
    // record.spineClip + record.spineShownStill — two independent retains on the same clip.
    expect(idle.refs).toBe(2);

    await switchAnim(renderer, state, "attack");
    // The identity moved on (spineClip released), but the idle frame is STILL ON SCREEN, so its object url must
    // survive: this is the retain that stops an LRU eviction revoking a url a live <img> is painting.
    expect(idle.refs).toBe(1);
    expect(img(stage)!.getAttribute("src")).toBe("blob:idle");

    decodes[1].ready(true);
    expect(idle.refs).toBe(0); // its pixels are gone → released
    expect(attack.refs).toBe(2);

    // The node leaves the scene: both retains go with the element.
    full(state, [], []);
    renderer.reconcile(state);
    expect(attack.refs).toBe(0);
    expect(stage.querySelector("img.mirror-spine-img")).toBeNull();
  });

  it("releases the displayed still when the mechanism swaps back to the canvas", async () => {
    const still = stillClip("blob:still");
    const { stage, renderer, state } = await mountStill({ idle_loop: still });
    decodes[0].ready(true);
    expect(still.refs).toBe(2);
    expect(img(stage)).not.toBeNull();

    // The settings panel flips Static → Dynamic: still-vs-animated is part of the clip identity, so the same
    // animation re-requests and comes back as a multi-frame clip, which puts the canvas back.
    __setRenderQualityForTest(resolveRenderQuality({ search: "?quality=high&spineClips=on", gpu: UNKNOWN_GPU }));
    mirrorSettings.spineMode = "dynamic";
    loadSpineClipMock.mockImplementation(() => Promise.resolve(animatedClip()));
    volatile(state, [spineNode()]);
    renderer.reconcile(state);
    await flush();
    expect(canvas(stage)).not.toBeNull();
    expect(img(stage)).toBeNull();
    expect(still.refs).toBe(0);
  });
});

describe("spine still decode gate — cache eviction tokens", () => {
  it("hands back every earlier clip when a TERMINAL animation starts, and the corpse's own on removal", async () => {
    const idle = stillClip("blob:idle");
    const attack = stillClip("blob:attack");
    const death = stillClip("blob:death");
    const { renderer, state } = await mountStill({ idle_loop: idle, attack, death });
    decodes[0].ready(true);
    await switchAnim(renderer, state, "attack");
    decodes[1].ready(true);
    expect(dropCacheEntryMock).not.toHaveBeenCalled();

    await switchAnim(renderer, state, "death");
    // The creature is dying: idle + attack will never play again, so their entries go back to the cache NOW (the
    // refcount keeps anything still painting alive). The death clip itself is NOT dropped — it is what's on screen.
    expect(dropCacheEntryMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      [
        "/spines/scenes/combat/characters/cultist.tscn?node=Visuals%2FSpineSprite&anim=attack&still=1",
        "/spines/scenes/combat/characters/cultist.tscn?node=Visuals%2FSpineSprite&anim=idle_loop&still=1"
      ].sort()
    );
    decodes[2].ready(true);

    dropCacheEntryMock.mockClear();
    full(state, [], []);
    renderer.reconcile(state);
    expect(dropCacheEntryMock.mock.calls.map((c) => c[0])).toEqual([
      "/spines/scenes/combat/characters/cultist.tscn?node=Visuals%2FSpineSprite&anim=death&still=1"
    ]);
  });

  it("evicts NOTHING when a living creature merely leaves the DOM (dormant reclaim rebuilds it)", async () => {
    const idle = stillClip("blob:idle");
    const attack = stillClip("blob:attack");
    const { renderer, state } = await mountStill({ idle_loop: idle, attack });
    decodes[0].ready(true);
    await switchAnim(renderer, state, "attack");
    decodes[1].ready(true);

    full(state, [], []);
    renderer.reconcile(state);
    expect(dropCacheEntryMock).not.toHaveBeenCalled();
  });
});

describe("spine still decode gate — capability recovery", () => {
  it("decodes a still before committing it even when the display mechanism is canvas", async () => {
    const idle = stillClip("blob:idle");
    const { stage } = await mountStill({ idle_loop: idle });

    expect(decodes).toHaveLength(1);
    expect(img(stage)).toBeNull();
    expect(canvas(stage)).not.toBeNull();
    decodes[0].ready(true);
    expect(mirrorWalkStats.spineStillCommits).toBe(1);
  });

  it("passes through SYNCHRONOUSLY where HTMLImageElement.decode is missing (jsdom fail-open)", async () => {
    // The production decoder, against jsdom's decode-less <img>: `ready` must fire before decodeStill returns, or
    // every environment without decode() would freeze on its first still forever.
    __setStillDecoderForTest(null);
    const idle = stillClip("blob:idle");
    const { stage } = await mountStill({ idle_loop: idle });
    expect(img(stage)!.getAttribute("src")).toBe("blob:idle");
    expect(mirrorWalkStats.spineStillCommits).toBe(1);
  });
});

// The client half of the host's `Sts2SpineStillFrame.IsTerminalAnimation` — the two must agree, since the host
// uses it to pick the corpse pose and the client uses it to decide a creature's clips are dead weight.
describe("isTerminalSpineAnim (lockstep with Sts2SpineStillFrame.cs)", () => {
  it("matches die/death/dead/defeat as NAME TOKEN PREFIXES, case-insensitively", () => {
    // Prefix, not whole word — same as the host's `token.StartsWith(prefix, OrdinalIgnoreCase)`, which is why
    // "die_loop" (and, harmlessly, a hypothetical "diet") answer true.
    for (const name of ["die", "death", "dead", "defeat", "Death", "DIE", "cultist_die", "boss-death_loop", "anim.defeat", "a/dead", "diet"]) {
      expect(isTerminalSpineAnim(name), name).toBe(true);
    }
  });

  it("never matches a mere substring, and answers false for nothing", () => {
    for (const name of ["audience_idle", "idle_loop", "attack", "shield_bash", "undead", "hurt"]) {
      expect(isTerminalSpineAnim(name), name).toBe(false);
    }
    expect(isTerminalSpineAnim(null)).toBe(false);
    expect(isTerminalSpineAnim(undefined)).toBe(false);
    expect(isTerminalSpineAnim("")).toBe(false);
    expect(isTerminalSpineAnim("   ")).toBe(false);
  });

  it("tolerates repeated / leading / trailing separators (RemoveEmptyEntries parity)", () => {
    expect(isTerminalSpineAnim("__die__")).toBe(true);
    expect(isTerminalSpineAnim("  cultist   death ")).toBe(true);
    expect(isTerminalSpineAnim("---")).toBe(false);
  });
});
