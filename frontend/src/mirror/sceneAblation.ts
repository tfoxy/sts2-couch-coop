import { resolveSceneInfo } from "@/mirror/renderer/sceneIdentity";
import type { MirrorNode, MirrorState } from "@/mirror/sceneTree";

export const SCENE_ABLATION_CONFIG_GLOBAL = "__mirrorSceneAblationConfig";
export const SCENE_ABLATION_RECEIPT_GLOBAL = "__mirrorSceneAblationReceipt";

export type SceneAblationMode =
  | "full"
  | "exclude"
  | "include"
  | "no-groups"
  | "data-only"
  | "app-shell";

export interface SceneGroupSelector {
  sceneFile: string;
  relativePath: string;
}

export interface EffectiveSceneAblationConfig {
  version: 1;
  mode: SceneAblationMode;
  groups: Record<string, SceneGroupSelector[]>;
  selectedGroups: string[];
  prefetch: "normal" | "off";
  effects: "normal" | "no-startup";
}

export type SceneAblationDisposition = "full" | "structural" | "hold";

export interface SceneAblationLiveCounts {
  liveSceneElements: number;
  shaderMarkers: number;
  particleMarkers: number;
  shaderRuntime: boolean;
  particleRuntime: boolean;
  shaderStats: unknown;
  particleStats: unknown;
}

export interface SceneAblationStateCounts {
  revision: number;
  nodes: number;
  watching: boolean;
}

export interface SceneAblationReceipt {
  version: 1;
  requested: unknown;
  errors: string[];
  active: boolean;
  effective: EffectiveSceneAblationConfig;
  selectors: Array<SceneGroupSelector & { group: string }>;
  matchedGroups: string[];
  matchedIdsByGroup: Record<string, string[]>;
  heldIds: string[];
  structuralAncestorIds: string[];
  createdSceneElements: number;
  createdStructuralElements: number;
  createdElementIds: string[];
  createdFullElementIds: string[];
  effectRuntimeStarts: { shader: number; particle: number };
  live: SceneAblationLiveCounts;
  state: SceneAblationStateCounts;
  stream: {
    appliedRevisions: number;
    appliedBytes: number;
    creditsReturned: number;
    consumedDirtyIds: number;
    consumedSceneRewrites: number;
    droppedHints: number;
    droppedCardFlights: number;
  };
}

const INERT_CONFIG: EffectiveSceneAblationConfig = {
  version: 1,
  mode: "full",
  groups: {},
  selectedGroups: [],
  prefetch: "normal",
  effects: "normal"
};

