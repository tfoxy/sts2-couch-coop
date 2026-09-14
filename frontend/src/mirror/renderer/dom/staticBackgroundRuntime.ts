import type { MirrorNode } from "@/mirror/sceneTree";

export interface StaticBackgroundRuntimePorts<Record> {
  nodes(): ReadonlyMap<string, MirrorNode>;
  records(): ReadonlyMap<string, Record>;
  staticBgEnabled(): boolean;
  // The FAIL-OPEN latch — see mirrorSettings.staticBgFailedOpen. It is set ONLY by a failure on a family that
  // still fails open (event backdrops, the shop); a failed COMBAT still never sets it, because a combat hold is
  // unconditional (see hold()).
  staticBgFailedOpen(): boolean;
  now(): number;
  holdMaxMs(): number;
  expiredDeadline: number;
  targetPath(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): string | null;
  isSuppressibleRoot(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): boolean;
  isCombatPath(path: string): boolean;
  isCombatRoot(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): boolean;
  writeDisplay(record: Record): void;
  markEffectsDirty(): void;
  noteHoldExpiry(): void;
}

export interface StaticBackgroundRuntime {
  readonly heldIds: ReadonlySet<string>;
  readonly suppressedRootIds: ReadonlySet<string>;
  suppress(id: string, node: MirrorNode): boolean;
  hold(id: string, node: MirrorNode): boolean;
  beginWalk(): void;
  finishWalk(): void;
  setShown(scenePath: string | null): void;
  dispose(): void;
}

// Owns the stateful static-image protocol. The renderer only supplies live-node and display-write ports, which
// preserves its record/walk ownership while keeping deadline and suppression ordering in one place.
//
// TWO HOLD REGIMES, split by family (see `hold`):
//   COMBAT  — UNCONDITIONAL while the setting is on. Performance is the point of the setting, so a missing
//             picture must never buy the phone the ~500-element live bg subtree back. No failure fold, no belt.
//   EVENTS / SHOP — unchanged fail-open: a failed still releases the hold and the live backdrop returns, with
//             the per-path belt still bounding "held with nothing resolving".
export function createStaticBackgroundRuntime<Record>(ports: StaticBackgroundRuntimePorts<Record>): StaticBackgroundRuntime {
  let shownScenePath: string | null = null;
  let holdActive = false;
  const suppressedRootIds = new Set<string>();
  const heldIds = new Set<string>();
  const holdDeadlines = new Map<string, number>();
  const nodes = () => ports.nodes();

  function suppress(id: string, node: MirrorNode): boolean {
    if (shownScenePath === null) return false;
    if (ports.targetPath(node, nodes()) !== shownScenePath) {
      if (suppressedRootIds.size > 0) suppressedRootIds.delete(id);
      return false;
    }
    if (ports.staticBgEnabled() && ports.isSuppressibleRoot(node, nodes())) {
      suppressedRootIds.add(id);
      return true;
    }
    suppressedRootIds.delete(id);
    return false;
  }

  function hold(id: string, node: MirrorNode): boolean {
    if (!holdActive) {
      if (heldIds.size > 0) heldIds.delete(id);
      return false;
    }
    const path = ports.targetPath(node, nodes());
    if (path === null) return false;
    if (!ports.isSuppressibleRoot(node, nodes())) {
      if (heldIds.size > 0) heldIds.delete(id);
      return false;
    }
    if (path !== shownScenePath && shownScenePath !== null && ports.isCombatPath(shownScenePath) && !ports.isCombatRoot(node, nodes())) {
      heldIds.delete(id);
      return false;
    }
    // COMBAT HOLDS UNCONDITIONALLY (the product rule): while "Static background" is on, the combat background
    // scene root is NEVER built as a DOM subtree — not on a 404, not on a stalled fetch, not after any deadline.
    // The viewer sees the digest-less still, the previous still for this same room, or `.mirror-stage`'s own
    // #181818 (StaticBackground.vue's ladder, in that order); what they never see is the ~500-element live
    // scenery this setting exists to stop compositing. So neither the fail-open latch below nor the per-path
    // deadline applies here — `staticBgHoldExpiries` is structurally 0 for combat, which is the signal we want.
    // Reached only past the isSuppressibleRoot gate above, so a combat-convention path here IS a combat root
    // (the MainMenu/RestSite background scenes never pass that gate).
    if (ports.isCombatPath(path)) {
      heldIds.add(id);
      return true;
    }
    // EVENT backdrops and the shop keep the fail-open safety net: their stills are frame-qualified against a
    // live-probed transform, a wrong frame is VISIBLE (the recovered lerp drifts from the shipped game), and the
    // host re-admits their subtree on the same latch — so a failure there returns the live scenery.
    if (ports.staticBgFailedOpen()) {
      if (heldIds.size > 0) heldIds.delete(id);
      return false;
    }
    if (path === shownScenePath) {
      heldIds.add(id);
      return true;
    }
    const deadline = holdDeadlines.get(path);
    if (deadline === ports.expiredDeadline) {
      heldIds.delete(id);
      return false;
    }
    if (deadline === undefined) {
      holdDeadlines.set(path, ports.now() + ports.holdMaxMs());
    } else if (ports.now() >= deadline) {
      ports.noteHoldExpiry();
      holdDeadlines.set(path, ports.expiredDeadline);
      heldIds.delete(id);
      return false;
    }
    heldIds.add(id);
    return true;
  }

  function beginWalk(): void {
    // The hold is now a function of the SETTING alone; the failure fold moved into `hold`, where it can be
    // applied per-path (combat holds through a failure, every other family still fails open).
    holdActive = ports.staticBgEnabled();
    // Deadlines are cleared on either release edge, exactly as when the fold lived here: a path whose belt was
    // already running when the fail-open latch engaged must not come back already-expired on recovery.
    if ((!holdActive || ports.staticBgFailedOpen()) && holdDeadlines.size > 0) holdDeadlines.clear();
  }

  function finishWalk(): void {
    for (const id of heldIds) if (!nodes().has(id)) heldIds.delete(id);
  }

  function setShown(scenePath: string | null): void {
    if (scenePath === shownScenePath) return;
    shownScenePath = scenePath;
    if (scenePath !== null) holdDeadlines.delete(scenePath);
    for (const id of [...suppressedRootIds]) {
      const node = nodes().get(id);
      if (scenePath === null || !node || ports.targetPath(node, nodes()) !== scenePath || !ports.staticBgEnabled() || !ports.isSuppressibleRoot(node, nodes())) {
        suppressedRootIds.delete(id);
        const record = ports.records().get(id);
        if (record) ports.writeDisplay(record);
      }
    }
    if (scenePath !== null && ports.staticBgEnabled()) {
      for (const [id, node] of nodes()) {
        if (ports.targetPath(node, nodes()) === scenePath && !suppressedRootIds.has(id) && ports.isSuppressibleRoot(node, nodes())) {
          suppressedRootIds.add(id);
          const record = ports.records().get(id);
          if (record) ports.writeDisplay(record);
        }
      }
    }
    ports.markEffectsDirty();
  }

  return { heldIds, suppressedRootIds, suppress, hold, beginWalk, finishWalk, setShown, dispose: () => { heldIds.clear(); holdDeadlines.clear(); suppressedRootIds.clear(); } };
}
