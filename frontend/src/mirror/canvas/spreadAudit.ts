// THE STAGE-WIDE WIDE-SCREEN FIELD AUDIT (`?spreadAudit=1`) — one invariant, checked on every node, every build.
//
// WHY IT EXISTS. The Aug-29 hand-landing defect was a field claim measured at the pose the WIRE last reported
// rather than the pose the node was DRAWN at, and it survived three rounds of instruments because every one of
// them was shaped like a hand: they sampled the tween's TARGET, which is a zero-size holder that paints nothing,
// and the holder's own claim was right the whole time. The nodes that were wrong were its painted descendants,
// which no hand-shaped probe looked at.
//
// So the invariant this checks is deliberately not about hands:
//
//     for EVERY node, the applied `spreadDx` must equal the field claim evaluated at the pose it is DRAWN at.
//
// A tween, a card flight, an idle bob, a replayed endpoint — anything that moves a node client-side is covered by
// the same sentence, and any future subtree that moves without its claim following will fail this rather than
// being discovered in a screenshot two rounds later.
//
// WHAT A ROW MEANS.
//   * `reason: "drawn-pose"` — a REAL defect. The node is drawn somewhere its claim was not evaluated, and the
//     `deltaPx` is exactly how far off the screen its pixels are. Expect zero of these.
//   * `reason: "local-anim"` — EXPECTED, and not gated. The idle vocabulary (`idleAnim.ts`) is a cosmetic
//     decoration the game believes is pinned at rest; the walk deliberately keeps it out of the claim, because a
//     claim that moved with a bob would make the shift a function of the browser's own clock (and `listPatch`'s
//     tier-3 arm reasons about exactly that). The delta is then the bob's own amplitude times `F − 1`, single px.
//
// Mode-0 nodes never produce a row and that is correct rather than a blind spot: a rigid rider, an anchor-algebra
// Control, an owner-anchored floater and a remote follower all take their shift from something that is NOT their
// own X, so there is nothing local to re-evaluate — the claim they ride is audited at the ancestor that made it.
//
// FREE WHEN OFF. The builder holds `null` unless the lever is set, and nothing below is reached.

import type { MirrorNode } from "@/mirror/sceneTree";
import { fieldDxAtGlobal, type SpreadAffine, type SpreadBox } from "@/mirror/spreadLayout";

/** Sub-hundredth-px differences are float noise in an affine compose, not a misplaced claim. */
export const SPREAD_AUDIT_EPS_PX = 0.01;

/** How many rows a report keeps. The WORST ones, not the first ones — see {@link auditSpreadClaim}. */
export const SPREAD_AUDIT_CAPACITY = 64;

export type SpreadAuditReason = "drawn-pose" | "local-anim";

export interface SpreadAuditRow {
  id: string;
  name: string;
  /** {@link SpreadOut.fieldMode}: 1 = the pass-through ORIGIN field, 2 = a positional claimer's CENTRE field. */
  fieldMode: number;
  /** The shift the build actually drew this node with. */
  applied: number;
  /** The shift the same rule gives at the node's drawn pose. */
  expected: number;
  /** `expected − applied`, in design px: how far right of where it belongs the node was painted. */
  deltaPx: number;
  /** The node's TRUE (streamed) origin x, i.e. where the claim was measured. */
  gameX: number;
  /** …and its DRAWN, unshifted origin x, i.e. where it should have been measured. */
  drawnX: number;
  reason: SpreadAuditReason;
}

export interface SpreadAudit {
  /** Nodes examined this build — a report of 0 rows out of 0 checked has proved nothing. */
  checked: number;
  /** Nodes drawn away from their streamed pose (by an override or a local anim), i.e. the exposed population. */
  moved: number;
  rows: SpreadAuditRow[];
  /** The largest `|deltaPx|` seen this build, INCLUDING rows evicted past the capacity. */
  worstPx: number;
  /** …and of the `"drawn-pose"` rows alone, which is the number a gate reads. */
  worstDefectPx: number;
}

export function createSpreadAudit(): SpreadAudit {
  return { checked: 0, moved: 0, rows: [], worstPx: 0, worstDefectPx: 0 };
}

/** Re-arm for a build. The rows array is replaced rather than emptied, so a held report stays readable. */
export function resetSpreadAudit(audit: SpreadAudit): void {
  audit.checked = 0;
  audit.moved = 0;
  audit.rows = [];
  audit.worstPx = 0;
  audit.worstDefectPx = 0;
}

/**
 * Check one node's applied shift against the claim at its drawn pose, and record it when they differ.
 *
 * `applied` is passed as `fieldDxAtGlobal`'s `walkedDx`, which makes a mode-0 node compare equal by construction
 * — the rule's own statement that such a node has no claim of its own to re-evaluate.
 */