const MODES = new Set<SceneAblationMode>([
  "full",
  "exclude",
  "include",
  "no-groups",
  "data-only",
  "app-shell"
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSnapshot(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return "[unserializable]";
  }
}

export function parseSceneAblationConfig(
  requested: unknown,
  dev = import.meta.env.DEV
): { requested: unknown; errors: string[]; active: boolean; effective: EffectiveSceneAblationConfig } {
  if (!dev || requested === undefined) {
    return { requested: jsonSnapshot(requested), errors: [], active: false, effective: INERT_CONFIG };
  }

  const errors: string[] = [];
  if (!plainObject(requested)) {
    return {
      requested: jsonSnapshot(requested),
      errors: ["config must be an object"],
      active: false,
      effective: INERT_CONFIG
    };
  }
  if (requested.version !== 1) errors.push("version must be 1");
  const mode = typeof requested.mode === "string" && MODES.has(requested.mode as SceneAblationMode)
    ? requested.mode as SceneAblationMode
    : null;
  if (mode === null) errors.push("mode is invalid");

  const groups: Record<string, SceneGroupSelector[]> = {};
  if (requested.groups !== undefined) {
    if (!plainObject(requested.groups)) {
      errors.push("groups must be an object");
    } else {
      for (const [group, rawSelectors] of Object.entries(requested.groups)) {
        if (!group || !Array.isArray(rawSelectors) || rawSelectors.length === 0) {
          errors.push(`group ${JSON.stringify(group)} must contain selectors`);
          continue;
        }
        const selectors: SceneGroupSelector[] = [];
        for (const [index, rawSelector] of rawSelectors.entries()) {
          if (
            !plainObject(rawSelector) ||
            typeof rawSelector.sceneFile !== "string" ||
            rawSelector.sceneFile.length === 0 ||
            typeof rawSelector.relativePath !== "string"
          ) {
            errors.push(`group ${JSON.stringify(group)} selector ${index} is invalid`);
            continue;
          }
          selectors.push({ sceneFile: rawSelector.sceneFile, relativePath: rawSelector.relativePath });
        }
        if (selectors.length > 0) groups[group] = selectors;
      }
    }
  }

  const rawSelectedGroups = requested.selectedGroups;
  const selectedGroups = Array.isArray(rawSelectedGroups) && rawSelectedGroups.every((v) => typeof v === "string")
    ? [...new Set(rawSelectedGroups as string[])]
    : [];
  if (rawSelectedGroups !== undefined && (!Array.isArray(rawSelectedGroups) || selectedGroups.length !== rawSelectedGroups.length)) {
    errors.push("selectedGroups must contain unique strings");
  }
  if (mode === "exclude" || mode === "include") {
    if (selectedGroups.length === 0) errors.push(`${mode} mode requires selectedGroups`);
    for (const group of selectedGroups) {
      if (!groups[group]) errors.push(`selected group ${JSON.stringify(group)} has no selectors`);
    }
  }

  const prefetch = requested.prefetch === undefined || requested.prefetch === "normal" || requested.prefetch === "off"
    ? (requested.prefetch ?? "normal") as "normal" | "off"
    : null;
  if (prefetch === null) errors.push("prefetch must be normal or off");
  const effects = requested.effects === undefined || requested.effects === "normal" || requested.effects === "no-startup"
    ? (requested.effects ?? "normal") as "normal" | "no-startup"
    : null;
  if (effects === null) errors.push("effects must be normal or no-startup");

  if (errors.length > 0 || mode === null || prefetch === null || effects === null) {
    return { requested: jsonSnapshot(requested), errors, active: false, effective: INERT_CONFIG };
  }
  const noPresentation = mode === "data-only" || mode === "app-shell";
  return {
    requested: jsonSnapshot(requested),
    errors,
    active: true,
    effective: {
      version: 1,
      mode,
      groups,
      selectedGroups,
      prefetch: noPresentation ? "off" : prefetch,
      effects: noPresentation ? "no-startup" : effects
    }
  };
}

export interface SceneAblationRuntime {
  readonly active: boolean;
  readonly effective: EffectiveSceneAblationConfig;
  readonly prefetchEnabled: boolean;
  readonly effectsStartupEnabled: boolean;
  readonly rendersScene: boolean;
  readonly streamsScene: boolean;
  beginWalk(nodes: ReadonlyMap<string, MirrorNode>, rootIds: readonly string[]): void;
  disposition(id: string): SceneAblationDisposition;
  changed(id: string): boolean;
  changedIds(): readonly string[];
  heldIds(): ReadonlySet<string>;
  noteElementCreated(id: string, structural: boolean): void;
  noteEffectRuntimeStarted(family: "shader" | "particle"): void;
  noteSceneDelta(raw: string): void;
  noteCreditReturned(): void;
  consumeDataOnlyState(state: MirrorState): void;
  setLiveCounts(supplier: (() => SceneAblationLiveCounts) | null): void;
  setStateCounts(supplier: (() => SceneAblationStateCounts) | null): void;
  receipt(): SceneAblationReceipt;
}

export function createSceneAblationRuntime(options: {
  dev?: boolean;
  requested?: unknown;
  target?: Record<string, unknown> | null;
} = {}): SceneAblationRuntime {
  const dev = options.dev ?? import.meta.env.DEV;
  const target = options.target ?? (typeof globalThis === "undefined" ? null : globalThis as unknown as Record<string, unknown>);
  // Production never reads the injection global. Keep the branch ahead of the property access so minifiers can
  // erase the whole diagnostic input path from a production build.
  const requested = options.requested !== undefined
    ? options.requested
    : dev && target
      ? target[SCENE_ABLATION_CONFIG_GLOBAL]
      : undefined;
  const parsed = parseSceneAblationConfig(requested, dev);
  const effective = parsed.effective;
  let dispositions = new Map<string, SceneAblationDisposition>();
  let changedIds = new Set<string>();
  let heldIds = new Set<string>();
  let structuralIds = new Set<string>();
  let matchedIdsByGroup = new Map<string, Set<string>>();
  let createdSceneElements = 0;
  let createdStructuralElements = 0;
  // Cumulative identities survive disposal: a later census must not erase a transient forbidden build.
  const createdElementIds = new Set<string>();
  const createdFullElementIds = new Set<string>();
  const effectRuntimeStarts = { shader: 0, particle: 0 };
  const stream = {
    appliedRevisions: 0,
    appliedBytes: 0,
    creditsReturned: 0,
    consumedDirtyIds: 0,
    consumedSceneRewrites: 0,
    droppedHints: 0,
    droppedCardFlights: 0
  };
  let liveCounts: (() => SceneAblationLiveCounts) | null = null;
  let stateCounts: (() => SceneAblationStateCounts) | null = null;

  const selectedSelectors = (): Array<SceneGroupSelector & { group: string }> => {
    const out: Array<SceneGroupSelector & { group: string }> = [];
    for (const group of effective.selectedGroups) {
      for (const selector of effective.groups[group] ?? []) out.push({ group, ...selector });
    }
    return out;
  };

  function beginWalk(nodes: ReadonlyMap<string, MirrorNode>, rootIds: readonly string[]): void {
    if (!parsed.active) return;
    const previous = dispositions;
    dispositions = new Map();
    heldIds = new Set();
    structuralIds = new Set();
    matchedIdsByGroup = new Map();
    const mode = parsed.active ? effective.mode : "full";
    if (mode === "full" || mode === "data-only" || mode === "app-shell") {
      changedIds = new Set(previous.keys());
      return;
    }
    if (mode === "no-groups") {
      for (const id of nodes.keys()) dispositions.set(id, "hold");
      for (const id of rootIds) heldIds.add(id);
    } else {
      const selectors = selectedSelectors();
      const matched = new Set<string>();
      for (const id of nodes.keys()) {
        const scene = resolveSceneInfo(id, nodes);
        if (!scene) continue;
        for (const selector of selectors) {
          if (scene.file !== selector.sceneFile || scene.relPath !== selector.relativePath) continue;
          matched.add(id);
          let ids = matchedIdsByGroup.get(selector.group);
          if (!ids) matchedIdsByGroup.set(selector.group, (ids = new Set()));
          ids.add(id);
        }
      }
      if (mode === "exclude") {
        for (const id of matched) {
          dispositions.set(id, "hold");
          heldIds.add(id);
        }
      } else {
        const children = new Map<string, string[]>();
        for (const node of nodes.values()) {
          if (node.parentId === null || !nodes.has(node.parentId)) continue;
          let ids = children.get(node.parentId);
          if (!ids) children.set(node.parentId, (ids = []));
          ids.push(node.id);
        }
        const full = new Set<string>();
        const stack = [...matched];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (full.has(id)) continue;
          full.add(id);
          for (const child of children.get(id) ?? []) stack.push(child);
        }
        for (const id of matched) {
          for (let parentId = nodes.get(id)?.parentId ?? null; parentId !== null; parentId = nodes.get(parentId)?.parentId ?? null) {
            if (!full.has(parentId)) structuralIds.add(parentId);
          }
        }
        for (const id of nodes.keys()) {
          if (full.has(id)) dispositions.set(id, "full");
          else if (structuralIds.has(id)) dispositions.set(id, "structural");
          else dispositions.set(id, "hold");
        }
        for (const id of nodes.keys()) {
          if (dispositions.get(id) !== "hold") continue;
          const parentId = nodes.get(id)?.parentId ?? null;
          if (parentId === null || dispositions.get(parentId) !== "hold") heldIds.add(id);
        }
      }
    }
    changedIds = new Set();
    const ids = new Set([...previous.keys(), ...dispositions.keys()]);
    for (const id of ids) {
      if ((previous.get(id) ?? "full") !== (dispositions.get(id) ?? "full")) changedIds.add(id);
    }
  }

  function receipt(): SceneAblationReceipt {
    const matchedObject: Record<string, string[]> = {};
    for (const [group, ids] of [...matchedIdsByGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      matchedObject[group] = [...ids].sort();
    }
    const fallbackLive: SceneAblationLiveCounts = {
      liveSceneElements: 0,
      shaderMarkers: 0,
      particleMarkers: 0,
      shaderRuntime: false,
      particleRuntime: false,
      shaderStats: null,
      particleStats: null
    };
    const fallbackState: SceneAblationStateCounts = { revision: -1, nodes: 0, watching: false };
    return {
      version: 1,
      requested: parsed.requested,
      errors: [...parsed.errors],
      active: parsed.active,
      effective,
      selectors: selectedSelectors(),
      matchedGroups: Object.keys(matchedObject),
      matchedIdsByGroup: matchedObject,
      heldIds: [...heldIds].sort(),
      structuralAncestorIds: [...structuralIds].sort(),
      createdSceneElements,
      createdStructuralElements,
      createdElementIds: [...createdElementIds].sort(),
      createdFullElementIds: [...createdFullElementIds].sort(),
      effectRuntimeStarts: { ...effectRuntimeStarts },
      live: liveCounts?.() ?? fallbackLive,
      state: stateCounts?.() ?? fallbackState,
      stream: { ...stream }
    };
  }

  const runtime: SceneAblationRuntime = {
    active: parsed.active,
    effective,
    prefetchEnabled: !parsed.active || effective.prefetch === "normal",
    effectsStartupEnabled: !parsed.active || effective.effects === "normal",
    rendersScene: !parsed.active || (effective.mode !== "data-only" && effective.mode !== "app-shell"),
    streamsScene: !parsed.active || effective.mode !== "app-shell",
    beginWalk,
    disposition: (id) => dispositions.get(id) ?? "full",
    changed: (id) => changedIds.has(id),
    changedIds: () => [...changedIds],
    heldIds: () => heldIds,
    noteElementCreated(id, structural) {
      if (!parsed.active) return;
      createdSceneElements++;
      if (structural) createdStructuralElements++;
      createdElementIds.add(id);
      if (!structural) createdFullElementIds.add(id);
    },
    noteEffectRuntimeStarted(family) {
      if (!parsed.active) return;
      effectRuntimeStarts[family]++;
    },
    noteSceneDelta(raw) {
      if (!parsed.active) return;
      stream.appliedRevisions++;
      stream.appliedBytes += typeof TextEncoder !== "undefined" ? new TextEncoder().encode(raw).byteLength : raw.length;
    },
    noteCreditReturned() {
      if (!parsed.active) return;
      stream.creditsReturned++;
    },
    consumeDataOnlyState(state) {
      if (!parsed.active || effective.mode !== "data-only") return;
      // With no renderer mounted, explicitly finish the renderer-owned one-shot lifecycle. Retained nodes,
      // order, screen type and revision stay intact so this arm still measures the real state-stream cost.
      stream.consumedDirtyIds += state.changedIds.size;
      stream.consumedSceneRewrites += state.sceneRewrite ? 1 : 0;
      stream.droppedHints += state.pendingHints.length;
      stream.droppedCardFlights += state.pendingCardFlights.length;
      state.changedIds.clear();
      state.sceneRewrite = false;
      state.pendingHints.length = 0;
      state.pendingCardFlights.length = 0;
    },
    setLiveCounts(supplier) {
      if (!parsed.active) return;
      liveCounts = supplier;
    },
    setStateCounts(supplier) {
      if (!parsed.active) return;
      stateCounts = supplier;
    },
    receipt
  };
  if (dev && target) target[SCENE_ABLATION_RECEIPT_GLOBAL] = receipt;
  return runtime;
}

export const sceneAblation = createSceneAblationRuntime();
