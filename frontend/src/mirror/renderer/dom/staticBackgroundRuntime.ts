import type { MirrorNode } from "@/mirror/sceneTree";

export interface StaticBackgroundRuntimePorts<Record> {
  nodes(): ReadonlyMap<string, MirrorNode>;
  records(): ReadonlyMap<string, Record>;
  staticBgEnabled(): boolean;
  staticBgFailed(): boolean;
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
    holdActive = ports.staticBgEnabled() && !ports.staticBgFailed();
    if (!holdActive && holdDeadlines.size > 0) holdDeadlines.clear();
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
