/** The sole recording envelope accepted by Couch's offline tools. */
export const REPRO_FORMAT = "repro/1";

/**
 * Validate the mandatory first NDJSON record without interpreting the stream.
 * Keeping this separate lets each consumer retain its own recovery handling for
 * later malformed frames while refusing an ambiguous, pre-protocol recording.
 */
export function requireReproHeader(text, source = "recording") {
  const first = String(text).replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  if (!first) throw new Error(`${source}: missing repro/1 header on the first line`);
  let header;
  try {
    header = JSON.parse(first);
  } catch {
    throw new Error(`${source}: first line must be a repro/1 header JSON object`);
  }
  if (!header?.meta || header.meta.format !== REPRO_FORMAT) {
    throw new Error(`${source}: expected first-line {"meta":{"format":"repro/1",…}} header`);
  }
  return header.meta;
}
