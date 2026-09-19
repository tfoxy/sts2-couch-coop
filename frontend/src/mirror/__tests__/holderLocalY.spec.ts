// THE SHARED POSE READ — the five legs both stage backends now take, pinned once.
//
// `raise/holderLocalY` is the number the whole focus ramp is a function of, and until this round it existed twice
// (once in `mirrorRenderer`, once in `canvas/handRaise`) with a comment on each saying it was leg-for-leg with the
// other. Two copies of a pose read, in the two backends that must draw the same hand, is the shape of the
// hand-landing report. The legs are shared now; what is still a port is WHICH endpoint counts as live (the H10
// guard in that module), and the last case below pins that the port is genuinely a port — the same state answers
// differently for two backends whose `liveEndpointY` disagree, which is exactly the divergence H10 is about.

import { describe, expect, it } from "vitest";

import { HAND_RAISE_RAMP_START_Y } from "@/mirror/raise/constants";
import { holderLocalY, holderPaintedLocalY, type HolderPoseEnv } from "@/mirror/raise/holderLocalY";
import type { MirrorNode } from "@/mirror/sceneTree";

const HAND_CONTAINER_NAME = "CardHolderContainer";

function node(id: string, parentId: string | null, over: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id,
    parentId,
    name: id,
    nodeType: "Godot.Control",
    transform: [1, 0, 0, 1, 0, 0],
    ...over
  } as MirrorNode;
}

/** A hand: the container the fan hangs off, one holder in it, and one holder parked on the hand root. */
function scene(holderOver: Partial<MirrorNode> = {}): Map<string, MirrorNode> {
  const nodes = new Map<string, MirrorNode>();
  nodes.set("hand", node("hand", null, { name: "NPlayerHand" }));
  nodes.set("container", node("container", "hand", { name: HAND_CONTAINER_NAME, transform: [1, 0, 0, 1, 960, 1080] }));
  nodes.set("holder", node("holder", "container", { transform: [1, 0, 0, 1, 0, -50], ...holderOver }));
  nodes.set("dragged", node("dragged", "hand", { transform: [1, 0, 0, 1, 900, 700] }));
  return nodes;
}

function env(nodes: Map<string, MirrorNode>, over: Partial<HolderPoseEnv> = {}): HolderPoseEnv {
  return {
    nodes,
    parentGlobalY: () => 1080,
    liveEndpointY: () => null,
    ...over
  };
}

describe("holderLocalY — the pose the focus ramp reads", () => {
  it("is the streamed y itself in local space (the modern producer's parent-relative transform)", () => {
    expect(holderLocalY(env(scene()), "holder")).toBe(-50);
  });

  it("prefers a LIVE endpoint over the streamed pose — which is frozen for the tween's whole window", () => {
    // The producer suppresses a tweened node's transforms, so the streamed -50 is the PRE-tween pose. The endpoint
    // (a global) says the card is on its way to the focus height, and the ramp has to ride that down.
    const nodes = scene();
    expect(holderLocalY(env(nodes, { liveEndpointY: () => 1080 - 209 }), "holder")).toBe(-209);
  });

  it("falls back to the resting fan when the node is tween-owned and has NO transform at all", () => {
    // The real shape of a cancelled play: the game re-describes the holder into the container with no pose, and
    // the pose follows a tick later. Guessing the resting fan is right because the pose the ramp exists for — the
    // focus — is a TELEPORT, which is streamed and never suppressed.
    const nodes = scene({ transform: null });
    expect(holderLocalY(env(nodes), "holder")).toBe(HAND_RAISE_RAMP_START_Y);
  });

  it("answers null for a holder that is OUT OF THE FAN — a dragged card keeps the game's pose exactly", () => {
    expect(holderLocalY(env(scene()), "dragged")).toBeNull();
  });

  it("answers null for an unknown node, and for one whose parent is not in the map", () => {
    const nodes = scene();
    nodes.set("orphan", node("orphan", "gone", { transform: [1, 0, 0, 1, 0, -50] }));
    expect(holderLocalY(env(nodes), "nobody")).toBeNull();
    expect(holderLocalY(env(nodes), "orphan")).toBeNull();
  });

  it("ignores an endpoint it cannot frame — no parent global, no subtraction", () => {
    // An endpoint is a GLOBAL; without the frame it was lifted into there is nothing to subtract, so the streamed
    // pose stays the answer rather than a global masquerading as a local one.
    const nodes = scene();
    expect(holderLocalY(env(nodes, { parentGlobalY: () => null, liveEndpointY: () => 871 }), "holder")).toBe(-50);
  });

  it("is the PORT that decides H10: one state, two `liveEndpointY` answers, two results", () => {
    // The DOM's predicate is wider than the canvas's (a pin in force OR a pending catch-up, vs a genuinely running
    // channel). This is that difference, in one assertion: the legs are identical, so anything the two backends
    // disagree about now has to come through here — which is what makes H10 a one-line change when it is settled.
    const nodes = scene();
    const stale = holderLocalY(env(nodes, { liveEndpointY: () => 1080 - 209 }), "holder");
    const strict = holderLocalY(env(nodes, { liveEndpointY: () => null }), "holder");
    expect(stale).toBe(-209);
    expect(strict).toBe(-50);
  });
});

// The SECOND question, asked of the same legs: not where the card is headed, where it IS. Used to put the DOM's
// cosmetic lift channel in phase with the pose channel before both of them ease (see `noteTransformArmPose`), which
// is a write of a drawn position — so a guess is the one answer it must never give.
describe("holderPaintedLocalY — the pose the holder is drawn at", () => {
  it("agrees with the ramp read wherever a real pose exists, streamed or endpoint", () => {
    expect(holderPaintedLocalY(env(scene()), "holder")).toBe(-50);
    const framed = env(scene(), { liveEndpointY: () => 1080 - 209 });
    expect(holderPaintedLocalY(framed, "holder")).toBe(holderLocalY(framed, "holder"));
  });

  it("answers NULL where the ramp read guesses the resting fan", () => {
    // A tween-owned holder with its transform suppressed: the ramp has to produce a destination for it, and the
    // resting fan is the honest guess for one. There is no honest guess for where it is being DRAWN, and stepping
    // its lift to a pose it is not at would snap the card by up to the whole 119px.
    const nodes = scene({ transform: null });
    expect(holderLocalY(env(nodes), "holder")).toBe(HAND_RAISE_RAMP_START_Y);
    expect(holderPaintedLocalY(env(nodes), "holder")).toBeNull();
  });

  it("answers null for the same non-holders the ramp read refuses", () => {
    expect(holderPaintedLocalY(env(scene()), "dragged")).toBeNull();
    expect(holderPaintedLocalY(env(scene()), "nobody")).toBeNull();
  });
});
