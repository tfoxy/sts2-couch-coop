import type { MirrorNode } from "@/mirror/sceneTree";

export interface StaticBackgroundRuntimePorts<Record> {
  nodes(): ReadonlyMap<string, MirrorNode>;
  records(): ReadonlyMap<string, Record>;
  staticBgEnabled(): boolean;
  targetPath(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): string | null;
  isSuppressibleRoot(node: MirrorNode, nodes: ReadonlyMap<string, MirrorNode>): boolean;
  writeDisplay(record: Record): void;
  markEffectsDirty(): void;
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
// preserves its record/walk ownership while keeping hold and suppression ordering in one place.
//
// The build hold is unconditional for every covered family while the setting is on. Image readiness is deliberately
// absent from these ports: fetch/decode failure and timeout can change only the still, never root admission.
export function createStaticBackgroundRuntime<Record>(ports: StaticBackgroundRuntimePorts<Record>): StaticBackgroundRuntime {
  let shownScenePath: string | null = null;
  let holdActive = false;
  const suppressedRootIds = new Set<string>();
  const heldIds = new Set<string>();
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
    if (ports.targetPath(node, nodes()) === null) {
      heldIds.delete(id);
      return false;
    }
    if (!ports.isSuppressibleRoot(node, nodes())) {
      if (heldIds.size > 0) heldIds.delete(id);
      return false;
    }
    heldIds.add(id);
    return true;
  }

  function beginWalk(): void {
    holdActive = ports.staticBgEnabled();
  }

  function finishWalk(): void {
    for (const id of heldIds) if (!nodes().has(id)) heldIds.delete(id);
  }

  function setShown(scenePath: string | null): void {
    if (scenePath === shownScenePath) return;
    shownScenePath = scenePath;
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

  return { heldIds, suppressedRootIds, suppress, hold, beginWalk, finishWalk, setShown, dispose: () => { heldIds.clear(); suppressedRootIds.clear(); } };
}
