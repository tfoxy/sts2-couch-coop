/** The sole recording envelope accepted by offline benches. */
export const REPRO_FORMAT = "repro/1";

export function requireReproHeader(text: string, source: string): Record<string, unknown> {
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  if (!first) throw new Error(`${source}: missing repro/1 header on the first line`);
  let header: unknown;
  try {
    header = JSON.parse(first);
  } catch {
    throw new Error(`${source}: first line must be a repro/1 header JSON object`);
  }
  const meta = typeof header === "object" && header !== null ? (header as { meta?: unknown }).meta : null;
  if (typeof meta !== "object" || meta === null || (meta as { format?: unknown }).format !== REPRO_FORMAT)
    throw new Error(`${source}: expected first-line {"meta":{"format":"repro/1",…}} header`);
  return meta as Record<string, unknown>;
}