export function auditSpreadClaim(
  audit: SpreadAudit,
  id: string,
  node: MirrorNode,
  fieldMode: number,
  applied: number,
  gGame: SpreadAffine,
  gDrawn: SpreadAffine,
  drawBox: SpreadBox | null,
  spreadFactor: number,
  moved: boolean,
  animMoved: boolean
): void {
  audit.checked++;
  if (moved || animMoved) {
    audit.moved++;
  }
  const expected = fieldDxAtGlobal(fieldMode, applied, gDrawn, node, drawBox, spreadFactor);
  const deltaPx = expected - applied;
  const magnitude = Math.abs(deltaPx);
  if (magnitude <= SPREAD_AUDIT_EPS_PX) {
    return;
  }
  // A node inside a local-anim subtree AND inside a moved one is reported as the defect it would be: the anim is
  // the smaller effect, and mislabelling a real mis-claim as expected is the failure mode that matters here.
  const reason: SpreadAuditReason = moved || !animMoved ? "drawn-pose" : "local-anim";
  audit.worstPx = Math.max(audit.worstPx, magnitude);
  if (reason === "drawn-pose") {
    audit.worstDefectPx = Math.max(audit.worstDefectPx, magnitude);
  }
  audit.rows.push({
    id,
    name: node.name ?? "",
    fieldMode,
    applied,
    expected,
    deltaPx,
    gameX: gGame[4],
    drawnX: gDrawn[4],
    reason
  });
  if (audit.rows.length > SPREAD_AUDIT_CAPACITY) {
    // Keep the WORST, not the first: a stage with hundreds of tiny local-anim rows would otherwise bury the one
    // 23px row that is the whole point of the instrument.
    audit.rows.sort((a, b) => Math.abs(b.deltaPx) - Math.abs(a.deltaPx));
    audit.rows.length = SPREAD_AUDIT_CAPACITY;
  }
}

/** What the window seam answers: the last build's audit, plus the same thing already formatted for a console. */
export interface SpreadAuditReport extends SpreadAudit {
  text: string;
}

export function spreadAuditReport(audit: SpreadAudit): SpreadAuditReport {
  return { ...audit, rows: audit.rows.slice(), text: formatSpreadAudit(audit) };
}

/** Where a console (and the live harness) finds the last build's report. Present only with `?spreadAudit=1`. */
export const SPREAD_AUDIT_GLOBAL = "__mirrorSpreadAudit";
const SPREAD_AUDIT_OWNER = "__mirrorSpreadAuditOwner";

/**
 * Install (or, with `read` null, remove) the window seam — `installHandPoseProbe`'s shape, including its owner
 * guard: `MirrorView` builds a replacement renderer BEFORE disposing the old one on a stage flip, so a late
 * `dispose()` must not unhook its successor.
 */
export function installSpreadAuditProbe(read: (() => SpreadAuditReport) | null, owner: object): void {
  if (typeof window === "undefined") {
    return;
  }
  const slot = window as unknown as Record<string, unknown>;
  if (read === null) {
    if (slot[SPREAD_AUDIT_OWNER] === owner) {
      delete slot[SPREAD_AUDIT_GLOBAL];
      delete slot[SPREAD_AUDIT_OWNER];
    }
    return;
  }
  slot[SPREAD_AUDIT_GLOBAL] = read;
  slot[SPREAD_AUDIT_OWNER] = owner;
}

/** A console-readable report — worst first, defects before the expected rows. */
export function formatSpreadAudit(audit: SpreadAudit): string {
  const rows = audit.rows
    .slice()
    .sort((a, b) => {
      if (a.reason !== b.reason) {
        return a.reason === "drawn-pose" ? -1 : 1;
      }
      return Math.abs(b.deltaPx) - Math.abs(a.deltaPx);
    })
    .map(
      (r) =>
        `  ${r.reason === "drawn-pose" ? "DEFECT" : "  anim"} ${r.deltaPx >= 0 ? "+" : ""}${r.deltaPx.toFixed(2)}px ` +
        `mode ${r.fieldMode} applied ${r.applied.toFixed(2)} expected ${r.expected.toFixed(2)} ` +
        `gameX ${r.gameX.toFixed(1)} drawnX ${r.drawnX.toFixed(1)}  ${r.name} [${r.id}]`
    );
  const defects = audit.rows.filter((r) => r.reason === "drawn-pose").length;
  return (
    `spread audit: ${audit.checked} nodes checked, ${audit.moved} drawn off their streamed pose, ` +
    `${defects} mis-claimed (worst ${audit.worstDefectPx.toFixed(2)}px)` +
    (rows.length === 0 ? "" : `\n${rows.join("\n")}`)
  );
}
