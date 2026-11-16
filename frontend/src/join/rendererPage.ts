// Renderer demand belongs to a document, independently of diagnostic visits and socket lifetimes.
// Keep this out of storage: duplicating a tab must create a separate owner.
const pageIds = new WeakMap<Document, string>();

export function rendererPageId(
  doc: Document | undefined = typeof document === "undefined" ? undefined : document
): string | null {
  if (!doc) return null;
  const cached = pageIds.get(doc);
  if (cached) return cached;
  // getRandomValues is available on plain HTTP LAN pages; randomUUID requires a secure context.
  if (!globalThis.crypto?.getRandomValues) return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  pageIds.set(doc, id);
  return id;
}
