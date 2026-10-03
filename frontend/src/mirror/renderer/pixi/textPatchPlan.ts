// rustTextPatch — the pure half of the text-only retained patch: which wire changes are text-only, and whether a
// changed label can be re-prepared in place. `createPixiMirrorRenderer.ts` supplies the committed build's state
// through `TextPatchContext`; nothing here reads the DOM or the renderer, so every refusal is unit-testable.

import type { PixiTextRecord } from "@godot-scene-web/canvas/pixi";
import type { MirrorNode } from "@/mirror/sceneTree";
import { sameFieldValue } from "./heldOverrides";

/** Fields a text-only change may touch: the label's text (string, style) and the line breaks Godot measured for it. */
const TEXT_FIELDS: ReadonlySet<string> = new Set(["text", "textWrap"]);

/**
 * Whether `before` → `after` changes only the label's text. Everything a full build derives from the text lives in
 * the label's own records; a container that resizes to it, or a sibling that moves with it, streams its own delta,
 * which keeps the patch on its usual rules. A label gaining or losing its text object is not a text-only change.
 */
export function textOnlyChange(before: MirrorNode, after: MirrorNode): boolean {
  if (!before.text || !after.text) return false;
  const left = before as unknown as Record<string, unknown>, right = after as unknown as Record<string, unknown>;
  let textChanged = false;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (sameFieldValue(left[key], right[key])) continue;
    if (!TEXT_FIELDS.has(key)) return false;
    textChanged = true;
  }
  return textChanged;
}

/** What `planTextPatch` reads of the committed build and of this frame's patch. */
export interface TextPatchContext {
  /** The committed build's text record keys for a label, in order (none: it drew no text). */
  keysOf(id: string): readonly string[] | undefined;
  /** The committed record for a key. */
  committedText(key: string): PixiTextRecord | undefined;
  /** Whether the committed build prepared this label (its paint record is retained). */
  built(id: string): boolean;
  /** Paint-order position of the label in the committed build. */
  orderOf(id: string): number | undefined;
  /** Paint-order spans this frame's wire changes move. */
  movedSpans: readonly { start: number; end: number }[];
  /** False when the label sits in a local-animation root's span or a committed patch moved it since the build. */
  textPatchable(id: string): boolean;
  /** Whether the label shares a lineage with a transform override. */
  underOverride(id: string): boolean;
  /** Primitive ids this frame's patch already changes (a sampled alpha or move of `text:<key>`). */
  sampled: ReadonlySet<string>;
  /** Whether a committed patch changed this record's alpha since the build. */
  committedAlpha(key: string): boolean;
  /** Re-prepare the label from its committed paint record, as the build's `semanticText` would. */
  prepare(id: string): { records: PixiTextRecord[] } | { refusal: string };
}

/**
 * Re-prepare each changed label, or name why not (when in doubt, refuse):
 * - `text-not-drawn`: the committed build drew no text for it;
 * - `text-span`: a wire change in this frame moves its span;
 * - `text-moved`: a committed patch moved it since the build, or it is inside a local-animation span;
 * - `text-under-override`: a transform override shares its lineage;
 * - `text-sampled`: this frame's patch already changes one of its records (a sampled alpha or move);
 * - `text-alpha`: a committed patch changed one of its records' alpha since the build;
 * - `text-prep:<reason>`: preparation refused (a pending font, unresolved text);
 * - `text-shape`: a different record shape (line or run count, keys) or an inline image.
 */
export function planTextPatch(ids: Iterable<string>, ctx: TextPatchContext): PixiTextRecord[] | string {
  const records: PixiTextRecord[] = [];
  for (const id of ids) {
    const keys = ctx.keysOf(id), order = ctx.orderOf(id);
    if (!keys?.length || !ctx.built(id) || order === undefined) return "text-not-drawn";
    if (ctx.movedSpans.some((span) => order >= span.start && order < span.end)) return "text-span";
    if (!ctx.textPatchable(id)) return "text-moved";
    if (ctx.underOverride(id)) return "text-under-override";
    for (const key of keys) {
      if (ctx.sampled.has(`text:${key}`)) return "text-sampled";
      if (ctx.committedAlpha(key)) return "text-alpha";
    }
    const prepared = ctx.prepare(id);
    if ("refusal" in prepared) return `text-prep:${prepared.refusal}`;
    if (prepared.records.length !== keys.length) return "text-shape";
    for (let i = 0; i < keys.length; i++) {
      const record = prepared.records[i], committed = ctx.committedText(keys[i]);
      if (record.key !== keys[i] || !committed || (record as { inlineImage?: unknown }).inlineImage ||
        (committed as { inlineImage?: unknown }).inlineImage) return "text-shape";
      // The composition stamped the committed record's group; the re-prepared one draws through the same group.
      const parentId = (committed as PixiTextRecord & { parentId?: string }).parentId;
      if (parentId !== undefined) (record as PixiTextRecord & { parentId?: string }).parentId = parentId;
      records.push(record);
    }
  }
  return records;
}
