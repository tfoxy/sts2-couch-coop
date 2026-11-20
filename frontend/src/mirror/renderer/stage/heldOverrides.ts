import type { MirrorNode } from "@/mirror/sceneTree";

/**
 * Held transform overrides (`rustHeldOverridePatch`).
 *
 * A tween that has ended can leave its last pose in the renderer's transform overrides until the node is next
 * upserted. While those overrides stay exactly the ones the committed full build applied, a retained patch can
 * still be exact: every pose recorded by that build already composes through them, so the patch only has to stay
 * away from the overridden lineages. These helpers answer the three questions that decide it.
 */
export type TransformOverrideBank = ReadonlyMap<string, readonly number[]>;

/** A value copy. The sampler rewrites override arrays in place, so a bank must never alias them. */
export function copyTransformOverrides(source: TransformOverrideBank): Map<string, readonly number[]> {
  const copy = new Map<string, readonly number[]>();
  for (const [id, matrix] of source) copy.set(id, matrix.slice());
  return copy;
}

/** The same key set with bitwise-equal matrices (`Object.is` per element, so `0` and `-0` differ). */
export function sameTransformOverrides(current: TransformOverrideBank, committed: TransformOverrideBank): boolean {
  if (current.size !== committed.size) return false;
  for (const [id, matrix] of current) {
    const banked = committed.get(id);
    if (!banked || banked.length !== matrix.length) return false;
    for (let i = 0; i < matrix.length; i++) if (!Object.is(matrix[i], banked[i])) return false;
  }
  return true;
}

/**
 * Whether two values of one streamed node field are equal: identical, or a plain object / array of the same
 * length whose own entries are pairwise identical (`Object.is`). One level only: a volatile upsert rebuilds its
 * colour objects with the same channels, while a nested object that was rebuilt (a text block) still differs.
 */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys)
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false;
  return true;
}

/** Every field but the transform equal under {@link sameFieldValue}, across both nodes' keys. */
export function sameNodeExceptTransform(before: MirrorNode, after: MirrorNode): boolean {
  const left = before as unknown as Record<string, unknown>, right = after as unknown as Record<string, unknown>;
  for (const key of Object.keys(left)) if (key !== "transform" && !sameFieldValue(left[key], right[key])) return false;
  for (const key of Object.keys(right))
    if (key !== "transform" && !Object.prototype.hasOwnProperty.call(left, key) && right[key] !== undefined) return false;
  return true;
}

/** The strict ancestors of every overridden node, by parent links. */
export function overrideAncestors(overrides: TransformOverrideBank, nodes: ReadonlyMap<string, MirrorNode>): Set<string> {
  const ancestors = new Set<string>();
  for (const id of overrides.keys()) {
    let parent = nodes.get(id)?.parentId ?? null;
    // Bounded by the node count, so a malformed parent cycle cannot hang the gate.
    for (let steps = 0; parent !== null && steps <= nodes.size && !ancestors.has(parent); steps++) {
      ancestors.add(parent);
      parent = nodes.get(parent)?.parentId ?? null;
    }
  }
  return ancestors;
}

/**
 * Whether a node shares a lineage with an override: it is overridden itself, sits under one, or sits above one.
 * `ancestors` is {@link overrideAncestors} for the same overrides and node map.
 */
export function touchesOverrideLineage(id: string, overrides: TransformOverrideBank,
  ancestors: ReadonlySet<string>, nodes: ReadonlyMap<string, MirrorNode>): boolean {
  if (ancestors.has(id)) return true;
  let current: string | null = id;
  for (let steps = 0; current !== null && steps <= nodes.size; steps++) {
    if (overrides.has(current)) return true;
    current = nodes.get(current)?.parentId ?? null;
  }
  return false;
}
