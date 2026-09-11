// BUILD-TIME flags for the mirror — the small set of things decided by which BUILD is running rather than by the
// viewer, the device or the URL.
//
// One flag lives here today: whether the REPRO RECORDER's user-facing surface (the settings row and the REC
// badge) is compiled into this build at all. A published build wants it gone — an end user who finds a
// "Repro recorder" switch in their settings panel has found a developer tool, and turning it on costs them
// memory for a file they will never send anyone. A local/dev build wants it present, because that is the whole
// point of it.
//
// The switch is the Vite env var `VITE_REPRO_UI`:
//   unset or "on"  ⇒ the row + badge are compiled in, and a saved `reproRecorder: true` arms the recorder.
//   "off"          ⇒ the row + badge are excluded, AND a stale saved value is IGNORED at layering time
//                    (mirrorSettings) — an excluded build must not keep recording because of a switch the
//                    viewer can no longer see, let alone turn off.
//
// `?repro=on` still arms an excluded build. That is deliberate: it is the support escape hatch (walk a player
// through appending one query param, get a recording, no rebuild), it cannot happen by accident, and the badge's
// arming path renders it even in an excluded build so the player has a SAVE button to press.
//
// WHY A MODULE CONSTANT. `import.meta.env.VITE_REPRO_UI` is statically substituted by Vite at build time, so
// evaluating it ONCE into a `const` leaves the consuming `v-if` as a constant branch a minifier can fold away.
// A getter or a per-call read would defeat that. Tests do not poke the constant — they call `readReproUiFlag`
// with an explicit env bag, or inject through `createMirrorSettings`' option, which is why the parse is a pure
// exported function rather than an inline expression.
//
// (`import.meta.env` is not new to this repo — see `frontend/src/mirror/canvas/paintOrder.ts`'s
// `paintOrderAssertsOn` and `canvasRenderer.ts`'s `paintDumpEnabled` — but it IS new as a product flag rather
// than a dev assertion, so it is centralised here instead of read at each use site.)

/** The shape of the env bag both Vite and a bare-Node import may (or may not) present. */
export type BuildEnvBag = Record<string, unknown> | undefined;

/**
 * Parse the repro-UI build flag out of an env bag.
 *
 * Anything other than a case-insensitive `"off"` — including an absent bag, an absent key and an empty string —
 * reads as ENABLED. The default has to be "on" because the bag is absent under bare Node (the offline tools
 * import mirror sources directly) and unset in a local `vite dev`, and both of those are exactly the cases that
 * want the tool present.
 */
export function readReproUiFlag(env: BuildEnvBag): boolean {
  const raw = env?.VITE_REPRO_UI;
  return typeof raw === "string" ? raw.toLowerCase() !== "off" : true;
}

/** This build's answer, evaluated once (see the note above on why it is a const). */
export const REPRO_UI_ENABLED: boolean = readReproUiFlag(
  (import.meta as unknown as { env?: Record<string, unknown> }).env
);
